//! The control-connection side of a mirroring session (spec §3, §4):
//! FairPlay, SETUP #1 (or the media-first SETUP), the event channel, the
//! `/info` refresh, RECORD, the audio and video SETUPs, the initial
//! volume, `/feedback` and TEARDOWN, with the spec's timeouts and failure
//! rules.
//!
//! [`Session::establish`] runs everything up to the audio SETUP (so the
//! canvas and audio format are known before the encoder starts);
//! [`Session::start_video`] runs the video SETUP (none for an audio-only
//! receiver) and the rest when the encoder's stream info is ready.
//!
//! Sources: docs/airplay-mirroring.md §2, §3, §4, §5.3, §7.2, §7.3,
//! §8.9; vectors tests/vectors/airplay-mirror/setup.txt,
//! appletv-session.txt.

use std::io::{Read, Write};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, TcpStream, UdpSocket};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use crate::airplay::access;
use crate::airplay::events::{Event, EventChannel};
use crate::airplay::info::Info;
use crate::airplay::keys;
use crate::airplay::mdc::MediaDataControl;
use crate::airplay::policy::{self, bit, Canvas, Leads};
use crate::airplay::secure::SecureStream;
use crate::airplay::setup::{
    parse_audio_response, parse_video_response, streams_body, AudioCodecId, AudioLayout,
    AudioPorts, AudioRequest, SessionRequest, SessionResponse, TimingRequest, VideoRequest,
};
use crate::airplay::timing::{anchor_from_headers, NtpResponder, PtpClock, Timeline};
use crate::codec::bplist::Plist;
use crate::crypto::ring::random_array;
use crate::error::{Error, ErrorKind, Result};
use crate::net::http::Response;
use crate::net::rtsp::RtspClient;

pub const USER_AGENT: &str = "AirPlay/935.7.1";
pub const BPLIST: &str = "application/x-apple-binary-plist";
const TEXT_PARAMETERS: &str = "text/parameters";

/// Response timeouts (§3).
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);
pub const INFO_TIMEOUT: Duration = Duration::from_secs(3);
pub const VOLUME_TIMEOUT: Duration = Duration::from_secs(3);
pub const CLEANUP_TEARDOWN_TIMEOUT: Duration = Duration::from_secs(2);
/// TEARDOWN when the user stops (Ctrl-C, EOF): the Apple TV answers in
/// ~0.7 s or closes the connection; a receiver that takes longer is not
/// waited for (the spec's general 30 s would make Ctrl-C hang).
pub const STOP_TEARDOWN_TIMEOUT: Duration = Duration::from_secs(4);
pub const DATA_CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
/// How long to wait for an asynchronous PTP clock id (§4.1).
const ASYNC_CLOCK_WAIT: Duration = Duration::from_secs(2);
/// Statuses that mean "use the other ordering / layout" (§4.1, §4.6).
const SETUP1_REFUSED: [u16; 6] = [400, 405, 406, 415, 455, 501];
const LAYOUT_REFUSED: [u16; 5] = [400, 406, 415, 455, 501];
const MDC_MIN_VERSION: (u64, u64, u64) = (450, 1, 0);
const MEDIA_FIRST_PTP_REFUSED: [u16; 5] = [400, 406, 415, 455, 501];

/// A control connection's stream: gives access to the socket for timeouts.
pub trait ControlStream: Read + Write + Send + 'static {
    fn tcp(&self) -> &TcpStream;
}

impl ControlStream for TcpStream {
    fn tcp(&self) -> &TcpStream {
        self
    }
}

impl ControlStream for SecureStream<TcpStream> {
    fn tcp(&self) -> &TcpStream {
        self.get_ref()
    }
}

/// The control connection with the spec's request conventions (§3).
pub struct Control<S> {
    client: RtspClient<S>,
    broken: bool,
}

impl<S: ControlStream> Control<S> {
    pub fn new(mut client: RtspClient<S>) -> Control<S> {
        client.default_headers.set("User-Agent", USER_AGENT);
        Control {
            client,
            broken: false,
        }
    }

    /// One request, answered within `timeout`. A timeout or transport
    /// error makes the connection unusable (a late answer would be read
    /// as the next one's); a complete non-2xx answer does not.
    pub fn request(
        &mut self,
        method: &str,
        uri: &str,
        headers: &[(&str, &str)],
        body: Option<(&str, Vec<u8>)>,
        timeout: Duration,
    ) -> Result<Response> {
        if self.broken {
            return Err(Error::closed(
                "airplay: control connection unusable after an earlier failure",
            ));
        }
        // `Session:` only where a caller sets it (RECORD).
        self.client.session = None;
        let _ = self
            .client
            .conn()
            .get_ref()
            .tcp()
            .set_read_timeout(Some(timeout));
        let mut req = self.client.prepare(method, uri);
        for (k, v) in headers {
            req.headers.set(*k, *v);
        }
        match body {
            Some((ct, b)) => req = req.body(ct, b),
            None => {
                req.headers.set("Content-Length", "0");
            }
        }
        debug!("airplay: > {method} {uri}");
        match self.client.send(&req) {
            Ok(r) => {
                debug!("airplay: < {} {} ({method} {uri})", r.status, r.reason);
                Ok(r)
            }
            Err(e) => {
                self.broken = true;
                Err(Error::new(
                    e.kind(),
                    format!("airplay: {method} {uri}: {e}"),
                ))
            }
        }
    }

