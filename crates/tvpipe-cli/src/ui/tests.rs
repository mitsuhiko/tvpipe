//! Snapshots of what people see: scripted event sequences through the
//! renderer, on a live terminal (replayed by a small terminal emulator to
//! the screen that stays) and without one, with and without colours, at
//! odd widths. `UPDATE_SNAPSHOTS=1 cargo test -p tvpipe-cli ui::` rewrites
//! `src/ui/snapshots/`.

use std::time::Duration;

use tvpipe::__cli::events::{Event, Progress, Step};

use super::confirm::Key as K;
use super::render::{Kind, Renderer};
use super::term::{Caps, StopHint};

/// One scripted input, at a time in milliseconds.
enum In {
    Event(Event),
    /// A JSON event (the event structs are not constructible here).
    Json(&'static str),
    /// A `stats` event: elapsed ms, video frames, video bytes.
    Stats(u64, u64, u64),
    Warn(&'static str),
    Typed,
    Stopping,
    Prompt(&'static str),
    /// The terminal's echo of what the person types.
    Echo(&'static str),
    Answered,
    Error(&'static str),
    Finish(bool),
    /// The ticker: the status line redrawn.
    Tick,
    /// A key on the terminal, and whether it must stop the session.
    Key(K, bool),
    /// Where a `play` that seeks is: position and length in seconds,
    /// paused.
    Playback(u64, Option<u64>, bool),
    /// Marks the output here, for [`shots`].
    Shot,
}

const SHOT: &str = "\0shot\0";

use In::*;

fn p(p: Progress) -> In {
    Event(Event::Progress(p))
}

fn run(caps: Caps, kind: Kind, title: Option<&str>, script: &[(u64, In)]) -> String {
    let mut r = Renderer::new(caps, kind, "debug pattern", title.map(str::to_owned));
    let mut out = String::new();
    for (ms, input) in script {
        let now = Duration::from_millis(*ms);
        out.push_str(&r.take());
        match input {
            Event(e) => r.event(e, now),
            Json(j) => r.event(&Event::from_json(j).unwrap(), now),
            Stats(elapsed, frames, bytes) => {
                let mut e = Event::from_json(&format!(
                    r#"{{"type":"stats","elapsed_ms":{elapsed},"video_frames":{frames},"audio_frames":0,"receivers":[]}}"#
                ))
                .unwrap();
                if let Event::Stats(s) = &mut e {
                    s.video_bytes = *bytes;
                }
                r.event(&e, now);
            }
            Warn(m) => {
                let e = Event::from_json(&format!(
                    r#"{{"type":"log","level":"warn","module":"session","message":{}}}"#,
                    json_string(m)
                ))
                .unwrap();
                let Event::Log(rec) = e else { unreachable!() };
                r.log(&rec, now);
            }
            Typed => {
                // What the person typed, echoed: "q", Enter.
                r.typed();
                out.push_str(&r.take());
                out.push_str("q\n");
            }
            Stopping => r.stopping(now),
            Prompt(q) => r.prompt(q),
            Echo(t) => out.push_str(t),
            Answered => r.answered(false, now),
            Error(j) => {
                let Event::Error(info) = Event::from_json(j).unwrap() else {
                    unreachable!()
                };
                r.error(&info, now);
            }
            Finish(stopped) => r.finish(*stopped, now),
            Tick => r.redraw(now),
            Playback(at, length, paused) => {
                let mut st = tvpipe::PlaybackStatus::default();
                st.seekable = true;
                st.position = Duration::from_secs(*at);
                st.duration = length.map(Duration::from_secs);
                st.paused = *paused;
                r.set_playback(st);
                r.redraw(now);
            }
            Key(k, stop) => assert_eq!(r.key(*k, now), *stop, "{k:?} at {ms} ms"),
            Shot => {
                out.push_str(&r.take());
                out.push_str(SHOT);
            }
        }
    }
    out.push_str(&r.take());
    out
}

fn json_string(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}

/// Replays terminal output: text, `\r`, `\n`, erase line, cursor up,
/// autowrap on and off; other escape sequences are dropped. Returns the
/// screen's lines and the cursor's row.
fn screen(bytes: &str, width: usize) -> (Vec<String>, usize) {
    let width = width.max(1);
    let mut rows: Vec<Vec<char>> = vec![Vec::new()];
    let (mut r, mut c) = (0usize, 0usize);
    let mut autowrap = true;
    let mut chars = bytes.chars().peekable();
    while let Some(ch) = chars.next() {
        match ch {
            '\x1b' => {
                let mut seq = String::new();
                if chars.peek() == Some(&'[') {
                    chars.next();
                }
                for x in chars.by_ref() {
                    seq.push(x);
                    if x.is_ascii_alphabetic() {
                        break;
                    }
                }
                match seq.as_str() {
                    "2K" => rows[r].clear(),
                    "?7l" => autowrap = false,
                    "?7h" => autowrap = true,
                    s if s.ends_with('A') => {
                        let n = s[..s.len() - 1].parse().unwrap_or(1);
                        r = r.saturating_sub(n);
                    }
                    _ => {}
                }
            }
            '\r' => c = 0,
            '\n' => {
                r += 1;
                c = 0;
                if rows.len() <= r {
                    rows.push(Vec::new());
                }
            }
            ch => {
                if c >= width && autowrap {
                    r += 1;
                    c = 0;
                    if rows.len() <= r {
                        rows.push(Vec::new());
                    }
                }
                if c < width {
                    let row = &mut rows[r];
                    while row.len() < c {
                        row.push(' ');
                    }
                    if c < row.len() {
                        row[c] = ch;
                    } else {
                        row.push(ch);
                    }
                }
                c += 1;
            }
        }
    }
    let lines = rows
        .iter()
        .map(|row| row.iter().collect::<String>().trim_end().to_owned())
        .collect();
    (lines, r)
}

fn shown(bytes: &str, width: usize) -> String {
    let (lines, _) = screen(bytes, width);
    let mut s = lines.join("\n");
    while s.ends_with('\n') {
        s.pop();
    }
    s + "\n"
}

/// The screen at each [`Shot`] and at the end, separated by `---`.
fn shots(raw: &str, width: usize) -> String {
    let mut all = Vec::new();
    for (i, _) in raw.match_indices(SHOT) {
        all.push(shown(&raw[..i].replace(SHOT, ""), width));
    }
    all.push(shown(&raw.replace(SHOT, ""), width));
    all.join("---\n")
}

/// Escape sequences made visible.
fn escaped(bytes: &str) -> String {
    bytes.replace('\x1b', "␛").replace('\r', "␍")
}

fn snapshot(name: &str, have: &str) {
    let path = format!("{}/src/ui/snapshots/{name}.txt", env!("CARGO_MANIFEST_DIR"));
    if std::env::var_os("UPDATE_SNAPSHOTS").is_some() {
        std::fs::create_dir_all(format!("{}/src/ui/snapshots", env!("CARGO_MANIFEST_DIR")))
            .unwrap();
        std::fs::write(&path, have).unwrap();
        return;
    }
    let want = std::fs::read_to_string(&path).unwrap_or_default();
    assert!(
        want == have,
        "{name} differs from {path} (UPDATE_SNAPSHOTS=1 rewrites it):\n{have}"
    );
}

fn live(width: usize, color: bool) -> Caps {
    Caps {
        color,
        live: true,
        width,
        qr: false,
        stop: StopHint::Key,
    }
}

const PLAYER: &str = r#"{"type":"player","name":"browser","url":"http://127.0.0.1:61868/?t=ee7d3e605e59c1314f0ba31148737fac"}"#;
const TUNNEL: &str = r#"{"type":"tunnel","page":"player","name":"browser","provider":"cloudflare","url":"https://galleries-courtesy-incredible-priced.trycloudflare.com/?t=05fc5f84727fa4b88dd604050721dd5a&delay=300"}"#;
const STARTED_4K: &str = r#"{"type":"started","route":"browser","video":{"codec":"h264","width":3840,"height":2160,"fps":30},"audio":[{"codec":"pcm-s16le","sample_rate":48000,"channels":2}],"latency_ms":100}"#;

/// `tvpipe screen --to browser --tunnel`.
fn screen_tunnel() -> Vec<(u64, In)> {
    vec![
        (0, Warn("screen: the browser tab plays the shared sound again (an echo): mute it, or use --no-audio")),
        (1, p(Progress::Begin(Step::Browser))),
        (300, Tick),
        (714, p(Progress::Done(Step::Browser, Some("Chrome/157.0.8103.79".into())))),
        (715, p(Progress::Begin(Step::Capture))),
        (2251, Json(r#"{"type":"capture","surface":"monitor","label":"screen:5:0","width":6016,"height":3384,"audio":true}"#)),
        (2252, Json(PLAYER)),
        (2252, p(Progress::Begin(Step::Tunnel))),
        (4500, Tick),
        (7600, Json(TUNNEL)),
        (7601, Json(r#"{"type":"receiver","name":"browser","protocol":"browser","state":"connected"}"#)),
        (7601, Json(r#"{"type":"connected","receivers":["browser"]}"#)),
        (7700, Json(STARTED_4K)),
        (8700, Stats(1000, 30, 1_500_000)),
        (9700, Stats(2000, 60, 3_050_000)),
        (9800, Json(r#"{"type":"viewer","name":"browser","tab":1,"state":"connected","public":true}"#)),
        (199_700, Stats(192_000, 5760, 300_000_000)),
        (199_800, Tick),
    ]
}

fn screen_tunnel_end() -> Vec<(u64, In)> {
    let mut s = screen_tunnel();
    s.extend([
        (200_000, Typed),
        (200_001, Stopping),
        (
            200_400,
            Json(r#"{"type":"end","reason":"stopped","receivers":[]}"#),
        ),
        (200_500, Finish(true)),
    ]);
    s
}

const SCREEN: Option<&str> = Some("Sharing your screen");

#[test]
fn screen_with_a_public_link() {
    let raw = run(
        live(100, false),
        Kind::Stream("Live"),
        SCREEN,
        &screen_tunnel(),
    );
    snapshot("screen-tunnel.live", &shown(&raw, 100));
    let raw = run(
        live(100, false),
        Kind::Stream("Live"),
        SCREEN,
        &screen_tunnel_end(),
    );
    snapshot("screen-tunnel.end", &shown(&raw, 100));
    let raw = run(
        live(100, true),
        Kind::Stream("Live"),
        SCREEN,
        &screen_tunnel_end(),
    );
    snapshot("screen-tunnel.color", &escaped(&raw));
    let raw = run(
        Caps::plain(),
        Kind::Stream("Live"),
        SCREEN,
        &screen_tunnel_end(),
    );
    assert!(!raw.contains('\x1b'), "{raw}");
    snapshot("screen-tunnel.plain", &raw);
    let raw = run(
        live(40, false),
        Kind::Stream("Live"),
        SCREEN,
        &screen_tunnel(),
    );
    snapshot("screen-tunnel.narrow", &shown(&raw, 40));
}

#[test]
fn who_opened_the_public_link() {
    let raw = run(
        Caps::plain(),
        Kind::Stream("Live"),
        SCREEN,
        &[
            (0, Json(PLAYER)),
            (1, Json(TUNNEL)),
            (
                2,
                Json(
                    r#"{"type":"viewer","name":"browser","tab":1,"state":"connected","public":true,"address":"203.0.113.9","country":"DE","browser":"Safari 18 on iPhone"}"#,
                ),
            ),
            (
                3,
                Json(
                    r#"{"type":"viewer","name":"browser","tab":2,"state":"connected","public":true,"address":"198.51.100.7"}"#,
                ),
            ),
            (
                4,
                Json(
                    r#"{"type":"viewer","name":"browser","tab":3,"state":"connected","public":true}"#,
                ),
            ),
            (
                5,
                Json(
                    r#"{"type":"viewer","name":"browser","tab":4,"state":"connected","browser":"Chrome 131 on macOS"}"#,
                ),
            ),
        ],
    );
    assert!(
        raw.contains("• 203.0.113.9 in DE (Safari 18 on iPhone) opened the public link\n"),
        "{raw}"
    );
    assert!(
        raw.contains("• 198.51.100.7 opened the public link\n"),
        "{raw}"
    );
    assert!(raw.contains("• Someone opened the public link\n"), "{raw}");
    // A tab on this computer is no news.
    assert_eq!(raw.matches("opened the public link").count(), 3, "{raw}");
}

#[test]
fn the_qr_code_is_framed() {
    let caps = Caps {
        qr: true,
        ..live(100, false)
    };
    let raw = run(caps, Kind::Stream("Live"), SCREEN, &screen_tunnel_end());
    snapshot("screen-tunnel.qr", &shown(&raw, 100));
}

#[test]
fn a_game_shows_the_short_link_and_the_tunnels_only_as_a_qr_code() {
    let caps = Caps {
        qr: true,
        ..Caps::plain()
    };
    let raw = run(caps, Kind::Game, None, &game());
    assert!(raw.contains("Phones scan this"), "{raw}");
    assert!(!raw.contains("opentunnel.xyz"), "{raw}");
    assert!(raw.contains("Carried by OpenTunnel"), "{raw}");
    assert!(
        raw.contains(
            "  Phones join here\n  https://tvpipe.party/BCDF\n  Or scan the QR code above"
        ),
        "{raw}"
    );
    // No short link to come: the tunnel's link as before.
    let mut script = game();
    script.retain(|(_, i)| !matches!(i, Event(Event::Progress(Progress::ShortLink { .. }))));
    for (_, i) in &mut script {
        if let Event(Event::Progress(Progress::GameLink { short, .. })) = i {
            *short = false;
        }
    }
    let raw = run(Caps::plain(), Kind::Game, None, &script);
    assert!(
        raw.contains("  Phones join here\n  https://85abd01b7ad97e1d.baqlo7vg7agz.opentunnel.xyz/"),
        "{raw}"
    );
}

/// `tvpipe play movie.mkv --to "Living Room TV"`, to the end.
fn play_file() -> Vec<(u64, In)> {
    vec![
        (0, p(Progress::Begin(Step::Find("Living Room TV".into())))),
        (200, Tick),
        (
            900,
            p(Progress::Done(Step::Find("Living Room TV".into()), None)),
        ),
        (
            900,
            p(Progress::Begin(Step::Connect("Living Room TV".into()))),
        ),
        (
            1800,
            Json(
                r#"{"type":"receiver","name":"Living Room TV","protocol":"cast","state":"connected"}"#,
            ),
        ),
        (
            1800,
            Json(r#"{"type":"connected","receivers":["Living Room TV"]}"#),
        ),
        (
            1900,
            Json(
                r#"{"type":"started","route":"passthrough","video":{"codec":"h264","width":1920,"height":1080,"fps":23.976},"audio":[],"latency_ms":300}"#,
            ),
        ),
        (2900, Stats(1000, 24, 600_000)),
        (3900, Stats(2000, 48, 1_250_000)),
        (3901, Tick),
        (2_532_000, Stats(2_530_000, 60_660, 1_600_000_000)),
        (
            2_532_100,
            Json(r#"{"type":"end","reason":"eof","receivers":[]}"#),
        ),
        (2_532_200, Finish(false)),
    ]
}

#[test]
fn a_file_to_a_tv() {
    let script = play_file();
    let raw = run(
        live(100, false),
        Kind::Stream("Playing"),
        Some("Playing movie.mkv"),
        &script[..9],
    );
    snapshot("play.live", &shown(&raw, 100));
    let raw = run(
        live(100, false),
        Kind::Stream("Playing"),
        Some("Playing movie.mkv"),
        &script,
    );
    snapshot("play.end", &shown(&raw, 100));
    let raw = run(
        Caps::plain(),
        Kind::Stream("Playing"),
        Some("Playing movie.mkv"),
        &script,
    );
    snapshot("play.plain", &raw);
}

#[test]
fn a_file_that_seeks_and_pauses() {
    let mut script = play_file();
    script.truncate(7);
    script.extend([
        (2000, Playback(0, Some(6312), false)),
        (2100, Shot),
        (5000, Key(K::Seek(60_000), false)),
        (5300, Playback(62, Some(6312), false)),
        (5400, Shot),
        (6000, Key(K::Pause, false)),
        (6100, Playback(62, Some(6312), true)),
        (6200, Shot),
        // The question stays while seeking.
        (7000, Key(K::Quit, false)),
        (7100, Key(K::Seek(-10_000), false)),
        (7200, Playback(52, Some(6312), true)),
        (7300, Shot),
        (7400, Key(K::Other, false)),
        // A URL without a length.
        (8000, Playback(4000, None, false)),
    ]);
    let raw = run(
        live(100, false),
        Kind::Stream("Playing"),
        Some("Playing movie.mkv"),
        &script,
    );
    snapshot("playback.live", &shots(&raw, 100));
    let raw = run(
        live(64, false),
        Kind::Stream("Playing"),
        Some("Playing movie.mkv"),
        &script,
    );
    snapshot("playback.narrow", &shots(&raw, 64));
}

#[test]
fn one_receiver_fails_another_comes_back() {
    let script = vec![
        (
            0,
            p(Progress::Begin(Step::Connect("Living Room TV".into()))),
        ),
        (0, p(Progress::Begin(Step::Connect("Bedroom".into())))),
        (10, Tick),
        (
            1500,
            Json(
                r#"{"type":"receiver","name":"Living Room TV","protocol":"cast","state":"connected"}"#,
            ),
        ),
        (
            3000,
            Json(
                r#"{"type":"receiver","name":"Bedroom","protocol":"airplay","state":"failed","error":"airplay: connect 192.168.1.16:7000: connection refused"}"#,
            ),
        ),
        (
            3000,
            Warn("1 of 2 receivers connected; going on without the others"),
        ),
        (
            3000,
            Json(r#"{"type":"connected","receivers":["Living Room TV"]}"#),
        ),
        (3100, Json(STARTED_4K)),
        (
            60_000,
            Json(
                r#"{"type":"receiver","name":"Living Room TV","state":"lost","error":"cast: connection reset"}"#,
            ),
        ),
        (
            62_100,
            Json(r#"{"type":"receiver","name":"Living Room TV","state":"reconnected"}"#),
        ),
        (63_000, Stats(60_000, 1800, 90_000_000)),
        (64_000, Stats(61_000, 1830, 91_500_000)),
        (64_001, Tick),
    ];
    let raw = run(
        live(100, false),
        Kind::Stream("Live"),
        Some("Test pattern"),
        &script,
    );
    snapshot("multi.live", &shown(&raw, 100));
    let raw = run(
        Caps::plain(),
        Kind::Stream("Live"),
        Some("Test pattern"),
        &script,
    );
    snapshot("multi.plain", &raw);
}

#[test]
fn errors_say_what_to_try() {
    let script = vec![
        (0, p(Progress::Begin(Step::Find("Nowhere TV".into())))),
        (500, Tick),
        (
            4014,
            Json(
                r#"{"type":"receiver","name":"Nowhere TV","state":"failed","error":"no receiver named \"Nowhere TV\"","code":"no-receiver"}"#,
            ),
        ),
        (
            4015,
            Error(
                r#"{"type":"error","kind":"not-found","code":"no-receiver","message":"no receiver named \"Nowhere TV\"","device":"Nowhere TV"}"#,
            ),
        ),
    ];
    let raw = run(
        live(80, false),
        Kind::Stream("Live"),
        Some("Test pattern"),
        &script,
    );
    let mut all = shown(&raw, 80);
    for (title, error) in [
        (
            "Playing nosuch.mkv",
            r#"{"type":"error","kind":"not-found","code":"input-not-found","message":"nosuch.mkv: no such file"}"#,
        ),
        (
            "Test pattern",
            r#"{"type":"error","kind":"auth","code":"pairing-required","message":"Livingroom (2): pairing required: run 'tvpipe pair'","device":"Livingroom (2)"}"#,
        ),
        (
            "Test pattern",
            r#"{"type":"error","kind":"usage","message":"--raw-video ...:h264 reads SLRW from stdin (-)"}"#,
        ),
    ] {
        let raw = run(
            live(80, false),
            Kind::Stream("Live"),
            Some(title),
            &[(0, Error(error))],
        );
        all.push_str("---\n");
        all.push_str(&shown(&raw, 80));
    }
    snapshot("errors", &all);
}

#[test]
fn pairing() {
    let script = vec![
        (0, p(Progress::Begin(Step::Find("Livingroom (2)".into())))),
        (10, Tick),
        (
            1200,
            p(Progress::Done(Step::Find("Livingroom (2)".into()), None)),
        ),
        (
            1300,
            Json(
                r#"{"type":"pin-required","name":"Livingroom (2)","address":"192.168.1.34:7000"}"#,
            ),
        ),
        (1300, Prompt("Enter the PIN shown on Livingroom (2):")),
        (5000, Echo("1234\n")),
        (5000, Answered),
        (
            6000,
            Json(r#"{"type":"paired","name":"Livingroom (2)","model":"AppleTV6,2"}"#),
        ),
        (6000, Finish(false)),
    ];
    let raw = run(
        live(80, false),
        Kind::Once,
        Some("Pairing with Livingroom (2)"),
        &script,
    );
    snapshot("pair", &shown(&raw, 80));
}

/// `tvpipe game play games/drawbluff`.
fn game() -> Vec<(u64, In)> {
    vec![
        (0, p(Progress::Begin(Step::Tunnel))),
        (1, Tick),
        (
            2,
            p(Progress::Game {
                title: "Drawbluff".into(),
                local: "http://127.0.0.1:62991/".into(),
                lan: None,
            }),
        ),
        (3, p(Progress::Begin(Step::Window))),
        (
            232,
            p(Progress::GameLink {
                url: "https://85abd01b7ad97e1d.baqlo7vg7agz.opentunnel.xyz/".into(),
                provider: "opentunnel".into(),
                short: true,
            }),
        ),
        (1100, p(Progress::Done(Step::Window, None))),
        (
            1900,
            p(Progress::ShortLink {
                url: "https://tvpipe.party/BCDF".into(),
            }),
        ),
        (30_000, p(Progress::Phones(1))),
        (40_000, p(Progress::Phones(3))),
        (60_000, p(Progress::Casting(vec!["Living Room TV".into()]))),
        // The next game of the run (Other game in the window).
        (
            600_000,
            p(Progress::Game {
                title: "Krakel".into(),
                local: "http://127.0.0.1:62991/".into(),
                lan: None,
            }),
        ),
        (601_000, p(Progress::Casting(vec!["Living Room TV".into()]))),
        (721_000, Tick),
    ]
}

#[test]
fn a_game() {
    let raw = run(live(100, false), Kind::Game, None, &game());
    snapshot("game.live", &shown(&raw, 100));
    let mut script = game();
    script.extend([
        (
            722_000,
            p(Progress::CastFailed(
                "Living Room TV: connection refused".into(),
            )),
        ),
        (723_000, Finish(true)),
    ]);
    let raw = run(Caps::plain(), Kind::Game, None, &script);
    snapshot("game.plain", &raw);
}

/// `tvpipe game play games/`: the window opens on the list first, the
/// game comes after the title line.
#[test]
fn a_game_picked_in_the_window() {
    let mut script = game();
    let at = script
        .iter()
        .position(|(_, i)| matches!(i, Event(Event::Progress(Progress::Game { .. }))))
        .unwrap();
    let (_, picked) = script.remove(at);
    script.insert(5, (1500, picked));
    let raw = run(Caps::plain(), Kind::Game, None, &script);
    assert!(raw.starts_with("tvpipe · Playing a game\n"), "{raw}");
    assert!(raw.contains("• Now playing Drawbluff\n"), "{raw}");
    assert!(raw.contains("• Now playing Krakel\n"), "{raw}");
}

#[test]
fn a_tunnel_and_discovery() {
    let script = vec![
        (0, p(Progress::Begin(Step::Tunnel))),
        (
            5200,
            Json(
                r#"{"type":"tunnel","page":"port","provider":"cloudflare","url":"https://a-b-c.trycloudflare.com/"}"#,
            ),
        ),
        (65_200, Tick),
    ];
    let raw = run(
        live(80, false),
        Kind::Tunnel,
        Some("Public link to port 8080"),
        &script,
    );
    let mut all = shown(&raw, 80);
    let script = vec![(0, p(Progress::Begin(Step::Discover))), (2300, Tick)];
    let raw = run(
        live(80, false),
        Kind::Once,
        Some("Looking for receivers"),
        &script,
    );
    all.push_str("---\n");
    all.push_str(&shown(&raw, 80));
    snapshot("tunnel-discover", &all);
}

#[test]
fn a_typed_line_does_not_leave_a_copy_of_the_status_line() {
    let mut s = screen_tunnel();
    s.extend([(200_000, Typed), (200_100, Tick)]);
    let mut r = Renderer::new(live(100, false), Kind::Stream("Live"), "x", None);
    let mut raw = String::new();
    for (ms, input) in s {
        let now = Duration::from_millis(ms);
        match input {
            Typed => {
                r.typed();
                raw.push_str(&r.take());
                raw.push_str("q\n");
            }
            Tick => r.redraw(now),
            Json(j) => r.event(&Event::from_json(j).unwrap(), now),
            Event(e) => r.event(&e, now),
            _ => {}
        }
        raw.push_str(&r.take());
    }
    let (lines, row) = screen(&raw, 100);
    let live: Vec<&String> = lines.iter().filter(|l| l.starts_with("● Live")).collect();
    assert_eq!(live.len(), 1, "{lines:#?}");
    assert_eq!(lines[row], *live[0]);
}

#[test]
fn no_panics_at_any_width() {
    let scripts = [
        screen_tunnel_end(),
        play_file(),
        game(),
        screen_tunnel_confirm(),
    ];
    for width in 0..200 {
        for color in [false, true] {
            for script in &scripts {
                let caps = Caps {
                    qr: width % 7 == 0,
                    ..live(width, color)
                };
                let raw = run(caps, Kind::Stream("Live"), SCREEN, script);
                // The status line never wraps: autowrap is off and it is
                // cut to the width.
                for frame in raw.split("\x1b[?7l").skip(1) {
                    let line = frame.split("\x1b[?7h").next().unwrap_or("");
                    assert!(
                        super::render::visible(line) <= width.max(2),
                        "{width}: {line:?}"
                    );
                }
            }
        }
    }
}

#[test]
fn wrapping_and_cutting() {
    use super::render::wrap;
    assert_eq!(wrap("a bb ccc", 4), ["a bb", "ccc"]);
    assert_eq!(
        wrap("averyveryverylongword x", 5),
        ["averyveryverylongword", "x"]
    );
    assert_eq!(wrap("", 5), [""]);
    assert_eq!(
        super::render::clock(Duration::from_secs(3 * 3600 + 192)),
        "03:03:12"
    );
    assert_eq!(super::render::quote("TV"), "TV");
    assert_eq!(super::render::quote("Living Room"), "\"Living Room\"");
}

#[test]
fn modes() {
    use super::Mode;
    use tvpipe::log::Level;
    assert_eq!(Mode::pick(false, false, false, None), Mode::People);
    assert_eq!(Mode::pick(true, true, true, Some("info")), Mode::Machine);
    assert_eq!(
        Mode::pick(false, true, false, None),
        Mode::Developer(Level::Debug)
    );
    assert_eq!(
        Mode::pick(false, false, true, None),
        Mode::Developer(Level::Trace)
    );
    assert_eq!(
        Mode::pick(false, false, false, Some("info")),
        Mode::Developer(Level::Info)
    );
    assert_eq!(
        Mode::pick(false, false, false, Some("nonsense")),
        Mode::People
    );
}

/// `q` while someone watches: the question, another key, the question
/// again, its timeout, then q q.
fn screen_tunnel_confirm() -> Vec<(u64, In)> {
    let mut s = screen_tunnel();
    s.extend([
        (200_000, Key(K::Quit, false)),
        (200_100, Tick),
        (200_100, Shot),
        (203_000, Key(K::Other, false)),
        (203_000, Shot),
        (204_000, Key(K::Quit, false)),
        (208_900, Tick),
        (208_900, Shot),
        (209_000, Tick),
        (209_000, Shot),
        (210_000, Key(K::Quit, false)),
        (210_500, Key(K::Quit, true)),
        (210_500, Stopping),
        (210_500, Shot),
        (
            211_000,
            Json(r#"{"type":"end","reason":"stopped","receivers":[]}"#),
        ),
        (211_000, Finish(true)),
    ]);
    s
}

#[test]
fn q_asks_while_someone_watches() {
    let s = screen_tunnel_confirm();
    let raw = run(live(100, false), Kind::Stream("Live"), SCREEN, &s);
    snapshot("confirm.live", &shots(&raw, 100));
    let raw = run(live(100, true), Kind::Stream("Live"), SCREEN, &s);
    snapshot("confirm.color", &escaped(&raw));
    // Narrow: the question gets shorter.
    let raw = run(live(50, false), Kind::Stream("Live"), SCREEN, &s);
    snapshot("confirm.narrow", &shots(&raw, 50));
}

/// Nobody watches yet (or a tunnel): `q` stops at once.
#[test]
fn q_stops_at_once_when_nobody_watches() {
    let mut s: Vec<(u64, In)> = screen_tunnel()
        .into_iter()
        .filter(|(_, i)| !matches!(i, Json(j) if j.contains("\"viewer\"")))
        .collect();
    s.extend([(200_000, Key(K::Quit, true))]);
    run(live(100, false), Kind::Stream("Live"), SCREEN, &s);
    let s = [
        (
            0,
            Json(
                r#"{"type":"tunnel","page":"port","provider":"cloudflare","url":"https://a-b-c.trycloudflare.com/"}"#,
            ),
        ),
        (1000, Key(K::Quit, true)),
    ];
    run(
        live(80, false),
        Kind::Tunnel,
        Some("Public link to port 8080"),
        &s,
    );
    // Without a status line there is nowhere to ask.
    let mut s = screen_tunnel();
    s.push((200_000, Key(K::Quit, true)));
    run(Caps::plain(), Kind::Stream("Live"), SCREEN, &s);
}

/// A file to a TV, in line mode (q + Enter; Windows), and a game.
#[test]
fn the_question_per_command_and_mode() {
    let line = Caps {
        stop: StopHint::Line,
        ..live(100, false)
    };
    let mut s = play_file();
    s.truncate(9);
    s.extend([
        (4000, Tick),
        (4000, Shot),
        (5000, Typed),
        (5000, Key(K::Quit, false)),
        (5000, Shot),
        (6000, Typed),
        (6000, Key(K::Quit, true)),
        (6000, Stopping),
    ]);
    let raw = run(line, Kind::Stream("Playing"), Some("Playing movie.mkv"), &s);
    let mut all = shots(&raw, 100);
    let mut s = game();
    s.extend([
        (722_000, Key(K::Quit, false)),
        (722_000, Shot),
        // Ctrl-C while asking: no question, it stops.
        (723_000, Stopping),
    ]);
    let raw = run(live(100, false), Kind::Game, None, &s);
    all.push_str("===\n");
    all.push_str(&shots(&raw, 100));
    snapshot("confirm.modes", &all);
}
