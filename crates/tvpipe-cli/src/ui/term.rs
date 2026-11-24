//! What the terminal can do: colours, in-place updates, its width.
//!
//! Detected from the environment (std): a terminal on stderr, `TERM`,
//! `NO_COLOR`, `CLICOLOR`/`CLICOLOR_FORCE`, `FORCE_COLOR` and, for Windows
//! terminals that understand ANSI without saying so in `TERM`,
//! `WT_SESSION` (Windows Terminal), `ConEmuANSI=ON` and `ANSICON`; and a
//! Windows console that took virtual terminal processing
//! (`crate::tty::windows`). The width comes from `COLUMNS`, else the
//! Windows console's window, else `tput cols`, else 80.

/// How a person stops the command, for the hint on the status line.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StopHint {
    /// `q` (stdin is a terminal and not the input, in single-key mode:
    /// `crate::tty`).
    Key,
    /// `q` + Enter (the same, where the terminal stays line by line:
    /// Windows, no `stty`).
    Line,
    /// Only Ctrl-C (stdin is the input or not a terminal).
    CtrlC,
    /// The command ends by itself.
    None,
}

/// What the terminal on stderr does.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Caps {
    /// SGR colours and styles.
    pub color: bool,
    /// A status line redrawn in place (ANSI cursor control on a terminal).
    pub live: bool,
    /// Columns.
    pub width: usize,
    /// QR codes of public links (drawn with explicit colours).
    pub qr: bool,
    /// The hint on the status line.
    pub stop: StopHint,
}

impl Caps {
    /// No terminal: plain lines (pipes, CI, log files).
    #[cfg(test)]
    pub fn plain() -> Caps {
        Caps {
            color: false,
            live: false,
            width: 80,
            qr: false,
            stop: StopHint::None,
        }
    }
}

/// The facts [`detect`] decides from.
pub struct Facts<'a> {
    /// Looks up an environment variable.
    pub env: &'a dyn Fn(&str) -> Option<String>,
    /// stderr is a terminal.
    pub stderr_tty: bool,
    /// stderr is a Windows console that now takes ANSI sequences.
    pub console_ansi: bool,
    /// The person can stop with `q` (see [`StopHint`]).
    pub stop: StopHint,
    /// `--no-qr`.
    pub no_qr: bool,
}

fn set(v: Option<String>) -> bool {
    v.is_some_and(|v| !v.is_empty() && v != "0" && !v.eq_ignore_ascii_case("false"))
}

/// Decides the capabilities; the width is looked up only for a live
/// terminal (`width`).
pub fn detect(f: &Facts<'_>, width: &dyn Fn() -> Option<usize>) -> Caps {
    let env = f.env;
    let term = env("TERM");
    let dumb = term.as_deref() == Some("dumb");
    // ANSI understood: a terminal that says so (any TERM but dumb), or a
    // Windows terminal known to.
    let ansi = f.stderr_tty
        && !dumb
        && (term.as_deref().is_some_and(|t| !t.is_empty())
            || env("WT_SESSION").is_some()
            || env("ConEmuANSI").as_deref() == Some("ON")
            || env("ANSICON").is_some()
            || f.console_ansi);
    let forced = set(env("CLICOLOR_FORCE")) || set(env("FORCE_COLOR"));
    let no_color = env("NO_COLOR").is_some_and(|v| !v.is_empty());
    let clicolor_off = env("CLICOLOR").as_deref() == Some("0");
    let color = forced || (ansi && !no_color && !clicolor_off);
    let qr = ansi && !f.no_qr && !set(env("TVPIPE_NO_QR"));
    let width = if ansi {
        env("COLUMNS")
            .and_then(|c| c.trim().parse::<usize>().ok())
            .filter(|&w| w > 0)
            .or_else(width)
            .unwrap_or(80)
    } else {
        80
    };
    Caps {
        color,
        live: ansi,
        width,
        qr,
        stop: f.stop,
    }
}

/// The terminal's columns: the Windows console's window, else `tput
/// cols`.
pub fn columns() -> Option<usize> {
    #[cfg(windows)]
    if let Some(w) = crate::tty::windows::columns() {
        return Some(w);
    }
    tput_cols()
}

/// `tput cols`, which asks the terminal (std::process only; on systems
/// without tput this is `None`).
pub fn tput_cols() -> Option<usize> {
    let out = std::process::Command::new("tput")
        .arg("cols")
        .stdin(std::process::Stdio::inherit())
        .stderr(std::process::Stdio::inherit())
        .stdout(std::process::Stdio::piped())
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    String::from_utf8_lossy(&out.stdout)
        .trim()
        .parse()
        .ok()
        .filter(|&w: &usize| w > 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn caps(vars: &[(&str, &str)], tty: bool) -> Caps {
        let env = |k: &str| {
            vars.iter()
                .find(|(n, _)| *n == k)
                .map(|(_, v)| (*v).to_owned())
        };
        detect(
            &Facts {
                env: &env,
                stderr_tty: tty,
                console_ansi: false,
                stop: StopHint::Key,
                no_qr: false,
            },
            &|| Some(132),
        )
    }

    #[test]
    fn colours_and_live_updates() {
        let c = caps(&[("TERM", "xterm-256color")], true);
        assert!(c.color && c.live && c.qr);
        assert_eq!(c.width, 132);
        // Not a terminal: plain, unless colour is forced.
        let c = caps(&[("TERM", "xterm")], false);
        assert!(!c.color && !c.live && !c.qr);
        assert_eq!(c.width, 80);
        assert!(caps(&[("TERM", "xterm"), ("CLICOLOR_FORCE", "1")], false).color);
        assert!(caps(&[("FORCE_COLOR", "3")], false).color);
        assert!(!caps(&[("TERM", "xterm"), ("FORCE_COLOR", "0")], false).color);
        // NO_COLOR keeps the status line, not the colours.
        let c = caps(&[("TERM", "xterm"), ("NO_COLOR", "1")], true);
        assert!(!c.color && c.live);
        assert!(!caps(&[("TERM", "xterm"), ("CLICOLOR", "0")], true).color);
        // TERM=dumb: nothing.
        let c = caps(&[("TERM", "dumb")], true);
        assert!(!c.color && !c.live && !c.qr);
        // Windows terminals without TERM.
        assert!(caps(&[("WT_SESSION", "x")], true).live);
        assert!(caps(&[("ConEmuANSI", "ON")], true).live);
        assert!(caps(&[("ANSICON", "1")], true).live);
        assert!(!caps(&[], true).live);
        let env = |_: &str| None;
        let console = Facts {
            env: &env,
            stderr_tty: true,
            console_ansi: true,
            stop: StopHint::Key,
            no_qr: false,
        };
        assert!(detect(&console, &|| None).live);
        // COLUMNS wins over tput.
        assert_eq!(
            caps(&[("TERM", "xterm"), ("COLUMNS", "50")], true).width,
            50
        );
        assert_eq!(
            caps(&[("TERM", "xterm"), ("COLUMNS", "x")], true).width,
            132
        );
        assert!(!caps(&[("TERM", "xterm"), ("TVPIPE_NO_QR", "1")], true).qr);
    }
}
