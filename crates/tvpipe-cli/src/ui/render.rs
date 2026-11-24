//! The renderer: the session's events, warnings and the clock in,
//! terminal bytes out. No I/O and no real clock, so the tests script it.
//!
//! On a live terminal ([`Caps::live`]) the last line is a status line
//! redrawn in place (a spinner while a step runs, the stream's numbers
//! while it plays); everything else is printed above it. Without one,
//! only the lines.

use std::time::Duration;

use tvpipe::__cli::events::{
    CaptureEvent, EndInfo, EndReason, ErrorInfo, Event, Progress, Protocol, ReceiverEvent,
    ReceiverState, Started, Stats, Step, TunnelEvent, TunnelPage, ViewerEvent, ViewerState,
};
use tvpipe::log::{Level, Record};
use tvpipe::PlaybackStatus;

use super::confirm::{Confirm, Key};
use super::term::{Caps, StopHint};

/// What kind of command runs, for the status line and the end.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    /// A stream to receivers; the word on the status line ("Live",
    /// "Playing").
    Stream(&'static str),
    /// `game play`.
    Game,
    /// `debug tunnel PORT`.
    Tunnel,
    /// A command that ends by itself (discover, pair).
    Once,
}

const SPINNER: [char; 10] = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/// SGR styles, or nothing without colours.
#[derive(Debug, Clone, Copy)]
struct Paint(bool);

impl Paint {
    fn sgr(self, code: &str, s: &str) -> String {
        if self.0 && !s.is_empty() {
            format!("\x1b[{code}m{s}\x1b[0m")
        } else {
            s.to_owned()
        }
    }
    fn dim(self, s: &str) -> String {
        self.sgr("2", s)
    }
    fn bold(self, s: &str) -> String {
        self.sgr("1", s)
    }
    /// The one accent colour.
    fn accent(self, s: &str) -> String {
        self.sgr("36", s)
    }
    fn url(self, s: &str) -> String {
        self.sgr("36;4", s)
    }
    fn yellow(self, s: &str) -> String {
        self.sgr("33;1", s)
    }
    fn red(self, s: &str) -> String {
        self.sgr("31;1", s)
    }
}

/// The renderer's state.
pub struct Renderer {
    caps: Caps,
    paint: Paint,
    kind: Kind,
    /// The command's name, for `--help` hints.
    command: String,
    title: Option<String>,
    title_shown: bool,
    /// The game being played (the status line); its links were shown
    /// with the first one (the next game of the run: a note).
    game: Option<String>,
    out: String,
    /// The last line printed is blank (or nothing is printed yet).
    blank: bool,
    /// The status line is on the screen, the cursor at its end.
    drawn: bool,
    /// What it shows.
    last: String,
    /// A line typed on the terminal moved the cursor below the status
    /// line.
    up: bool,
    prompting: bool,
    stopping: bool,
    /// `q` asked whether to stop.
    confirm: Confirm,
    ended: bool,
    /// Steps running, with when they began.
    steps: Vec<(Step, Duration)>,
    /// When the first step for a receiver began (its line's duration).
    began: Vec<(String, Duration)>,
    /// Receivers that failed while connecting, until `connected` says
    /// whether the session goes on.
    held: Vec<(String, String)>,
    connected: bool,
    /// Connected receivers, the browser page left out.
    receivers: Vec<String>,
    browser: bool,
    viewers: usize,
    started: Option<(Started, Duration)>,
    stats: Option<Stats>,
    /// Measured frames per second and bits per second.
    rate: Option<(f64, f64)>,
    /// When the clock of the status line starts (games, tunnels).
    since: Option<Duration>,
    phones: usize,
    casting: Vec<String>,
    /// A download's bytes so far and its length.
    download: Option<(u64, Option<u64>)>,
    /// `play` of a file: where it is (polled from its control).
    playback: Option<PlaybackStatus>,
    /// The note about the playback keys was shown.
    keys_told: bool,
    /// Messages already printed (the command's error is not repeated).
    shown: Vec<String>,
}

impl Renderer {
    /// `title` is the part after "tvpipe · " (`None`: no title line, or
    /// one set later with [`Renderer::set_title`]).
    pub fn new(caps: Caps, kind: Kind, command: &str, title: Option<String>) -> Renderer {
        Renderer {
            caps,
            paint: Paint(caps.color),
            kind,
            command: command.to_owned(),
            title,
            title_shown: false,
            game: None,
            out: String::new(),
            blank: true,
            drawn: false,
            last: String::new(),
            up: false,
            prompting: false,
            stopping: false,
            confirm: Confirm::default(),
            ended: false,
            steps: Vec::new(),
            began: Vec::new(),
            held: Vec::new(),
            connected: false,
            receivers: Vec::new(),
            browser: false,
            viewers: 0,
            started: None,
            stats: None,
            rate: None,
            since: None,
            phones: 0,
            casting: Vec::new(),
            download: None,
            playback: None,
            keys_told: false,
            shown: Vec::new(),
        }
    }

