//! Single keys on a terminal: stdin switched to non-canonical, no-echo
//! input, so `q` needs no Enter and arrows arrive as they are typed.
//!
//! On Unix through the `stty` program (`stty -icanon -echo min 1 time 0`,
//! std::process with stdin inherited), not OS calls (AGENTS.md:
//! platform-neutral code). Windows consoles have no stty: there the
//! console mode does it ([`windows`], one of the files with platform
//! code, ARCHITECTURE.md), and an MSYS terminal (whose stdin is a pipe,
//! not a console) gets stty again. Where neither works, [`enter`] fails
//! and input stays line by line (`q` + Enter).
//!
//! The terminal gets its old state back (`stty` with what `stty -g`
//! printed, or the console mode as it was) on every way out: [`restore`] when `main` returns (normal end,
//! errors, `q`, the first Ctrl-C), on a panic (a hook), and before a
//! second Ctrl-C ends the process (main, through
//! `tvpipe::signals::before_forced_exit`);
//! [`Cooked`] lends the terminal back in its old state to a prompt
//! that reads a line.

use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;

#[cfg(windows)]
pub mod windows;

/// The terminal's state before [`enter`].
#[derive(Debug, Clone, PartialEq, Eq)]
enum Saved {
    /// What `stty -g` printed.
    Stty(String),
    /// A Windows console's input mode.
    #[cfg(windows)]
    Console(u32),
}

impl Saved {
    /// Puts the terminal back in this state.
    fn apply(&self) {
        match self {
            Saved::Stty(s) => {
                let _ = stty(&[s]);
            }
            #[cfg(windows)]
            Saved::Console(m) => {
                windows::set_input_mode(*m);
            }
        }
    }

    /// Single keys again (after a [`Cooked`] prompt).
    fn keys(&self) -> bool {
        match self {
            Saved::Stty(_) => stty(&KEYS).is_some(),
            #[cfg(windows)]
            Saved::Console(m) => windows::set_input_mode(windows::keys_mode(*m)),
        }
    }
}

static SAVED: OnceLock<Saved> = OnceLock::new();
/// Single keys are on now.
static ON: AtomicBool = AtomicBool::new(false);
/// [`restore`] ran: never single keys again.
static DONE: AtomicBool = AtomicBool::new(false);

const KEYS: [&str; 6] = ["-icanon", "-echo", "min", "1", "time", "0"];

/// Runs `stty ARGS` on stdin; its stdout if it succeeded.
fn stty(args: &[&str]) -> Option<String> {
    let out = Command::new("stty")
        .args(args)
        .stdin(Stdio::inherit())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).trim().to_owned())
}

/// A Windows console on stdin switched to single keys.
#[cfg(windows)]
fn enter_console() -> Option<Saved> {
    let before = windows::input_mode()?;
    windows::set_input_mode(windows::keys_mode(before)).then_some(Saved::Console(before))
}

#[cfg(not(windows))]
fn enter_console() -> Option<Saved> {
    None
}

/// The terminal switched to single keys by stty.
fn enter_stty() -> Option<Saved> {
    let before = stty(&["-g"]).filter(|s| !s.is_empty())?;
    if stty(&KEYS).is_none() {
        let _ = stty(&[&before]);
        return None;
    }
    // A stty that succeeds without changing the terminal (an MSYS stty on
    // a Windows console) leaves it line by line.
    if stty(&["-g"]).is_none_or(|after| after == before) {
        let _ = stty(&[&before]);
        return None;
    }
    Some(Saved::Stty(before))
}

/// Switches stdin (a terminal; the caller checks) to single keys without
/// echo. False if that is not possible here: input stays line by line.
pub fn enter() -> bool {
    if DONE.load(Ordering::SeqCst) || SAVED.get().is_some() {
        return ON.load(Ordering::SeqCst);
    }
    let Some(saved) = enter_console().or_else(enter_stty) else {
        return false;
    };
    if let Err(saved) = SAVED.set(saved) {
        saved.apply();
        return false;
    }
    ON.store(true, Ordering::SeqCst);
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        restore();
        previous(info);
    }));
    true
}

/// Single keys are on (not while a [`Cooked`] prompt reads a line).
pub fn keys() -> bool {
    ON.load(Ordering::SeqCst)
}

/// Gives the terminal its old state back, for good. Idempotent; does
/// nothing if [`enter`] never succeeded.
pub fn restore() {
    DONE.store(true, Ordering::SeqCst);
    if ON.swap(false, Ordering::SeqCst) {
        if let Some(saved) = SAVED.get() {
            saved.apply();
        }
    }
}

/// Restores the terminal when dropped (at the end of `main`).
pub struct Guard;

impl Drop for Guard {
    fn drop(&mut self) {
        restore();
    }
}

/// The terminal in its old state (lines, echo) while this lives, for a
/// prompt that reads a line; single keys again afterwards.
pub struct Cooked(bool);

impl Cooked {
    pub fn new() -> Cooked {
        let was = ON.swap(false, Ordering::SeqCst);
        if was {
            if let Some(saved) = SAVED.get() {
                saved.apply();
            }
        }
        Cooked(was)
    }
}

impl Drop for Cooked {
    fn drop(&mut self) {
        if self.0 && !DONE.load(Ordering::SeqCst) && SAVED.get().is_some_and(Saved::keys) {
            ON.store(true, Ordering::SeqCst);
        }
    }
}

/// Echo is off for a [`NoEcho`] prompt; what the terminal had before.
static HIDDEN: std::sync::Mutex<Option<Saved>> = std::sync::Mutex::new(None);

/// Gives the terminal its echo back after a [`NoEcho`], once; whether it
/// was off.
fn show() -> bool {
    let saved = HIDDEN.lock().unwrap_or_else(|e| e.into_inner()).take();
    match saved {
        Some(saved) => {
            saved.apply();
            true
        }
        None => false,
    }
}

/// Echo off for a line; what to put back.
#[cfg(windows)]
fn hide_console() -> Option<Saved> {
    let before = windows::input_mode()?;
    windows::set_input_mode(windows::no_echo_mode(before)).then_some(Saved::Console(before))
}

#[cfg(not(windows))]
fn hide_console() -> Option<Saved> {
    None
}

fn hide_stty() -> Option<Saved> {
    let before = stty(&["-g"]).filter(|s| !s.is_empty())?;
    stty(&["-echo"]).map(|_| Saved::Stty(before))
}

/// No echo while this lives, for a password prompt that reads a line
/// (inside a [`Cooked`]). Where neither the console nor stty can do it
/// the typing stays visible. Ctrl-C while it is off gives the echo back
/// before the usual: the process exits (130) unless a session catches
/// Ctrl-C to stop.
pub struct NoEcho {
    /// The echo is off.
    pub hidden: bool,
}

impl NoEcho {
    pub fn new() -> NoEcho {
        static WATCH: std::sync::Once = std::sync::Once::new();
        WATCH.call_once(|| {
            tvpipe::signals::on_signal(|| {
                if show() {
                    eprintln!();
                }
                // Without a session's handler Ctrl-C would have ended the
                // process; installing ours must not change that.
                if !crate::interrupt::linked() {
                    std::process::exit(130);
                }
            });
        });
        let hidden = match hide_console().or_else(hide_stty) {
            Some(before) => {
                *HIDDEN.lock().unwrap_or_else(|e| e.into_inner()) = Some(before);
                true
            }
            None => false,
        };
        NoEcho { hidden }
    }
}

impl Drop for NoEcho {
    fn drop(&mut self) {
        show();
    }
}
