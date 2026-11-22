//! Legacy raw (non-TLV) pairing for third-party receivers (spec
//! `airplay-mirroring.md` Appendix A), and the connection choice between
//! it and HAP.
//!
//! **Untested on hardware**: implemented from the spec and checked only
//! against the spec's key vector and a fake receiver.
//!
//! - Raw pair-setup: `POST /pair-setup` with our 32-byte Ed25519 public
//!   key; the receiver answers with its own. Unauthenticated; done once,
//!   the key is stored (`pairing = raw` in the credential store).
//! - Raw pair-verify: V1 `01 00 00 00 ‖ X25519 pub ‖ Ed25519 pub` → V2
//!   `X25519 pub ‖ enc(signature)`; `S = X25519`, AES-128-CTR key/IV =
//!   SHA-512 of a label ‖ `S` (`keys::legacy_pair_verify_key_iv`); V3
//!   `00 00 00 00 ‖ enc(our signature)` with the next 64 keystream bytes;
//!   V4 empty. The control connection stays plaintext (legacy profile).
//!
//! [`connect`] keeps HAP the default: a stored HAP pairing, or any
//! receiver that is not a legacy candidate, goes through
//! [`pair::connect`] unchanged. Only unpaired legacy candidates (no
//! HAP pairing feature bit, or a third-party bit) try raw pair-setup
//! first, falling back to the HAP flow when that fails.
//!
//! Sources: docs/airplay-mirroring.md Appendix A, §2.1, §2.2, §10;
//! vectors tests/vectors/airplay-mirror/channels.txt.

use std::net::{SocketAddr, TcpStream};

use crate::airplay::credentials::{Identity, Query, Receiver, Store};
use crate::airplay::keys::legacy_pair_verify_key_iv;
use crate::airplay::pair::{self, Control, Target};
use crate::airplay::policy::has;
use crate::crypto::modes::Ctr;
use crate::crypto::ring::{ed25519_verify, X25519Ephemeral};
use crate::error::{Error, ErrorKind, Result};
use crate::net::rtsp::RtspClient;

pub const USER_AGENT: &str = "AirPlay/935.7.1";
const OCTETS: &str = "application/octet-stream";

/// HAP pairing feature bits (38, 43, 46, 48) and third-party bits (26, 51).
const HAP_BITS: [u32; 4] = [38, 43, 46, 48];
const THIRD_PARTY_BITS: [u32; 2] = [26, 51];

/// Whether a receiver advertises HAP (TLV8) pairing.
pub fn hap_capable(features: u64) -> bool {
    HAP_BITS.iter().any(|&b| has(features, b))
}

/// Whether a receiver may speak raw pairing (Appendix A).
pub fn is_candidate(features: u64) -> bool {
    !hap_capable(features) || THIRD_PARTY_BITS.iter().any(|&b| has(features, b))
}

fn post(
    client: &mut RtspClient<TcpStream>,
    path: &str,
    verify: bool,
    body: Vec<u8>,
) -> Result<Vec<u8>> {
    let mut req = client.prepare("POST", path);
    req.headers.set("User-Agent", USER_AGENT);
    if verify {
        req.headers.set("X-Apple-ProtocolVersion", "1");
        req.headers.set("X-Apple-PD", "1");
    }
    let req = req.body(OCTETS, body);
    let resp = client.send(&req)?;
    if !resp.is_success() {
        let msg = format!(
            "legacy pairing: {path} answered {} {}",
            resp.status, resp.reason
        );
        return Err(match resp.status {
            401 | 403 | 470 => Error::auth(msg),
            404 => Error::not_found(msg),
            _ => Error::protocol(msg),
        });
    }
    Ok(resp.body)
}

