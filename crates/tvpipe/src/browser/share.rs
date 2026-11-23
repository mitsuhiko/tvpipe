//! `tvpipe share`: the page server and the input it feeds (protocol in
//! docs/share-protocol.md).
//!
//! [`ShareServer`] serves the share page, `capture.js` and the page's
//! fonts on 127.0.0.1 and accepts the page's WebSocket at `/ws`. The page
//! and the socket need the session's random token (`?t=`), every request
//! a loopback `Host` (no DNS rebinding). Several pages may connect (a
//! reload, a second tab); the first that starts a capture becomes the
//! source, later ones are told `busy`. The session then sends the page its encode `plan` and turns
//! the server into a [`ShareInput`], which feeds the page's records into
//! the encoded-SLRW state (`media::input::EncodedState`): passthrough
//! H.264, PCM for AirPlay, `aacenc` AAC for Cast. Keyframe requests go
//! back to the page as `keyframe` messages. The input ends when the share
//! ends or the page goes away.
//!
//! With [`ShareServer::set_rejoin`] (the headless browser) a source
//! page that goes away mid-stream does not end the input: tvpipe's
//! browser re-shares after a navigation, a reload or a crash, and the
//! newest page that captures becomes the source and gets the same plan.
//! The stream goes on with a gap; the page's clock is wall-clock time, so
//! the timeline stays continuous. [`ShareHandle::fail`] ends it instead
//! (the browser cannot be brought back).

use std::net::{SocketAddr, TcpStream};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, SyncSender};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use crate::browser::access::{Access, Via};
use crate::browser::fonts;
use crate::browser::protocol::{self, CaptureInfo, PageConfig, PageMsg, Remote, SharePlan};
use crate::codec::json::Value;
use crate::error::{Error, ErrorKind, Result};
use crate::media::h264;
use crate::media::input::{
    AudioOut, EncodedState, Input, Stop, KEYFRAME_REQUEST_INTERVAL, STOP_POLL,
};
use crate::media::slrw::{self, Kind, Packet};
use crate::net::http::Request;
use crate::net::httpd::{self, Reply};
use crate::net::tunnel::{self, Tunnel};
use crate::net::websocket::{self, close_code, Message, Role, Sender};
use crate::opts::{RawAudioSpec, RawVideoSpec};
use crate::types::StreamInfo;
use crate::types::{AudioFamily, EncodedFrame};

pub const PAGE_HTML: &str = include_str!("share.html");
/// The page `tvpipe screen`'s browser shows: capture.js and a line of
/// text; tvpipe starts the capture in it (`browser::screen`).
pub const SCREEN_HTML: &str = include_str!("screen.html");
/// The capture script: self-contained, also injected into pages by the
/// headless-browser mode.
pub const CAPTURE_JS: &str = include_str!("capture.js");

/// Records queued between the page's socket and the session.
const EVENT_QUEUE: usize = 256;
/// How often a page connection checks for shutdown.
const CLIENT_POLL: Duration = Duration::from_millis(200);
/// How long the page may take from the plan to its first keyframe.
const FIRST_KEYFRAME_TIMEOUT: Duration = Duration::from_secs(15);
const LAG_REPORT: Duration = Duration::from_secs(5);
/// Video records left out of the final lag summary (encoder warm-up).
const LAG_WARMUP: u64 = 30;

/// What happened on the source page's socket.
enum Event {
    Packet(Packet),
    Stats(Value),
    Ended(String),
    Failed(Error),
    /// Rejoin mode: the source page went away (why); another may come.
    Detached(String),
    /// Rejoin mode: page `id` captured and is the source now.
    Attached(u64),
}

#[derive(Default)]
struct State {
    next_id: u64,
    clients: Vec<(u64, Sender<TcpStream>)>,
    /// Each page's key for its media socket (`channel`).
    keys: Vec<(u64, String)>,
    /// The `config` message, once the session knows it.
    config: Option<String>,
    /// The last `status` message, for pages that connect later.
    status: Option<String>,
    /// The page whose capture is the source.
    active: Option<u64>,
    capture: Option<CaptureInfo>,
    /// The active page's clock at its `hello`, and when that arrived.
    clock: PageClock,
    agent: String,
    /// The plan went out: records flow to the input.
    streaming: bool,
    shutdown: bool,
    /// A source page that goes away may be replaced (see the module docs).
    rejoin: bool,
    /// Why the source cannot come back ([`ShareHandle::fail`]).
    failed: Option<(ErrorKind, String)>,
    /// The source is gone for good, without an error ([`ShareHandle::end`]).
    ended: bool,
}

struct Shared {
    access: Access,
    state: Mutex<State>,
    cv: Condvar,
    events: SyncSender<Event>,
}

impl Shared {
    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn broadcast(&self, st: &State, text: &str) {
        for (_, s) in &st.clients {
            let _ = s.send_text(text);
        }
    }

