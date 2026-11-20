//! The share server and input against a fake page written in Rust: it
//! speaks the page's side of the protocol over a real loopback WebSocket
//! and encodes with the built-in H.264 encoder (no browser, no ffmpeg).

use std::io::{Read, Write};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use super::*;
use crate::codec::json::Value;
use crate::media::convert::Yuv420Frame;
use crate::media::h264enc;
use crate::net::websocket::{self, Message};
use crate::types::TrackKind;
use crate::util::ratio::Ratio;

/// What the fake page does.
#[derive(Clone)]
pub(crate) struct PageScript {
    pub frames: usize,
    pub fps: u32,
    pub capture: (u32, u32),
    pub audio: bool,
    /// Send `ended` after the frames (else just close the socket).
    pub send_ended: bool,
    /// Replace the first video record with this message.
    pub bad_record: Option<Vec<u8>>,
    /// Duplicate the avcC's SPS/PPS NAL headers as Firefox 160 does.
    pub duplicate_parameter_set_headers: bool,
    /// Come as a browser over the tunnel would: this `Host`, and
    /// `https://HOST` as `Origin`.
    pub public_host: Option<String>,
}

impl Default for PageScript {
    fn default() -> PageScript {
        PageScript {
            frames: 30,
            fps: 30,
            capture: (640, 360),
            audio: true,
            send_ended: true,
            bad_record: None,
            duplicate_parameter_set_headers: false,
            public_host: None,
        }
    }
}

/// What the fake page saw.
#[derive(Default, Debug, Clone)]
pub(crate) struct PageSeen {
    pub config: Option<Value>,
    pub plan: Option<Value>,
    pub statuses: Vec<String>,
    pub keyframe_requests: usize,
    pub busy: bool,
    pub end: Option<String>,
    pub closed: bool,
    /// IDRs the page made because tvpipe asked.
    pub requested_idrs: usize,
    pub frames_sent: usize,
}

type Seen = Arc<(Mutex<PageSeen>, Condvar)>;

fn wait_for(seen: &Seen, timeout: Duration, f: impl Fn(&PageSeen) -> bool) -> bool {
    let (m, cv) = &**seen;
    let deadline = Instant::now() + timeout;
    let mut g = m.lock().unwrap();
    while !f(&g) {
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return false;
        }
        g = cv.wait_timeout(g, left).unwrap().0;
    }
    true
}

/// A fake page: connects to `ws_url`, captures, waits for the plan and
/// streams `script.frames` frames in real time.
pub(crate) fn spawn_page(ws_url: String, script: PageScript) -> JoinHandle<PageSeen> {
    std::thread::spawn(move || run_page(&ws_url, script))
}

