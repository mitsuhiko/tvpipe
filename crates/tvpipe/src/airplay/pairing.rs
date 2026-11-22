//! HAP pairing over AirPlay's control connection.
//!
//! - **Pair-setup with a PIN** (`POST /pair-setup`, `X-Apple-HKP: 3`),
//!   TLV8 M1–M6: SRP-6a (3072-bit, SHA-512, user `Pair-Setup`), then the
//!   long-term Ed25519 keys are exchanged, signed and encrypted with
//!   ChaCha20-Poly1305 under `HKDF(K, Pair-Setup-Encrypt-Salt/Info)`.
//!   `POST /pair-pin-start` first makes the TV show the PIN.
//! - **Transient pair-setup** (`X-Apple-HKP: 4`, `Flags = 0x10`, PIN
//!   `3939`): M1–M4 only; the SRP session key `K` is the shared secret.
//! - **Pair-verify** (`POST /pair-verify`), M1–M4: ephemeral X25519, both
//!   sides sign `own ephemeral | own id | peer ephemeral` with their
//!   long-term keys; the X25519 result is the shared secret.
//!
//! The shared secret keys the control channel ([`secure::Keys::control`])
//! and the stream keys ([`Shared::secret`]).
//!
//! Each step is a pure function over TLV8 bodies so the transcripts are
//! testable without a network; the drivers ([`pair_setup_pin`],
//! [`pair_setup_transient`], [`pair_verify`]) run them over a
//! [`Transport`].
//!
//! Sources: HomeKit Accessory Protocol specification (pair-setup §5.6,
//! pair-verify §5.7, TLV types, error codes); pyatv (MIT)
//! `pyatv/auth/hap_srp.py` (HKDF salts/infos, signed payloads, nonces),
//! `pyatv/protocols/airplay/auth/hap.py` and `hap_transient.py` (endpoints,
//! headers `X-Apple-HKP`, `User-Agent: AirPlay/320.20`, `Content-Type:
//! application/octet-stream`, transient PIN and flag).

use std::io::{Read, Write};

use crate::airplay::credentials::Identity;
use crate::airplay::secure::Keys;
use crate::codec::tlv8::{errors, method, tag, Tlv8};
use crate::crypto::ring::{
    ed25519_verify, hkdf_sha512_array, nonce_label, ChaCha20Poly1305, X25519Ephemeral,
    ED25519_PUBLIC_KEY_LEN,
};
use crate::crypto::srp::{SrpClient, HAP_USERNAME, HASH_LEN};
use crate::error::{Error, ErrorKind, Result};
use crate::net::http::{Conn, Request, Response, Version};
use crate::net::rtsp::RtspClient;

/// The PIN of transient pair-setup.
pub const TRANSIENT_PIN: &str = "3939";
/// `Flags` TLV value requesting transient pairing.
pub const FLAG_TRANSIENT: u8 = 0x10;
/// The user agent pyatv uses for pairing requests.
pub const USER_AGENT: &str = "AirPlay/320.20";
pub const CONTENT_TYPE: &str = "application/octet-stream";

/// `X-Apple-HKP`: which pairing flavour a request belongs to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Hkp {
    /// Normal HAP pairing (PIN pair-setup, pair-verify): `3`.
    Normal,
    /// Transient pair-setup: `4`.
    Transient,
}

impl Hkp {
    pub fn as_str(self) -> &'static str {
        match self {
            Hkp::Normal => "3",
            Hkp::Transient => "4",
        }
    }
}

/// The PIN of pair-setup: one the receiver shows, or its password.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PinKind {
    /// Shown on the TV after `/pair-pin-start` (or a fixed one).
    Shown,
    /// The receiver's password.
    Password,
}

impl PinKind {
    /// A password with HAP pairing and no PIN flag 0x8 is the PIN (§2.1).
    pub fn from_status(flags: u32, features: u64) -> PinKind {
        use crate::airplay::discovery::status;
        if flags & status::PASSWORD_REQUIRED != 0
            && flags & status::PIN_REQUIRED == 0
            && crate::airplay::legacy_pair::hap_capable(features)
        {
            PinKind::Password
        } else {
            PinKind::Shown
        }
    }