    fn handle(self: &Arc<Self>, req: &Request) -> Reply {
        let free = ["/capture.js", "/favicon.ico", "/ui.css"];
        let (via, path, token_ok) = match self.access.check(req, &free) {
            Ok(c) => (c.via, c.path, c.token_ok),
            Err(r) => return Reply::Response(r),
        };
        match path {
            "/capture.js" => Reply::Response(httpd::response(
                200,
                "OK",
                "text/javascript; charset=utf-8",
                CAPTURE_JS.as_bytes().to_vec(),
            )),
            "/favicon.ico" => Reply::Response(httpd::response(
                204,
                "No Content",
                "image/x-icon",
                Vec::new(),
            )),
            "/ui.css" => Reply::Response(httpd::response(
                200,
                "OK",
                "text/css; charset=utf-8",
                fonts::UI_CSS.as_bytes().to_vec(),
            )),
            p if p.starts_with("/fonts/") => fonts::reply(p),
            _ if !token_ok => Reply::Response(httpd::error_response(
                403,
                "Forbidden (open the URL tvpipe printed)",
            )),
            "/" => Reply::Response(httpd::response(
                200,
                "OK",
                "text/html; charset=utf-8",
                PAGE_HTML.as_bytes().to_vec(),
            )),
            // tvpipe's own capture of this machine's screen: never over a
            // tunnel.
            "/screen" if via == Via::Local => Reply::Response(httpd::response(
                200,
                "OK",
                "text/html; charset=utf-8",
                SCREEN_HTML.as_bytes().to_vec(),
            )),
            // Over the tunnel only the page's own origin (here any page
            // may connect: `share URL` injects the script into any site).
            "/ws"
                if via == Via::Public && !self.access.origin_ok(via, req.headers.get("origin")) =>
            {
                Reply::Response(httpd::error_response(403, "Forbidden origin"))
            }
            "/ws" if websocket::is_upgrade(req) => match websocket::server_response(req) {
                Ok(resp) => {
                    let me = self.clone();
                    // Over the tunnel: who it is, for the confirmation.
                    let remote = (via == Via::Public)
                        .then(|| self.access.remote_peer(httpd::current_peer()));
                    Reply::Upgrade(
                        resp,
                        Box::new(move |tcp, rest| me.client(tcp, rest, remote)),
                    )
                }
                Err(e) => {
                    debug!("share: bad upgrade: {e}");
                    let mut r = if e.kind() == ErrorKind::Unsupported {
                        httpd::error_response(426, "Upgrade Required")
                    } else {
                        httpd::error_response(400, "Bad Request")
                    };
                    r.headers.add("Sec-WebSocket-Version", "13");
                    Reply::Response(r)
                }
            },
            _ => Reply::Response(httpd::error_response(404, "Not Found")),
        }
    }

