//! playshare against fake devices and fake pages, over real sockets.

use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use super::backend::{Backend, Cast, Discover, Pair};
use super::bundle::{clean_path, Bundle, Lookup, Manifest};
use super::*;
use crate::codec::json::Value;
use crate::net::websocket::{self, Message, Receiver, Role, Sender, WsUrl};

fn fixture(rel: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/playshare")
        .join(rel)
}

// ---------------------------------------------------------------------
// The manifest and the bundle

#[test]
fn manifest_fields_and_errors() {
    let m = Manifest::parse(
        r#"{"name":"g","pages":{"host":"h.html","tv":"./t.html","phone":"p/i.html"},
            "root":"dist/","players":{"min":3,"max":50},"tv":{"width":1281,"height":720},
            "limits":{"rate":30}}"#,
    )
    .unwrap();
    assert_eq!(m.root, "dist");
    assert_eq!(m.title, "g");
    assert_eq!(m.pages.tv, "t.html");
    assert_eq!(m.pages.launcher, None);
    assert_eq!((m.min_players, m.max_players), (3, 50));
    assert_eq!(m.tv_size, Some((1280, 720)));
    assert!(!m.tv_fixed);
    assert_eq!(m.limits.rate, 30);
    let fixed = Manifest::parse(
        r#"{"name":"g","pages":{"host":"h","tv":"t","phone":"p"},
            "tv":{"width":1280,"height":720,"resolution":"fixed"}}"#,
    )
    .unwrap();
    assert!(fixed.tv_fixed);
    assert_eq!(
        fixed.to_value().get("tv").unwrap().to_json(),
        r#"{"width":1280,"height":720,"resolution":"fixed"}"#
    );
    assert_eq!(m.limits.burst, 50);
    for (bad, says) in [
        ("[]", "object"),
        ("{", "JSON"),
        (r#"{"pages":{}}"#, "\"name\""),
        (r#"{"name":"Big Name","pages":{}}"#, "\"name\""),
        (r#"{"name":"g"}"#, "\"pages\""),
        (
            r#"{"name":"g","pages":{"host":"h","tv":"t"}}"#,
            "pages.phone",
        ),
        (
            r#"{"name":"g","pages":{"host":"../h","tv":"t","phone":"p"}}"#,
            "pages.host",
        ),
        (
            r#"{"name":"g","pages":{"host":"/h","tv":"t","phone":"p"}}"#,
            "pages.host",
        ),
        (
            r#"{"name":"g","root":"..","pages":{"host":"h","tv":"t","phone":"p"}}"#,
            "root",
        ),
        (
            r#"{"name":"g","pages":{"host":"h","tv":"t","phone":"p"},"players":{"min":5,"max":2}}"#,
            "players.min",
        ),
        (
            r#"{"name":"g","tvpipe":"99.0","pages":{"host":"h","tv":"t","phone":"p"}}"#,
            "needs tvpipe 99.0 or newer",
        ),
        (
            r#"{"name":"g","tvpipe":2,"pages":{"host":"h","tv":"t","phone":"p"}}"#,
            "\"tvpipe\" must be a version",
        ),
        (
            r#"{"name":"g","pages":{"host":"h","tv":"t","phone":"p"},"players":{"max":5000}}"#,
            "players.max",
        ),
        (
            r#"{"name":"g","pages":{"host":"h","tv":"t","phone":"p"},"tv":{"width":640}}"#,
            "tv",
        ),
        (
            r#"{"name":"g","pages":{"host":"h","tv":"t","phone":"p"},"limits":{"message":10}}"#,
            "limits.message",
        ),
        (
            r#"{"name":"g","pages":{"host":"h","tv":"t","phone":"p"},"tv":{"resolution":"fixed"}}"#,
            "tv.resolution",
        ),
        (
            r#"{"name":"g","pages":{"host":"h","tv":"t","phone":"p"},"tv":{"width":640,"height":480,"resolution":"4k"}}"#,
            "tv.resolution",
        ),
    ] {
        let e = Manifest::parse(bad).unwrap_err().to_string();
        assert!(e.contains(says), "{bad}: {e}");
    }
}

#[test]
fn clean_paths() {
    assert_eq!(clean_path("a/b.js").as_deref(), Some("a/b.js"));
    assert_eq!(clean_path("./a").as_deref(), Some("a"));
    for bad in [
        "", "/a", "a/../b", "..", "a//b", ".git/x", "a\\b", "a\0", "a/",
    ] {
        assert_eq!(clean_path(bad), None, "{bad:?}");
    }
}

fn check_bundle(b: &Bundle) {
    assert_eq!(b.manifest.name, "test-game");
    assert_eq!(b.manifest.limits.rate, 5);
    match b.get("phone/index.html") {
        Lookup::File(f) => assert!(f.bytes.starts_with(b"<!doctype html>")),
        other => panic!("{other:?}"),
    }
    assert!(matches!(b.get("phone"), Lookup::Dir));
    assert!(matches!(b.get("nope.html"), Lookup::NotFound));
    assert!(matches!(b.get(".hidden"), Lookup::NotFound));
}

#[test]
fn bundle_folder_and_zip() {
    check_bundle(&Bundle::open(&fixture("game")).unwrap());
    check_bundle(&Bundle::open(&fixture("game.zip")).unwrap());
    // As Finder zips a folder: __MACOSX/ and .DS_Store beside it.
    check_bundle(&Bundle::open(&fixture("finder.zip")).unwrap());
    // A missing entry page is an error naming it.
    let dir = scratch("missing-page");
    std::fs::write(
        dir.join("tvpipe.json"),
        r#"{"name":"x","pages":{"host":"h.html","tv":"t.html","phone":"p.html"}}"#,
    )
    .unwrap();
    std::fs::write(dir.join("h.html"), "x").unwrap();
    let e = Bundle::open(&dir).unwrap_err().to_string();
    assert!(e.contains("pages.tv"), "{e}");
    assert!(Bundle::open(&scratch("empty")).is_err());
}

#[cfg(unix)]
#[test]
fn bundle_folder_symlinks_stay_inside() {
    let dir = scratch("symlinks");
    std::fs::write(
        dir.join("tvpipe.json"),
        r#"{"name":"x","pages":{"host":"h.html","tv":"h.html","phone":"h.html"}}"#,
    )
    .unwrap();
    std::fs::write(dir.join("h.html"), "x").unwrap();
    let outside = scratch("outside");
    std::fs::write(outside.join("secret"), "s").unwrap();
    std::os::unix::fs::symlink(outside.join("secret"), dir.join("leak")).unwrap();
    std::os::unix::fs::symlink(dir.join("h.html"), dir.join("alias.html")).unwrap();
    let b = Bundle::open(&dir).unwrap();
    assert!(matches!(b.get("leak"), Lookup::NotFound));
    assert!(matches!(b.get("alias.html"), Lookup::File(_)));
}

fn scratch(name: &str) -> PathBuf {
    let d = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../target/test-tmp/playshare")
        .join(format!("{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

#[test]
fn embedded_files_match_the_directory() {
    let mut on_disk = Vec::new();
    fn list(dir: &Path, prefix: &str, out: &mut Vec<String>) {
        for e in std::fs::read_dir(dir).unwrap() {
            let e = e.unwrap();
            let name = e.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') {
                continue;
            }
            if e.file_type().unwrap().is_dir() {
                list(&e.path(), &format!("{prefix}{name}/"), out);
            } else {
                out.push(format!("{prefix}{name}"));
            }
        }
    }
    list(Path::new(web::SOURCE), "", &mut on_disk);
    on_disk.sort();
    let mut embedded: Vec<String> = web::FILES.iter().map(|f| f.path.to_owned()).collect();
    embedded.sort();
    assert_eq!(on_disk, embedded, "update web::FILES");
}

// ---------------------------------------------------------------------
// Fakes

#[derive(Default)]
pub(crate) struct Log {
    pub casts: Vec<(String, Vec<String>)>,
    /// Pages a running cast was sent to instead.
    pub navigations: Vec<String>,
    pictures: Vec<super::resolution::Picture>,
    stopped: usize,
    pins: Vec<String>,
}

/// Devices, pairing, casts and surfaces that only log.
pub(crate) struct Fake {
    pub log: Arc<Mutex<Log>>,
    pub fail_cast: bool,
}

struct FakeDiscover;
impl Discover for FakeDiscover {
    fn devices(&self) -> Vec<Value> {
        vec![Value::object()
            .with("name", "Living Room")
            .with("kind", "airplay")
            .with("needsPairing", true)]
    }
}

struct FakePair {
    log: Arc<Mutex<Log>>,
}
impl Pair for FakePair {
    fn state(&self) -> Value {
        let l = self.log.lock().unwrap();
        match l.pins.last().map(String::as_str) {
            None => Value::object().with("state", "pin"),
            Some("1234") => Value::object().with("state", "done"),
            Some(_) => Value::object()
                .with("state", "failed")
                .with("error", "wrong PIN"),
        }
    }
    fn submit(&self, pin: &str) -> crate::error::Result<()> {
        self.log.lock().unwrap().pins.push(pin.to_owned());
        Ok(())
    }
    fn cancel(&self) {}
}

struct FakeCast {
    log: Arc<Mutex<Log>>,
    polls: u32,
}
impl Cast for FakeCast {
    fn status(&mut self) -> Value {
        self.polls += 1;
        let state = if self.polls > 1 {
            "streaming"
        } else {
            "starting"
        };
        Value::object().with("state", state).with(
            "receivers",
            Value::array(vec![Value::object()
                .with("name", "Living Room")
                .with("state", "connected")]),
        )
    }
    fn stop(self: Box<Self>) {
        self.log.lock().unwrap().stopped += 1;
    }
    fn navigate(&mut self, url: &str) -> crate::error::Result<()> {
        self.log.lock().unwrap().navigations.push(url.to_owned());
        Ok(())
    }
}

#[derive(Default)]
struct SurfaceLog {
    configs: usize,
    frames: Vec<(Duration, bool)>,
    audio: usize,
    stopped: bool,
}

struct FakeSurface {
    log: Arc<Mutex<SurfaceLog>>,
    key: bool,
    t0: Instant,
}

impl super::backend::SurfaceSink for FakeSurface {
    fn config(&mut self, _data: &[u8], _annex_b: bool) -> crate::error::Result<()> {
        self.log.lock().unwrap().configs += 1;
        Ok(())
    }
    fn video(
        &mut self,
        _au: &[u8],
        pts: Duration,
        key: bool,
        _a: bool,
    ) -> crate::error::Result<bool> {
        let mut log = self.log.lock().unwrap();
        log.frames.push((pts, key));
        // A receiver that wants an IDR after the first frame.
        if log.frames.len() == 1 {
            self.key = true;
        }
        Ok(true)
    }
    fn audio(&mut self, pcm: &[i16], _pts: Duration) -> crate::error::Result<()> {
        self.log.lock().unwrap().audio += pcm.len();
        Ok(())
    }
    fn keyframe_wanted(&mut self) -> bool {
        std::mem::take(&mut self.key)
    }
    fn elapsed(&self) -> Duration {
        self.t0.elapsed()
    }
    fn status(&mut self) -> Value {
        Value::object().with("state", "streaming")
    }
    fn stop(self: Box<Self>) {
        self.log.lock().unwrap().stopped = true;
    }
}

static SURFACE_LOG: std::sync::LazyLock<Arc<Mutex<SurfaceLog>>> =
    std::sync::LazyLock::new(Arc::default);

impl Backend for Fake {
    fn surface(
        &self,
        _to: &[String],
        _spec: super::backend::SurfaceSpec,
    ) -> crate::error::Result<Box<dyn super::backend::SurfaceSink>> {
        Ok(Box::new(FakeSurface {
            log: SURFACE_LOG.clone(),
            key: false,
            t0: Instant::now(),
        }))
    }
    fn discover(&self) -> crate::error::Result<Box<dyn Discover>> {
        Ok(Box::new(FakeDiscover))
    }
    fn pair(&self, _device: &str) -> crate::error::Result<Box<dyn Pair>> {
        Ok(Box::new(FakePair {
            log: self.log.clone(),
        }))
    }
    fn cast(
        &self,
        url: &str,
        to: &[String],
        picture: super::resolution::Picture,
    ) -> crate::error::Result<Box<dyn Cast>> {
        if self.fail_cast {
            return Err(crate::error::Error::closed("no such TV").with_code("not-found"));
        }
        let mut log = self.log.lock().unwrap();
        log.casts.push((url.to_owned(), to.to_vec()));
        log.pictures.push(picture);
        drop(log);
        Ok(Box::new(FakeCast {
            log: self.log.clone(),
            polls: 0,
        }))
    }
}

struct Setup {
    running: Option<Running>,
    hub: Arc<Hub>,
    log: Arc<Mutex<Log>>,
    ticker: Option<std::thread::JoinHandle<()>>,
    stop: Stop,
}

impl Setup {
    fn new(path: &str) -> Setup {
        Setup::with(path, false)
    }

    fn with(path: &str, fail_cast: bool) -> Setup {
        crate::util::timer::raise_resolution();
        let log = Arc::new(Mutex::new(Log::default()));
        let bundle = Bundle::open(&fixture(path)).unwrap();
        let stop = Stop::new();
        let opts = Options {
            tunnel: TunnelChoice::Off,
            ..Options::default()
        };
        let running = Running::start(
            bundle,
            Box::new(Fake {
                log: log.clone(),
                fail_cast,
            }),
            &opts,
            stop.clone(),
        )
        .unwrap();
        let hub = running.hub.clone();
        let (h, s) = (hub.clone(), stop.clone());
        let ticker = std::thread::spawn(move || {
            while !s.wait(Duration::from_millis(20)) {
                h.tick();
            }
        });
        Setup {
            running: Some(running),
            hub,
            log,
            ticker: Some(ticker),
            stop,
        }
    }

    fn local(&self) -> u16 {
        self.hub.ports.get().unwrap().local
    }

    fn public(&self) -> u16 {
        self.hub.ports.get().unwrap().public
    }

    fn end(&mut self) {
        self.stop.request();
        if let Some(t) = self.ticker.take() {
            let _ = t.join();
        }
        if let Some(r) = self.running.take() {
            r.end();
        }
    }
}

impl Drop for Setup {
    fn drop(&mut self) {
        self.end();
    }
}

/// A raw HTTP exchange: the status line, headers and body as text.
fn http(port: u16, raw: &str) -> String {
    let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
    s.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
    s.write_all(raw.as_bytes()).unwrap();
    let mut out = String::new();
    let _ = s.read_to_string(&mut out);
    out
}

fn get(port: u16, path: &str, host: &str, extra: &str) -> String {
    http(
        port,
        &format!("GET {path} HTTP/1.1\r\nHost: {host}\r\n{extra}Connection: close\r\n\r\n"),
    )
}

/// A plain GET on 127.0.0.1 (the raw answer).
pub(crate) fn http_get(port: u16, path: &str) -> String {
    get(port, path, &format!("127.0.0.1:{port}"), "")
}

type Ws = (Receiver<TcpStream, TcpStream>, Sender<TcpStream>);

fn ws(port: u16, path: &str, headers: &[(&str, &str)]) -> crate::error::Result<Ws> {
    let url = WsUrl::parse(&format!("ws://127.0.0.1:{port}{path}"))?;
    let tcp = TcpStream::connect(("127.0.0.1", port)).unwrap();
    tcp.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
    let (tcp, rest) = websocket::client_handshake(tcp, &url, headers)?;
    websocket::pair(tcp, rest, Role::Client, websocket::Limits::default())
}

fn refused(r: crate::error::Result<Ws>) -> crate::error::Error {
    match r {
        Ok(_) => panic!("the WebSocket was accepted"),
        Err(e) => e,
    }
}

fn api(s: &Setup) -> Ws {
    ws(s.local(), &format!("/_tvpipe/api?t={}", s.hub.token), &[]).unwrap()
}

/// The next text message that is JSON (binary ones are returned too).
fn next(rx: &mut Receiver<TcpStream, TcpStream>) -> Message {
    rx.read_message().unwrap()
}

fn next_json(rx: &mut Receiver<TcpStream, TcpStream>) -> Value {
    loop {
        match next(rx) {
            Message::Text(t) => return Value::parse(&t).unwrap(),
            Message::Binary(_) => continue,
            Message::Close(c) => panic!("closed: {c:?}"),
        }
    }
}

/// Calls a method and waits for its reply (events meanwhile are dropped).
fn call(w: &mut Ws, method: &str, params: Value) -> Value {
    static N: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    let n = N.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    w.1.send_text(
        &Value::object()
            .with("t", "call")
            .with("n", n)
            .with("method", method)
            .with("params", params)
            .to_json(),
    )
    .unwrap();
    loop {
        let v = next_json(&mut w.0);
        if v.get("t").and_then(Value::as_str) == Some("reply")
            && v.get("n").and_then(Value::as_u64) == Some(n)
        {
            return v;
        }
    }
}

fn event_of(w: &mut Ws, kind: &str) -> Value {
    loop {
        let v = next_json(&mut w.0);
        if v.get("t").and_then(Value::as_str) == Some("event")
            && v.get("type").and_then(Value::as_str) == Some(kind)
        {
            return v.get("data").cloned().unwrap_or(Value::Null);
        }
    }
}

fn close_code(rx: &mut Receiver<TcpStream, TcpStream>) -> u16 {
    loop {
        match rx.read_message() {
            Ok(Message::Close(c)) => return c.map(|c| c.0).unwrap_or(1005),
            Ok(_) => continue,
            Err(_) => return 1006,
        }
    }
}

// ---------------------------------------------------------------------
// The listeners

#[test]
fn local_listener_rules() {
    let s = Setup::new("game");
    let host = format!("127.0.0.1:{}", s.local());
    // DNS rebinding.
    assert!(get(s.local(), "/host.html", "evil.example:80", "").starts_with("HTTP/1.1 421"));
    // `/` without the cookie, a wrong token, the right one.
    assert!(get(s.local(), "/", &host, "").starts_with("HTTP/1.1 403"));
    // A browser gets a page in tvpipe's look.
    let html = "Accept: text/html,application/xhtml+xml,*/*;q=0.8\r\n";
    let r = get(s.local(), "/", &host, html);
    assert!(r.starts_with("HTTP/1.1 403"), "{r}");
    assert!(r.contains("Content-Type: text/html; charset=utf-8"), "{r}");
    assert!(r.contains("<h1>Open the link tvpipe printed</h1>"), "{r}");
    assert!(r.contains("href=\"/_tvpipe/ui.css\""), "{r}");
    assert!(r.contains("403 Forbidden</span>"), "{r}");
    assert!(get(s.local(), "/_tvpipe/start?t=nope", &host, "").starts_with("HTTP/1.1 403"));
    let r = get(
        s.local(),
        &format!("/_tvpipe/start?t={}", s.hub.token),
        &host,
        "",
    );
    assert!(r.starts_with("HTTP/1.1 302"), "{r}");
    assert!(r.contains("Location: /_tvpipe/launcher/"), "{r}");
    let cookie = format!("tvpipe-{}={}", s.local(), s.hub.token);
    assert!(
        r.contains(&format!(
            "Set-Cookie: {cookie}; Path=/; HttpOnly; SameSite=Strict"
        )),
        "{r}"
    );
    let r = get(s.local(), "/", &host, &format!("Cookie: a=b; {cookie}\r\n"));
    assert!(r.contains("Location: /_tvpipe/launcher/"), "{r}");
    // The bundle, the library and the launcher.
    let r = get(s.local(), "/host.html", &host, "");
    assert!(r.starts_with("HTTP/1.1 200"), "{r}");
    assert!(r.contains("Content-Type: text/html; charset=utf-8"), "{r}");
    assert!(r.contains("Cache-Control: no-cache"), "{r}");
    assert!(get(s.local(), "/_tvpipe/lib/client.js", &host, "").starts_with("HTTP/1.1 200"));
    assert!(get(s.local(), "/_tvpipe/launcher/", &host, "").starts_with("HTTP/1.1 200"));
    assert!(get(s.local(), "/_tvpipe/screen/", &host, "").starts_with("HTTP/1.1 200"));
    let r = get(s.local(), "/_tvpipe/tvsync/", &host, "");
    assert!(
        r.starts_with("HTTP/1.1 200") && r.contains("tvsync.js"),
        "{r}"
    );
    assert!(get(s.local(), "/_tvpipe/tvsync/tvsync.js", &host, "").contains("../lib/flashsync.js"));
    // tvpipe's look: the stylesheet and the browser player's fonts.
    let r = get(s.local(), "/_tvpipe/ui.css", &host, "");
    assert!(r.starts_with("HTTP/1.1 200"), "{r}");
    assert!(r.contains("Content-Type: text/css"), "{r}");
    assert!(r.contains("url(fonts/michroma.woff2)"), "{r}");
    let r = http(
        s.local(),
        &format!("HEAD /_tvpipe/fonts/michroma.woff2 HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n"),
    );
    assert!(
        r.starts_with("HTTP/1.1 200") && r.contains("font/woff2"),
        "{r}"
    );
    assert!(get(s.local(), "/_tvpipe/fonts/nope.woff2", &host, "").starts_with("HTTP/1.1 404"));
    let r = get(s.local(), "/phone", &host, "");
    assert!(
        r.starts_with("HTTP/1.1 301") && r.contains("Location: /phone/"),
        "{r}"
    );
    // Never served: the bundle's own `_tvpipe`, dot files, traversal.
    for bad in [
        "/_tvpipe/secret.txt",
        "/_tvpipe/../tvpipe.json/../_tvpipe/secret.txt",
        "/.hidden",
        "/phone/../../tvpipe.json",
        "/%2e%2e/x",
        "/_tvpipe/lib/../launcher/index.html",
    ] {
        let r = get(s.local(), bad, &host, "");
        assert!(r.starts_with("HTTP/1.1 404"), "{bad}: {r}");
    }
    assert!(http(
        s.local(),
        &format!("POST /host.html HTTP/1.1\r\nHost: {host}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
    )
    .starts_with("HTTP/1.1 405"));
    // ETags.
    let r = get(s.local(), "/tv.html", &host, "");
    let etag = r
        .lines()
        .find_map(|l| l.strip_prefix("ETag: "))
        .unwrap()
        .to_owned();
    let r = get(
        s.local(),
        "/tv.html",
        &host,
        &format!("If-None-Match: {etag}\r\n"),
    );
    assert!(r.starts_with("HTTP/1.1 304"), "{r}");
}

#[test]
fn public_listener_rules() {
    let s = Setup::new("game.zip");
    let host = format!("127.0.0.1:{}", s.public());
    let r = get(s.public(), "/?r=BCDF", &host, "");
    assert!(r.starts_with("HTTP/1.1 302"), "{r}");
    // The game's tag in the query too: a page in the frame page gets no
    // cookie (docs/game-switching.md); an old one gives way.
    let tag = s.hub.game_tag(&s.hub.game().unwrap());
    let phone = format!("Location: /phone/index.html?r=BCDF&g={tag}\r\n");
    assert!(r.contains(&phone), "{r}");
    let r = get(s.public(), "/?g=old.1&r=BCDF&g", &host, "");
    assert!(r.contains(&phone), "{r}");
    // Only the listener itself and the frame page's origin may frame the
    // phones' pages; the window's own listener says nothing.
    let csp = s.hub.frame_ancestors();
    assert!(csp.starts_with("frame-ancestors 'self'"), "{csp}");
    assert!(
        r.contains(&format!("Content-Security-Policy: {csp}\r\n")),
        "{r}"
    );
    let local = format!("127.0.0.1:{}", s.local());
    let r = get(s.local(), "/tv.html", &local, "");
    assert!(!r.contains("Content-Security-Policy"), "{r}");
    assert!(get(s.public(), "/phone/app.js", &host, "").contains("export const x"));
    // No service workers on the phones' origin (§18); the window may.
    let r = get(
        s.public(),
        "/phone/app.js",
        &host,
        "Service-Worker: script\r\n",
    );
    assert!(r.starts_with("HTTP/1.1 403"), "{r}");
    let local = format!("127.0.0.1:{}", s.local());
    let r = get(
        s.local(),
        "/phone/app.js",
        &local,
        "Service-Worker: script\r\n",
    );
    assert!(!r.starts_with("HTTP/1.1 403 Forbidden: no service"), "{r}");
    assert!(get(s.public(), "/_tvpipe/lib/client.js", &host, "").starts_with("HTTP/1.1 200"));
    assert!(get(s.public(), "/_tvpipe/ui.css", &host, "").starts_with("HTTP/1.1 200"));
    let r = get(s.public(), "/nope.html", &host, "Accept: text/html\r\n");
    assert!(r.starts_with("HTTP/1.1 404"), "{r}");
    assert!(r.contains("scan the QR code on the TV again"), "{r}");
    // Local-only things are not there.
    assert!(get(s.public(), "/_tvpipe/launcher/", &host, "").starts_with("HTTP/1.1 404"));
    assert!(get(s.public(), "/_tvpipe/tvsync/", &host, "").starts_with("HTTP/1.1 404"));
    assert!(get(s.public(), "/_tvpipe/screen/", &host, "").starts_with("HTTP/1.1 404"));
    assert!(get(
        s.public(),
        &format!("/_tvpipe/start?t={}", s.hub.token),
        &host,
        ""
    )
    .starts_with("HTTP/1.1 404"));
    assert!(ws(s.public(), &format!("/_tvpipe/api?t={}", s.hub.token), &[]).is_err());
    // The tunnel's name once it is up; others never.
    assert!(get(s.public(), "/", "abc.example.com", "").starts_with("HTTP/1.1 421"));
    {
        let mut t = s.hub.tunnel.write().unwrap();
        t.state = "up";
        t.host = Some("abc.example.com".into());
    }
    assert!(get(s.public(), "/", "abc.example.com", "").starts_with("HTTP/1.1 302"));
    assert!(get(s.public(), "/", "abc.example.com:443", "").starts_with("HTTP/1.1 302"));
    assert!(get(s.public(), "/", "x.example.com", "").starts_with("HTTP/1.1 421"));
    let info = s.hub.info();
    assert_eq!(
        info.unwrap()
            .get("phone")
            .unwrap()
            .get("url")
            .unwrap()
            .as_str(),
        Some("https://abc.example.com/")
    );
}

#[test]
fn api_access() {
    let s = Setup::new("game");
    assert!(ws(s.local(), "/_tvpipe/api", &[]).is_err());
    assert!(ws(s.local(), "/_tvpipe/api?t=wrong", &[]).is_err());
    let path = format!("/_tvpipe/api?t={}", s.hub.token);
    // Cross-site WebSocket hijacking: a page of another origin (another
    // port of 127.0.0.1 too) is refused even with the cookie.
    for origin in [
        "http://evil.example".to_owned(),
        format!("http://127.0.0.1:{}", s.public()),
    ] {
        let e = refused(ws(s.local(), &path, &[("Origin", origin.as_str())]));
        assert!(e.to_string().contains("403"), "{origin}: {e}");
    }
    let origin = format!("http://127.0.0.1:{}", s.local());
    let cookie = format!("tvpipe-{}={}", s.local(), s.hub.token);
    let mut w = ws(
        s.local(),
        "/_tvpipe/api",
        &[("Origin", origin.as_str()), ("Cookie", cookie.as_str())],
    )
    .unwrap();
    let r = call(&mut w, "info", Value::object());
    assert_eq!(r.get("ok").and_then(Value::as_bool), Some(true), "{r}");
    let info = r.get("value").unwrap();
    assert_eq!(info.get("name").and_then(Value::as_str), Some("test-game"));
    assert_eq!(
        info.get("pages")
            .unwrap()
            .get("phone")
            .and_then(Value::as_str),
        Some("/phone/index.html")
    );
    assert_eq!(
        info.get("phone")
            .unwrap()
            .get("mode")
            .and_then(Value::as_str),
        Some("local")
    );
    let r = call(&mut w, "nope", Value::object());
    assert_eq!(
        r.get("error").unwrap().get("code").and_then(Value::as_str),
        Some("unknown-method")
    );
    let r = call(
        &mut w,
        "qr",
        Value::object().with("text", "https://example.com/"),
    );
    let qr = r.get("value").unwrap();
    assert_eq!(qr.get("size").and_then(Value::as_u64), Some(25));
    assert_eq!(qr.get("rows").unwrap().as_array().unwrap().len(), 25);
}

#[test]
fn launcher_flow_with_fake_devices() {
    let mut s = Setup::new("game");
    let mut w = api(&s);
    let r = call(&mut w, "devices.watch", Value::object().with("on", true));
    assert!(r.get("ok").and_then(Value::as_bool).unwrap());
    let devices = event_of(&mut w, "devices");
    let names: Vec<&str> = devices
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|d| d.get("name").and_then(Value::as_str))
        .collect();
    assert_eq!(names, ["browser", "Living Room"]);
    // Pairing: the PIN, a wrong one first.
    call(
        &mut w,
        "pair.start",
        Value::object().with("device", "Living Room"),
    );
    let p = event_of(&mut w, "pair");
    assert_eq!(p.get("state").and_then(Value::as_str), Some("pin"));
    call(
        &mut w,
        "pair.pin",
        Value::object()
            .with("device", "Living Room")
            .with("pin", "1234"),
    );
    let p = event_of(&mut w, "pair");
    assert_eq!(p.get("state").and_then(Value::as_str), Some("done"), "{p}");
    assert_eq!(p.get("device").and_then(Value::as_str), Some("Living Room"));
    // The selection survives a navigation (a new socket).
    call(
        &mut w,
        "select",
        Value::object().with("devices", vec!["Living Room"]),
    );
    drop(w);
    let mut w = api(&s);
    let r = call(&mut w, "selection", Value::object());
    assert_eq!(
        r.get("value")
            .unwrap()
            .get("devices")
            .unwrap()
            .at(0)
            .and_then(Value::as_str),
        Some("Living Room")
    );
    // Casting: only pages of the local origin; the selection by default.
    for bad in ["https://evil.example/", "//evil.example/x", "tv.html"] {
        let r = call(&mut w, "cast.start", Value::object().with("page", bad));
        assert_eq!(r.get("ok").and_then(Value::as_bool), Some(false), "{bad}");
    }
    let r = call(
        &mut w,
        "cast.start",
        Value::object().with("page", "/tv.html#r=AB&k=key"),
    );
    assert_eq!(r.get("ok").and_then(Value::as_bool), Some(true), "{r}");
    assert_eq!(
        r.get("value").unwrap().get("state").and_then(Value::as_str),
        Some("starting")
    );
    loop {
        let st = event_of(&mut w, "cast");
        if st.get("state").and_then(Value::as_str) == Some("streaming") {
            break;
        }
    }
    {
        let log = s.log.lock().unwrap();
        assert_eq!(
            log.casts,
            [(
                format!("http://127.0.0.1:{}/tv.html#r=AB&k=key", s.local()),
                vec!["Living Room".to_owned()]
            )]
        );
    }
    // A second cast replaces the first.
    call(
        &mut w,
        "cast.start",
        Value::object()
            .with("page", "/tv.html")
            .with("to", vec!["browser"]),
    );
    assert_eq!(s.log.lock().unwrap().stopped, 1);
    // The end stops it.
    s.end();
    assert_eq!(s.log.lock().unwrap().stopped, 2);
}

#[test]
fn tv_lags_are_kept_and_shown() {
    let mut s = Setup::new("game");
    let mut w = api(&s);
    call(&mut w, "devices.watch", Value::object().with("on", true));
    let devices = event_of(&mut w, "devices");
    let room = |list: &Value| {
        list.as_array()
            .unwrap()
            .iter()
            .find(|d| d.get("name").and_then(Value::as_str) == Some("Living Room"))
            .cloned()
            .unwrap()
    };
    assert!(room(&devices).get("displayMs").is_none(), "{devices}");
    // Measured: the devices list says so at once, any case.
    let r = call(
        &mut w,
        "tvsync.set",
        Value::object()
            .with("device", "living room")
            .with("displayMs", 162),
    );
    assert_eq!(r.get("ok").and_then(Value::as_bool), Some(true), "{r}");
    // (Its `devices` event went out before the reply: `call` drops it.)
    let list = |w: &mut Ws| {
        call(w, "devices.watch", Value::object().with("on", true))
            .get("value")
            .cloned()
            .unwrap()
    };
    let devices = list(&mut w);
    assert_eq!(
        room(&devices).get("displayMs").and_then(Value::as_u32),
        Some(162),
        "{devices}"
    );
    // Statuses carry it for their receivers.
    call(
        &mut w,
        "cast.start",
        Value::object()
            .with("page", "/_tvpipe/tvsync/")
            .with("to", vec!["Living Room"]),
    );
    let st = loop {
        let st = event_of(&mut w, "cast");
        if st.get("state").and_then(Value::as_str) == Some("streaming") {
            break st;
        }
    };
    let r = st.get("receivers").and_then(|r| r.at(0)).unwrap();
    assert_eq!(
        r.get("displayMs").and_then(Value::as_u32),
        Some(162),
        "{st}"
    );
    // Out of range or no device: refused; null forgets it.
    for bad in [
        Value::object()
            .with("device", "Living Room")
            .with("displayMs", 2001),
        Value::object()
            .with("device", "Living Room")
            .with("displayMs", -5),
        Value::object().with("device", " ").with("displayMs", 10),
        Value::object().with("displayMs", 10),
    ] {
        let r = call(&mut w, "tvsync.set", bad.clone());
        assert_eq!(r.get("ok").and_then(Value::as_bool), Some(false), "{bad}");
    }
    call(
        &mut w,
        "tvsync.set",
        Value::object()
            .with("device", "Living Room")
            .with("displayMs", Value::Null),
    );
    let devices = list(&mut w);
    assert!(room(&devices).get("displayMs").is_none(), "{devices}");
    s.end();
}

#[test]
fn tv_lags_come_from_the_storage() {
    let storage = crate::storage::Storage::memory();
    storage.set_tv_lag("Living Room", Some(90)).unwrap();
    struct Kept(Fake, crate::storage::Storage);
    impl Backend for Kept {
        fn surface(
            &self,
            to: &[String],
            spec: super::backend::SurfaceSpec,
        ) -> crate::error::Result<Box<dyn super::backend::SurfaceSink>> {
            self.0.surface(to, spec)
        }
        fn discover(&self) -> crate::error::Result<Box<dyn Discover>> {
            self.0.discover()
        }
        fn pair(&self, device: &str) -> crate::error::Result<Box<dyn Pair>> {
            self.0.pair(device)
        }
        fn cast(
            &self,
            url: &str,
            to: &[String],
            picture: super::resolution::Picture,
        ) -> crate::error::Result<Box<dyn Cast>> {
            self.0.cast(url, to, picture)
        }
        fn storage(&self) -> Option<&crate::storage::Storage> {
            Some(&self.1)
        }
    }
    let hub = Hub::new(
        Bundle::open(&fixture("game")).unwrap(),
        "token".into(),
        Box::new(Kept(
            Fake {
                log: Arc::default(),
                fail_cast: false,
            },
            storage.clone(),
        )),
        Stop::new(),
    );
    let st = hub.status_with_display(Value::object().with(
        "receivers",
        Value::array(vec![Value::object().with("name", "Living Room")]),
    ));
    assert_eq!(
        st.to_json(),
        r#"{"receivers":[{"name":"Living Room","displayMs":90}]}"#
    );
    // Changes are written through.
    hub.call(
        0,
        "tvsync.set",
        &Value::object().with("device", "Den").with("displayMs", 40),
    )
    .unwrap();
    let lags = storage.tv_lags().unwrap();
    assert_eq!(lags.get("Den"), Some(&40));
    assert_eq!(lags.get("Living Room"), Some(&90));
}

#[test]
fn cast_failure_is_reported() {
    let s = Setup::with("game", true);
    let mut w = api(&s);
    let r = call(
        &mut w,
        "cast.start",
        Value::object()
            .with("page", "/tv.html")
            .with("to", vec!["x"]),
    );
    assert_eq!(
        r.get("error").unwrap().get("code").and_then(Value::as_str),
        Some("not-found")
    );
    let r = call(
        &mut w,
        "cast.start",
        Value::object().with("page", "/tv.html"),
    );
    assert_eq!(
        r.get("error").unwrap().get("code").and_then(Value::as_str),
        Some("no-receivers")
    );
}

/// The resolution: chosen with the selection, overridden per cast,
/// offered in `info`.
#[test]
fn resolution_is_chosen() {
    use super::resolution::{Picture, Resolution};
    let s = Setup::new("game");
    let mut w = api(&s);
    let value = |r: Value| r.get("value").cloned().unwrap_or(Value::Null);
    let info = value(call(&mut w, "info", Value::object()));
    assert_eq!(
        info.get("resolutions").unwrap().to_json(),
        r#"["auto","720p","1080p","2160p"]"#
    );
    // Not in test mode unless `--dev`.
    assert_eq!(info.get("dev").and_then(Value::as_bool), Some(false));
    s.hub.dev.store(true, std::sync::atomic::Ordering::Relaxed);
    let info = value(call(&mut w, "info", Value::object()));
    assert_eq!(info.get("dev").and_then(Value::as_bool), Some(true));
    let sel = value(call(&mut w, "selection", Value::object()));
    assert_eq!(sel.get("resolution").and_then(Value::as_str), Some("auto"));
    let r = call(
        &mut w,
        "select",
        Value::object()
            .with("devices", vec!["TV"])
            .with("resolution", "2160p"),
    );
    assert_eq!(
        value(r).get("resolution").and_then(Value::as_str),
        Some("2160p")
    );
    // A select without one keeps it.
    call(
        &mut w,
        "select",
        Value::object().with("devices", vec!["TV"]),
    );
    let r = call(
        &mut w,
        "cast.start",
        Value::object().with("page", "/tv.html"),
    );
    assert_eq!(r.get("ok").and_then(Value::as_bool), Some(true), "{r}");
    let r = call(
        &mut w,
        "cast.start",
        Value::object()
            .with("page", "/tv.html")
            .with("resolution", "720p"),
    );
    assert_eq!(r.get("ok").and_then(Value::as_bool), Some(true), "{r}");
    for (method, params) in [
        ("select", Value::object().with("devices", vec!["TV"])),
        ("cast.start", Value::object().with("page", "/tv.html")),
    ] {
        let r = call(&mut w, method, params.with("resolution", "8k"));
        assert_eq!(
            r.get("error").unwrap().get("code").and_then(Value::as_str),
            Some("bad-resolution"),
            "{method}"
        );
    }
    // The same TVs and picture: the next page goes into the running tab.
    let r = call(
        &mut w,
        "cast.start",
        Value::object()
            .with("page", "/tv.html#k=next")
            .with("resolution", "720p"),
    );
    assert_eq!(r.get("ok").and_then(Value::as_bool), Some(true), "{r}");
    {
        let log = s.log.lock().unwrap();
        assert_eq!(
            log.navigations,
            [format!("http://127.0.0.1:{}/tv.html#k=next", s.local())]
        );
        assert_eq!((log.casts.len(), log.stopped), (2, 1));
    }
    // Other TVs: a cast of their own.
    let r = call(
        &mut w,
        "cast.start",
        Value::object()
            .with("page", "/tv.html")
            .with("to", vec!["Kitchen"])
            .with("resolution", "720p"),
    );
    assert_eq!(r.get("ok").and_then(Value::as_bool), Some(true), "{r}");
    assert_eq!(s.log.lock().unwrap().casts.len(), 3);
    s.log.lock().unwrap().pictures.pop();
    assert_eq!(
        s.log.lock().unwrap().pictures,
        [
            Picture {
                layout: None,
                resolution: Some(Resolution::P2160)
            },
            Picture {
                layout: None,
                resolution: Some(Resolution::P720)
            },
        ]
    );
}

// ---------------------------------------------------------------------
// The relay

fn attach(s: &Setup) -> Ws {
    let mut host = api(s);
    let r = call(&mut host, "relay.attach", Value::object());
    assert_eq!(r.get("ok").and_then(Value::as_bool), Some(true), "{r}");
    host
}

fn phone(s: &Setup) -> crate::error::Result<Ws> {
    ws(
        s.public(),
        "/_tvpipe/ws?x=1",
        &[("User-Agent", "fake phone")],
    )
}

/// The host's next relay message: control JSON or a data frame.
enum HostMsg {
    Control(Value),
    Data(u8, u32, Vec<u8>),
}

fn host_next(host: &mut Ws) -> HostMsg {
    loop {
        match host.0.read_message().unwrap() {
            Message::Text(t) => {
                let v = Value::parse(&t).unwrap();
                if v.get("t").and_then(Value::as_str) == Some("event") {
                    continue;
                }
                return HostMsg::Control(v);
            }
            Message::Binary(b) => {
                return HostMsg::Data(
                    b[0],
                    u32::from_be_bytes([b[1], b[2], b[3], b[4]]),
                    b[5..].to_vec(),
                )
            }
            Message::Close(c) => panic!("host closed: {c:?}"),
        }
    }
}

fn host_control(host: &mut Ws, t: &str) -> Value {
    loop {
        if let HostMsg::Control(v) = host_next(host) {
            if v.get("t").and_then(Value::as_str) == Some(t) {
                return v;
            }
        }
    }
}

#[test]
fn relay_both_ways() {
    let s = Setup::new("game");
    // No host: clients are turned away.
    let e = refused(phone(&s));
    assert!(e.to_string().contains("503"), "{e}");
    let mut host = attach(&s);
    let mut p = phone(&s).unwrap();
    let open = host_control(&mut host, "open");
    let conn = open.get("conn").and_then(Value::as_u64).unwrap() as u32;
    assert_eq!(open.get("via").and_then(Value::as_str), Some("public"));
    assert_eq!(open.get("addr").and_then(Value::as_str), Some("127.0.0.1"));
    assert_eq!(open.get("query").and_then(Value::as_str), Some("x=1"));
    assert_eq!(
        open.get("agent").and_then(Value::as_str),
        Some("fake phone")
    );
    // Phone → host.
    p.1.send_text("{\"t\":\"hello\"}").unwrap();
    p.1.send_binary(&[1, 2, 3]).unwrap();
    match host_next(&mut host) {
        HostMsg::Data(1, c, d) => {
            assert_eq!(c, conn);
            assert_eq!(d, b"{\"t\":\"hello\"}");
        }
        _ => panic!("expected text data"),
    }
    match host_next(&mut host) {
        HostMsg::Data(2, c, d) => assert_eq!((c, d), (conn, vec![1, 2, 3])),
        _ => panic!("expected binary data"),
    }
    // Host → phone, then a close after the data.
    host.1
        .send_binary(&hub::frame(hub::OP_TEXT, conn, b"welcome"))
        .unwrap();
    host.1
        .send_binary(&hub::frame(hub::OP_BINARY, conn, &[9]))
        .unwrap();
    // Unknown connections and ops are ignored.
    host.1
        .send_binary(&hub::frame(hub::OP_TEXT, 999, b"x"))
        .unwrap();
    host.1.send_binary(&[7, 0, 0, 0, 1]).unwrap();
    host.1
        .send_text(
            &Value::object()
                .with("t", "close")
                .with("conn", u64::from(conn))
                .with("code", 4003u64)
                .with("reason", "bad-key")
                .to_json(),
        )
        .unwrap();
    assert_eq!(p.0.read_message().unwrap(), Message::Text("welcome".into()));
    assert_eq!(p.0.read_message().unwrap(), Message::Binary(vec![9]));
    assert_eq!(close_code(&mut p.0), 4003);
    let c = host_control(&mut host, "close");
    assert_eq!(c.get("conn").and_then(Value::as_u64), Some(u64::from(conn)));
    // A phone that closes by itself.
    let p2 = phone(&s).unwrap();
    let open = host_control(&mut host, "open");
    let conn2 = open.get("conn").and_then(Value::as_u64).unwrap();
    assert!(conn2 > u64::from(conn));
    p2.1.close(1000, "bye").unwrap();
    let c = host_control(&mut host, "close");
    assert_eq!(c.get("conn").and_then(Value::as_u64), Some(conn2));
    assert_eq!(c.get("code").and_then(Value::as_u64), Some(1000));
}

#[test]
fn the_next_game_takes_the_room_over() {
    let s = Setup::new("game");
    let mut host = attach(&s);
    let info = call(&mut host, "info", Value::object());
    let room = info
        .get("value")
        .and_then(|v| v.get("room"))
        .unwrap()
        .clone();
    let code = room.get("code").and_then(Value::as_str).unwrap();
    assert_eq!(code.len(), 4);
    assert!(code.bytes().all(|b| b"BCDFGHJKLMNPQRSTVWXZ".contains(&b)));
    assert_eq!(room.get("key").and_then(Value::as_str).unwrap().len(), 22);
    // Bundle files name their game; the phone page connects with it.
    let raw = get(
        s.public(),
        "/phone/index.html",
        &format!("127.0.0.1:{}", s.public()),
        "",
    );
    let tag = format!("{}.1", s.hub.run);
    assert!(
        raw.contains(&format!(
            "Set-Cookie: tvpipe-game={tag}; Path=/; SameSite=Lax"
        )),
        "{raw}"
    );
    let mut p = ws(s.public(), &format!("/_tvpipe/ws?g={tag}"), &[]).unwrap();
    host_control(&mut host, "open");
    // Without `g` (Node, tests): not checked.
    let mut q = phone(&s).unwrap();
    host_control(&mut host, "open");
    // The next game: phones go to their join link, the host is detached,
    // the pages get where to go.
    call(
        &mut host,
        "select",
        Value::object().with("devices", vec!["Living Room"]),
    );
    let url = s.hub.put(Bundle::open(&fixture("game.zip")).unwrap());
    assert_eq!(url, "/host.html");
    assert_eq!(close_code(&mut p.0), hub::CLOSE_NEXT_GAME);
    assert_eq!(close_code(&mut q.0), hub::CLOSE_NEXT_GAME);
    let ev = event_of(&mut host, "game");
    assert_eq!(ev.get("url").and_then(Value::as_str), Some("/host.html"));
    assert_eq!(ev.get("title").and_then(Value::as_str), Some("Test game"));
    assert!(!s.hub.host_attached());
    // A page of the last game is sent along at once, even without a host.
    let mut stale = ws(s.public(), &format!("/_tvpipe/ws?g={tag}"), &[]).unwrap();
    assert_eq!(close_code(&mut stale.0), hub::CLOSE_NEXT_GAME);
    // The new host page: the same room.
    let mut host2 = attach(&s);
    let info = call(&mut host2, "info", Value::object());
    let v = info.get("value").unwrap();
    assert_eq!(v.get("room"), Some(&room));
    assert_eq!(v.get("game").and_then(Value::as_u64), Some(2));
    let tag2 = format!("{}.2", s.hub.run);
    let _p = ws(s.public(), &format!("/_tvpipe/ws?g={tag2}"), &[]).unwrap();
    host_control(&mut host2, "open");
}

#[test]
fn relay_origins_and_local_clients() {
    let s = Setup::new("game");
    let _host = attach(&s);
    let e = refused(ws(
        s.public(),
        "/_tvpipe/ws",
        &[("Origin", "https://evil.example")],
    ));
    assert!(e.to_string().contains("403"), "{e}");
    let ok = format!("http://127.0.0.1:{}", s.public());
    assert!(ws(s.public(), "/_tvpipe/ws", &[("Origin", ok.as_str())]).is_ok());
    // The TV page on the local listener.
    let local = format!("http://localhost:{}", s.local());
    let mut host = api(&s);
    call(&mut host, "relay.attach", Value::object());
    let _tv = ws(s.local(), "/_tvpipe/ws", &[("Origin", local.as_str())]).unwrap();
    let open = host_control(&mut host, "open");
    assert_eq!(open.get("via").and_then(Value::as_str), Some("local"));
}

#[test]
fn relay_limits() {
    let s = Setup::new("game");
    let mut host = attach(&s);
    // Larger than limits.message (4096): closed 1009.
    let mut p = phone(&s).unwrap();
    host_control(&mut host, "open");
    p.1.send_text(&"x".repeat(5000)).unwrap();
    assert_eq!(close_code(&mut p.0), 1009);
    host_control(&mut host, "close");
    // Faster than the rate (5/s, 10 at once): closed 4008.
    let mut p = phone(&s).unwrap();
    host_control(&mut host, "open");
    for _ in 0..20 {
        if p.1.send_text("x").is_err() {
            break;
        }
    }
    assert_eq!(close_code(&mut p.0), 4008);
    // The first message must come within 10 s: tested by `conn` with a
    // shorter limit (below). Connections: 2 × 4 + 16 = 24 < 64: 64.
    assert_eq!(s.hub.max_clients(), 64);
}

#[test]
fn host_changes_and_the_end() {
    let mut s = Setup::new("game");
    let mut host = attach(&s);
    let mut p = phone(&s).unwrap();
    host_control(&mut host, "open");
    // A second host takes over: the first is told, phones restart.
    let mut host2 = attach(&s);
    assert_eq!(close_code(&mut p.0), 1012);
    loop {
        match host.0.read_message() {
            Ok(Message::Text(t)) if t.contains("\"detached\"") => break,
            Ok(_) => continue,
            Err(e) => panic!("{e}"),
        }
    }
    assert_eq!(close_code(&mut host.0), 1000);
    // The host leaving: phones restart too.
    let mut p = phone(&s).unwrap();
    host_control(&mut host2, "open");
    drop(host2);
    assert_eq!(close_code(&mut p.0), 1012);
    // The end: `closing` to the host, then 4011 to phones.
    let mut host3 = attach(&s);
    let mut p = phone(&s).unwrap();
    host_control(&mut host3, "open");
    let h = s.hub.clone();
    let t0 = Instant::now();
    let ender = std::thread::spawn(move || h.shutdown());
    assert!(event_of(&mut host3, "closing").is_null());
    assert_eq!(close_code(&mut p.0), hub::CLOSE_ENDED);
    ender.join().unwrap();
    assert!(t0.elapsed() >= Duration::from_millis(900));
    assert!(phone(&s).is_err());
    s.end();
}

#[test]
fn host_says_goodbye_before_the_end() {
    let s = Setup::new("game");
    let mut host = attach(&s);
    let mut p = phone(&s).unwrap();
    let conn = host_control(&mut host, "open")
        .get("conn")
        .and_then(Value::as_u64)
        .unwrap();
    let h = s.hub.clone();
    let t0 = Instant::now();
    let ender = std::thread::spawn(move || h.shutdown());
    event_of(&mut host, "closing");
    host.1
        .send_binary(&hub::frame(hub::OP_TEXT, conn as u32, b"{\"t\":\"bye\"}"))
        .unwrap();
    host.1
        .send_text(
            &Value::object()
                .with("t", "close")
                .with("conn", conn)
                .with("code", 4011u64)
                .to_json(),
        )
        .unwrap();
    assert_eq!(
        p.0.read_message().unwrap(),
        Message::Text("{\"t\":\"bye\"}".into())
    );
    assert_eq!(close_code(&mut p.0), 4011);
    ender.join().unwrap();
    // Everyone was gone: no full second of waiting.
    assert!(
        t0.elapsed() < Duration::from_millis(900),
        "{:?}",
        t0.elapsed()
    );
}

#[test]
fn surfaces() {
    let s = Setup::new("game");
    let mut w = api(&s);
    let r = call(
        &mut w,
        "surface.open",
        Value::object()
            .with("width", 1281u64)
            .with("height", 720u64)
            .with("audio", true)
            .with("to", vec!["browser"]),
    );
    let v = r.get("value").unwrap_or_else(|| panic!("{r}"));
    assert_eq!(v.get("width").and_then(Value::as_u64), Some(1280));
    let path = v.get("path").and_then(Value::as_str).unwrap().to_owned();
    let id = v.get("id").and_then(Value::as_u64).unwrap();
    // Needs the token, and an open surface.
    assert!(ws(s.local(), &path, &[]).is_err());
    assert!(ws(
        s.local(),
        &format!("/_tvpipe/surface?id=99&t={}", s.hub.token),
        &[]
    )
    .is_err());
    assert!(ws(s.public(), &format!("{path}&t={}", s.hub.token), &[]).is_err());
    let (mut rx, tx) = ws(s.local(), &format!("{path}&t={}", s.hub.token), &[]).unwrap();
    let rec = |kind: u8, pts: u64, payload: &[u8]| {
        let mut b = vec![kind];
        b.extend_from_slice(&pts.to_le_bytes());
        b.extend_from_slice(&(payload.len() as u32).to_le_bytes());
        b.extend_from_slice(payload);
        b
    };
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_micros() as u64;
    tx.send_binary(&rec(4, now, &[0, 1, 2, 3])).unwrap();
    tx.send_binary(&rec(3, now, &[1, 9, 9])).unwrap();
    tx.send_binary(&rec(3, now + 33_333, &[0, 9])).unwrap();
    tx.send_binary(&rec(2, now + 10_000, &[0; 1920])).unwrap();
    // The fake asks for a keyframe once; the status comes too.
    let mut got = (false, false);
    while !(got.0 && got.1) {
        let m = next_json(&mut rx);
        match m.get("t").and_then(Value::as_str) {
            Some("keyframe") => got.0 = true,
            Some("status") => got.1 = true,
            _ => {}
        }
    }
    loop {
        let m = next_json(&mut rx);
        if m.get("t").and_then(Value::as_str) == Some("stats") {
            assert_eq!(
                m.get("fps").and_then(Value::as_f64).map(|f| f > 0.0),
                Some(true)
            );
            break;
        }
    }
    {
        let log = SURFACE_LOG.lock().unwrap();
        assert_eq!(log.configs, 1);
        // On the stream's clock: the second one stamped 33 ms after the first.
        let (a, b) = (log.frames[0], log.frames[1]);
        assert!(a.1 && !b.1);
        let d = b.0.as_micros() as i64 - a.0.as_micros() as i64;
        assert!((20_000..=40_000).contains(&d), "{d}");
        assert_eq!(log.audio, 960);
    }
    // A bad record closes the socket.
    tx.send_binary(&[3, 0, 0]).unwrap();
    assert_eq!(close_code(&mut rx), 1002);
    let r = call(&mut w, "surface.close", Value::object().with("id", id));
    assert_eq!(r.get("ok").and_then(Value::as_bool), Some(true), "{r}");
    assert!(SURFACE_LOG.lock().unwrap().stopped);
}

#[test]
fn lan_listener() {
    // A LAN listener on loopback (no network, no firewall prompt): its
    // own exact Host and Origin only.
    crate::util::timer::raise_resolution();
    let bundle = Bundle::open(&fixture("game")).unwrap();
    let opts = Options {
        tunnel: TunnelChoice::Off,
        lan: Some(Some("127.0.0.1".parse().unwrap())),
        ..Options::default()
    };
    let log = Arc::new(Mutex::new(Log::default()));
    let running = Running::start(
        bundle,
        Box::new(Fake {
            log,
            fail_cast: false,
        }),
        &opts,
        Stop::new(),
    )
    .unwrap();
    let hub = running.hub.clone();
    let lan = hub.ports.get().unwrap().lan.unwrap();
    let info = hub.info().unwrap();
    let phone = info.get("phone").unwrap();
    assert_eq!(phone.get("mode").and_then(Value::as_str), Some("lan"));
    assert_eq!(
        phone.get("url").and_then(Value::as_str),
        Some(format!("http://{lan}/").as_str())
    );
    let r = get(lan.port(), "/?r=AB", &lan.to_string(), "");
    assert!(r.contains("Location: /phone/index.html?r=AB"), "{r}");
    assert!(
        get(lan.port(), "/", &format!("localhost:{}", lan.port()), "").starts_with("HTTP/1.1 421")
    );
    assert!(get(lan.port(), "/_tvpipe/launcher/", &lan.to_string(), "").starts_with("HTTP/1.1 404"));
    let mut host = api_of(&hub);
    call(&mut host, "relay.attach", Value::object());
    let origin = format!("http://{lan}");
    let _p = ws(lan.port(), "/_tvpipe/ws", &[("Origin", origin.as_str())]).unwrap();
    let open = host_control(&mut host, "open");
    assert_eq!(open.get("via").and_then(Value::as_str), Some("lan"));
    let e = refused(ws(
        lan.port(),
        "/_tvpipe/ws",
        &[("Origin", "http://127.0.0.1:1")],
    ));
    assert!(e.to_string().contains("403"), "{e}");
    drop(host);
    running.end();
}

// ---------------------------------------------------------------------
// One connection

#[test]
fn outbox_marks_and_limit() {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let s2 = seen.clone();
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = std::thread::spawn(move || {
        let (tcp, _) = listener.accept().unwrap();
        // The handshake by hand.
        let mut c = crate::net::http::Conn::new(tcp);
        let req = c.read_request().unwrap();
        c.send_response(&websocket::server_response(&req).unwrap())
            .unwrap();
        let (tcp, rest) = c.into_parts();
        let opts = conn::Options {
            name: "test",
            max_message: 1024,
            first_message: Some(Duration::from_millis(300)),
            mark: Some((
                1000,
                Box::new(move |busy| s2.lock().unwrap().push(busy)) as conn::MarkFn,
            )),
            limit: Some((50_000, 4013, "slow")),
        };
        conn::run(
            tcp,
            rest,
            opts,
            |out| {
                // 30 KB queued at once: above the mark, under the limit.
                for _ in 0..30 {
                    out.text("y".repeat(1000));
                }
            },
            |_| conn::Next::Continue,
        )
    });
    let (mut rx, tx) = ws(port, "/", &[]).unwrap();
    for _ in 0..30 {
        assert!(matches!(rx.read_message().unwrap(), Message::Text(_)));
    }
    // Then nothing: the first message never came within 300 ms.
    let _ = tx;
    assert_eq!(close_code(&mut rx), 4002);
    let ended = server.join().unwrap();
    assert_eq!(ended.code, 4002);
    // Busy, drained (perhaps more than once while the writer kept up).
    let seen = seen.lock().unwrap();
    assert!(seen.len() >= 2 && seen.len() % 2 == 0, "{seen:?}");
    assert!(
        seen.iter().enumerate().all(|(i, b)| *b == (i % 2 == 0)),
        "{seen:?}"
    );
}

#[test]
fn buckets_and_windows() {
    let t0 = Instant::now();
    let mut b = conn::Bucket::new(10, 3);
    assert!(b.take_at(t0) && b.take_at(t0) && b.take_at(t0));
    assert!(!b.take_at(t0));
    assert!(b.take_at(t0 + Duration::from_millis(100)));
    let mut w = conn::WindowCounter::new(2, Duration::from_secs(60));
    assert!(w.hit("a", t0) && w.hit("a", t0));
    assert!(!w.hit("a", t0));
    assert!(w.hit("b", t0));
    assert!(w.hit("a", t0 + Duration::from_secs(61)));
}

// ---------------------------------------------------------------------
// With a real browser (opt-in):
// TVPIPE_TEST_CHROME=/path/to/chrome cargo test --release chrome_playshare -- --ignored --nocapture

/// The window (headless here) shows the launcher, which connects; a cast
/// of the bundle's TV page goes through a real headless Chrome to the
/// fake Cast receiver; closing the window's page is noticed; the end
/// stops the cast.
#[test]
#[ignore]
fn chrome_playshare_window_and_cast() {
    let Ok(bin) = std::env::var("TVPIPE_TEST_CHROME") else {
        eprintln!("TVPIPE_TEST_CHROME not set");
        return;
    };
    crate::util::timer::raise_resolution();
    let rx = crate::cast::fake_receiver::FakeReceiver::spawn(Default::default());
    let bundle = Bundle::open(&fixture("game")).unwrap();
    let stop = Stop::new();
    let opts = Options {
        tunnel: TunnelChoice::Off,
        ..Options::default()
    };
    let backend = backend::Real {
        storage: crate::storage::Storage::memory(),
        browser: Some(bin.clone().into()),
        bitrate_kbps: None,
    };
    let running = Running::start(bundle, Box::new(backend), &opts, stop.clone()).unwrap();
    let hub = running.hub.clone();
    let (mut window, mode) = window::Window::open(
        WindowMode::Headless,
        &running.start_url(),
        Some(&bin.into()),
    )
    .unwrap();
    assert_eq!(mode, WindowMode::Headless);
    // The launcher's script connects to the API.
    let until = Instant::now() + Duration::from_secs(20);
    while hub.apis_gone_for().is_none() && hub.lock().apis.is_empty() {
        assert!(Instant::now() < until, "the launcher never connected");
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(!window.closed());
    // Cast the TV page to the fake receiver.
    let mut w = api_of(&hub);
    let r = call(
        &mut w,
        "cast.start",
        Value::object()
            .with("page", "/tv.html")
            .with("to", vec![format!("cast:{}", rx.addr)]),
    );
    assert_eq!(r.get("ok").and_then(Value::as_bool), Some(true), "{r}");
    let until = Instant::now() + Duration::from_secs(30);
    let frames = || {
        rx.state
            .lock()
            .unwrap()
            .streams
            .iter()
            .map(|s| s.frames.len())
            .sum::<usize>()
    };
    while frames() < 30 {
        assert!(Instant::now() < until, "no frames from the cast");
        hub.tick();
        std::thread::sleep(Duration::from_millis(100));
    }
    hub.tick();
    eprintln!("cast: {} frames at the fake receiver", frames());
    // Closing the window's only page.
    let cdp = window.browser().unwrap().cdp();
    let targets = cdp
        .call(None, "Target.getTargets", Value::object())
        .unwrap();
    let page = targets
        .get("targetInfos")
        .and_then(Value::as_array)
        .unwrap()
        .iter()
        .find(|t| t.get("type").and_then(Value::as_str) == Some("page"))
        .and_then(|t| t.get("targetId").and_then(Value::as_str))
        .unwrap()
        .to_owned();
    cdp.call(
        None,
        "Target.closeTarget",
        Value::object().with("targetId", page),
    )
    .unwrap();
    let until = Instant::now() + Duration::from_secs(10);
    while !window.closed() {
        assert!(Instant::now() < until, "the closed window was not noticed");
        std::thread::sleep(Duration::from_millis(100));
    }
    drop(w);
    running.end();
    window.close();
    assert!(rx.state.lock().unwrap().stopped, "the receiver got STOP");
}

fn api_of(hub: &Arc<Hub>) -> Ws {
    ws(
        hub.ports.get().unwrap().local,
        &format!("/_tvpipe/api?t={}", hub.token),
        &[],
    )
    .unwrap()
}

// ---------------------------------------------------------------------
// Short links (docs/short-links.md)

#[test]
fn shortlink_only_for_the_tunnels_link() {
    let s = Setup::new("game");
    let mut w = api(&s);
    let error_code = |r: &Value| {
        assert_eq!(r.get("ok").and_then(Value::as_bool), Some(false), "{r}");
        r.get("error")
            .and_then(|e| e.get("code"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned()
    };
    let params = |url: &str| Value::object().with("url", url).with("code", "BCDF");
    let join = "https://abc.example.com/?r=BCDF#k=0123456789abcdef";
    // No tunnel: no short link.
    let r = call(&mut w, "shortlink", params(join));
    assert_eq!(error_code(&r), "unavailable");
    {
        let mut t = s.hub.tunnel.write().unwrap();
        t.state = "up";
        t.host = Some("abc.example.com".into());
    }
    // Only the tunnel's own links.
    for foreign in [
        "https://evil.example/?r=BCDF#k=0123456789abcdef",
        "https://abc.example.com.evil.example/?r=BCDF",
        "https://abc.example.com@evil.example/",
        "https://abc.example.com:8443/",
        "http://abc.example.com/?r=BCDF",
        "javascript:alert(1)",
    ] {
        let r = call(&mut w, "shortlink", params(foreign));
        assert_eq!(error_code(&r), "bad-url", "{foreign}");
    }
    let r = call(&mut w, "shortlink", Value::object());
    assert_eq!(r.get("ok").and_then(Value::as_bool), Some(false), "{r}");

    // A hub with a service of its own.
    let (svc, fake) = super::shortlink::tests::service();
    let stop = Stop::new();
    let hub = Hub::new(
        Bundle::open(&fixture("game")).unwrap(),
        "token".into(),
        Box::new(Fake {
            log: Arc::default(),
            fail_cast: false,
        }),
        stop.clone(),
    );
    let join = super::shortlink::tests::JOIN;
    let p = Value::object().with("url", join).with("code", "BCDF");
    // No short links set up (or off): unavailable.
    {
        let mut t = hub.tunnel.write().unwrap();
        t.state = "up";
        t.host = Some("abc.opentunnel.xyz".into());
    }
    let e = hub.call(0, "shortlink", &p).unwrap_err();
    assert_eq!(e.code(), Some("unavailable"));
    let _ = hub.shortlinks.set(super::shortlink::ShortLinks::new(
        Some(&svc.base("")),
        stop.clone(),
    ));
    // The frame page is the service's; it may frame the phones' pages.
    let base = svc.base("").trim_end_matches('/').to_owned();
    let info = hub.info().unwrap();
    assert_eq!(
        info.get("phone")
            .and_then(|p| p.get("frame"))
            .and_then(Value::as_str),
        Some(format!("{base}/p").as_str())
    );
    assert_eq!(
        hub.frame_ancestors(),
        format!("frame-ancestors 'self' {base}")
    );
    let v = hub.call(0, "shortlink", &p).unwrap();
    assert_eq!(
        v.to_json(),
        r#"{"url":"https://party.test/BCDF","code":"BCDF"}"#
    );
    assert_eq!(fake.lock().unwrap().links["BCDF"].0, join);
    hub.shortlinks.get().unwrap().release();
    assert!(fake.lock().unwrap().links.is_empty());
    stop.request();
}
