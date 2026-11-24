//! What a person sees in the terminal (docs/terminal-ui.md).
//!
//! Three modes: `--machine` (machine.rs), the developer log (`-v`,
//! `--debug`, `TVPIPE_LOG`: timestamped log lines on stderr, as before)
//! and, by default, this: a title, one line per thing that happened, links
//! with their QR codes and, on a terminal, a status line redrawn in place.
//! It is fed by the session's events ([`Event`]) and by warnings from the
//! log; [`render::Renderer`] turns them into bytes, this module owns the
//! one renderer of the process and writes to stderr. stdout stays for
//! data (discover's list, `--window none`'s URL, keyframe requests).

pub mod confirm;
pub mod render;
pub mod term;

#[cfg(test)]
mod tests;

use std::io::{IsTerminal, Write};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use tvpipe::__cli::events::{ErrorInfo, Event, Events};
use tvpipe::__cli::opts::{Command, InputSpec, ScreenTarget};
use tvpipe::__cli::Stop;
use tvpipe::log::{self, Level};

use render::{Kind, Renderer};
use term::{Caps, Facts, StopHint};

/// How the CLI talks to whoever runs it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    /// JSON events (`--machine`).
    Machine,
    /// Log lines at this level (`-v`, `--debug`, `TVPIPE_LOG`).
    Developer(Level),
    /// This module.
    People,
}

impl Mode {
    /// `--machine` wins, then `--debug`, `-v` and `TVPIPE_LOG`.
    pub fn pick(machine: bool, verbose: bool, debug: bool, env: Option<&str>) -> Mode {
        if machine {
            Mode::Machine
        } else if debug {
            Mode::Developer(Level::Trace)
        } else if verbose {
            Mode::Developer(Level::Debug)
        } else if let Some(l) = env.and_then(|e| Level::from_wire(e.trim())) {
            Mode::Developer(l)
        } else {
            Mode::People
        }
    }

    /// The log level the logger is installed at.
    pub fn level(self) -> Level {
        match self {
            Mode::Machine => Level::Info,
            Mode::Developer(l) => l,
            // Warnings are shown; the rest is for -v.
            Mode::People => Level::Warn,
        }
    }
}

struct Ui {
    r: Mutex<Renderer>,
    start: Instant,
}

static UI: OnceLock<Ui> = OnceLock::new();

fn with(f: impl FnOnce(&mut Renderer, Duration)) -> bool {
    let Some(ui) = UI.get() else {
        return false;
    };
    let r = ui.r.lock().unwrap_or_else(|e| e.into_inner());
    write(r, ui, f);
    true
}

fn write(
    mut r: std::sync::MutexGuard<'_, Renderer>,
    ui: &Ui,
    f: impl FnOnce(&mut Renderer, Duration),
) {
    f(&mut r, ui.start.elapsed());
    let out = r.take();
    if !out.is_empty() {
        // One write under the renderer's lock: lines stay whole and in
        // order.
        let mut err = std::io::stderr().lock();
        let _ = err.write_all(out.as_bytes());
        let _ = err.flush();
    }
}

/// Whether the people's UI runs.
pub fn active() -> bool {
    UI.get().is_some()
}

/// The title, the kind and the `--help` name of a command.
pub fn describe(command: &Command) -> (Option<String>, Kind) {
    let stream = Kind::Stream("Live");
    match command {
        Command::Play(o) => {
            let browser_only = o.to.iter().all(|t| t.eq_ignore_ascii_case("browser"));
            let what = match &o.input {
                InputSpec::Path(p) => {
                    let s = p.to_string_lossy();
                    if s.contains("://") {
                        s.into_owned()
                    } else {
                        std::path::Path::new(p)
                            .file_name()
                            .map(|f| f.to_string_lossy().into_owned())
                            .unwrap_or_else(|| s.into_owned())
                    }
                }
                InputSpec::Stdin => "the input on stdin".to_owned(),
                InputSpec::FfmpegArgs(_) => "ffmpeg's input".to_owned(),
                InputSpec::TestPattern => "the test pattern".to_owned(),
            };
            let verb = if browser_only {
                "Previewing"
            } else {
                "Playing"
            };
            let kind = match o.input {
                InputSpec::Path(_) => Kind::Stream("Playing"),
                _ => stream,
            };
            (Some(format!("{verb} {what}")), kind)
        }
        Command::TestPattern(_) => (Some("Test pattern".into()), stream),
        Command::Share(o) => match &o.page {
            Some(p) => (Some(format!("Sharing {}", p.url)), stream),
            None => (Some("Sharing a browser tab or a screen".into()), stream),
        },
        Command::Screen(o) => (
            Some(match &o.target {
                ScreenTarget::Window(w) => format!("Sharing the window “{w}” (your screen)"),
                _ => "Sharing your screen".to_owned(),
            }),
            stream,
        ),
        Command::Tunnel { port, .. } => (Some(format!("Public link to port {port}")), Kind::Tunnel),
        // The game's own title, once it is open.
        Command::Playshare(_) => (None, Kind::Game),
        Command::Discover { .. } => (Some("Looking for receivers".into()), Kind::Once),
        Command::Pair { target, .. } => (Some(format!("Pairing with {target}")), Kind::Once),
        _ => (None, Kind::Once),
    }
}

