//! `MirrorSink`: the AirPlay screen-mirroring [`Sink`]
//! (docs/airplay-mirroring.md).
//!
//! [`connect_mirror`] pair-verifies, runs FairPlay and the session setup
//! up to the audio SETUP ([`Session::establish`]), so the canvas and
//! audio format are known before ffmpeg starts. [`Sink::start`] runs the
//! video SETUP, connects the data channel and starts:
//!
//! - `airplay-video`: writes codec packets, encrypted frames and the 1 s
//!   heartbeat to the data connection (one writer, whole packets);
//! - `airplay-feedback`: `POST /feedback` every 2 s (re-anchors PTP);
//! - `airplay-data`: watches the data connection for the receiver ending
//!   the session;
//! - `airplay-rtcp`: answers retransmit requests on the audio control
//!   socket.
//!
//! [`Sink::push`] timestamps video and queues it for the writer; audio is
//! wrapped as verbatim ALAC, encrypted and sent at once (with a sync
//! packet first and then every second).
//!
//! Timing: the session's [`MediaClock`] (handed over by the fanout with
//! [`Sink::set_clock`], shared with the other receivers; ARCHITECTURE.md)
//! maps pts to capture instants; without one, a private clock is anchored
//! on the first frame and re-anchored when frames are more than
//! [`MAX_LATENESS`] late or [`MAX_EARLY`] early. The session timeline
//! (PTP via response headers, or NTP) maps those to receiver time.
//!
//! Sources: docs/airplay-mirroring.md §4.8, §4.11, §4.13, §6, §7.4,
//! §8.2–§8.8; ARCHITECTURE.md, "Timing and Latency".

use std::collections::VecDeque;
use std::io::{Read, Write};
use std::net::{IpAddr, SocketAddr, TcpStream, UdpSocket};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use crate::airplay::audio::{
    alac_verbatim, sync_ntp, sync_ptp, AudioCipher, Packetizer, Redundancy, ALAC_FRAME_SAMPLES,
    SAMPLE_RATE,
};
use crate::airplay::keys;
use crate::airplay::legacy_pair::{self, Connected};
use crate::airplay::mirror::{self, avcc_record, codec_header, frame_payload, VideoCipher};
use crate::airplay::pair::{self, SecureClient};
use crate::airplay::policy::{self, bit};
use crate::airplay::secure::SecureStream;
use crate::airplay::session::{
    lock_control, ControlStream, MirrorOptions, NoMemory, PtpMemory, ReceiverKey, Session,
    SetupError, DEFAULT_TIMEOUT, STOP_TEARDOWN_TIMEOUT,
};
use crate::airplay::setup::AudioCodecId;
use crate::airplay::timing::{
    anchor_from_headers, fp_from_duration, fp_to_ns, ntp_clock, Timeline, NTP_EPOCH_OFFSET_FP,
};
use crate::error::{Error, Result};
use crate::media::clock::{SessionClock, SinkClock, Tolerance};
use crate::media::h264::{self, AvcConfig};
use crate::types::{
    AudioCodec, AudioFamily, AudioFormat, AudioInfo, Capabilities, EncodedFrame, Sink, SinkStatus,
    TrackKind, VideoCodec, VideoInfo, VIDEO_CLOCK_RATE,
};
use crate::util::ratio::Ratio;
use crate::util::time::ticks_to_duration;

/// Frames later than this re-anchor the media clock.
pub const MAX_LATENESS: Duration = Duration::from_millis(100);
/// Frames earlier than this re-anchor it too (a jump in the input).
pub const MAX_EARLY: Duration = Duration::from_secs(1);
pub const FEEDBACK_INTERVAL: Duration = Duration::from_secs(2);
pub const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(1);
pub const SYNC_INTERVAL: Duration = Duration::from_secs(1);
/// Write timeouts (§6.5).
const FRAME_WRITE_TIMEOUT: Duration = Duration::from_secs(2);
const CODEC_WRITE_TIMEOUT: Duration = Duration::from_secs(1);
const HEARTBEAT_WRITE_TIMEOUT: Duration = Duration::from_secs(5);
/// How long `stop` lets the writer send what is still queued.
const STOP_DRAIN: Duration = Duration::from_millis(500);
/// After TEARDOWN: how long `stop` waits for the sink's threads.
const STOP_JOIN: Duration = Duration::from_secs(1);
/// After a failed write: how long the writer waits for the reader to see
/// the receiver closing the connection (which makes it no failure).
const WRITE_FAILURE_GRACE: Duration = Duration::from_millis(250);
/// Video packets queued for the writer before frames are dropped.
const MAX_QUEUED: usize = 32;
const MAX_QUEUED_BYTES: usize = 8 << 20;
/// Capture instants further than this from the predicted ones mean the
/// media clock was re-anchored.
const CLOCK_SHIFT_TOLERANCE: Duration = Duration::from_millis(1);
/// Consecutive stale audio frames at start-up before giving up (§8.8).
const MAX_STALE_AT_START: u32 = 128;
/// Burst pacing: packets per window (§8.4).
const BURST_PACKETS: u32 = 12;
const BURST_WINDOW: Duration = Duration::from_millis(5);
/// Bitrate ceiling. The reference stops at 12000 kbit/s (§6.6), with
/// its own adaptation below; 25 Mbit/s per mirroring stream is the
/// bandwidth AirPlay receivers' makers quote (§2.6). The defaults stay
/// lower (1080p60: about 12 Mbit/s); `--bitrate` may go up to this.
const MAX_BITRATE_KBPS: u32 = 25_000;

/// The production stream type.
pub type SecureMirrorSink = MirrorSink<SecureStream<TcpStream>>;

/// Connects to an AirPlay receiver for mirroring: pair-verify (stored
/// credentials, else transient), FairPlay, session setup. Falls back from
/// PTP to NTP on a fresh connection when PTP fails (§2.5), and remembers
/// that in the credential store so the next session uses NTP at once.
pub fn connect_mirror(
    target: &pair::Target,
    opts: &MirrorOptions,
    storage: &crate::storage::Storage,
) -> Result<AnyMirrorSink> {
    let store = std::cell::RefCell::new(crate::airplay::credentials::Store::open(storage)?);
    let name = target.label();
    let first = legacy_pair::connect(target, &mut store.borrow_mut())?;
    match first {
        Connected::Hap(control) => {
            let mut first = Some(*control);
            connect_full(
                name,
                opts,
                &RECONNECT,
                &mut StoreMemory(&store),
                |timeout| {
                    let control = match (first.take(), timeout) {
                        (Some(c), _) => c,
                        (None, Some(t)) => pair::connect_within(target, &store.borrow(), t)?,
                        (None, None) => pair::connect(target, &store.borrow())?,
                    };
                    let secret = control.shared.secret().to_vec();
                    let client: SecureClient = control.client;
                    Ok((client, control.addr, secret, true))
                },
            )
            .map_err(|e| refusal(e, target))
            .map(AnyMirrorSink::Hap)
        }
        Connected::Legacy {
            client,
            addr,
            secret,
        } => {
            warn!("airplay: {name}: legacy profile (untested on hardware)");
            let mut first = Some((client, addr, secret));
            connect_with(name, opts, |_| match first.take() {
                Some((client, addr, secret)) => Ok((client, addr, secret, false)),
                // The legacy profile never uses PTP, so there is no retry.
                None => Err(Error::protocol("airplay: legacy session cannot be retried")),
            })
            .map_err(|e| refusal(e, target))
            .map(AnyMirrorSink::Legacy)
        }
    }
}

/// A session's 403 from a receiver whose advertisement says its Apple Home
/// takes only its members: `home-only` (§2.1).
fn refusal(e: Error, target: &pair::Target) -> Error {
    if e.code() == Some("forbidden") && target.home_only() {
        crate::airplay::access::home_only(&target.label())
    } else {
        e
    }
}

/// [`PtpMemory`] in the credential store (saved at once).
struct StoreMemory<'a>(&'a std::cell::RefCell<crate::airplay::credentials::Store>);

impl PtpMemory for StoreMemory<'_> {
    fn ptp_failed(&self, key: &ReceiverKey) -> bool {
        self.0.borrow().ptp_failed(key)
    }
    fn remember_ptp_failed(&mut self, key: &ReceiverKey, name: &str) {
        let mut store = self.0.borrow_mut();
        store.remember_ptp_failed(key, name);
        if let Err(e) = store.save() {
            debug!("airplay: could not remember the PTP failure: {e}");
        }
    }
}

/// A mirroring sink of either crypto profile.
pub enum AnyMirrorSink {
    /// Encrypted control channel (HAP pair-verify).
    Hap(SecureMirrorSink),
    /// Plaintext control channel (legacy raw pair-verify).
    Legacy(MirrorSink<TcpStream>),
}

macro_rules! any {
    ($self:ident, $s:ident => $e:expr) => {
        match $self {
            AnyMirrorSink::Hap($s) => $e,
            AnyMirrorSink::Legacy($s) => $e,
        }
    };
}

impl Sink for AnyMirrorSink {
    fn name(&self) -> &str {
        any!(self, s => s.name())
    }
    fn capabilities(&self) -> &Capabilities {
        any!(self, s => s.capabilities())
    }
    fn set_clock(&mut self, clock: SessionClock) {
        any!(self, s => s.set_clock(clock))
    }
    fn start(&mut self, video: &VideoInfo, audio: Option<&AudioInfo>) -> Result<()> {
        any!(self, s => s.start(video, audio))
    }
    fn push(&mut self, frame: &EncodedFrame) -> Result<SinkStatus> {
        any!(self, s => s.push(frame))
    }
    fn wants_keyframe(&self) -> bool {
        any!(self, s => s.wants_keyframe())
    }
    fn stop(&mut self) -> Result<()> {
        any!(self, s => s.stop())
    }
}

/// A fresh authenticated control connection: client, peer, shared
/// secret, HAP profile.
pub type Fresh<S> = (crate::net::rtsp::RtspClient<S>, SocketAddr, Vec<u8>, bool);

/// How [`connect_full`] reconnects after a PTP failure (§2.5).
#[derive(Debug, Clone, Copy)]
pub struct Reconnect {
    /// The pause before each attempt.
    pub pauses: &'static [Duration],
    /// What an attempt has to authenticate in.
    pub timeout: Duration,
}

/// Up to three attempts, 5 s each, over about 22 s: a receiver may ignore
/// a new connection while it is still busy with the abandoned session
/// (the Samsung Frame, §10), and one that answers at all answers pairing
/// in well under a second.
pub const RECONNECT: Reconnect = Reconnect {
    pauses: &[
        Duration::from_millis(500),
        Duration::from_secs(2),
        Duration::from_secs(5),
    ],
    timeout: Duration::from_secs(5),
};

/// [`connect_full`] without memory and with [`RECONNECT`].
pub fn connect_with<S: ControlStream>(
    name: String,
    opts: &MirrorOptions,
    connect: impl FnMut(Option<Duration>) -> Result<Fresh<S>>,
) -> Result<MirrorSink<S>> {
    connect_full(name, opts, &RECONNECT, &mut NoMemory, connect)
}

/// [`connect_mirror`] over any connector: establishes the session, and
/// when PTP fails tears it down and retries with NTP on a new connection
/// (§2.5). `connect(None)` gives the first connection, `connect(Some(t))`
/// a new one that has to authenticate within `t`.
pub fn connect_full<S: ControlStream>(
    name: String,
    opts: &MirrorOptions,
    reconnect: &Reconnect,
    memory: &mut dyn PtpMemory,
    mut connect: impl FnMut(Option<Duration>) -> Result<Fresh<S>>,
) -> Result<MirrorSink<S>> {
    let mut opts = opts.clone();
    let mut fresh = connect(None)?;
    loop {
        let (client, peer, secret, hap) = fresh;
        match Session::establish(client, peer, secret, hap, &opts, memory) {
            Ok(s) => return Ok(MirrorSink::new(name, s, &opts)),
            Err(SetupError::PtpFailed(e)) if opts.ptp => {
                // Not a warning: NTP works, and the receiver gets it at
                // once from now on.
                info!("airplay: {name}: no PTP timing ({e}); using NTP");
                opts.ptp = false;
                fresh = reconnect_after_ptp(&name, reconnect, &mut connect)?;
            }
            Err(e) => return Err(e.into_error()),
        }
    }
}

