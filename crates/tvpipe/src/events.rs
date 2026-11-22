//! What sessions and commands report: [`Event`], the typed form of the
//! machine interface's events (docs/machine.md), and [`Events`], the
//! per-session handle they go out through.
//!
//! The machine protocol is the JSON serialization of these types
//! ([`Event::to_json`]); wire names are as in docs/machine.md
//! (`gave-up`, `share-page`, snake_case fields). [`Event::from_json`]
//! reads them back, for programs that run `tvpipe --machine`.

use std::sync::Arc;

use crate::codec::json::Value;
use crate::error::{Error, Result};

/// One thing that happened in a session or a command.
#[derive(Debug, Clone, PartialEq)]
#[non_exhaustive]
pub enum Event {
    /// The first event of `tvpipe --machine`; library sessions never send
    /// it.
    Hello(Hello),
    /// A log line of `tvpipe --machine`; library sessions never send it
    /// (log lines go to the logger, see [`crate::log`]).
    Log(crate::log::Record),
    /// A receiver changed state.
    Receiver(ReceiverEvent),
    /// A `browser` receiver's page listens.
    Player(PlayerEvent),
    /// A tab connected to or left a `browser` receiver's page.
    Viewer(ViewerEvent),
    /// A public link (`tunnel`) to the player or share page works.
    Tunnel(TunnelEvent),
    /// `share` without a URL: the page to open and share from.
    SharePage(SharePageEvent),
    /// `share` or `screen`: the browser started sharing.
    Capture(CaptureEvent),
    /// Every receiver that could be connected is; the input opens next.
    Connected(ConnectedEvent),
    /// The input is open and the receivers started.
    Started(Started),
    /// A receiver needs an IDR (programs sending their own H.264).
    Keyframe,
    /// Once a second while frames flow.
    Stats(Stats),
    /// `discover`'s result.
    Devices(DevicesEvent),
    /// Pairing needs the PIN the TV shows.
    PinRequired(PinRequest),
    /// Pairing succeeded and was verified.
    Paired(Paired),
    /// A pairing was forgotten.
    Unpaired(Unpaired),
    /// The session or command is over.
    End(EndInfo),
    /// The session or command failed.
    Error(ErrorInfo),
    /// Progress for people: steps that take a while, `game play`'s links
    /// and phones. Not part of the machine protocol: `tvpipe --machine`
    /// does not write it (its JSON, `progress`, is for logs and tests).
    Progress(Progress),
}

/// A step of a command that takes a while (people see it as "Starting
/// the browser…"), in [`Progress`].
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum Step {
    /// Looking for a receiver by its name on the network.
    Find(String),
    /// Connecting to a receiver (ends with its [`ReceiverEvent`]).
    Connect(String),
    /// Starting tvpipe's own browser (`screen`, `share URL`, `game play`'s
    /// TV page).
    Browser,
    /// Opening `game play`'s window.
    Window,
    /// Opening a public link (ends with a [`TunnelEvent`] or the game's
    /// link).
    Tunnel,
    /// Waiting for the browser to capture (ends with a [`CaptureEvent`]).
    Capture,
    /// Waiting for a tab to open the player (`--wait-for-viewer`).
    Viewer,
    /// Looking for every receiver on the network (`discover`).
    Discover,
    /// Downloading a game (`game play` from the internet): what.
    Download(String),
}

/// A [`Step`] or `game play` news.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum Progress {
    /// The step began.
    Begin(Step),
    /// The step is done; the detail says with what, if anything (the
    /// browser's name and version).
    Done(Step, Option<String>),
    /// The step failed (the error follows as a warning or the command's
    /// error).
    Failed(Step, String),
    /// `game play` serves a game: its title and the phones' links on this
    /// computer and on the LAN (`--lan`).
    Game {
        /// The manifest's title.
        title: String,
        /// The phones' page on this computer.
        local: String,
        /// The phones' page on the LAN.
        lan: Option<String>,
    },
    /// `game play`'s public link for phones works.
    GameLink {
        /// The link.
        url: String,
        /// Who carries it: `cloudflare` or `opentunnel`.
        provider: String,
        /// A short link (tvpipe.party/CODE) will follow as
        /// [`Progress::ShortLink`] once the game asks for it: people are
        /// shown that one, this link only as its QR code.
        short: bool,
    },
    /// `game play`'s short link for phones (`https://tvpipe.party/CODE`,
    /// docs/short-links.md): registered, or changed.
    ShortLink {
        /// The link.
        url: String,
    },
    /// `game play`: the number of phones connected changed.
    Phones(usize),
    /// `game play` casts its TV page to these receivers.
    Casting(Vec<String>),
    /// `game play`'s cast failed.
    CastFailed(String),
    /// `game play`'s cast stopped.
    CastStopped,
    /// A download's bytes so far, and the total when known.
    Download {
        /// Bytes so far.
        done: u64,
        /// The length, if the server said.
        total: Option<u64>,
    },
}