    /// One page connection, on its own thread until it closes.
    /// `remote`: it came over the tunnel (with the visitor's address if
    /// known).
    fn client(self: Arc<Self>, tcp: TcpStream, rest: Vec<u8>, remote: Option<Option<String>>) {
        if tcp.set_read_timeout(Some(CLIENT_POLL)).is_err() {
            return;
        }
        let limits = websocket::Limits {
            max_message: protocol::MAX_MESSAGE,
        };
        let Ok((mut rx, tx)) = websocket::pair(tcp, rest, Role::Server, limits) else {
            return;
        };
        // The key its worker may open a media socket with (without one,
        // the page sends every record itself).
        let key = crate::crypto::ring::random_array::<16>()
            .ok()
            .map(|k| crate::util::hex::encode(&k));
        let id = {
            let mut st = self.lock();
            st.next_id += 1;
            let id = st.next_id;
            st.clients.push((id, tx.clone()));
            if let Some(k) = &key {
                st.keys.push((id, k.clone()));
                let _ = tx.send_text(&protocol::channel(k));
            }
            for m in [&st.config, &st.status].into_iter().flatten() {
                let _ = tx.send_text(m);
            }
            id
        };
        debug!(
            "share: page {id} connected{}",
            if remote.is_some() {
                " over the tunnel"
            } else {
                ""
            }
        );
        let mut clock = None;
        let mut page_agent = String::new();
        // This socket carries the records of that page (its worker's).
        let mut media_of: Option<u64> = None;
        let why = loop {
            {
                let st = self.lock();
                if st.shutdown {
                    break "tvpipe stopped".to_owned();
                }
                if media_of.is_some_and(|page| !st.clients.iter().any(|(c, _)| *c == page)) {
                    break "its page went away".to_owned();
                }
            }
            match rx.read_message() {
                Err(e) if e.kind() == ErrorKind::Timeout => {}
                Err(e) => break format!("the page's connection failed: {e}"),
                Ok(Message::Close(_)) => break "the page closed".to_owned(),
                Ok(Message::Text(t)) => match protocol::parse_page(&t) {
                    Ok(PageMsg::Hello {
                        version,
                        clock_us,
                        agent,
                    }) => {
                        debug!("share: page {id}: {agent} (protocol {version})");
                        if version != protocol::VERSION {
                            warn!(
                                "share: the page speaks protocol {version}, tvpipe {}",
                                protocol::VERSION
                            );
                        }
                        clock = Some((Instant::now(), clock_us));
                        page_agent.clone_from(&agent);
                        self.lock().agent = agent;
                    }
                    Ok(PageMsg::Capture(mut info)) => {
                        info.remote = remote.clone().map(|peer| Remote {
                            peer,
                            agent: page_agent.clone(),
                        });
                        let mut st = self.lock();
                        if st.rejoin && st.active != Some(id) {
                            // The newest capture is the source (the old
                            // page is navigating away).
                            info!(
                                "share: page {id} captures {}x{}{}",
                                info.width,
                                info.height,
                                if info.audio { " with audio" } else { "" }
                            );
                            st.active = Some(id);
                            st.capture = Some(info);
                            st.clock = clock;
                            self.cv.notify_all();
                            if st.streaming {
                                drop(st);
                                if self.events.send(Event::Attached(id)).is_err() {
                                    break "tvpipe stopped".to_owned();
                                }
                            }
                        } else if st.active.is_none() && !st.streaming {
                            info!(
                                "share: capturing {} {}x{}{}{}",
                                info.surface.as_deref().unwrap_or("a surface"),
                                info.width,
                                info.height,
                                info.fps.map(|f| format!("@{f:.0}")).unwrap_or_default(),
                                if info.audio { " with audio" } else { "" }
                            );
                            st.active = Some(id);
                            st.capture = Some(info);
                            st.clock = clock;
                            self.cv.notify_all();
                        } else if st.active != Some(id) {
                            drop(st);
                            let _ = tx.send_text(&protocol::busy());
                            let _ = tx.close(close_code::POLICY, "another page is sharing");
                            break "busy".to_owned();
                        }
                    }
                    Ok(PageMsg::Stats(v)) => {
                        if self.is_source(id) {
                            let _ = self.events.try_send(Event::Stats(v));
                        }
                    }
                    Ok(PageMsg::Ended(reason)) => {
                        if self.is_source(id) {
                            break reason;
                        }
                    }
                    Ok(PageMsg::Log { level, message }) => match level.as_str() {
                        "error" | "warn" => warn!("share page: {message}"),
                        _ => debug!("share page: {message}"),
                    },
                    Ok(PageMsg::Media { key }) => {
                        let mut st = self.lock();
                        let page = st
                            .keys
                            .iter()
                            .find(|(c, k)| *c != id && *k == key)
                            .map(|(c, _)| *c);
                        match page {
                            Some(page) if media_of.is_none() && clock.is_none() => {
                                debug!("share: page {id} carries page {page}'s records");
                                media_of = Some(page);
                                // Not a page: no broadcasts, no key.
                                st.clients.retain(|(c, _)| *c != id);
                                st.keys.retain(|(c, _)| *c != id);
                                drop(st);
                                let _ = tx.send_text(&protocol::media_ok());
                            }
                            _ => {
                                drop(st);
                                let _ = tx.close(close_code::POLICY, "unknown media key");
                                break "a media socket with an unknown key".to_owned();
                            }
                        }
                    }
                    Ok(PageMsg::Unknown(t)) => trace!("share: page {id}: unknown message {t:?}"),
                    Err(e) => debug!("share: page {id}: {e}"),
                },
                Ok(Message::Binary(b)) => {
                    let source = media_of.unwrap_or(id);
                    let streaming = {
                        let st = self.lock();
                        st.streaming && st.active == Some(source)
                    };
                    if !streaming {
                        continue;
                    }
                    let ev = match protocol::parse_record(&b) {
                        Ok(p) => Event::Packet(p),
                        Err(e) => {
                            let _ = tx.close(close_code::UNSUPPORTED, e.message());
                            let _ = self.events.send(Event::Failed(e));
                            break "bad record".to_owned();
                        }
                    };
                    // Blocks while the session is behind: backpressure
                    // into the socket, where the page sees bufferedAmount
                    // grow and drops frames.
                    if self.events.send(ev).is_err() {
                        break "tvpipe stopped".to_owned();
                    }
                }
            }
        };
        debug!("share: page {id}: {why}");
        let mut st = self.lock();
        st.clients.retain(|(c, _)| *c != id);
        st.keys.retain(|(c, _)| *c != id);
        if st.active == Some(id) {
            if st.streaming && st.rejoin {
                st.active = None;
                st.capture = None;
                let _ = self.events.try_send(Event::Detached(why));
            } else if st.streaming {
                let _ = self.events.try_send(Event::Ended(why));
            } else {
                // Not started yet: another capture may take its place.
                st.active = None;
                st.capture = None;
                self.cv.notify_all();
            }
        }
        drop(st);
        let _ = tx.close(close_code::NORMAL, "");
        tx.with_stream(|s| {
            let _ = s.shutdown(std::net::Shutdown::Both);
        });
    }