    /// Where a `play` that seeks and pauses is (the ticker polls it).
    /// Once it streams, a note says which keys do it.
    pub fn set_playback(&mut self, status: PlaybackStatus) {
        self.playback = status.seekable.then_some(status);
        if !self.keys_told
            && status.seekable
            && self.started.is_some()
            && self.caps.stop == StopHint::Key
        {
            self.keys_told = true;
            self.note("Space pauses, ←/→ jump 10 s, ↑/↓ a minute");
        }
    }

    /// The bytes to write since the last call.
    pub fn take(&mut self) -> String {
        std::mem::take(&mut self.out)
    }

    /// Sets the title if none is shown yet.
    pub fn set_title(&mut self, title: &str) {
        if !self.title_shown {
            self.title = Some(title.to_owned());
        }
    }

    // -----------------------------------------------------------------
    // Lines

    fn ensure_title(&mut self) {
        if self.title_shown {
            return;
        }
        if self.title.is_none() && self.kind == Kind::Game {
            // A line before the game said its title.
            self.title = Some("Playing a game".into());
        }
        self.title_shown = true;
        if let Some(t) = self.title.clone() {
            let p = self.paint;
            let line = format!("{}{}{}", p.sgr("1;36", "tvpipe"), p.dim(" · "), p.bold(&t));
            self.raw_line(&line);
            self.raw_line("");
        }
    }

    fn clear_live(&mut self) {
        if self.drawn {
            if self.up {
                self.out.push_str("\x1b[1A");
            }
            self.out.push_str("\r\x1b[2K");
            self.drawn = false;
            self.up = false;
        }
    }

    fn raw_line(&mut self, s: &str) {
        self.clear_live();
        self.out.push_str(s);
        self.out.push('\n');
        self.blank = s.is_empty();
    }

    /// One line above the status line.
    fn line(&mut self, s: &str) {
        self.ensure_title();
        self.raw_line(s);
    }

    fn blank_line(&mut self) {
        self.ensure_title();
        if !self.blank {
            self.raw_line("");
        }
    }

    /// `symbol text`, wrapped on a live terminal with the text's lines
    /// indented under the first.
    fn symbol_line(&mut self, symbol: &str, text: &str) {
        let lines = if self.caps.live {
            wrap(text, self.caps.width.saturating_sub(2).max(20))
        } else {
            vec![text.to_owned()]
        };
        for (i, l) in lines.iter().enumerate() {
            if i == 0 {
                self.line(&format!("{symbol} {l}"));
            } else {
                self.line(&format!("  {l}"));
            }
        }
    }

    fn ok(&mut self, text: &str, took: Option<Duration>) {
        let p = self.paint;
        let text = match took.filter(|d| *d >= Duration::from_millis(500)) {
            Some(d) => format!("{text} {}", p.dim(&format!("({})", seconds(d)))),
            None => text.to_owned(),
        };
        self.symbol_line(&p.accent("✓"), &text);
    }

    fn note(&mut self, text: &str) {
        let p = self.paint;
        self.symbol_line(&p.dim("•"), text);
    }

    fn warn(&mut self, text: &str) {
        let p = self.paint;
        self.symbol_line(&p.yellow("!"), text);
    }

    fn fail(&mut self, text: &str) {
        let p = self.paint;
        self.symbol_line(&p.red("✗"), text);
    }

    fn hint(&mut self, text: &str) {
        let p = self.paint;
        let line = format!("  {}", p.dim(text));
        self.line(&line);
    }

    /// A link: a label, the URL on its own line, its QR code if wanted,
    /// a footnote; framed by blank lines.
    /// A link shown only as its QR code (`caps.qr`), with a label and a
    /// footnote.
    fn qr_block(&mut self, label: &str, url: &str, footnote: &str) {
        let p = self.paint;
        self.blank_line();
        self.line(&format!("  {}", p.bold(label)));
        if let Some(art) = tvpipe::__cli::qr::render_terminal(url) {
            self.raw_line("");
            for l in art.lines() {
                self.raw_line(&format!("  {l}"));
            }
            self.raw_line("");
        }
        self.line(&format!("  {}", p.dim(footnote)));
        self.raw_line("");
    }

    fn link(&mut self, label: &str, url: &str, qr: bool, footnote: Option<&str>) {
        let p = self.paint;
        self.blank_line();
        self.line(&format!("  {}", p.bold(label)));
        self.line(&format!("  {}", p.url(url)));
        if qr && self.caps.qr {
            if let Some(art) = tvpipe::__cli::qr::render_terminal(url) {
                self.raw_line("");
                for l in art.lines() {
                    self.raw_line(&format!("  {l}"));
                }
            }
        }
        if let Some(f) = footnote {
            if qr && self.caps.qr {
                self.raw_line("");
            }
            self.line(&format!("  {}", p.dim(f)));
        }
        self.raw_line("");
    }

    // -----------------------------------------------------------------
    // Input