/// The new connection after a PTP failure, within `r`'s attempts.
fn reconnect_after_ptp<S: ControlStream>(
    name: &str,
    r: &Reconnect,
    connect: &mut impl FnMut(Option<Duration>) -> Result<Fresh<S>>,
) -> Result<Fresh<S>> {
    let mut last = None;
    for (i, pause) in r.pauses.iter().enumerate() {
        std::thread::sleep(*pause);
        match connect(Some(r.timeout)) {
            Ok(f) => return Ok(f),
            // Refused credentials do not get better by waiting.
            Err(e) if e.kind() == crate::error::ErrorKind::Auth => return Err(e),
            Err(e) => {
                debug!("airplay: {name}: reconnect {} failed: {e}", i + 1);
                last = Some(e);
            }
        }
    }
    let why = last.map_or_else(String::new, |e| format!(" ({e})"));
    Err(Error::timeout(format!(
        "airplay: {name} did not take a new connection after its PTP setup failed{why}; \
         the next attempt uses NTP from the start: try again in a minute"
    )))
}

/// The private clock's rule (a sink used without a fanout).
const PRIVATE_CLOCK: Tolerance = Tolerance {
    late: MAX_LATENESS,
    early: MAX_EARLY,
};

/// Maps pts to capture instants (like the Cast sink): on the session's
/// clock when there is one, else on the private one (early frames keep
/// their future instants, frames far off re-anchor).
fn capture_instant(clock: &SinkClock, pts: u64, rate: u32, now: Instant) -> Instant {
    clock.instant(pts, rate, now)
}

// ---------------------------------------------------------------------------
// Video writer

enum Item {
    Codec(Vec<u8>),
    Frame {
        payload: Vec<u8>,
        ts: u64,
        idr: bool,
    },
}

impl Item {
    fn len(&self) -> usize {
        match self {
            Item::Codec(p) => p.len(),
            Item::Frame { payload, .. } => payload.len(),
        }
    }
}

#[derive(Default)]
struct Queue {
    items: VecDeque<Item>,
    bytes: usize,
    closed: bool,
    /// After `closed`: queued packets are written until then, the rest
    /// is dropped (a slow receiver must not hold up a stop).
    drain_until: Option<Instant>,
}

/// State shared between the sink and its threads.
struct Shared {
    queue: Mutex<Queue>,
    cond: Condvar,
    /// The receiver ended the session.
    finished: AtomicBool,
    /// A fatal error in a thread.
    failed: Mutex<Option<Error>>,
    /// Stopping: threads exit, errors are expected.
    stopping: AtomicBool,
    /// The first video frame went out (audio may start).
    first_frame_sent: AtomicBool,
    /// A frame was dropped; skip to the next keyframe.
    need_key: AtomicBool,
    /// When the receiver last answered `POST /feedback` (or the stream
    /// started).
    last_answer: Mutex<Instant>,
}

impl Shared {
    fn queue(&self) -> MutexGuard<'_, Queue> {
        self.queue.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn fail(&self, e: Error) {
        if self.stopping.load(Ordering::Acquire) {
            debug!("airplay: after stop: {e}");
            return;
        }
        // `push` returns it; the session logs it (and may reconnect).
        debug!("airplay: {e}");
        let mut f = self.failed.lock().unwrap_or_else(|e| e.into_inner());
        f.get_or_insert(e);
    }

    fn take_failure(&self) -> Option<Error> {
        self.failed.lock().unwrap_or_else(|e| e.into_inner()).take()
    }

    fn answered(&self) {
        *self.last_answer.lock().unwrap_or_else(|e| e.into_inner()) = Instant::now();
    }

    fn silent_for(&self) -> Duration {
        self.last_answer
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .elapsed()
    }
}

fn write_packet(sock: &mut TcpStream, bytes: &[u8], timeout: Duration) -> Result<()> {
    let _ = sock.set_write_timeout(Some(timeout));
    sock.write_all(bytes)
        .map_err(|e| Error::io("airplay: video data write", e))
}

enum Next {
    Item(Item),
    Heartbeat,
    Done,
}

fn writer_loop(shared: &Shared, mut sock: TcpStream, mut cipher: VideoCipher, timeline: Timeline) {
    let mut next_heartbeat: Option<Instant> = None;
    let mut frames = 0u64;
    loop {
        let next = {
            let mut q = shared.queue();
            loop {
                if q.closed && q.drain_until.is_some_and(|t| Instant::now() >= t) {
                    if !q.items.is_empty() {
                        debug!(
                            "airplay: dropping {} queued video packets at stop",
                            q.items.len()
                        );
                    }
                    q.items.clear();
                    q.bytes = 0;
                }
                if let Some(it) = q.items.pop_front() {
                    q.bytes -= it.len();
                    break Next::Item(it);
                }
                if q.closed {
                    break Next::Done;
                }
                let now = Instant::now();
                match next_heartbeat {
                    Some(at) if now >= at => break Next::Heartbeat,
                    Some(at) => {
                        q = shared
                            .cond
                            .wait_timeout(q, at - now)
                            .map(|(g, _)| g)
                            .unwrap_or_else(|e| e.into_inner().0);
                    }
                    None => q = shared.cond.wait(q).unwrap_or_else(|e| e.into_inner()),
                }
            }
        };
        let r = match next {
            Next::Done => return,
            Next::Heartbeat => {
                next_heartbeat = Some(Instant::now() + HEARTBEAT_INTERVAL);
                trace!("airplay: heartbeat");
                write_packet(&mut sock, &mirror::heartbeat(), HEARTBEAT_WRITE_TIMEOUT)
            }
            Next::Item(Item::Codec(p)) => {
                debug!("airplay: codec packet ({} bytes)", p.len());
                write_packet(&mut sock, &p, CODEC_WRITE_TIMEOUT)
            }
            Next::Item(Item::Frame { payload, ts, idr }) => cipher
                .frame_packet(payload, ts, idr, timeline.timeline_id())
                .and_then(|pkt| {
                    write_packet(&mut sock, &pkt, FRAME_WRITE_TIMEOUT)?;
                    frames += 1;
                    if frames == 1 {
                        debug!("airplay: first video frame sent ({} bytes)", pkt.len());
                        shared.first_frame_sent.store(true, Ordering::Release);
                        next_heartbeat = Some(Instant::now() + HEARTBEAT_INTERVAL);
                    }
                    Ok(())
                }),
        };
        if let Err(e) = r {
            // The receiver closing the connection fails the write too;
            // that is the end of the session, not a loss, once the
            // reader sees it.
            let until = Instant::now() + WRITE_FAILURE_GRACE;
            while !shared.finished.load(Ordering::Acquire) && Instant::now() < until {
                std::thread::sleep(Duration::from_millis(5));
            }
            if !shared.finished.load(Ordering::Acquire) {
                shared.fail(e);
            }
            let mut q = shared.queue();
            q.items.clear();
            q.bytes = 0;
            q.closed = true;
            return;
        }
    }
}

// ---------------------------------------------------------------------------
// Video and audio state on the push side

struct VideoState {
    length_size: usize,
    sps: Vec<u8>,
    pps: Vec<u8>,
    width: u32,
    height: u32,
    need_codec: bool,
    last_ts: Option<u64>,
    lead: u64,
}

impl VideoState {
    fn new(video: &VideoInfo, lead_ms: u32) -> Result<VideoState> {
        if video.codec != VideoCodec::H264 {
            return Err(Error::unsupported(
                "airplay: only H.264 mirroring is implemented",
            ));
        }
        let cfg = AvcConfig::parse(&video.avcc)?;
        let sps = cfg
            .sps
            .first()
            .cloned()
            .ok_or_else(|| Error::malformed("airplay: avcC without SPS"))?;
        let pps = cfg
            .pps
            .first()
            .cloned()
            .ok_or_else(|| Error::malformed("airplay: avcC without PPS"))?;
        let mut v = VideoState {
            length_size: cfg.length_size as usize,
            sps: Vec::new(),
            pps,
            width: video.width,
            height: video.height,
            need_codec: true,
            last_ts: None,
            lead: fp_from_duration(Duration::from_millis(lead_ms as u64)),
        };
        v.set_sps(sps);
        Ok(v)
    }

    fn set_sps(&mut self, sps: Vec<u8>) {
        if let Ok(s) = h264::parse_sps(&sps) {
            if s.width > 0 && s.height > 0 {
                self.width = s.width;
                self.height = s.height;
            }
        }
        self.sps = sps;
    }

    /// §6.3: strictly increasing timestamps.
    fn timestamp(&mut self, t: u64) -> u64 {
        let ts = match self.last_ts {
            Some(prev) if t <= prev => prev + 1,
            _ => t,
        };
        self.last_ts = Some(ts);
        ts
    }
}

struct AudioState {
    channels: u8,
    packetizer: Arc<Mutex<Packetizer>>,
    data: UdpSocket,
    control: UdpSocket,
    rtcp: SocketAddr,
    lead: Duration,
    lead_samples: u32,
    started: bool,
    stale: u32,
    /// `rtp = pts + offset` (mod 2³²).
    offset: u32,
    last_pts: Option<u64>,
    /// The capture instant of the last frame (to see clock re-anchors).
    last_capture: Option<Instant>,
    last_sync: Option<Instant>,
    first_sync: bool,
    window: (Instant, u32),
    frames: u64,
}

fn lock_pk(p: &Mutex<Packetizer>) -> MutexGuard<'_, Packetizer> {
    p.lock().unwrap_or_else(|e| e.into_inner())
}

impl AudioState {
    fn pace(&mut self) {
        let now = Instant::now();
        if now.duration_since(self.window.0) >= BURST_WINDOW {
            self.window = (now, 0);
        }
        if self.window.1 >= BURST_PACKETS {
            let until = self.window.0 + BURST_WINDOW;
            if let Some(d) = until.checked_duration_since(now) {
                std::thread::sleep(d);
            }
            self.window = (Instant::now(), 0);
        }
        self.window.1 += 1;
    }

    fn send_sync(&mut self, timeline: &Timeline, rtp_now: u32, t: Instant) {
        let first = self.first_sync;
        self.first_sync = false;
        let play = rtp_now.wrapping_sub(self.lead_samples);
        let pkt = match timeline {
            Timeline::Ptp(c) => sync_ptp(first, play, fp_to_ns(c.at(t)), c.timeline()).to_vec(),
            Timeline::Ntp => sync_ntp(
                first,
                play,
                ntp_clock(t).wrapping_add(NTP_EPOCH_OFFSET_FP),
                rtp_now,
            )
            .to_vec(),
        };
        if first {
            debug!("airplay: first audio sync (rtp {rtp_now}, play {play})");
        }
        if let Err(e) = self.control.send_to(&pkt, self.rtcp) {
            debug!("airplay: sync packet: {e}");
        }
        self.last_sync = Some(Instant::now());
    }