/// Defines a string enum with its wire names.
macro_rules! wire_enum {
    ($(#[$m:meta])* $name:ident { $($(#[$vm:meta])* $v:ident = $s:literal),+ $(,)? }) => {
        $(#[$m])*
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
        #[non_exhaustive]
        #[allow(missing_docs)]
        pub enum $name { $($(#[$vm])* $v),+ }

        impl $name {
            /// The name on the wire (docs/machine.md).
            pub fn as_str(self) -> &'static str {
                match self { $($name::$v => $s),+ }
            }

            /// Parses a wire name.
            pub fn from_wire(s: &str) -> Option<$name> {
                match s { $($s => Some($name::$v),)+ _ => None }
            }
        }

        impl std::fmt::Display for $name {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str(self.as_str())
            }
        }
    };
}

wire_enum!(
    /// A receiver's protocol.
    Protocol {
        Cast = "cast",
        AirPlay = "airplay",
        Browser = "browser",
    }
);

wire_enum!(
    /// A receiver's state in [`ReceiverEvent`].
    ReceiverState {
        /// Connected and ready to play.
        Connected = "connected",
        /// Could not resolve, connect or start, or failed mid-stream.
        Failed = "failed",
        /// The connection broke; reconnecting.
        Lost = "lost",
        /// Back after [`Lost`](ReceiverState::Lost).
        Reconnected = "reconnected",
        /// Reconnecting failed.
        GaveUp = "gave-up",
        /// The receiver's user ended the session.
        Ended = "ended",
        /// tvpipe stopped it (the session ended).
        Stopped = "stopped",
    }
);

wire_enum!(
    /// A tab of a `browser` receiver.
    ViewerState {
        Connected = "connected",
        Disconnected = "disconnected",
    }
);

wire_enum!(
    /// Which page a public link leads to.
    TunnelPage {
        /// A `browser` receiver's player page.
        Player = "player",
        /// The share page.
        Share = "share",
        /// Any program's server on a loopback port (`tvpipe debug tunnel PORT`).
        Port = "port",
    }
);

wire_enum!(
    /// Where the frames come from.
    Route {
        /// A file sent unchanged.
        Passthrough = "passthrough",
        /// Encoded by ffmpeg.
        Ffmpeg = "ffmpeg",
        /// Raw frames or the test pattern through the built-in encoder.
        Builtin = "builtin",
        /// The program's own H.264.
        Encoded = "encoded",
        /// A browser page's capture (`share`, `screen`).
        Browser = "browser",
    }
);

wire_enum!(
    /// Why a session ended.
    EndReason {
        /// The input ended (and its tail played out).
        Eof = "eof",
        /// Stopped on request.
        Stopped = "stopped",
        /// Every receiver ended the session.
        ReceiversGone = "receivers-gone",
        /// The input failed.
        Error = "error",
        /// A command without a stream finished.
        Done = "done",
    }
);

wire_enum!(
    /// How one receiver ended.
    ReceiverEnd {
        Stopped = "stopped",
        Ended = "ended",
        Failed = "failed",
    }
);

/// `hello`: the machine interface's first event.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub struct Hello {
    /// The machine protocol version (1).
    pub protocol: u32,
    /// tvpipe's version.
    pub version: String,
    /// The command (`play` also for `preview`; `test-pattern` for `debug pattern`, …).
    pub command: String,
}

impl Hello {
    /// A `hello` event.
    pub fn new(protocol: u32, version: impl Into<String>, command: impl Into<String>) -> Hello {
        Hello {
            protocol,
            version: version.into(),
            command: command.into(),
        }
    }
}

/// A receiver's state change.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub struct ReceiverEvent {
    /// The receiver, as given (`--to`) or as discovered.
    pub name: String,
    /// Known on `connected`, and on `failed` while connecting.
    pub protocol: Option<Protocol>,
    /// What happened.
    pub state: ReceiverState,
    /// What went wrong (`failed`, `lost`, `gave-up`).
    pub error: Option<String>,
    /// A stable code for the error, e.g. `pairing-required`.
    pub code: Option<String>,
    /// On `connected`: the playout delay the receiver presents video
    /// with, ms after a frame's instant on the session clock (Cast's
    /// target delay, AirPlay's video lead, the player page's delay). The
    /// receiver's own display adds its lag on top.
    pub delay_ms: Option<u32>,
}

impl ReceiverEvent {
    pub(crate) fn new(
        name: &str,
        protocol: Option<Protocol>,
        state: ReceiverState,
        error: Option<&Error>,
    ) -> ReceiverEvent {
        ReceiverEvent {
            name: name.to_owned(),
            protocol,
            state,
            error: error.map(|e| e.to_string()),
            code: error.and_then(|e| e.code()).map(str::to_owned),
            delay_ms: None,
        }
    }

    /// The same event with the receiver's playout delay.
    pub(crate) fn with_delay(mut self, ms: u32) -> ReceiverEvent {
        self.delay_ms = Some(ms);
        self
    }
}

/// A `browser` receiver's page.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub struct PlayerEvent {
    /// The receiver (`browser`).
    pub name: String,
    /// Open it in a browser to watch.
    pub url: String,
}