    pub fn is_broken(&self) -> bool {
        self.broken
    }

    fn socket(&mut self) -> &TcpStream {
        self.client.conn().get_ref().tcp()
    }
}

fn check(resp: Response, what: &str) -> Result<Response> {
    resp.error_for_status(&format!("airplay: {what}"))
}

fn plist_of(resp: &Response, what: &str) -> Result<Plist> {
    if resp.body.is_empty() {
        return Ok(Plist::dict());
    }
    Plist::from_bytes(&resp.body).map_err(|e| Error::malformed(format!("airplay: {what}: {e}")))
}

pub use crate::airplay::options::MirrorOptions;

pub use crate::airplay::options::ReceiverKey;

/// The receiver's [`ReceiverKey`], if its `/info` has a `deviceID`.
fn receiver_key(info: &Info, version: Option<&str>) -> Option<ReceiverKey> {
    Some(ReceiverKey {
        device_id: info.device_id.clone().filter(|d| !d.is_empty())?,
        source_version: version.unwrap_or_default().to_owned(),
    })
}

/// Receivers whose PTP setup failed (§2.5): later sessions use NTP from
/// the start, without the reconnect that some receivers do not survive.
pub trait PtpMemory {
    /// Whether PTP failed with this receiver before.
    fn ptp_failed(&self, key: &ReceiverKey) -> bool;
    /// PTP failed with it (`name` is for people reading the store).
    fn remember_ptp_failed(&mut self, key: &ReceiverKey, name: &str);
}

/// Remembers nothing.
pub struct NoMemory;

impl PtpMemory for NoMemory {
    fn ptp_failed(&self, _: &ReceiverKey) -> bool {
        false
    }
    fn remember_ptp_failed(&mut self, _: &ReceiverKey, _: &str) {}
}

/// Remembers for as long as it lives.
impl PtpMemory for Vec<ReceiverKey> {
    fn ptp_failed(&self, key: &ReceiverKey) -> bool {
        self.contains(key)
    }
    fn remember_ptp_failed(&mut self, key: &ReceiverKey, _: &str) {
        if !self.contains(key) {
            self.push(key.clone());
        }
    }
}

/// Why [`Session::establish`] failed.
#[derive(Debug)]
pub enum SetupError {
    /// PTP could not be set up; retry on a fresh connection with NTP.
    PtpFailed(Error),
    Fatal(Error),
}

impl From<Error> for SetupError {
    fn from(e: Error) -> SetupError {
        SetupError::Fatal(e)
    }
}

impl SetupError {
    pub fn into_error(self) -> Error {
        match self {
            SetupError::PtpFailed(e) | SetupError::Fatal(e) => e,
        }
    }
}

/// What FairPlay contributed (§2.2).
#[derive(Clone)]
pub struct FairPlayKeys {
    /// `K`, the stream master key.
    pub master: [u8; 16],
    pub eiv: [u8; 16],
    /// `ekey` (legacy profile only).
    pub ekey: [u8; 72],
}

impl std::fmt::Debug for FairPlayKeys {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("FairPlayKeys { .. }")
    }
}

/// The three local UDP sockets: timing N, audio control N+1, data N+2.
#[derive(Debug)]
pub struct AudioSockets {
    pub timing: UdpSocket,
    pub control: UdpSocket,
    pub data: UdpSocket,
}

fn bind_sockets(ipv6: bool) -> Result<AudioSockets> {
    let any = |port: u16| -> SocketAddr {
        if ipv6 {
            SocketAddr::new(IpAddr::V6(Ipv6Addr::UNSPECIFIED), port)
        } else {
            SocketAddr::new(IpAddr::V4(Ipv4Addr::UNSPECIFIED), port)
        }
    };
    let bind = |port| UdpSocket::bind(any(port)).map_err(|e| Error::io("airplay: bind UDP", e));
    // Consecutive ports, as Apple senders use them (§8.2).
    for _ in 0..16 {
        let timing = bind(0)?;
        let n = timing
            .local_addr()
            .map_err(|e| Error::io("airplay: UDP address", e))?
            .port();
        if n > u16::MAX - 2 {
            continue;
        }
        if let (Ok(control), Ok(data)) = (bind(n + 1), bind(n + 2)) {
            return Ok(AudioSockets {
                timing,
                control,
                data,
            });
        }
    }
    Ok(AudioSockets {
        timing: bind(0)?,
        control: bind(0)?,
        data: bind(0)?,
    })
}

fn udp_port(s: &UdpSocket) -> Result<u16> {
    Ok(s.local_addr()
        .map_err(|e| Error::io("airplay: UDP address", e))?
        .port())
}

/// A positive random 63-bit `streamConnectionID`.
fn stream_id() -> Result<u64> {
    loop {
        let v = u64::from_le_bytes(random_array()?) & (i64::MAX as u64);
        if v != 0 {
            return Ok(v);
        }
    }
}

fn uuid_lower() -> Result<String> {
    Ok(crate::airplay::credentials::random_uuid()?.to_lowercase())
}