    pub fn is_password(self) -> bool {
        self == PinKind::Password
    }

    /// Whether to ask the receiver to show it (`/pair-pin-start`).
    pub fn shows_pin(self) -> bool {
        self == PinKind::Shown
    }

    /// A PIN is trimmed; a password loses only a trailing line ending.
    pub fn normalize(self, text: &str) -> String {
        match self {
            PinKind::Shown => text.trim().to_owned(),
            PinKind::Password => text.trim_end_matches(['\r', '\n']).to_owned(),
        }
    }
}

const SETUP_ENCRYPT_SALT: &[u8] = b"Pair-Setup-Encrypt-Salt";
const SETUP_ENCRYPT_INFO: &[u8] = b"Pair-Setup-Encrypt-Info";
const SETUP_CONTROLLER_SIGN_SALT: &[u8] = b"Pair-Setup-Controller-Sign-Salt";
const SETUP_CONTROLLER_SIGN_INFO: &[u8] = b"Pair-Setup-Controller-Sign-Info";
const SETUP_ACCESSORY_SIGN_SALT: &[u8] = b"Pair-Setup-Accessory-Sign-Salt";
const SETUP_ACCESSORY_SIGN_INFO: &[u8] = b"Pair-Setup-Accessory-Sign-Info";
const VERIFY_ENCRYPT_SALT: &[u8] = b"Pair-Verify-Encrypt-Salt";
const VERIFY_ENCRYPT_INFO: &[u8] = b"Pair-Verify-Encrypt-Info";

// ---------------------------------------------------------------------------
// Transport

/// Sends one pairing request and returns the response body.
pub trait Transport {
    fn post(&mut self, path: &str, hkp: Hkp, body: &[u8]) -> Result<Vec<u8>>;
}

fn check_status(path: &str, resp: Response) -> Result<Vec<u8>> {
    match resp.status {
        200..=299 => Ok(resp.body),
        // "Connection Authorization Required" / forbidden: pairing refused.
        // 403: refused by its Apple Home's access setting (§2.1).
        403 => Err(Error::auth(format!(
            "pairing: {path} refused with {} {}",
            resp.status, resp.reason
        ))
        .with_code("pairing-forbidden")),
        401 | 470 => Err(Error::auth(format!(
            "pairing: {path} refused with {} {}",
            resp.status, resp.reason
        ))),
        status => Err(Error::protocol(format!(
            "pairing: {path} failed with {status} {}",
            resp.reason
        ))),
    }
}

fn pairing_request(mut req: Request, hkp: Hkp, body: &[u8]) -> Request {
    req.headers.set("User-Agent", USER_AGENT);
    req.headers.set("X-Apple-HKP", hkp.as_str());
    req.headers.set("Content-Length", body.len().to_string());
    req.body(CONTENT_TYPE, body.to_vec())
}

/// Pairing requests as RTSP/1.0 (with CSeq), the control connection's
/// native protocol.
impl<S: Read + Write> Transport for RtspClient<S> {
    fn post(&mut self, path: &str, hkp: Hkp, body: &[u8]) -> Result<Vec<u8>> {
        let req = pairing_request(self.prepare("POST", path), hkp, body);
        let resp = self.send(&req)?;
        check_status(path, resp)
    }
}

/// Pairing requests as HTTP/1.1 (what pyatv sends).
impl<S: Read + Write> Transport for Conn<S> {
    fn post(&mut self, path: &str, hkp: Hkp, body: &[u8]) -> Result<Vec<u8>> {
        let req = pairing_request(Request::new("POST", path, Version::Http11), hkp, body);
        trace!("> POST {path} (HTTP/1.1, {} bytes)", body.len());
        let resp = self.request(&req)?;
        trace!("< {} {}", resp.status, resp.reason);
        check_status(path, resp)
    }
}

// ---------------------------------------------------------------------------
// Results

/// A pairing's shared secret (pair-verify: the 32-byte X25519 result;
/// transient pair-setup: the 64-byte SRP session key).
#[derive(Clone, PartialEq, Eq)]
pub struct Shared(Vec<u8>);

impl std::fmt::Debug for Shared {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Shared({} bytes)", self.0.len())
    }
}

