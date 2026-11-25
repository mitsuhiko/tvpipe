//! `--to browser` in whole sessions, with a Rust WebSocket client
//! as the page: `preview` of the built-in test pattern, and a browser
//! next to a fake Cast receiver on one timeline, joining late.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use super::tests::{opts, SharedTally, Tallied};
use super::*;
use crate::airplay::MirrorOptions;
use crate::browser::protocol;
use crate::cast::fake_receiver::{FakeReceiver, Options as CastFake};
use crate::codec::json::Value;
use crate::media::clock::SessionClock;
use crate::media::slrw::Kind;
use crate::net::websocket::{self, Message};
use crate::types::{AudioInfo, EncodedFrame, SinkStatus, VideoInfo, VIDEO_CLOCK_RATE};

/// One test at a time: they share the stop flag.
static SERIAL: Mutex<()> = Mutex::new(());
static STOP: std::sync::LazyLock<crate::util::stop::Stop> =
    std::sync::LazyLock::new(crate::util::stop::Stop::new);

fn never() -> Ctx {
    Ctx::new()
}

/// Tests never take the fixed port.
fn any_port() -> BrowserOptions {
    BrowserOptions {
        port: Some(0),
        ..BrowserOptions::default()
    }
}

fn no_io() -> GameIo {
    GameIo {
        stdin: Box::new(std::io::empty()),
        stdout: Box::new(std::io::sink()),
        approve: Box::new(|_, _| false),
    }
}

/// What the fake page got.
#[derive(Default, Debug)]
struct PageLog {
    config: Option<Value>,
    /// `(kind, pts_us, keyframe, payload length)` in arrival order.
    records: Vec<(Kind, u64, bool, usize)>,
    first_record: Option<Instant>,
    connected: Option<Instant>,
    end: Option<String>,
}

/// A page reading everything until tvpipe closes; `video` counts the
/// video records so far.
fn spawn_page(ws_url: String, video: Arc<AtomicUsize>) -> JoinHandle<PageLog> {
    std::thread::spawn(move || {
        let mut log = PageLog::default();
        let (mut rx, _tx) = websocket::connect(
            &ws_url,
            Duration::from_secs(10),
            websocket::Limits::default(),
        )
        .unwrap();
        log.connected = Some(Instant::now());
        rx.with_stream(|s| s.set_read_timeout(Some(Duration::from_secs(30))))
            .unwrap();
        loop {
            match rx.read_message() {
                Ok(Message::Text(t)) => {
                    let v = Value::parse(&t).unwrap();
                    match v.get("type").and_then(Value::as_str) {
                        Some("config") => log.config = Some(v),
                        Some("end") => {
                            log.end = v.get("reason").and_then(Value::as_str).map(Into::into)
                        }
                        _ => {}
                    }
                }
                Ok(Message::Binary(b)) => {
                    let p = protocol::parse_record(&b).unwrap();
                    log.first_record.get_or_insert_with(Instant::now);
                    let key = p.kind == Kind::H264 && p.payload[0] & 1 != 0;
                    if p.kind == Kind::H264 {
                        video.fetch_add(1, Ordering::SeqCst);
                    }
                    log.records.push((p.kind, p.pts_us, key, p.payload.len()));
                }
                Ok(Message::Close(_)) | Err(_) => return log,
            }
        }
    })
}

/// Logs `(pts, instant)` of the video a sink accepted, read from the
/// session clock it was given.
struct Logged {
    inner: Box<dyn Sink>,
    clock: Option<SessionClock>,
    log: Arc<Mutex<Vec<(u64, Instant)>>>,
}

impl Sink for Logged {
    fn name(&self) -> &str {
        self.inner.name()
    }
    fn capabilities(&self) -> &Capabilities {
        self.inner.capabilities()
    }
    fn set_clock(&mut self, clock: SessionClock) {
        self.clock = Some(clock.clone());
        self.inner.set_clock(clock)
    }
    fn start(&mut self, v: &VideoInfo, a: Option<&AudioInfo>) -> Result<()> {
        self.inner.start(v, a)
    }
    fn push(&mut self, f: &EncodedFrame) -> Result<SinkStatus> {
        let r = self.inner.push(f);
        if f.track == TrackKind::Video && matches!(r, Ok(SinkStatus::Accepted)) {
            let at = self
                .clock
                .as_ref()
                .unwrap()
                .instant_for(f.pts, VIDEO_CLOCK_RATE);
            self.log.lock().unwrap().push((f.pts, at.unwrap()));
        }
        r
    }
    fn wants_keyframe(&self) -> bool {
        self.inner.wants_keyframe()
    }
    fn stop(&mut self) -> Result<()> {
        self.inner.stop()
    }
}