    fn is_source(&self, id: u64) -> bool {
        self.lock().active == Some(id)
    }
}

/// The share page server, until a capture starts streaming.
pub struct ShareServer {
    http: Option<httpd::Server>,
    shared: Arc<Shared>,
    events: Receiver<Event>,
    url: String,
    end_reason: String,
    /// `--tunnel` ([`ShareServer::expose`]).
    tunnel: Option<Box<dyn Tunnel>>,
}

impl ShareServer {
    /// Listens on 127.0.0.1 (`port` 0: any free port).
    pub fn bind(port: u16) -> Result<ShareServer> {
        let token = crate::util::hex::encode(&crate::crypto::ring::random_array::<16>()?);
        // The port is only known after binding; the handler reads it from
        // `Shared`, which is built around a placeholder first.
        let listener_addr: SocketAddr = (std::net::Ipv4Addr::LOCALHOST, port).into();
        let (tx, events) = mpsc::sync_channel(EVENT_QUEUE);
        let cell: Arc<Mutex<Option<Arc<Shared>>>> = Arc::new(Mutex::new(None));
        let c = cell.clone();
        let handler: httpd::Handler = Arc::new(move |req: &Request| {
            let shared = c.lock().unwrap_or_else(|e| e.into_inner()).clone();
            match shared {
                Some(s) => s.handle(req),
                None => Reply::Response(httpd::error_response(503, "Service Unavailable")),
            }
        });
        let http = httpd::Server::bind(listener_addr, handler)?;
        let port = http.local_addr().port();
        let shared = Arc::new(Shared {
            access: Access::new("share", port, token.clone()),
            state: Mutex::new(State::default()),
            cv: Condvar::new(),
            events: tx,
        });
        *cell.lock().unwrap_or_else(|e| e.into_inner()) = Some(shared.clone());
        Ok(ShareServer {
            http: Some(http),
            shared,
            events,
            url: format!("http://127.0.0.1:{port}/?t={token}"),
            end_reason: "tvpipe stopped".into(),
            tunnel: None,
        })
    }

    /// Also serves the page on a public URL (docs/tunnels.md) that lets
    /// people in for `ttl`, and returns it: anyone who has it can ask to
    /// share to the receivers.
    pub fn expose(
        &mut self,
        provider: tunnel::Provider,
        ttl: Option<Duration>,
        stop: &dyn Fn() -> bool,
    ) -> Result<String> {
        let t = tunnel::start(self.shared.access.port(), provider, stop)?;
        let url = self.publish(t.host(), ttl, t.peer_lookup())?;
        self.tunnel = Some(t);
        Ok(url)
    }

    /// Accepts `host` as the page's public host (what [`expose`]
    /// does once the tunnel is up; tests call it directly).
    ///
    /// [`expose`]: Self::expose
    pub fn publish(
        &self,
        host: &str,
        ttl: Option<Duration>,
        peers: Option<tunnel::PeerLookup>,
    ) -> Result<String> {
        let token = self.shared.access.publish(host, ttl, peers)?;
        Ok(format!("https://{host}/?t={token}"))
    }

    /// Whether the capture [`wait_capture`](Self::wait_capture) returned
    /// is still there (its page did not go away).
    pub fn capture_pending(&self) -> bool {
        self.shared.lock().capture.is_some()
    }

    /// Turns the capture [`wait_capture`](Self::wait_capture) returned
    /// down: its page is told `reason` and closed, and the next capture
    /// may take its place.
    pub fn decline(&self, reason: &str) {
        let mut st = self.shared.lock();
        if st.streaming {
            return;
        }
        if let Some(id) = st.active.take() {
            st.capture = None;
            if let Some((_, s)) = st.clients.iter().find(|(c, _)| *c == id) {
                let _ = s.send_text(&protocol::end(reason));
                let _ = s.close(close_code::POLICY, reason);
            }
        }
    }

    /// Keep streaming when the source page goes away, until another page
    /// captures (see the module docs).
    pub fn set_rejoin(&self, on: bool) {
        self.shared.lock().rejoin = on;
    }

    /// A handle that can end the session from another thread.
    pub fn handle(&self) -> ShareHandle {
        ShareHandle(self.shared.clone())
    }

    /// Why [`ShareHandle::fail`] ended the session, if it did.
    pub fn failure(&self) -> Option<Error> {
        self.shared
            .lock()
            .failed
            .as_ref()
            .map(|(kind, msg)| Error::new(*kind, msg.clone()))
    }

