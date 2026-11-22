//! `tvpipe pair` / `unpair` and [`connect`], the
//! authenticated control connection the mirroring sink starts from.
//!
//! `connect` opens the control port, pair-verifies with stored
//! credentials (or does transient pair-setup when the receiver allows
//! it), and switches the connection to the encrypted channel. The
//! returned [`Control`] carries the RTSP client and the shared secret.

use std::net::{IpAddr, SocketAddr, TcpStream};
use std::time::Duration;

use crate::airplay::credentials::{Identity, Query, Receiver, Store};
use crate::airplay::discovery;
use crate::airplay::info::{get_info, Info};
use crate::airplay::pairing::{self, PinKind, Shared};
use crate::airplay::secure::SecureStream;
use crate::ctx::Ctx;
use crate::error::{Error, ErrorKind, Result};
use crate::events::{Event, Paired, PinRequest, Progress, Step, Unpaired};
use crate::net::device::Device;
use crate::net::discover;
use crate::net::http::Conn;
use crate::net::rtsp::RtspClient;

/// The AirPlay control port when only an address is given.
pub const DEFAULT_PORT: u16 = 7000;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const IO_TIMEOUT: Duration = Duration::from_secs(15);
const DISCOVER_TIMEOUT: Duration = Duration::from_secs(4);
/// How long `pair` looks for the advertisement of a receiver given by address.
const ADVERTISED_TIMEOUT: Duration = Duration::from_millis(1500);

/// The encrypted control connection.
pub type SecureClient = RtspClient<SecureStream<TcpStream>>;

/// How [`connect`] authenticated.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Auth {
    /// Pair-verify with stored credentials.
    Verified(Receiver),
    /// Transient pair-setup (no stored credentials needed).
    Transient,
}

/// An authenticated, encrypted control connection.
pub struct Control {
    pub client: SecureClient,
    /// The pairing's shared secret (the stream keys are derived from it).
    pub shared: Shared,
    pub addr: SocketAddr,
    pub auth: Auth,
}

impl std::fmt::Debug for Control {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Control")
            .field("addr", &self.addr)
            .field("auth", &self.auth)
            .finish_non_exhaustive()
    }
}

/// A resolved `NAME|ADDR`.
#[derive(Debug, Clone)]
pub struct Target {
    pub addr: SocketAddr,
    /// The discovered device, unless an address was given.
    pub device: Option<Device>,
}

impl Target {
    /// The device's display name, else the address.
    pub fn label(&self) -> String {
        self.device
            .as_ref()
            .map(|d| d.name.clone())
            .unwrap_or_else(|| self.addr.to_string())
    }

    /// Its AirPlay (else RAOP) TXT record, if discovery found it.
    pub fn txt(&self) -> Option<&discovery::AirPlayTxt> {
        self.device
            .as_ref()
            .and_then(|d| d.airplay.as_ref().or(d.raop.as_ref()))
            .map(|a| &a.txt)
    }

    /// A credentials query from what discovery knows.
    pub fn query(&self) -> Query<'_> {
        let mut q = Query::default();
        if let Some(d) = &self.device {
            let txt = d.airplay.as_ref().or(d.raop.as_ref()).map(|a| &a.txt);
            q.public_key = txt.and_then(|t| t.pk.as_deref());
            q.device_id = txt.and_then(|t| t.deviceid.as_deref());
            q.names = d.names();
        }
        q
    }
}

/// Parses `ip` or `ip:port` (IPv6 as `[addr]:port`).
fn parse_addr(s: &str) -> Option<SocketAddr> {
    if let Ok(ip) = s.parse::<IpAddr>() {
        return Some(SocketAddr::new(ip, DEFAULT_PORT));
    }
    s.parse::<SocketAddr>().ok()
}

/// Resolves `NAME|ADDR` to the AirPlay control address.
pub fn resolve(target: &str) -> Result<Target> {
    if let Some(addr) = parse_addr(target) {
        return Ok(Target { addr, device: None });
    }
    let device = discover::resolve(target, DISCOVER_TIMEOUT, &[])?.ok_or_else(|| {
        Error::not_found(format!("no receiver named {target:?}"))
            .with_code("no-receiver")
            .with_device(target)
    })?;
    let ep = device
        .airplay
        .as_ref()
        .or(device.raop.as_ref())
        .map(|a| &a.endpoint)
        .ok_or_else(|| Error::unsupported(format!("{} does not speak AirPlay", device.name)))?;
    let addr = SocketAddr::new(ep.addr(), ep.port);
    debug!("resolved {target:?} to {} at {addr}", device.name);
    Ok(Target {
        addr,
        device: Some(device),
    })
}