/// Sets the stop flag once `cond` holds (or after `limit`).
fn stop_when(limit: Duration, cond: impl Fn() -> bool + Send + 'static) -> JoinHandle<bool> {
    std::thread::spawn(move || {
        let t0 = Instant::now();
        let ok = loop {
            if cond() {
                break true;
            }
            if t0.elapsed() > limit {
                break false;
            }
            std::thread::sleep(Duration::from_millis(10));
        };
        STOP.request();
        ok
    })
}

#[test]
fn preview_plays_the_test_pattern_in_a_page() {
    let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    STOP.clear();
    let video = Arc::new(AtomicUsize::new(0));
    let page = Mutex::new(None);
    let connect = |t: &Target, _: &CastOptions, _: &MirrorOptions| -> Result<Box<dyn Sink>> {
        let Target::Browser(o) = t else {
            panic!("{t:?}")
        };
        let sink = BrowserSink::bind(o, &never())?;
        *page.lock().unwrap() = Some((spawn_page(sink.ws_url(), video.clone()), *o.clone()));
        Ok(Box::new(sink))
    };
    let v = video.clone();
    let stopper = stop_when(Duration::from_secs(60), move || {
        v.load(Ordering::SeqCst) >= 20
    });
    // What `tvpipe preview --encoder builtin --size 320x180` parses to.
    let o = PlayOptions {
        to: vec!["browser".into()],
        browser: any_port(),
        size: Some(Size {
            width: 320,
            height: 180,
        }),
        encoder: Encoder::Builtin,
        ..opts()
    };
    play_with(o, no_io(), &connect, &Ctx::from(STOP.clone())).unwrap();
    assert!(stopper.join().unwrap(), "the page got too little video");
    let (page, popts) = page.lock().unwrap().take().unwrap();
    let log = page.join().unwrap();
    assert_eq!(popts.latency_ms, BROWSER_LATENCY_MS);
    assert!(popts.audio);

    let cfg = log.config.expect("config");
    assert_eq!(
        cfg.get("latency").unwrap().as_u32(),
        Some(BROWSER_LATENCY_MS)
    );
    let v = cfg.get("video").unwrap();
    assert_eq!(v.get("width").unwrap().as_u32(), Some(320));
    assert!(v
        .get("codec")
        .unwrap()
        .as_str()
        .unwrap()
        .starts_with("avc1.42"));
    let a = cfg.get("audio").unwrap();
    assert_eq!(a.get("sampleRate").unwrap().as_u32(), Some(48_000));
    assert_eq!(log.end.as_deref(), Some("the stream ended"));

    let vids: Vec<_> = log.records.iter().filter(|r| r.0 == Kind::H264).collect();
    assert!(vids.len() >= 20, "{}", vids.len());
    assert!(vids[0].2, "the first video record is a keyframe");
    // Delivered pictures stay on the 30 fps timeline even if a frame is skipped.
    let mut consecutive = false;
    for w in vids.windows(2) {
        assert!(w[1].1 > w[0].1, "{:?}", w);
        let delta = w[1].1 - w[0].1;
        let frames = (delta * 30 + 500_000) / 1_000_000;
        assert!(
            frames > 0 && delta.abs_diff(frames * 1_000_000 / 30) < 2_000,
            "{delta}"
        );
        consecutive |= frames == 1;
    }
    assert!(consecutive, "no consecutive frames at 30 fps");
    // PCM in s16le stereo frames.
    let audio: Vec<_> = log.records.iter().filter(|r| r.0 == Kind::Audio).collect();
    assert!(!audio.is_empty());
    assert!(audio.iter().all(|r| r.3 > 0 && r.3 % 4 == 0));
}

