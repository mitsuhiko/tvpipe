//! `share` with the real capture script in real browsers (opt-in,
//! `--ignored`): headless Chrome driven over the DevTools protocol,
//! headless Firefox over WebDriver BiDi (tvpipe's own launcher and
//! profile, no geckodriver), and Safari over WebDriver (`safaridriver`).
//! To fake Cast + AirPlay receivers by default, or to a real one.
//!
//! ```sh
//! TVPIPE_TEST_CHROME=/path/to/chrome cargo test --release chrome_share -- --ignored --nocapture
//! TVPIPE_TEST_CHROME=/path/to/chrome cargo test --release chrome_share_adapts_bitrate -- --ignored --nocapture
//! TVPIPE_TEST_FIREFOX=/path/to/firefox cargo test --release firefox_share -- --ignored --nocapture
//! TVPIPE_TEST_SAFARI=1 cargo test --release safari_share -- --ignored --nocapture
//! ```
//!
//! Firefox: `TVPIPE_TEST_FIREFOX_HEADED=1` (a window),
//! `TVPIPE_TEST_FIREFOX_SCREEN=1` (the page's own getDisplayMedia, which
//! shares the primary screen without a picker; on macOS Firefox needs the
//! Screen Recording permission). The manual check with the picker is in
//! docs/share-protocol.md (Browsers).
//!
//! Options (both): `TVPIPE_TEST_BROWSER_SECS` (streaming time, default 6),
//! `_TO=ADDR` (a real receiver), `_SIZE=WxH` (`--size`), `_DUMP=PATH`
//! (what the fake Cast receiver got: H.264 Annex B, and `PATH.aac`),
//! `_DEBUG=1` (debug logs). Chrome: `TVPIPE_TEST_CHROME_VIEWPORT=WxH`
//! (default 1920x1080), `TVPIPE_TEST_CHROME_HEADED=1`,
//! `TVPIPE_TEST_CHROME_NO_MSTP=1` (the `<video>` path of Firefox).
//!
//! Safari cannot be made to accept the screen-sharing picker, so it
//! shares a synthetic stream (an animated 16:10 canvas and a tone)
//! through the same `share()`; everything after getDisplayMedia is the
//! real path. Safari needs Develop > Allow Remote Automation (once).

use std::sync::{Arc, Mutex};

use super::tests::{connect_test, fake_airplay, SharedTally, Tallied};
use super::*;
use crate::airplay::fake_mirror::{Behaviour, FakeMirror};
use crate::airplay::MirrorOptions;
use crate::cast::fake_receiver::{FakeReceiver, Options as CastFake};
use crate::codec::json::Value;
use crate::net::http::{Conn, Request, Version};

type Report = Arc<Mutex<Vec<String>>>;

fn env(name: &str) -> Option<String> {
    std::env::var(format!("TVPIPE_TEST_BROWSER_{name}")).ok()
}

fn secs() -> u64 {
    env("SECS").and_then(|s| s.parse().ok()).unwrap_or(6)
}

/// One browser test at a time (they share the stop flag).
static SERIAL: Mutex<()> = Mutex::new(());
static STOP: std::sync::LazyLock<crate::util::stop::Stop> =
    std::sync::LazyLock::new(crate::util::stop::Stop::new);

/// Runs `share` while `drive(url, report)` works the browser on another
/// thread; the session stops when `drive` returns.
fn share_in_browser(drive: impl FnOnce(String, Report) + Send + 'static) {
    share_in_browser_with(None, drive)
}

/// The AirPlay fake as a network that is 200 ms behind (of 300) for
/// `behind` after its start, then keeps up.
struct Lagging {
    inner: Box<dyn Sink>,
    behind: Duration,
    started: Option<Instant>,
}

impl Sink for Lagging {
    fn name(&self) -> &str {
        self.inner.name()
    }
    fn capabilities(&self) -> &Capabilities {
        self.inner.capabilities()
    }
    fn set_clock(&mut self, clock: crate::media::clock::SessionClock) {
        self.inner.set_clock(clock)
    }
    fn start(
        &mut self,
        v: &crate::types::VideoInfo,
        a: Option<&crate::types::AudioInfo>,
    ) -> Result<()> {
        self.started = Some(Instant::now());
        self.inner.start(v, a)
    }
    fn push(&mut self, f: &crate::types::EncodedFrame) -> Result<crate::types::SinkStatus> {
        self.inner.push(f)
    }
    fn wants_keyframe(&self) -> bool {
        self.inner.wants_keyframe()
    }
    fn backlog(&self) -> Option<crate::types::Backlog> {
        match self.started {
            Some(t) if t.elapsed() < self.behind => Some(crate::types::Backlog {
                delay: Duration::from_millis(200),
                limit: Duration::from_millis(300),
                dropped: 0,
            }),
            _ => self.inner.backlog(),
        }
    }
    fn stop(&mut self) -> Result<()> {
        self.inner.stop()
    }
}