    /// A session event.
    pub fn event(&mut self, e: &Event, now: Duration) {
        match e {
            Event::Progress(p) => self.progress(p, now),
            Event::Receiver(r) => self.receiver(r, now),
            Event::Player(p) => self.link("Watch on this computer", &p.url, false, None),
            Event::SharePage(p) => {
                self.link("Open this page and press Share", &p.url, false, None);
            }
            Event::Tunnel(t) => self.tunnel(t, now),
            Event::Viewer(v) => match v.state {
                ViewerState::Connected => {
                    self.viewers += 1;
                    self.end_step(|s| *s == Step::Viewer);
                    if v.public {
                        self.note(&opened_link(v));
                    }
                }
                ViewerState::Disconnected => self.viewers = self.viewers.saturating_sub(1),
                _ => {}
            },
            Event::Capture(c) => self.capture(c, now),
            Event::Connected(c) => {
                self.connected = true;
                for (name, error) in std::mem::take(&mut self.held) {
                    self.fail(&format!("Couldn't connect to {name}: {error}"));
                    self.shown.push(error);
                }
                if c.receivers.is_empty() {
                    self.receivers.clear();
                }
            }
            Event::Started(s) => {
                self.started = Some((s.clone(), now));
                if !self.caps.live {
                    self.note(&format!(
                        "Streaming {}×{} at {} fps",
                        s.video.width,
                        s.video.height,
                        fps(s.video.fps)
                    ));
                }
            }
            Event::Stats(s) => {
                if let Some(prev) = &self.stats {
                    let dt = s.elapsed_ms.saturating_sub(prev.elapsed_ms) as f64 / 1000.0;
                    if dt > 0.0 {
                        let frames = s.video_frames.saturating_sub(prev.video_frames) as f64;
                        let bytes = s.video_bytes.saturating_sub(prev.video_bytes) as f64;
                        self.rate = Some((frames / dt, bytes * 8.0 / dt));
                    }
                }
                self.stats = Some(s.clone());
            }
            Event::End(e) => self.end(e, now),
            Event::Paired(p) => {
                let model = p
                    .model
                    .as_deref()
                    .map(|m| format!(" · {m}"))
                    .unwrap_or_default();
                self.ok(&format!("Paired with {}{model}", p.name), None);
                self.hint(&format!(
                    "Stream to it with: tvpipe play FILE --to {}",
                    quote(&p.name)
                ));
            }
            Event::Unpaired(u) => self.ok(&format!("Forgot the pairing with {}", u.name), None),
            _ => {}
        }
        self.redraw(now);
    }

    /// A log record: warnings are shown, the rest is for `-v`.
    pub fn log(&mut self, r: &Record, now: Duration) {
        if r.level == Level::Warn {
            let text = sentence(strip_tag(&r.message));
            self.warn(&text);
            self.redraw(now);
        }
    }

    fn progress(&mut self, p: &Progress, now: Duration) {
        match p {
            Progress::Begin(s) => {
                if let Step::Find(n) | Step::Connect(n) = s {
                    if !self.began.iter().any(|(b, _)| b == n) {
                        self.began.push((n.clone(), now));
                    }
                }
                self.steps.push((s.clone(), now));
            }
            Progress::Done(s, detail) => {
                let took = self.end_step(|x| x == s).map(|t| now.saturating_sub(t));
                match s {
                    Step::Browser => {
                        let name = detail.as_deref().map(browser_name);
                        let text = match name {
                            Some(n) if !n.is_empty() => format!("{n} started"),
                            _ => "The browser started".to_owned(),
                        };
                        self.ok(&text, took);
                    }
                    Step::Window => self.ok("Game window open", took),
                    Step::Download(what) => {
                        let size = self.download.take().map(|(d, _)| mib(d));
                        let text = match size {
                            Some(m) => format!("Downloaded {what} ({m})"),
                            None => format!("Downloaded {what}"),
                        };
                        self.ok(&text, took);
                    }
                    _ => {}
                }
            }
            Progress::Failed(s, error) => {
                let s = s.clone();
                self.end_step(|x| *x == s);
                // Games go on without a public link; elsewhere the
                // command's error says it.
                if s == Step::Tunnel && self.kind == Kind::Game {
                    self.warn(&format!(
                        "No public link ({error}); phones on other networks cannot join"
                    ));
                }
            }
            Progress::Game { title, .. } if self.game.is_some() => {
                // The next game of the run: the links stay the same.
                self.game = Some(title.clone());
                self.note(&format!("Now playing {title}"));
            }
            Progress::Game { title, local, lan } => {
                self.game = Some(title.clone());
                self.set_title(title);
                // Picked in the window: the title line went out before.
                if self.title_shown && self.title.as_deref() != Some(title.as_str()) {
                    self.note(&format!("Now playing {title}"));
                }
                self.since.get_or_insert(now);
                self.link("Play in a browser on this computer", local, false, None);
                if let Some(lan) = lan {
                    self.link("Phones on the same Wi-Fi join here", lan, true, None);
                }
            }
            Progress::GameLink {
                url,
                provider,
                short,
            } => {
                let took = self
                    .end_step(|s| *s == Step::Tunnel)
                    .map(|t| now.saturating_sub(t));
                self.ok("Public link ready", took);
                if *short {
                    // The tunnel's link is too long to read out: only its
                    // QR code here; the short link to type follows.
                    if self.caps.qr {
                        self.qr_block("Phones scan this", url, &provider_note(provider));
                    }
                } else {
                    self.link(
                        "Phones join here",
                        url,
                        true,
                        Some(&provider_note(provider)),
                    );
                }
            }
            Progress::ShortLink { url } => {
                let note = self
                    .caps
                    .qr
                    .then_some("Or scan the QR code above: it opens the game directly");
                self.link("Phones join here", url, false, note);
            }
            Progress::Phones(n) => self.phones = *n,
            Progress::Download { done, total } => self.download = Some((*done, *total)),
            Progress::Casting(to) => {
                self.casting = to.clone();
                self.note(&format!("Casting to {}", list(to)));
            }
            Progress::CastFailed(e) => {
                self.casting.clear();
                self.fail(&format!("The cast failed: {e}"));
            }
            Progress::CastStopped => {
                if !self.casting.is_empty() {
                    self.note("The cast stopped");
                }
                self.casting.clear();
            }
            _ => {}
        }
    }