#[test]
fn a_late_tab_shares_the_cast_timeline() {
    let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    STOP.clear();
    let rx = FakeReceiver::spawn(CastFake::default());
    let cast_tally = SharedTally::default();
    type Log = Arc<Mutex<Vec<(u64, Instant)>>>;
    let (cast_log, browser_log): (Log, Log) = (Arc::default(), Arc::default());
    let browser = Mutex::new(None);
    let connect = |t: &Target, c: &CastOptions, _: &MirrorOptions| -> Result<Box<dyn Sink>> {
        Ok(match t {
            Target::Cast { addr, name } => Box::new(Logged {
                inner: Tallied::boxed(Box::new(cast::connect(*addr, name, c)?), None, &cast_tally),
                clock: None,
                log: cast_log.clone(),
            }),
            Target::Browser(o) => {
                let sink = BrowserSink::bind(o, &never())?;
                *browser.lock().unwrap() = Some((sink.ws_url(), sink.epoch(), *o.clone()));
                Box::new(Logged {
                    inner: Box::new(sink),
                    clock: None,
                    log: browser_log.clone(),
                })
            }
            Target::AirPlay { .. } => panic!("no AirPlay here"),
        })
    };
    let video = Arc::new(AtomicUsize::new(0));
    let o = PlayOptions {
        to: vec![rx.addr.to_string(), "browser".into()],
        browser: any_port(),
        size: Some(Size {
            width: 320,
            height: 180,
        }),
        encoder: Encoder::Builtin,
        ..opts()
    };
    let (tally, b, v) = (cast_tally.clone(), &browser, video.clone());
    let page = std::thread::scope(|s| {
        // The page connects once the Cast receiver got some video.
        let joiner = s.spawn(move || {
            let t0 = Instant::now();
            while tally.lock().unwrap().video < 15 {
                assert!(t0.elapsed() < Duration::from_secs(60), "no Cast video");
                std::thread::sleep(Duration::from_millis(10));
            }
            let url = b.lock().unwrap().as_ref().unwrap().0.clone();
            let page = spawn_page(url, v.clone());
            let vv = v.clone();
            let stopped = stop_when(Duration::from_secs(60), move || {
                vv.load(Ordering::SeqCst) >= 15
            });
            (page, stopped)
        });
        play_with(o, no_io(), &connect, &Ctx::from(STOP.clone())).unwrap();
        joiner.join().unwrap()
    });
    assert!(page.1.join().unwrap(), "the page got too little video");
    let log = page.0.join().unwrap();
    let (_, epoch, popts) = browser.lock().unwrap().take().unwrap();
    // One budget: the browser shows frames when the Cast TV does.
    assert_eq!(popts.latency_ms, DEFAULT_LATENCY_MS);
    let cfg = log.config.expect("config");
    assert_eq!(
        cfg.get("latency").unwrap().as_u32(),
        Some(DEFAULT_LATENCY_MS)
    );
    let state = rx.shutdown();
    let st = state.lock().unwrap();
    assert!(st.stopped, "STOP not received");

    // The late tab started on a keyframe, soon (the built-in encoder makes
    // one on request, or the next GOP comes within half a second).
    let vids: Vec<_> = log.records.iter().filter(|r| r.0 == Kind::H264).collect();
    assert!(vids[0].2, "the first video record is a keyframe");
    let waited = log.first_record.unwrap() - log.connected.unwrap();
    assert!(waited < Duration::from_secs(5), "{waited:?}");

    // Every record carries the instant the session gave that frame, the
    // same the Cast sink got.
    let browser_log = browser_log.lock().unwrap().clone();
    let cast_log = cast_log.lock().unwrap().clone();
    assert_eq!(browser_log.len(), vids.len());
    let us = |t: Instant| t.saturating_duration_since(epoch).as_micros() as u64;
    let mut common = 0;
    for ((pts, at), rec) in browser_log.iter().zip(&vids) {
        assert_eq!(rec.1, us(*at), "pts {pts}");
        if let Some((_, c)) = cast_log.iter().find(|(p, _)| p == pts) {
            assert_eq!(at, c, "pts {pts}");
            common += 1;
        }
    }
    assert!(common >= 10, "{common} frames in common");
}