impl Shared {
    pub fn new(secret: Vec<u8>) -> Shared {
        Shared(secret)
    }

    /// The raw secret (the stream keys are derived from it).
    pub fn secret(&self) -> &[u8] {
        &self.0
    }

    /// The sender's control channel keys.
    pub fn control_keys(&self) -> Result<Keys> {
        Keys::control(&self.0)
    }
}

/// What pair-setup learned about the receiver.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReceiverIdentity {
    pub id: Vec<u8>,
    pub public_key: [u8; ED25519_PUBLIC_KEY_LEN],
}

// ---------------------------------------------------------------------------
// Helpers

fn parse(body: &[u8], what: &str, expect_state: u8) -> Result<Tlv8> {
    let tlv = Tlv8::decode(body)
        .map_err(|e| Error::new(e.kind(), format!("pairing: {what}: {}", e.message())))?;
    if let Err(e) = tlv.check_error() {
        let hint = match tlv.get_u8(tag::ERROR) {
            Some(errors::AUTHENTICATION) => " (wrong PIN or unknown controller?)",
            Some(errors::BACKOFF) | Some(errors::MAX_TRIES) => " (too many attempts; wait)",
            Some(errors::UNAVAILABLE) | Some(errors::MAX_PEERS) => " (receiver not pairable now)",
            _ => "",
        };
        return Err(Error::auth(format!("pairing: {what}: {e}{hint}")));
    }
    match tlv.state() {
        Some(s) if s == expect_state => Ok(tlv),
        Some(s) => Err(Error::protocol(format!(
            "pairing: {what}: expected state {expect_state}, got {s}"
        ))),
        None => Err(Error::protocol(format!("pairing: {what}: missing state"))),
    }
}

fn key32(salt: &[u8], ikm: &[u8], info: &[u8]) -> Result<[u8; 32]> {
    hkdf_sha512_array(salt, ikm, info)
}

fn public_key32(v: &[u8], what: &str) -> Result<[u8; 32]> {
    v.try_into()
        .map_err(|_| Error::protocol(format!("pairing: {what} must be 32 bytes")))
}

fn open(key: &[u8; 32], label: &[u8], data: &[u8], what: &str) -> Result<Tlv8> {
    let cipher = ChaCha20Poly1305::new(key);
    let plain = cipher
        .open(&nonce_label(label)?, &[], data)
        .map_err(|_| Error::crypto(format!("pairing: {what}: decryption failed")))?;
    Tlv8::decode(&plain).map_err(|e| Error::malformed(format!("pairing: {what}: {e}")))
}

fn seal(key: &[u8; 32], label: &[u8], tlv: &Tlv8) -> Result<Vec<u8>> {
    Ok(ChaCha20Poly1305::new(key).seal(&nonce_label(label)?, &[], &tlv.encode()))
}

// ---------------------------------------------------------------------------
// Pair-setup steps

/// M1: start pair-setup (`transient` adds `Flags = 0x10`).
pub fn setup_m1(transient: bool) -> Vec<u8> {
    let mut tlv = Tlv8::new()
        .with_u8(tag::METHOD, method::PAIR_SETUP)
        .with_u8(tag::STATE, 1);
    if transient {
        tlv.push_u8(tag::FLAGS, FLAG_TRANSIENT);
    }
    tlv.encode()
}

/// The receiver's SRP parameters from M2.
#[derive(Debug, Clone)]
pub struct SetupM2 {
    pub salt: Vec<u8>,
    pub public_key: Vec<u8>,
}

pub fn parse_setup_m2(body: &[u8]) -> Result<SetupM2> {
    let tlv = parse(body, "pair-setup M2", 2)?;
    Ok(SetupM2 {
        salt: tlv.require(tag::SALT)?.to_vec(),
        public_key: tlv.require(tag::PUBLIC_KEY)?.to_vec(),
    })
}

/// M3: the SRP public key and proof for `pin`.
pub fn setup_m3(m2: &SetupM2, pin: &str) -> Result<(Vec<u8>, SrpClient)> {
    let srp = SrpClient::new(HAP_USERNAME, pin.as_bytes(), &m2.salt, &m2.public_key)?;
    let body = Tlv8::new()
        .with_u8(tag::STATE, 3)
        .with(tag::PUBLIC_KEY, srp.public_key())
        .with(tag::PROOF, srp.proof().to_vec())
        .encode();
    Ok((body, srp))
}

