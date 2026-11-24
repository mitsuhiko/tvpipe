//! Keys, `q` and the question before stopping: while something is
//! watched or played, the first `q` asks ("Stop streaming? Press q
//! again…"), a second `q` stops, any other key or 5 s keep going.
//! Otherwise `q` stops at once. Ctrl-C never asks. The playback keys
//! (arrows, space: [`Keys`]) leave the question alone. No I/O and no real
//! clock.

use std::time::Duration;

/// How long the question stays before the status line comes back.
pub const TIMEOUT: Duration = Duration::from_secs(5);

/// A key from the terminal (a line in line mode).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Key {
    /// `q` (or `Q`).
    Quit,
    /// ← → ↓ ↑: jump by this many milliseconds (`play` of a file).
    Seek(i64),
    /// Space: pause or resume (`play` of a file).
    Pause,
    /// Anything else.
    Other,
}

/// ←/→ jump this far, ↓/↑ [`BIG_SEEK_MS`] (mpv's and VLC's keys).
pub const SEEK_MS: i64 = 10_000;
pub const BIG_SEEK_MS: i64 = 60_000;

impl Key {
    /// A key that is one byte (not the start of an escape sequence: see
    /// [`Keys`]).
    pub fn from_byte(b: u8) -> Key {
        if b.eq_ignore_ascii_case(&b'q') {
            Key::Quit
        } else if b == b' ' {
            Key::Pause
        } else {
            Key::Other
        }
    }

    pub fn from_line(l: &str) -> Key {
        if l.trim().eq_ignore_ascii_case("q") {
            Key::Quit
        } else {
            Key::Other
        }
    }
}

/// Turns the bytes a terminal sends into keys: arrows come as escape
/// sequences, `ESC [ A`…`D` or `ESC O A`…`D` (ECMA-48 CSI, SS3), with
/// modifiers as parameters (`ESC [ 1 ; 2 C`, ignored); Windows consoles
/// send the same with virtual terminal input on (`crate::tty`). Other
/// sequences are swallowed whole; a lone ESC is [`Key::Other`] once the
/// next byte shows it started nothing.
#[derive(Debug, Default)]
pub struct Keys {
    state: Esc,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
enum Esc {
    #[default]
    None,
    /// After ESC.
    Start,
    /// After `ESC [` (parameters may follow) or `ESC O`.
    Csi,
}

impl Keys {
    /// The keys `b` completes (at most two: a lone ESC and the next key).
    pub fn feed(&mut self, b: u8) -> Vec<Key> {
        match self.state {
            Esc::None if b == 0x1b => {
                self.state = Esc::Start;
                Vec::new()
            }
            Esc::None => vec![Key::from_byte(b)],
            Esc::Start => match b {
                b'[' | b'O' => {
                    self.state = Esc::Csi;
                    Vec::new()
                }
                0x1b => vec![Key::Other],
                _ => {
                    self.state = Esc::None;
                    vec![Key::Other, Key::from_byte(b)]
                }
            },
            // Parameter and intermediate bytes, then the final byte.
            Esc::Csi if (0x20..=0x3f).contains(&b) => Vec::new(),
            Esc::Csi => {
                self.state = Esc::None;
                vec![match b {
                    b'C' => Key::Seek(SEEK_MS),
                    b'D' => Key::Seek(-SEEK_MS),
                    b'A' => Key::Seek(BIG_SEEK_MS),
                    b'B' => Key::Seek(-BIG_SEEK_MS),
                    _ => Key::Other,
                }]
            }
        }
    }
}

/// The question's state.
#[derive(Debug, Default)]
pub struct Confirm {
    /// When the question was asked.
    asked: Option<Duration>,
}

impl Confirm {
    /// A key at `now`; `watched`: something is watched or played. True:
    /// stop now.
    pub fn key(&mut self, key: Key, watched: bool, now: Duration) -> bool {
        self.expire(now);
        match key {
            // Playback keys do their own thing.
            Key::Seek(_) | Key::Pause => false,
            Key::Quit if self.asked.is_some() || !watched => {
                self.asked = None;
                true
            }
            Key::Quit => {
                self.asked = Some(now);
                false
            }
            Key::Other => {
                self.asked = None;
                false
            }
        }
    }

    /// Drops the question after [`TIMEOUT`].
    pub fn expire(&mut self, now: Duration) {
        if self.asked.is_some_and(|t| now.saturating_sub(t) >= TIMEOUT) {
            self.asked = None;
        }
    }