/// A tab of a `browser` receiver connected or left.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub struct ViewerEvent {
    /// The receiver (`browser`).
    pub name: String,
    /// The tab, numbered from 1 per receiver.
    pub tab: u64,
    /// Connected or left.
    pub state: ViewerState,
    /// It came over the public link.
    pub public: bool,
    /// Over the public link: the visitor's address, when the tunnel knows it.
    pub address: Option<String>,
    /// Over a Cloudflare link: the visitor's country, two letters
    /// (Cloudflare's `cf-ipcountry`).
    pub country: Option<String>,
    /// The visitor's browser and system, from its user agent ("Safari 18
    /// on iPhone").
    pub browser: Option<String>,
}

/// A public link works.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub struct TunnelEvent {
    /// The page it leads to.
    pub page: TunnelPage,
    /// The player's name (`page` = player).
    pub name: Option<String>,
    /// Who carries it: `cloudflare` or `opentunnel`.
    pub provider: String,
    /// The link, with its token.
    pub url: String,
}

/// The page `share` serves.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub struct SharePageEvent {
    /// The page; open it and press Share.
    pub url: String,
}

/// What a share captures.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub struct CaptureEvent {
    /// `monitor`, `window` or `browser`, if the browser says.
    pub surface: Option<String>,
    /// What the browser calls it (a screen or window title), if it says.
    pub label: Option<String>,
    /// The capture's width.
    pub width: u32,
    /// The capture's height.
    pub height: u32,
    /// Whether the capture has sound.
    pub audio: bool,
}

/// The receivers connected.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub struct ConnectedEvent {
    /// The receivers that connected, by name.
    pub receivers: Vec<String>,
}

/// The video being sent.
#[derive(Debug, Clone, PartialEq)]
#[non_exhaustive]
pub struct VideoStarted {
    /// `h264`.
    pub codec: String,
    /// Encoded width.
    pub width: u32,
    /// Encoded height.
    pub height: u32,
    /// Frames per second.
    pub fps: f64,
}

/// One audio track being sent (one per receiver family).
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub struct AudioStarted {
    /// `alac`, `aac-lc`, `opus`, `pcm-s16le`, …
    pub codec: String,
    /// Samples per second.
    pub sample_rate: u32,
    /// Channels.
    pub channels: u8,
}

/// The plan once streaming started.
#[derive(Debug, Clone, PartialEq)]
#[non_exhaustive]
pub struct Started {
    /// Where the frames come from.
    pub route: Route,
    /// The video.
    pub video: VideoStarted,
    /// One audio track per receiver family.
    pub audio: Vec<AudioStarted>,
    /// The playout delay every receiver presents frames with.
    pub latency_ms: u32,
}