/// A random locally administered MAC-style id (`02:..`).
fn device_id() -> Result<String> {
    let mut b: [u8; 6] = random_array()?;
    b[0] = 0x02;
    Ok(b.iter()
        .map(|x| format!("{x:02X}"))
        .collect::<Vec<_>>()
        .join(":"))
}

/// The audio stream as negotiated.
#[derive(Debug)]
pub struct AudioStream {
    pub codec: AudioCodecId,
    /// `None`: the receiver gave no ports; video only.
    pub ports: Option<AudioPorts>,
    /// HAP profile: the ChaCha audio key.
    pub key: Option<[u8; 32]>,
    pub sockets: AudioSockets,
}

/// The pairing's shared secret `S`.
#[derive(Clone)]
pub struct KeyedSecret(pub Vec<u8>);

impl std::fmt::Debug for KeyedSecret {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "KeyedSecret({} bytes)", self.0.len())
    }
}

/// Requests a keyframe from the sink (the receiver's `forceKeyFrame`).
#[derive(Debug, Default)]
pub struct Signals {
    pub keyframe_requested: AtomicBool,
}

/// An established session, ready for [`start_video`](Session::start_video).
pub struct Session<S: ControlStream> {
    pub control: Arc<Mutex<Control<S>>>,
    /// The control connection's peer (receiver IP and port).
    pub peer: SocketAddr,
    pub audio_id: u64,
    pub video_id: u64,
    pub session_uuid: String,
    pub secret: KeyedSecret,
    /// HAP profile (else legacy).
    pub hap: bool,
    pub fairplay: Option<FairPlayKeys>,
    pub timeline: Timeline,
    pub info: Info,
    pub version: Option<String>,
    pub leads: Leads,
    /// [`policy::audio_only`] of the first `/info`, decided once.
    audio_only: bool,
    pub canvas: Canvas,
    pub audio: AudioStream,
    pub signals: Arc<Signals>,
    /// The video `shk` sent in SETUP #3 (legacy profile: keys the video).
    pub video_shk: Option<[u8; 16]>,
    /// A handle on the control socket, to unblock a stuck request.
    control_sock: Option<TcpStream>,
    /// The MediaDataControl seed, when the receiver qualifies (§8.10).
    mdc_seed: Option<u64>,
    mdc: Option<MediaDataControl>,
    events: Option<EventChannel>,
    ntp: Option<NtpResponder>,
    record_pending: bool,
    skip_record: bool,
    has_audio: bool,
    torn_down: bool,
}

impl<S: ControlStream> std::fmt::Debug for Session<S> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Session")
            .field("peer", &self.peer)
            .field("audio_id", &self.audio_id)
            .field("video_id", &self.video_id)
            .field("hap", &self.hap)
            .field("timeline", &self.timeline)
            .finish_non_exhaustive()
    }
}

/// Locks the control connection, giving up at `deadline`.
fn lock_control_until<S>(
    c: &Mutex<Control<S>>,
    deadline: Instant,
) -> Option<MutexGuard<'_, Control<S>>> {
    loop {
        match c.try_lock() {
            Ok(g) => return Some(g),
            Err(std::sync::TryLockError::Poisoned(p)) => return Some(p.into_inner()),
            Err(std::sync::TryLockError::WouldBlock) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(10));
            }
            Err(std::sync::TryLockError::WouldBlock) => return None,
        }
    }
}

/// Locks the shared control connection.
pub fn lock_control<S>(c: &Mutex<Control<S>>) -> MutexGuard<'_, Control<S>> {
    c.lock().unwrap_or_else(|e| e.into_inner())
}

impl<S: ControlStream> Session<S> {
    pub fn audio_uri(&self) -> String {
        format!("rtsp://{}/{}", self.peer, self.audio_id)
    }

    pub fn video_uri(&self) -> String {
        format!("rtsp://{}/{}", self.peer, self.video_id)
    }

    fn request(
        &self,
        method: &str,
        uri: &str,
        headers: &[(&str, &str)],
        body: Option<(&str, Vec<u8>)>,
        timeout: Duration,
    ) -> Result<Response> {
        lock_control(&self.control).request(method, uri, headers, body, timeout)
    }