    /// Ends the first running step that matches; when it began.
    fn end_step(&mut self, f: impl Fn(&Step) -> bool) -> Option<Duration> {
        let i = self.steps.iter().position(|(s, _)| f(s))?;
        Some(self.steps.remove(i).1)
    }

    fn began(&self, name: &str) -> Option<Duration> {
        self.began.iter().find(|(n, _)| n == name).map(|(_, t)| *t)
    }

    fn receiver(&mut self, r: &ReceiverEvent, now: Duration) {
        let name = r.name.clone();
        let error = r.error.clone().unwrap_or_else(|| "unknown error".into());
        match r.state {
            ReceiverState::Connected => {
                self.end_step(|s| matches!(s, Step::Find(n) | Step::Connect(n) if *n == name));
                if r.protocol == Some(Protocol::Browser) {
                    self.browser = true;
                    return;
                }
                if !self.receivers.contains(&name) {
                    self.receivers.push(name.clone());
                }
                let took = self.began(&name).map(|t| now.saturating_sub(t));
                let kind = match r.protocol {
                    Some(Protocol::Cast) => " · Google Cast",
                    Some(Protocol::AirPlay) => " · AirPlay",
                    _ => "",
                };
                self.ok(&format!("Connected to {name}{kind}"), took);
            }
            ReceiverState::Failed => {
                self.end_step(|s| matches!(s, Step::Find(n) | Step::Connect(n) if *n == name));
                self.receivers.retain(|n| *n != name);
                // With others still connecting or connected, the session
                // goes on: say it now. The last one waits: its error may
                // be the command's.
                let others = !self.receivers.is_empty()
                    || self.browser
                    || self
                        .steps
                        .iter()
                        .any(|(s, _)| matches!(s, Step::Find(_) | Step::Connect(_)));
                if self.connected {
                    self.fail(&format!("{name} failed: {error}"));
                    self.shown.push(error);
                } else if others {
                    self.fail(&format!("Couldn't connect to {name}: {error}"));
                    self.shown.push(error);
                } else {
                    self.held.push((name, error));
                }
            }
            ReceiverState::Lost => {
                self.warn(&format!("Lost {name} ({error}); reconnecting…"));
            }
            ReceiverState::Reconnected => self.ok(&format!("{name} is back"), None),
            ReceiverState::GaveUp => {
                self.receivers.retain(|n| *n != name);
                self.fail(&format!("Gave up on {name}: {error}"));
                self.shown.push(error);
            }
            ReceiverState::Ended => {
                self.receivers.retain(|n| *n != name);
                if !self.ended {
                    self.note(&format!("{name} ended the session"));
                }
            }
            _ => {}
        }
    }

    fn tunnel(&mut self, t: &TunnelEvent, now: Duration) {
        let took = self
            .end_step(|s| *s == Step::Tunnel)
            .map(|b| now.saturating_sub(b));
        self.ok("Public link ready", took);
        let note = provider_note(&t.provider);
        match t.page {
            TunnelPage::Player => {
                self.link("Anyone with this link can watch", &t.url, true, Some(&note))
            }
            TunnelPage::Share => self.link(
                "Anyone with this link can ask to share their screen here",
                &t.url,
                true,
                Some(&format!("{note} · you confirm each share here")),
            ),
            _ => {
                self.since.get_or_insert(now);
                self.link("Public link", &t.url, true, Some(&note));
            }
        }
    }

    fn capture(&mut self, c: &CaptureEvent, now: Duration) {
        let took = self
            .end_step(|s| *s == Step::Capture)
            .map(|b| now.saturating_sub(b));
        let what = match (c.surface.as_deref(), c.label.as_deref()) {
            (Some("monitor"), _) => "your screen".to_owned(),
            (Some("window"), Some(l)) if !l.is_empty() => format!("the window “{l}”"),
            (Some("window"), _) => "a window".to_owned(),
            (Some("browser"), Some(l)) if !l.is_empty() => format!("the tab “{l}”"),
            (Some("browser"), _) => "a browser tab".to_owned(),
            _ => "the page".to_owned(),
        };
        let sound = if c.audio {
            "with sound"
        } else {
            "without sound"
        };
        self.ok(
            &format!("Capturing {what} · {}×{} {sound}", c.width, c.height),
            took,
        );
    }