/// Counters of one receiver.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
#[non_exhaustive]
pub struct ReceiverStats {
    /// The receiver.
    pub name: String,
    /// Frames handed to the receiver's sink.
    pub pushed: u64,
    /// Frames the sink dropped (its writer was full).
    pub dropped: u64,
    /// Frames dropped because the receiver's queue was full.
    pub dropped_full: u64,
    /// Frames dropped while waiting for a keyframe.
    pub dropped_waiting: u64,
}

/// Once a second while frames flow.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
#[non_exhaustive]
pub struct Stats {
    /// Time since streaming started.
    pub elapsed_ms: u64,
    /// Video frames sent so far.
    pub video_frames: u64,
    /// Audio frames sent so far.
    pub audio_frames: u64,
    /// Per receiver.
    pub receivers: Vec<ReceiverStats>,
    /// Video bytes sent so far (for a bitrate). Not in the machine
    /// protocol: `to_json` leaves it out and `from_json` reads 0.
    pub video_bytes: u64,
}

/// `discover`'s devices.
#[derive(Debug, Clone, PartialEq)]
#[non_exhaustive]
pub struct DevicesEvent {
    /// What was found.
    pub devices: Vec<crate::net::discover::DeviceInfo>,
}

/// Pairing needs a PIN.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub struct PinRequest {
    /// The receiver's name.
    pub name: String,
    /// Its address (`ip:port`).
    pub address: String,
    /// It asks for its AirPlay password and shows no PIN.
    pub password: bool,
}

/// A pairing succeeded.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub struct Paired {
    /// The receiver.
    pub name: String,
    /// Its model, if it said.
    pub model: Option<String>,
    /// The credentials file, when the storage is a directory.
    pub file: Option<String>,
}

/// A pairing was forgotten.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub struct Unpaired {
    /// The receiver.
    pub name: String,
    /// Its pairing identifier.
    pub id: String,
}

/// How one receiver ended, with its counters.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub struct ReceiverEndInfo {
    /// Its counters.
    pub stats: ReceiverStats,
    /// How it ended.
    pub end: ReceiverEnd,
    /// What went wrong (`failed`).
    pub error: Option<String>,
}

/// How a session or command ended.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub struct EndInfo {
    /// Why.
    pub reason: EndReason,
    /// Per receiver (sessions only; `None` for commands without a stream).
    pub receivers: Option<Vec<ReceiverEndInfo>>,
}

impl EndInfo {
    /// An end without per-receiver details.
    pub fn new(reason: EndReason) -> EndInfo {
        EndInfo {
            reason,
            receivers: None,
        }
    }
}

/// A failure, as the `error` event carries it.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub struct ErrorInfo {
    /// The error kind's wire name (`io`, `auth`, …).
    pub kind: String,
    /// A stable code (`pairing-required`, …), where the case is known.
    pub code: Option<String>,
    /// What went wrong, for people.
    pub message: String,
    /// The receiver the error is about.
    pub device: Option<String>,
}

impl From<&Error> for ErrorInfo {
    fn from(e: &Error) -> ErrorInfo {
        ErrorInfo {
            kind: e.kind().id().to_owned(),
            code: e.code().map(str::to_owned),
            message: e.to_string(),
            device: e.device().map(str::to_owned),
        }
    }
}

// ---------------------------------------------------------------------------
// JSON

fn stats_json(st: &ReceiverStats) -> Value {
    Value::object()
        .with("name", st.name.as_str())
        .with("pushed", st.pushed)
        .with("dropped", st.dropped)
        .with("dropped_full", st.dropped_full)
        .with("dropped_waiting", st.dropped_waiting)
}

fn stats_from(v: &Value) -> Result<ReceiverStats> {
    Ok(ReceiverStats {
        name: v.require_str("name")?.to_owned(),
        pushed: v.require_u64("pushed")?,
        dropped: v.require_u64("dropped")?,
        dropped_full: v.require_u64("dropped_full")?,
        dropped_waiting: v.require_u64("dropped_waiting")?,
    })
}

fn opt_str(v: &Value, key: &str) -> Option<String> {
    v.get(key).and_then(Value::as_str).map(str::to_owned)
}

fn wire<T>(v: &Value, key: &str, parse: fn(&str) -> Option<T>) -> Result<T> {
    let s = v.require_str(key)?;
    parse(s).ok_or_else(|| Error::malformed(format!("event: unknown {key} {s:?}")))
}