/// Opens a plain control connection with timeouts set.
pub fn open(addr: SocketAddr) -> Result<RtspClient<TcpStream>> {
    open_within(addr, IO_TIMEOUT)
}

/// [`open`] with `io` as the read and write timeout.
fn open_within(addr: SocketAddr, io: Duration) -> Result<RtspClient<TcpStream>> {
    let stream = TcpStream::connect_timeout(&addr, CONNECT_TIMEOUT.min(io))
        .map_err(|e| Error::io(format!("airplay: connect to {addr}"), e))?;
    stream
        .set_read_timeout(Some(io))
        .and_then(|()| stream.set_write_timeout(Some(io)))
        .and_then(|()| stream.set_nodelay(true))
        .map_err(|e| Error::io("airplay: socket options", e))?;
    Ok(RtspClient::new(stream))
}

/// Switches a plain connection to the encrypted channel keyed by `shared`.
pub fn encrypt(mut client: RtspClient<TcpStream>, shared: &Shared) -> Result<SecureClient> {
    if !client.conn().buffered().is_empty() {
        return Err(Error::protocol(
            "airplay: receiver sent data before the encrypted channel started",
        ));
    }
    let stream = client
        .conn()
        .get_ref()
        .try_clone()
        .map_err(|e| Error::io("airplay: clone socket", e))?;
    let secure = SecureStream::new(stream, &shared.control_keys()?);
    Ok(client.replace_conn(Conn::new(secure)))
}

/// Connects and authenticates: pair-verify with `receiver`, else
/// transient pair-setup.
pub fn connect_with(addr: SocketAddr, identity: &Identity, auth: Auth) -> Result<Control> {
    connect_auth(addr, identity, auth, false, IO_TIMEOUT)
}

/// Whether discovery says the receiver prefers legacy pairing (no
/// CoreUtils pairing bit, or bit 26/51): its transient pair-setup starts
/// with `X-Apple-HKP: 3` (spec `airplay-mirroring.md` Appendix A).
fn legacy_preferring(target: &Target) -> bool {
    target
        .txt()
        .and_then(|t| t.features)
        .is_some_and(crate::airplay::legacy_pair::is_candidate)
}

fn connect_auth(
    addr: SocketAddr,
    identity: &Identity,
    auth: Auth,
    legacy_preferring: bool,
    io: Duration,
) -> Result<Control> {
    let mut client = open_within(addr, io)?;
    let shared = match &auth {
        Auth::Verified(r) => {
            debug!("pair-verify with {} at {addr}", r.name);
            pairing::pair_verify(&mut client, identity, &r.id, &r.public_key)?
        }
        Auth::Transient => {
            debug!("transient pair-setup with {addr}");
            pairing::pair_setup_transient_for(&mut client, legacy_preferring)?
        }
    };
    let client = encrypt(client, &shared)?;
    Ok(Control {
        client,
        shared,
        addr,
        auth,
    })
}

/// Connects to a resolved target with the credentials in `store`: stored
/// pairing first, transient pair-setup otherwise.
pub fn connect(target: &Target, store: &Store) -> Result<Control> {
    connect_within(target, store, IO_TIMEOUT)
}

