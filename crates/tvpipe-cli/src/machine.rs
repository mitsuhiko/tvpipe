//! The machine interface (`--machine`, docs/machine.md): JSON events on
//! stdout, commands on stdin, and stop when the parent goes away.
//!
//! - [`emit`] writes one event per line. Logs become `log` events
//!   (`crate::log`), so stdout carries nothing else.
//! - The stdin router ([`start_router`]) owns stdin from the start. It
//!   reads SLRW records: `command` records (kind 6) are handled at once,
//!   media records go to the SLRW input once it opened ([`stdin_reader`]),
//!   and EOF stops the session (or ends an open SLRW input, which then
//!   plays out its tail).
//!
//! Platform-neutral: std pipes only.

use std::io::{self, Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, SyncSender};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};

use tvpipe::__cli::error::{Error, Result};
use tvpipe::__cli::events::{EndInfo, EndReason, ErrorInfo, Event, Events, Hello};
use tvpipe::__cli::slrw;

/// The protocol version in `hello`. New fields and event types do not
/// change it; incompatible changes do.
pub const PROTOCOL: u32 = 1;

/// Largest `command` payload.
pub const MAX_COMMAND: u32 = 64 << 10;

/// Records in flight between the router and the SLRW input (each record
/// is two messages: the header and the payload).
const FORWARD_QUEUE: usize = 16;

static END_SENT: AtomicBool = AtomicBool::new(false);

/// `share URL`'s tab, for `navigate` commands.
static PAGE: OnceLock<tvpipe::__cli::opts::PageControl> = OnceLock::new();

/// The page control of this process's `share URL` (`main`).
pub fn set_page(control: tvpipe::__cli::opts::PageControl) {
    let _ = PAGE.set(control);
}

/// `play` of a file or URL, for `seek`, `pause` and `resume` commands.
static PLAYBACK: OnceLock<tvpipe::__cli::PlaybackControl> = OnceLock::new();

/// The playback control of this process's `play` (`main`).
pub fn set_playback(control: tvpipe::__cli::PlaybackControl) {
    let _ = PLAYBACK.set(control);
}

/// Writes one line on stdout. A closed stdout is ignored: the parent
/// stopped listening.
fn write_line(line: &str) {
    let mut out = io::stdout().lock();
    let _ = out.write_all(line.as_bytes());
    let _ = out.write_all(b"\n");
    let _ = out.flush();
}

/// The session's events as lines on stdout.
pub fn events() -> Events {
    Events::to(|e| emit(&e))
}

/// Writes one event line (nothing for events outside the machine
/// protocol, [`Event::is_machine`]).
pub fn emit(e: &Event) {
    if !e.is_machine() {
        return;
    }
    if matches!(e, Event::End(_)) {
        END_SENT.store(true, Ordering::SeqCst);
    }
    write_line(&e.to_json());
}

/// `hello`, the first event.
pub fn hello(command: &str) {
    emit(&Event::Hello(Hello::new(
        PROTOCOL,
        env!("CARGO_PKG_VERSION"),
        command,
    )));
}

/// `end`, unless the session already sent one (with its details).
pub fn end_if_unsent(reason: EndReason) {
    if !END_SENT.load(Ordering::SeqCst) {
        emit(&Event::End(EndInfo::new(reason)));
    }
}

/// `error`, the last event of a failed command.
pub fn error_event(e: &Error) -> Event {
    Event::Error(ErrorInfo::from(e))
}

/// The back channel of an encoded SLRW input in machine mode: each
/// `keyframe` line becomes a `keyframe` event.
pub struct KeyframeEvents {
    line: Vec<u8>,
    events: Events,
}

impl KeyframeEvents {
    pub fn new(events: Events) -> KeyframeEvents {
        KeyframeEvents {
            line: Vec::new(),
            events,
        }
    }
}