fn list<T>(v: &Value, key: &str, f: impl Fn(&Value) -> Result<T>) -> Result<Vec<T>> {
    v.require_array(key)?.iter().map(f).collect()
}

impl Step {
    fn wire(&self) -> (&'static str, Option<&str>) {
        match self {
            Step::Find(n) => ("find", Some(n)),
            Step::Connect(n) => ("connect", Some(n)),
            Step::Browser => ("browser", None),
            Step::Window => ("window", None),
            Step::Tunnel => ("tunnel", None),
            Step::Capture => ("capture", None),
            Step::Viewer => ("viewer", None),
            Step::Discover => ("discover", None),
            Step::Download(n) => ("download", Some(n)),
        }
    }

    fn from_wire(step: &str, name: Option<String>) -> Result<Step> {
        let name = || {
            name.clone()
                .ok_or_else(|| Error::malformed("event: step without name"))
        };
        Ok(match step {
            "find" => Step::Find(name()?),
            "connect" => Step::Connect(name()?),
            "browser" => Step::Browser,
            "window" => Step::Window,
            "tunnel" => Step::Tunnel,
            "capture" => Step::Capture,
            "viewer" => Step::Viewer,
            "discover" => Step::Discover,
            "download" => Step::Download(name()?),
            other => return Err(Error::malformed(format!("event: unknown step {other:?}"))),
        })
    }
}

fn progress_value(p: &Progress, v: Value) -> Value {
    let step = |v: Value, kind: &str, s: &Step| {
        let (step, name) = s.wire();
        v.with("kind", kind)
            .with("step", step)
            .with_opt("name", name)
    };
    match p {
        Progress::Begin(s) => step(v, "begin", s),
        Progress::Done(s, d) => step(v, "done", s).with_opt("detail", d.as_deref()),
        Progress::Failed(s, e) => step(v, "failed", s).with("error", e.as_str()),
        Progress::Game { title, local, lan } => v
            .with("kind", "game")
            .with("title", title.as_str())
            .with("local", local.as_str())
            .with_opt("lan", lan.as_deref()),
        Progress::GameLink {
            url,
            provider,
            short,
        } => v
            .with("kind", "game-link")
            .with("url", url.as_str())
            .with("provider", provider.as_str())
            .with("short", *short),
        Progress::ShortLink { url } => v.with("kind", "short-link").with("url", url.as_str()),
        Progress::Phones(n) => v.with("kind", "phones").with("count", *n as u64),
        Progress::Casting(to) => v
            .with("kind", "casting")
            .with("to", Value::array(to.iter().map(String::as_str))),
        Progress::CastFailed(e) => v.with("kind", "cast-failed").with("error", e.as_str()),
        Progress::CastStopped => v.with("kind", "cast-stopped"),
        Progress::Download { done, total } => v
            .with("kind", "download")
            .with("done", *done)
            .with_opt("total", *total),
    }
}

fn progress_from(v: &Value) -> Result<Progress> {
    let step = || Step::from_wire(v.require_str("step")?, opt_str(v, "name"));
    Ok(match v.require_str("kind")? {
        "begin" => Progress::Begin(step()?),
        "done" => Progress::Done(step()?, opt_str(v, "detail")),
        "failed" => Progress::Failed(step()?, v.require_str("error")?.to_owned()),
        "game" => Progress::Game {
            title: v.require_str("title")?.to_owned(),
            local: v.require_str("local")?.to_owned(),
            lan: opt_str(v, "lan"),
        },
        "game-link" => Progress::GameLink {
            url: v.require_str("url")?.to_owned(),
            provider: v.require_str("provider")?.to_owned(),
            short: v.get("short").and_then(Value::as_bool).unwrap_or(false),
        },
        "short-link" => Progress::ShortLink {
            url: v.require_str("url")?.to_owned(),
        },
        "phones" => Progress::Phones(
            usize::try_from(v.require_u64("count")?)
                .map_err(|_| Error::malformed("event: phones"))?,
        ),
        "casting" => Progress::Casting(list(v, "to", |r| {
            r.as_str()
                .map(str::to_owned)
                .ok_or_else(|| Error::malformed("event: receiver name not a string"))
        })?),
        "cast-failed" => Progress::CastFailed(v.require_str("error")?.to_owned()),
        "cast-stopped" => Progress::CastStopped,
        "download" => Progress::Download {
            done: v.require_u64("done")?,
            total: v.get("total").and_then(Value::as_u64),
        },
        other => {
            return Err(Error::malformed(format!(
                "event: unknown progress {other:?}"
            )))
        }
    })
}