/// M4: checks the receiver's SRP proof; returns the session key `K`.
pub fn parse_setup_m4(body: &[u8], srp: SrpClient) -> Result<[u8; HASH_LEN]> {
    let tlv = parse(body, "pair-setup M4", 4)?;
    srp.verify(tlv.require(tag::PROOF)?)
}

/// M5: our identifier, long-term public key and signature, encrypted.
pub fn setup_m5(k: &[u8], identity: &Identity) -> Result<Vec<u8>> {
    let enc_key = key32(SETUP_ENCRYPT_SALT, k, SETUP_ENCRYPT_INFO)?;
    let ios_x = key32(SETUP_CONTROLLER_SIGN_SALT, k, SETUP_CONTROLLER_SIGN_INFO)?;
    let ltpk = identity.public_key();
    let id = identity.id.as_bytes();
    let signature = identity.key.sign(&[&ios_x[..], id, &ltpk].concat());
    let sub = Tlv8::new()
        .with(tag::IDENTIFIER, id)
        .with(tag::PUBLIC_KEY, ltpk.to_vec())
        .with(tag::SIGNATURE, signature.to_vec());
    let encrypted = seal(&enc_key, b"PS-Msg05", &sub)?;
    Ok(encrypted)
}

fn setup_m5_body(encrypted: Vec<u8>) -> Vec<u8> {
    Tlv8::new()
        .with_u8(tag::STATE, 5)
        .with(tag::ENCRYPTED_DATA, encrypted)
        .encode()
}

/// M6: decrypts and checks the receiver's long-term key and signature.
pub fn open_setup_m6(k: &[u8], encrypted: &[u8]) -> Result<ReceiverIdentity> {
    let enc_key = key32(SETUP_ENCRYPT_SALT, k, SETUP_ENCRYPT_INFO)?;
    let sub = open(&enc_key, b"PS-Msg06", encrypted, "pair-setup M6")?;
    let id = sub.require(tag::IDENTIFIER)?.to_vec();
    let public_key = public_key32(sub.require(tag::PUBLIC_KEY)?, "receiver public key")?;
    let signature = sub.require(tag::SIGNATURE)?;
    let acc_x = key32(SETUP_ACCESSORY_SIGN_SALT, k, SETUP_ACCESSORY_SIGN_INFO)?;
    ed25519_verify(
        &public_key,
        &[&acc_x[..], &id, &public_key].concat(),
        signature,
    )
    .map_err(|_| Error::auth("pairing: pair-setup M6: bad receiver signature"))?;
    Ok(ReceiverIdentity { id, public_key })
}

pub fn parse_setup_m6(body: &[u8], k: &[u8]) -> Result<ReceiverIdentity> {
    let tlv = parse(body, "pair-setup M6", 6)?;
    open_setup_m6(k, tlv.require(tag::ENCRYPTED_DATA)?)
}

// ---------------------------------------------------------------------------
// Pair-verify steps

/// M1: our ephemeral X25519 public key.
pub fn verify_m1(ephemeral_public: &[u8]) -> Vec<u8> {
    Tlv8::new()
        .with_u8(tag::STATE, 1)
        .with(tag::PUBLIC_KEY, ephemeral_public)
        .encode()
}

/// The receiver's M2: its ephemeral key and encrypted proof.
#[derive(Debug, Clone)]
pub struct VerifyM2 {
    pub public_key: [u8; 32],
    pub encrypted: Vec<u8>,
}

pub fn parse_verify_m2(body: &[u8]) -> Result<VerifyM2> {
    let tlv = parse(body, "pair-verify M2", 2)?;
    Ok(VerifyM2 {
        public_key: public_key32(tlv.require(tag::PUBLIC_KEY)?, "receiver ephemeral key")?,
        encrypted: tlv.require(tag::ENCRYPTED_DATA)?.to_vec(),
    })
}

