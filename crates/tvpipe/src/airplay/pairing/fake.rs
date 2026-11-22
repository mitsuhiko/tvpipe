//! An in-process fake AirPlay receiver for tests: `/pair-pin-start`,
//! PIN and transient `/pair-setup`, `/pair-verify`, and `GET /info`, on a
//! local TCP port, switching to the encrypted control channel exactly
//! where a receiver does (after the response to transient M4 or verify
//! M4). Built on `crypto::srp::SrpServer`; the receiver side of the HAP
//! flows mirrors pyatv's test server (MIT,
//! `pyatv/protocols/airplay/server_auth.py`).

use std::net::{SocketAddr, TcpListener, TcpStream};
use std::sync::{Arc, Mutex};
use std::thread;

use crate::airplay::pairing::{
    FLAG_TRANSIENT, SETUP_ACCESSORY_SIGN_INFO, SETUP_ACCESSORY_SIGN_SALT,
    SETUP_CONTROLLER_SIGN_INFO, SETUP_CONTROLLER_SIGN_SALT, SETUP_ENCRYPT_INFO, SETUP_ENCRYPT_SALT,
    TRANSIENT_PIN, VERIFY_ENCRYPT_INFO, VERIFY_ENCRYPT_SALT,
};
use crate::airplay::secure::{Keys, SecureStream};
use crate::codec::bplist::Plist;
use crate::codec::tlv8::{errors, tag, Tlv8};
use crate::crypto::ring::{
    ed25519_verify, hkdf_sha512_array, nonce_label, ChaCha20Poly1305, Ed25519KeyPair,
    X25519Ephemeral,
};
use crate::crypto::srp::{SrpServer, HAP_USERNAME, HASH_LEN};
use crate::error::Result;
use crate::net::http::{Conn, Request, Response};

/// How the fake receiver behaves.
#[derive(Debug, Clone)]
pub(crate) struct Config {
    pub pin: String,
    pub allow_transient: bool,
    pub id: Vec<u8>,
    pub seed: [u8; 32],
    pub name: String,
    /// `X-Apple-HKP` accepted on transient pair-setup (Apple: "4").
    pub transient_hkp: String,
    /// SRP password of transient pair-setup.
    pub transient_pin: String,
    /// `statusFlags` of `/info` (default 0x644).
    pub status_flags: u64,
    /// Answer `/pair-setup` with 403.
    pub forbid_pair_setup: bool,
}

impl Default for Config {
    fn default() -> Config {
        Config {
            pin: "1234".into(),
            allow_transient: true,
            id: b"AA:BB:CC:00:00:0A".to_vec(),
            seed: [7; 32],
            name: "Fake TV".into(),
            transient_hkp: "4".into(),
            transient_pin: TRANSIENT_PIN.into(),
            status_flags: 0x644,
            forbid_pair_setup: false,
        }
    }
}

/// State shared by all connections.
#[derive(Debug, Default)]
pub(crate) struct State {
    /// Paired controllers: (id, long-term public key).
    pub pairings: Vec<(Vec<u8>, [u8; 32])>,
    /// How often `/pair-pin-start` was called.
    pub pin_starts: usize,
    /// Every request line, prefixed `plain`/`secure`.
    pub log: Vec<String>,
}

pub(crate) struct FakeReceiver {
    pub addr: SocketAddr,
    pub state: Arc<Mutex<State>>,
    pub config: Arc<Config>,
}

impl FakeReceiver {
    pub fn start(config: Config) -> FakeReceiver {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let state = Arc::new(Mutex::new(State::default()));
        let config = Arc::new(config);
        let (st, cfg) = (state.clone(), config.clone());
        thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(stream) = stream else { break };
                let (st, cfg) = (st.clone(), cfg.clone());
                thread::spawn(move || {
                    if let Err(e) = serve(stream, &st, &cfg) {
                        debug!("fake receiver: connection ended: {e}");
                    }
                });
            }
        });
        FakeReceiver {
            addr,
            state,
            config,
        }
    }

    pub fn public_key(&self) -> [u8; 32] {
        Ed25519KeyPair::from_seed(&self.config.seed)
            .unwrap()
            .public_key()
    }

    pub fn log(&self) -> Vec<String> {
        self.state.lock().unwrap().log.clone()
    }
}