/// [`share_in_browser`], the AirPlay fake [`Lagging`] for `behind`.
fn share_in_browser_with(
    behind: Option<Duration>,
    drive: impl FnOnce(String, Report) + Send + 'static,
) {
    let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    STOP.clear();
    if env("DEBUG").is_some() {
        crate::log::set_level(crate::log::Level::Debug);
    }
    let rx = FakeReceiver::spawn(CastFake::default());
    let fake = FakeMirror::start(Behaviour {
        nack_after: None,
        ..Behaviour::default()
    });
    let (cast_tally, airplay_tally) = (SharedTally::default(), SharedTally::default());
    let connect = |t: &Target, c: &CastOptions, m: &MirrorOptions| -> Result<Box<dyn Sink>> {
        Ok(match t {
            Target::Browser(_) => connect_test(t, c, m)?,
            Target::Cast { addr, name } => {
                Tallied::boxed(Box::new(cast::connect(*addr, name, c)?), None, &cast_tally)
            }
            Target::AirPlay { .. } => {
                let m = MirrorOptions {
                    ptp: false,
                    ..m.clone()
                };
                let sink = fake_airplay(&fake, "fake-airplay", &m)?;
                let sink: Box<dyn Sink> = match behind {
                    Some(behind) => Box::new(Lagging {
                        inner: sink,
                        behind,
                        started: None,
                    }),
                    None => sink,
                };
                Tallied::boxed(sink, None, &airplay_tally)
            }
        })
    };
    let report: Report = Arc::default();
    let driver = Mutex::new(None);
    let drive = Mutex::new(Some(drive));
    let hook = |server: &ShareServer| {
        let url = server.url().to_owned();
        let report = report.clone();
        let drive = drive.lock().unwrap().take().unwrap();
        *driver.lock().unwrap() = Some(std::thread::spawn(move || {
            let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| drive(url, report)));
            STOP.request();
            r
        }));
    };
    let real = env("TO");
    let to = match &real {
        Some(addr) => vec![addr.clone()],
        None => vec![rx.addr.to_string(), format!("airplay:{}", fake.addr)],
    };
    let o = ShareOptions {
        to,
        latency_ms: None,
        size: env("SIZE").map(|s| s.parse().unwrap()),
        fps: None,
        bitrate_kbps: None,
        no_audio: false,
        open: false,
        ..ShareOptions::default()
    };
    let r = if real.is_some() {
        share_with(o, &connect_test, &Ctx::from(STOP.clone()), &hook)
    } else {
        share_with(o, &connect, &Ctx::from(STOP.clone()), &hook)
    };
    let drove = driver.lock().unwrap().take().map(|h| h.join());
    for line in report.lock().unwrap().iter() {
        eprintln!("page: {line}");
    }
    if let Some(Ok(Err(panic))) = drove {
        std::panic::resume_unwind(panic);
    }
    r.unwrap();
    if real.is_some() {
        return;
    }
    let state = rx.shutdown();
    let st = state.lock().unwrap();
    let (tc, ta) = (*cast_tally.lock().unwrap(), *airplay_tally.lock().unwrap());
    eprintln!("cast {tc:?}\nairplay {ta:?}");
    let v = st.streams.iter().find(|s| s.codec == "h264").unwrap();
    for s in &st.streams {
        eprintln!("cast stream {}: {} frames", s.codec, s.frames.len());
    }
    if let Some(path) = env("DUMP") {
        let all: Vec<u8> = v.frames.values().flat_map(|f| f.data.clone()).collect();
        std::fs::write(&path, all).unwrap();
        if let Some(a) = st.streams.iter().find(|s| s.codec == "aac") {
            let adts: Vec<u8> = a.frames.values().flat_map(|f| f.data.clone()).collect();
            std::fs::write(format!("{path}.aac"), adts).unwrap();
        }
        eprintln!("wrote {path}");
    }
    assert!(tc.video > secs() * 10, "{tc:?}");
    assert!(ta.audio > 0 && tc.audio > 0, "{tc:?} {ta:?}");
}