/// [`connect`] that has to authenticate within `io` (per read).
pub fn connect_within(target: &Target, store: &Store, io: Duration) -> Result<Control> {
    let found = store.find(&target.query()).or_else(|| {
        let ip = target.addr.ip().to_string();
        store.find(&Query {
            addr: Some(&ip),
            ..Query::default()
        })
    });
    // Legacy raw pairings are verified by `airplay::legacy_pair`.
    match found.filter(|r| !r.raw) {
        // A pairing the receiver refuses (it forgot it, or it was reset)
        // needs a new one, like no pairing at all.
        Some(r) => connect_auth(
            target.addr,
            &store.identity,
            Auth::Verified(r.clone()),
            false,
            io,
        )
        .map_err(|e| {
            if e.kind() == ErrorKind::Auth {
                Error::auth(format!(
                    "{} refused its pairing: run `tvpipe pair {:?}` again ({})",
                    target.label(),
                    target.label(),
                    e.message()
                ))
                .with_code("pairing-required")
                .with_device(target.label())
            } else {
                e
            }
        }),
        None => connect_auth(
            target.addr,
            &store.identity,
            Auth::Transient,
            legacy_preferring(target),
            io,
        )
        .map_err(|e| {
            // An address has no advertisement: look it up to explain the refusal.
            let looked_up =
                (target.device.is_none() && e.kind() == ErrorKind::Auth).then(|| Target {
                    addr: target.addr,
                    device: advertised_at(target.addr),
                });
            let txt = target.txt().or(looked_up.as_ref().and_then(Target::txt));
            let forbidden = e.code() == Some("pairing-forbidden");
            if txt.is_some_and(|t| t.home_only()) {
                crate::airplay::session::home_only(Some(&target.label()))
            } else if forbidden && txt.is_some_and(|t| t.owner_only()) {
                crate::airplay::session::owner_only(Some(&target.label()))
            } else if forbidden && txt.is_some_and(|t| t.homekit()) {
                crate::airplay::session::pairing_forbidden(Some(&target.label()), true)
            } else if e.kind() == ErrorKind::Auth {
                Error::auth(format!(
                    "{} requires pairing: run `tvpipe pair {:?}` ({})",
                    target.label(),
                    target.label(),
                    e.message()
                ))
                .with_code("pairing-required")
                .with_device(target.label())
            } else {
                e
            }
        }),
    }
}

/// The AirPlay receiver advertised at `addr`, if discovery finds one.
fn advertised_at(addr: SocketAddr) -> Option<Device> {
    discover::at(addr, ADVERTISED_TIMEOUT)
        .map_err(|e| debug!("pair: discovery: {e}"))
        .ok()?
}

/// Whether discovery says only its Apple Home's members may use it.
pub(crate) fn home_only(target: &Target) -> bool {
    target.txt().is_some_and(|t| t.home_only())
}

/// [`PinKind::from_status`] from the plain `/info`, else from discovery.
fn pin_kind(target: &Target, plain_info: Option<&Info>) -> PinKind {
    match plain_info.and_then(|i| Some((i.status_flags?, i.features))) {
        Some((flags, features)) => PinKind::from_status(flags as u32, features),
        None => target.txt().map_or(PinKind::Shown, |t| t.pin_kind()),
    }
}

/// Pairs with `target` and stores the credentials in `store`. With `pin`
/// given, the receiver is assumed to have a fixed PIN and
/// `/pair-pin-start` is skipped; without it, the TV shows a PIN and
/// `get_pin` is asked for it (or for the receiver's password).
pub fn pair_with(
    target: &Target,
    store: &mut Store,
    pin: Option<&str>,
    get_pin: impl FnOnce(PinKind) -> Result<String>,
) -> Result<Receiver> {
    let mut client = open(target.addr)?;
    let plain_info = get_info(&mut client)
        .map_err(|e| debug!("pair: plain /info failed: {e}"))
        .ok();
    let kind = pin_kind(target, plain_info.as_ref());
    let homekit = plain_info
        .as_ref()
        .map(crate::airplay::session::homekit)
        .unwrap_or_else(|| target.txt().is_some_and(|t| t.homekit()));
    let owner_only = target.txt().is_some_and(|t| t.owner_only());
    let forbidden = |e: Error| match e.code() {
        Some("pairing-forbidden") if owner_only => {
            crate::airplay::session::owner_only(Some(&target.label()))
        }
        Some("pairing-forbidden") => {
            crate::airplay::session::pairing_forbidden(Some(&target.label()), homekit)
        }
        _ => e,
    };
    let receiver = match pin {
        Some(pin) => {
            let pin = kind.normalize(pin);
            pairing::pair_setup_pin(&mut client, &store.identity, false, move || Ok(pin))
                .map_err(forbidden)?
        }
        None => pairing::pair_setup_pin(&mut client, &store.identity, kind.shows_pin(), || {
            Ok(kind.normalize(&get_pin(kind)?))
        })
        .map_err(forbidden)?,
    };
    drop(client);
    if let Some(pk) = plain_info.as_ref().and_then(|i| i.pk.as_deref()) {
        if pk != receiver.public_key {
            debug!("pair: /info pk differs from the pair-setup key");
        }
    }
    let name = target
        .device
        .as_ref()
        .map(|d| d.name.clone())
        .or_else(|| plain_info.as_ref().and_then(|i| i.name.clone()))
        .unwrap_or_else(|| target.addr.ip().to_string());
    let device_id = target
        .txt()
        .and_then(|t| t.deviceid.clone())
        .or_else(|| plain_info.as_ref().and_then(|i| i.device_id.clone()));
    let record = Receiver {
        id: receiver.id,
        public_key: receiver.public_key,
        name,
        device_id,
        addr: Some(target.addr.to_string()),
        raw: false,
    };
    store.upsert(record.clone());
    store.save()?;
    Ok(record)
}