/// Raw pair-setup: returns the receiver's Ed25519 public key.
pub fn pair_setup(client: &mut RtspClient<TcpStream>, identity: &Identity) -> Result<[u8; 32]> {
    let body = post(client, "/pair-setup", false, identity.public_key().to_vec())?;
    body.as_slice()
        .try_into()
        .map_err(|_| Error::malformed(format!("legacy pair-setup: {}-byte reply", body.len())))
}

/// Raw pair-verify against the stored receiver key; returns `S`.
pub fn pair_verify(
    client: &mut RtspClient<TcpStream>,
    identity: &Identity,
    receiver_key: &[u8; 32],
) -> Result<Vec<u8>> {
    let eph = X25519Ephemeral::generate()?;
    let ours = eph.public_key();
    let mut v1 = vec![1, 0, 0, 0];
    v1.extend_from_slice(&ours);
    v1.extend_from_slice(&identity.public_key());
    let v2 = post(client, "/pair-verify", true, v1)?;
    if v2.len() != 96 {
        return Err(Error::malformed(format!(
            "legacy pair-verify: V2 is {} bytes, want 96",
            v2.len()
        )));
    }
    let theirs: [u8; 32] = v2[..32].try_into().unwrap_or([0; 32]);
    let secret = eph.agree(&theirs)?;
    let (key, iv) = legacy_pair_verify_key_iv(&secret);
    let mut ctr = Ctr::with_key(&key, &iv)?;
    let mut sig = v2[32..96].to_vec();
    ctr.apply(&mut sig);
    ed25519_verify(receiver_key, &[&theirs[..], &ours[..]].concat(), &sig)
        .map_err(|_| Error::auth("legacy pair-verify: receiver signature does not verify"))?;
    let mut mine = identity
        .key
        .sign(&[&ours[..], &theirs[..]].concat())
        .to_vec();
    ctr.apply(&mut mine);
    let mut v3 = vec![0, 0, 0, 0];
    v3.extend_from_slice(&mine);
    post(client, "/pair-verify", true, v3)?;
    Ok(secret.to_vec())
}

/// An authenticated control connection of either profile.
pub enum Connected {
    Hap(Box<Control>),
    Legacy {
        client: RtspClient<TcpStream>,
        addr: SocketAddr,
        /// The raw pair-verify secret `S` (sent with `X-Apple-PD: 1`).
        secret: Vec<u8>,
    },
}

fn find_raw<'a>(target: &Target, store: &'a Store) -> Option<&'a Receiver> {
    let ip = target.addr.ip().to_string();
    store
        .find(&target.query())
        .or_else(|| {
            store.find(&Query {
                addr: Some(&ip),
                ..Query::default()
            })
        })
        .filter(|r| r.raw)
}

fn has_hap_pairing(target: &Target, store: &Store) -> bool {
    let ip = target.addr.ip().to_string();
    store
        .find(&target.query())
        .or_else(|| {
            store.find(&Query {
                addr: Some(&ip),
                ..Query::default()
            })
        })
        .is_some_and(|r| !r.raw)
}

fn txt_features(target: &Target) -> Option<u64> {
    target.txt()?.features
}

/// Connects with the right pairing (see the module docs).
pub fn connect(target: &Target, store: &mut Store) -> Result<Connected> {
    if let Some(r) = find_raw(target, store).cloned() {
        info!(
            "airplay: legacy raw pair-verify with {} (untested on hardware)",
            r.name
        );
        let mut client = pair::open(target.addr)?;
        let secret = pair_verify(&mut client, &store.identity, &r.public_key)?;
        return Ok(Connected::Legacy {
            client,
            addr: target.addr,
            secret,
        });
    }
    let paired = has_hap_pairing(target, store);
    // Members only and no pairing: a new pairing would get no session (§2.1).
    if !paired && pair::home_only(target) {
        return Err(crate::airplay::session::home_only(Some(&target.label())));
    }
    let candidate = !paired && txt_features(target).is_some_and(is_candidate);
    if candidate {
        let hap = txt_features(target).is_some_and(hap_capable);
        match raw_setup_and_verify(target, store, hap) {
            Ok(c) => return Ok(c),
            Err(e) if e.kind() == ErrorKind::Auth => return Err(e),
            Err(e) => debug!("airplay: legacy raw pairing failed ({e}); trying HAP"),
        }
    }
    pair::connect(target, store).map(|c| Connected::Hap(Box::new(c)))
}