    /// The page's URL (with the token).
    pub fn url(&self) -> &str {
        &self.url
    }

    /// The WebSocket URL a capture script connects to.
    pub fn ws_url(&self) -> String {
        format!(
            "ws://127.0.0.1:{}/ws?t={}",
            self.shared.access.port(),
            self.shared.access.token()
        )
    }

    /// The page `tvpipe screen`'s browser opens (with the token).
    pub fn screen_url(&self) -> String {
        format!(
            "http://127.0.0.1:{}/screen?t={}",
            self.shared.access.port(),
            self.shared.access.token()
        )
    }

    /// Tells pages what to capture (sent now and to every later page).
    pub fn configure(&self, config: &PageConfig) {
        let text = config.to_json();
        let mut st = self.shared.lock();
        self.shared.broadcast(&st, &text);
        st.config = Some(text);
    }

    /// Shows `state`/`message` on every page.
    pub fn set_status(&self, state: &str, message: &str, receivers: &[String]) {
        let text = protocol::status(state, message, receivers);
        let mut st = self.shared.lock();
        self.shared.broadcast(&st, &text);
        st.status = Some(text);
    }

    /// What pages see when the server goes away (default: "tvpipe
    /// stopped").
    pub fn set_end_reason(&mut self, reason: &str) {
        self.end_reason = reason.to_owned();
    }

    /// Waits until a page starts a capture; `None` on a stop request (or
    /// a [`failure`](Self::failure)).
    pub fn wait_capture(&self, stop: &Stop) -> Option<CaptureInfo> {
        let mut st = self.shared.lock();
        loop {
            if stop.requested() || st.failed.is_some() || st.ended {
                return None;
            }
            if let Some(c) = &st.capture {
                return Some(c.clone());
            }
            st = self
                .shared
                .cv
                .wait_timeout(st, STOP_POLL)
                .unwrap_or_else(|e| e.into_inner())
                .0;
        }
    }

    /// Sends the plan to the source page and waits for its first
    /// keyframe. On failure the pages are told why.
    pub fn start(
        mut self,
        plan: &SharePlan,
        opts: ShareInputOptions,
        stop: Stop,
    ) -> Result<ShareInput> {
        let claimed = self.claim().and_then(|(sender, clock, agent)| {
            sender.send_text(&plan.to_json())?;
            Ok((sender, clock, agent))
        });
        let (sender, clock, agent) = match claimed {
            Ok(v) => v,
            Err(e) => {
                self.set_end_reason(&e.to_string());
                return Err(e);
            }
        };
        let video = RawVideoSpec {
            size: crate::opts::Size {
                width: plan.width,
                height: plan.height,
            },
            fps: opts.fps,
            pix_fmt: crate::media::slrw::ENCODED_PIX_FMT.into(),
        };
        let st = match EncodedState::new(video, opts.audio, &opts.audio_families, None) {
            Ok(st) => st,
            Err(e) => {
                self.set_end_reason(&e.to_string());
                return Err(e);
            }
        };
        let mut input = ShareInput {
            server: self,
            plan: plan.clone(),
            sender,
            st,
            info: StreamInfo {
                video: crate::types::VideoInfo {
                    codec: crate::types::VideoCodec::H264,
                    width: 0,
                    height: 0,
                    fps: opts.fps,
                    avcc: Vec::new(),
                },
                audio: Vec::new(),
            },
            stop,
            last_key_request: None,
            length_size: 4,
            clock,
            lag: Lag::default(),
            page_stats: None,
            sound: Sound::default(),
            agent,
            last_video: None,
            gap_since: None,
        };
        match input.first_keyframe() {
            Ok(()) => Ok(input),
            Err(e) => {
                input.server.set_end_reason(&e.to_string());
                Err(e)
            }
        }
    }

    /// Marks the source page as streaming: its sender, clock and agent.
    fn claim(&self) -> Result<(Sender<TcpStream>, PageClock, String)> {
        let mut st = self.shared.lock();
        let active = st
            .active
            .ok_or_else(|| Error::closed("share: the capture ended before streaming started"))?;
        let sender = st
            .clients
            .iter()
            .find(|(id, _)| *id == active)
            .map(|(_, s)| s.clone())
            .ok_or_else(|| Error::closed("share: the page went away"))?;
        st.streaming = true;
        Ok((sender, st.clock, st.agent.clone()))
    }
}

impl Drop for ShareServer {
    fn drop(&mut self) {
        let end = protocol::end(&self.end_reason);
        {
            let mut st = self.shared.lock();
            st.shutdown = true;
            for (_, s) in &st.clients {
                let _ = s.send_text(&end);
                let _ = s.close(close_code::GOING_AWAY, &self.end_reason);
            }
            self.shared.cv.notify_all();
        }
        if let Some(mut h) = self.http.take() {
            h.shutdown();
        }
    }
}

