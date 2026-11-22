//! The public API (docs/rust-sdk-design.md §5): discovery, pairing, and
//! sessions that stream to receivers.

mod options;
mod session;
pub(crate) mod stream;
mod tunnel;

use std::collections::BTreeMap;
use std::sync::mpsc;
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

pub use options::{Input, Options, PixelFormat, PlayerOptions, TunnelProvider};
pub use session::{ReceiverInfo, Session, SessionState, Stopper};
pub use stream::{AudioWriter, ConfigFormat, Frame, FrameBuffer, Stream, Written, H264};
pub use tunnel::{QrCode, Tunnel};

use crate::error::{Error, Result};
use crate::events::{Event, Paired, PinRequest, Unpaired};
use crate::net::discover::DeviceInfo;
use crate::opts::{Command, InputSpec};
use crate::session::GameIo;

/// The session callback of `options`, if any.
fn callback(options: &Options) -> Option<session::Callback> {
    let f = options.on_event.clone()?;
    Some(Box::new(move |e: &Event| {
        (f.lock().unwrap_or_else(|e| e.into_inner()))(e)
    }))
}

// ---------------------------------------------------------------------------
// Discovery

/// The receivers on the local network, after browsing for `timeout`
/// (AirPlay and Cast records of one TV are one [`Device`](DeviceInfo)).
/// `paired` comes from the default storage.
pub fn discover(timeout: Duration) -> Result<Vec<DeviceInfo>> {
    discover_with(&Options::new(), timeout)
}

/// [`discover`] with the storage of `options` for `paired`.
pub fn discover_with(options: &Options, timeout: Duration) -> Result<Vec<DeviceInfo>> {
    let devices = crate::net::discover::discover(timeout, &[])?;
    let store = crate::net::discover::stored_pairings(&options.ctx().storage);
    Ok(devices
        .iter()
        .map(|d| DeviceInfo::new(d, store.as_ref()))
        .collect())
}

/// Discovery in the background, for a program's receiver menu:
/// [`devices`](Discovery::devices) is what was found so far. Stops when
/// dropped.
pub struct Discovery {
    shared: Arc<DiscoveryShared>,
    thread: Option<JoinHandle<()>>,
}

impl std::fmt::Debug for Discovery {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Discovery").finish_non_exhaustive()
    }
}

/// What [`Discovery`] found, and whether it should stop.
type DiscoveryShared = (Mutex<(Vec<DeviceInfo>, bool)>, Condvar);

/// How long one browse round of [`Discovery`] lasts.
const DISCOVERY_ROUND: Duration = Duration::from_secs(3);

impl Discovery {
    /// Starts browsing (repeatedly, so devices that come later appear).
    pub fn start(options: &Options) -> Result<Discovery> {
        let shared: Arc<DiscoveryShared> =
            Arc::new((Mutex::new((Vec::new(), false)), Condvar::new()));
        let s = shared.clone();
        let opts = options.clone();
        let thread = std::thread::Builder::new()
            .name("tvpipe-discovery".into())
            .spawn(move || loop {
                let found = discover_with(&opts, DISCOVERY_ROUND);
                let (lock, cv) = &*s;
                let mut g = lock.lock().unwrap_or_else(|e| e.into_inner());
                if g.1 {
                    return;
                }
                match found {
                    Ok(list) => {
                        let mut by_name: BTreeMap<String, DeviceInfo> =
                            g.0.drain(..).map(|d| (d.name.clone(), d)).collect();
                        for d in list {
                            by_name.insert(d.name.clone(), d);
                        }
                        g.0 = by_name.into_values().collect();
                    }
                    Err(e) => debug!("discovery: {e}"),
                }
                // A short pause between rounds; stop wakes it.
                let (g, _) = cv
                    .wait_timeout(g, Duration::from_millis(500))
                    .unwrap_or_else(|e| e.into_inner());
                if g.1 {
                    return;
                }
            })
            .map_err(|e| Error::io("spawn the discovery thread", e))?;
        Ok(Discovery {
            shared,
            thread: Some(thread),
        })
    }

    /// Every device found so far, by name.
    pub fn devices(&self) -> Vec<DeviceInfo> {
        self.shared
            .0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .0
            .clone()
    }
}

impl Drop for Discovery {
    fn drop(&mut self) {
        self.shared.0.lock().unwrap_or_else(|e| e.into_inner()).1 = true;
        self.shared.1.notify_all();
        // The thread ends after its browse round; do not wait for it.
        drop(self.thread.take());
    }
}

// ---------------------------------------------------------------------------
// Pairing