    fn end(&mut self, e: &EndInfo, now: Duration) {
        if self.ended {
            return;
        }
        let streamed = self.streamed(now);
        let to = self.audience_end();
        let played = matches!(self.kind, Kind::Stream("Playing"));
        let text = match e.reason {
            EndReason::Eof => {
                let verb = if played { "Played" } else { "Streamed" };
                Some(format!("Done. {verb} {streamed}{to}."))
            }
            EndReason::Stopped => Some(format!("Stopped. Streamed {streamed}{to}.")),
            EndReason::ReceiversGone => Some(format!(
                "The receivers ended the session. Streamed {streamed}{to}."
            )),
            // The error follows.
            _ => None,
        };
        self.ended = true;
        self.steps.clear();
        if let Some(t) = text {
            self.blank_line();
            if e.reason == EndReason::Eof {
                self.ok(&t, None);
            } else {
                self.line(&t);
            }
        }
    }

    fn streamed(&self, now: Duration) -> String {
        // The stats' clock, or the time since the start when it is ahead
        // (stats come once a second).
        let since = self
            .started
            .as_ref()
            .map(|(_, t)| now.saturating_sub(*t).as_millis() as u64)
            .unwrap_or(0);
        let ms = self.stats.as_ref().map_or(0, |s| s.elapsed_ms).max(since);
        clock(Duration::from_millis(ms))
    }

    /// " to Living Room TV", " to the browser page", " to 3 receivers".
    fn audience_end(&self) -> String {
        let n = self.receivers.len() + self.browser as usize;
        match (self.receivers.as_slice(), self.browser) {
            ([], false) => String::new(),
            ([], true) => " to the browser page".to_owned(),
            ([one], false) => format!(" to {one}"),
            _ => format!(" to {n} receivers"),
        }
    }

    /// The end of a command without an `end` event (stopped before it
    /// streamed, a game, a tunnel).
    pub fn finish(&mut self, stopped: bool, now: Duration) {
        if !self.ended {
            self.ended = true;
            self.steps.clear();
            match self.kind {
                Kind::Once => {}
                Kind::Game | Kind::Tunnel => {
                    let took = self
                        .since
                        .map(|s| format!(" after {}", clock(now.saturating_sub(s))))
                        .unwrap_or_default();
                    self.blank_line();
                    self.line(&format!("Stopped{took}."));
                }
                Kind::Stream(_) if stopped => {
                    self.blank_line();
                    self.line("Stopped.");
                }
                Kind::Stream(_) => {}
            }
        }
        self.clear_live();
    }

    /// The process ends at once (a second Ctrl-C): no status line.
    pub fn abandon(&mut self) {
        self.ended = true;
        self.clear_live();
    }

    /// The command failed: `✗ what: why`, then what to try.
    pub fn error(&mut self, e: &ErrorInfo, now: Duration) {
        let _ = now;
        for (name, error) in std::mem::take(&mut self.held) {
            if error != e.message {
                self.fail(&format!("Couldn't connect to {name}: {error}"));
            }
        }
        self.ended = true;
        self.steps.clear();
        if !self.shown.contains(&e.message) {
            let text = match (e.code.as_deref(), e.device.as_deref()) {
                (Some("no-receiver"), Some(d)) => {
                    format!("No receiver named {} answered on this network", quote(d))
                }
                (Some("pairing-required"), Some(d)) => {
                    format!("{d} needs pairing before it shows anything")
                }
                (Some("home-only"), Some(d)) => {
                    format!("{d} only takes AirPlay from members of its Apple Home")
                }
                _ => sentence(&e.message),
            };
            self.fail(&text);
        }
        let hint = match (e.code.as_deref(), e.device.as_deref()) {
            (Some("no-receiver"), _) => {
                Some("See which receivers are on this network: tvpipe discover".to_owned())
            }
            (Some("pairing-required"), Some(d)) => {
                Some(format!("Pair it once with: tvpipe pair {}", quote(d)))
            }
            (Some("home-only"), d) => Some(match d {
                Some(d) => format!(
                    "{}, then pair it if it is not yet: tvpipe pair {}",
                    home_access(),
                    quote(d)
                ),
                None => home_access(),
            }),
            (Some("input-not-found"), _) => Some("Check the file's name, or give a URL".into()),
            (Some("ffmpeg-missing"), _) => Some(
                "This input needs ffmpeg: install it (https://ffmpeg.org/download.html) \
                 or point --ffmpeg at it"
                    .into(),
            ),
            (Some("pin-missing"), _) => {
                Some("Run tvpipe pair again and type the PIN the TV shows".into())
            }
            _ if e.kind == "usage" && !self.command.is_empty() => {
                Some(format!("See: tvpipe {} --help", self.command))
            }
            _ => None,
        };
        if let Some(h) = hint {
            self.hint(&h);
        }
        self.clear_live();
    }