#[derive(Default)]
struct ConnState {
    srp: Option<SrpServer>,
    transient: bool,
    k: Option<[u8; HASH_LEN]>,
    /// Pair-verify: (shared secret, our ephemeral, controller ephemeral).
    verify: Option<([u8; 32], [u8; 32], [u8; 32])>,
    verified: bool,
}

fn serve(stream: TcpStream, state: &Mutex<State>, cfg: &Config) -> Result<()> {
    let mut conn = Conn::new(stream);
    let mut cs = ConnState::default();
    let shared = loop {
        let req = conn.read_request()?;
        state
            .lock()
            .unwrap()
            .log
            .push(format!("plain {} {}", req.method, req.target));
        let (resp, enable) = handle(&req, &mut cs, state, cfg);
        conn.send_response(&resp)?;
        if let Some(shared) = enable {
            break shared;
        }
    };
    let (stream, rest) = conn.into_parts();
    assert!(
        rest.is_empty(),
        "fake receiver: data after the last plain request"
    );
    // The receiver reads with the sender's write key.
    let keys = Keys::control(&shared)?.swapped();
    let mut conn = Conn::new(SecureStream::new(stream, &keys));
    cs.verified = true;
    loop {
        let req = conn.read_request()?;
        state
            .lock()
            .unwrap()
            .log
            .push(format!("secure {} {}", req.method, req.target));
        let (resp, _) = handle(&req, &mut cs, state, cfg);
        conn.send_response(&resp)?;
    }
}

fn reply(req: &Request, status: u16, reason: &str, ct: Option<&str>, body: Vec<u8>) -> Response {
    let mut r = Response::new(req.version, status, reason);
    if let Some(cseq) = req.headers.get("cseq") {
        r.headers.set("CSeq", cseq);
    }
    r.headers.set("Server", "AirTunes/0.0-fake");
    if let Some(ct) = ct {
        r.headers.set("Content-Type", ct);
    }
    r.body = body;
    r
}

fn tlv_reply(req: &Request, tlv: Tlv8) -> Response {
    reply(
        req,
        200,
        "OK",
        Some("application/octet-stream"),
        tlv.encode(),
    )
}

fn tlv_error(state: u8, code: u8) -> Tlv8 {
    Tlv8::new()
        .with_u8(tag::STATE, state)
        .with_u8(tag::ERROR, code)
}

/// Handles one request; `Some(shared)` turns encryption on after the
/// response.
fn handle(
    req: &Request,
    cs: &mut ConnState,
    state: &Mutex<State>,
    cfg: &Config,
) -> (Response, Option<Vec<u8>>) {
    match (req.method.as_str(), req.target.as_str()) {
        ("POST", "/pair-pin-start") => {
            state.lock().unwrap().pin_starts += 1;
            (reply(req, 200, "OK", None, Vec::new()), None)
        }
        ("POST", "/pair-setup") if cfg.forbid_pair_setup => {
            (reply(req, 403, "Forbidden", None, Vec::new()), None)
        }
        ("POST", "/pair-setup") => match pair_setup(req, cs, state, cfg) {
            Ok(r) => r,
            Err(e) => {
                debug!("fake receiver: pair-setup: {e}");
                (reply(req, 400, "Bad Request", None, Vec::new()), None)
            }
        },
        ("POST", "/pair-verify") => match pair_verify(req, cs, state, cfg) {
            Ok(r) => r,
            Err(e) => {
                debug!("fake receiver: pair-verify: {e}");
                (reply(req, 400, "Bad Request", None, Vec::new()), None)
            }
        },
        ("GET", "/info") => (
            reply(
                req,
                200,
                "OK",
                Some("application/x-apple-binary-plist"),
                info(cfg, cs.verified).to_bytes(),
            ),
            None,
        ),
        _ if !cs.verified => (reply(req, 403, "Forbidden", None, Vec::new()), None),
        _ => (reply(req, 404, "Not Found", None, Vec::new()), None),
    }
}