impl Write for KeyframeEvents {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        for &b in buf {
            if b == b'\n' {
                let word = String::from_utf8_lossy(&self.line).trim().to_owned();
                self.line.clear();
                if word == "keyframe" {
                    self.events.emit(Event::Keyframe);
                }
            } else if self.line.len() < 256 {
                self.line.push(b);
            }
        }
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// The stdin router

/// What the router does with media records.
enum Mode {
    /// Nobody reads them yet: dropped, except the last `h264-config` and
    /// `control`, which go first once the input opens.
    Holding {
        config: Option<Vec<u8>>,
        control: Option<Vec<u8>>,
    },
    /// The SLRW input reads them.
    Forwarding(SyncSender<io::Result<Vec<u8>>>),
    /// The input is gone, or stdin ended.
    Closed,
}

/// What the router reports to the session.
pub struct Hooks {
    /// A stop request (`stop` command, EOF while no input reads, a
    /// malformed stream).
    pub stop: Box<dyn Fn() + Send + Sync>,
    /// `keyframe` events (a test substitutes its own).
    pub keyframe: Box<dyn Fn() + Send + Sync>,
}

struct Shared {
    mode: Mutex<Mode>,
    pins: Mutex<Option<Receiver<String>>>,
    hooks: Hooks,
    /// Why the stream was refused (reported as the command's error).
    failure: Mutex<Option<String>>,
}

impl Shared {
    fn mode(&self) -> MutexGuard<'_, Mode> {
        self.mode.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// The running router (one per process; tests make their own).
#[derive(Clone)]
pub struct Router(Arc<Shared>);

static ROUTER: OnceLock<Router> = OnceLock::new();

/// Starts the process's router on stdin (`main`, with `--machine`);
/// `stop` is the session's. From then on nothing else may touch stdin,
/// not even to ask whether it is a terminal: on Windows that waits for the
/// router's pending read (`interrupt::watch_stdin`).
pub fn start_router(stop: tvpipe::__cli::Stop) {
    let r = Router::spawn(
        io::stdin(),
        Hooks {
            stop: Box::new(move || stop.request()),
            keyframe: Box::new(|| emit(&Event::Keyframe)),
        },
    );
    let _ = ROUTER.set(r);
}

/// The process's router, if `--machine` started one.
pub fn router() -> Option<&'static Router> {
    ROUTER.get()
}

/// The SLRW input's stdin: with the router, records reach it from the
/// first read on; without, stdin itself.
pub fn stdin_reader() -> Box<dyn Read + Send> {
    match router() {
        Some(r) => Box::new(r.reader()),
        None => Box::new(io::stdin()),
    }
}

/// Why the router refused the stream, if it did.
pub fn failure() -> Option<Error> {
    let r = router()?;
    let msg =
        r.0.failure
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take()?;
    Some(Error::malformed(msg).with_code("bad-input"))
}

impl Router {
    /// Reads `input` on a thread of its own.
    pub fn spawn(input: impl Read + Send + 'static, hooks: Hooks) -> Router {
        let (pin_tx, pin_rx) = mpsc::channel();
        let shared = Arc::new(Shared {
            mode: Mutex::new(Mode::Holding {
                config: None,
                control: None,
            }),
            pins: Mutex::new(Some(pin_rx)),
            hooks,
            failure: Mutex::new(None),
        });
        let s = shared.clone();
        let spawned = std::thread::Builder::new()
            .name("machine-stdin".into())
            .spawn(move || route(input, &s, pin_tx));
        if let Err(e) = spawned {
            // Without the router nothing would ever stop the session but
            // a signal; better not to start.
            error!("cannot read stdin: {e}");
            (shared.hooks.stop)();
        }
        Router(shared)
    }

    /// A reader of the media records from now on. The first `read`
    /// switches the router to forwarding.
    pub fn reader(&self) -> ForwardReader {
        ForwardReader {
            router: self.clone(),
            rx: None,
            chunk: Vec::new(),
            pos: 0,
        }
    }

    /// Starts forwarding: the magic, the kept configuration and control
    /// records, then whatever comes.
    fn claim(&self) -> Receiver<io::Result<Vec<u8>>> {
        let (tx, rx) = mpsc::sync_channel(FORWARD_QUEUE);
        let mut mode = self.0.mode();
        match std::mem::replace(&mut *mode, Mode::Closed) {
            Mode::Holding { config, control } => {
                let _ = tx.send(Ok(slrw::MAGIC.to_vec()));
                let mut keyframes = false;
                for rec in [control, config].into_iter().flatten() {
                    if rec.first() == Some(&slrw::Kind::Control.code()) {
                        keyframes = rec
                            .get(13..17)
                            .and_then(|b| b.try_into().ok())
                            .map(u32::from_le_bytes)
                            .is_some_and(|f| f & slrw::CONTROL_KEYFRAME_REQUESTS != 0);
                    }
                    let _ = tx.send(Ok(rec));
                }
                *mode = Mode::Forwarding(tx);
                drop(mode);
                if keyframes {
                    // Keyframes sent before the input opened were dropped.
                    (self.0.hooks.keyframe)();
                }
            }
            // Claimed twice, or stdin already ended: an empty stream.
            other => {
                *mode = match other {
                    Mode::Forwarding(_) => Mode::Closed,
                    m => m,
                };
            }
        }
        rx
    }