/// Whether the page's sound was ever more than silence: a capture whose
/// sound stays digital silence is noted once (on macOS that is how a
/// browser without the "System Audio Recording" permission sounds).
#[derive(Debug, Default)]
struct Sound {
    /// Stats reports with sound flowing, all of it silence.
    silent: u32,
    heard: bool,
    noted: bool,
}

/// Silent stats reports (2 s each) before the note.
const SILENT_REPORTS: u32 = 5;

impl Sound {
    /// Takes a page `stats` message; `true` when the note goes out now.
    fn stats(&mut self, v: &Value) -> bool {
        let flowing = v.get("audioKbps").and_then(Value::as_f64).unwrap_or(0.0) > 0.0;
        let Some(peak) = v.get("audioPeak").and_then(Value::as_f64) else {
            return false;
        };
        if !flowing || self.heard || self.noted {
            return false;
        }
        if peak > 0.0 {
            self.heard = true;
            return false;
        }
        self.silent += 1;
        if self.silent < SILENT_REPORTS {
            return false;
        }
        self.noted = true;
        info!(
            "share: the captured sound has been silent for {} s (nothing playing?{})",
            SILENT_REPORTS * 2,
            if cfg!(target_os = "macos") {
                " On macOS the browser needs the System Audio Recording permission: \
                 System Settings > Privacy & Security > Screen & System Audio Recording"
            } else {
                ""
            }
        );
        true
    }
}

/// A page's clock (µs) and when we read it.
type PageClock = Option<(Instant, u64)>;

/// Ends a share from another thread (the headless browser's keeper).
#[derive(Clone)]
pub struct ShareHandle(Arc<Shared>);

impl ShareHandle {
    /// The source cannot come back: the input fails with `e` (or the
    /// wait for a capture ends; see [`ShareServer::failure`]).
    pub fn fail(&self, e: Error) {
        let mut st = self.0.lock();
        if st.failed.is_none() {
            st.failed = Some((e.kind(), e.message().to_owned()));
        }
        self.0.cv.notify_all();
        drop(st);
        let _ = self.0.events.try_send(Event::Failed(e));
    }

    /// The source is gone for good (the user closed the browser): the
    /// input ends like a file, or the wait for a capture ends.
    pub fn end(&self, reason: &str) {
        let mut st = self.0.lock();
        st.ended = true;
        self.0.cv.notify_all();
        drop(st);
        let _ = self.0.events.try_send(Event::Ended(reason.to_owned()));
    }

    /// The WebSocket URL a capture script connects to.
    pub fn ws_url(&self) -> String {
        format!(
            "ws://127.0.0.1:{}/ws?t={}",
            self.0.access.port(),
            self.0.access.token()
        )
    }

    /// Whether pages get their `config` at once (the session knows what
    /// to capture).
    pub fn configured(&self) -> bool {
        self.0.lock().config.is_some()
    }
}

/// The input side of [`ShareServer::start`].
pub struct ShareInputOptions {
    /// Frame rate for timing when the SPS has none.
    pub fps: crate::util::ratio::Ratio,
    /// The PCM the page sends (s16le), if any.
    pub audio: Option<RawAudioSpec>,
    pub audio_families: Vec<(AudioFamily, AudioOut)>,
}

/// Capture-to-tvpipe delay of video records (page clock vs. arrival),
/// and how evenly their timestamps are spaced (receivers show frames at
/// their timestamps: uneven spacing is uneven motion).
#[derive(Default)]
struct Lag {
    since: Option<Instant>,
    n: u64,
    sum_ms: f64,
    max_ms: f64,
    last_pts: Option<u64>,
    /// Gaps between timestamps (ms): count, sum, sum of squares, largest.
    gaps: u64,
    gap_sum: f64,
    gap_sq: f64,
    gap_max: f64,
    seen: u64,
    total_n: u64,
    total_sum_ms: f64,
    total_max_ms: f64,
}