fn info(cfg: &Config, verified: bool) -> Plist {
    let key = Ed25519KeyPair::from_seed(&cfg.seed).unwrap();
    let mut p = Plist::dict()
        .with("deviceID", String::from_utf8_lossy(&cfg.id).into_owned())
        .with("model", "AppleTV6,2")
        .with("name", cfg.name.as_str())
        .with("features", 0x3C177FDE_4A7FDFD5u64 as i64)
        .with("pk", Plist::data(key.public_key().to_vec()))
        .with("sourceVersion", "960.13.1")
        .with("statusFlags", cfg.status_flags as i64);
    if verified {
        p = p.with(
            "displays",
            Plist::array([Plist::dict()
                .with("widthPixels", 3840i64)
                .with("heightPixels", 2160i64)
                .with("width", 1920i64)
                .with("height", 1080i64)
                .with("refreshRate", 1.0 / 60.0)
                .with("maxFPS", 60i64)
                .with("uuid", "e0ff8a27-6738-3d56-8a16-cc53aacee925")]),
        );
    }
    p
}

fn key32(salt: &[u8], ikm: &[u8], info: &[u8]) -> Result<[u8; 32]> {
    hkdf_sha512_array(salt, ikm, info)
}

type Handled = (Response, Option<Vec<u8>>);

fn pair_setup(
    req: &Request,
    cs: &mut ConnState,
    state: &Mutex<State>,
    cfg: &Config,
) -> Result<Handled> {
    let tlv = Tlv8::decode(&req.body)?;
    let hkp = req.headers.get("x-apple-hkp").unwrap_or("");
    match tlv.state() {
        Some(1) => {
            let transient = tlv.get_u8(tag::FLAGS) == Some(FLAG_TRANSIENT);
            let want = if transient {
                cfg.transient_hkp.as_str()
            } else {
                "3"
            };
            if hkp != want {
                return Ok((tlv_reply(req, tlv_error(2, errors::UNKNOWN)), None));
            }
            if transient && !cfg.allow_transient {
                return Ok((tlv_reply(req, tlv_error(2, errors::UNAVAILABLE)), None));
            }
            let pin = if transient {
                cfg.transient_pin.as_str()
            } else {
                cfg.pin.as_str()
            };
            let srp = SrpServer::new(HAP_USERNAME, pin.as_bytes())?;
            let out = Tlv8::new()
                .with_u8(tag::STATE, 2)
                .with(tag::SALT, srp.salt())
                .with(tag::PUBLIC_KEY, srp.public_key());
            cs.srp = Some(srp);
            cs.transient = transient;
            Ok((tlv_reply(req, out), None))
        }
        Some(3) => {
            let Some(srp) = cs.srp.take() else {
                return Ok((tlv_reply(req, tlv_error(4, errors::UNKNOWN)), None));
            };
            let a = tlv.require(tag::PUBLIC_KEY)?;
            let m1 = tlv.require(tag::PROOF)?;
            match srp.verify(a, m1) {
                Ok((m2, k)) => {
                    let out = Tlv8::new()
                        .with_u8(tag::STATE, 4)
                        .with(tag::PROOF, m2.to_vec());
                    if cs.transient {
                        return Ok((tlv_reply(req, out), Some(k.to_vec())));
                    }
                    cs.k = Some(k);
                    Ok((tlv_reply(req, out), None))
                }
                Err(_) => Ok((tlv_reply(req, tlv_error(4, errors::AUTHENTICATION)), None)),
            }
        }
        Some(5) => {
            let Some(k) = cs.k.take() else {
                return Ok((tlv_reply(req, tlv_error(6, errors::UNKNOWN)), None));
            };
            let enc = ChaCha20Poly1305::new(&key32(SETUP_ENCRYPT_SALT, &k, SETUP_ENCRYPT_INFO)?);
            let plain = enc.open(
                &nonce_label(b"PS-Msg05")?,
                &[],
                tlv.require(tag::ENCRYPTED_DATA)?,
            )?;
            let sub = Tlv8::decode(&plain)?;
            let id = sub.require(tag::IDENTIFIER)?.to_vec();
            let ltpk: [u8; 32] = sub
                .require(tag::PUBLIC_KEY)?
                .try_into()
                .map_err(|_| crate::error::Error::protocol("ltpk length"))?;
            let ios_x = key32(SETUP_CONTROLLER_SIGN_SALT, &k, SETUP_CONTROLLER_SIGN_INFO)?;
            if ed25519_verify(
                &ltpk,
                &[&ios_x[..], &id, &ltpk].concat(),
                sub.require(tag::SIGNATURE)?,
            )
            .is_err()
            {
                return Ok((tlv_reply(req, tlv_error(6, errors::AUTHENTICATION)), None));
            }
            {
                let mut st = state.lock().unwrap();
                st.pairings.retain(|(i, _)| *i != id);
                st.pairings.push((id, ltpk));
            }
            let key = Ed25519KeyPair::from_seed(&cfg.seed)?;
            let acc_x = key32(SETUP_ACCESSORY_SIGN_SALT, &k, SETUP_ACCESSORY_SIGN_INFO)?;
            let pk = key.public_key();
            let sig = key.sign(&[&acc_x[..], &cfg.id, &pk].concat());
            let sub = Tlv8::new()
                .with(tag::IDENTIFIER, cfg.id.clone())
                .with(tag::PUBLIC_KEY, pk.to_vec())
                .with(tag::SIGNATURE, sig.to_vec());
            let encrypted = enc.seal(&nonce_label(b"PS-Msg06")?, &[], &sub.encode());
            let out = Tlv8::new()
                .with_u8(tag::STATE, 6)
                .with(tag::ENCRYPTED_DATA, encrypted);
            Ok((tlv_reply(req, out), None))
        }
        _ => Ok((tlv_reply(req, tlv_error(2, errors::UNKNOWN)), None)),
    }
}