// ---------------------------------------------------------------------------
// Real browsers (opt-in, `--ignored`)
//
// TVPIPE_TEST_CHROME=/path/to/chrome cargo test --release chrome_player -- --ignored --nocapture
// TVPIPE_TEST_SAFARI=1 cargo test --release safari_player -- --ignored --nocapture
// TVPIPE_TEST_FIREFOX=.../Firefox.app/Contents/MacOS/firefox \
//   TVPIPE_TEST_GECKODRIVER=.../geckodriver cargo test --release firefox_player -- --ignored --nocapture
//
// `preview` of the built-in test pattern (or TVPIPE_TEST_PLAYER_INPUT, a
// file through ffmpeg or passthrough) in the real player page for
// TVPIPE_TEST_BROWSER_SECS (default 6): frames drawn, no decoder errors,
// audio scheduled, the measured delay near the target.
// TVPIPE_TEST_PLAYER_SHOT=PATH (Chrome): a screenshot with the statistics
// (the page's clock next to the pattern's burned-in clock).

pub(super) fn browser_secs() -> u64 {
    std::env::var("TVPIPE_TEST_BROWSER_SECS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(6)
}

/// Runs `preview` while `drive(url)` works a browser; the session stops
/// when `drive` returns.
fn preview_in_browser(drive: impl FnOnce(String) + Send + 'static) {
    let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    STOP.clear();
    if std::env::var("TVPIPE_TEST_BROWSER_DEBUG").is_ok() {
        crate::log::set_level(crate::log::Level::Debug);
    }
    let drive = Mutex::new(Some(drive));
    let driver = Mutex::new(None);
    let connect = |t: &Target, _: &CastOptions, _: &MirrorOptions| -> Result<Box<dyn Sink>> {
        let Target::Browser(o) = t else {
            panic!("{t:?}")
        };
        let sink = BrowserSink::bind(o, &never())?;
        let url = sink.url().to_owned();
        let drive = drive.lock().unwrap().take().unwrap();
        *driver.lock().unwrap() = Some(std::thread::spawn(move || {
            let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| drive(url)));
            STOP.request();
            r
        }));
        Ok(Box::new(sink))
    };
    let input = std::env::var_os("TVPIPE_TEST_PLAYER_INPUT");
    let o = PlayOptions {
        to: vec!["browser".into()],
        browser: any_port(),
        encoder: if input.is_some() {
            Encoder::Auto
        } else {
            Encoder::Builtin
        },
        looped: input.is_some(),
        input: input.map_or(InputSpec::TestPattern, InputSpec::Path),
        latency_ms: std::env::var("TVPIPE_TEST_PLAYER_LATENCY")
            .ok()
            .and_then(|s| s.parse().ok()),
        ..opts()
    };
    let r = play_with(o, no_io(), &connect, &Ctx::from(STOP.clone()));
    let drove = driver.lock().unwrap().take().map(|h| h.join());
    if let Some(Ok(Err(panic))) = drove {
        std::panic::resume_unwind(panic);
    }
    r.unwrap();
}

/// Watches the page for the test's duration and checks what it did.
pub(super) fn watch_player(eval: &mut dyn FnMut(&str) -> Value) {
    let t0 = Instant::now();
    let deadline = t0 + Duration::from_secs(20);
    while eval("return !!(window.tvpipePlayer && tvpipePlayer.config)") != Value::Bool(true) {
        assert!(Instant::now() < deadline, "the page got no config");
        std::thread::sleep(Duration::from_millis(100));
    }
    let secs = browser_secs();
    let mut last = Value::Null;
    let mut delays = Vec::new();
    let t1 = Instant::now();
    while t1.elapsed() < Duration::from_secs(secs) {
        std::thread::sleep(Duration::from_millis(1000));
        let s = eval("return JSON.stringify(tvpipePlayer.summary())");
        eprintln!("page: {}", s.as_str().unwrap_or("?"));
        last = Value::parse(s.as_str().unwrap_or("null")).unwrap_or(Value::Null);
        if let Some(d) = last.get("delayMs").and_then(Value::as_f64) {
            delays.push(d);
        }
    }
    let log = eval("return tvpipePlayer.log.join('\\n')");
    eprintln!("page log:\n{}", log.as_str().unwrap_or(""));
    let n = |k: &str| last.get(k).and_then(Value::as_f64).unwrap_or(-1.0);
    assert!(n("drawn") >= (secs * 20) as f64, "{last}");
    assert_eq!(n("decodeErrors"), 0.0, "{last}");
    assert!(n("audioChunks") > 0.0, "no audio played: {last}");
    let target = n("targetMs");
    // After start-up the frames are shown on time.
    let settled: Vec<f64> = delays.iter().skip(2).copied().collect();
    let avg = settled.iter().sum::<f64>() / settled.len().max(1) as f64;
    eprintln!("delay from the capture instant: avg {avg:.1} ms (target {target} ms)");
    assert!(
        (avg - target).abs() < 40.0,
        "delay {avg:.1} ms, target {target}"
    );
}