/// The core of pair-verify once the X25519 secret is known: checks the
/// receiver's signature in M2 and returns M3's encrypted data.
pub fn verify_exchange(
    identity: &Identity,
    receiver_id: &[u8],
    receiver_ltpk: &[u8; 32],
    our_ephemeral: &[u8; 32],
    m2: &VerifyM2,
    shared: &[u8],
) -> Result<Vec<u8>> {
    let key = key32(VERIFY_ENCRYPT_SALT, shared, VERIFY_ENCRYPT_INFO)?;
    let sub = open(&key, b"PV-Msg02", &m2.encrypted, "pair-verify M2")?;
    let id = sub.require(tag::IDENTIFIER)?;
    if id != receiver_id {
        return Err(Error::auth(format!(
            "pairing: pair-verify M2: receiver id {:?} does not match the paired id {:?} (re-pair?)",
            String::from_utf8_lossy(id),
            String::from_utf8_lossy(receiver_id)
        )));
    }
    let signature = sub.require(tag::SIGNATURE)?;
    let info = [&m2.public_key[..], id, our_ephemeral].concat();
    ed25519_verify(receiver_ltpk, &info, signature)
        .map_err(|_| Error::auth("pairing: pair-verify M2: bad receiver signature (re-pair?)"))?;
    let our_id = identity.id.as_bytes();
    let ours = [&our_ephemeral[..], our_id, &m2.public_key].concat();
    let sub = Tlv8::new()
        .with(tag::IDENTIFIER, our_id)
        .with(tag::SIGNATURE, identity.key.sign(&ours).to_vec());
    seal(&key, b"PV-Msg03", &sub)
}

fn verify_m3_body(encrypted: Vec<u8>) -> Vec<u8> {
    Tlv8::new()
        .with_u8(tag::STATE, 3)
        .with(tag::ENCRYPTED_DATA, encrypted)
        .encode()
}

// ---------------------------------------------------------------------------
// Drivers

/// `POST /pair-pin-start`: asks the receiver to show its PIN.
pub fn pin_start<T: Transport>(t: &mut T) -> Result<()> {
    t.post("/pair-pin-start", Hkp::Normal, &[]).map(|_| ())
}

/// Pair-setup with a PIN. Sends `/pair-pin-start` (if `show_pin`) and
/// M1, then calls `get_pin` (the TV shows it by now), then finishes
/// M3–M6.
pub fn pair_setup_pin<T: Transport>(
    t: &mut T,
    identity: &Identity,
    show_pin: bool,
    get_pin: impl FnOnce() -> Result<String>,
) -> Result<ReceiverIdentity> {
    if show_pin {
        debug!("pair-setup: /pair-pin-start");
        pin_start(t)?;
    }
    debug!("pair-setup: M1");
    let m2 = parse_setup_m2(&t.post("/pair-setup", Hkp::Normal, &setup_m1(false))?)?;
    debug!(
        "pair-setup: M2 (salt {} bytes, B {} bytes)",
        m2.salt.len(),
        m2.public_key.len()
    );
    let pin = get_pin()?;
    let pin = pin.as_str();
    if pin.is_empty() {
        return Err(Error::usage("pairing: empty PIN"));
    }
    let (m3, srp) = setup_m3(&m2, pin)?;
    debug!("pair-setup: M3");
    let k = parse_setup_m4(&t.post("/pair-setup", Hkp::Normal, &m3)?, srp)?;
    debug!("pair-setup: M4 ok, M5");
    let m5 = setup_m5_body(setup_m5(&k, identity)?);
    let receiver = parse_setup_m6(&t.post("/pair-setup", Hkp::Normal, &m5)?, &k)?;
    debug!(
        "pair-setup: M6 ok, receiver id {:?}",
        String::from_utf8_lossy(&receiver.id)
    );
    Ok(receiver)
}

/// Transient pair-setup (M1–M4 with PIN 3939). The caller enables the
/// encrypted channel with the result right after.
pub fn pair_setup_transient<T: Transport>(t: &mut T) -> Result<Shared> {
    pair_setup_transient_for(t, false)
}

/// The empty SRP password some senders use for transient pairing
/// (spec `airplay-mirroring.md` Appendix A).
pub const TRANSIENT_PIN_EMPTY: &str = "";