fn pair_verify(
    req: &Request,
    cs: &mut ConnState,
    state: &Mutex<State>,
    cfg: &Config,
) -> Result<Handled> {
    let tlv = Tlv8::decode(&req.body)?;
    let key = Ed25519KeyPair::from_seed(&cfg.seed)?;
    match tlv.state() {
        Some(1) => {
            let theirs: [u8; 32] = tlv
                .require(tag::PUBLIC_KEY)?
                .try_into()
                .map_err(|_| crate::error::Error::protocol("ephemeral length"))?;
            let eph = X25519Ephemeral::generate()?;
            let ours = eph.public_key();
            let shared = eph.agree(&theirs)?;
            let vkey = key32(VERIFY_ENCRYPT_SALT, &shared, VERIFY_ENCRYPT_INFO)?;
            let sig = key.sign(&[&ours[..], &cfg.id, &theirs].concat());
            let sub = Tlv8::new()
                .with(tag::IDENTIFIER, cfg.id.clone())
                .with(tag::SIGNATURE, sig.to_vec());
            let encrypted =
                ChaCha20Poly1305::new(&vkey).seal(&nonce_label(b"PV-Msg02")?, &[], &sub.encode());
            cs.verify = Some((shared, ours, theirs));
            let out = Tlv8::new()
                .with_u8(tag::STATE, 2)
                .with(tag::PUBLIC_KEY, ours.to_vec())
                .with(tag::ENCRYPTED_DATA, encrypted);
            Ok((tlv_reply(req, out), None))
        }
        Some(3) => {
            let Some((shared, ours, theirs)) = cs.verify.take() else {
                return Ok((tlv_reply(req, tlv_error(4, errors::UNKNOWN)), None));
            };
            let vkey = key32(VERIFY_ENCRYPT_SALT, &shared, VERIFY_ENCRYPT_INFO)?;
            let plain = ChaCha20Poly1305::new(&vkey).open(
                &nonce_label(b"PV-Msg03")?,
                &[],
                tlv.require(tag::ENCRYPTED_DATA)?,
            )?;
            let sub = Tlv8::decode(&plain)?;
            let id = sub.require(tag::IDENTIFIER)?;
            let ltpk = state
                .lock()
                .unwrap()
                .pairings
                .iter()
                .find(|(i, _)| i == id)
                .map(|(_, pk)| *pk);
            let ok = ltpk.is_some_and(|pk| {
                ed25519_verify(
                    &pk,
                    &[&theirs[..], id, &ours].concat(),
                    sub.get(tag::SIGNATURE).unwrap_or_default(),
                )
                .is_ok()
            });
            if !ok {
                return Ok((tlv_reply(req, tlv_error(4, errors::AUTHENTICATION)), None));
            }
            let out = Tlv8::new().with_u8(tag::STATE, 4);
            Ok((tlv_reply(req, out), Some(shared.to_vec())))
        }
        _ => Ok((tlv_reply(req, tlv_error(2, errors::UNKNOWN)), None)),
    }
}