    fn push(
        &mut self,
        frame: &EncodedFrame,
        clock: &SinkClock,
        timeline: &Timeline,
    ) -> Result<SinkStatus> {
        let now = Instant::now();
        let capture = capture_instant(clock, frame.pts, SAMPLE_RATE, now);
        if !self.started {
            // §8.8: drop frames that would arrive too late.
            if capture + self.lead <= now + Duration::from_millis(5) {
                self.stale += 1;
                if self.stale >= MAX_STALE_AT_START {
                    return Err(Error::protocol(
                        "airplay: audio frames keep arriving too late to play",
                    ));
                }
                return Ok(SinkStatus::Dropped);
            }
            self.started = true;
            self.offset = ALAC_FRAME_SAMPLES.wrapping_sub(frame.pts as u32);
        }
        let samples = (frame.data.len() / (2 * self.channels as usize)) as u32;
        if let (Some(last), Some(last_capture)) = (self.last_pts, self.last_capture) {
            if frame.pts < last {
                // A new segment: continue after the last frame (§8.5).
                let last_rtp = (last as u32).wrapping_add(self.offset);
                self.offset = last_rtp
                    .wrapping_add(ALAC_FRAME_SAMPLES)
                    .wrapping_sub(frame.pts as u32);
                self.first_sync = true;
                self.last_sync = None;
            } else {
                // The media clock re-anchored (the source stalled and the
                // frames arrive late): keep the RTP timeline on the same
                // sample<->time line by leaving a gap of the shift in the
                // RTP timestamps (§8.2: a real gap stays a gap). The
                // receiver keeps its first mapping; without the gap every
                // later packet would be late by the accumulated stalls.
                let predicted = last_capture + ticks_to_duration(frame.pts - last, SAMPLE_RATE);
                if capture > predicted + CLOCK_SHIFT_TOLERANCE {
                    let gap = ((capture - predicted).as_secs_f64() * SAMPLE_RATE as f64).round();
                    debug!("airplay: audio clock moved {gap} samples ahead; RTP gap");
                    self.offset = self.offset.wrapping_add(gap as u32);
                } else if capture + CLOCK_SHIFT_TOLERANCE < predicted {
                    // Moved back (a jump in the input): announce a new
                    // mapping (§8.5).
                    debug!("airplay: audio clock moved back; new sync mapping");
                    self.first_sync = true;
                    self.last_sync = None;
                }
            }
        }
        self.last_pts = Some(frame.pts);
        self.last_capture = Some(capture);
        let rtp = (frame.pts as u32).wrapping_add(self.offset);
        let alac = alac_verbatim(&frame.data, self.channels)?;
        let due = self
            .last_sync
            .is_none_or(|t| now.duration_since(t) >= SYNC_INTERVAL);
        if due {
            self.send_sync(timeline, rtp, capture);
        }
        let packets = lock_pk(&self.packetizer).frame(rtp, &alac)?;
        for p in packets {
            self.pace();
            if let Err(e) = self.data.send(&p) {
                debug!("airplay: audio send: {e}");
            }
        }
        self.frames += 1;
        if self.frames == 1 {
            debug!("airplay: first audio frame sent (rtp {rtp}, {samples} samples)");
        }
        Ok(SinkStatus::Accepted)
    }
}

// ---------------------------------------------------------------------------
// The sink

/// Debug statistics on frame timing, logged every few seconds: how late
/// each track arrives relative to a fixed pts schedule (anchored on the
/// first frame, never moved), and the playout headroom it is sent with.
#[derive(Default)]
struct Diag {
    origin: Option<(Instant, Duration)>,
    since: Option<Instant>,
    /// [video, audio]: (min, max) arrival lateness and min headroom, ms.
    late: [(i64, i64); 2],
    headroom: [i64; 2],
    count: [u64; 2],
}

const DIAG_INTERVAL: Duration = Duration::from_secs(5);

impl Diag {
    fn note(&mut self, track: usize, media: Duration, now: Instant, deadline: Instant) {
        let (t0, m0) = *self.origin.get_or_insert((now, media));
        let since = *self.since.get_or_insert(now);
        let ms = |a: Instant, b: Instant| -> i64 {
            if a >= b {
                (a - b).as_millis() as i64
            } else {
                -((b - a).as_millis() as i64)
            }
        };
        let due = if media >= m0 {
            t0 + (media - m0)
        } else {
            t0.checked_sub(m0 - media).unwrap_or(t0)
        };
        let late = ms(now, due);
        let head = ms(deadline, now);
        if self.count[track] == 0 {
            self.late[track] = (late, late);
            self.headroom[track] = head;
        } else {
            let l = &mut self.late[track];
            *l = (l.0.min(late), l.1.max(late));
            self.headroom[track] = self.headroom[track].min(head);
        }
        self.count[track] += 1;
        if now.duration_since(since) >= DIAG_INTERVAL {
            debug!(
                "airplay: timing: video {} frames late {}..{} ms headroom >= {} ms; \
                 audio {} frames late {}..{} ms headroom >= {} ms",
                self.count[0],
                self.late[0].0,
                self.late[0].1,
                self.headroom[0],
                self.count[1],
                self.late[1].0,
                self.late[1].1,
                self.headroom[1]
            );
            self.count = [0, 0];
            self.since = Some(now);
        }
    }
}

struct Media {
    diag: Diag,
    clock: SinkClock,
    video: VideoState,
    audio: Option<AudioState>,
    data_sock: TcpStream,
    threads: Vec<JoinHandle<()>>,
}

pub struct MirrorSink<S: ControlStream> {
    name: String,
    caps: Capabilities,
    session: Session<S>,
    shared: Arc<Shared>,
    media: Option<Media>,
    /// The session's media clock (from the fanout), if any.
    clock: Option<SessionClock>,
    /// [`MirrorOptions::feedback_timeout`].
    feedback_timeout: Duration,
    stopped: bool,
}

impl<S: ControlStream> MirrorSink<S> {
    pub fn new(name: String, session: Session<S>, opts: &MirrorOptions) -> MirrorSink<S> {
        let c = session.canvas;
        let fps = c.max_fps.unwrap_or(60).clamp(1, 60);
        let audio_formats = if opts.audio && session.audio.ports.is_some() {
            match session.audio.codec {
                AudioCodecId::Alac => vec![AudioFormat {
                    codec: AudioCodec::Alac,
                    sample_rate: SAMPLE_RATE,
                    channels: 2,
                }],
                AudioCodecId::AacEld => vec![AudioFormat {
                    codec: AudioCodec::AacEld,
                    sample_rate: SAMPLE_RATE,
                    channels: 2,
                }],
            }
        } else {
            Vec::new()
        };
        // An explicit resolution may go up to the decoder's maximum (a
        // stream larger than the canvas was accepted, §2.6; whether it is
        // shown at full resolution is not verified).
        let (max_width, max_height) = if opts.decoder_max {
            (c.max_width.max(c.width), c.max_height.max(c.height))
        } else {
            (c.width, c.height)
        };
        let caps = Capabilities {
            max_width,
            max_height,
            max_fps: Ratio::integer(fps),
            video_codecs: vec![VideoCodec::H264],
            audio_formats,
            audio_family: AudioFamily::AirPlay,
            max_bitrate_kbps: Some(MAX_BITRATE_KBPS),
            max_pixels_per_second: None,
            min_latency_ms: None,
            preferred_latency_ms: Some(session.leads.video_ms),
            // An IDR at least every ~0.5 s (docs/airplay-mirroring.md §6.6).
            max_key_interval_ms: Some(500),
            // The canvas from SETUP is the screen's shape.
            display_aspect: crate::types::aspect_of(c.width, c.height)
                .or(Some(crate::types::DEFAULT_DISPLAY_ASPECT)),
        };
        info!(
            "airplay: {name}: session ready ({}, {}x{}@{fps}{}, audio {:?})",
            match session.timeline {
                Timeline::Ptp(_) => "PTP",
                Timeline::Ntp => "NTP",
            },
            c.width,
            c.height,
            if (max_width, max_height) != (c.width, c.height) {
                format!(", up to its decoder's {max_width}x{max_height}")
            } else {
                String::new()
            },
            caps.audio_formats.first().map(|f| f.codec)
        );
        MirrorSink {
            name,
            caps,
            session,
            shared: Arc::new(Shared {
                queue: Mutex::new(Queue::default()),
                cond: Condvar::new(),
                finished: AtomicBool::new(false),
                failed: Mutex::new(None),
                stopping: AtomicBool::new(false),
                first_frame_sent: AtomicBool::new(false),
                need_key: AtomicBool::new(false),
                last_answer: Mutex::new(Instant::now()),
            }),
            feedback_timeout: opts.feedback_timeout,
            media: None,
            clock: None,
            stopped: false,
        }
    }

    pub fn session(&self) -> &Session<S> {
        &self.session
    }

    fn audio_state(&self, audio: Option<&AudioInfo>) -> Result<Option<AudioState>> {
        let (Some(info), Some(ports)) = (audio, self.session.audio.ports) else {
            return Ok(None);
        };
        if info.codec != AudioCodec::PcmS16le || info.sample_rate != SAMPLE_RATE {
            return Err(Error::unsupported(format!(
                "airplay: audio must be 44.1 kHz s16le PCM (got {:?} at {} Hz)",
                info.codec, info.sample_rate
            )));
        }
        if self.session.audio.codec != AudioCodecId::Alac {
            return Err(Error::unsupported(
                "airplay: AAC-ELD audio is not implemented",
            ));
        }
        let ip = self.session.peer.ip();
        let cipher = match (&self.session.audio.key, &self.session.fairplay) {
            (Some(k), _) => AudioCipher::chacha(k),
            (None, Some(fp)) => AudioCipher::aes_cbc(&fp.master, &fp.eiv)?,
            (None, None) => AudioCipher::Clear,
        };
        let features = self.session.info.features;
        let redundancy = if policy::has(features, bit::RFC2198) {
            Redundancy::Rfc2198
        } else {
            Redundancy::Resend
        };
        let socks = &self.session.audio.sockets;
        let clone = |s: &UdpSocket| {
            s.try_clone()
                .map_err(|e| Error::io("airplay: clone UDP", e))
        };
        let data = clone(&socks.data)?;
        data.connect(SocketAddr::new(ip, ports.rtp))
            .map_err(|e| Error::io("airplay: audio connect", e))?;
        Ok(Some(AudioState {
            channels: info.channels,
            packetizer: Arc::new(Mutex::new(Packetizer::new(cipher, redundancy))),
            data,
            control: clone(&socks.control)?,
            rtcp: SocketAddr::new(ip, ports.rtcp),
            lead: Duration::from_millis(self.session.leads.audio_ms as u64),
            lead_samples: self.session.leads.audio_samples(),
            started: false,
            stale: 0,
            offset: 0,
            last_pts: None,
            last_capture: None,
            last_sync: None,
            first_sync: true,
            window: (Instant::now(), 0),
            frames: 0,
        }))
    }

    fn spawn(
        threads: &mut Vec<JoinHandle<()>>,
        name: &str,
        f: impl FnOnce() + Send + 'static,
    ) -> Result<()> {
        threads.push(
            std::thread::Builder::new()
                .name(name.into())
                .spawn(f)
                .map_err(|e| Error::io(format!("airplay: spawn {name}"), e))?,
        );
        Ok(())
    }