    /// Runs the setup up to and including the audio SETUP (§4.1–§4.6,
    /// §4.12) on an authenticated control connection. `secret` is the
    /// pair-verify shared secret; `hap` selects the crypto profile.
    /// `memory` says which receivers get NTP at once and learns about
    /// PTP failures.
    pub fn establish(
        client: RtspClient<S>,
        peer: SocketAddr,
        secret: Vec<u8>,
        hap: bool,
        opts: &MirrorOptions,
        memory: &mut dyn PtpMemory,
    ) -> std::result::Result<Session<S>, SetupError> {
        let mut control = Control::new(client);
        let local_ip = control
            .socket()
            .local_addr()
            .map_err(|e| Error::io("airplay: local address", e))?
            .ip();
        let resp = check(
            control.request("GET", "/info", &[], None, DEFAULT_TIMEOUT)?,
            "GET /info",
        )?;
        let info = Info::parse(&resp.body)?;
        let version = policy::source_version(&info, resp.headers.get("server"));
        let features = info.features;
        debug!(
            "airplay: receiver {} ({}), features {features:#x}, sourceVersion {:?}",
            info.name.as_deref().unwrap_or("?"),
            info.model.as_deref().unwrap_or("?"),
            version
        );
        let audio_only = policy::audio_only(features);
        if audio_only {
            info!("airplay: receiver cannot mirror (no feature 7); streaming audio only");
        } else if !policy::has(features, bit::SCREEN_MIRRORING) {
            warn!("airplay: receiver does not advertise screen mirroring (feature 7)");
        }

        // FairPlay (§2.2). Without the `fairplay` feature, HAP sessions go
        // on with the §5.3 placeholders (what the Apple TV accepts); a
        // legacy session needs it.
        let mut fairplay_skipped = false;
        let fairplay = if !policy::has(features, bit::FAIRPLAY_SAP) {
            debug!("airplay: no FairPlay (feature 14 not set)");
            None
        } else if FAIRPLAY_BUILT {
            fair_play(&mut control, &secret)?
        } else if hap {
            debug!("airplay: receiver offers FairPlay; this build has none, going on without");
            fairplay_skipped = true;
            None
        } else {
            return Err(SetupError::Fatal(fairplay_required(
                info.name.as_deref().unwrap_or("the receiver"),
                "its legacy (unpaired) profile",
            )));
        };

        // PTP anchors on the `X-Apple-*` timing headers (§7.2), which a
        // receiver that has them puts on every response. Without them on
        // `/info` the PTP SETUP would fail and need a new connection, which
        // some receivers do not answer after the abandoned session (§2.5).
        let anchors = anchor_from_headers(&resp.headers).is_some();
        let key = receiver_key(&info, version.as_deref());
        let mut ptp = opts.ptp && policy::use_ptp(hap, features, version.as_deref());
        if ptp && !anchors {
            debug!("airplay: receiver advertises PTP but sends no timing headers; using NTP");
            ptp = false;
        } else if ptp && key.as_ref().is_some_and(|k| memory.ptp_failed(k)) {
            debug!("airplay: PTP failed with this receiver before; using NTP");
            ptp = false;
        }
        let sockets = bind_sockets(peer.is_ipv6())?;
        let ntp = if ptp {
            None
        } else {
            let sock = sockets
                .timing
                .try_clone()
                .map_err(|e| Error::io("airplay: clone timing socket", e))?;
            Some(NtpResponder::start(sock, peer.ip())?)
        };
        let leads = Leads::for_receiver(opts.latency_ms, &info, opts.audio);
        let mut session = Session {
            control_sock: control.socket().try_clone().ok(),
            control: Arc::new(Mutex::new(control)),
            peer,
            audio_id: stream_id()?,
            video_id: stream_id()?,
            session_uuid: uuid_lower()?,
            secret: KeyedSecret(secret),
            hap,
            fairplay,
            timeline: Timeline::Ntp,
            info,
            version,
            leads,
            audio_only,
            canvas: Canvas {
                width: 0,
                height: 0,
                max_fps: None,
                max_width: 0,
                max_height: 0,
                from_display: false,
            },
            audio: AudioStream {
                codec: AudioCodecId::Alac,
                ports: None,
                key: None,
                sockets,
            },
            signals: Arc::new(Signals::default()),
            video_shk: None,
            mdc_seed: None,
            mdc: None,
            events: None,
            ntp,
            record_pending: true,
            skip_record: false,
            has_audio: opts.audio,
            torn_down: true,
        };
        let r = session.setup(opts, ptp, local_ip);
        match r {
            Ok(()) => Ok(session),
            // A receiver that refuses the session after FairPlay was
            // skipped most likely wants it.
            Err(SetupError::Fatal(e))
                if fairplay_skipped
                    && matches!(e.kind(), ErrorKind::Protocol | ErrorKind::Auth) =>
            {
                session.cleanup();
                debug!("airplay: setup without FairPlay failed: {e}");
                Err(SetupError::Fatal(fairplay_required(
                    session.info.name.as_deref().unwrap_or("the receiver"),
                    &format!("it refused the session without it ({e})"),
                )))
            }
            Err(e) => {
                if let (SetupError::PtpFailed(_), Some(k)) = (&e, &key) {
                    let name = session.info.name.as_deref().unwrap_or_default();
                    memory.remember_ptp_failed(k, name);
                }
                session.cleanup();
                Err(e)
            }
        }
    }