impl Lag {
    fn add(&mut self, ms: f64, pts_us: u64) {
        if let Some(last) = self.last_pts.filter(|&l| l < pts_us) {
            let gap = (pts_us - last) as f64 / 1000.0;
            self.gaps += 1;
            self.gap_sum += gap;
            self.gap_sq += gap * gap;
            self.gap_max = self.gap_max.max(gap);
        }
        self.last_pts = Some(pts_us);
        let now = Instant::now();
        let since = *self.since.get_or_insert(now);
        self.n += 1;
        self.sum_ms += ms;
        self.max_ms = self.max_ms.max(ms);
        self.seen += 1;
        // The totals leave out the encoder's warm-up.
        if self.seen > LAG_WARMUP {
            self.total_n += 1;
            self.total_sum_ms += ms;
            self.total_max_ms = self.total_max_ms.max(ms);
        }
        if now.duration_since(since) >= LAG_REPORT {
            let n = self.gaps.max(1) as f64;
            let mean = self.gap_sum / n;
            debug!(
                "share: {:.1} fps from the page, capture to tvpipe avg {:.1} ms, max {:.1} ms; \
                 frames {:.1} ms apart (deviation {:.1} ms, longest {:.1} ms)",
                self.n as f64 / now.duration_since(since).as_secs_f64(),
                self.sum_ms / self.n as f64,
                self.max_ms,
                mean,
                (self.gap_sq / n - mean * mean).max(0.0).sqrt(),
                self.gap_max
            );
            *self = Lag {
                since: Some(now),
                last_pts: self.last_pts,
                seen: self.seen,
                total_n: self.total_n,
                total_sum_ms: self.total_sum_ms,
                total_max_ms: self.total_max_ms,
                ..Lag::default()
            };
        }
    }
}

/// H.264 + PCM from the share page.
pub struct ShareInput {
    server: ShareServer,
    /// What every source page gets (rejoin mode: again for each).
    plan: SharePlan,
    sender: Sender<TcpStream>,
    st: EncodedState,
    info: StreamInfo,
    stop: Stop,
    last_key_request: Option<Instant>,
    /// The page's AVCC length size (from its avcC).
    length_size: usize,
    clock: PageClock,
    lag: Lag,
    page_stats: Option<Value>,
    sound: Sound,
    agent: String,
    /// When the last video record came, and since when there is none
    /// (rejoin mode: the page went away).
    last_video: Option<Instant>,
    gap_since: Option<Instant>,
}

impl ShareInput {
    fn first_keyframe(&mut self) -> Result<()> {
        let deadline = Instant::now() + FIRST_KEYFRAME_TIMEOUT;
        while !self.st.started() {
            if self.st.ended() {
                return Err(Error::closed(
                    "share: the capture ended before the first keyframe",
                ));
            }
            if Instant::now() >= deadline {
                return Err(Error::timeout(format!(
                    "share: no keyframe from the page within {} s (can the browser encode H.264?)",
                    FIRST_KEYFRAME_TIMEOUT.as_secs()
                )));
            }
            if !self.pump()? {
                return Err(Error::closed("share: stopped before the first keyframe"));
            }
        }
        self.info = self.st.stream_info()?;
        if let Some(sar) = square_pixels(&self.info.video.avcc) {
            warn!(
                "share: the browser's H.264 says pixels are {}:{}, not square; \
                 receivers may stretch the picture",
                sar.0, sar.1
            );
        }
        Ok(())
    }

    /// Waits up to [`STOP_POLL`] for one event and handles it; `false` on
    /// a stop request.
    fn pump(&mut self) -> Result<bool> {
        if self.stop.requested() {
            return Ok(false);
        }
        match self.server.events.recv_timeout(STOP_POLL) {
            Ok(Event::Packet(p)) => self.packet(p)?,
            Ok(Event::Stats(v)) => {
                trace!("share: page stats {v}");
                self.sound.stats(&v);
                self.page_stats = Some(v);
            }
            Ok(Event::Ended(reason)) => {
                info!("share: {reason}");
                self.server.set_end_reason("the share ended");
                self.st.end();
            }
            Ok(Event::Failed(e)) => return Err(e),
            Ok(Event::Detached(why)) => {
                info!("share: the page stopped sharing ({why}); waiting for it to share again");
                self.gap_since = self.last_video.or(Some(Instant::now()));
            }
            Ok(Event::Attached(id)) => self.attach(id)?,
            Err(RecvTimeoutError::Timeout) => {
                if let Some(e) = self.server.failure() {
                    return Err(e);
                }
            }
            Err(RecvTimeoutError::Disconnected) => self.st.end(),
        }
        Ok(true)
    }

    /// Rejoin mode: page `id` captured; it gets the plan and is the
    /// source from now on.
    fn attach(&mut self, id: u64) -> Result<()> {
        let (sender, clock, agent, capture) = {
            let st = self.server.shared.lock();
            if st.active != Some(id) {
                // Already replaced by a newer page (its own event follows).
                return Ok(());
            }
            let Some(sender) = st
                .clients
                .iter()
                .find(|(c, _)| *c == id)
                .map(|(_, s)| s.clone())
            else {
                return Ok(());
            };
            (sender, st.clock, st.agent.clone(), st.capture.clone())
        };
        let mut plan = self.plan.clone();
        if let Some(c) = &capture {
            plan.content = crate::browser::layout::place(
                (c.width.max(1), c.height.max(1)),
                (plan.width, plan.height),
            );
        }
        if let Err(e) = sender.send_text(&plan.to_json()) {
            debug!("share: page {id} went away before its plan: {e}");
            return Ok(());
        }
        info!("share: page {id} shares again");
        self.sender = sender;
        self.clock = clock;
        self.agent = agent;
        // Its avcC says (it comes before its first chunk).
        self.length_size = 4;
        Ok(())
    }