    fn start_inner(&mut self, video: &VideoInfo, audio: Option<&AudioInfo>) -> Result<()> {
        let vstate = VideoState::new(video, self.session.leads.video_ms)?;
        let astate = self.audio_state(audio)?;
        let data = self.session.start_video()?;
        let cipher = if self.session.hap {
            VideoCipher::chacha(&keys::video_key(
                &self.session.secret.0,
                self.session.video_id,
            )?)
        } else {
            // §5.2: K with FairPlay; without it the random `shk` we sent
            // (audio then goes in the clear). Untested on hardware.
            let shk = match (&self.session.fairplay, self.session.video_shk) {
                (Some(fp), _) => fp.master,
                (None, Some(shk)) => {
                    warn!("airplay: legacy profile without FairPlay (untested on any receiver)");
                    shk
                }
                (None, None) => return Err(Error::protocol("airplay: no video key")),
            };
            let (k, iv) = keys::legacy_video_key_iv(&shk, self.session.video_id);
            VideoCipher::aes_ctr(&k, &iv)?
        };
        let mut threads = Vec::new();
        let clone = |s: &TcpStream| {
            s.try_clone()
                .map_err(|e| Error::io("airplay: clone socket", e))
        };
        self.shared.answered();

        // Writer.
        {
            let shared = self.shared.clone();
            let sock = clone(&data)?;
            let timeline = self.session.timeline.clone();
            Self::spawn(&mut threads, "airplay-video", move || {
                writer_loop(&shared, sock, cipher, timeline)
            })?;
        }
        // Data connection reader: the receiver closing it (EOF, or a
        // reset when our frames were still unread) means it ended
        // mirroring (§4.14); a receiver that is gone (another address,
        // off the network) cannot close anything. Other errors (the
        // kernel giving up on retransmissions) mean it is lost.
        {
            let shared = self.shared.clone();
            let mut sock = clone(&data)?;
            Self::spawn(&mut threads, "airplay-data", move || {
                let mut buf = [0u8; 1024];
                let error = loop {
                    match sock.read(&mut buf) {
                        Ok(0) => break None,
                        Err(e) if e.kind() == std::io::ErrorKind::ConnectionReset => break None,
                        Ok(n) => trace!("airplay: {n} bytes on the video data connection"),
                        Err(e)
                            if matches!(
                                e.kind(),
                                std::io::ErrorKind::WouldBlock
                                    | std::io::ErrorKind::TimedOut
                                    | std::io::ErrorKind::Interrupted
                            ) => {}
                        Err(e) => break Some(e),
                    }
                };
                if shared.stopping.load(Ordering::Acquire) {
                    return;
                }
                match error {
                    None => {
                        info!("airplay: receiver closed the video connection");
                        shared.finished.store(true, Ordering::Release);
                    }
                    Some(e) => shared.fail(Error::io("airplay: video data connection", e)),
                }
            })?;
        }
        // Feedback (§4.13), first one immediately.
        {
            let shared = self.shared.clone();
            let control = self.session.control.clone();
            let timeline = self.session.timeline.clone();
            Self::spawn(&mut threads, "airplay-feedback", move || {
                feedback_loop(&shared, &control, &timeline)
            })?;
        }
        // Retransmits (§8.6).
        if let Some(a) = &astate {
            let shared = self.shared.clone();
            let sock = a
                .control
                .try_clone()
                .map_err(|e| Error::io("airplay: clone UDP", e))?;
            let pk = a.packetizer.clone();
            let ip = self.session.peer.ip();
            Self::spawn(&mut threads, "airplay-rtcp", move || {
                rtcp_loop(&shared, &sock, &pk, ip)
            })?;
        }
        debug!(
            "airplay: {}: streaming {}x{} video{}",
            self.name,
            vstate.width,
            vstate.height,
            if astate.is_some() {
                " and ALAC audio"
            } else {
                ""
            }
        );
        self.media = Some(Media {
            diag: Diag::default(),
            clock: self
                .clock
                .clone()
                .map_or_else(|| SinkClock::private(PRIVATE_CLOCK), SinkClock::shared),
            video: vstate,
            audio: astate,
            data_sock: data,
            threads,
        });
        Ok(())
    }

    fn queue_video(shared: &Shared, items: Vec<Item>, keyframe: bool) -> SinkStatus {
        let mut q = shared.queue();
        let bytes: usize = items.iter().map(Item::len).sum();
        if q.closed {
            return SinkStatus::Dropped;
        }
        if q.items.len() + items.len() > MAX_QUEUED || q.bytes + bytes > MAX_QUEUED_BYTES {
            if !shared.need_key.swap(true, Ordering::AcqRel) {
                debug!("airplay: video queue full; skipping to the next keyframe");
            }
            return SinkStatus::Dropped;
        }
        if keyframe {
            shared.need_key.store(false, Ordering::Release);
        }
        q.bytes += bytes;
        q.items.extend(items);
        drop(q);
        shared.cond.notify_all();
        SinkStatus::Accepted
    }

    fn push_video(&mut self, frame: &EncodedFrame) -> Result<SinkStatus> {
        let Some(m) = self.media.as_mut() else {
            return Err(Error::protocol("airplay: push before start"));
        };
        let now = Instant::now();
        let p = frame_payload(&frame.data, m.video.length_size)?;
        if p.idr {
            if let Some(sps) = p.sps.as_ref().filter(|s| **s != m.video.sps) {
                debug!("airplay: SPS changed");
                m.video.set_sps(sps.clone());
                m.video.need_codec = true;
            }
            if let Some(pps) = p.pps.as_ref().filter(|s| **s != m.video.pps) {
                debug!("airplay: PPS changed");
                m.video.pps = pps.clone();
                m.video.need_codec = true;
            }
        } else if m.video.need_codec || self.shared.need_key.load(Ordering::Acquire) {
            return Ok(SinkStatus::Dropped);
        }
        if p.data.is_empty() {
            return Ok(SinkStatus::Dropped);
        }
        let capture = capture_instant(&m.clock, frame.pts, VIDEO_CLOCK_RATE, now);
        m.diag.note(
            0,
            ticks_to_duration(frame.pts, VIDEO_CLOCK_RATE),
            now,
            capture + Duration::from_millis(self.session.leads.video_ms as u64),
        );
        let ts = m
            .video
            .timestamp(self.session.timeline.at(capture).wrapping_add(m.video.lead));
        let mut items = Vec::with_capacity(2);
        if p.idr && m.video.need_codec {
            let rec = avcc_record(&m.video.sps, &m.video.pps)?;
            let mut pkt = codec_header(rec.len(), ts, m.video.width, m.video.height)?.to_vec();
            pkt.extend_from_slice(&rec);
            items.push(Item::Codec(pkt));
        }
        items.push(Item::Frame {
            payload: p.data,
            ts,
            idr: p.idr,
        });
        let status = Self::queue_video(&self.shared, items, p.idr);
        if status == SinkStatus::Accepted && p.idr {
            m.video.need_codec = false;
            if self
                .session
                .signals
                .keyframe_requested
                .swap(false, Ordering::AcqRel)
            {
                debug!("airplay: keyframe request served");
            }
        }
        Ok(status)
    }

    fn push_audio(&mut self, frame: &EncodedFrame) -> Result<SinkStatus> {
        let Some(m) = self.media.as_mut() else {
            return Err(Error::protocol("airplay: push before start"));
        };
        let Some(a) = m.audio.as_mut() else {
            return Ok(SinkStatus::Dropped);
        };
        if !self.shared.first_frame_sent.load(Ordering::Acquire) {
            return Ok(SinkStatus::Dropped);
        }
        let now = Instant::now();
        let r = a.push(frame, &m.clock, &self.session.timeline);
        if let Some(capture) = m.clock.instant_for(frame.pts, SAMPLE_RATE) {
            m.diag.note(
                1,
                ticks_to_duration(frame.pts, SAMPLE_RATE),
                now,
                capture + a.lead,
            );
        }
        r
    }
}

fn feedback_loop<S: ControlStream>(
    shared: &Shared,
    control: &Mutex<crate::airplay::session::Control<S>>,
    timeline: &Timeline,
) {
    let mut next = Instant::now();
    loop {
        {
            let mut q = shared.queue();
            loop {
                if shared.stopping.load(Ordering::Acquire) || q.closed {
                    return;
                }
                let now = Instant::now();
                if now >= next {
                    break;
                }
                q = shared
                    .cond
                    .wait_timeout(q, next - now)
                    .map(|(g, _)| g)
                    .unwrap_or_else(|e| e.into_inner().0);
            }
        }
        next += FEEDBACK_INTERVAL;
        let mut c = lock_control(control);
        match c.request("POST", "/feedback", &[], None, DEFAULT_TIMEOUT) {
            Ok(r) => {
                let t1 = Instant::now();
                drop(c);
                shared.answered();
                if !r.is_success() {
                    debug!("airplay: /feedback answered {}", r.status);
                }
                if let (Timeline::Ptp(clock), Some(r1)) =
                    (timeline, anchor_from_headers(&r.headers))
                {
                    clock.reanchor(t1, r1);
                }
            }
            Err(e) if c.is_broken() => {
                drop(c);
                shared.fail(e);
                return;
            }
            Err(e) => warn!("airplay: /feedback: {e}"),
        }
    }
}

fn rtcp_loop(shared: &Shared, sock: &UdpSocket, pk: &Mutex<Packetizer>, peer: IpAddr) {
    let _ = sock.set_read_timeout(Some(Duration::from_millis(100)));
    let mut buf = [0u8; 2048];
    while !shared.stopping.load(Ordering::Acquire) {
        let (n, from) = match sock.recv_from(&mut buf) {
            Ok(v) => v,
            Err(_) => continue,
        };
        if from.ip() != peer {
            continue;
        }
        let replies = lock_pk(pk).retransmit(&buf[..n]);
        if replies.is_empty() {
            trace!("airplay: {n} bytes on the audio control socket");
            continue;
        }
        debug!("airplay: retransmitting {} audio packets", replies.len());
        for r in replies {
            let _ = sock.send_to(&r, from);
        }
    }
}

impl<S: ControlStream> Sink for MirrorSink<S> {
    fn name(&self) -> &str {
        &self.name
    }

    fn capabilities(&self) -> &Capabilities {
        &self.caps
    }

    fn set_clock(&mut self, clock: SessionClock) {
        self.clock = Some(clock);
    }

    fn start(&mut self, video: &VideoInfo, audio: Option<&AudioInfo>) -> Result<()> {
        if self.media.is_some() {
            return Err(Error::protocol("airplay: sink already started"));
        }
        self.start_inner(video, audio)
    }

    fn push(&mut self, frame: &EncodedFrame) -> Result<SinkStatus> {
        // The receiver ending the session wins over the errors closing
        // its connections causes.
        if self.shared.finished.load(Ordering::Acquire) {
            return Ok(SinkStatus::Finished);
        }
        if let Some(e) = self.shared.take_failure() {
            return Err(e);
        }
        if self.media.is_some() {
            let silent = self.shared.silent_for();
            if silent >= self.feedback_timeout {
                return Err(Error::timeout(format!(
                    "airplay: no answer to /feedback for {:.0} s",
                    silent.as_secs_f64()
                )));
            }
        }
        match frame.track {
            TrackKind::Video => self.push_video(frame),
            TrackKind::Audio(AudioFamily::AirPlay) => self.push_audio(frame),
            TrackKind::Audio(_) => Ok(SinkStatus::Dropped),
        }
    }

    fn wants_keyframe(&self) -> bool {
        // Before start, after a dropped frame, or when the receiver asked
        // (`forceKeyFrame`): the fanout then skips to the next IDR.
        self.media.is_none()
            || self.shared.need_key.load(Ordering::Acquire)
            || self
                .session
                .signals
                .keyframe_requested
                .load(Ordering::Acquire)
    }

    fn stop(&mut self) -> Result<()> {
        if self.stopped {
            return Ok(());
        }
        self.stopped = true;
        // Let the writer finish what is queued, then stop everything.
        {
            let mut q = self.shared.queue();
            q.closed = true;
            q.drain_until = Some(Instant::now() + STOP_DRAIN);
        }
        self.shared.cond.notify_all();
        let mut threads = Vec::new();
        if let Some(m) = self.media.as_mut() {
            // The writer drains and exits on `closed`.
            if let Some(w) = (!m.threads.is_empty()).then(|| m.threads.remove(0)) {
                let _ = w.join();
            }
            threads = std::mem::take(&mut m.threads);
        }
        self.shared.stopping.store(true, Ordering::Release);
        self.shared.cond.notify_all();
        let r = self.session.teardown(STOP_TEARDOWN_TIMEOUT);
        if let Some(m) = self.media.take() {
            let _ = m.data_sock.shutdown(std::net::Shutdown::Both);
            if let Some(a) = &m.audio {
                debug!("airplay: sent {} audio frames", a.frames);
            }
        }
        // A `/feedback` blocked on a receiver that stopped answering is
        // woken by the shutdown above on Linux and macOS, not on Windows
        // (`util::thread`): leave it to its own timeout.
        let deadline = Instant::now() + STOP_JOIN;
        for t in threads {
            crate::util::thread::join_until(t, deadline);
        }
        debug!("airplay: {}: stopped", self.name);
        r
    }
}