    fn setup(
        &mut self,
        opts: &MirrorOptions,
        ptp: bool,
        local_ip: IpAddr,
    ) -> std::result::Result<(), SetupError> {
        let features = self.info.features;
        // Audio codec first: an unusable audio format is fatal early.
        self.audio.codec = if opts.audio {
            policy::select_audio(policy::audio_mask(&self.info), false)?
        } else {
            AudioCodecId::Alac
        };
        if self.hap {
            self.audio.key = Some(random_array()?);
        }
        // §8.10: MediaDataControl (receiver audio reports) only with HAP,
        // features 59 + 60, sourceVersion >= 450.1.0 and automatic leads
        // (the wireless profile, not an LG TV's, §2.7).
        if self.hap
            && opts.audio
            && opts.latency_ms.is_none()
            && self.leads == Leads::WIRELESS
            && policy::has(features, bit::STREAM_CONNECTIONS)
            && policy::has(features, bit::MEDIA_DATA_CONTROL)
            && policy::version_at_least(self.version.as_deref(), MDC_MIN_VERSION)
        {
            self.mdc_seed = Some(u64::from_le_bytes(random_array()?));
        }
        let timing = if ptp {
            TimingRequest::Ptp {
                peer_id: uuid_lower()?,
                address: local_ip.to_string(),
            }
        } else {
            TimingRequest::Ntp {
                port: udp_port(&self.audio.sockets.timing)?,
            }
        };
        let req = SessionRequest {
            device_id: device_id()?,
            session_uuid: self.session_uuid.clone(),
            name: opts.name.clone(),
            timing,
            fairplay: match (&self.fairplay, self.hap) {
                (Some(fp), false) => Some((fp.ekey.to_vec(), fp.eiv)),
                _ => None,
            },
        };
        let layout = if policy::has(features, bit::STREAM_CONNECTIONS) {
            AudioLayout::S
        } else {
            AudioLayout::P
        };

        // SETUP #1 (§4.1); refused → media-first (§4.12).
        let uri = self.audio_uri();
        let body = req.to_plist(true).to_bytes();
        let resp = self.request("SETUP", &uri, &[], Some((BPLIST, body)), DEFAULT_TIMEOUT)?;
        let t0 = Instant::now();
        let mut media_first = false;
        let (resp, t0) = if SETUP1_REFUSED.contains(&resp.status) {
            debug!(
                "airplay: session SETUP refused ({}), using media-first ordering",
                resp.status
            );
            media_first = true;
            let session = Some(req.to_plist(false));
            let resp = self.audio_setup(layout, session.clone())?;
            if ptp && MEDIA_FIRST_PTP_REFUSED.contains(&resp.status) {
                return Err(SetupError::PtpFailed(Error::protocol(format!(
                    "airplay: media-first PTP SETUP refused with {}",
                    resp.status
                ))));
            }
            let resp = if LAYOUT_REFUSED.contains(&resp.status) {
                self.audio_setup(layout.other(), session)?
            } else {
                resp
            };
            (check(resp, "SETUP (media-first)")?, Instant::now())
        } else if resp.status == 403 || resp.status == 401 {
            // After pairing: a home for its members only, or a password
            // wanted as HTTP Digest (§2.1, §3).
            let name = self.info.name.as_deref().unwrap_or("the receiver");
            return Err(SetupError::Fatal(match resp.status {
                403 => access::forbidden(name),
                _ => access::password_unsupported(name),
            }));
        } else {
            (check(resp, "SETUP (session)")?, t0)
        };
        self.torn_down = false;
        let body = plist_of(&resp, "SETUP response")?;
        let sr = SessionResponse::parse(&body);
        self.skip_record = sr.skip_record;
        if media_first {
            self.audio.ports = parse_audio_response(&body);
        }

        // Timing (§7.2, §7.3).
        let clock = if ptp {
            let anchor = anchor_from_headers(&resp.headers).ok_or_else(|| {
                SetupError::PtpFailed(Error::protocol(
                    "airplay: SETUP response without timing headers",
                ))
            })?;
            Some(Arc::new(PtpClock::new(
                t0,
                anchor,
                sr.clock_id.unwrap_or(0),
            )))
        } else {
            None
        };

        // Event channel (§4.2).
        self.connect_events(sr.event_port, clock.clone());

        if let Some(c) = &clock {
            if c.timeline() == 0 {
                if sr.async_ptp && self.events.is_some() {
                    let until = Instant::now() + ASYNC_CLOCK_WAIT;
                    while c.timeline() == 0 && Instant::now() < until {
                        std::thread::sleep(Duration::from_millis(20));
                    }
                }
                if c.timeline() == 0 {
                    return Err(SetupError::PtpFailed(Error::protocol(
                        "airplay: receiver sent no PTP clock id",
                    )));
                }
            }
            debug!("airplay: PTP timeline {:#018x}", c.timeline());
            self.timeline = Timeline::Ptp(c.clone());
        } else {
            self.timeline = Timeline::Ntp;
            if let Some(p) = sr.timing_port {
                NtpResponder::initiate(
                    &self.audio.sockets.timing,
                    SocketAddr::new(self.peer.ip(), p),
                );
            }
        }

        // `/info` with displays (§4.3).
        match sr.info.as_ref().filter(|i| i.get("displays").is_some()) {
            Some(i) => {
                if let Ok(info) = Info::from_plist(i.clone()) {
                    self.info = info;
                }
            }
            None => self.refresh_info()?,
        }
        self.canvas = policy::canvas(&self.info.raw, self.info.features);
        debug!(
            "airplay: canvas {}x{} (max fps {:?}, from displays: {})",
            self.canvas.width, self.canvas.height, self.canvas.max_fps, self.canvas.from_display
        );

        if !media_first {
            // Early RECORD (§4.4).
            if !self.skip_record && self.has_audio {
                let resp = self.record()?;
                if resp.status == 455 {
                    debug!("airplay: RECORD refused with 455; sending it after the streams");
                } else {
                    check(resp, "RECORD")?;
                    self.record_pending = false;
                }
            }
            // SETUP #2 (§4.6).
            let resp = self.audio_setup(layout, None)?;
            let resp = if LAYOUT_REFUSED.contains(&resp.status) {
                debug!(
                    "airplay: audio SETUP refused ({}), other layout",
                    resp.status
                );
                self.audio_setup(layout.other(), None)?
            } else {
                resp
            };
            let resp = check(resp, "SETUP (audio)")?;
            let body = plist_of(&resp, "audio SETUP response")?;
            self.audio.ports = parse_audio_response(&body);
            if self.events.is_none() {
                self.connect_events(SessionResponse::parse(&body).event_port, clock.clone());
            }
        }
        match self.audio.ports {
            Some(p) => debug!("airplay: audio RTP port {}, RTCP port {}", p.rtp, p.rtcp),
            None => info!("airplay: receiver gave no audio ports; video only"),
        }
        Ok(())
    }