    /// The question is shown.
    pub fn asking(&self) -> bool {
        self.asked.is_some()
    }

    /// Stopping anyway (Ctrl-C, the session ended): no question.
    pub fn stopped(&mut self) {
        self.asked = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(secs: f64) -> Duration {
        Duration::from_secs_f64(secs)
    }

    #[test]
    fn q_stops_at_once_when_nobody_watches() {
        let mut c = Confirm::default();
        assert!(c.key(Key::Quit, false, s(1.0)));
        assert!(!c.asking());
    }

    #[test]
    fn q_asks_and_q_again_stops() {
        let mut c = Confirm::default();
        assert!(!c.key(Key::Quit, true, s(1.0)));
        assert!(c.asking());
        assert!(c.key(Key::Quit, true, s(2.0)));
        assert!(!c.asking());
    }

    #[test]
    fn another_key_keeps_going() {
        let mut c = Confirm::default();
        assert!(!c.key(Key::Quit, true, s(1.0)));
        assert!(!c.key(Key::Other, true, s(1.5)));
        assert!(!c.asking());
        // The next q asks again.
        assert!(!c.key(Key::Quit, true, s(2.0)));
        assert!(c.asking());
        // Keys without a question do nothing.
        let mut c = Confirm::default();
        assert!(!c.key(Key::Other, true, s(1.0)));
        assert!(!c.asking());
    }

    #[test]
    fn the_question_times_out() {
        let mut c = Confirm::default();
        assert!(!c.key(Key::Quit, true, s(1.0)));
        c.expire(s(5.9));
        assert!(c.asking());
        c.expire(s(6.0));
        assert!(!c.asking());
        // A q after the timeout asks again instead of stopping.
        let mut c = Confirm::default();
        assert!(!c.key(Key::Quit, true, s(1.0)));
        assert!(!c.key(Key::Quit, true, s(7.0)));
        assert!(c.asking());
    }

    #[test]
    fn ctrl_c_ends_the_question() {
        let mut c = Confirm::default();
        assert!(!c.key(Key::Quit, true, s(1.0)));
        c.stopped();
        assert!(!c.asking());
    }

    #[test]
    fn keys_and_lines() {
        assert_eq!(Key::from_byte(b'q'), Key::Quit);
        assert_eq!(Key::from_byte(b'Q'), Key::Quit);
        assert_eq!(Key::from_byte(b'x'), Key::Other);
        assert_eq!(Key::from_byte(0x1b), Key::Other);
        assert_eq!(Key::from_line(" q "), Key::Quit);
        assert_eq!(Key::from_line("quit"), Key::Other);
        assert_eq!(Key::from_line(""), Key::Other);
        assert_eq!(Key::from_byte(b' '), Key::Pause);
    }

    fn feed(bytes: &[u8]) -> Vec<Key> {
        let mut k = Keys::default();
        bytes.iter().flat_map(|&b| k.feed(b)).collect()
    }

    #[test]
    fn escape_sequences() {
        use Key::*;
        // xterm's normal and application cursor keys.
        assert_eq!(
            feed(b"\x1b[C\x1b[D\x1bOA\x1bOB"),
            [Seek(10_000), Seek(-10_000), Seek(60_000), Seek(-60_000)]
        );
        // With modifiers; other sequences (Home, F5, Delete) are one key.
        assert_eq!(
            feed(b"\x1b[1;2C\x1b[H\x1b[15~\x1b[3~q"),
            [Seek(10_000), Other, Other, Other, Quit]
        );
        // A lone ESC, then keys; ESC ESC.
        assert_eq!(
            feed(b"\x1bq \x1b\x1b[D"),
            [Other, Quit, Pause, Other, Seek(-10_000)]
        );
        assert_eq!(feed(b"\x1b"), []);
    }

    #[test]
    fn playback_keys_leave_the_question() {
        let mut c = Confirm::default();
        assert!(!c.key(Key::Quit, true, s(1.0)));
        assert!(!c.key(Key::Seek(10_000), true, s(1.5)));
        assert!(!c.key(Key::Pause, true, s(1.6)));
        assert!(c.asking());
        assert!(c.key(Key::Quit, true, s(2.0)));
        // Without a question they do nothing here either.
        let mut c = Confirm::default();
        assert!(!c.key(Key::Pause, false, s(1.0)));
        assert!(!c.asking());
    }
}