/// The page's letterbox arithmetic must be the Rust one.
fn check_place(eval: &mut dyn FnMut(&str) -> Value) {
    for (sw, sh, dw, dh) in [
        (1920u32, 1200u32, 1920u32, 1080u32),
        (800, 600, 1066, 600),
        (1920, 800, 1440, 1080),
        (333, 777, 1920, 1080),
        (1919, 1201, 1280, 720),
        (1, 99999, 2, 2),
    ] {
        let js = eval(&format!(
            "return JSON.stringify(tvpipeCapture.place({sw}, {sh}, {dw}, {dh}))"
        ));
        let r = crate::browser::layout::place((sw, sh), (dw, dh));
        let rust = format!(
            r#"{{"x":{},"y":{},"width":{},"height":{}}}"#,
            r.x, r.y, r.width, r.height
        );
        assert_eq!(js.as_str(), Some(rust.as_str()), "{sw}x{sh} in {dw}x{dh}");
    }
}

/// The page's timing (capture.js `L.pacer`, `L.captureClock`, `L.audioClock`),
/// known answers worked out by hand.
fn check_timing(eval: &mut dyn FnMut(&str) -> Value) {
    // 25 fps: slots 40 ms apart, an eighth of each offset followed. On
    // time; 1 ms late; 10.1 ms early (the slot stays, the grid moves
    // 1.27 ms earlier); 18 ms early (0.45 slots: skipped); after a gap
    // (two slots on); early but forced (the next slot).
    let js = eval(
        "const p = tvpipeCapture.pacer(40000); return JSON.stringify([p(1000000), p(1041000), \
         p(1070000), p(1100859), p(1200000), p(1210000, true)])",
    );
    assert_eq!(
        js.as_str(),
        Some("[1000000,1040000,1080125,null,1198859.375,1239001.953125]")
    );
    // The first delay (100 ms) is the offset; longer ones creep it up
    // 2 µs; a shorter one takes over; a timestamp going back, or none,
    // is the arrival time and starts over; a second's jump starts over.
    let js = eval(
        "const c = tvpipeCapture.captureClock(); return JSON.stringify([c(5000, 105000), \
         c(38000, 140000), c(71000, 171500), c(104000, 203000), c(104000, 240000), \
         c(137000, 236000), c(undefined, 250000), c(170000, 1500000), c(203000, 1533500), \
         c(236000, 2800000)])",
    );
    assert_eq!(
        js.as_str(),
        Some("[105000,138002,171004,203000,240000,236000,250000,1500000,1533002,2800000]")
    );
    // 10 ms chunks at 48 kHz: on time; 25 ms late (keeps its count);
    // 2 ms early (the count moves earlier); 2 s late (a gap: starts over).
    let js = eval(
        "const a = tvpipeCapture.audioClock(48000); return JSON.stringify([a(480, 1010000), \
         a(480, 1045000), a(480, 1028000), a(480, 3100000), a(480, 3135000)])",
    );
    assert_eq!(
        js.as_str(),
        Some("[1000000,1010000,1018000,3090000,3100000]")
    );
    // Every chunk after the first 30 ms late: the first two-second window
    // had the on-time one, the second moves the count 30 ms later.
    let js = eval(
        "const b = tvpipeCapture.audioClock(48000), out = []; \
         for (let k = 0; k <= 398; k++) { \
         const v = b(480, k ? 1e6 + (k + 1) * 10000 + 30000 : 1010000); \
         if ([0, 1, 396, 397, 398].includes(k)) out.push(v); } return JSON.stringify(out)",
    );
    assert_eq!(
        js.as_str(),
        Some("[1000000,1010000,4960000,5000000,5010000]")
    );
}

