//! Stop requests from the person at the terminal, so `play` can send
//! STOP/TEARDOWN before it exits (ARCHITECTURE.md, "Session Lifecycle").
//!
//! Ctrl-C and SIGTERM come through the library's `tvpipe::signals` (the
//! `signals` feature; the platform FFI lives there, see ARCHITECTURE.md,
//! "Platform-Specific Code"). [`watch_stdin`] adds a std-only way to stop:
//! `q` on a terminal, a single key where the terminal can be switched to
//! that (`crate::tty`), else `q` + Enter. With single keys, `play` of a
//! file also seeks (arrows) and pauses (space) through
//! [`set_playback`]'s control. While something is watched
//! the first `q` asks on the status line (`ui::confirm`). Lines answer
//! [`ask`] (the `share --tunnel` confirmation), with the terminal back in
//! line mode meanwhile.
//!
//! The library never reads stdin; this module is the CLI's.

use std::io::{IsTerminal, Read};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use tvpipe::__cli::{PlaybackControl, Stop};

use crate::ui::confirm::{Key, Keys};

/// [`link`] installed the handler.
static LINKED: AtomicBool = AtomicBool::new(false);
/// The stdin watcher runs (stdin is a terminal).
static WATCHING: AtomicBool = AtomicBool::new(false);
/// Where the watcher sends the next line that is not `q`, if [`ask`]
/// waits for one.
static ANSWER: Mutex<Option<mpsc::Sender<String>>> = Mutex::new(None);
/// `play` of a file: the arrows seek, space pauses.
static PLAYBACK: OnceLock<PlaybackControl> = OnceLock::new();

/// The keys seek and pause `control` (`play` of a file or URL).
pub fn set_playback(control: PlaybackControl) {
    let _ = PLAYBACK.set(control);
}

/// Installs the Ctrl-C/SIGTERM handler and forwards it to `stop`.
/// Returns false if the platform refused; Ctrl-C then kills the process
/// as usual.
pub fn link(stop: Stop) -> bool {
    let linked = tvpipe::signals::on_signal(move || stop.request());
    LINKED.store(linked, Ordering::SeqCst);
    linked
}

/// Ctrl-C stops a session ([`link`] succeeded).
pub fn linked() -> bool {
    LINKED.load(Ordering::SeqCst)
}

/// Whether the stop came from Ctrl-C/SIGTERM (exit status 130; `q`
/// exits with 0).
pub fn signalled() -> bool {
    tvpipe::signals::requested()
}

/// Prints `question` and waits for a line on the terminal (after
/// [`watch_stdin`]). `None`: stdin is not a terminal, or `cancel` said so
/// first (polled every 100 ms).
pub fn ask(question: &str, cancel: &dyn Fn() -> bool) -> Option<String> {
    if !WATCHING.load(Ordering::SeqCst) {
        return None;
    }
    let (tx, rx) = mpsc::channel();
    // Lines with echo while asking.
    let _cooked = crate::tty::Cooked::new();
    *ANSWER.lock().unwrap_or_else(|e| e.into_inner()) = Some(tx);
    crate::ui::prompt(question);
    let answer = loop {
        if cancel() || signalled() {
            break None;
        }
        match rx.recv_timeout(Duration::from_millis(100)) {
            Ok(l) => break Some(l),
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => break None,
        }
    };
    ANSWER.lock().unwrap_or_else(|e| e.into_inner()).take();
    crate::ui::answered(answer.is_none());
    answer
}

/// Whether stdin is a terminal the person types on, for [`watch_stdin`]
/// (never asked with `--machine`: see there).
pub fn stdin_is_terminal() -> bool {
    crate::machine::router().is_none() && std::io::stdin().is_terminal()
}

/// If stdin is a terminal, reads it on a background thread: `q` (a key,
/// or a line in line mode) stops via `stop`, after the status line's
/// question while something is watched (like ffmpeg's `q`). Does nothing
/// otherwise, so piped or closed stdin never stops a session.
///
/// Never with `--machine`: the router owns stdin then, and on Windows
/// `is_terminal` must not run while its read is pending. Windows
/// serializes synchronous I/O on a file object, and `is_terminal` asks a
/// pipe for its name (`GetFileInformationByHandleEx`, to spot MSYS
/// terminals), which waits until the router's `ReadFile` returns: until
/// the parent writes again, possibly never (the SDK's sessions hung at
/// start on Windows runners).
pub fn watch_stdin(stop: Stop) {
    if !stdin_is_terminal() {
        return;
    }
    let spawned = std::thread::Builder::new()
        .name("stdin-quit".into())
        .spawn(move || {
            let press = |key| {
                match (key, PLAYBACK.get()) {
                    (Key::Seek(ms), Some(c)) => {
                        c.seek_by(ms);
                    }
                    (Key::Pause, Some(c)) => {
                        c.toggle_pause();
                    }
                    _ => {}
                }
                if crate::ui::key(key) {
                    stop.request();
                }
            };
            let mut keys = Keys::default();
            let mut stdin = std::io::stdin().lock();
            let mut buf = [0u8; 64];
            let mut line = Vec::new();
            loop {
                let n = match stdin.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => n,
                    Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(_) => break,
                };
                for &b in &buf[..n] {
                    let asking = ANSWER.lock().unwrap_or_else(|e| e.into_inner()).is_some();
                    if crate::tty::keys() && !asking {
                        line.clear();
                        for key in keys.feed(b) {
                            press(key);
                        }
                    } else if b == b'\n' {
                        // The terminal echoed the line: the status line
                        // moved up.
                        crate::ui::typed();
                        let l = String::from_utf8_lossy(&line).into_owned();
                        line.clear();
                        let tx = ANSWER.lock().unwrap_or_else(|e| e.into_inner()).take();
                        match tx {
                            Some(tx) => {
                                let _ = tx.send(l);
                            }
                            None => press(Key::from_line(&l)),
                        }
                    } else if b != b'\r' {
                        line.push(b);
                    }
                }
            }
            WATCHING.store(false, Ordering::SeqCst);
        });
    if spawned.is_ok() {
        WATCHING.store(true, Ordering::SeqCst);
    }
    if let Err(e) = spawned {
        debug!("cannot watch stdin: {e}");
    }
}