impl<S: ControlStream> Drop for MirrorSink<S> {
    fn drop(&mut self) {
        let _ = self.stop();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::airplay::fake_mirror::{Behaviour, FakeMirror, CLOCK_ID};
    use crate::airplay::policy::Leads;
    use crate::codec::bplist::Plist;
    use crate::net::rtsp::RtspClient;
    use crate::util::vectors;

    fn connect(fake: &FakeMirror, opts: &MirrorOptions) -> MirrorSink<TcpStream> {
        try_connect(fake, opts).unwrap()
    }

    fn try_connect(fake: &FakeMirror, opts: &MirrorOptions) -> Result<MirrorSink<TcpStream>> {
        connect_with("fake".into(), opts, connector(fake))
    }

    /// Connections to `fake`; a reconnect stands in for pair-verify with a
    /// request the fake has to answer within the attempt's timeout.
    fn connector(
        fake: &FakeMirror,
    ) -> impl FnMut(Option<Duration>) -> Result<Fresh<TcpStream>> + '_ {
        |timeout| {
            let tcp = TcpStream::connect(fake.addr).unwrap();
            let mut client = RtspClient::new(tcp);
            if let Some(t) = timeout {
                client.conn().get_ref().set_read_timeout(Some(t)).unwrap();
                client.request("POST", "/pair-verify", &[], None)?;
            }
            Ok((client, fake.addr, fake.secret.clone(), true))
        }
    }

    /// The fake's `/info` key.
    fn fake_key() -> ReceiverKey {
        ReceiverKey {
            device_id: "AA:BB:CC:00:00:0A".into(),
            source_version: "960.13.1".into(),
        }
    }

    fn timing_protocols(fake: &FakeMirror) -> Vec<String> {
        fake.rec()
            .setup_bodies
            .iter()
            .filter_map(|b| b.get("timingProtocol").and_then(Plist::as_str))
            .map(str::to_owned)
            .collect()
    }

    /// Quick reconnects for tests.
    const FAST: Reconnect = Reconnect {
        pauses: &[
            Duration::from_millis(50),
            Duration::from_millis(300),
            Duration::from_millis(1000),
        ],
        timeout: Duration::from_millis(400),
    };

    fn avcc() -> (Vec<u8>, Vec<u8>, Vec<u8>) {
        let b = vectors::load("airplay-mirror/video.txt")
            .into_iter()
            .find(|b| b.name() == "avcC record for codec packet")
            .unwrap();
        let (sps, pps) = (b.hex("sps"), b.hex("pps"));
        let mut rec = vec![1, sps[1], sps[2], sps[3], 0xff, 0xe1];
        rec.extend_from_slice(&(sps.len() as u16).to_be_bytes());
        rec.extend_from_slice(&sps);
        rec.push(1);
        rec.extend_from_slice(&(pps.len() as u16).to_be_bytes());
        rec.extend_from_slice(&pps);
        (rec, sps, pps)
    }

    fn nal(bytes: &[u8]) -> Vec<u8> {
        [&(bytes.len() as u32).to_be_bytes()[..], bytes].concat()
    }

    fn video_info() -> VideoInfo {
        VideoInfo {
            codec: VideoCodec::H264,
            width: 1920,
            height: 1080,
            fps: Ratio::integer(30),
            avcc: avcc().0,
        }
    }

    fn audio_info() -> AudioInfo {
        AudioInfo {
            codec: AudioCodec::PcmS16le,
            sample_rate: 44_100,
            channels: 2,
            frame_samples: 352,
            config: Vec::new(),
        }
    }

    fn video(i: u64, sps: &[u8], pps: &[u8]) -> EncodedFrame {
        let idr = i % 15 == 0;
        let data = if idr {
            [
                nal(&[0x09, 0xf0]),
                nal(sps),
                nal(pps),
                nal(&[0x65, 0x88, i as u8]),
            ]
            .concat()
        } else {
            [nal(&[0x09, 0xf0]), nal(&[0x41, 0x9a, i as u8])].concat()
        };
        EncodedFrame {
            track: TrackKind::Video,
            pts: i * 3000,
            keyframe: idr,
            data: data.into(),
        }
    }

    fn pcm(i: u64) -> Vec<u8> {
        (0..352 * 2)
            .flat_map(|s| ((s as i16).wrapping_mul(i as i16 + 1)).to_le_bytes())
            .collect()
    }

    fn audio(i: u64) -> EncodedFrame {
        EncodedFrame {
            track: TrackKind::Audio(AudioFamily::AirPlay),
            pts: i * 352,
            keyframe: true,
            data: pcm(i).into(),
        }
    }