fn run_page(ws_url: &str, script: PageScript) -> PageSeen {
    let seen: Seen = Arc::default();
    let (mut rx, tx) = match &script.public_host {
        None => websocket::connect(
            ws_url,
            Duration::from_secs(10),
            websocket::Limits::default(),
        )
        .expect("page connect"),
        Some(host) => {
            let u = websocket::WsUrl::parse(ws_url).unwrap();
            let tcp = TcpStream::connect((u.host.as_str(), u.port)).unwrap();
            let url = websocket::WsUrl {
                host: host.clone(),
                port: 80,
                path: u.path,
            };
            let origin = format!("https://{host}");
            let (tcp, rest) =
                websocket::client_handshake(tcp, &url, &[("Origin", origin.as_str())]).unwrap();
            websocket::pair(
                tcp,
                rest,
                websocket::Role::Client,
                websocket::Limits::default(),
            )
            .unwrap()
        }
    };
    let s2 = seen.clone();
    let reader = std::thread::spawn(move || loop {
        let msg = rx.read_message();
        let (m, cv) = &*s2;
        let mut g = m.lock().unwrap();
        match msg {
            Ok(Message::Text(t)) => {
                let v = Value::parse(&t).unwrap();
                match v.get("type").and_then(Value::as_str).unwrap_or("") {
                    "config" => g.config = Some(v.clone()),
                    "plan" => g.plan = Some(v.clone()),
                    "status" => g
                        .statuses
                        .push(v.get("state").unwrap().as_str().unwrap().into()),
                    "keyframe" => g.keyframe_requests += 1,
                    "busy" => g.busy = true,
                    "end" => g.end = Some(v.get("reason").unwrap().as_str().unwrap().into()),
                    _ => {}
                }
            }
            Ok(Message::Binary(_)) => {}
            Ok(Message::Close(_)) | Err(_) => {
                g.closed = true;
                cv.notify_all();
                return;
            }
        }
        cv.notify_all();
    });
    // One clock for every fake page, like the real pages' wall clock
    // (timeOrigin + now()).
    static BASE: std::sync::OnceLock<Instant> = std::sync::OnceLock::new();
    let t0 = *BASE.get_or_init(Instant::now);
    let clock = move || 5_000_000 + t0.elapsed().as_micros() as u64;
    let hello = Value::object()
        .with("type", "hello")
        .with("version", 1)
        .with("clock", clock())
        .with("agent", "Mozilla/5.0 Chrome/131.0.0.0 Safari/537.36");
    tx.send_text(&hello.to_json()).unwrap();
    assert!(wait_for(&seen, Duration::from_secs(20), |s| s
        .config
        .is_some()
        || s.closed));
    let capture = Value::object()
        .with("type", "capture")
        .with("width", script.capture.0)
        .with("height", script.capture.1)
        .with("fps", script.fps)
        .with("audio", script.audio)
        .with("surface", "browser");
    let _ = tx.send_text(&capture.to_json());
    if !wait_for(&seen, Duration::from_secs(30), |s| {
        s.plan.is_some() || s.busy || s.closed
    }) {
        panic!("no plan");
    }
    let plan = seen.0.lock().unwrap().plan.clone();
    if let Some(plan) = plan {
        stream(&tx, &seen, &plan, &script, &clock);
    }
    if script.send_ended {
        let _ = tx.send_text(r#"{"type":"ended","reason":"the fake page is done"}"#);
    }
    let _ = tx.close(close_code::NORMAL, "");
    // tvpipe closes its end once the session is over.
    let _ = wait_for(&seen, Duration::from_secs(20), |s| s.closed);
    tx.with_stream(|s| {
        let _ = s.shutdown(std::net::Shutdown::Both);
    });
    let _ = reader.join();
    let out = seen.0.lock().unwrap().clone();
    out
}

fn stream(
    tx: &websocket::Sender<TcpStream>,
    seen: &Seen,
    plan: &Value,
    script: &PageScript,
    clock: &dyn Fn() -> u64,
) {
    let w = plan.get("width").unwrap().as_u32().unwrap();
    let h = plan.get("height").unwrap().as_u32().unwrap();
    let key_interval = plan.get("keyInterval").unwrap().as_u32().unwrap().max(1) as usize;
    let audio = plan.get("audio").filter(|a| !a.is_null()).map(|a| {
        (
            a.get("sampleRate").unwrap().as_u32().unwrap(),
            a.get("channels").unwrap().as_u32().unwrap(),
        )
    });
    let mut enc = h264enc::Encoder::new(h264enc::Config {
        width: w,
        height: h,
        fps: Ratio::integer(script.fps),
        bitrate_kbps: 500,
        gop: 0,
        threads: 1,
        ..h264enc::Config::default()
    })
    .unwrap();
    let mut avcc = enc.avcc();
    if script.duplicate_parameter_set_headers {
        let mut cfg = h264::AvcConfig::parse(&avcc).unwrap();
        cfg.sps[0].insert(0, 0x67);
        cfg.pps[0].insert(0, 0x68);
        avcc = cfg.to_bytes().unwrap();
    }
    let mut cfg = vec![slrw::CONFIG_AVCC];
    cfg.extend_from_slice(&avcc);
    tx.send_binary(&protocol::record(Kind::H264Config, clock(), &cfg))
        .unwrap();
    let start = Instant::now();
    let mut answered = 0;
    let mut since_key = usize::MAX - 1;
    for i in 0..script.frames {
        let due = start + Duration::from_micros(i as u64 * 1_000_000 / script.fps as u64);
        std::thread::sleep(due.saturating_duration_since(Instant::now()));
        let pts = clock();
        let requests = seen.0.lock().unwrap().keyframe_requests;
        let requested = requests > answered;
        answered = requests;
        let mut f = Yuv420Frame::new(w, h);
        for (k, y) in f.y.iter_mut().enumerate() {
            *y = ((k as u32 / 4 + i as u32 * 3) % 200 + 16) as u8;
        }
        let out = enc
            .encode(&f, requested || since_key + 1 >= key_interval)
            .unwrap();
        since_key = if out.keyframe { 0 } else { since_key + 1 };
        if requested && out.keyframe {
            seen.0.lock().unwrap().requested_idrs += 1;
        }
        let mut payload = vec![if out.keyframe { slrw::H264_KEYFRAME } else { 0 }];
        payload.extend_from_slice(&out.data);
        let msg = match (&script.bad_record, i) {
            (Some(bad), 1) => bad.clone(),
            _ => protocol::record(Kind::H264, pts, &payload),
        };
        if tx.send_binary(&msg).is_err() {
            return;
        }
        seen.0.lock().unwrap().frames_sent += 1;
        if let Some((rate, ch)) = audio {
            let n = (rate / script.fps) as usize;
            let pcm: Vec<u8> = (0..n * ch as usize)
                .flat_map(|k| (((k as f64 * 0.05).sin() * 4000.0) as i16).to_le_bytes())
                .collect();
            let _ = tx.send_binary(&protocol::record(Kind::Audio, pts, &pcm));
        }
    }
}

fn never() -> crate::util::stop::Stop {
    crate::util::stop::Stop::new()
}

fn config(receivers: &[&str]) -> PageConfig {
    PageConfig {
        fps: 30.0,
        audio: true,
        sample_rate: 48_000,
        channels: 2,
        receivers: receivers.iter().map(|s| s.to_string()).collect(),
    }
}

fn plan(w: u32, h: u32, key_interval: u32, audio: bool) -> SharePlan {
    SharePlan {
        width: w,
        height: h,
        fps: 30.0,
        bitrate_bps: 1_000_000,
        key_interval,
        audio: audio.then_some((48_000, 2)),
        content: crate::browser::layout::Rect {
            x: 0,
            y: 0,
            width: w,
            height: h,
        },
    }
}

fn input_opts(audio: bool) -> ShareInputOptions {
    ShareInputOptions {
        fps: Ratio::integer(30),
        audio: audio.then(|| "48000:2:s16le".parse().unwrap()),
        audio_families: if audio {
            vec![(AudioFamily::AirPlay, AudioOut::Pcm { frame_samples: 352 })]
        } else {
            Vec::new()
        },
    }
}

fn drain(input: &mut ShareInput) -> Vec<EncodedFrame> {
    let mut out = Vec::new();
    while let Some(f) = input.next_frame().unwrap() {
        out.push(f);
    }
    out
}

#[test]
fn streams_video_and_pcm_until_the_share_ends() {
    let server = ShareServer::bind(0).unwrap();
    server.configure(&config(&["TV"]));
    let page = spawn_page(server.ws_url(), PageScript::default());
    let cap = server.wait_capture(&never()).unwrap();
    assert_eq!((cap.width, cap.height, cap.audio), (640, 360, true));
    assert_eq!(cap.surface.as_deref(), Some("browser"));
    // The source's SPS says 30 fps; retain the negotiated rate instead.
    let mut p = plan(320, 180, 15, true);
    p.fps = 15.0;
    let mut opts = input_opts(true);
    opts.fps = Ratio::integer(15);
    let mut input = server.start(&p, opts, never()).unwrap();
    let info = input.info().clone();
    assert_eq!((info.video.width, info.video.height), (320, 180));
    assert_eq!(info.video.fps, Ratio::integer(15));
    assert_eq!(info.audio.len(), 1);
    assert!(
        input.describe().contains("Chrome 131"),
        "{}",
        input.describe()
    );
    let frames = drain(&mut input);
    let video: Vec<_> = frames
        .iter()
        .filter(|f| f.track == TrackKind::Video)
        .collect();
    let audio = frames.len() - video.len();
    assert_eq!(video.len(), 30);
    assert!(video[0].keyframe && video[15].keyframe && !video[1].keyframe);
    assert!(video.windows(2).all(|w| w[0].pts < w[1].pts));
    // 30 frames of 1600 samples = 48000 samples in 352-sample frames.
    assert!((130..=137).contains(&audio), "{audio}");
    Box::new(input).finish(true).unwrap();
    let seen = page.join().unwrap();
    assert_eq!(seen.frames_sent, 30);
    assert_eq!(
        seen.config.unwrap().get("sampleRate").unwrap().as_u32(),
        Some(48_000)
    );
    assert_eq!(seen.plan.unwrap().get("width").unwrap().as_u32(), Some(320));
    // The page ended the share itself: it gets no `end`, just the close.
    assert!(seen.closed && seen.end.is_none());
}

#[test]
fn streams_with_duplicated_parameter_set_headers() {
    let server = ShareServer::bind(0).unwrap();
    server.configure(&config(&[]));
    let page = spawn_page(
        server.ws_url(),
        PageScript {
            frames: 2,
            audio: false,
            duplicate_parameter_set_headers: true,
            ..PageScript::default()
        },
    );
    server.wait_capture(&never()).unwrap();
    let mut input = server
        .start(&plan(160, 96, 30, false), input_opts(false), never())
        .unwrap();
    let info = input.info();
    assert_eq!((info.video.width, info.video.height), (160, 96));
    assert_eq!(info.video.fps, Ratio::integer(30));
    let cfg = h264::AvcConfig::parse(&info.video.avcc).unwrap();
    let sps = h264::parse_sps(&cfg.sps[0]).unwrap();
    assert_eq!((sps.width, sps.height, cfg.length_size), (160, 96, 4));
    let frames = drain(&mut input);
    assert_eq!(frames.len(), 2);
    assert!(frames[0].keyframe && !frames[1].keyframe);
    assert!(frames[1].pts > frames[0].pts);
    Box::new(input).finish(true).unwrap();
    assert_eq!(page.join().unwrap().frames_sent, 2);
}

#[test]
fn keyframes_on_request() {
    let server = ShareServer::bind(0).unwrap();
    server.configure(&config(&[]));
    let page = spawn_page(
        server.ws_url(),
        PageScript {
            frames: 60,
            audio: false,
            ..PageScript::default()
        },
    );
    server.wait_capture(&never()).unwrap();
    // No periodic IDRs: every keyframe after the first was asked for.
    let mut input = server
        .start(&plan(160, 96, 100_000, false), input_opts(false), never())
        .unwrap();
    let mut keys = 0;
    let mut n = 0;
    let mut asked_at = None;
    while let Some(f) = input.next_frame().unwrap() {
        n += 1;
        keys += f.keyframe as usize;
        if n == 10 {
            assert!(input.request_keyframe());
            // Coalesced: a second request right away is not sent.
            assert!(input.request_keyframe());
            asked_at = Some(n);
        }
    }
    assert!(asked_at.is_some());
    assert_eq!(keys, 2, "the first IDR and the requested one");
    drop(input);
    let seen = page.join().unwrap();
    assert_eq!(seen.keyframe_requests, 1);
    assert_eq!(seen.requested_idrs, 1);
}

#[test]
fn a_second_page_is_busy_and_a_closed_page_ends_the_input() {
    let server = ShareServer::bind(0).unwrap();
    server.configure(&config(&[]));
    let first = spawn_page(
        server.ws_url(),
        PageScript {
            frames: 45,
            audio: false,
            send_ended: false,
            ..PageScript::default()
        },
    );
    server.wait_capture(&never()).unwrap();
    let second = spawn_page(server.ws_url(), PageScript::default());
    let seen2 = second.join().unwrap();
    assert!(seen2.busy && seen2.plan.is_none() && seen2.closed);
    let mut input = server
        .start(&plan(160, 96, 30, false), input_opts(false), never())
        .unwrap();
    // The page closes its socket without `ended`: the input ends.
    let frames = drain(&mut input);
    assert_eq!(frames.len(), 45);
    drop(input);
    let seen = first.join().unwrap();
    assert!(seen.closed);
}

#[test]
fn a_bad_record_fails_the_input() {
    let server = ShareServer::bind(0).unwrap();
    server.configure(&config(&[]));
    let page = spawn_page(
        server.ws_url(),
        PageScript {
            frames: 10,
            audio: false,
            bad_record: Some(protocol::record(Kind::H264, 1, &[0, 0, 0, 0, 9, 1])),
            ..PageScript::default()
        },
    );
    server.wait_capture(&never()).unwrap();
    let mut input = server
        .start(&plan(160, 96, 30, false), input_opts(false), never())
        .unwrap();
    let mut err = None;
    for _ in 0..20 {
        match input.next_frame() {
            Ok(Some(_)) => {}
            Ok(None) => break,
            Err(e) => {
                err = Some(e);
                break;
            }
        }
    }
    assert!(err.is_some(), "a truncated AVCC unit must fail the stream");
    drop(input);
    page.join().unwrap();
}

#[test]
fn ended_before_the_plan_lets_another_capture_take_over() {
    let server = ShareServer::bind(0).unwrap();
    server.configure(&config(&[]));
    let url = server.ws_url();
    // A page that captures, then stops before tvpipe sends a plan.
    let (mut rx, tx) =
        websocket::connect(&url, Duration::from_secs(10), websocket::Limits::default()).unwrap();
    tx.send_text(r#"{"type":"hello","version":1,"clock":1}"#)
        .unwrap();
    tx.send_text(r#"{"type":"capture","width":320,"height":200,"audio":false}"#)
        .unwrap();
    assert_eq!(server.wait_capture(&never()).unwrap().height, 200);
    tx.send_text(r#"{"type":"ended","reason":"changed my mind"}"#)
        .unwrap();
    // The server closes that connection; read until it does.
    while !matches!(rx.read_message(), Ok(Message::Close(_)) | Err(_)) {}
    let deadline = Instant::now() + Duration::from_secs(10);
    while server.shared.lock().capture.is_some() {
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(10));
    }
    let page = spawn_page(
        url,
        PageScript {
            frames: 5,
            audio: false,
            capture: (800, 600),
            ..PageScript::default()
        },
    );
    assert_eq!(server.wait_capture(&never()).unwrap().height, 600);
    let mut input = server
        .start(&plan(160, 120, 30, false), input_opts(false), never())
        .unwrap();
    assert_eq!(drain(&mut input).len(), 5);
    drop(input);
    page.join().unwrap();
}

#[test]
fn rejoin_mode_keeps_streaming_across_pages() {
    let server = ShareServer::bind(0).unwrap();
    server.set_rejoin(true);
    server.configure(&config(&[]));
    let handle = server.handle();
    assert_eq!(handle.ws_url(), server.ws_url());
    let url = server.ws_url();
    let script = PageScript {
        frames: 20,
        audio: true,
        send_ended: false,
        ..PageScript::default()
    };
    let first = spawn_page(url.clone(), script.clone());
    server.wait_capture(&never()).unwrap();
    let mut input = server
        .start(&plan(160, 96, 10, true), input_opts(true), never())
        .unwrap();
    let mut frames = Vec::new();
    // The first page streams and closes (a navigation): the input waits.
    let mut second = None;
    let deadline = Instant::now() + Duration::from_secs(30);
    let mut video = 0;
    while video < 40 {
        assert!(Instant::now() < deadline, "only {video} video frames");
        let f = input.next_frame().unwrap().expect("the input ended");
        if f.track == TrackKind::Video {
            video += 1;
        }
        frames.push(f);
        if video == 20 && second.is_none() {
            // A new document of the same tab shares again, with another
            // capture size: its plan is the same frame, its content placed.
            second = Some(spawn_page(
                url.clone(),
                PageScript {
                    capture: (320, 240),
                    ..script.clone()
                },
            ));
        }
    }
    handle.end("the browser was closed");
    let rest = drain(&mut input);
    frames.extend(rest);
    let video: Vec<_> = frames
        .iter()
        .filter(|f| f.track == TrackKind::Video)
        .collect();
    assert_eq!(video.len(), 40);
    assert!(
        video[0].keyframe && video[20].keyframe,
        "each page starts with an IDR"
    );
    assert!(
        video.windows(2).all(|w| w[0].pts < w[1].pts),
        "one timeline"
    );
    assert!(frames.iter().any(|f| f.track != TrackKind::Video));
    drop(input);
    let seen1 = first.join().unwrap();
    let seen2 = second.unwrap().join().unwrap();
    assert!(!seen1.busy && !seen2.busy);
    let p2 = seen2.plan.unwrap();
    assert_eq!(p2.get("width").unwrap().as_u32(), Some(160));
    let content = p2.get("content").unwrap();
    // 320x240 in 160x96: pillarboxed.
    assert_eq!(content.get("height").unwrap().as_u32(), Some(96));
    assert_eq!(content.get("width").unwrap().as_u32(), Some(128));
}

#[test]
fn a_failed_source_ends_the_wait_and_the_input() {
    let server = ShareServer::bind(0).unwrap();
    server.set_rejoin(true);
    server.configure(&config(&[]));
    let handle = server.handle();
    let h = handle.clone();
    let t = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(100));
        h.fail(Error::process("the browser died 4 times"));
    });
    assert!(server.wait_capture(&never()).is_none());
    t.join().unwrap();
    let e = server.failure().unwrap();
    assert_eq!(e.kind(), ErrorKind::Process);
    assert!(e.to_string().contains("died 4 times"));

    // Mid-stream: the input fails with it.
    let server = ShareServer::bind(0).unwrap();
    server.set_rejoin(true);
    server.configure(&config(&[]));
    let handle = server.handle();
    let page = spawn_page(
        server.ws_url(),
        PageScript {
            frames: 10,
            audio: false,
            send_ended: false,
            ..PageScript::default()
        },
    );
    server.wait_capture(&never()).unwrap();
    let mut input = server
        .start(&plan(160, 96, 30, false), input_opts(false), never())
        .unwrap();
    let mut n = 0;
    let err = loop {
        match input.next_frame() {
            Ok(Some(_)) => {
                n += 1;
                if n == 10 {
                    handle.fail(Error::process("gave up"));
                }
            }
            Ok(None) => panic!("ended instead of failing"),
            Err(e) => break e,
        }
    };
    assert!(err.to_string().contains("gave up"), "{err}");
    drop(input);
    page.join().unwrap();
}