/// The `pair` command body. `get_pin` is asked for the PIN the TV shows,
/// after a `pin-required` event.
pub fn pair(
    target: &str,
    pin: Option<&str>,
    ctx: &Ctx,
    get_pin: &mut dyn FnMut(&PinRequest) -> Result<String>,
) -> Result<Paired> {
    ctx.events
        .progress(Progress::Begin(Step::Find(target.to_owned())));
    let found = resolve(target);
    ctx.events.progress(match &found {
        Ok(_) => Progress::Done(Step::Find(target.to_owned()), None),
        Err(e) => Progress::Failed(Step::Find(target.to_owned()), e.to_string()),
    });
    let mut target = found?;
    // By address: its advertisement says whether its home takes pairings.
    if target.device.is_none() {
        target.device = advertised_at(target.addr);
    }
    let mut store = Store::open(&ctx.storage)?;
    let label = target.label();
    // It would pair, and refuse every session.
    if home_only(&target) {
        return Err(crate::airplay::session::home_only(Some(&label)));
    }
    info!("pairing with {label} at {}", target.addr);
    let record = pair_with(&target, &mut store, pin, |kind| {
        let req = PinRequest {
            name: label.clone(),
            address: target.addr.to_string(),
            password: kind.is_password(),
        };
        ctx.events.emit(Event::PinRequired(req.clone()));
        get_pin(&req)
    })?;
    info!(
        "paired with {} (receiver id {}); credentials in {}",
        record.name,
        record.id_display(),
        store.location()
    );
    // Prove the pairing works: verify on a fresh connection and fetch the
    // full /info over the encrypted channel.
    let mut control = connect_with(target.addr, &store.identity, Auth::Verified(record))?;
    let info = get_info(&mut control.client)?;
    let paired = Paired {
        name: label,
        model: info.model.clone(),
        file: store.file().map(|f| f.display().to_string()),
    };
    ctx.events.emit(Event::Paired(paired.clone()));
    Ok(paired)
}

/// The `unpair` command body: forgets the stored pairing.
pub fn unpair(target: &str, ctx: &Ctx) -> Result<Vec<Unpaired>> {
    let mut store = Store::open(&ctx.storage)?;
    let removed = forget(&mut store, target, resolve)?;
    let mut out = Vec::new();
    for r in &removed {
        let u = Unpaired {
            name: r.name.clone(),
            id: r.id_display(),
        };
        ctx.events.emit(Event::Unpaired(u.clone()));
        out.push(u);
    }
    Ok(out)
}