/// Streams for a while, sampling the page's stats; asks for a keyframe
/// halfway and checks the encoder made one.
fn watch(eval: &mut dyn FnMut(&str) -> Value, report: &Report) {
    let t0 = Instant::now();
    let total = Duration::from_secs(secs());
    let mut asked = false;
    while t0.elapsed() < total {
        std::thread::sleep(Duration::from_millis(1000));
        if !asked && t0.elapsed() >= total / 2 {
            asked = true;
            eval("tvpipeShare._message({type: 'keyframe'}); return 1");
        }
        let s = eval(
            "return JSON.stringify({stats: window.tvpipeLastStats || null, \
             log: [...document.getElementById('log').children].map(e => e.textContent).join('\\n'), \
             capture: document.getElementById('capture').textContent, \
             plan: document.getElementById('plan').textContent})",
        );
        report
            .lock()
            .unwrap()
            .push(s.as_str().unwrap_or("?").to_owned());
    }
    // Stats come every 2 s: wait for the one covering the request.
    std::thread::sleep(Duration::from_millis(2200));
    let s = eval("return JSON.stringify(window.tvpipeKeyLatency === undefined ? null : window.tvpipeKeyLatency)");
    report
        .lock()
        .unwrap()
        .push(format!("keyframe request answered in {s} ms"));
    assert!(
        s.as_str().is_some_and(|v| v != "null"),
        "the keyframe request was not answered"
    );
}

// ---------------------------------------------------------------------------
// Chrome (DevTools protocol)

/// Chrome for the tests: `browser::launch` with a temporary profile, the
/// tab set up by `browser::headless::attach` (the production code), on
/// `url`. Dropping it quits Chrome and deletes the profile.
pub(super) struct Chrome {
    browser: crate::browser::launch::Browser,
    session: String,
    _profile: crate::browser::launch::Profile,
}

impl Chrome {
    /// A command on the tab's session; its `result`.
    pub(super) fn call(&mut self, method: &str, params: Value) -> Value {
        self.browser
            .cdp()
            .call(Some(&self.session), method, params)
            .unwrap_or_else(|e| panic!("{method}: {e}"))
    }

    /// Evaluates a function body as if the user clicked (transient
    /// activation); awaits a returned promise.
    pub(super) fn eval(&mut self, body: &str) -> Value {
        self.browser
            .cdp()
            .evaluate(
                &self.session,
                &format!("(async () => {{ {body} }})()"),
                true,
                true,
                Duration::from_secs(30),
            )
            .unwrap_or_else(|e| {
                eprintln!("eval {body}: {e}");
                Value::Null
            })
    }

    pub(super) fn profile_dir(&self) -> std::path::PathBuf {
        self._profile.dir().to_path_buf()
    }
}

/// TVPIPE_TEST_CHROME_VIEWPORT=WxH, default 1920x1080.
fn viewport() -> (u32, u32) {
    let v: Size = std::env::var("TVPIPE_TEST_CHROME_VIEWPORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(Size {
            width: 1920,
            height: 1080,
        });
    (v.width, v.height)
}

/// Starts Chrome on `url` (headless unless TVPIPE_TEST_CHROME_HEADED,
/// tab capture auto-accepted).
pub(super) fn chrome(bin: &str, url: &str) -> Chrome {
    let profile = crate::browser::launch::Profile::temporary().unwrap();
    let opts = crate::browser::launch::LaunchOptions {
        bin: bin.into(),
        viewport: viewport(),
        scale: 1.0,
        visible: std::env::var("TVPIPE_TEST_CHROME_HEADED").is_ok(),
        app: None,
        screen: None,
    };
    let browser = crate::browser::launch::Browser::launch(&opts, &profile).unwrap();
    let (_, session) = crate::browser::headless::attach(&browser, opts.viewport).unwrap();
    let mut c = Chrome {
        browser,
        session,
        _profile: profile,
    };
    let r = c.call("Page.navigate", Value::object().with("url", url));
    assert!(r.get("errorText").is_none(), "{url}: {r}");
    c
}

