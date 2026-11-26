//! A fake mirroring receiver for loop tests (test-only): plain RTSP
//! control (the tests skip pairing and hand the session a fixed shared
//! secret), the HAP-profile media ciphers, an encrypted event channel,
//! a video data port that decrypts what it gets, and audio RTP/RTCP
//! sockets. Behaviour follows the Apple TV as the spec describes it.
//!
//! [`FakeMirror::vanish`] makes the sessions so far go dark, like a
//! receiver that left the network (the control connections break, the
//! data connection stays open but is no longer read); new connections
//! are new sessions, unless [`FakeMirror::set_refusing`] turns them away.
//!
//! Sources: docs/airplay-mirroring.md §4, §6, §8, §9, §11.

#![cfg(test)]

use std::io::Read;
use std::net::{SocketAddr, TcpListener, TcpStream, UdpSocket};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use crate::airplay::keys;
use crate::airplay::secure::SecureStream;
use crate::codec::bplist::Plist;
use crate::crypto::aes::Aes;
use crate::crypto::modes::{cbc_decrypt, Ctr};
use crate::crypto::ring::{nonce_counter, ChaCha20Poly1305};
use crate::net::http::{Conn, Request, Response};

/// The Apple TV's features without FairPlay (the fake cannot do it).
pub const FEATURES: u64 = 0x3c17_7fde_4a7f_dfd5 & !(1 << 14);
pub const CLOCK_ID: u64 = 0xaabb_ccff_fe00_000a;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VideoPacket {
    pub kind: u8,
    pub idr: bool,
    pub ts: u64,
    pub timeline: u64,
    /// Decrypted payload.
    pub payload: Vec<u8>,
    /// The session (0, then 1 after a [`FakeMirror::vanish`], ...).
    pub session: usize,
}

#[derive(Debug, Default)]
pub struct Recorded {
    pub requests: Vec<String>,
    pub setup_bodies: Vec<Plist>,
    pub video: Vec<VideoPacket>,
    /// (seq, rtp ts, decrypted payload after the RFC 2198 header byte).
    pub audio: Vec<(u16, u32, Vec<u8>)>,
    pub sync: Vec<Vec<u8>>,
    pub retransmits: Vec<Vec<u8>>,
    /// UDP packets from someone other than our sender, ignored: a sink of
    /// another test still sending to a port that was freed and then
    /// given to this fake (both bind 127.0.0.1:0).
    pub strays: usize,
    pub event_replies: usize,
    pub teardown: bool,
    /// The last TEARDOWN's `Content-Type` and body.
    pub teardown_body: Option<(Option<String>, Vec<u8>)>,
}

/// How the fake behaves.
#[derive(Debug, Clone)]
pub struct Behaviour {
    /// Refuse the control-first SETUP with this status (media-first).
    pub refuse_session_setup: Option<u16>,
    /// Close the data connection after this many video packets.
    pub close_after_packets: Option<usize>,
    /// Ask for retransmission of audio seq 1..2 after this many packets.
    pub nack_after: Option<usize>,
    /// Close the control connection instead of answering TEARDOWN.
    pub teardown_eof: bool,
    /// Send `forceKeyFrame` on the event channel once video flows.
    pub force_keyframe: bool,
    /// Omit the `X-Apple-*` timing headers (like the modelled LG and the
    /// reported Samsung Frame).
    pub no_timing_headers: bool,
    /// Omit them only on SETUP responses: PTP fails although `/info`
    /// promised anchors (exercises the §2.5 reconnect).
    pub no_setup_timing_headers: bool,
    /// After answering a PTP session SETUP, answer nothing for this long,
    /// on any connection (the reported Samsung Frame: TEARDOWN and the
    /// next pair-verify go unanswered, §10).
    pub deaf_after_ptp: Option<Duration>,
    /// Accept the data connection but never read from it.
    pub stall_data: bool,
    /// Legacy profile with these FairPlay keys (`K`, `eiv`): plaintext
    /// events, AES-CTR video, AES-CBC audio.
    pub legacy: Option<([u8; 16], [u8; 16])>,
    /// Answer raw (legacy) pair-setup/verify with this Ed25519 seed.
    pub raw_pairing: Option<[u8; 32]>,
    /// Legacy without FairPlay: audio in the clear (video keyed from `shk`).
    pub legacy_no_fairplay: bool,
    /// Never answer `POST /feedback` (a wedged receiver).
    pub hang_feedback: bool,
    /// Advertise FairPlay (feature 14). The fake cannot do it, so both
    /// `/fp-setup` requests get 404 (a FairPlay build goes on without).
    pub fairplay_bit: bool,
    /// `manufacturer` in `/info` (default: none, as the Apple TV).
    pub manufacturer: Option<&'static str>,
    /// The display it reports once a session exists: nominal and
    /// decoder-maximum pixels and `maxFPS` (default: the dev Apple TV's
    /// 1280x720, 3840x2160 max, 60 fps).
    pub display: Display,
    /// An audio-only speaker (like a Devialet Phantom): no screen
    /// mirroring bit, and a video SETUP answered without `dataPort`.
    pub speaker: bool,
}