/// Removes the pairings for `target` from `store` and saves it. Looks the
/// target up by name or address first and only calls `resolve` (which
/// browses) when that finds nothing.
pub fn forget(
    store: &mut Store,
    target: &str,
    resolve: impl FnOnce(&str) -> Result<Target>,
) -> Result<Vec<Receiver>> {
    let addr = parse_addr(target).map(|a| a.ip().to_string());
    let local = Query {
        names: if addr.is_none() { vec![target] } else { vec![] },
        addr: addr.as_deref(),
        ..Query::default()
    };
    let mut removed = store.remove(&local);
    if removed.is_empty() && addr.is_none() {
        match resolve(target) {
            Ok(t) => removed = store.remove(&t.query()),
            Err(e) => debug!("unpair: cannot resolve {target:?}: {e}"),
        }
    }
    if removed.is_empty() {
        return Err(Error::not_found(format!(
            "no stored pairing for {target:?}"
        )));
    }
    store.save()?;
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::airplay::credentials::tests::temp_dir;
    use crate::airplay::pairing::fake::{Config, FakeReceiver};
    use crate::storage::Storage;

    fn target(fake: &FakeReceiver) -> Target {
        Target {
            addr: fake.addr,
            device: None,
        }
    }

    #[test]
    fn pin_pair_then_verify_after_restart() {
        let fake = FakeReceiver::start(Config {
            allow_transient: false,
            ..Config::default()
        });
        let path = Storage::dir(temp_dir("pair-pin"));
        let mut store = Store::open(&path).unwrap();
        let record = pair_with(&target(&fake), &mut store, None, |_| Ok("1234".into())).unwrap();
        assert_eq!(record.id, fake.config.id);
        assert_eq!(record.public_key, fake.public_key());
        assert_eq!(record.name, "Fake TV");
        assert_eq!(record.device_id.as_deref(), Some("AA:BB:CC:00:00:0A"));
        assert_eq!(fake.state.lock().unwrap().pin_starts, 1);
        drop(store);

        // A later run: credentials come from disk.
        let store = Store::open(&path).unwrap();
        assert_eq!(store.receivers.len(), 1);
        let mut control = connect(&target(&fake), &store).unwrap();
        assert!(matches!(control.auth, Auth::Verified(_)));
        assert_eq!(control.shared.secret().len(), 32);
        let info = get_info(&mut control.client).unwrap();
        let caps = info.capabilities();
        assert_eq!((caps.max_width, caps.max_height), (3840, 2160));
        assert_eq!(caps.max_fps.num, 60);
        // A second request on the same encrypted connection.
        let resp = control.client.request("OPTIONS", "*", &[], None).unwrap();
        assert_eq!(resp.status, 404);
        let log = fake.log();
        assert!(log.contains(&"secure GET /info".to_string()), "{log:?}");
        assert!(log.contains(&"secure OPTIONS *".to_string()), "{log:?}");
    }

    #[test]
    fn fixed_pin_skips_pin_start() {
        let fake = FakeReceiver::start(Config::default());
        let path = Storage::dir(temp_dir("pair-fixed-pin"));
        let mut store = Store::open(&path).unwrap();
        pair_with(&target(&fake), &mut store, Some("1234"), |_| {
            panic!("not asked")
        })
        .unwrap();
        assert_eq!(fake.state.lock().unwrap().pin_starts, 0);
    }

    /// A receiver with a password: no `/pair-pin-start`, and the asker is told.
    #[test]
    fn password_is_the_pin_and_nothing_is_shown() {
        let pair = |flags: u64, dir: &str, pin: Option<&str>| {
            let fake = FakeReceiver::start(Config {
                status_flags: flags,
                ..Config::default()
            });
            let mut store = Store::open(&Storage::dir(temp_dir(dir))).unwrap();
            let mut asked = None;
            let r = pair_with(&target(&fake), &mut store, pin, |kind| {
                asked = Some(kind);
                Ok(" 1234 ".into())
            });
            let starts = fake.state.lock().unwrap().pin_starts;
            (r.map(|_| ()), asked, starts)
        };
        // A password: asked for as one, taken as typed, nothing shown.
        let (r, asked, starts) = pair(0x4c4, "pair-password", None);
        assert_eq!((asked, starts), (Some(PinKind::Password), 0));
        assert_eq!(r.unwrap_err().kind(), ErrorKind::Auth);
        pair(0x4c4, "pair-password-given", Some("1234")).0.unwrap();
        assert!(pair(0x4c4, "pair-password-spaces", Some("1234 "))
            .0
            .is_err());
        // With the one-time pairing flag 0x200: still the password.
        let (_, asked, starts) = pair(0x6c4, "pair-password-and-otp", None);
        assert_eq!((asked, starts), (Some(PinKind::Password), 0));
        // With the PIN flag (0x8) the PIN is shown, and trimmed.
        let (r, asked, starts) = pair(0x4cc, "pair-password-and-pin", None);
        assert_eq!((asked, starts), (Some(PinKind::Shown), 1));
        r.unwrap();
        pair(0x644, "pair-pin-given", Some(" 1234\n")).0.unwrap();

        let dev = crate::net::device::tests::lan_devices()
            .into_iter()
            .find(|d| d.airplay.is_some())
            .unwrap();
        let t = Target {
            addr: "127.0.0.1:9".parse().unwrap(),
            device: Some(dev),
        };
        assert!(!home_only(&t));
        let mut t = t;
        t.device.as_mut().unwrap().airplay.as_mut().unwrap().txt.acl = Some(1);
        assert!(home_only(&t));
    }

    /// A 403 to pair-setup is `forbidden`, naming the Home only for flag 0x400.
    #[test]
    fn forbidden_pair_setup_names_the_home() {
        let fake = |flags: u64| {
            FakeReceiver::start(Config {
                status_flags: flags,
                forbid_pair_setup: true,
                ..Config::default()
            })
        };
        let paired = |flags: u64, dir: &str| {
            let f = fake(flags);
            let mut store = Store::open(&Storage::dir(temp_dir(dir))).unwrap();
            pair_with(&target(&f), &mut store, Some("1234"), |_| {
                panic!("not asked")
            })
            .unwrap_err()
        };
        let e = paired(0x644, "pair-forbidden-home");
        assert_eq!(e.code(), Some("forbidden"), "{e}");
        assert!(
            e.to_string().contains("refused pairing with 403 Forbidden"),
            "{e}"
        );
        assert!(e.to_string().contains("Anyone On the Same Network"), "{e}");
        let e = paired(0x244, "pair-forbidden");
        assert_eq!(e.code(), Some("forbidden"), "{e}");
        assert!(!e.to_string().contains("Apple Home"), "{e}");

        // An unpaired session gets the same refusal, not "run `tvpipe pair`".
        let f = fake(0x644);
        let mut dev = crate::net::device::tests::lan_devices()
            .into_iter()
            .find(|d| d.airplay.is_some())
            .unwrap();
        dev.airplay.as_mut().unwrap().txt.flags = Some(0x644);
        let t = Target {
            addr: f.addr,
            device: Some(dev),
        };
        let store = Store::open(&Storage::dir(temp_dir("connect-forbidden"))).unwrap();
        let Err(e) = connect(&t, &store) else {
            panic!("connected through a refused pair-setup");
        };
        assert_eq!(e.code(), Some("forbidden"), "{e}");
        assert!(e.to_string().contains("Apple Home"), "{e}");

        // A Mac on "Current User" (`act=2`) names its own setting.
        let f = fake(0x4);
        let mut dev = t.device.clone().unwrap();
        let txt = &mut dev.airplay.as_mut().unwrap().txt;
        txt.flags = Some(0x4);
        txt.act = Some("2".into());
        let t = Target {
            addr: f.addr,
            device: Some(dev),
        };
        let store = Store::open(&Storage::dir(temp_dir("connect-owner-only"))).unwrap();
        let Err(e) = connect(&t, &store) else {
            panic!("connected through a refused pair-setup");
        };
        assert_eq!(e.code(), Some("forbidden"), "{e}");
        assert!(e.to_string().contains("Allow AirPlay for"), "{e}");
        let mut store = Store::open(&Storage::dir(temp_dir("pair-owner-only"))).unwrap();
        let e = pair_with(&t, &mut store, Some("1234"), |_| panic!("not asked")).unwrap_err();
        assert!(e.to_string().contains("Allow AirPlay for"), "{e}");
    }

    #[test]
    fn wrong_pin_is_auth_error() {
        let fake = FakeReceiver::start(Config::default());
        let path = Storage::dir(temp_dir("pair-wrong-pin"));
        let mut store = Store::open(&path).unwrap();
        let err = pair_with(&target(&fake), &mut store, None, |_| Ok("9999".into())).unwrap_err();
        assert_eq!(err.kind(), ErrorKind::Auth, "{err}");
        assert!(store.receivers.is_empty());
    }

    #[test]
    fn transient_when_unpaired() {
        let fake = FakeReceiver::start(Config::default());
        let path = Storage::dir(temp_dir("pair-transient"));
        let store = Store::open(&path).unwrap();
        let mut control = connect(&target(&fake), &store).unwrap();
        assert_eq!(control.auth, Auth::Transient);
        assert_eq!(control.shared.secret().len(), 64);
        let info = get_info(&mut control.client).unwrap();
        assert_eq!(info.displays.len(), 1);
        assert_eq!(
            fake.log(),
            [
                "plain POST /pair-setup",
                "plain POST /pair-setup",
                "secure GET /info"
            ]
        );
    }

    fn setups(fake: &FakeReceiver) -> usize {
        fake.log()
            .iter()
            .filter(|l| *l == "plain POST /pair-setup")
            .count()
    }

    /// Transient HKP by receiver family, with one retry each for the
    /// HKP value and the SRP password (spec airplay-mirroring Appendix A).
    #[test]
    fn transient_hkp_and_password_retries() {
        let lg = || {
            FakeReceiver::start(Config {
                transient_hkp: "3".into(),
                ..Config::default()
            })
        };
        // Legacy-preferring receiver, HKP 3 first: the plain exchange.
        let fake = lg();
        let mut c = connect_auth(
            fake.addr,
            &Identity::generate().unwrap(),
            Auth::Transient,
            true,
            IO_TIMEOUT,
        )
        .unwrap();
        get_info(&mut c.client).unwrap();
        assert_eq!(setups(&fake), 2);
        // Apple order against it: HKP 4 is rejected at M1, HKP 3 works.
        let fake = lg();
        let mut c =
            connect_with(fake.addr, &Identity::generate().unwrap(), Auth::Transient).unwrap();
        get_info(&mut c.client).unwrap();
        assert_eq!(setups(&fake), 3);
        // Empty transient password: 3939 fails at M4, the retry works.
        let fake = FakeReceiver::start(Config {
            transient_pin: String::new(),
            ..Config::default()
        });
        let mut c =
            connect_with(fake.addr, &Identity::generate().unwrap(), Auth::Transient).unwrap();
        get_info(&mut c.client).unwrap();
        assert_eq!(setups(&fake), 4);
        // Neither HKP accepted: an error after two M1 tries.
        let fake = FakeReceiver::start(Config {
            transient_hkp: "9".into(),
            ..Config::default()
        });
        let err =
            connect_with(fake.addr, &Identity::generate().unwrap(), Auth::Transient).unwrap_err();
        assert_eq!(err.kind(), ErrorKind::Auth, "{err}");
        assert_eq!(setups(&fake), 2);
    }

    /// `connect` picks HKP 3 first from the discovered features.
    #[test]
    fn connect_uses_discovered_family() {
        let fake = FakeReceiver::start(Config {
            transient_hkp: "3".into(),
            ..Config::default()
        });
        let mut dev = crate::net::device::tests::lan_devices()
            .into_iter()
            .find(|d| d.airplay.is_some())
            .unwrap();
        dev.airplay.as_mut().unwrap().txt.features = Some(1 << 7 | 1 << 26 | 1 << 48);
        let t = Target {
            addr: fake.addr,
            device: Some(dev),
        };
        let path = Storage::dir(temp_dir("pair-family"));
        let store = Store::open(&path).unwrap();
        assert!(legacy_preferring(&t));
        connect(&t, &store).unwrap();
        assert_eq!(setups(&fake), 2);
        assert!(!legacy_preferring(&target(&fake)));
    }

    #[test]
    fn unpaired_and_no_transient_says_pair() {
        let fake = FakeReceiver::start(Config {
            allow_transient: false,
            ..Config::default()
        });
        let path = Storage::dir(temp_dir("pair-required"));
        let store = Store::open(&path).unwrap();
        let err = connect(&target(&fake), &store).unwrap_err();
        assert_eq!(err.kind(), ErrorKind::Auth);
        assert!(err.message().contains("tvpipe pair"), "{err}");
        assert_eq!(err.code(), Some("pairing-required"));
    }

    #[test]
    fn forget_by_name_address_or_discovery() {
        let fake = FakeReceiver::start(Config::default());
        let path = Storage::dir(temp_dir("pair-forget"));
        let mut store = Store::open(&path).unwrap();
        pair_with(&target(&fake), &mut store, None, |_| Ok("1234".into())).unwrap();
        let no_browse = |_: &str| -> Result<Target> { panic!("should not browse") };
        let removed = forget(&mut store, "fake tv", no_browse).unwrap();
        assert_eq!(removed.len(), 1);
        assert!(Store::open(&path).unwrap().receivers.is_empty());

        pair_with(&target(&fake), &mut store, None, |_| Ok("1234".into())).unwrap();
        let ip = fake.addr.ip().to_string();
        assert_eq!(forget(&mut store, &ip, no_browse).unwrap().len(), 1);

        // Unknown name: falls back to discovery, then reports not found.
        let err = forget(&mut store, "Other", |_| Err(Error::not_found("x"))).unwrap_err();
        assert_eq!(err.kind(), ErrorKind::NotFound);
    }

    #[test]
    fn repeated_verify_and_repair() {
        let fake = FakeReceiver::start(Config::default());
        let path = Storage::dir(temp_dir("pair-repeat"));
        let mut store = Store::open(&path).unwrap();
        pair_with(&target(&fake), &mut store, None, |_| Ok("1234".into())).unwrap();
        let mut secrets = Vec::new();
        for _ in 0..3 {
            let mut c = connect(&target(&fake), &store).unwrap();
            assert!(matches!(c.auth, Auth::Verified(_)));
            get_info(&mut c.client).unwrap();
            secrets.push(c.shared.secret().to_vec());
        }
        // Fresh ephemeral keys every time.
        assert_ne!(secrets[0], secrets[1]);
        // Pairing again replaces the record instead of adding one.
        pair_with(&target(&fake), &mut store, None, |_| Ok("1234".into())).unwrap();
        assert_eq!(Store::open(&path).unwrap().receivers.len(), 1);
    }

    #[test]
    fn verify_fails_when_receiver_forgot_us() {
        let fake = FakeReceiver::start(Config::default());
        let path = Storage::dir(temp_dir("pair-forgotten"));
        let mut store = Store::open(&path).unwrap();
        pair_with(&target(&fake), &mut store, None, |_| Ok("1234".into())).unwrap();
        fake.state.lock().unwrap().pairings.clear();
        let err = connect(&target(&fake), &store).unwrap_err();
        assert_eq!(err.kind(), ErrorKind::Auth, "{err}");
        assert!(err.message().contains("re-pair"), "{err}");
        // Like no pairing: the launcher and the API's `on_pin` pair again.
        assert_eq!(err.code(), Some("pairing-required"));
        assert_eq!(err.device(), Some(fake.addr.to_string().as_str()));

        // A stored key that does not match the receiver fails in M2.
        store.receivers[0].public_key = [1; 32];
        let err = connect(&target(&fake), &store).unwrap_err();
        assert_eq!(err.kind(), ErrorKind::Auth, "{err}");
    }
}