#[test]
#[ignore]
fn chrome_player() {
    let Ok(bin) = std::env::var("TVPIPE_TEST_CHROME") else {
        eprintln!("TVPIPE_TEST_CHROME not set");
        return;
    };
    preview_in_browser(move |url| {
        let mut chrome = super::browser_tests::chrome(&bin, &format!("{url}&stats=1"));
        watch_player(&mut |s| chrome.eval(s));
        if let Ok(path) = std::env::var("TVPIPE_TEST_PLAYER_SHOT") {
            let r = chrome.call(
                "Page.captureScreenshot",
                Value::object().with("format", "png"),
            );
            let data = r.get("data").and_then(Value::as_str).unwrap();
            std::fs::write(&path, crate::net::base64::decode(data).unwrap()).unwrap();
            eprintln!("wrote {path}");
        }
    });
}

#[test]
#[ignore]
fn safari_player() {
    if std::env::var("TVPIPE_TEST_SAFARI").is_err() {
        eprintln!("TVPIPE_TEST_SAFARI not set");
        return;
    }
    preview_in_browser(move |url| {
        let wd = super::browser_tests::WebDriver::start();
        wd.call(
            "POST",
            "/url",
            Some(&Value::object().with("url", format!("{url}&stats=1"))),
        );
        watch_player(&mut |s| wd.eval(s));
    });
}

/// Firefox over geckodriver (W3C WebDriver), headless, with a fresh
/// profile and autoplay allowed.
struct Gecko {
    port: u16,
    session: String,
    child: std::process::Child,
}

impl Gecko {
    fn start(firefox: &str, driver: &str) -> Gecko {
        use super::browser_tests::webdriver_call;
        let port = std::net::TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let child = std::process::Command::new(driver)
            .args(["--port", &port.to_string()])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("geckodriver");
        let deadline = Instant::now() + Duration::from_secs(10);
        while std::net::TcpStream::connect(("127.0.0.1", port)).is_err() {
            assert!(Instant::now() < deadline, "geckodriver did not start");
            std::thread::sleep(Duration::from_millis(50));
        }
        let mut args = Vec::new();
        if std::env::var("TVPIPE_TEST_FIREFOX_HEADED").is_err() {
            args.push("-headless");
        }
        let options = Value::object()
            .with("binary", firefox)
            .with("args", Value::array(args))
            .with(
                "prefs",
                Value::object()
                    .with("media.autoplay.default", 0)
                    .with("media.autoplay.blocking_policy", 0),
            );
        let caps = Value::object().with(
            "capabilities",
            Value::object().with(
                "alwaysMatch",
                Value::object()
                    .with("browserName", "firefox")
                    .with("moz:firefoxOptions", options),
            ),
        );
        let v = webdriver_call(port, "POST", "/session", Some(&caps));
        let session = v
            .get("sessionId")
            .and_then(Value::as_str)
            .unwrap_or_else(|| panic!("no WebDriver session: {v}"))
            .to_owned();
        Gecko {
            port,
            session,
            child,
        }
    }

    fn call(&self, method: &str, path: &str, body: Option<&Value>) -> Value {
        super::browser_tests::webdriver_call(
            self.port,
            method,
            &format!("/session/{}{path}", self.session),
            body,
        )
    }