    /// The next PIN from a `pin` command; an error once stdin ended.
    pub fn wait_pin(&self) -> Result<String> {
        let rx = self
            .0
            .pins
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take()
            .ok_or_else(|| Error::usage("the PIN was asked for already"))?;
        let pin = rx
            .recv()
            .map_err(|_| Error::usage("no PIN entered (stdin closed)").with_code("pin-missing"));
        *self.0.pins.lock().unwrap_or_else(|e| e.into_inner()) = Some(rx);
        pin
    }
}

/// A record as read: kind, the 13-byte header, the payload.
type RawRecord = (u8, Vec<u8>, Vec<u8>);

/// Reads one record: `None` at EOF on a record boundary.
fn read_record(r: &mut impl Read) -> io::Result<Option<RawRecord>> {
    let mut head = [0u8; 13];
    if !fill(r, &mut head)? {
        return Ok(None);
    }
    let kind = head[0];
    let len = u32::from_le_bytes([head[9], head[10], head[11], head[12]]);
    let max = match kind {
        0 => 0,
        6 => MAX_COMMAND,
        5 => 4,
        4 => slrw::MAX_CONFIG_PAYLOAD,
        3 => slrw::MAX_H264_PAYLOAD,
        1 | 2 => slrw::MAX_PAYLOAD,
        k => return Err(invalid(format!("unknown record kind {k}"))),
    };
    if len > max {
        return Err(invalid(format!(
            "record of kind {kind} with {len} bytes exceeds {max}"
        )));
    }
    let mut payload = vec![0u8; len as usize];
    if len > 0 && !fill(r, &mut payload)? {
        return Err(invalid("truncated record".into()));
    }
    Ok(Some((kind, head.to_vec(), payload)))
}

fn invalid(msg: String) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, format!("slrw: {msg}"))
}

/// Fills `buf`; `Ok(false)` at EOF before the first byte.
fn fill(r: &mut impl Read, buf: &mut [u8]) -> io::Result<bool> {
    let mut got = 0;
    while got < buf.len() {
        match r.read(&mut buf[got..]) {
            Ok(0) if got == 0 => return Ok(false),
            Ok(0) => return Err(invalid("truncated record".into())),
            Ok(n) => got += n,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
            Err(e) => return Err(e),
        }
    }
    Ok(true)
}

/// The router thread.
fn route(mut input: impl Read, s: &Shared, pins: mpsc::Sender<String>) {
    let end = (|| -> io::Result<()> {
        let mut magic = [0u8; 4];
        if !fill(&mut input, &mut magic)? {
            return Ok(());
        }
        if &magic != slrw::MAGIC {
            return Err(invalid("stdin must start with the SLRW magic".into()));
        }
        while let Some((kind, head, payload)) = read_record(&mut input)? {
            if kind == 6 {
                command(s, &payload, &pins);
                continue;
            }
            forward(s, kind, head, payload);
        }
        Ok(())
    })();
    drop(pins);
    let forwarding = {
        let mut mode = s.mode();
        match std::mem::replace(&mut *mode, Mode::Closed) {
            Mode::Forwarding(tx) => {
                if let Err(e) = &end {
                    let _ = tx.send(Err(io::Error::new(e.kind(), e.to_string())));
                }
                true
            }
            _ => false,
        }
    };
    if let Err(e) = end {
        error!("stdin: {e}");
        *s.failure.lock().unwrap_or_else(|e| e.into_inner()) = Some(e.to_string());
        (s.hooks.stop)();
    } else if !forwarding {
        // The parent closed our stdin (or exited): nothing reads media,
        // so this is the end of the session.
        debug!("stdin closed; stopping");
        (s.hooks.stop)();
    }
}