/// A display in `/info` (`displays[0]`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Display {
    pub size: (u32, u32),
    pub max: (u32, u32),
    pub max_fps: u32,
}

impl Default for Display {
    fn default() -> Display {
        Display {
            size: (1280, 720),
            max: (3840, 2160),
            max_fps: 60,
        }
    }
}

impl Default for Behaviour {
    fn default() -> Behaviour {
        Behaviour {
            refuse_session_setup: None,
            close_after_packets: None,
            nack_after: Some(5),
            teardown_eof: false,
            force_keyframe: false,
            no_timing_headers: false,
            no_setup_timing_headers: false,
            deaf_after_ptp: None,
            stall_data: false,
            legacy: None,
            raw_pairing: None,
            legacy_no_fairplay: false,
            hang_feedback: false,
            fairplay_bit: false,
            manufacturer: None,
            display: Display::default(),
            speaker: false,
        }
    }
}

pub struct FakeMirror {
    pub addr: SocketAddr,
    pub rec: Arc<Mutex<Recorded>>,
    pub secret: Vec<u8>,
    ctx: Arc<Ctx>,
}

struct Ctx {
    rec: Arc<Mutex<Recorded>>,
    secret: Vec<u8>,
    behaviour: Behaviour,
    audio_key: Mutex<Option<[u8; 32]>>,
    session: AtomicBool,
    close_data: Arc<AtomicBool>,
    raw: Mutex<Option<crate::airplay::legacy_pair::fake::RawReceiver>>,
    /// Bumped by `vanish`: connections of older generations are dark.
    generation: AtomicUsize,
    refusing: AtomicBool,
    /// Requests until then go unanswered (`deaf_after_ptp`).
    deaf_until: Mutex<Option<Instant>>,
}

impl Ctx {
    fn gone(&self, generation: usize) -> bool {
        self.generation.load(Ordering::Acquire) != generation
    }
}

impl FakeMirror {
    pub fn start(behaviour: Behaviour) -> FakeMirror {
        crate::util::timer::raise_resolution();
        let behaviour_raw = behaviour.raw_pairing;
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let secret: Vec<u8> = (0x40u8..0x60).collect();
        let rec = Arc::new(Mutex::new(Recorded::default()));
        let ctx = Arc::new(Ctx {
            rec: rec.clone(),
            secret: secret.clone(),
            behaviour,
            audio_key: Mutex::new(None),
            session: AtomicBool::new(false),
            close_data: Arc::new(AtomicBool::new(false)),
            raw: Mutex::new(behaviour_raw.map(crate::airplay::legacy_pair::fake::RawReceiver::new)),
            generation: AtomicUsize::new(0),
            refusing: AtomicBool::new(false),
            deaf_until: Mutex::new(None),
        });
        let accept = ctx.clone();
        thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(stream) = stream else { break };
                if accept.refusing.load(Ordering::Acquire) {
                    continue; // dropped: the sender sees EOF
                }
                let ctx = accept.clone();
                thread::spawn(move || {
                    let _ = serve(stream, &ctx);
                });
            }
        });
        FakeMirror {
            addr,
            rec,
            secret,
            ctx,
        }
    }

    /// The sessions so far go dark (see the module docs).
    pub fn vanish(&self) {
        self.ctx.generation.fetch_add(1, Ordering::AcqRel);
    }

    /// Closes new connections at once (an address nobody serves).
    pub fn set_refusing(&self, refusing: bool) {
        self.ctx.refusing.store(refusing, Ordering::Release);
    }

    pub fn rec(&self) -> std::sync::MutexGuard<'_, Recorded> {
        self.rec.lock().unwrap()
    }
}