    fn audio_setup(&self, layout: AudioLayout, session: Option<Plist>) -> Result<Response> {
        let req = AudioRequest {
            stream_id: self.audio_id,
            codec: self.audio.codec,
            latency_max: self.leads.audio_samples(),
            latency_min: self.leads.audio_min_samples(&self.info),
            layout,
            shk: self.audio.key,
            control_port: udp_port(&self.audio.sockets.control)?,
            mdc_seed: self.mdc_seed.filter(|_| layout == AudioLayout::S),
        };
        let body = streams_body(req.descriptor(), session).to_bytes();
        self.request(
            "SETUP",
            &self.audio_uri(),
            &[],
            Some((BPLIST, body)),
            DEFAULT_TIMEOUT,
        )
    }

    fn record(&self) -> Result<Response> {
        let resp = self.request(
            "RECORD",
            &self.audio_uri(),
            &[
                ("Session", &self.session_uuid),
                ("Range", "npt=0-"),
                ("RTP-Info", "seq=0;rtptime=0"),
            ],
            None,
            DEFAULT_TIMEOUT,
        )?;
        if let Some(l) = resp.headers.get("audio-latency") {
            debug!("airplay: Audio-Latency {l}");
        }
        Ok(resp)
    }

    fn refresh_info(&mut self) -> Result<()> {
        let resp = self.request("GET", "/info", &[], None, INFO_TIMEOUT)?;
        if resp.status == 401 {
            return Err(Error::auth("airplay: GET /info: 401 (password required)"));
        }
        if !resp.is_success() {
            debug!("airplay: info refresh failed with {}", resp.status);
            return Ok(());
        }
        match Info::parse(&resp.body) {
            Ok(i) => self.info = i,
            Err(e) => debug!("airplay: info refresh: {e}"),
        }
        Ok(())
    }

    fn connect_events(&mut self, port: Option<u16>, clock: Option<Arc<PtpClock>>) {
        let Some(port) = port else { return };
        let keys = if self.hap {
            match keys::event_keys(&self.secret.0) {
                Ok(k) => Some(k),
                Err(e) => {
                    warn!("airplay: event keys: {e}");
                    return;
                }
            }
        } else {
            None
        };
        let signals = self.signals.clone();
        let handler = move |ev: Event| match ev {
            Event::UpdateInfo(_) => debug!("airplay event: updateInfo"),
            Event::UpdateTimingPeerInfo(id) => {
                debug!("airplay event: updateTimingPeerInfo {id:?}");
                if let (Some(c), Some(id)) = (&clock, id.filter(|&i| i != 0)) {
                    c.set_timeline(id);
                }
            }
            Event::ForceKeyFrame => {
                debug!("airplay event: forceKeyFrame");
                signals.keyframe_requested.store(true, Ordering::Release);
            }
            Event::Other(t) => debug!("airplay event: {t}"),
        };
        match EventChannel::connect(
            SocketAddr::new(self.peer.ip(), port),
            keys.as_ref(),
            handler,
        ) {
            Ok(ch) => self.events = Some(ch),
            Err(e) => warn!("airplay: no event channel: {e}"),
        }
    }

    /// The receiver cannot mirror (no feature bit 7: a speaker such as a
    /// HomePod or a Devialet Phantom), so it gets audio only.
    pub fn audio_only(&self) -> bool {
        self.audio_only
    }

    /// SETUP #3 and the data connection (§4.7, §4.8).
    fn connect_video(&mut self) -> Result<TcpStream> {
        let (shk, shiv) = match &self.fairplay {
            Some(fp) => (fp.master, fp.eiv),
            // §5.3: placeholders without FairPlay.
            None if self.hap => {
                let k = crate::airplay::secure::Keys::control(&self.secret.0)?;
                let mut shk = [0u8; 16];
                let mut shiv = [0u8; 16];
                shk.copy_from_slice(&k.write[..16]);
                shiv.copy_from_slice(&k.read[..16]);
                (shk, shiv)
            }
            // Legacy without FairPlay: random values that also key the
            // video (§5.2; untested on any receiver).
            None => (random_array()?, random_array()?),
        };
        self.video_shk = Some(shk);
        let req = VideoRequest {
            stream_id: self.video_id,
            latency_ms: self.leads.video_ms,
            shk,
            shiv,
        };
        let body = streams_body(req.descriptor(), None).to_bytes();
        let resp = check(
            self.request(
                "SETUP",
                &self.video_uri(),
                &[],
                Some((BPLIST, body)),
                DEFAULT_TIMEOUT,
            )?,
            "SETUP (video)",
        )?;
        let body = plist_of(&resp, "video SETUP response")?;
        let port = parse_video_response(&body)
            .ok_or_else(|| Error::protocol("airplay: video SETUP response without dataPort"))?;
        if self.events.is_none() {
            let clock = match &self.timeline {
                Timeline::Ptp(c) => Some(c.clone()),
                Timeline::Ntp => None,
            };
            self.connect_events(SessionResponse::parse(&body).event_port, clock);
        }
        let addr = SocketAddr::new(self.peer.ip(), port);
        let data = TcpStream::connect_timeout(&addr, DATA_CONNECT_TIMEOUT)
            .map_err(|e| Error::io(format!("airplay: connect video data {addr}"), e))?;
        let _ = data.set_nodelay(true);
        debug!("airplay: video data connection to {addr}");
        Ok(data)
    }