/// Pairs with an AirPlay receiver (`airplay`): the TV shows a PIN, which
/// `on_pin` returns (`None`: give up). Blocks until done. The pairing is
/// kept in the default storage; see [`pair_with`].
#[cfg(feature = "airplay")]
pub fn pair(target: &str, on_pin: impl FnMut(&PinRequest) -> Option<String>) -> Result<Paired> {
    pair_with(target, &Options::new(), on_pin)
}

/// [`pair`] with the storage (and events) of `options`.
#[cfg(feature = "airplay")]
pub fn pair_with(
    target: &str,
    options: &Options,
    mut on_pin: impl FnMut(&PinRequest) -> Option<String>,
) -> Result<Paired> {
    let ctx = options.ctx();
    crate::airplay::pair::pair(target, None, &ctx, &mut |req| {
        on_pin(req).ok_or_else(|| Error::usage("no PIN entered").with_code("pin-missing"))
    })
}

/// Forgets the pairing with `target` (a name or an address) in the
/// storage of `options`.
#[cfg(feature = "airplay")]
pub fn unpair(target: &str, options: &Options) -> Result<Vec<Unpaired>> {
    crate::airplay::pair::unpair(target, &options.ctx())
}

/// Where a [`Pairing`] is.
#[derive(Debug)]
#[non_exhaustive]
pub enum PairingState {
    /// Finding the receiver, starting pair-setup.
    Connecting,
    /// The TV shows a PIN: pass it to [`Pairing::submit_pin`].
    NeedPin(PinRequest),
    /// Paired and verified.
    Done(Paired),
    /// It failed.
    Failed(Error),
}

/// Pairing over several frames of a program's UI: [`state`](Pairing::state)
/// says what it needs.
#[cfg(feature = "airplay")]
pub struct Pairing {
    state: Arc<Mutex<PairingState>>,
    pin: mpsc::Sender<Option<String>>,
    thread: Option<JoinHandle<()>>,
}

#[cfg(feature = "airplay")]
impl std::fmt::Debug for Pairing {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Pairing")
            .field("state", &*self.lock())
            .finish_non_exhaustive()
    }
}

#[cfg(feature = "airplay")]
impl Pairing {
    /// Starts pairing with `target` on a thread of its own.
    pub fn start(target: &str, options: &Options) -> Result<Pairing> {
        let state = Arc::new(Mutex::new(PairingState::Connecting));
        let (tx, rx) = mpsc::channel::<Option<String>>();
        let (s, target, opts) = (state.clone(), target.to_owned(), options.clone());
        let thread = std::thread::Builder::new()
            .name("tvpipe-pairing".into())
            .spawn(move || {
                let set = |st: PairingState| *s.lock().unwrap_or_else(|e| e.into_inner()) = st;
                let r = pair_with(&target, &opts, |req| {
                    set(PairingState::NeedPin(req.clone()));
                    let pin = rx.recv().ok().flatten();
                    set(PairingState::Connecting);
                    pin
                });
                set(match r {
                    Ok(p) => PairingState::Done(p),
                    Err(e) => PairingState::Failed(e),
                });
            })
            .map_err(|e| Error::io("spawn the pairing thread", e))?;
        Ok(Pairing {
            state,
            pin: tx,
            thread: Some(thread),
        })
    }

    fn lock(&self) -> MutexGuard<'_, PairingState> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// The current state (a copy).
    pub fn state(&self) -> PairingState {
        match &*self.lock() {
            PairingState::Connecting => PairingState::Connecting,
            PairingState::NeedPin(r) => PairingState::NeedPin(r.clone()),
            PairingState::Done(p) => PairingState::Done(p.clone()),
            PairingState::Failed(e) => PairingState::Failed(e.clone_lossy()),
        }
    }

    /// The PIN the TV shows, or its password (as given but for a line ending).
    pub fn submit_pin(&self, pin: &str) -> Result<()> {
        if !matches!(*self.lock(), PairingState::NeedPin(_)) {
            return Err(Error::usage("the pairing does not wait for a PIN"));
        }
        self.pin
            .send(Some(pin.trim_end_matches(['\r', '\n']).to_owned()))
            .map_err(|_| Error::closed("the pairing ended"))
    }

    /// Gives up (when it waits for a PIN; a running exchange ends by
    /// itself).
    pub fn cancel(&self) {
        let _ = self.pin.send(None);
    }

    /// Waits until the pairing is done.
    pub fn wait(mut self) -> Result<Paired> {
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
        match self.state() {
            PairingState::Done(p) => Ok(p),
            PairingState::Failed(e) => Err(e),
            _ => Err(Error::closed("the pairing ended")),
        }
    }
}