/// The real capture script in headless Chrome: tab capture of the share
/// page itself (an animation and a tone injected).
#[test]
#[ignore]
fn chrome_share_to_fakes() {
    let Ok(bin) = std::env::var("TVPIPE_TEST_CHROME") else {
        eprintln!("TVPIPE_TEST_CHROME not set");
        return;
    };
    share_in_browser(move |url, report| {
        let mut chrome = chrome(&bin, &url);
        let mut eval = |s: &str| chrome.eval(s);
        let deadline = Instant::now() + Duration::from_secs(20);
        while eval("return !!(window.tvpipeShare && window.tvpipeShare.config)")
            != Value::Bool(true)
        {
            assert!(Instant::now() < deadline, "the page got no config");
            std::thread::sleep(Duration::from_millis(100));
        }
        let geo = eval(
            "return JSON.stringify([innerWidth, innerHeight, outerWidth, outerHeight, \
             devicePixelRatio, screen.width, screen.height])",
        );
        report.lock().unwrap().push(format!("geometry: {geo}"));
        let (vw, vh) = viewport();
        let g = geo.as_str().unwrap_or("");
        assert!(
            g.starts_with(&format!("[{vw},{vh},")),
            "viewport is not {vw}x{vh}: {geo}"
        );
        assert!(g.contains(",1,"), "scale: {geo}");
        check_place(&mut eval);
        check_timing(&mut eval);
        // Something that moves and something that sounds.
        eval(
            "const c = document.createElement('canvas'); c.width = 640; c.height = 200; \
             document.body.prepend(c); const g = c.getContext('2d'); let n = 0; \
             (function draw() { g.fillStyle = `hsl(${n % 360},80%,50%)`; g.fillRect(0, 0, 640, 200); \
             g.fillStyle = '#fff'; g.font = '48px sans-serif'; g.fillText(String(n++), 20, 120); \
             requestAnimationFrame(draw); })(); \
             const a = new AudioContext(); const o = a.createOscillator(); o.frequency.value = 440; \
             o.connect(a.destination); o.start(); return a.state;",
        );
        if std::env::var("TVPIPE_TEST_CHROME_NO_MSTP").is_ok() {
            eval("window.MediaStreamTrackProcessor = undefined; tvpipeShare.opts.worker = false; return 1");
        }
        let r = eval(
            "tvpipeShare.opts.preferCurrentTab = true; tvpipeShare.opts.selfBrowserSurface = 'include'; \
             return tvpipeShare.captureDisplay().then(() => 'ok', e => 'error: ' + e.name + ': ' + e.message)",
        );
        report.lock().unwrap().push(format!("captureDisplay: {r}"));
        watch(&mut eval, &report);
        drop(chrome);
    });
}

/// Adaptive bitrate with Chrome's encoder: while the AirPlay fake is
/// behind, tvpipe lowers the page's target (`bitrate` messages, the
/// encoder reconfigured in place) and the stream goes on; once it keeps
/// up, the target comes back. The page keeps painting random boxes, so
/// the encoder spends about the whole target.
#[test]
#[ignore]
fn chrome_share_adapts_bitrate() {
    let Ok(bin) = std::env::var("TVPIPE_TEST_CHROME") else {
        eprintln!("TVPIPE_TEST_CHROME not set");
        return;
    };
    share_in_browser_with(Some(Duration::from_secs(4)), move |url, report| {
        let mut chrome = chrome(&bin, &url);
        let mut eval = |s: &str| chrome.eval(s);
        let deadline = Instant::now() + Duration::from_secs(20);
        while eval("return !!(window.tvpipeShare && window.tvpipeShare.config)")
            != Value::Bool(true)
        {
            assert!(Instant::now() < deadline, "the page got no config");
            std::thread::sleep(Duration::from_millis(100));
        }
        eval(
            "const c = document.createElement('canvas'); c.width = 1280; c.height = 720; \
             document.body.prepend(c); const g = c.getContext('2d'); \
             (function draw() { for (let i = 0; i < 60; i++) { \
             g.fillStyle = `hsl(${Math.random() * 360},70%,${20 + Math.random() * 60}%)`; \
             g.fillRect(Math.random() * 1280, Math.random() * 720, 20 + Math.random() * 120, 20 + Math.random() * 120); } \
             requestAnimationFrame(draw); })(); return 1",
        );
        let r = eval(
            "tvpipeShare.opts.preferCurrentTab = true; tvpipeShare.opts.selfBrowserSurface = 'include'; \
             return tvpipeShare.captureDisplay().then(() => 'ok', e => 'error: ' + e.name + ': ' + e.message)",
        );
        report.lock().unwrap().push(format!("captureDisplay: {r}"));
        // (target, output) kbit/s from the page's stats, every 2 s.
        let mut seen: Vec<(i64, i64)> = Vec::new();
        let t0 = Instant::now();
        let mut last = String::new();
        while t0.elapsed() < Duration::from_secs(22) {
            std::thread::sleep(Duration::from_millis(250));
            let s = eval("return JSON.stringify(window.tvpipeLastStats || null)");
            let s = s.as_str().unwrap_or("null").to_owned();
            if s == last || s == "null" {
                continue;
            }
            last = s.clone();
            let v = Value::parse(&s).unwrap();
            let k = |n: &str| v.get(n).and_then(Value::as_i64).unwrap_or(-1);
            seen.push((k("targetKbps"), k("kbps")));
            report.lock().unwrap().push(format!(
                "{:>5.1} s: target {} kbit/s, output {} kbit/s, plan '{}'",
                t0.elapsed().as_secs_f64(),
                k("targetKbps"),
                k("kbps"),
                eval("return document.getElementById('plan').textContent")
                    .as_str()
                    .unwrap_or("")
            ));
        }
        let log = eval(
            "return [...document.getElementById('log').children].map(e => e.textContent).join('\\n')",
        );
        report
            .lock()
            .unwrap()
            .push(format!("log: {}", log.as_str().unwrap_or("")));
        drop(chrome);
        let first = seen.first().map_or(0, |s| s.0);
        let least = seen.iter().map(|s| s.0).min().unwrap_or(0);
        let end = seen.last().map_or(0, |s| s.0);
        assert!(
            least > 0 && least < first * 3 / 4,
            "never lowered: {seen:?}"
        );
        assert!(end > least, "never came back: {seen:?}");
    });
}