/// Starts the people's UI for `command`: the renderer, the log handler
/// (warnings) and, on a live terminal, the ticker that redraws the status
/// line. Returns where the session's events go.
pub fn install(command: &Command, no_qr: bool, stop_hint: StopHint, stop: Stop) -> Events {
    let env = |k: &str| std::env::var(k).ok();
    let caps = term::detect(
        &Facts {
            env: &env,
            stderr_tty: std::io::stderr().is_terminal(),
            console_ansi: console_ansi(),
            stop: stop_hint,
            no_qr,
        },
        &term::columns,
    );
    install_with(command, caps, stop)
}

/// A Windows console on stderr takes ANSI sequences (switched on).
#[cfg(windows)]
fn console_ansi() -> bool {
    crate::tty::windows::ansi_stderr()
}

#[cfg(not(windows))]
fn console_ansi() -> bool {
    false
}

fn install_with(command: &Command, caps: Caps, stop: Stop) -> Events {
    let (title, kind) = describe(command);
    let ui = Ui {
        r: Mutex::new(Renderer::new(caps, kind, &help_name(command), title)),
        start: Instant::now(),
    };
    if UI.set(ui).is_err() {
        return Events::none();
    }
    let _ = log::set_logger(Mode::People.level(), |r| {
        with(|ui, now| ui.log(r, now));
    });
    // `play` of a file: its position on the status line.
    let playback = match command {
        Command::Play(o) => o.playback.clone(),
        _ => None,
    };
    if caps.live {
        let _ = std::thread::Builder::new()
            .name("ui-ticker".into())
            .spawn(move || {
                let mut stopping = false;
                loop {
                    let requested = stop.wait(Duration::from_millis(100));
                    with(|ui, now| {
                        if let Some(c) = &playback {
                            ui.set_playback(c.status());
                        }
                        if requested && !stopping {
                            ui.stopping(now);
                        } else {
                            ui.redraw(now);
                        }
                    });
                    stopping |= requested;
                    if stopping {
                        // The stop is shown; the spinner keeps turning.
                        std::thread::sleep(Duration::from_millis(100));
                    }
                }
            });
    }
    Events::to(|e| {
        with(|ui, now| ui.event(&e, now));
    })
}

/// `tvpipe CMD --help`'s CMD.
fn help_name(command: &Command) -> String {
    match command {
        Command::TestPattern(_) => "debug pattern".into(),
        Command::Tunnel { .. } => "debug tunnel".into(),
        Command::Qr { .. } => "debug qr".into(),
        Command::DebugPipeline(_) => "debug pipeline".into(),
        Command::Playshare(_) => "game play".into(),
        c => c.name().to_owned(),
    }
}

/// One event (from the CLI itself: pairing, unpairing).
pub fn event(e: &Event) {
    with(|ui, now| ui.event(e, now));
}

/// The command failed.
pub fn error(e: &ErrorInfo) -> bool {
    with(|ui, now| ui.error(e, now))
}

/// The command is over.
pub fn finish(stopped: bool) {
    with(|ui, now| ui.finish(stopped, now));
}

/// Asks a question on the terminal; [`answered`] when the line came.
/// Without the UI: on stderr as is.
pub fn prompt(question: &str) {
    if !with(|ui, _| ui.prompt(question)) {
        eprint!("{question} ");
        let _ = std::io::stderr().flush();
    }
}

/// The prompt's line came (`newline`: it was cancelled, end the line).
pub fn answered(newline: bool) {
    if !with(|ui, now| ui.answered(newline, now)) && newline {
        eprintln!();
    }
}

/// A second Ctrl-C ends the process now: the status line goes, so the
/// shell's prompt starts on a line of its own. Skipped if the renderer is
/// busy (whatever holds it may be stuck).
pub fn abandon() {
    if let Some(ui) = UI.get() {
        if let Ok(r) = ui.r.try_lock() {
            write(r, ui, |r, _| r.abandon());
        }
    }
}

/// A line was typed on the terminal (its echo moved the cursor).
pub fn typed() {
    with(|ui, _| ui.typed());
}

/// A key on the terminal (a line in line mode): whether to stop now. The
/// first `q` may ask on the status line instead ([`confirm`]); without the
/// people's UI `q` stops at once.
pub fn key(key: confirm::Key) -> bool {
    let mut stop = key == confirm::Key::Quit;
    with(|ui, now| stop = ui.key(key, now));
    stop
}