    /// Asks on the terminal: the question stays on the line, the answer
    /// follows it.
    pub fn prompt(&mut self, question: &str) {
        self.ensure_title();
        self.clear_live();
        let p = self.paint;
        self.out.push_str(&format!("{} {question} ", p.accent("?")));
        self.prompting = true;
        self.blank = false;
    }

    /// The prompt got its answer (the terminal's echo ended the line), or
    /// was cancelled (`newline`: end the line).
    pub fn answered(&mut self, newline: bool, now: Duration) {
        if newline {
            self.out.push('\n');
        }
        self.prompting = false;
        self.redraw(now);
    }

    /// A line was typed (and echoed) while the status line was shown.
    pub fn typed(&mut self) {
        if self.drawn && !self.prompting {
            self.up = true;
        }
    }

    /// Stopping was requested (q, Ctrl-C).
    pub fn stopping(&mut self, now: Duration) {
        self.stopping = true;
        self.confirm.stopped();
        self.redraw(now);
    }

    /// A key on the terminal (a line in line mode): true to stop now.
    /// The first `q` asks on the status line while something is watched
    /// or played; without a status line `q` stops at once.
    pub fn key(&mut self, key: Key, now: Duration) -> bool {
        if !self.caps.live || self.stopping || self.ended || self.prompting {
            return key == Key::Quit;
        }
        let watched = self.watched();
        let stop = self.confirm.key(key, watched, now);
        if stop {
            // "Stopping…" right away, not the numbers in between.
            self.stopping(now);
        } else {
            self.redraw(now);
        }
        stop
    }

    /// Someone would notice a stop: a receiver shows the stream, a
    /// browser watches it, phones play the game.
    fn watched(&self) -> bool {
        match self.kind {
            Kind::Stream(_) => !self.receivers.is_empty() || self.viewers > 0,
            Kind::Game => self.phones > 0,
            Kind::Tunnel | Kind::Once => false,
        }
    }

    /// The question after the first `q`, fitted to `width`.
    fn question(&self, width: usize) -> String {
        let p = self.paint;
        let (question, verb, keep) = match self.kind {
            Kind::Stream("Playing") => ("Stop playing?", "stop", "keep going"),
            Kind::Game => ("End the game?", "end it", "keep playing"),
            _ => ("Stop streaming?", "stop", "keep going"),
        };
        let (long, short) = match self.caps.stop {
            StopHint::Line => (
                format!("Type q and Enter again to {verb}, just Enter to {keep}"),
                format!("q + Enter again to {verb}"),
            ),
            _ => (
                format!("Press q again to {verb}, any other key to {keep}"),
                format!("Press q again to {verb}"),
            ),
        };
        let head = format!("{} {}", p.yellow("?"), p.bold(question));
        for how in [long, short] {
            let line = format!("{head} {how}");
            if visible(&line) <= width {
                return line;
            }
        }
        cut(&head, width)
    }

    // -----------------------------------------------------------------
    // The status line

    /// Redraws the status line (also every few hundred ms on a live
    /// terminal, for the spinner and the clock).
    pub fn redraw(&mut self, now: Duration) {
        if !self.caps.live || self.prompting {
            return;
        }
        self.confirm.expire(now);
        let text = if self.ended { None } else { self.status(now) };
        if self.drawn && !self.up && text.as_ref() == Some(&self.last) {
            return;
        }
        self.clear_live();
        if let Some(t) = text {
            // A game's title comes with its first event.
            if self.title.is_some() {
                self.ensure_title();
            }
            // Autowrap off while drawing: a line wider than the terminal
            // is cut, never wrapped (which would leave a copy behind).
            self.out.push_str("\x1b[?7l");
            self.out.push_str(&t);
            self.out.push_str("\x1b[?7h");
            self.drawn = true;
            self.last = t;
        }
    }