fn http_get(addr: SocketAddr, target: &str, host: &str) -> (u16, String) {
    let mut s = TcpStream::connect(addr).unwrap();
    s.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
    write!(
        s,
        "GET {target} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n"
    )
    .unwrap();
    let mut out = String::new();
    let _ = s.read_to_string(&mut out);
    let status = out.get(9..12).and_then(|c| c.parse().ok()).unwrap_or(0);
    (status, out)
}

#[test]
fn page_server_checks_token_and_host() {
    let server = ShareServer::bind(0).unwrap();
    let url = server.url().to_owned();
    let port: u16 = url
        .trim_start_matches("http://127.0.0.1:")
        .split('/')
        .next()
        .unwrap()
        .parse()
        .unwrap();
    let addr: SocketAddr = ([127, 0, 0, 1], port).into();
    let host = format!("127.0.0.1:{port}");
    let query = &url[url.find('?').unwrap()..];
    let (st, body) = http_get(addr, &format!("/{query}"), &host);
    assert_eq!(st, 200);
    assert!(body.contains("tvpipe share") && body.contains("/capture.js"));
    assert!(body.contains("href=\"/ui.css\""));
    // tvpipe's look, without the token like the fonts.
    let (st, body) = http_get(addr, "/ui.css", &host);
    assert_eq!(st, 200);
    assert!(body.contains("Content-Type: text/css") && body.contains("url(fonts/michroma.woff2)"));
    let (st, body) = http_get(addr, "/capture.js", &format!("localhost:{port}"));
    assert_eq!(st, 200);
    assert!(body.contains("tvpipeCapture"));
    assert!(body.contains("Content-Type: text/javascript"));
    // No token, a wrong token, a foreign Host (DNS rebinding).
    assert_eq!(http_get(addr, "/", &host).0, 403);
    assert_eq!(http_get(addr, "/?t=00", &host).0, 403);
    assert_eq!(
        http_get(addr, &format!("/{query}"), "evil.example:80").0,
        421
    );
    assert_eq!(http_get(addr, &format!("/ws{query}"), &host).0, 404);
    assert_eq!(http_get(addr, "/nothing", &host).0, 403);
    // The WebSocket needs the token too.
    let bad = format!("ws://127.0.0.1:{port}/ws?t=1234");
    assert!(
        websocket::connect(&bad, Duration::from_secs(10), websocket::Limits::default()).is_err()
    );
    assert!(websocket::connect(
        &server.ws_url(),
        Duration::from_secs(10),
        websocket::Limits::default()
    )
    .is_ok());
}