// ---------------------------------------------------------------------------
// Firefox (WebDriver BiDi)

/// Firefox for the tests: `browser::launch` with a temporary profile and
/// tvpipe's preferences, the tab set up by
/// `browser::headless::firefox::attach` (the production code), on `url`.
/// Dropping it quits Firefox and deletes the profile.
pub(super) struct Firefox {
    browser: crate::browser::launch::Browser,
    context: String,
    profile: crate::browser::launch::Profile,
}

impl Firefox {
    /// Evaluates a function body as if the user clicked (transient
    /// activation); awaits a returned promise.
    pub(super) fn eval(&mut self, body: &str) -> Value {
        crate::browser::bidi::evaluate(
            self.browser.cdp(),
            &self.context,
            &format!("(async () => {{ {body} }})()"),
            true,
            true,
            Duration::from_secs(30),
        )
        .unwrap_or_else(|e| {
            eprintln!("eval {body}: {e}");
            Value::Null
        })
    }

    pub(super) fn profile_dir(&self) -> std::path::PathBuf {
        self.profile.dir().to_path_buf()
    }

    /// Opens another tab in front: this one goes to the background.
    pub(super) fn open_tab_in_front(&self, url: &str) {
        let r = self
            .browser
            .cdp()
            .call(
                None,
                "browsingContext.create",
                Value::object()
                    .with("type", "tab")
                    .with("background", false),
            )
            .unwrap();
        let ctx = r.get("context").and_then(Value::as_str).unwrap();
        crate::browser::headless::firefox::navigate(self.browser.cdp(), ctx, url).unwrap();
    }
}

/// TVPIPE_TEST_FIREFOX=/path/to/firefox (the executable, or a macOS
/// `.app`'s `Contents/MacOS/firefox`).
pub(super) fn firefox_bin() -> Option<String> {
    std::env::var("TVPIPE_TEST_FIREFOX").ok()
}

/// Starts Firefox on `url` (headless unless TVPIPE_TEST_FIREFOX_HEADED).
pub(super) fn firefox(bin: &str, url: &str, viewport: (u32, u32)) -> Firefox {
    let profile = crate::browser::launch::Profile::temporary().unwrap();
    let opts = crate::browser::launch::LaunchOptions {
        bin: bin.into(),
        viewport,
        scale: 1.0,
        visible: std::env::var("TVPIPE_TEST_FIREFOX_HEADED").is_ok(),
        app: None,
        screen: None,
    };
    assert_eq!(
        opts.engine(),
        crate::browser::launch::Engine::Firefox,
        "{bin} is not Firefox"
    );
    let browser = crate::browser::launch::Browser::launch(&opts, &profile).unwrap();
    let context = crate::browser::headless::firefox::attach(&browser, viewport).unwrap();
    crate::browser::headless::firefox::navigate(browser.cdp(), &context, url).unwrap();
    Firefox {
        browser,
        context,
        profile,
    }
}