    /// SETUP #3 and the data connection unless the receiver is
    /// [`audio_only`](Self::audio_only), then the initial volume and a
    /// pending RECORD (§4.7–§4.11). Returns the connected data socket of a
    /// mirroring receiver.
    pub fn start_video(&mut self) -> Result<Option<TcpStream>> {
        let data = if self.audio_only() {
            None
        } else {
            Some(self.connect_video()?)
        };
        if let (Some(seed), Some(port)) = (
            self.mdc_seed,
            self.audio.ports.and_then(|p| p.media_data_control),
        ) {
            let keys = keys::media_data_control_keys(&self.secret.0, seed)?;
            match MediaDataControl::connect(SocketAddr::new(self.peer.ip(), port), &keys) {
                Ok(m) => self.mdc = Some(m),
                Err(e) => debug!("airplay: no MediaDataControl: {e}"),
            }
        }

        // Initial volume (§4.9, §8.9).
        let mut initial = policy::info_volume(&self.info);
        if initial.is_none()
            && policy::should_query_volume(&self.info, self.version.as_deref(), self.has_audio)
        {
            let resp = self.request(
                "GET_PARAMETER",
                &self.audio_uri(),
                &[],
                Some((TEXT_PARAMETERS, b"volume\r\n".to_vec())),
                VOLUME_TIMEOUT,
            )?;
            if resp.is_success() {
                initial = policy::parse_volume(&resp.body);
                debug!("airplay: receiver volume {initial:?}");
            }
        }
        // Late RECORD (§4.10).
        if self.record_pending && !self.skip_record {
            check(self.record()?, "RECORD")?;
            self.record_pending = false;
        }
        if self.has_audio {
            if let Some(v) = policy::initial_volume(&self.info, initial) {
                self.set_volume(v);
            }
        }
        Ok(data)
    }

    /// `SET_PARAMETER volume` (failure is not fatal).
    pub fn set_volume(&self, v: f64) {
        let body = policy::volume_body(policy::outgoing_volume(v));
        match self.request(
            "SET_PARAMETER",
            &self.audio_uri(),
            &[],
            Some((TEXT_PARAMETERS, body)),
            DEFAULT_TIMEOUT,
        ) {
            Ok(r) if r.is_success() => debug!("airplay: volume set to {v}"),
            Ok(r) => debug!("airplay: SET_PARAMETER volume: {}", r.status),
            Err(e) => warn!("airplay: SET_PARAMETER volume: {e}"),
        }
    }

    /// `TEARDOWN` for the whole session (§4.14), then closes the side
    /// channels. Safe to call more than once.
    pub fn teardown(&mut self, timeout: Duration) -> Result<()> {
        let deadline = Instant::now() + timeout;
        let r = if self.torn_down {
            Ok(())
        } else {
            self.torn_down = true;
            let uri = self.audio_uri();
            // Another request (a `/feedback` to a receiver that stopped
            // answering) may hold the connection; do not wait for it past
            // the deadline.
            match lock_control_until(&self.control, deadline) {
                None => Err(Error::timeout(
                    "airplay: TEARDOWN: control connection busy (receiver not answering)",
                )),
                Some(mut c) => {
                    let left = deadline
                        .saturating_duration_since(Instant::now())
                        .max(Duration::from_millis(100));
                    // An empty dict, not no body: an LG restarts its
                    // AirPlay service on a body-less one (§4.14).
                    let body = Some((BPLIST, Plist::dict().to_bytes()));
                    match c.request("TEARDOWN", &uri, &[], body, left) {
                        Ok(r) if r.is_success() => {
                            debug!("airplay: session torn down");
                            Ok(())
                        }
                        Ok(r) => Err(Error::protocol(format!(
                            "airplay: TEARDOWN answered {} {}",
                            r.status, r.reason
                        ))),
                        // The Apple TV often closes the control connection
                        // instead of answering; that ends the session too
                        // (§4.14, §13).
                        Err(e) if e.kind() == crate::error::ErrorKind::Closed => {
                            debug!("airplay: receiver closed the connection on TEARDOWN ({e})");
                            Ok(())
                        }
                        Err(e) => Err(e),
                    }
                }
            }
        };
        if let Some(mut ev) = self.events.take() {
            ev.close();
        }
        if let Some(mut m) = self.mdc.take() {
            m.close();
        }
        self.ntp = None;
        if r.is_err() {
            if let Some(s) = &self.control_sock {
                let _ = s.shutdown(std::net::Shutdown::Both);
            }
        }
        r
    }