#[cfg(feature = "airplay")]
impl Drop for Pairing {
    fn drop(&mut self) {
        self.cancel();
    }
}

// ---------------------------------------------------------------------------
// Sessions

/// Starts a session and waits until its receivers are connected; pairs an
/// AirPlay receiver that needs it first when `options` has `on_pin`.
fn start_session(
    options: &Options,
    start: impl Fn(&Options) -> Result<Session>,
) -> Result<Session> {
    let s = start(options)?;
    match s.wait_connected() {
        Ok(()) => Ok(s),
        Err(e) => {
            drop(s);
            pair_on_demand(options, e)?;
            let s = start(options)?;
            s.wait_connected()?;
            Ok(s)
        }
    }
}

/// When `e` says a receiver needs pairing and `options` can ask for the
/// PIN, pairs it (`Ok`: try again); otherwise `e`.
fn pair_on_demand(options: &Options, e: Error) -> Result<()> {
    #[cfg(feature = "airplay")]
    if let (Some("pairing-required"), Some(device), Some(f)) =
        (e.code(), e.device(), options.on_pin.clone())
    {
        info!("{device} needs pairing");
        pair_with(device, options, |req| {
            (f.lock().unwrap_or_else(|e| e.into_inner()))(req)
        })?;
        return Ok(());
    }
    let _ = options;
    Err(e)
}

/// Streams the program's own frames and sound ([`Stream`]); blocks until
/// the receivers are connected (seconds). See [`Stream::start`] to keep
/// rendering meanwhile.
pub fn stream(options: Options) -> Result<Stream> {
    let s = Stream::start(options.clone())?;
    match s.wait_connected() {
        Ok(()) => Ok(s),
        Err(e) => {
            drop(s);
            pair_on_demand(&options, e)?;
            let s = Stream::start(options)?;
            s.wait_connected()?;
            Ok(s)
        }
    }
}

fn spawn(options: &Options, cmd: Command) -> Result<Session> {
    let approve = options.approve_remote.clone();
    let io = GameIo {
        approve: Box::new(move |what, cancel| approve.as_ref().is_some_and(|f| f(what, cancel))),
        ..GameIo::none()
    };
    Session::spawn(cmd, options.ctx(), io, callback(options))
}

/// Plays a file, a URL or an ffmpeg input to the receivers; blocks until
/// they are connected.
pub fn play(input: Input, options: Options) -> Result<Session> {
    start_session(&options, |o| {
        spawn(o, Command::Play(o.play_options(input.spec())))
    })
}

/// The built-in test pattern (colour bars, a clock and a beep every
/// second, for measuring latency); blocks until the receivers are
/// connected.
pub fn test_pattern(options: Options) -> Result<Session> {
    start_session(&options, |o| {
        spawn(
            o,
            Command::TestPattern(o.play_options(InputSpec::TestPattern)),
        )
    })
}

/// [`play`] (or the test pattern without `input`) to a browser tab only:
/// the session's [`player_url`](Session::player_url) is the page.
pub fn preview(input: Option<Input>, options: Options) -> Result<Session> {
    let mut options = options;
    options.to = vec![crate::opts::BROWSER_TARGET.to_owned()];
    match input {
        Some(i) => play(i, options),
        None => test_pattern(options),
    }
}

/// Shares a browser tab, window or screen to the receivers (`share`):
/// without `url`, the session's [`share_url`](Session::share_url) is a page
/// to open and press Share on; with one, tvpipe's own browser shows the
/// page and shares it (`headless`). Returns once the session runs (the
/// receivers connect after the capture starts).
pub fn share(url: Option<&str>, options: Options) -> Result<Session> {
    let s = spawn(&options, Command::Share(options.share_options(url)))?;
    // The share page listens first; wait for it (or the failure).
    let until = Instant::now() + Duration::from_secs(30);
    while url.is_none() && s.share_url().is_none() && Instant::now() < until {
        if s.wait_timeout(Duration::from_millis(20)) {
            break;
        }
    }
    Ok(s)
}

/// What the `tvpipe` command-line tool runs: an internal command on the
/// session machinery of [`play`] (not part of the public API).
#[doc(hidden)]
pub fn __spawn_command(
    cmd: Command,
    ctx: crate::ctx::Ctx,
    io: GameIo,
    on_event: Option<session::Callback>,
) -> Result<Session> {
    Session::spawn(cmd, ctx, io, on_event)
}

#[cfg(all(test, feature = "player", feature = "h264"))]
mod tests;