/// The real capture script and share page in Firefox: the page's own
/// tab captured (getUserMedia's `browser` source and its sound,
/// `audioCapture`: what `share URL` uses) and shared through the page's
/// engine (`<video>` frames, Firefox's H.264 encoder, the padding, the
/// audio worklet, keyframe requests). TVPIPE_TEST_FIREFOX_SCREEN=1
/// shares with the page's real getDisplayMedia instead, which tvpipe's
/// preferences answer without the picker: the primary screen.
#[test]
#[ignore]
fn firefox_share_to_fakes() {
    let Some(bin) = firefox_bin() else {
        eprintln!("TVPIPE_TEST_FIREFOX not set");
        return;
    };
    share_in_browser(move |url, report| {
        // 16:10 into the receivers' 16:9: the padding.
        let mut ff = firefox(&bin, &url, (1280, 800));
        let mut eval = |s: &str| ff.eval(s);
        let deadline = Instant::now() + Duration::from_secs(20);
        while eval("return !!(window.tvpipeShare && window.tvpipeShare.config)")
            != Value::Bool(true)
        {
            assert!(Instant::now() < deadline, "the page got no config");
            std::thread::sleep(Duration::from_millis(100));
        }
        let f = eval("return JSON.stringify(tvpipeCapture.features())");
        report.lock().unwrap().push(format!("features: {f}"));
        let howto = eval("return document.getElementById('howto').hidden ? '' : document.getElementById('howto').innerText");
        report
            .lock()
            .unwrap()
            .push(format!("how-to shown: {howto}"));
        assert!(
            howto.as_str().is_some_and(|h| h.contains("Firefox")),
            "Firefox's how-to is missing: {howto}"
        );
        check_place(&mut eval);
        check_timing(&mut eval);
        eval(
            "const c = document.createElement('canvas'); c.width = 640; c.height = 200; \
             document.body.prepend(c); const g = c.getContext('2d'); let n = 0; \
             (function draw() { g.fillStyle = `hsl(${n % 360},80%,50%)`; g.fillRect(0, 0, 640, 200); \
             g.fillStyle = '#fff'; g.font = '48px sans-serif'; g.fillText(String(n++), 20, 120); \
             requestAnimationFrame(draw); })(); \
             const a = new AudioContext(); const o = a.createOscillator(); o.frequency.value = 440; \
             o.connect(a.destination); o.start(); return a.state;",
        );
        let screen = std::env::var("TVPIPE_TEST_FIREFOX_SCREEN").is_ok();
        let r = eval(&format!(
            "tvpipeShare.opts.preferCurrentTab = {}; \
             return tvpipeShare.captureDisplay().then(() => 'ok', e => 'error: ' + e.name + ': ' + e.message)",
            !screen
        ));
        report.lock().unwrap().push(format!("captureDisplay: {r}"));
        assert_eq!(r.as_str(), Some("ok"), "{r}");
        watch(&mut eval, &report);
        let mode = eval("return window.tvpipeLastStats && window.tvpipeLastStats.mode");
        report.lock().unwrap().push(format!("engine: {mode}"));
        // The share page in a background tab (the user switched to the
        // tab to show) keeps streaming.
        ff.open_tab_in_front("about:blank");
        std::thread::sleep(Duration::from_secs(5));
        let s =
            ff.eval("return JSON.stringify([document.visibilityState, window.tvpipeLastStats])");
        report
            .lock()
            .unwrap()
            .push(format!("in the background: {s}"));
        let v = Value::parse(s.as_str().unwrap_or("null")).unwrap_or(Value::Null);
        assert_eq!(v.at(0).and_then(Value::as_str), Some("hidden"), "{s}");
        let fps = v
            .at(1)
            .and_then(|st| st.get("fps"))
            .and_then(Value::as_f64)
            .unwrap_or(0.0);
        assert!(fps >= 20.0, "{fps} fps in the background: {s}");
        drop(ff);
    });
}

// ---------------------------------------------------------------------------
// Safari (WebDriver)

pub(super) struct WebDriver {
    port: u16,
    session: String,
    child: std::process::Child,
}

pub(super) fn webdriver_call(port: u16, method: &str, path: &str, body: Option<&Value>) -> Value {
    let tcp = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
    tcp.set_read_timeout(Some(Duration::from_secs(60))).unwrap();
    let mut c = Conn::new(tcp);
    let mut req = Request::new(method, path, Version::Http11)
        .header("Host", format!("127.0.0.1:{port}"))
        .header("Connection", "close");
    if let Some(b) = body {
        req = req.body("application/json", b.to_json().into_bytes());
    }
    let resp = c.request(&req).unwrap();
    let v = Value::parse(std::str::from_utf8(&resp.body).unwrap()).unwrap();
    v.get("value").cloned().unwrap_or(Value::Null)
}