    fn status(&self, now: Duration) -> Option<String> {
        let p = self.paint;
        let spin = SPINNER[(now.as_millis() / 100) as usize % SPINNER.len()];
        let width = self.caps.width.saturating_sub(1).max(1);
        if self.stopping {
            return Some(fit(
                &[format!("{} Stopping…", p.accent(&spin.to_string()))],
                &[],
                width,
                p,
            ));
        }
        if self.confirm.asking() {
            return Some(self.question(width));
        }
        if let Some((step, t)) = self.steps.first() {
            let mut s = format!("{} {}", p.accent(&spin.to_string()), self.pending(step));
            let waited = now.saturating_sub(*t);
            if waited >= Duration::from_secs(2) {
                s.push_str(&p.dim(&format!(" {} s", waited.as_secs())));
            }
            if self.steps.len() > 1 {
                s.push_str(&p.dim(&format!(" (+{} more)", self.steps.len() - 1)));
            }
            return Some(fit(&[s], &[], width, p));
        }
        let playback = self.playback.filter(|_| self.started.is_some());
        let hints: &[&str] = match self.caps.stop {
            StopHint::Key => &["q to stop"],
            StopHint::Line => &["q + Enter to stop"],
            StopHint::CtrlC => &["Ctrl-C to stop"],
            StopHint::None => &[],
        };
        let dot = p.accent("●");
        let parts = match self.kind {
            Kind::Stream(word) => {
                let (s, _) = self.started.as_ref()?;
                let mut parts = vec![match playback {
                    Some(b) if b.paused => format!("{} Paused", p.yellow("●")),
                    _ => format!("{dot} {word}"),
                }];
                let elapsed = match playback {
                    Some(b) => match b.duration {
                        Some(d) => format!("{} / {}", clock(b.position), clock(d)),
                        None => clock(b.position),
                    },
                    None => self.streamed(now),
                };
                parts.push(format!("{}×{}", s.video.width, s.video.height));
                let fps_now = self.rate.map(|r| r.0).unwrap_or(s.video.fps);
                parts.push(format!("{} fps", fps(fps_now)));
                if let Some((_, bps)) = self.rate {
                    parts.push(mbits(bps));
                }
                if let Some(a) = self.audience() {
                    parts.push(a);
                }
                parts.push(elapsed);
                parts
            }
            Kind::Game => {
                let since = self.since?;
                let mut parts = vec![match &self.game {
                    Some(g) => format!("{dot} {g}"),
                    None => format!("{dot} Running"),
                }];
                parts.push(match self.phones {
                    0 => "no phones yet".to_owned(),
                    1 => "1 phone".to_owned(),
                    n => format!("{n} phones"),
                });
                if !self.casting.is_empty() {
                    parts.push(format!("on {}", list(&self.casting)));
                }
                parts.push(clock(now.saturating_sub(since)));
                parts
            }
            Kind::Tunnel => {
                let since = self.since?;
                vec![format!("{dot} Link open"), clock(now.saturating_sub(since))]
            }
            Kind::Once => return None,
        };
        Some(fit(&parts, hints, width, p))
    }

    /// Who watches, for the status line.
    fn audience(&self) -> Option<String> {
        let watching = match self.viewers {
            0 => "no viewers yet".to_owned(),
            1 => "1 viewer".to_owned(),
            n => format!("{n} viewers"),
        };
        match (self.receivers.as_slice(), self.browser) {
            ([], false) => None,
            ([], true) => Some(watching),
            (r, b) => {
                let tvs = match r {
                    [one] => one.clone(),
                    r => format!("{} receivers", r.len()),
                };
                Some(if b && self.viewers > 0 {
                    format!("{tvs} + {watching}")
                } else {
                    tvs
                })
            }
        }
    }

    fn pending(&self, s: &Step) -> String {
        match s {
            Step::Find(n) => format!("Looking for {n}…"),
            Step::Connect(n) => format!("Connecting to {n}…"),
            Step::Browser => "Starting the browser…".to_owned(),
            Step::Window => "Opening the game window…".to_owned(),
            Step::Tunnel => "Opening a public link…".to_owned(),
            Step::Capture if self.title.as_deref().is_some_and(|t| t.contains("screen")) => {
                "Waiting for the screen capture…".to_owned()
            }
            Step::Capture => "Waiting for someone to press Share…".to_owned(),
            Step::Viewer => "Waiting for someone to open the page…".to_owned(),
            Step::Discover => "Looking for receivers on this network…".to_owned(),
            Step::Download(what) => match self.download {
                Some((d, Some(t))) => format!("Downloading {what}… {} of {}", mib(d), mib(t)),
                Some((d, None)) => format!("Downloading {what}… {}", mib(d)),
                None => format!("Downloading {what}…"),
            },
            _ => "Working…".to_owned(),
        }
    }
}

// ---------------------------------------------------------------------------
// Text

/// Bytes as KiB or MiB with one decimal.
fn mib(b: u64) -> String {
    if b < 1 << 20 {
        format!("{:.1} KiB", b as f64 / 1024.0)
    } else {
        format!("{:.1} MiB", b as f64 / (1 << 20) as f64)
    }
}

/// Visible width: characters, escape sequences left out.
pub fn visible(s: &str) -> usize {
    let mut n = 0;
    let mut esc = false;
    for c in s.chars() {
        if esc {
            if c.is_ascii_alphabetic() {
                esc = false;
            }
        } else if c == '\x1b' {
            esc = true;
        } else {
            n += 1;
        }
    }
    n
}

/// Cuts `s` to `width` visible characters, ending in "…" when cut.
fn cut(s: &str, width: usize) -> String {
    if visible(s) <= width {
        return s.to_owned();
    }
    let mut out = String::new();
    let mut n = 0;
    let mut esc = false;
    for c in s.chars() {
        if esc {
            out.push(c);
            esc = !c.is_ascii_alphabetic();
            continue;
        }
        if c == '\x1b' {
            out.push(c);
            esc = true;
            continue;
        }
        if n + 1 >= width {
            break;
        }
        out.push(c);
        n += 1;
    }
    if width > 0 {
        out.push('…');
    }
    if out.contains('\x1b') {
        out.push_str("\x1b[0m");
    }
    out
}