impl Event {
    /// The event's `type` on the wire.
    pub fn type_name(&self) -> &'static str {
        match self {
            Event::Hello(_) => "hello",
            Event::Log(_) => "log",
            Event::Receiver(_) => "receiver",
            Event::Player(_) => "player",
            Event::Viewer(_) => "viewer",
            Event::Tunnel(_) => "tunnel",
            Event::SharePage(_) => "share-page",
            Event::Capture(_) => "capture",
            Event::Connected(_) => "connected",
            Event::Started(_) => "started",
            Event::Keyframe => "keyframe",
            Event::Stats(_) => "stats",
            Event::Devices(_) => "devices",
            Event::PinRequired(_) => "pin-required",
            Event::Paired(_) => "paired",
            Event::Unpaired(_) => "unpaired",
            Event::End(_) => "end",
            Event::Error(_) => "error",
            Event::Progress(_) => "progress",
        }
    }

    /// Whether the machine interface writes it (everything but
    /// [`Event::Progress`]).
    pub fn is_machine(&self) -> bool {
        !matches!(self, Event::Progress(_))
    }

    /// The event as a JSON value (one machine-interface line).
    pub(crate) fn to_value(&self) -> Value {
        let v = Value::object().with("type", self.type_name());
        match self {
            Event::Hello(h) => v
                .with("protocol", h.protocol)
                .with("version", h.version.as_str())
                .with("command", h.command.as_str()),
            Event::Log(r) => v
                .with("level", r.level.as_str())
                .with("module", r.module.as_str())
                .with("message", r.message.as_str()),
            Event::Receiver(r) => v
                .with("name", r.name.as_str())
                .with_opt("protocol", r.protocol.map(Protocol::as_str))
                .with("state", r.state.as_str())
                .with_opt("error", r.error.as_deref())
                .with_opt("code", r.code.as_deref())
                .with_opt("delay_ms", r.delay_ms),
            Event::Player(p) => v.with("name", p.name.as_str()).with("url", p.url.as_str()),
            Event::Viewer(w) => v
                .with("name", w.name.as_str())
                .with("tab", w.tab)
                .with("state", w.state.as_str())
                .with("public", w.public)
                .with_opt("address", w.address.as_deref())
                .with_opt("country", w.country.as_deref())
                .with_opt("browser", w.browser.as_deref()),
            Event::Tunnel(t) => v
                .with("page", t.page.as_str())
                .with_opt("name", t.name.as_deref())
                .with("provider", t.provider.as_str())
                .with("url", t.url.as_str()),
            Event::SharePage(p) => v.with("url", p.url.as_str()),
            Event::Capture(c) => v
                .with_opt("surface", c.surface.as_deref())
                .with_opt("label", c.label.as_deref())
                .with("width", c.width)
                .with("height", c.height)
                .with("audio", c.audio),
            Event::Connected(c) => v.with(
                "receivers",
                Value::array(c.receivers.iter().map(String::as_str)),
            ),
            Event::Started(s) => v
                .with("route", s.route.as_str())
                .with(
                    "video",
                    Value::object()
                        .with("codec", s.video.codec.as_str())
                        .with("width", s.video.width)
                        .with("height", s.video.height)
                        .with("fps", s.video.fps),
                )
                .with(
                    "audio",
                    Value::array(s.audio.iter().map(|a| {
                        Value::object()
                            .with("codec", a.codec.as_str())
                            .with("sample_rate", a.sample_rate)
                            .with("channels", a.channels)
                    })),
                )
                .with("latency_ms", s.latency_ms),
            Event::Keyframe => v,
            Event::Stats(s) => v
                .with("elapsed_ms", s.elapsed_ms)
                .with("video_frames", s.video_frames)
                .with("audio_frames", s.audio_frames)
                .with(
                    "receivers",
                    Value::array(s.receivers.iter().map(stats_json)),
                ),
            Event::Devices(d) => v.with(
                "devices",
                Value::array(d.devices.iter().map(|d| d.to_value())),
            ),
            Event::PinRequired(p) => v
                .with("name", p.name.as_str())
                .with("address", p.address.as_str())
                .with("password", p.password),
            Event::Paired(p) => v
                .with("name", p.name.as_str())
                .with_opt("model", p.model.as_deref())
                .with_opt("file", p.file.as_deref()),
            Event::Unpaired(u) => v.with("name", u.name.as_str()).with("id", u.id.as_str()),
            Event::End(e) => v.with("reason", e.reason.as_str()).with_opt(
                "receivers",
                e.receivers.as_ref().map(|r| {
                    Value::array(r.iter().map(|r| {
                        stats_json(&r.stats)
                            .with("end", r.end.as_str())
                            .with_opt("error", r.error.as_deref())
                    }))
                }),
            ),
            Event::Error(e) => v
                .with("kind", e.kind.as_str())
                .with_opt("code", e.code.as_deref())
                .with("message", e.message.as_str())
                .with_opt("device", e.device.as_deref()),
            Event::Progress(p) => progress_value(p, v),
        }
    }

    /// The event as one line of JSON (without the newline), as
    /// `tvpipe --machine` writes it.
    pub fn to_json(&self) -> String {
        self.to_value().to_json()
    }

    /// Parses one machine-interface line. Unknown fields are ignored; an
    /// unknown `type` is an error (readers skip those lines).
    pub fn from_json(line: &str) -> Result<Event> {
        Event::from_value(&Value::parse(line)?)
    }

    pub(crate) fn from_value(v: &Value) -> Result<Event> {
        let ty = v.require_str("type")?;
        Ok(match ty {
            "hello" => Event::Hello(Hello {
                protocol: v.require_u32("protocol")?,
                version: v.require_str("version")?.to_owned(),
                command: v.require_str("command")?.to_owned(),
            }),
            "log" => Event::Log(crate::log::Record {
                level: wire(v, "level", crate::log::Level::from_wire)?,
                module: v.require_str("module")?.to_owned(),
                message: v.require_str("message")?.to_owned(),
            }),
            "receiver" => Event::Receiver(ReceiverEvent {
                name: v.require_str("name")?.to_owned(),
                protocol: match v.get("protocol") {
                    Some(_) => Some(wire(v, "protocol", Protocol::from_wire)?),
                    None => None,
                },
                state: wire(v, "state", ReceiverState::from_wire)?,
                error: opt_str(v, "error"),
                code: opt_str(v, "code"),
                delay_ms: match v.get("delay_ms") {
                    Some(_) => Some(v.require_u32("delay_ms")?),
                    None => None,
                },
            }),
            "player" => Event::Player(PlayerEvent {
                name: v.require_str("name")?.to_owned(),
                url: v.require_str("url")?.to_owned(),
            }),
            "viewer" => Event::Viewer(ViewerEvent {
                name: v.require_str("name")?.to_owned(),
                tab: v.require_u64("tab")?,
                state: wire(v, "state", ViewerState::from_wire)?,
                public: v.get("public").and_then(Value::as_bool).unwrap_or(false),
                address: opt_str(v, "address"),
                country: opt_str(v, "country"),
                browser: opt_str(v, "browser"),
            }),
            "tunnel" => Event::Tunnel(TunnelEvent {
                page: wire(v, "page", TunnelPage::from_wire)?,
                name: opt_str(v, "name"),
                provider: v.require_str("provider")?.to_owned(),
                url: v.require_str("url")?.to_owned(),
            }),
            "share-page" => Event::SharePage(SharePageEvent {
                url: v.require_str("url")?.to_owned(),
            }),
            "capture" => Event::Capture(CaptureEvent {
                surface: opt_str(v, "surface"),
                label: opt_str(v, "label"),
                width: v.require_u32("width")?,
                height: v.require_u32("height")?,
                audio: v.require_bool("audio")?,
            }),
            "connected" => Event::Connected(ConnectedEvent {
                receivers: list(v, "receivers", |r| {
                    r.as_str()
                        .map(str::to_owned)
                        .ok_or_else(|| Error::malformed("event: receiver name not a string"))
                })?,
            }),
            "started" => {
                let video = v.require("video")?;
                Event::Started(Started {
                    route: wire(v, "route", Route::from_wire)?,
                    video: VideoStarted {
                        codec: video.require_str("codec")?.to_owned(),
                        width: video.require_u32("width")?,
                        height: video.require_u32("height")?,
                        fps: video.require_f64("fps")?,
                    },
                    audio: list(v, "audio", |a| {
                        Ok(AudioStarted {
                            codec: a.require_str("codec")?.to_owned(),
                            sample_rate: a.require_u32("sample_rate")?,
                            channels: u8::try_from(a.require_u32("channels")?)
                                .map_err(|_| Error::malformed("event: too many channels"))?,
                        })
                    })?,
                    latency_ms: v.require_u32("latency_ms")?,
                })
            }
            "keyframe" => Event::Keyframe,
            "stats" => Event::Stats(Stats {
                elapsed_ms: v.require_u64("elapsed_ms")?,
                video_frames: v.require_u64("video_frames")?,
                audio_frames: v.require_u64("audio_frames")?,
                receivers: list(v, "receivers", stats_from)?,
                video_bytes: 0,
            }),
            "devices" => Event::Devices(DevicesEvent {
                devices: list(v, "devices", crate::net::discover::DeviceInfo::from_value)?,
            }),
            "pin-required" => Event::PinRequired(PinRequest {
                name: v.require_str("name")?.to_owned(),
                address: v.require_str("address")?.to_owned(),
                password: v.get("password").and_then(Value::as_bool).unwrap_or(false),
            }),
            "paired" => Event::Paired(Paired {
                name: v.require_str("name")?.to_owned(),
                model: opt_str(v, "model"),
                file: opt_str(v, "file"),
            }),
            "unpaired" => Event::Unpaired(Unpaired {
                name: v.require_str("name")?.to_owned(),
                id: v.require_str("id")?.to_owned(),
            }),
            "end" => Event::End(EndInfo {
                reason: wire(v, "reason", EndReason::from_wire)?,
                receivers: match v.get("receivers") {
                    Some(_) => Some(list(v, "receivers", |r| {
                        Ok(ReceiverEndInfo {
                            stats: stats_from(r)?,
                            end: wire(r, "end", ReceiverEnd::from_wire)?,
                            error: opt_str(r, "error"),
                        })
                    })?),
                    None => None,
                },
            }),
            "error" => Event::Error(ErrorInfo {
                kind: v.require_str("kind")?.to_owned(),
                code: opt_str(v, "code"),
                message: v.require_str("message")?.to_owned(),
                device: opt_str(v, "device"),
            }),
            "progress" => Event::Progress(progress_from(v)?),
            other => return Err(Error::unsupported(format!("event: unknown type {other:?}"))),
        })
    }
}