#[test]
fn square_pixel_check() {
    // The built-in encoder writes no aspect ratio: fine.
    let enc = h264enc::Encoder::new(h264enc::Config {
        width: 64,
        height: 48,
        ..h264enc::Config::default()
    })
    .unwrap();
    assert_eq!(square_pixels(&enc.avcc()), None);
    // An avcC around x264's SPS with SAR 4:3 (see h264's KATs) is flagged.
    let sps =
        crate::util::hex::decode("6764000bacd942847e5c3840000003004000000f03c50a6580").unwrap();
    let cfg = h264::AvcConfig::from_parameter_sets(
        vec![sps],
        vec![vec![0x68, 0xeb, 0xe3, 0xcb, 0x22, 0xc0]],
    )
    .unwrap()
    .to_bytes()
    .unwrap();
    assert_eq!(square_pixels(&cfg), Some((4, 3)));
}

// Captured from Firefox 160 on Linux, WebCodecs avc1.42E028, 1920x1080.
const FIREFOX_AVCC: &str =
    "0142c02803010019676742c028d900780227e5840000030004007a12003c60c9200100056868cb8cb2";

#[test]
fn repairs_firefox_avcc_without_weakening_sps_validation() {
    let raw = crate::util::hex::decode(FIREFOX_AVCC).unwrap();
    let mut cfg = h264::AvcConfig::parse(&raw).unwrap();
    assert!(h264::parse_sps(&cfg.sps[0]).is_err());
    assert!(repair_firefox_avcc(&mut cfg));
    let fixed = cfg.to_bytes().unwrap();
    assert_eq!(
        crate::util::hex::encode(&fixed),
        "0142c028ffe100186742c028d900780227e5840000030004007a12003c60c92001000468cb8cb2"
    );
    let parsed = h264::AvcConfig::parse(&fixed).unwrap();
    let sps = h264::parse_sps(&parsed.sps[0]).unwrap();
    assert_eq!((sps.width, sps.height, parsed.length_size), (1920, 1080, 4));
    assert_eq!(sps.fps, Some(Ratio::integer(1_000_000)));
    assert!(!repair_firefox_avcc(&mut cfg));
    assert_eq!(cfg.to_bytes().unwrap(), fixed);
}