fn reply(req: &Request, status: u16, body: Option<Plist>) -> Response {
    let mut r = Response::new(
        req.version,
        status,
        if status == 200 { "OK" } else { "Error" },
    );
    if let Some(c) = req.headers.get("cseq") {
        r.headers.set("CSeq", c);
    }
    r.headers.set("Server", "AirTunes/960.13.1");
    r.headers
        .set("X-Apple-RequestReceivedTimestamp", "1201707321");
    r.headers.set("X-Apple-ProcessingTime", "127");
    if let Some(b) = body {
        r.headers
            .set("Content-Type", "application/x-apple-binary-plist");
        r.body = b.to_bytes();
    }
    r
}

fn info(display: Option<Display>, behaviour: &Behaviour) -> Plist {
    let features = if behaviour.fairplay_bit {
        FEATURES | 1 << 14
    } else {
        FEATURES
    };
    let features = if behaviour.speaker {
        features & !(1 << 7)
    } else {
        features
    };
    let mut p = Plist::dict()
        .with("model", "AppleTV6,2")
        .with("name", "Fake TV")
        .with("deviceID", "AA:BB:CC:00:00:0A")
        .with("features", features as i64)
        .with("sourceVersion", "960.13.1")
        .with("initialVolume", 0.0)
        .with(
            "supportedFormats",
            Plist::dict().with("screenStream", 0x144_0800i64),
        );
    if let Some(m) = behaviour.manufacturer {
        p = p.with("manufacturer", m);
    }
    if let Some(d) = display {
        p = p.with(
            "displays",
            Plist::array([Plist::dict()
                .with("widthPixels", d.size.0 as i64)
                .with("heightPixels", d.size.1 as i64)
                .with("widthPixelsMax", d.max.0 as i64)
                .with("heightPixelsMax", d.max.1 as i64)
                .with("maxFPS", d.max_fps as i64)]),
        );
    }
    p
}

fn serve(stream: TcpStream, ctx: &Arc<Ctx>) -> crate::error::Result<()> {
    let generation = ctx.generation.load(Ordering::Acquire);
    let mut conn = Conn::new(stream);
    loop {
        let req = conn.read_request()?;
        if ctx.gone(generation) {
            return Ok(()); // vanished: the connection breaks
        }
        ctx.rec
            .lock()
            .unwrap()
            .requests
            .push(format!("{} {}", req.method, req.target));
        if ctx.behaviour.hang_feedback && req.target == "/feedback" {
            thread::sleep(Duration::from_secs(40));
            return Ok(());
        }
        if req.method == "TEARDOWN" {
            let mut rec = ctx.rec.lock().unwrap();
            rec.teardown = true;
            let ct = req.headers.get("content-type").map(str::to_owned);
            rec.teardown_body = Some((ct, req.body.clone()));
            drop(rec);
            ctx.close_data.store(true, Ordering::Release);
            if ctx.behaviour.teardown_eof {
                return Ok(());
            }
        }
        if ctx
            .deaf_until
            .lock()
            .unwrap()
            .is_some_and(|t| Instant::now() < t)
        {
            continue;
        }
        let mut resp = handle(&req, ctx);
        if ctx.behaviour.no_timing_headers
            || (ctx.behaviour.no_setup_timing_headers && req.method == "SETUP")
        {
            resp.headers.remove("X-Apple-RequestReceivedTimestamp");
            resp.headers.remove("X-Apple-ProcessingTime");
        }
        conn.send_response(&resp)?;
        if let Some(d) = ctx.behaviour.deaf_after_ptp {
            let ptp_session = req.method == "SETUP"
                && Plist::from_bytes(&req.body)
                    .is_ok_and(|b| b.get("timingProtocol").and_then(Plist::as_str) == Some("PTP"));
            if ptp_session {
                *ctx.deaf_until.lock().unwrap() = Some(Instant::now() + d);
            }
        }
    }
}