    fn eval(&self, body: &str) -> Value {
        let script = format!(
            "const done = arguments[arguments.length - 1]; \
             (async () => {{ {body} }})().then(done, e => done('error: ' + e));"
        );
        let b = Value::object()
            .with("script", script)
            .with("args", Value::array(Vec::<Value>::new()));
        self.call("POST", "/execute/async", Some(&b))
    }
}

impl Drop for Gecko {
    fn drop(&mut self) {
        super::browser_tests::webdriver_call(
            self.port,
            "DELETE",
            &format!("/session/{}", self.session),
            None,
        );
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// TVPIPE_TEST_FIREFOX=/path/to/Firefox.app/Contents/MacOS/firefox and
/// TVPIPE_TEST_GECKODRIVER=/path/to/geckodriver.
#[test]
#[ignore]
fn firefox_player() {
    let (Ok(firefox), Ok(driver)) = (
        std::env::var("TVPIPE_TEST_FIREFOX"),
        std::env::var("TVPIPE_TEST_GECKODRIVER"),
    ) else {
        eprintln!("TVPIPE_TEST_FIREFOX / TVPIPE_TEST_GECKODRIVER not set");
        return;
    };
    preview_in_browser(move |url| {
        let ff = Gecko::start(&firefox, &driver);
        ff.call(
            "POST",
            "/url",
            Some(&Value::object().with("url", format!("{url}&stats=1"))),
        );
        watch_player(&mut |s| ff.eval(s));
    });
}

/// A tab stays open while tvpipe stops and starts again with the same
/// port and token: it reconnects and plays the new session.
#[test]
#[ignore]
fn chrome_player_reconnects_to_the_next_run() {
    let Ok(bin) = std::env::var("TVPIPE_TEST_CHROME") else {
        eprintln!("TVPIPE_TEST_CHROME not set");
        return;
    };
    let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let port = std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    let page = PlayerOptions {
        port: Some(port),
        token: Some("0123456789abcdef0123456789abcdef".into()),
        ..PlayerOptions::default()
    };
    let url = format!("http://127.0.0.1:{port}/?t=0123456789abcdef0123456789abcdef");
    let browser: Arc<Mutex<Option<super::browser_tests::Chrome>>> = Arc::default();
    let mut drawn = Vec::new();
    for run in 0..2 {
        STOP.clear();
        let (b, o, u, bin) = (browser.clone(), page.clone(), url.clone(), bin.clone());
        let connect =
            move |_: &Target, _: &CastOptions, _: &MirrorOptions| -> Result<Box<dyn Sink>> {
                let sink = BrowserSink::bind(&o, &never())?;
                let mut g = b.lock().unwrap();
                if g.is_none() {
                    *g = Some(super::browser_tests::chrome(&bin, &u));
                }
                Ok(Box::new(sink))
            };
        let b = browser.clone();
        let watcher = std::thread::spawn(move || {
            let t0 = Instant::now();
            let start = |b: &Arc<Mutex<Option<super::browser_tests::Chrome>>>| {
                b.lock().unwrap().as_mut().map(|c| {
                    c.eval("return window.tvpipePlayer ? tvpipePlayer.stats.drawn : 0")
                        .as_f64()
                        .unwrap_or(0.0)
                })
            };
            let mut first = None;
            let r = loop {
                std::thread::sleep(Duration::from_millis(200));
                let n = start(&b).unwrap_or(0.0);
                let base = *first.get_or_insert(n);
                if n >= base + 30.0 {
                    break n;
                }
                if t0.elapsed() > Duration::from_secs(30) {
                    break -1.0;
                }
            };
            STOP.request();
            r
        });
        let o = PlayOptions {
            to: vec!["browser".into()],
            ..opts()
        };
        play_with(o, no_io(), &connect, &Ctx::from(STOP.clone())).unwrap();
        let n = watcher.join().unwrap();
        eprintln!("run {run}: page drew {n} frames so far");
        assert!(n > 0.0, "run {run}: the page did not play");
        drawn.push(n);
    }
    assert!(drawn[1] > drawn[0]);
    drop(browser.lock().unwrap().take());
}