#[test]
fn avcc_repair_requires_the_complete_signature_and_a_valid_sps() {
    let raw = crate::util::hex::decode(FIREFOX_AVCC).unwrap();
    let original = h264::AvcConfig::parse(&raw).unwrap();
    let mut mismatch = original.clone();
    mismatch.profile_idc ^= 1;
    let mut truncated = original.clone();
    truncated.sps[0].truncate(5);
    let mut normal_pps = original.clone();
    normal_pps.pps[0].remove(0);
    // A PPS can legitimately begin 68 68: a valid SPS must keep it intact.
    let mut normal_sps = original.clone();
    normal_sps.sps[0].remove(0);
    let mut empty = original.clone();
    empty.sps.clear();
    let mut multiple = original.clone();
    multiple.sps.push(original.sps[0].clone());
    for mut cfg in [mismatch, truncated, normal_pps, normal_sps, empty, multiple] {
        let before = cfg.clone();
        assert!(!repair_firefox_avcc(&mut cfg));
        assert_eq!(cfg, before);
    }
}

#[test]
fn reframes_short_lengths() {
    let p = [1u8, 0, 3, 0x65, 0xaa, 0xbb, 0, 1, 0x41];
    assert_eq!(
        reframe(&p, 2).unwrap(),
        [1, 0, 0, 0, 3, 0x65, 0xaa, 0xbb, 0, 0, 0, 1, 0x41]
    );
    assert!(reframe(&[1, 0, 9, 0x65], 2).is_err());
}

#[test]
fn silent_sound_is_noted_once() {
    let stats = |kbps: f64, peak: Option<f64>| {
        let v = Value::object().with("audioKbps", kbps);
        match peak {
            Some(p) => v.with("audioPeak", p),
            None => v,
        }
    };
    let mut s = Sound::default();
    for _ in 0..SILENT_REPORTS - 1 {
        assert!(!s.stats(&stats(1536.0, Some(0.0))));
    }
    // No sound flowing, or an older page without the field: not counted.
    assert!(!s.stats(&stats(0.0, Some(0.0))));
    assert!(!s.stats(&stats(1536.0, None)));
    assert!(s.stats(&stats(1536.0, Some(0.0))));
    assert!(!s.stats(&stats(1536.0, Some(0.0))));

    // Sound heard once: silence later is fine.
    let mut s = Sound::default();
    assert!(!s.stats(&stats(1536.0, Some(0.25))));
    for _ in 0..2 * SILENT_REPORTS {
        assert!(!s.stats(&stats(1536.0, Some(0.0))));
    }
}