fn handle(req: &Request, ctx: &Arc<Ctx>) -> Response {
    match req.method.as_str() {
        "GET" if req.target == "/info" => reply(
            req,
            200,
            Some(info(
                ctx.session
                    .load(Ordering::Acquire)
                    .then_some(ctx.behaviour.display),
                &ctx.behaviour,
            )),
        ),
        "RECORD" => {
            let mut r = reply(req, 200, None);
            r.headers.set("Audio-Latency", "0");
            r
        }
        "POST" if req.target == "/feedback" => reply(
            req,
            200,
            Some(Plist::dict().with("streams", Plist::array(Vec::<Plist>::new()))),
        ),
        "TEARDOWN" | "SET_PARAMETER" => reply(req, 200, None),
        "POST" if req.target == "/pair-setup" || req.target == "/pair-verify" => {
            let mut raw = ctx.raw.lock().unwrap();
            let out = raw.as_mut().and_then(|r| {
                if req.target == "/pair-setup" {
                    r.setup(&req.body)
                } else {
                    r.verify(&req.body)
                }
            });
            match out {
                Some(body) => {
                    let mut r = reply(req, 200, None);
                    r.body = body;
                    r
                }
                None => reply(req, 470, None),
            }
        }
        "SETUP" => {
            let body = Plist::from_bytes(&req.body).unwrap();
            ctx.rec.lock().unwrap().setup_bodies.push(body.clone());
            let stream = body
                .get("streams")
                .and_then(Plist::as_array)
                .and_then(|a| a.first())
                .cloned();
            let session_keys = body.get("sessionUUID").is_some();
            if session_keys && stream.is_none() {
                if let Some(s) = ctx.behaviour.refuse_session_setup {
                    return reply(req, s, None);
                }
            }
            let mut out = Plist::dict();
            if session_keys {
                ctx.session.store(true, Ordering::Release);
                ctx.close_data.store(false, Ordering::Release);
                out = out.with("eventPort", event_server(ctx) as i64).with(
                    "timingPeerInfo",
                    Plist::dict().with("ClockID", CLOCK_ID as i64),
                );
            }
            match stream
                .as_ref()
                .and_then(|s| s.get("type"))
                .and_then(Plist::as_i128)
            {
                Some(96) => {
                    let s = stream.unwrap();
                    *ctx.audio_key.lock().unwrap() = s
                        .get("shk")
                        .and_then(Plist::as_data)
                        .map(|k| k.try_into().unwrap());
                    let ctl_port = s
                        .get("streamConnections")
                        .and_then(|c| c.get("streamConnectionTypeRTCP"))
                        .and_then(|c| c.get("streamConnectionKeyPort"))
                        .and_then(Plist::as_i128)
                        .unwrap() as u16;
                    let (rtp, rtcp) = audio_server(ctx, ctl_port);
                    out = out.with(
                        "streams",
                        Plist::array([Plist::dict()
                            .with("type", 96i64)
                            .with("streamID", -5i64)
                            .with(
                                "streamConnections",
                                Plist::dict()
                                    .with(
                                        "streamConnectionTypeRTP",
                                        Plist::dict().with("streamConnectionKeyPort", rtp as i64),
                                    )
                                    .with(
                                        "streamConnectionTypeRTCP",
                                        Plist::dict().with("streamConnectionKeyPort", rtcp as i64),
                                    ),
                            )]),
                    );
                }
                Some(110) if ctx.behaviour.speaker => {
                    out = out.with(
                        "streams",
                        Plist::array([Plist::dict().with("type", 110i64)]),
                    );
                }
                Some(110) => {
                    let s = stream.unwrap();
                    let id = s
                        .get("streamConnectionID")
                        .and_then(Plist::as_i128)
                        .unwrap() as u64;
                    let shk: [u8; 16] = s
                        .get("shk")
                        .and_then(Plist::as_data)
                        .and_then(|k| k.try_into().ok())
                        .unwrap();
                    let port = data_server(ctx, id, shk);
                    out = out.with(
                        "streams",
                        Plist::array([Plist::dict()
                            .with("type", 110i64)
                            .with("dataPort", port as i64)]),
                    );
                }
                _ => {}
            }
            reply(req, 200, Some(out))
        }
        _ => reply(req, 404, None),
    }
}