/// A media record: held, forwarded or dropped.
fn forward(s: &Shared, kind: u8, mut head: Vec<u8>, payload: Vec<u8>) {
    let tx = {
        let mut mode = s.mode();
        match &mut *mode {
            Mode::Holding { config, control } => {
                if kind == slrw::Kind::End.code() {
                    drop(mode);
                    debug!("stdin: end of stream before the input opened; stopping");
                    (s.hooks.stop)();
                    return;
                }
                let keep = match kind {
                    4 => Some(config),
                    5 => Some(control),
                    _ => None,
                };
                if let Some(slot) = keep {
                    head.extend_from_slice(&payload);
                    *slot = Some(head);
                }
                return;
            }
            Mode::Forwarding(tx) => tx.clone(),
            Mode::Closed => return,
        }
    };
    let sent = tx.send(Ok(head)).is_ok() && (payload.is_empty() || tx.send(Ok(payload)).is_ok());
    if !sent {
        // The input finished: from now on only commands matter.
        *s.mode() = Mode::Closed;
    }
}

fn command(s: &Shared, payload: &[u8], pins: &mpsc::Sender<String>) {
    let text = String::from_utf8_lossy(payload);
    let v = match tvpipe::__cli::json::parse(&text) {
        Ok(v) => v,
        Err(e) => {
            warn!("stdin: bad command: {e}");
            return;
        }
    };
    match v["type"].as_str() {
        Some("stop") => {
            debug!("stdin: stop");
            (s.hooks.stop)();
        }
        Some("pin") => match v["pin"].as_str() {
            Some(pin) => {
                // As given but for a line ending: it may be a password
                // (pairing trims a PIN itself).
                let _ = pins.send(pin.trim_end_matches(['\r', '\n']).to_owned());
            }
            None => warn!("stdin: pin command without a pin"),
        },
        Some("navigate") => navigate(v["url"].as_str()),
        Some(what @ ("seek" | "pause" | "resume")) => playback(what, &v),
        other => warn!("stdin: unknown command {other:?}"),
    }
}

/// `{"type":"seek","position_ms":…}` or `{"type":"seek","by_ms":…}`,
/// `{"type":"pause"}`, `{"type":"resume"}`: `play` of a file or a URL
/// with a length; refusals are warnings, the `playback` event says what
/// happened.
fn playback(what: &str, v: &tvpipe::__cli::json::Value) {
    let Some(c) = PLAYBACK.get() else {
        warn!("stdin: {what}: only play of a file or URL seeks and pauses");
        return;
    };
    let done = match what {
        "pause" => c.set_paused(true),
        "resume" => c.set_paused(false),
        _ => match (v["position_ms"].as_u64(), v["by_ms"].as_i64()) {
            (Some(ms), None) => c.seek_to(std::time::Duration::from_millis(ms)),
            (None, Some(ms)) => c.seek_by(ms),
            _ => {
                warn!("stdin: seek needs position_ms or by_ms");
                return;
            }
        },
    };
    if done {
        debug!("stdin: {what}");
    } else {
        warn!("stdin: {what}: this input cannot seek or pause (not yet, or not at all)");
    }
}

/// `{"type":"navigate","url":…}`: `share URL` shows another page in its
/// tab (the receivers keep their sessions); refusals are warnings.
fn navigate(url: Option<&str>) {
    let Some(url) = url else {
        warn!("stdin: navigate command without a url");
        return;
    };
    let Some(page) = PAGE.get() else {
        warn!("stdin: navigate: only share URL shows pages");
        return;
    };
    match tvpipe::__cli::page_url(url) {
        Ok(url) => {
            debug!("stdin: navigate to {url}");
            page.navigate(url);
        }
        Err(e) => warn!("stdin: navigate: {e}"),
    }
}

/// The SLRW input's end of the router.
pub struct ForwardReader {
    router: Router,
    rx: Option<Receiver<io::Result<Vec<u8>>>>,
    chunk: Vec<u8>,
    pos: usize,
}

impl Read for ForwardReader {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if buf.is_empty() {
            return Ok(0);
        }
        let rx = self.rx.get_or_insert_with(|| self.router.claim());
        while self.pos >= self.chunk.len() {
            match rx.recv() {
                Ok(Ok(c)) => {
                    self.chunk = c;
                    self.pos = 0;
                }
                Ok(Err(e)) => return Err(e),
                Err(_) => return Ok(0),
            }
        }
        let n = buf.len().min(self.chunk.len() - self.pos);
        buf[..n].copy_from_slice(&self.chunk[self.pos..self.pos + n]);
        self.pos += n;
        Ok(n)
    }
}

#[cfg(test)]
mod tests;