impl WebDriver {
    pub(super) fn start() -> WebDriver {
        let port = std::net::TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let child = std::process::Command::new("safaridriver")
            .args(["-p", &port.to_string()])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("safaridriver");
        let deadline = Instant::now() + Duration::from_secs(10);
        while std::net::TcpStream::connect(("127.0.0.1", port)).is_err() {
            assert!(Instant::now() < deadline, "safaridriver did not start");
            std::thread::sleep(Duration::from_millis(50));
        }
        let caps = Value::object().with(
            "capabilities",
            Value::object().with(
                "alwaysMatch",
                Value::object()
                    .with("browserName", "safari")
                    .with("webkit:alwaysAllowAutoplay", true),
            ),
        );
        let v = webdriver_call(port, "POST", "/session", Some(&caps));
        let session = v
            .get("sessionId")
            .and_then(Value::as_str)
            .unwrap_or_else(|| {
                panic!("no WebDriver session (Develop > Allow Remote Automation?): {v}")
            })
            .to_owned();
        WebDriver {
            port,
            session,
            child,
        }
    }

    pub(super) fn call(&self, method: &str, path: &str, body: Option<&Value>) -> Value {
        webdriver_call(
            self.port,
            method,
            &format!("/session/{}{path}", self.session),
            body,
        )
    }

    /// Runs a function body (`return` a value; promises are awaited).
    pub(super) fn eval(&self, body: &str) -> Value {
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

impl Drop for WebDriver {
    fn drop(&mut self) {
        webdriver_call(
            self.port,
            "DELETE",
            &format!("/session/{}", self.session),
            None,
        );
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// The real capture script in Safari, sharing a synthetic 16:10 stream
/// (getDisplayMedia needs a human): the worker engine, Safari's H.264
/// encoder, the padding, the audio worklet, keyframe requests.
#[test]
#[ignore]
fn safari_share_to_fakes() {
    if std::env::var("TVPIPE_TEST_SAFARI").is_err() {
        eprintln!("TVPIPE_TEST_SAFARI not set");
        return;
    }
    share_in_browser(move |url, report| {
        let wd = WebDriver::start();
        wd.call(
            "POST",
            "/url",
            Some(&Value::object().with("url", url.as_str())),
        );
        let mut eval = |s: &str| wd.eval(s);
        let deadline = Instant::now() + Duration::from_secs(20);
        while eval("return !!(window.tvpipeShare && window.tvpipeShare.config)")
            != Value::Bool(true)
        {
            assert!(Instant::now() < deadline, "the page got no config");
            std::thread::sleep(Duration::from_millis(100));
        }
        let f = eval("return JSON.stringify(tvpipeCapture.features())");
        report.lock().unwrap().push(format!("features: {f}"));
        let howto = eval("return document.getElementById('howto').hidden ? '' : document.getElementById('howto').innerText");
        report
            .lock()
            .unwrap()
            .push(format!("how-to shown: {howto}"));
        assert!(
            howto
                .as_str()
                .is_some_and(|h| h.contains("not a single tab")),
            "Safari's how-to is missing: {howto}"
        );
        check_place(&mut eval);
        check_timing(&mut eval);
        let r = eval(
            "const c = document.createElement('canvas'); c.width = 1280; c.height = 800; \
             document.body.prepend(c); const g = c.getContext('2d'); let n = 0; \
             (function draw() { g.fillStyle = `hsl(${n % 360},80%,50%)`; g.fillRect(0, 0, 1280, 800); \
             g.fillStyle = '#fff'; g.font = '96px sans-serif'; g.fillText(String(n++), 40, 200); \
             requestAnimationFrame(draw); })(); \
             const a = new AudioContext({sampleRate: tvpipeShare.config.sampleRate}); await a.resume(); \
             const o = a.createOscillator(); o.frequency.value = 440; \
             const d = a.createMediaStreamDestination(); o.connect(d); o.start(); \
             tvpipeShare.audioCtx = new AudioContext({sampleRate: tvpipeShare.config.sampleRate}); \
             await tvpipeShare.audioCtx.resume(); \
             const s = new MediaStream([...c.captureStream(30).getVideoTracks(), ...d.stream.getAudioTracks()]); \
             return tvpipeShare.share(s).then(() => 'ok', e => 'error: ' + e);",
        );
        report.lock().unwrap().push(format!("share: {r}"));
        watch(&mut eval, &report);
        let mode = eval("return window.tvpipeLastStats && window.tvpipeLastStats.mode");
        report.lock().unwrap().push(format!("engine: {mode}"));
        assert_eq!(
            mode.as_str(),
            Some("worker"),
            "Safari should encode in a worker"
        );
        drop(wd);
    });
}