    fn packet(&mut self, mut p: Packet) -> Result<()> {
        match p.kind {
            // Audio from before the first keyframe (the encoder starting
            // up) would only make the session's clock start that late.
            Kind::Audio if !self.st.started() => return Ok(()),
            Kind::H264Config if p.payload.first() == Some(&slrw::CONFIG_AVCC) => {
                debug!("share: avcC {}", crate::util::hex::encode(&p.payload[1..]));
                let cfg = h264::AvcConfig::parse(&p.payload[1..])?;
                self.length_size = cfg.length_size as usize;
            }
            Kind::H264 => {
                let now = Instant::now();
                if let Some(since) = self.gap_since.take() {
                    info!(
                        "share: video again after a {} ms gap",
                        now.duration_since(since).as_millis()
                    );
                }
                self.last_video = Some(now);
                if let Some((at, page_us)) = self.clock {
                    let page_now = page_us as f64 + at.elapsed().as_secs_f64() * 1e6;
                    self.lag
                        .add((page_now - p.pts_us as f64) / 1000.0, p.pts_us);
                }
                let annexb = p.payload[0] & slrw::H264_ANNEX_B != 0;
                if !annexb && self.length_size != 4 {
                    p.payload = reframe(&p.payload, self.length_size)?;
                }
            }
            _ => {}
        }
        self.st.handle(p)
    }
}

/// The sample aspect ratio of an avcC's SPS when it is not square
/// (`None`: square or unspecified, which receivers treat as square).
fn square_pixels(avcc: &[u8]) -> Option<(u32, u32)> {
    let cfg = h264::AvcConfig::parse(avcc).ok()?;
    let sps = h264::parse_sps(cfg.sps.first()?).ok()?;
    sps.sar.filter(|&(w, h)| w != h)
}

/// An `h264` record payload (flags + AVCC with `n`-byte lengths) with
/// 4-byte lengths.
fn reframe(payload: &[u8], n: usize) -> Result<Vec<u8>> {
    let mut out = Vec::with_capacity(payload.len() + 16);
    out.push(payload[0]);
    for nal in h264::avcc_nals(&payload[1..], n) {
        let nal = nal?;
        out.extend_from_slice(&(nal.len() as u32).to_be_bytes());
        out.extend_from_slice(nal);
    }
    Ok(out)
}

impl Input for ShareInput {
    fn info(&self) -> &StreamInfo {
        &self.info
    }

    fn next_frame(&mut self) -> Result<Option<EncodedFrame>> {
        loop {
            if let Some(f) = self.st.pop() {
                return Ok(Some(f));
            }
            if self.st.ended() || !self.pump()? {
                return Ok(None);
            }
        }
    }

    fn request_keyframe(&mut self) -> bool {
        let now = Instant::now();
        if self
            .last_key_request
            .is_some_and(|l| now.duration_since(l) < KEYFRAME_REQUEST_INTERVAL)
        {
            return true;
        }
        self.last_key_request = Some(now);
        debug!("share: asking the page for a keyframe");
        self.sender.send_text(&protocol::keyframe()).is_ok()
    }

    fn bitrate_kbps(&self) -> Option<u32> {
        Some((self.plan.bitrate_bps / 1000).min(u32::MAX as u64) as u32)
    }

    /// The page reconfigures its encoder; a page that shares later (rejoin
    /// mode) gets it with its plan.
    fn set_bitrate(&mut self, kbps: u32) {
        self.plan.bitrate_bps = kbps as u64 * 1000;
        if let Err(e) = self
            .sender
            .send_text(&protocol::bitrate(self.plan.bitrate_bps))
        {
            debug!("share: bitrate to the page: {e}");
        }
    }

    fn describe(&self) -> String {
        let agent = crate::browser::agent::browser_name(&self.agent);
        format!(
            "shared {}",
            if agent.is_empty() {
                "browser capture".into()
            } else {
                format!("capture from {agent}")
            }
        )
    }

    fn finish(self: Box<Self>, _clean_eof: bool) -> Result<()> {
        let l = &self.lag;
        if l.total_n > 0 {
            info!(
                "share: {} video frames; capture to tvpipe avg {:.1} ms, max {:.1} ms \
                 (after the first {LAG_WARMUP})",
                l.seen,
                l.total_sum_ms / l.total_n as f64,
                l.total_max_ms
            );
        }
        if let Some(s) = &self.page_stats {
            debug!("share: last page stats {s}");
        }
        // Dropping the server tells the pages and stops listening.
        Ok(())
    }
}

#[cfg(test)]
pub(crate) mod tests;