    /// After a failed setup: TEARDOWN within 2 s, else close (§4.14).
    fn cleanup(&mut self) {
        if let Err(e) = self.teardown(CLEANUP_TEARDOWN_TIMEOUT) {
            debug!("airplay: cleanup: {e}");
        }
    }
}

/// Whether this build includes FairPlay (the `fairplay` feature).
pub const FAIRPLAY_BUILT: bool = cfg!(feature = "fairplay");

/// The `X-Apple-ET` header both `/fp-setup` requests carry (§2.2).
const FP_ENCRYPTION_TYPE: &str = "32";
/// Their `Content-Type` (§2.2).
const FP_CONTENT_TYPE: &str = "application/octet-stream";

/// The error for a receiver that needs FairPlay in a build without it.
pub fn fairplay_required(name: &str, why: &str) -> Error {
    Error::unsupported(format!(
        "airplay: {name} needs FairPlay ({why}), which this build does not include: \
         enable tvpipe's `fairplay` feature (LGPL-3.0-or-later code, linked statically: \
         the program then has the LGPL's obligations, including relinkability), or use \
         the `tvpipe` command-line tool"
    ))
    .with_code("fairplay-required")
}

#[cfg(not(feature = "fairplay"))]
fn fair_play<S: ControlStream>(
    _control: &mut Control<S>,
    _secret: &[u8],
) -> Result<Option<FairPlayKeys>> {
    Err(fairplay_required("the receiver", "built without it"))
}

/// `POST /fp-setup` ×2 (§2.2). `None`: the receiver does not do
/// FairPlay (404). Any other failure aborts.
#[cfg(feature = "fairplay")]
fn fair_play<S: ControlStream>(
    control: &mut Control<S>,
    secret: &[u8],
) -> Result<Option<FairPlayKeys>> {
    let mut fp = tvpipe_fairplay::FpSession::new().map_err(fp_error)?;
    let post = |control: &mut Control<S>, body: Vec<u8>| {
        control.request(
            "POST",
            "/fp-setup",
            &[("X-Apple-ET", FP_ENCRYPTION_TYPE)],
            Some((FP_CONTENT_TYPE, body)),
            DEFAULT_TIMEOUT,
        )
    };
    let m2 = post(control, fp.m1().to_vec())?;
    if m2.status == 404 {
        debug!("airplay: /fp-setup not found; no FairPlay");
        return Ok(None);
    }
    let m2 = check(m2, "fp-setup m1")?;
    let m3 = fp.m3(&m2.body).map_err(fp_error)?;
    let m4 = post(control, m3.to_vec())?;
    if m4.status == 404 {
        debug!("airplay: /fp-setup m3 not found; no FairPlay");
        return Ok(None);
    }
    let m4 = check(m4, "fp-setup m3")?;
    fp.check_m4(&m4.body).map_err(fp_error)?;
    let k_fp: [u8; 16] = random_array()?;
    let eiv: [u8; 16] = random_array()?;
    let ekey = fp.wrap_key(&k_fp).map_err(fp_error)?;
    // §2.2: HAP mixes the pair-verify secret in (as does a raw verify
    // with X-Apple-PD: 1, which we would always send).
    let master = keys::stream_master_key(&k_fp, secret);
    debug!("airplay: FairPlay done");
    Ok(Some(FairPlayKeys { master, eiv, ekey }))
}

#[cfg(feature = "fairplay")]
fn fp_error(e: tvpipe_fairplay::Error) -> Error {
    use tvpipe_fairplay::ErrorKind as K;
    match e.kind() {
        K::Malformed => Error::malformed(e.to_string()),
        K::Unsupported => Error::unsupported(e.to_string()),
        K::Crypto => Error::crypto(e.to_string()),
        _ => Error::protocol(e.to_string()),
    }
}

#[cfg(all(test, feature = "fairplay"))]
mod fairplay_tests {
    use super::*;

    /// The whole `/fp-setup` exchange against a real receiver over the
    /// verified control channel (the CLI's pairings):
    ///
    /// ```text
    /// TVPIPE_ATV=192.168.1.34 cargo test hardware_fp_setup -- --ignored --nocapture
    /// ```
    #[test]
    #[ignore]
    fn hardware_fp_setup() {
        use crate::airplay::credentials::Store;
        use crate::airplay::pair;

        let Ok(target) = std::env::var("TVPIPE_ATV") else {
            eprintln!("TVPIPE_ATV not set; skipping");
            return;
        };
        let target = pair::resolve(&target).unwrap();
        let store = Store::open(&crate::storage::Storage::cli()).unwrap();
        let control = pair::connect(&target, &store).unwrap();
        let secret = control.shared.secret().to_vec();
        let mut c = Control::new(control.client);
        let keys = fair_play(&mut c, &secret).unwrap().expect("FairPlay ran");
        eprintln!("fp-setup ok; ekey {} bytes", keys.ekey.len());
        // The connection is still usable afterwards.
        let resp = c
            .request("GET", "/info", &[], None, DEFAULT_TIMEOUT)
            .unwrap();
        eprintln!("GET /info after fp-setup: {}", resp.status);
    }
}