fn transport_failure(e: &Error) -> bool {
    matches!(
        e.kind(),
        ErrorKind::Io | ErrorKind::Closed | ErrorKind::Timeout
    )
}

/// Transient pair-setup with the receiver-family rules of the spec
/// (`airplay-mirroring.md` Appendix A):
///
/// - `X-Apple-HKP`: 4 for Apple receivers, 3 for legacy-preferring ones
///   (`legacy_preferring`: no CoreUtils pairing bit, or bit 26/51); if
///   the receiver rejects M1 (an error status or a TLV error in M2),
///   retry once with the other value.
/// - SRP password `3939`; if M4 fails authentication, retry once from M1
///   with the empty password.
///
/// A receiver that accepts the first try sees exactly the old exchange.
pub fn pair_setup_transient_for<T: Transport>(
    t: &mut T,
    legacy_preferring: bool,
) -> Result<Shared> {
    let hkps = if legacy_preferring {
        [Hkp::Normal, Hkp::Transient]
    } else {
        [Hkp::Transient, Hkp::Normal]
    };
    let pins = [TRANSIENT_PIN, TRANSIENT_PIN_EMPTY];
    let (mut hkp_i, mut pin_i) = (0, 0);
    loop {
        let hkp = hkps[hkp_i];
        debug!("transient pair-setup: M1 (HKP {})", hkp.as_str());
        let m2 = match t
            .post("/pair-setup", hkp, &setup_m1(true))
            .and_then(|b| parse_setup_m2(&b))
        {
            Ok(m2) => m2,
            Err(e) if transport_failure(&e) || hkp_i == 1 => return Err(e),
            Err(e) => {
                debug!(
                    "transient pair-setup: {e}; retrying with HKP {}",
                    hkps[1].as_str()
                );
                hkp_i = 1;
                continue;
            }
        };
        let (m3, srp) = setup_m3(&m2, pins[pin_i])?;
        debug!("transient pair-setup: M3");
        match t
            .post("/pair-setup", hkp, &m3)
            .and_then(|b| parse_setup_m4(&b, srp))
        {
            Ok(k) => {
                debug!("transient pair-setup: M4 ok");
                return Ok(Shared(k.to_vec()));
            }
            Err(e) if e.kind() == ErrorKind::Auth && pin_i == 0 => {
                debug!("transient pair-setup: {e}; retrying with the empty password");
                pin_i = 1;
            }
            Err(e) => return Err(e),
        }
    }
}

/// Pair-verify against a paired receiver. The caller enables the
/// encrypted channel with the result right after.
pub fn pair_verify<T: Transport>(
    t: &mut T,
    identity: &Identity,
    receiver_id: &[u8],
    receiver_ltpk: &[u8; 32],
) -> Result<Shared> {
    let eph = X25519Ephemeral::generate()?;
    let our_public = eph.public_key();
    debug!("pair-verify: M1");
    let m2 = parse_verify_m2(&t.post("/pair-verify", Hkp::Normal, &verify_m1(&our_public))?)?;
    let shared = eph.agree(&m2.public_key)?;
    let m3 = verify_exchange(
        identity,
        receiver_id,
        receiver_ltpk,
        &our_public,
        &m2,
        &shared,
    )?;
    debug!("pair-verify: M2 ok, M3");
    let m4 = t.post("/pair-verify", Hkp::Normal, &verify_m3_body(m3))?;
    parse(&m4, "pair-verify M4", 4).map_err(|e| {
        if e.kind() == ErrorKind::Auth {
            Error::auth(format!(
                "{} (receiver forgot this pairing? re-pair)",
                e.message()
            ))
        } else {
            e
        }
    })?;
    debug!("pair-verify: M4 ok");
    Ok(Shared(shared.to_vec()))
}