fn event_server(ctx: &Arc<Ctx>) -> u16 {
    let l = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = l.local_addr().unwrap().port();
    let ctx = ctx.clone();
    thread::spawn(move || {
        let Ok((s, _)) = l.accept() else { return };
        if ctx.behaviour.legacy.is_some() {
            run_events(&mut Conn::new(s), &ctx);
        } else {
            let keys = keys::event_keys(&ctx.secret).unwrap().swapped();
            run_events(&mut Conn::new(SecureStream::new(s, &keys)), &ctx);
        }
    });
    port
}

fn run_events<S: Read + std::io::Write>(conn: &mut Conn<S>, ctx: &Ctx) {
    {
        let body = Plist::dict()
            .with("type", "updateInfo")
            .with("value", info(Some(ctx.behaviour.display), &ctx.behaviour))
            .to_bytes();
        let req = Request::new("POST", "/command", crate::net::http::Version::Rtsp10)
            .header("CSeq", "1")
            .body("application/x-apple-binary-plist", body);
        if conn.request(&req).is_ok_and(|r| r.status == 200) {
            ctx.rec.lock().unwrap().event_replies += 1;
        }
        if ctx.behaviour.force_keyframe {
            while ctx.rec.lock().unwrap().video.is_empty() {
                thread::sleep(Duration::from_millis(5));
            }
            let body = Plist::dict().with("type", "forceKeyFrame").to_bytes();
            let req = Request::new("POST", "/command", crate::net::http::Version::Rtsp10)
                .header("CSeq", "2")
                .body("application/x-apple-binary-plist", body);
            if conn.request(&req).is_ok_and(|r| r.status == 200) {
                ctx.rec.lock().unwrap().event_replies += 1;
            }
        }
        // Keep the channel open until the sender closes it.
        let _ = conn.read_request();
    }
}

fn data_server(ctx: &Arc<Ctx>, stream_id: u64, shk: [u8; 16]) -> u16 {
    let l = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = l.local_addr().unwrap().port();
    let ctx = ctx.clone();
    let generation = ctx.generation.load(Ordering::Acquire);
    thread::spawn(move || {
        let Ok((mut s, _)) = l.accept() else { return };
        if ctx.behaviour.stall_data {
            while !ctx.close_data.load(Ordering::Acquire) {
                thread::sleep(Duration::from_millis(20));
            }
            return;
        }
        s.set_read_timeout(Some(Duration::from_millis(50))).unwrap();
        let key = keys::video_key(&ctx.secret, stream_id).unwrap();
        let cipher = ChaCha20Poly1305::new(&key);
        // Legacy: the receiver derives the CTR key from the `shk` it got.
        let mut ctr = ctx.behaviour.legacy.map(|_| {
            let (key, iv) = keys::legacy_video_key_iv(&shk, stream_id);
            Ctr::with_key(&key, &iv).unwrap()
        });
        let mut counter = 0u64;
        let mut n = 0usize;
        let mut buf = Vec::new();
        let mut chunk = [0u8; 65536];
        loop {
            if ctx.gone(generation) {
                // Dark: hold the connection without reading (no EOF),
                // until the sender closes it or a while passed.
                let _ = s.set_read_timeout(Some(Duration::from_millis(100)));
                for _ in 0..200 {
                    thread::sleep(Duration::from_millis(100));
                    if s.peek(&mut [0u8; 1]).is_ok_and(|n| n == 0) {
                        break;
                    }
                }
                return;
            }
            if ctx.close_data.load(Ordering::Acquire)
                || ctx.behaviour.close_after_packets.is_some_and(|c| n >= c)
            {
                return; // drops the socket: the sender sees EOF
            }
            match s.read(&mut chunk) {
                Ok(0) => return,
                Ok(k) => buf.extend_from_slice(&chunk[..k]),
                Err(_) => continue,
            }
            while buf.len() >= 128 {
                let len = u32::from_le_bytes(buf[..4].try_into().unwrap()) as usize;
                if buf.len() < 128 + len {
                    break;
                }
                let header: Vec<u8> = buf[..128].to_vec();
                let mut payload = buf[128..128 + len].to_vec();
                buf.drain(..128 + len);
                if let (0, Some(ctr)) = (header[4], ctr.as_mut()) {
                    ctr.apply(&mut payload);
                } else if header[4] == 0 {
                    let pt = cipher
                        .open_in_place(&nonce_counter(counter), &header, &mut payload)
                        .expect("video frame authenticates")
                        .to_vec();
                    counter += 1;
                    payload = pt;
                }
                ctx.rec.lock().unwrap().video.push(VideoPacket {
                    kind: header[4],
                    idr: header[5] == 0x10,
                    ts: u64::from_le_bytes(header[8..16].try_into().unwrap()),
                    timeline: u64::from_le_bytes(header[40..48].try_into().unwrap()),
                    payload,
                    session: generation,
                });
                n += 1;
            }
        }
    });
    port
}