    fn wait_for(what: &str, mut f: impl FnMut() -> bool) {
        let until = Instant::now() + Duration::from_secs(5);
        while !f() {
            assert!(Instant::now() < until, "timed out waiting for {what}");
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    /// Streams 1.3 s of 30 fps video and audio to the fake receiver.
    fn stream(sink: &mut MirrorSink<TcpStream>, frames: u64) -> Vec<SinkStatus> {
        stream_with_stall(sink, frames, None).statuses
    }

    /// What `stream_with_stall` pushed and saw.
    struct Streamed {
        statuses: Vec<SinkStatus>,
        /// The most a push came after its due time (a loaded machine
        /// oversleeping). The audio pushed with video frame `i` is due
        /// with it, so the clock sees it up to [`FRAME`] later still.
        late: Duration,
        /// Per audio frame, right after pushing it: where the sink's
        /// clock put media time 0 (its origin), relative to the start of
        /// the schedule, in ms. Changes are the clock's re-anchors.
        origins_ms: Vec<f64>,
    }

    /// One video frame at 30 fps.
    const FRAME: Duration = Duration::from_micros(33_333);

    /// Like `stream`, but the source stalls for `stall.1` before frame
    /// `stall.0` (like ffmpeg lagging on a badly interleaved file): the
    /// frames after it arrive late and in a burst.
    fn stream_with_stall(
        sink: &mut MirrorSink<TcpStream>,
        frames: u64,
        stall: Option<(u64, Duration)>,
    ) -> Streamed {
        let (_, sps, pps) = avcc();
        let t0 = Instant::now();
        // The clock's origin, read through a pts far after the anchor.
        const PROBE: u64 = 3600 * VIDEO_CLOCK_RATE as u64;
        let origin_ms = |sink: &MirrorSink<TcpStream>| {
            let at = sink
                .media
                .as_ref()?
                .clock
                .instant_for(PROBE, VIDEO_CLOCK_RATE)?;
            let at = at.checked_sub(ticks_to_duration(PROBE, VIDEO_CLOCK_RATE))?;
            Some(match at.checked_duration_since(t0) {
                Some(d) => d.as_secs_f64() * 1000.0,
                None => -(t0 - at).as_secs_f64() * 1000.0,
            })
        };
        let mut s = Streamed {
            statuses: Vec::new(),
            late: Duration::ZERO,
            origins_ms: Vec::new(),
        };
        let mut a = 0u64;
        for i in 0..frames {
            let mut due = t0 + FRAME * i as u32;
            if let Some((at, d)) = stall {
                if i >= at {
                    due += d;
                }
            }
            if let Some(d) = due.checked_duration_since(Instant::now()) {
                std::thread::sleep(d);
            }
            s.late = s.late.max(Instant::now().saturating_duration_since(due));
            s.statuses.push(sink.push(&video(i, &sps, &pps)).unwrap());
            // Audio up to this video frame's time.
            while a * 352 * 90_000 / 44_100 <= i * 3000 {
                s.late = s.late.max(Instant::now().saturating_duration_since(due));
                s.statuses.push(sink.push(&audio(a)).unwrap());
                s.origins_ms.push(origin_ms(sink).unwrap_or(f64::NAN));
                a += 1;
            }
        }
        s
    }

    #[test]
    fn an_explicit_resolution_may_use_the_decoder_maximum() {
        // The fake is the dev Apple TV: 1280x720 nominal, 3840x2160 max.
        let fake = FakeMirror::start(Behaviour::default());
        let opts = MirrorOptions {
            decoder_max: true,
            ..MirrorOptions::default()
        };
        let mut sink = connect(&fake, &opts);
        let caps = sink.capabilities().clone();
        assert_eq!((caps.max_width, caps.max_height), (3840, 2160));
        assert_eq!(caps.display_aspect, Some((16, 9)));
        sink.stop().unwrap();
    }

    #[test]
    fn streams_to_fake_receiver() {
        let fake = FakeMirror::start(Behaviour::default());
        let opts = MirrorOptions::default();
        let mut sink = connect(&fake, &opts);
        let caps = sink.capabilities().clone();
        assert_eq!((caps.max_width, caps.max_height), (1280, 720));
        assert_eq!(caps.audio_formats.len(), 1);
        assert_eq!(caps.audio_family, AudioFamily::AirPlay);
        sink.start(&video_info(), Some(&audio_info())).unwrap();
        let statuses = stream(&mut sink, 40);
        assert!(statuses.iter().all(|s| *s != SinkStatus::Finished));
        wait_for("audio and video", || {
            let r = fake.rec();
            r.video.iter().filter(|p| p.kind == 0).count() == 40 && !r.retransmits.is_empty()
        });
        sink.stop().unwrap();
        sink.stop().unwrap();

        let r = fake.rec();
        assert_eq!(
            r.requests,
            [
                "GET /info",
                &format!("SETUP rtsp://{}/{}", fake.addr, sink.session.audio_id),
                "GET /info",
                &format!("RECORD rtsp://{}/{}", fake.addr, sink.session.audio_id),
                &format!("SETUP rtsp://{}/{}", fake.addr, sink.session.audio_id),
                &format!("SETUP rtsp://{}/{}", fake.addr, sink.session.video_id),
                "POST /feedback",
            ]
            .iter()
            .map(|s| s.to_string())
            .chain(r.requests[7..].iter().cloned())
            .collect::<Vec<_>>()
        );
        assert_eq!(
            r.requests.last().unwrap(),
            &format!("TEARDOWN rtsp://{}/{}", fake.addr, sink.session.audio_id)
        );
        assert!(r.teardown);
        // The body is a bplist of an empty dict (§4.14).
        let (ct, body) = r.teardown_body.clone().unwrap();
        assert_eq!(ct.as_deref(), Some("application/x-apple-binary-plist"));
        assert_eq!(Plist::from_bytes(&body).unwrap(), Plist::dict());
        assert_eq!(body.len(), 42);
        assert_eq!(r.event_replies, 1);
        assert!(r.setup_bodies[0].get("timingPeerInfo").is_some());

        // Video: codec packet, then IDR at the same timestamp; strictly
        // increasing timestamps; SPS/PPS/AUD stripped; heartbeat.
        let (_, sps, pps) = avcc();
        let v = &r.video;
        assert_eq!(v[0].kind, 1);
        assert_eq!(v[0].payload, avcc_record(&sps, &pps).unwrap());
        assert_eq!((v[1].kind, v[1].idr, v[1].ts), (0, true, v[0].ts));
        assert_eq!(v[1].payload, nal(&[0x65, 0x88, 0]));
        assert_eq!(v[1].timeline, CLOCK_ID);
        let frames: Vec<&crate::airplay::fake_mirror::VideoPacket> =
            v.iter().filter(|p| p.kind == 0).collect();
        assert!(frames.windows(2).all(|w| w[1].ts > w[0].ts));
        assert_eq!(frames[1].payload, nal(&[0x41, 0x9a, 1]));
        assert!(!frames[1].idr && frames[15].idr);
        // In-band SPS equal to the avcC one: no second codec packet.
        assert_eq!(v.iter().filter(|p| p.kind == 1).count(), 1);
        assert!(v.iter().any(|p| p.kind == 2), "heartbeat");
        // ~33 ms apart on the receiver's timeline (PTP anchored at the
        // SETUP headers: 1201707.448 s).
        let dt = frames[30].ts - frames[0].ts;
        let secs = dt as f64 / 4_294_967_296.0;
        assert!((0.9..1.2).contains(&secs), "{secs}");
        assert!(frames[0].ts >> 32 >= 1_201_707);

        // Audio: sequence from 1, RTP from 352, verbatim ALAC of our PCM.
        let a = &r.audio;
        assert!(a.len() > 20, "{}", a.len());
        assert_eq!((a[0].0, a[0].1), (1, 352));
        assert_eq!(a[1].1 - a[0].1, 352);
        assert_eq!(a[0].2.len(), 1416);
        // First sync: X bit, PTP form, rtp_play = rtp_now - 3748.
        assert_eq!(&r.sync[0][..4], &[0x90, 0xd7, 0, 4]);
        let play = u32::from_be_bytes(r.sync[0][4..8].try_into().unwrap());
        assert_eq!(play, 352u32.wrapping_sub(Leads::new(None).audio_samples()));
        assert_eq!(&r.sync[0][20..28], &CLOCK_ID.to_be_bytes());
        assert!(r.sync.len() >= 2 && r.sync[1][0] == 0x80);
        // Retransmit answers for seq 1 and 2 carry the stored PT 96 copies.
        assert_eq!(r.retransmits.len(), 2);
        for (i, p) in r.retransmits.iter().enumerate() {
            assert_eq!(&p[..4], &[0x80, 0xd6, 0, 9]);
            assert_eq!(p[5], 96);
            assert_eq!(u16::from_be_bytes([p[6], p[7]]), i as u16 + 1);
        }
    }

    #[test]
    fn audio_payload_is_verbatim_alac() {
        let fake = FakeMirror::start(Behaviour {
            nack_after: None,
            ..Behaviour::default()
        });
        let mut sink = connect(&fake, &MirrorOptions::default());
        sink.start(&video_info(), Some(&audio_info())).unwrap();
        let late = stream_with_stall(&mut sink, 10, None).late;
        wait_for("audio", || fake.rec().audio.len() >= 5);
        sink.stop().unwrap();
        let r = fake.rec();
        // Audio before the first video frame is dropped, so find the first
        // sent frame among the pushed ones; the rest follow in order.
        let first = (0..20u64)
            .find(|&src| alac_verbatim(&pcm(src), 2).unwrap() == r.audio[0].2)
            .expect("ALAC payload of a pushed frame");
        assert_eq!(r.audio[0].1, 352);
        for (k, (seq, ts, payload)) in r.audio.iter().take(5).enumerate() {
            assert_eq!(*seq as usize, k + 1);
            assert_eq!(*payload, alac_verbatim(&pcm(first + k as u64), 2).unwrap());
            if k > 0 {
                // 352 apart, unless a push came so late (a loaded machine)
                // that the clock re-anchored: then the RTP time has a gap.
                let step = ts.wrapping_sub(r.audio[k - 1].1);
                if late < MAX_LATENESS / 2 {
                    assert_eq!(step, 352, "{late:?}");
                } else {
                    assert!((352..1 << 20).contains(&step), "{step} {late:?}");
                }
            }
        }
    }

    #[test]
    fn receiver_closing_data_finishes() {
        let fake = FakeMirror::start(Behaviour {
            close_after_packets: Some(3),
            ..Behaviour::default()
        });
        let mut sink = connect(&fake, &MirrorOptions::default());
        sink.start(&video_info(), None).unwrap();
        let (_, sps, pps) = avcc();
        let mut end = None;
        for i in 0..200 {
            match sink.push(&video(i, &sps, &pps)) {
                Ok(SinkStatus::Finished) => {
                    end = Some(SinkStatus::Finished);
                    break;
                }
                Err(e) => panic!("the receiver ending mirroring is no failure: {e}"),
                _ => std::thread::sleep(Duration::from_millis(20)),
            }
        }
        assert_eq!(end, Some(SinkStatus::Finished));
        sink.stop().unwrap();
    }

    /// Pushes video until `push` says something other than Accepted or
    /// Dropped.
    fn push_until_end(sink: &mut MirrorSink<TcpStream>) -> Result<SinkStatus> {
        let (_, sps, pps) = avcc();
        let until = Instant::now() + Duration::from_secs(15);
        for i in 0.. {
            assert!(Instant::now() < until, "the sink never noticed");
            match sink.push(&video(i, &sps, &pps)) {
                Ok(SinkStatus::Accepted | SinkStatus::Dropped) => {}
                other => return other,
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        unreachable!()
    }

    /// The receiver goes off the network: its connections break or go
    /// quiet without the data connection being closed. That is a
    /// failure (the session may reconnect), not the end of the session.
    #[test]
    fn vanished_receiver_fails_sink() {
        let fake = FakeMirror::start(Behaviour {
            nack_after: None,
            ..Behaviour::default()
        });
        let mut sink = connect(&fake, &MirrorOptions::default());
        sink.start(&video_info(), None).unwrap();
        stream(&mut sink, 5);
        fake.vanish();
        let e = push_until_end(&mut sink).unwrap_err();
        assert_ne!(e.kind(), crate::error::ErrorKind::Unsupported, "{e}");
        let t = Instant::now();
        let _ = sink.stop();
        assert!(t.elapsed() < Duration::from_secs(6), "{:?}", t.elapsed());
        // It serves the next connection as a new session.
        let mut again = connect(&fake, &MirrorOptions::default());
        again.start(&video_info(), None).unwrap();
        stream(&mut again, 5);
        wait_for("second session", || {
            fake.rec()
                .video
                .iter()
                .any(|p| p.session == 1 && p.kind == 0)
        });
        again.stop().unwrap();
    }

    /// `/feedback` goes unanswered: lost after the feedback timeout.
    #[test]
    fn unanswered_feedback_fails_sink() {
        let fake = FakeMirror::start(Behaviour {
            hang_feedback: true,
            nack_after: None,
            ..Behaviour::default()
        });
        let opts = MirrorOptions {
            feedback_timeout: Duration::from_millis(400),
            ..MirrorOptions::default()
        };
        let mut sink = connect(&fake, &opts);
        sink.start(&video_info(), None).unwrap();
        let t0 = Instant::now();
        let e = push_until_end(&mut sink).unwrap_err();
        assert_eq!(e.kind(), crate::error::ErrorKind::Timeout, "{e}");
        assert!(t0.elapsed() >= Duration::from_millis(400));
        let _ = sink.stop();
    }

    #[test]
    fn receiver_keyframe_request() {
        let fake = FakeMirror::start(Behaviour {
            force_keyframe: true,
            nack_after: None,
            ..Behaviour::default()
        });
        let mut sink = connect(&fake, &MirrorOptions::default());
        sink.start(&video_info(), None).unwrap();
        let (_, sps, pps) = avcc();
        assert!(sink.push(&video(0, &sps, &pps)).unwrap() == SinkStatus::Accepted);
        wait_for("forceKeyFrame", || sink.wants_keyframe());
        // A non-IDR leaves the request pending; the next IDR serves it.
        sink.push(&video(1, &sps, &pps)).unwrap();
        assert!(sink.wants_keyframe());
        assert_eq!(
            sink.push(&video(15, &sps, &pps)).unwrap(),
            SinkStatus::Accepted
        );
        assert!(!sink.wants_keyframe());
        sink.stop().unwrap();
    }

    #[test]
    fn no_timing_headers_means_ntp_from_the_start() {
        // Third-party TVs (LG, Samsung Frame) advertise PTP but send no
        // timing headers, and may ignore a second pair-verify after an
        // abandoned PTP session (issue #5): NTP on the first connection.
        let fake = FakeMirror::start(Behaviour {
            no_timing_headers: true,
            nack_after: None,
            ..Behaviour::default()
        });
        let mut sink = connect(&fake, &MirrorOptions::default());
        assert!(matches!(sink.session.timeline, Timeline::Ntp));
        sink.start(&video_info(), Some(&audio_info())).unwrap();
        stream(&mut sink, 3);
        sink.stop().unwrap();
        let r = fake.rec();
        let protocols: Vec<&str> = r
            .setup_bodies
            .iter()
            .filter_map(|b| b.get("timingProtocol").and_then(Plist::as_str))
            .collect();
        assert_eq!(protocols, ["NTP"]);
        let infos = r.requests.iter().filter(|q| *q == "GET /info").count();
        let teardowns = r
            .requests
            .iter()
            .filter(|q| q.starts_with("TEARDOWN"))
            .count();
        assert_eq!((infos, teardowns), (2, 1), "{:?}", r.requests);
        assert!(r.video.iter().any(|p| p.kind == 0));
    }

    #[test]
    fn ptp_without_anchor_falls_back_to_ntp() {
        let fake = FakeMirror::start(Behaviour {
            no_setup_timing_headers: true,
            nack_after: None,
            ..Behaviour::default()
        });
        let mut sink = connect(&fake, &MirrorOptions::default());
        assert!(matches!(sink.session.timeline, Timeline::Ntp));
        sink.start(&video_info(), Some(&audio_info())).unwrap();
        stream(&mut sink, 3);
        sink.stop().unwrap();
        let r = fake.rec();
        let protocols: Vec<&str> = r
            .setup_bodies
            .iter()
            .filter_map(|b| b.get("timingProtocol").and_then(Plist::as_str))
            .collect();
        assert_eq!(protocols, ["PTP", "NTP"]);
        // The failed PTP session was released before the retry.
        let first_teardown = r
            .requests
            .iter()
            .position(|q| q.starts_with("TEARDOWN"))
            .unwrap();
        let second_info = r
            .requests
            .iter()
            .skip(1)
            .position(|q| q == "GET /info")
            .unwrap()
            + 1;
        assert!(first_teardown < second_info, "{:?}", r.requests);
        assert!(r.video.iter().any(|p| p.kind == 0));
    }

    #[test]
    fn ptp_failure_is_remembered() {
        let fake = FakeMirror::start(Behaviour {
            no_setup_timing_headers: true,
            nack_after: None,
            ..Behaviour::default()
        });
        let opts = MirrorOptions::default();
        let mut memory: Vec<ReceiverKey> = Vec::new();
        let mut sink =
            connect_full("fake".into(), &opts, &FAST, &mut memory, connector(&fake)).unwrap();
        sink.stop().unwrap();
        assert_eq!(memory, [fake_key()]);
        assert_eq!(timing_protocols(&fake), ["PTP", "NTP"]);
        // The next session asks for NTP at once, on one connection.
        let mut sink =
            connect_full("fake".into(), &opts, &FAST, &mut memory, connector(&fake)).unwrap();
        assert!(matches!(sink.session.timeline, Timeline::Ntp));
        sink.stop().unwrap();
        assert_eq!(timing_protocols(&fake), ["PTP", "NTP", "NTP"]);
        // Another software version tries PTP again.
        let mut other = vec![ReceiverKey {
            source_version: "960.14.0".into(),
            ..fake_key()
        }];
        let mut sink =
            connect_full("fake".into(), &opts, &FAST, &mut other, connector(&fake)).unwrap();
        sink.stop().unwrap();
        assert_eq!(timing_protocols(&fake)[3], "PTP");
    }

    #[test]
    fn reconnect_waits_out_a_busy_receiver() {
        // Like the reported Samsung Frame: after the PTP SETUP it answers
        // neither the TEARDOWN nor the next connection's pairing for a
        // while. The cleanup TEARDOWN gives up after 2 s; the first two
        // reconnects start by 2.5 s, inside the 4 s, the third after 5 s
        // gets in (wide margins: a loaded CI runner is slow).
        const WAIT: Reconnect = Reconnect {
            pauses: &[
                Duration::from_millis(50),
                Duration::from_millis(50),
                Duration::from_millis(2500),
            ],
            timeout: Duration::from_millis(400),
        };
        let fake = FakeMirror::start(Behaviour {
            no_setup_timing_headers: true,
            deaf_after_ptp: Some(Duration::from_secs(4)),
            nack_after: None,
            ..Behaviour::default()
        });
        let mut memory: Vec<ReceiverKey> = Vec::new();
        let mut sink = connect_full(
            "fake".into(),
            &MirrorOptions::default(),
            &WAIT,
            &mut memory,
            connector(&fake),
        )
        .unwrap();
        assert!(matches!(sink.session.timeline, Timeline::Ntp));
        sink.start(&video_info(), Some(&audio_info())).unwrap();
        stream(&mut sink, 3);
        sink.stop().unwrap();
        assert_eq!(timing_protocols(&fake), ["PTP", "NTP"]);
        let verifies = fake
            .rec()
            .requests
            .iter()
            .filter(|q| *q == "POST /pair-verify")
            .count();
        assert_eq!(verifies, 3, "{:?}", fake.rec().requests);
        assert_eq!(memory, [fake_key()]);
    }

    #[test]
    fn unreachable_after_ptp_failure_says_to_retry() {
        let fake = FakeMirror::start(Behaviour {
            no_setup_timing_headers: true,
            deaf_after_ptp: Some(Duration::from_secs(30)),
            nack_after: None,
            ..Behaviour::default()
        });
        const QUICK: Reconnect = Reconnect {
            pauses: &[Duration::from_millis(10), Duration::from_millis(10)],
            timeout: Duration::from_millis(200),
        };
        let mut memory: Vec<ReceiverKey> = Vec::new();
        let e = connect_full(
            "fake".into(),
            &MirrorOptions::default(),
            &QUICK,
            &mut memory,
            connector(&fake),
        )
        .err()
        .unwrap();
        assert_eq!(e.kind(), crate::error::ErrorKind::Timeout);
        assert!(e.message().contains("uses NTP from the start"), "{e}");
        // Remembered before the reconnect, so the next run skips PTP.
        assert_eq!(memory, [fake_key()]);
    }

    #[test]
    fn stalled_receiver_fails_the_sink() {
        let fake = FakeMirror::start(Behaviour {
            stall_data: true,
            nack_after: None,
            ..Behaviour::default()
        });
        let mut sink = connect(&fake, &MirrorOptions::default());
        sink.start(&video_info(), None).unwrap();
        let (_, sps, pps) = avcc();
        let big = |i: u64| {
            let mut f = video(i, &sps, &pps);
            let mut d = f.data.to_vec();
            d.extend(nal(&vec![0x41; 256 * 1024]));
            f.data = d.into();
            f
        };
        let t0 = Instant::now();
        let mut dropped = 0;
        let err = loop {
            assert!(t0.elapsed() < Duration::from_secs(20), "never failed");
            match sink.push(&big(dropped % 15)) {
                Ok(SinkStatus::Dropped) => dropped += 1,
                Ok(_) => {}
                Err(e) => break e,
            }
            std::thread::sleep(Duration::from_millis(2));
        };
        assert!(dropped > 0, "queue never filled");
        assert!(sink.wants_keyframe());
        assert_eq!(err.kind(), crate::error::ErrorKind::Timeout, "{err}");
        let t = Instant::now();
        sink.stop().unwrap();
        assert!(t.elapsed() < Duration::from_secs(3));
    }

    #[test]
    fn legacy_profile_media() {
        let master = [0x25; 16];
        let eiv = [0xf0; 16];
        let fake = FakeMirror::start(Behaviour {
            legacy: Some((master, eiv)),
            nack_after: None,
            ..Behaviour::default()
        });
        let tcp = TcpStream::connect(fake.addr).unwrap();
        let opts = MirrorOptions::default();
        let mut session = Session::establish(
            RtspClient::new(tcp),
            fake.addr,
            fake.secret.clone(),
            false,
            &opts,
            &mut NoMemory,
        )
        .map_err(SetupError::into_error)
        .unwrap();
        // NTP (PTP needs HAP); no ChaCha audio key.
        assert!(matches!(session.timeline, Timeline::Ntp));
        assert!(session.audio.key.is_none());
        // The fake does no FairPlay; give the session fixed keys.
        session.fairplay = Some(crate::airplay::session::FairPlayKeys {
            master,
            eiv,
            ekey: [0; 72],
        });
        let mut sink = MirrorSink::new("legacy".into(), session, &opts);
        sink.start(&video_info(), Some(&audio_info())).unwrap();
        stream(&mut sink, 20);
        wait_for("media", || {
            let r = fake.rec();
            r.video.iter().filter(|p| p.kind == 0).count() == 20 && r.audio.len() > 5
        });
        sink.stop().unwrap();
        let r = fake.rec();
        assert_eq!(r.event_replies, 1, "plaintext event channel");
        let frames: Vec<_> = r.video.iter().filter(|p| p.kind == 0).collect();
        assert_eq!(frames[0].payload, nal(&[0x65, 0x88, 0]));
        assert_eq!(frames[19].payload, nal(&[0x41, 0x9a, 19]));
        assert_eq!(frames[0].timeline, 0);
        let first = (0..20u64)
            .find(|&src| alac_verbatim(&pcm(src), 2).unwrap() == r.audio[0].2)
            .expect("CBC audio decrypts to a pushed frame");
        assert_eq!(r.audio[1].2, alac_verbatim(&pcm(first + 1), 2).unwrap());
        // The legacy SETUP #1 carries the FairPlay root fields... only when
        // FairPlay ran during setup, which the fake cannot do.
        assert!(r.setup_bodies[0].get("ekey").is_none());
        assert_eq!(
            r.setup_bodies[0]
                .get("timingProtocol")
                .and_then(Plist::as_str),
            Some("NTP")
        );
    }

    /// Legacy without FairPlay (§5.2, untested on any receiver): random
    /// `shk` keys the AES-CTR video, audio goes in the clear, no ekey.
    #[test]
    fn legacy_without_fairplay() {
        let fake = FakeMirror::start(Behaviour {
            legacy: Some(([0; 16], [0; 16])),
            legacy_no_fairplay: true,
            nack_after: None,
            ..Behaviour::default()
        });
        let tcp = TcpStream::connect(fake.addr).unwrap();
        let opts = MirrorOptions::default();
        let session = Session::establish(
            RtspClient::new(tcp),
            fake.addr,
            fake.secret.clone(),
            false,
            &opts,
            &mut NoMemory,
        )
        .map_err(SetupError::into_error)
        .unwrap();
        assert!(session.fairplay.is_none());
        let mut sink = MirrorSink::new("legacy".into(), session, &opts);
        sink.start(&video_info(), Some(&audio_info())).unwrap();
        stream(&mut sink, 10);
        wait_for("media", || {
            let r = fake.rec();
            r.video.iter().filter(|p| p.kind == 0).count() == 10 && r.audio.len() > 3
        });
        sink.stop().unwrap();
        let r = fake.rec();
        assert!(r.setup_bodies.iter().all(|b| b.get("ekey").is_none()));
        let frames: Vec<_> = r.video.iter().filter(|p| p.kind == 0).collect();
        assert_eq!(frames[0].payload, nal(&[0x65, 0x88, 0]));
        assert_eq!(frames[9].payload, nal(&[0x41, 0x9a, 9]));
        assert!((0..20u64).any(|src| alac_verbatim(&pcm(src), 2).unwrap() == r.audio[0].2));
    }

    /// A receiver offering FairPlay with the HAP profile: a build without
    /// FairPlay skips it (the §5.3 placeholders), a build with it tries
    /// `/fp-setup` (404 from the fake) and goes on without. Both stream.
    #[test]
    fn hap_receiver_offering_fairplay_streams_either_way() {
        let fake = FakeMirror::start(Behaviour {
            fairplay_bit: true,
            nack_after: None,
            ..Behaviour::default()
        });
        let opts = MirrorOptions::default();
        let mut sink = connect(&fake, &opts);
        assert!(sink.session.fairplay.is_none());
        sink.start(&video_info(), Some(&audio_info())).unwrap();
        stream(&mut sink, 5);
        wait_for("video", || {
            fake.rec().video.iter().filter(|p| p.kind == 0).count() == 5
        });
        sink.stop().unwrap();
        let tried = fake.rec().requests.iter().any(|r| r.contains("/fp-setup"));
        assert_eq!(tried, crate::airplay::session::FAIRPLAY_BUILT);
    }

    /// The legacy profile with feature 14 needs FairPlay: without it the
    /// session fails with `fairplay-required` before SETUP.
    #[test]
    fn legacy_receiver_needs_fairplay() {
        let fake = FakeMirror::start(Behaviour {
            legacy: Some(([0; 16], [0; 16])),
            legacy_no_fairplay: true,
            fairplay_bit: true,
            nack_after: None,
            ..Behaviour::default()
        });
        let tcp = TcpStream::connect(fake.addr).unwrap();
        let r = Session::establish(
            RtspClient::new(tcp),
            fake.addr,
            fake.secret.clone(),
            false,
            &MirrorOptions::default(),
            &mut NoMemory,
        )
        .map_err(SetupError::into_error);
        if crate::airplay::session::FAIRPLAY_BUILT {
            // /fp-setup is 404: legacy without FairPlay, as before.
            assert!(r.unwrap().fairplay.is_none());
        } else {
            let e = r.err().unwrap();
            assert_eq!(e.code(), Some("fairplay-required"), "{e}");
            assert!(e.to_string().contains("`fairplay` feature"), "{e}");
            assert!(fake.rec().setup_bodies.is_empty());
        }
    }

    /// A receiver that refuses the session after FairPlay was skipped:
    /// `fairplay-required` (with FairPlay built in, the refusal itself).
    #[test]
    fn refusal_without_fairplay_names_it() {
        let fake = FakeMirror::start(Behaviour {
            fairplay_bit: true,
            refuse_session_setup: Some(403),
            nack_after: None,
            ..Behaviour::default()
        });
        let tcp = TcpStream::connect(fake.addr).unwrap();
        let e = Session::establish(
            RtspClient::new(tcp),
            fake.addr,
            fake.secret.clone(),
            true,
            &MirrorOptions::default(),
            &mut NoMemory,
        )
        .map_err(SetupError::into_error)
        .err()
        .unwrap();
        assert_eq!(
            e.code() == Some("fairplay-required"),
            !crate::airplay::session::FAIRPLAY_BUILT,
            "{e}"
        );
    }

    /// After pairing, 403 to the session is `forbidden` (naming the Home
    /// setting), 401 `password-unsupported` (HTTP Digest); `home-only` when
    /// the advertisement says `acl=1` (§2.1).
    #[test]
    fn refused_session_after_pairing() {
        let refused = |status| {
            let fake = FakeMirror::start(Behaviour {
                refuse_session_setup: Some(status),
                nack_after: None,
                ..Behaviour::default()
            });
            let tcp = TcpStream::connect(fake.addr).unwrap();
            let e = Session::establish(
                RtspClient::new(tcp),
                fake.addr,
                fake.secret.clone(),
                true,
                &MirrorOptions::default(),
                &mut NoMemory,
            )
            .map_err(SetupError::into_error)
            .err()
            .unwrap();
            assert_eq!(fake.rec().setup_bodies.len(), 1);
            e
        };
        let e = refused(403);
        assert_eq!((e.code(), e.device()), (Some("forbidden"), Some("Fake TV")));
        assert_eq!(e.kind(), crate::error::ErrorKind::Auth);
        assert!(e.to_string().contains("403 Forbidden"), "{e}");
        assert!(e.to_string().contains("Allow Speaker & TV Access"), "{e}");
        let e = refused(401);
        assert_eq!(e.code(), Some("password-unsupported"), "{e}");
        assert!(e.to_string().contains("turn Require Password off"), "{e}");
        // Others as before.
        assert_eq!(refused(500).code(), None);

        let mut dev = crate::net::device::tests::lan_devices()
            .into_iter()
            .find(|d| d.airplay.is_some())
            .unwrap();
        let name = dev.name.clone();
        let mut target = pair::Target {
            addr: "192.0.2.7:7000".parse().unwrap(),
            device: Some(dev.clone()),
        };
        assert_eq!(refusal(refused(403), &target).code(), Some("forbidden"));
        dev.airplay.as_mut().unwrap().txt.acl = Some(1);
        target.device = Some(dev);
        let e = refusal(refused(403), &target);
        assert_eq!(
            (e.code(), e.device()),
            (Some("home-only"), Some(name.as_str()))
        );
        assert_eq!(refusal(refused(500), &target).code(), None);
    }

    /// Regression (audio stopped on a QuickTime recording): when the
    /// source stalls and the media clock re-anchors, the RTP timestamps
    /// get the same gap, so every sync packet stays on one sample<->time
    /// line (the receiver keeps its first mapping and would otherwise
    /// count every later packet as late).
    #[test]
    fn source_stall_keeps_audio_mapping() {
        let fake = FakeMirror::start(Behaviour {
            nack_after: None,
            ..Behaviour::default()
        });
        let mut sink = connect(&fake, &MirrorOptions::default());
        sink.start(&video_info(), Some(&audio_info())).unwrap();
        let stall = Duration::from_millis(400);
        let st = stream_with_stall(&mut sink, 84, Some((36, stall)));
        wait_for("sync after the stall", || fake.rec().sync.len() >= 3);
        sink.stop().unwrap();
        let r = fake.rec();
        let ms = |d: Duration| d.as_secs_f64() * 1000.0;
        let samples_ms = |n: u32| n as i32 as f64 * 1000.0 / 44_100.0;
        // The received packets by audio frame (the payload tells which).
        let index: std::collections::HashMap<Vec<u8>, usize> = (0..st.origins_ms.len())
            .map(|a| (alac_verbatim(&pcm(a as u64), 2).unwrap(), a))
            .collect();
        let got: Vec<(usize, u32)> = r
            .audio
            .iter()
            .map(|(_, rtp, payload)| (index[payload], *rtp))
            .collect();
        let (a0, rtp0) = got[0];
        let origin0 = st.origins_ms[a0];
        // RTP gaps (beyond 352 per frame) appear exactly where and by as
        // much as the clock re-anchored (moved its origin), so every
        // packet stays on the first sample<->time line.
        let mut gaps_ms = Vec::new();
        let mut last_gap = 0.0;
        for &(a, rtp) in &got {
            let gap = samples_ms(rtp.wrapping_sub(rtp0).wrapping_sub((a - a0) as u32 * 352));
            let moved = st.origins_ms[a] - origin0;
            assert!(
                (gap - moved).abs() < 0.1,
                "audio frame {a}: RTP gap {gap} ms, clock moved {moved} ms since frame {a0}"
            );
            if gap - last_gap > 0.1 {
                gaps_ms.push(gap - last_gap);
            }
            last_gap = gap;
        }
        // The re-anchors add up to the real stall plus lateness: the
        // origin starts at the first push (or at a re-anchor before audio
        // started) and ends at a frame after the stall, each at most
        // `late` plus the audio's lag behind video (one frame) after the
        // schedule. Each re-anchor is a frame more than MAX_LATENESS late.
        let (late_ms, stall_ms) = (ms(st.late + FRAME) + 5.0, ms(stall));
        let end = *st.origins_ms.last().unwrap();
        let what = format!(
            "gaps {gaps_ms:?} ms, {:?} late, origins {origin0} -> {end} ms",
            st.late
        );
        assert!((-1.0..=late_ms).contains(&origin0), "{what}");
        assert!(
            (stall_ms - 1.0..=stall_ms + late_ms).contains(&end),
            "{what}"
        );
        let total: f64 = gaps_ms.iter().sum();
        assert!(
            (stall_ms - origin0 - 1.0..=stall_ms + late_ms).contains(&total),
            "{what}"
        );
        assert!(
            gaps_ms.iter().all(|&g| g >= ms(MAX_LATENESS) - 1.0),
            "{what}"
        );
        // On an idle machine no push is MAX_LATENESS late: the stall is
        // the one re-anchor.
        if late_ms < ms(MAX_LATENESS) {
            assert_eq!(gaps_ms.len(), 1, "{what}");
        }
        // Every sync packet: (rtp_play, T ns). All on one line.
        let points: Vec<(u32, u64)> = r
            .sync
            .iter()
            .map(|p| {
                (
                    u32::from_be_bytes(p[4..8].try_into().unwrap()),
                    u64::from_be_bytes(p[8..16].try_into().unwrap()),
                )
            })
            .collect();
        let (r0, t0) = points[0];
        for &(rtp, t) in &points[1..] {
            let by_rtp = rtp.wrapping_sub(r0) as f64 / 44_100.0;
            let by_time = (t - t0) as f64 / 1e9;
            assert!(
                (by_rtp - by_time).abs() < 0.003,
                "sync mapping moved: {by_rtp} s of samples vs {by_time} s"
            );
        }
        // Only the first sync packet has the X bit.
        assert!(r.sync[1..].iter().all(|p| p[0] == 0x80));
    }

    /// UDP from another sender reaching the fake's audio ports (a sink of
    /// another test still sending to a port that was freed and reused) is
    /// ignored and counted; before, it failed authentication and killed
    /// the fake's audio thread (seen once in a loaded run).
    #[test]
    fn fake_receiver_ignores_stray_udp() {
        let fake = FakeMirror::start(Behaviour {
            nack_after: None,
            ..Behaviour::default()
        });
        let mut sink = connect(&fake, &MirrorOptions::default());
        sink.start(&video_info(), Some(&audio_info())).unwrap();
        let a = sink.media.as_ref().unwrap().audio.as_ref().unwrap();
        let (data, rtcp) = (a.data.peer_addr().unwrap(), a.rtcp);
        let stray = UdpSocket::bind("127.0.0.1:0").unwrap();
        let mut junk = vec![0x80u8, 0x60, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0];
        junk.extend_from_slice(&[7; 40]);
        let send = || {
            stray.send_to(&junk, data).unwrap();
            stray.send_to(&junk, rtcp).unwrap();
        };
        // Before our sender's first packet, and between its packets.
        send();
        stream(&mut sink, 10);
        send();
        stream(&mut sink, 10);
        wait_for("audio, sync and four strays", || {
            let r = fake.rec();
            !r.audio.is_empty() && !r.sync.is_empty() && r.strays == 4
        });
        sink.stop().unwrap();
        let r = fake.rec();
        assert_eq!(r.strays, 4);
        // Only our sync packets (type 0x57, marker set) got through.
        assert!(r.sync.iter().all(|p| p[1] == 0xd7));
    }

    /// A receiver that stops answering must not make `stop` (Ctrl-C) wait
    /// for the 30 s request timeout of the pending `/feedback`.
    #[test]
    fn stop_is_bounded_when_the_receiver_hangs() {
        let fake = FakeMirror::start(Behaviour {
            hang_feedback: true,
            nack_after: None,
            ..Behaviour::default()
        });
        let mut sink = connect(&fake, &MirrorOptions::default());
        sink.start(&video_info(), Some(&audio_info())).unwrap();
        stream(&mut sink, 5);
        wait_for("feedback", || {
            fake.rec().requests.iter().any(|r| r == "POST /feedback")
        });
        let t = Instant::now();
        let _ = sink.stop();
        assert!(t.elapsed() < Duration::from_secs(6), "{:?}", t.elapsed());
    }

    #[test]
    fn eof_after_teardown_is_a_clean_stop() {
        let fake = FakeMirror::start(Behaviour {
            teardown_eof: true,
            nack_after: None,
            ..Behaviour::default()
        });
        let mut sink = connect(&fake, &MirrorOptions::default());
        sink.start(&video_info(), Some(&audio_info())).unwrap();
        stream(&mut sink, 5);
        sink.stop().unwrap();
        assert!(fake.rec().teardown);
    }

    /// An LG TV: 300 ms leads with audio, and `latencyMin` = `latencyMax`
    /// (§2.7); `--latency` and `--no-audio` as for any receiver.
    #[test]
    fn lg_audio_lead() {
        let audio_latency = |fake: &FakeMirror| -> Vec<(i128, i128)> {
            fake.rec()
                .setup_bodies
                .iter()
                .filter_map(|b| b.get("streams")?.as_array()?.first().cloned())
                .filter(|s| s.get("type").and_then(Plist::as_i128) == Some(96))
                .map(|s| {
                    let n = |k| s.get(k).and_then(Plist::as_i128).unwrap();
                    (n("latencyMin"), n("latencyMax"))
                })
                .collect()
        };
        let session = |manufacturer, opts: &MirrorOptions| {
            let fake = FakeMirror::start(Behaviour {
                manufacturer,
                nack_after: None,
                ..Behaviour::default()
            });
            let sink = connect(&fake, opts);
            let leads = sink.session.leads;
            let caps = sink.capabilities().preferred_latency_ms;
            drop(sink);
            (leads, caps, audio_latency(&fake))
        };
        let auto = MirrorOptions::default();
        let (leads, caps, lat) = session(Some("LG"), &auto);
        assert_eq!((leads, caps), (Leads::LG, Some(300)));
        assert_eq!(lat, [(13230, 13230)]);
        let given = MirrorOptions {
            latency_ms: Some(500),
            ..MirrorOptions::default()
        };
        let (leads, _, lat) = session(Some("LG"), &given);
        assert_eq!((leads.video_ms, lat), (500, vec![(22050, 22050)]));
        let quiet = MirrorOptions {
            audio: false,
            ..MirrorOptions::default()
        };
        assert_eq!(session(Some("LG"), &quiet).0, Leads::WIRELESS);
        // Anyone else: the automatic profile and latencyMin 0, unchanged.
        let (leads, caps, lat) = session(None, &auto);
        assert_eq!((leads, caps), (Leads::WIRELESS, Some(100)));
        assert_eq!(lat, [(0, 7497)]);
        assert_eq!(session(Some("Samsung"), &auto).2, [(0, 7497)]);
    }

    #[test]
    fn media_first_ordering() {
        let fake = FakeMirror::start(Behaviour {
            refuse_session_setup: Some(455),
            nack_after: None,
            ..Behaviour::default()
        });
        let opts = MirrorOptions::default();
        let mut sink = connect(&fake, &opts);
        sink.start(&video_info(), Some(&audio_info())).unwrap();
        stream(&mut sink, 5);
        sink.stop().unwrap();
        let r = fake.rec();
        let audio_uri = format!("rtsp://{}/{}", fake.addr, sink.session.audio_id);
        assert_eq!(
            r.requests[..6],
            [
                "GET /info".to_string(),
                format!("SETUP {audio_uri}"),
                format!("SETUP {audio_uri}"),
                "GET /info".into(),
                format!("SETUP rtsp://{}/{}", fake.addr, sink.session.video_id),
                format!("RECORD {audio_uri}"),
            ]
        );
        // The media-first SETUP carries the session and the stream.
        let mf = &r.setup_bodies[1];
        assert!(mf.get("sessionUUID").is_some() && mf.get("streams").is_some());
        assert!(mf.get("updateSessionRequest").is_none());
        assert!(r.video.iter().any(|p| p.kind == 0));
    }

    #[test]
    fn ntp_session() {
        let fake = FakeMirror::start(Behaviour {
            nack_after: None,
            ..Behaviour::default()
        });
        let opts = MirrorOptions {
            ptp: false,
            ..MirrorOptions::default()
        };
        let mut sink = connect(&fake, &opts);
        assert!(matches!(sink.session.timeline, Timeline::Ntp));
        sink.start(&video_info(), Some(&audio_info())).unwrap();
        stream(&mut sink, 5);
        wait_for("sync", || !fake.rec().sync.is_empty());
        sink.stop().unwrap();
        let r = fake.rec();
        assert_eq!(
            r.setup_bodies[0]
                .get("timingProtocol")
                .and_then(Plist::as_str),
            Some("NTP")
        );
        assert!(r.setup_bodies[0].get("timingPort").is_some());
        assert_eq!(&r.sync[0][..2], &[0x90, 0xd4]);
        assert_eq!(r.sync[0].len(), 20);
        let f = r.video.iter().find(|p| p.kind == 0).unwrap();
        assert_eq!(f.timeline, 0);
    }
}