#[cfg(test)]
pub(crate) mod fake;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crypto::ring::Ed25519KeyPair;
    use crate::util::vectors;

    fn identity(b: &vectors::Block, who: &str) -> Identity {
        Identity {
            id: String::from_utf8(b.hex(&format!("{who}_id"))).unwrap(),
            key: Ed25519KeyPair::from_seed_slice(&b.hex(&format!("{who}_seed"))).unwrap(),
        }
    }

    #[test]
    fn normalize_pin_and_password() {
        assert_eq!(PinKind::Shown.normalize(" 1234\n"), "1234");
        assert_eq!(
            PinKind::Password.normalize(" pass word \r\n"),
            " pass word "
        );
        assert_eq!(PinKind::Password.normalize("secret\n"), "secret");
    }

    #[test]
    fn setup_m5_m6_vectors() {
        let blocks = vectors::load("airplay/pairing.txt");
        let b = &blocks[0];
        let controller = identity(b, "controller");
        let k = b.hex("K");
        assert_eq!(setup_m5(&k, &controller).unwrap(), b.hex("m5_encrypted"));
        let r = open_setup_m6(&k, &b.hex("m6_encrypted")).unwrap();
        let acc = identity(b, "accessory");
        assert_eq!(r.id, acc.id.as_bytes());
        assert_eq!(r.public_key, acc.public_key());
        // Transient: K keys the control channel.
        let keys = Shared::new(k.clone()).control_keys().unwrap();
        assert_eq!(keys.write.to_vec(), b.hex("transient_write_key"));
        assert_eq!(keys.read.to_vec(), b.hex("transient_read_key"));
        // A flipped byte fails authentication, a wrong K too.
        let mut bad = b.hex("m6_encrypted");
        bad[10] ^= 1;
        assert_eq!(
            open_setup_m6(&k, &bad).unwrap_err().kind(),
            ErrorKind::Crypto
        );
        assert!(open_setup_m6(&k[1..], &b.hex("m6_encrypted")).is_err());
    }

    #[test]
    fn verify_m2_m3_vectors() {
        let blocks = vectors::load("airplay/pairing.txt");
        let b = &blocks[1];
        let controller = identity(b, "controller");
        let acc = identity(b, "accessory");
        let m2 = VerifyM2 {
            public_key: b.hex("accessory_ephemeral").try_into().unwrap(),
            encrypted: b.hex("m2_encrypted"),
        };
        let ours: [u8; 32] = b.hex("controller_ephemeral").try_into().unwrap();
        let shared = b.hex("shared");
        let m3 = verify_exchange(
            &controller,
            acc.id.as_bytes(),
            &acc.public_key(),
            &ours,
            &m2,
            &shared,
        )
        .unwrap();
        assert_eq!(m3, b.hex("m3_encrypted"));
        let keys = Shared::new(shared.clone()).control_keys().unwrap();
        assert_eq!(keys.write.to_vec(), b.hex("control_write_key"));
        assert_eq!(keys.read.to_vec(), b.hex("control_read_key"));

        // Wrong receiver id or key is an auth error.
        let err = verify_exchange(
            &controller,
            b"other",
            &acc.public_key(),
            &ours,
            &m2,
            &shared,
        )
        .unwrap_err();
        assert_eq!(err.kind(), ErrorKind::Auth);
        let err = verify_exchange(
            &controller,
            acc.id.as_bytes(),
            &controller.public_key(),
            &ours,
            &m2,
            &shared,
        )
        .unwrap_err();
        assert_eq!(err.kind(), ErrorKind::Auth);
    }

    #[test]
    fn m1_layout_and_peer_errors() {
        assert_eq!(setup_m1(false), [0, 1, 0, 6, 1, 1]);
        assert_eq!(setup_m1(true), [0, 1, 0, 6, 1, 1, 0x13, 1, 0x10]);
        // M2 carrying an error (state 2, error 6 = unavailable).
        let err = parse_setup_m2(&[6, 1, 2, 7, 1, 6]).unwrap_err();
        assert_eq!(err.kind(), ErrorKind::Auth);
        assert!(err.message().contains("not pairable"), "{err}");
        // Wrong state, garbage, empty.
        assert_eq!(
            parse_setup_m2(&[6, 1, 4]).unwrap_err().kind(),
            ErrorKind::Protocol
        );
        assert!(parse_setup_m2(&[6, 5, 1]).is_err());
        assert!(parse_setup_m2(&[]).is_err());
        assert!(parse_verify_m2(&[6, 1, 2, 3, 2, 0, 0, 5, 0]).is_err());
    }
}