fn audio_server(ctx: &Arc<Ctx>, sender_control: u16) -> (u16, u16) {
    let rtp = UdpSocket::bind("127.0.0.1:0").unwrap();
    let rtcp = UdpSocket::bind("127.0.0.1:0").unwrap();
    let ports = (
        rtp.local_addr().unwrap().port(),
        rtcp.local_addr().unwrap().port(),
    );
    let key = *ctx.audio_key.lock().unwrap();
    assert_eq!(key.is_none(), ctx.behaviour.legacy.is_some(), "shk iff HAP");
    {
        let ctx = ctx.clone();
        let rtcp = rtcp.try_clone().unwrap();
        thread::spawn(move || {
            let cipher = key.map(|k| ChaCha20Poly1305::new(&k));
            let cbc = ctx
                .behaviour
                .legacy
                .filter(|_| !ctx.behaviour.legacy_no_fairplay)
                .map(|(k, iv)| (Aes::new(&k).unwrap(), iv));
            let mut buf = [0u8; 2048];
            let mut n = 0usize;
            // Where our sender's audio comes from: the source of the first
            // packet that authenticates.
            let mut sender = None;
            while let Ok((len, from)) = rtp.recv_from(&mut buf) {
                let p = &buf[..len];
                if sender.is_some_and(|s| s != from) || len < 21 {
                    ctx.rec.lock().unwrap().strays += 1;
                    continue;
                }
                let seq = u16::from_be_bytes([p[2], p[3]]);
                let ts = u32::from_be_bytes(p[4..8].try_into().unwrap());
                let clear = if p[1] == 97 { 1 } else { 0 };
                assert!(clear == 0 || p[12] == 0x60, "no redundant blocks expected");
                let body = &p[12 + clear..];
                let pt = match (&cipher, &cbc) {
                    (Some(c), _) => {
                        let opened = body.len().checked_sub(8).ok_or(()).and_then(|tag| {
                            let nonce = u64::from_le_bytes(body[tag..].try_into().unwrap());
                            c.open(&nonce_counter(nonce), &p[4..12], &body[..tag])
                                .map_err(|_| ())
                        });
                        match (opened, sender) {
                            (Ok(pt), _) => {
                                sender = Some(from);
                                pt
                            }
                            // Our sender's packets must all authenticate.
                            (Err(()), Some(_)) => panic!("audio packet does not authenticate"),
                            (Err(()), None) => {
                                ctx.rec.lock().unwrap().strays += 1;
                                continue;
                            }
                        }
                    }
                    (None, Some((aes, iv))) => {
                        let mut b = body.to_vec();
                        let whole = b.len() / 16 * 16;
                        cbc_decrypt(aes, &mut iv.clone(), &mut b[..whole]).unwrap();
                        b
                    }
                    (None, None) => body.to_vec(),
                };
                ctx.rec.lock().unwrap().audio.push((seq, ts, pt));
                n += 1;
                if ctx.behaviour.nack_after == Some(n) {
                    let req = [0x80, 0xd5, 0, 9, 0, 1, 0, 2];
                    let _ = rtcp.send_to(&req, ("127.0.0.1", sender_control));
                }
            }
        });
    }
    {
        let ctx = ctx.clone();
        thread::spawn(move || {
            let mut buf = [0u8; 2048];
            while let Ok((len, from)) = rtcp.recv_from(&mut buf) {
                // Sync and retransmissions come from the sender's control
                // socket.
                if from.port() != sender_control {
                    ctx.rec.lock().unwrap().strays += 1;
                    continue;
                }
                let p = buf[..len].to_vec();
                let mut r = ctx.rec.lock().unwrap();
                if p[1] == 0xd6 {
                    r.retransmits.push(p);
                } else {
                    r.sync.push(p);
                }
            }
        });
    }
    ports
}