// ---------------------------------------------------------------------------
// The handle

type Sink = dyn Fn(Event) + Send + Sync;

/// Where a session's events go: nowhere by default, or a function (the
/// API's queue and callback, the CLI's `--machine` lines). Cloning shares
/// the destination.
#[derive(Clone, Default)]
pub struct Events(Option<Arc<Sink>>);

impl Events {
    /// Events that go nowhere.
    pub fn none() -> Events {
        Events(None)
    }

    /// Events handed to `f`, on whatever thread emits them (so `f` must be
    /// quick).
    pub fn to(f: impl Fn(Event) + Send + Sync + 'static) -> Events {
        Events(Some(Arc::new(f)))
    }

    /// Whether anything listens (skip building events nobody reads).
    pub fn active(&self) -> bool {
        self.0.is_some()
    }

    /// Sends an event.
    pub fn emit(&self, e: Event) {
        if let Some(f) = &self.0 {
            f(e);
        }
    }

    /// A [`Progress`] event.
    pub(crate) fn progress(&self, p: Progress) {
        self.emit(Event::Progress(p));
    }

    /// A [`ReceiverEvent`].
    pub(crate) fn receiver(
        &self,
        name: &str,
        protocol: Option<Protocol>,
        state: ReceiverState,
        error: Option<&Error>,
    ) {
        if self.active() {
            self.emit(Event::Receiver(ReceiverEvent::new(
                name, protocol, state, error,
            )));
        }
    }
}

impl std::fmt::Debug for Events {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(if self.active() {
            "Events(active)"
        } else {
            "Events(none)"
        })
    }
}

#[cfg(test)]
mod tests;