/// Hostile-input smoke tests: random and mutated bodies for every parser
/// must give errors, never panics.
#[cfg(test)]
mod fuzz {
    use super::*;
    use crate::airplay::info::Info;
    use crate::airplay::secure::SecureStream;
    use crate::net::http::tests::Duplex;

    struct Rng(u64);

    impl Rng {
        fn next(&mut self) -> u64 {
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 7;
            self.0 ^= self.0 << 17;
            self.0
        }

        fn below(&mut self, n: usize) -> usize {
            (self.next() % n as u64) as usize
        }

        fn mutate(&mut self, seed: &[u8]) -> Vec<u8> {
            let mut v = seed.to_vec();
            for _ in 0..1 + self.below(6) {
                match self.below(4) {
                    0 if !v.is_empty() => {
                        let i = self.below(v.len());
                        v[i] ^= 1 << self.below(8);
                    }
                    1 if !v.is_empty() => {
                        let i = self.below(v.len());
                        v[i] = [0, 1, 0xff, 0x7f, 2][self.below(5)];
                    }
                    2 => v.truncate(self.below(v.len() + 1)),
                    _ => {
                        let i = self.below(v.len() + 1);
                        v.insert(i, self.next() as u8);
                    }
                }
            }
            v
        }
    }

    #[test]
    fn parsers_never_panic() {
        let m2 = Tlv8::new()
            .with_u8(tag::STATE, 2)
            .with(tag::SALT, vec![1; 16])
            .with(tag::PUBLIC_KEY, vec![0x55; 384])
            .encode();
        let m4 = Tlv8::new()
            .with_u8(tag::STATE, 4)
            .with(tag::PROOF, vec![3; 64])
            .encode();
        let m6 = Tlv8::new()
            .with_u8(tag::STATE, 6)
            .with(tag::ENCRYPTED_DATA, vec![9; 150])
            .encode();
        let v2 = Tlv8::new()
            .with_u8(tag::STATE, 2)
            .with(tag::PUBLIC_KEY, vec![4; 32])
            .with(tag::ENCRYPTED_DATA, vec![5; 120])
            .encode();
        let info = crate::util::vectors::fixture("net/appletv-info.rtsp");
        let info_body = info[info.windows(8).position(|w| w == b"bplist00").unwrap()..].to_vec();
        let identity = Identity::generate().unwrap();
        let k = [7u8; 64];
        let mut rng = Rng(0x9e37_79b9_7f4a_7c15);
        for _ in 0..3000 {
            let _ = parse_setup_m2(&rng.mutate(&m2));
            let _ = parse_setup_m6(&rng.mutate(&m6), &k);
            let _ = open_setup_m6(&k, &rng.mutate(&[0; 100]));
            if let Ok(m2) = parse_verify_m2(&rng.mutate(&v2)) {
                let _ = verify_exchange(&identity, b"id", &[1; 32], &[2; 32], &m2, &[3; 32]);
            }
            let _ = parse(&rng.mutate(&m4), "m4", 4);
            let _ = Info::parse(&rng.mutate(&info_body));
        }
        // M3 setup with hostile B values (zero, N, too long) errors.
        for b in [
            vec![0u8; 384],
            crate::crypto::srp::N_3072.to_vec(),
            vec![0xff; 400],
        ] {
            let m2 = SetupM2 {
                salt: vec![1; 16],
                public_key: b,
            };
            assert!(setup_m3(&m2, "1234").is_err());
        }
    }

    #[test]
    fn secure_stream_never_panics() {
        let keys = Keys::control(b"k").unwrap();
        let mut w = SecureStream::new(Duplex::new(&[]), &keys.swapped());
        use std::io::{Read, Write};
        w.write_all(b"RTSP/1.0 200 OK\r\nContent-Length: 0\r\n\r\n")
            .unwrap();
        let wire = w.into_inner().output;
        let mut rng = Rng(42);
        for _ in 0..2000 {
            let input = rng.mutate(&wire);
            let mut d = Duplex::new(&input);
            d.piece = 1 + rng.below(50);
            let mut r = SecureStream::new(d, &keys);
            let mut out = Vec::new();
            let _ = r.read_to_end(&mut out);
        }
    }
}