/// `hap`: the receiver advertises HAP pairing too.
fn raw_setup_and_verify(target: &Target, store: &mut Store, hap: bool) -> Result<Connected> {
    info!(
        "airplay: trying legacy raw pair-setup with {} (untested on hardware)",
        target.label()
    );
    let mut client = pair::open(target.addr)?;
    // With HAP pairing too, a refusal sends it on to HAP pairing.
    let key = pair_setup(&mut client, &store.identity).map_err(|e| match e.kind() {
        ErrorKind::Auth if hap => Error::protocol(e.message().to_owned()),
        _ => e,
    })?;
    let device_id = target
        .device
        .as_ref()
        .and_then(|d| d.airplay.as_ref().or(d.raop.as_ref()))
        .and_then(|a| a.txt.deviceid.clone());
    let id = format!(
        "raw:{}",
        device_id
            .clone()
            .unwrap_or_else(|| target.addr.ip().to_string())
    );
    let record = Receiver {
        id: id.into_bytes(),
        public_key: key,
        name: target.label(),
        device_id,
        addr: Some(target.addr.to_string()),
        raw: true,
    };
    store.upsert(record);
    store.save()?;
    let secret = pair_verify(&mut client, &store.identity, &key)?;
    Ok(Connected::Legacy {
        client,
        addr: target.addr,
        secret,
    })
}

#[cfg(test)]
pub(crate) mod fake {
    //! Receiver side of raw pairing, for the fake receivers.
    use super::*;
    use crate::crypto::ring::Ed25519KeyPair;

    type Pending = ([u8; 32], [u8; 32], [u8; 32], Ctr);

    pub struct RawReceiver {
        pub key: Ed25519KeyPair,
        /// The controller's Ed25519 key from V1.
        controller: Option<[u8; 32]>,
        /// (S, our X25519 pub, controller X25519 pub, CTR after V2).
        verify: Option<Pending>,
        pub verified: Option<Vec<u8>>,
    }

    impl RawReceiver {
        pub fn new(seed: [u8; 32]) -> RawReceiver {
            RawReceiver {
                key: Ed25519KeyPair::from_seed(&seed).unwrap(),
                controller: None,
                verify: None,
                verified: None,
            }
        }

        pub fn setup(&mut self, body: &[u8]) -> Option<Vec<u8>> {
            self.controller = Some(body.try_into().ok()?);
            Some(self.key.public_key().to_vec())
        }