/// Hardware checks against a real receiver, run by hand (they use the
/// real credential store, like the CLI):
///
/// ```text
/// TVPIPE_ATV=192.168.1.34 cargo test hardware_pair -- --ignored --nocapture
/// TVPIPE_ATV=192.168.1.34 cargo test hardware_verify -- --ignored --nocapture
/// ```
#[cfg(test)]
mod hardware {
    use super::*;

    fn atv() -> Option<Target> {
        let addr = parse_addr(&std::env::var("TVPIPE_ATV").ok()?)?;
        crate::log::to_stderr(crate::log::Level::Trace);
        Some(Target { addr, device: None })
    }

    #[test]
    #[ignore]
    fn hardware_plain_info() {
        let Some(t) = atv() else { return };
        let mut c = open(t.addr).unwrap();
        let info = get_info(&mut c).unwrap();
        eprintln!("{info:#?}");
    }

    /// Interactive: reads the PIN shown on the TV from stdin.
    #[test]
    #[ignore]
    fn hardware_pair() {
        let Some(t) = atv() else { return };
        let mut store = Store::open(&crate::storage::Storage::cli()).unwrap();
        let r = pair_with(&t, &mut store, None, |_| {
            eprint!("PIN: ");
            let mut line = String::new();
            std::io::stdin().read_line(&mut line).unwrap();
            Ok(line.trim().to_owned())
        })
        .unwrap();
        eprintln!("paired: {} ({})", r.name, r.id_display());
    }

    /// Pair-verify with the stored credentials, then `/info` over the
    /// encrypted channel; saves the body to `target/appletv-info-verified.bplist`
    /// (scrub it with `tests/fixtures/airplay/scrub_info.py` before committing).
    #[test]
    #[ignore]
    fn hardware_verify() {
        let Some(t) = atv() else { return };
        let store = Store::open(&crate::storage::Storage::cli()).unwrap();
        let mut control = connect(&t, &store).unwrap();
        eprintln!(
            "verified with {} at {}",
            match &control.auth {
                Auth::Verified(r) => r.name.as_str(),
                Auth::Transient => "(transient)",
            },
            control.addr
        );
        let resp = control.client.request("GET", "/info", &[], None).unwrap();
        let out = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join("appletv-info-verified.bplist");
        std::fs::write(&out, &resp.body).unwrap();
        let info = crate::airplay::info::Info::parse(&resp.body).unwrap();
        eprintln!("{:#?}", info.capabilities());
        eprintln!("saved {}", out.display());
    }
}