/// The status line: `parts` joined by " · ", the first hint that fits at
/// the right; when none does, the hint goes first, then parts from the
/// second to last backwards (the first and the clock stay), then it is
/// cut.
fn fit(parts: &[String], hints: &[&str], width: usize, p: Paint) -> String {
    let sep = p.dim(" · ");
    let mut keep: Vec<&String> = parts.iter().collect();
    let join = |keep: &[&String]| {
        keep.iter()
            .map(|s| s.as_str())
            .collect::<Vec<_>>()
            .join(&sep)
    };
    let mut line = join(&keep);
    for h in hints {
        if visible(&line) + 4 + visible(h) <= width {
            return format!("{line}    {}", p.dim(h));
        }
    }
    while visible(&line) > width && keep.len() > 2 {
        keep.remove(keep.len() - 2);
        line = join(&keep);
    }
    cut(&line, width)
}

/// Words wrapped to `width` (long words stay whole).
pub fn wrap(text: &str, width: usize) -> Vec<String> {
    let mut lines = Vec::new();
    let mut cur = String::new();
    for word in text.split(' ') {
        if !cur.is_empty() && visible(&cur) + 1 + visible(word) > width {
            lines.push(std::mem::take(&mut cur));
        }
        if !cur.is_empty() {
            cur.push(' ');
        }
        cur.push_str(word);
    }
    if !cur.is_empty() || lines.is_empty() {
        lines.push(cur);
    }
    lines
}

/// The log's component tag (`browser: …`) is for developers.
fn strip_tag(msg: &str) -> &str {
    const TAGS: [&str; 10] = [
        "browser: ",
        "share: ",
        "screen: ",
        "tunnel: ",
        "cast: ",
        "airplay: ",
        "playshare: ",
        "slrw: ",
        "passthrough: ",
        "player: ",
    ];
    TAGS.iter().find_map(|t| msg.strip_prefix(t)).unwrap_or(msg)
}

/// Upper-cases the first letter when the first word is a plain word
/// (not a file name, a program or a receiver: `nosuch.mkv: …`,
/// `ffmpeg: …`).
fn sentence(s: &str) -> String {
    let first = s.split(' ').next().unwrap_or("");
    let plain = first
        .trim_end_matches(',')
        .chars()
        .all(|c| c.is_ascii_lowercase());
    let mut c = s.chars();
    match c.next() {
        Some(f) if plain && f.is_ascii_lowercase() => {
            f.to_ascii_uppercase().to_string() + c.as_str()
        }
        _ => s.to_owned(),
    }
}

/// The Home app's steps for a members-only receiver, as a sentence.
pub fn home_access() -> String {
    let steps = tvpipe::__cli::HOME_ACCESS;
    let mut c = steps.chars();
    match c.next() {
        Some(first) => first.to_uppercase().chain(c).collect(),
        None => String::new(),
    }
}

/// A name as typed on the command line.
pub fn quote(name: &str) -> String {
    if name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || "-_.:".contains(c))
        && !name.is_empty()
    {
        name.to_owned()
    } else {
        format!("\"{}\"", name.replace('"', "\\\""))
    }
}

fn list(names: &[String]) -> String {
    match names {
        [] => String::new(),
        [one] => one.clone(),
        [a, b] => format!("{a} and {b}"),
        more => format!("{} receivers", more.len()),
    }
}

/// "Chrome/157.0.8103.79" → "Chrome".
fn browser_name(product: &str) -> String {
    let name = product.split('/').next().unwrap_or(product);
    name.strip_prefix("Headless").unwrap_or(name).to_owned()
}

fn provider_note(provider: &str) -> String {
    match provider {
        "cloudflare" => "Cloudflare quick tunnel · a new link every run".to_owned(),
        "opentunnel" => "Carried by OpenTunnel".to_owned(),
        other => format!("Carried by {other}"),
    }
}

/// "2.4 s", "12 s".
fn seconds(d: Duration) -> String {
    let s = d.as_secs_f64();
    if s < 10.0 {
        format!("{s:.1} s")
    } else {
        format!("{} s", d.as_secs())
    }
}

/// "00:03:12".
pub fn clock(d: Duration) -> String {
    let s = d.as_secs();
    format!("{:02}:{:02}:{:02}", s / 3600, s / 60 % 60, s % 60)
}

/// Whole frames per second: a measured 29.1 does not flicker.
fn fps(f: f64) -> String {
    format!("{}", f.round().max(0.0) as u64)
}

fn mbits(bps: f64) -> String {
    if bps >= 1e6 {
        format!("{:.1} Mbit/s", bps / 1e6)
    } else {
        format!("{} kbit/s", (bps / 1e3).round() as u64)
    }
}

/// "203.0.113.9 in DE (Safari 18 on iPhone) opened the public link", with
/// what the tunnel and the browser told (checked by the library), else
/// "Someone opened the public link".
fn opened_link(v: &ViewerEvent) -> String {
    let mut who = v.address.clone().unwrap_or_else(|| "Someone".into());
    if let Some(c) = &v.country {
        who.push_str(&format!(" in {c}"));
    }
    if let Some(b) = &v.browser {
        who.push_str(&format!(" ({b})"));
    }
    format!("{who} opened the public link")
}