        pub fn verify(&mut self, body: &[u8]) -> Option<Vec<u8>> {
            match body.first()? {
                1 if body.len() == 68 => {
                    let theirs: [u8; 32] = body[4..36].try_into().ok()?;
                    let ctl: [u8; 32] = body[36..68].try_into().ok()?;
                    if self.controller.is_some_and(|c| c != ctl) {
                        return None;
                    }
                    self.controller = Some(ctl);
                    let eph = X25519Ephemeral::generate().ok()?;
                    let ours = eph.public_key();
                    let s = eph.agree(&theirs).ok()?;
                    let (k, iv) = legacy_pair_verify_key_iv(&s);
                    let mut ctr = Ctr::with_key(&k, &iv).ok()?;
                    let mut sig = self.key.sign(&[&ours[..], &theirs[..]].concat()).to_vec();
                    ctr.apply(&mut sig);
                    self.verify = Some((s, ours, theirs, ctr));
                    Some([&ours[..], &sig].concat())
                }
                0 if body.len() == 68 => {
                    let (s, ours, theirs, mut ctr) = self.verify.take()?;
                    let mut sig = body[4..].to_vec();
                    ctr.apply(&mut sig);
                    ed25519_verify(&self.controller?, &[&theirs[..], &ours[..]].concat(), &sig)
                        .ok()?;
                    self.verified = Some(s.to_vec());
                    Some(Vec::new())
                }
                _ => None,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::net::http::{Conn, Response};
    use std::net::TcpListener;

    /// Unpaired legacy candidate → raw pair-setup (stored as `pairing =
    /// raw`) → raw verify → a legacy session; the next connect verifies
    /// with the stored key.
    #[test]
    fn connect_pairs_raw_then_verifies() {
        use crate::airplay::credentials::tests::temp_dir;
        use crate::airplay::fake_mirror::{Behaviour, FakeMirror};
        use crate::airplay::session::{ControlAuth, MirrorOptions, Session};
        let fake = FakeMirror::start(Behaviour {
            raw_pairing: Some([5; 32]),
            legacy: Some(([0; 16], [0; 16])),
            ..Behaviour::default()
        });
        let path = crate::storage::Storage::dir(temp_dir("legacy-connect"));
        let mut store = Store::open(&path).unwrap();
        let mut dev = crate::net::device::tests::lan_devices()
            .into_iter()
            .find(|d| d.airplay.is_some())
            .unwrap();
        dev.airplay.as_mut().unwrap().txt.features = Some(1 << 7 | 1 << 26);
        let target = Target {
            addr: fake.addr,
            device: Some(dev),
        };
        for round in 0..2 {
            let Connected::Legacy {
                client,
                addr,
                secret,
            } = connect(&target, &mut store).unwrap()
            else {
                panic!("expected the legacy profile");
            };
            assert_eq!(secret.len(), 32);
            let reloaded = Store::open(&path).unwrap();
            assert_eq!(reloaded.receivers.len(), 1);
            assert!(reloaded.receivers[0].raw);
            let s = Session::establish(
                client,
                addr,
                secret,
                ControlAuth::Legacy,
                &MirrorOptions::default(),
                &mut crate::airplay::session::NoMemory,
            )
            .map_err(|e| e.into_error())
            .unwrap();
            assert!(!s.hap());
            drop(s);
            let setups = fake
                .rec()
                .requests
                .iter()
                .filter(|r| *r == "POST /pair-setup")
                .count();
            assert_eq!(setups, 1, "round {round}: pair-setup only once");
        }
    }

    #[test]
    fn candidates() {
        // The dev Apple TV: HAP bits, no third-party bit.
        assert!(!is_candidate(0x3c17_7fde_4a7f_dfd5));
        assert!(is_candidate(0));
        assert!(is_candidate(1 << 26 | 1 << 48));
        assert!(is_candidate(1 << 51 | 1 << 38));
        assert!(!is_candidate(1 << 43));
    }

    /// A refused raw pair-setup is no auth error from a receiver with HAP pairing.
    #[test]
    fn refused_raw_setup_is_not_an_auth_failure() {
        use crate::airplay::credentials::tests::temp_dir;
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = l.local_addr().unwrap();
        std::thread::spawn(move || {
            for _ in 0..2 {
                let (s, _) = l.accept().unwrap();
                let mut conn = Conn::new(s);
                let req = conn.read_request().unwrap();
                let mut r = Response::new(req.version, 403, "Forbidden");
                r.headers.set("CSeq", req.headers.get("cseq").unwrap());
                conn.send_response(&r).unwrap();
            }
        });
        let path = crate::storage::Storage::dir(temp_dir("legacy-refused-raw"));
        let mut store = Store::open(&path).unwrap();
        let target = Target { addr, device: None };
        let Err(e) = raw_setup_and_verify(&target, &mut store, false) else {
            panic!("a refused pair-setup connected");
        };
        assert_eq!(e.kind(), ErrorKind::Auth, "{e}");
        let path = crate::storage::Storage::dir(temp_dir("legacy-refused"));
        let mut store = Store::open(&path).unwrap();
        let target = Target { addr, device: None };
        let Err(e) = raw_setup_and_verify(&target, &mut store, true) else {
            panic!("a refused pair-setup connected");
        };
        assert_eq!(e.kind(), ErrorKind::Protocol, "{e}");
        assert!(store.receivers.is_empty());
        assert!(hap_capable(0x38b_cf46_007f_8ad0) && !hap_capable(1 << 26 | 1 << 7));
    }

    /// `acl=1` and no pairing: no connection is made.
    #[test]
    fn home_only_is_said_before_connecting() {
        use crate::airplay::credentials::tests::temp_dir;
        let mut dev = crate::net::device::tests::lan_devices()
            .into_iter()
            .find(|d| d.airplay.is_some())
            .unwrap();
        dev.airplay.as_mut().unwrap().txt.acl = Some(1);
        let name = dev.name.clone();
        let target = Target {
            addr: "127.0.0.1:9".parse().unwrap(),
            device: Some(dev),
        };
        let path = crate::storage::Storage::dir(temp_dir("legacy-home-only"));
        let mut store = Store::open(&path).unwrap();
        let Err(e) = connect(&target, &mut store) else {
            panic!("connected to a receiver that takes its home's members only");
        };
        assert_eq!(e.code(), Some("home-only"), "{e}");
        assert_eq!(e.device(), Some(name.as_str()));
    }

    /// Raw pair-setup + pair-verify against the fake receiver side; both
    /// ends agree on `S`.
    #[test]
    fn raw_pairing_round_trip() {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = l.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (s, _) = l.accept().unwrap();
            let mut conn = Conn::new(s);
            let mut rx = fake::RawReceiver::new([3; 32]);
            let mut headers = Vec::new();
            for _ in 0..3 {
                let req = conn.read_request().unwrap();
                headers.push(req.headers.clone());
                let out = match req.target.as_str() {
                    "/pair-setup" => rx.setup(&req.body),
                    _ => rx.verify(&req.body),
                };
                let mut r = Response::new(req.version, if out.is_some() { 200 } else { 470 }, "x");
                r.headers.set("CSeq", req.headers.get("cseq").unwrap());
                r.body = out.unwrap_or_default();
                conn.send_response(&r).unwrap();
            }
            (rx.verified, rx.key.public_key(), headers)
        });
        let identity = Identity::generate().unwrap();
        let mut client = pair::open(addr).unwrap();
        let key = pair_setup(&mut client, &identity).unwrap();
        let s = pair_verify(&mut client, &identity, &key).unwrap();
        let (verified, pk, headers) = server.join().unwrap();
        assert_eq!(pk, key);
        assert_eq!(verified.as_deref(), Some(&s[..]));
        assert_eq!(headers[1].get("x-apple-pd"), Some("1"));
        assert_eq!(headers[1].get("x-apple-protocolversion"), Some("1"));
        assert_eq!(headers[0].get("x-apple-pd"), None);
        assert_eq!(headers[0].get("content-type"), Some(OCTETS));

        // A wrong stored key fails with an auth error.
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = l.local_addr().unwrap();
        std::thread::spawn(move || {
            let (s, _) = l.accept().unwrap();
            let mut conn = Conn::new(s);
            let mut rx = fake::RawReceiver::new([3; 32]);
            let req = conn.read_request().unwrap();
            let mut r = Response::new(req.version, 200, "OK");
            r.headers.set("CSeq", req.headers.get("cseq").unwrap());
            r.body = rx.verify(&req.body).unwrap();
            conn.send_response(&r).unwrap();
        });
        let mut client = pair::open(addr).unwrap();
        let e = pair_verify(&mut client, &identity, &[9; 32]).unwrap_err();
        assert_eq!(e.kind(), ErrorKind::Auth);
    }
}
