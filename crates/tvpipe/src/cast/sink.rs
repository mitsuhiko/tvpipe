//! `StreamingSink`: the Cast Streaming [`Sink`] (ARCHITECTURE.md, "Cast").
//!
//! [`connect`] opens the control channel, launches the mirroring receiver
//! app, connects to its transport, and runs OFFER/ANSWER; the sink then
//! knows the receiver's [`Capabilities`]. [`Sink::start`] opens the UDP
//! media socket and starts two threads:
//!
//! - `cast-send`: paces RTP out in bursts (every [`BURST_INTERVAL`], audio
//!   before video), sends Sender Reports, retransmissions and kickstarts.
//! - `cast-rtcp`: reads the receiver's RTCP and updates the streams.
//!
//! A third thread (`cast-control`) watches the control channel for the
//! receiver ending the session. [`Sink::push`] only converts, encrypts and
//! queues; it never waits for the network.
//!
//! Timing: every frame's reference time is derived from its pts on the
//! session's [`media::clock`](crate::media::clock) (handed over by the
//! fanout with [`Sink::set_clock`], shared with the other receivers;
//! ARCHITECTURE.md), so audio and video stay in sync, and the receiver plays
//! each frame at reference time + target delay. Without a session clock
//! the first frame pushed anchors a private one, moved forward when frames
//! arrive more than [`MAX_LATENESS`] late (a stalled encoder).
//!
//! AAC-LC goes out ADTS-framed by default ([`AacFraming::Adts`]), one
//! access unit per Cast frame, as Chromium's Cast sender does
//! (`media/cast/encoding/audio_encoder.cc`, `AppleAacImpl`); openscreen's
//! receiver has no AudioSpecificConfig and cannot decode raw access units
//! (docs/measurements.md). Raw units (from ffmpeg's Matroska,
//! passthrough, `aacenc`) get the header here. [`AacFraming::Raw`] sends
//! raw units instead (stripping headers), for receivers that want those.
//!
//! Sources: openscreen `cast/standalone_sender/looping_file_cast_agent.cc`
//! (launch/connect/negotiate flow), `cast/streaming/sender_packet_router.cc`
//! (burst pacing, RTCP priority), `cast/streaming/impl/sender_impl.cc`;
//! ARCHITECTURE.md, "Timing and Latency", "Cast".

use std::net::{IpAddr, SocketAddr, UdpSocket};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use super::annexb::{avcc_to_annexb, AvcConfig};
use super::channel::{Channel, ChannelSender};
use super::messages::{self, ReceiverMessage};
use super::retransmit::{StreamConfig, StreamSender};
use super::rtcp;
use super::rtp::{MAX_PACKET_SIZE_IPV4, MAX_PACKET_SIZE_IPV6};
use super::streaming::{
    AudioOptions, Codec, Negotiated, Offer, OfferOptions, SelectedStream, VideoOptions,
};
use crate::codec::protobuf::CastMessage;
use crate::crypto::ring::random_array;
use crate::error::{Error, ErrorKind, Result};
use crate::media::clock::{SessionClock, SinkClock, Tolerance};
use crate::types::{
    AudioCodec, AudioFamily, AudioInfo, Backlog, Capabilities, EncodedFrame, Sink, SinkStatus,
    TrackKind, VideoCodec, VideoInfo, VIDEO_CLOCK_RATE,
};
use crate::util::time::{rescale, NtpTime};

pub use super::options::{AacFraming, CastOptions};

/// Pacing granularity.
pub const BURST_INTERVAL: Duration = Duration::from_millis(10);
/// Default burst rate (openscreen's `kDefaultMaxBurstBitrate`, 24 Mibit/s).
pub const DEFAULT_BURST_BITRATE: u32 = 24 << 20;
/// Frames later than this re-anchor the media clock.
pub const MAX_LATENESS: Duration = Duration::from_millis(100);
const LAUNCH_TIMEOUT: Duration = Duration::from_secs(20);
const ANSWER_TIMEOUT: Duration = Duration::from_secs(10);
const STATS_INTERVAL: Duration = Duration::from_secs(5);
impl CastOptions {
    fn offer_options(&self) -> OfferOptions {
        let mut resolutions = vec![(self.max_width, self.max_height)];
        for r in [(1920, 1080), (1280, 720)] {
            if r.0 < self.max_width && r.1 < self.max_height {
                resolutions.push(r);
            }
        }
        let audio = |codec| AudioOptions {
            codec,
            sample_rate: self.audio_sample_rate,
            channels: self.audio_channels,
            bit_rate: 128_000,
        };
        OfferOptions {
            latency_ms: self.latency_ms,
            video: Some(VideoOptions {
                codec: VideoCodec::H264,
                max_bitrate: self.max_bitrate_kbps.saturating_mul(1000),
                max_frame_rate: self.max_fps,
                resolutions,
            }),
            audio: if self.audio {
                self.audio_codecs
                    .iter()
                    .filter(|c| matches!(c, AudioCodec::Opus | AudioCodec::AacLc))
                    .map(|&c| audio(c))
                    .collect()
            } else {
                Vec::new()
            },
            android_rtp_hack: self.android_rtp_hack,
        }
    }
}

/// The control session (virtual connection to the mirroring app).
struct Control {
    local_id: String,
    transport_id: String,
    session_id: String,
}

/// Connects to the Cast receiver at `addr` (control port, usually 8009) and
/// negotiates a mirroring session.
pub fn connect(addr: SocketAddr, name: &str, opts: &CastOptions) -> Result<StreamingSink> {
    info!("cast: connecting to {name} at {addr}");
    let channel = Channel::connect(addr, opts.connect_timeout)?;
    channel.send(&messages::connect(
        messages::PLATFORM_SENDER_ID,
        messages::PLATFORM_RECEIVER_ID,
    ))?;
    let app = launch(&channel)?;
    let suffix = u32::from_be_bytes(random_array()?) % 1_000_000;
    let control = Control {
        local_id: format!("tvpipe-{suffix}"),
        transport_id: app.transport_id.clone().unwrap_or_default(),
        session_id: app.session_id.clone().unwrap_or_default(),
    };
    channel.send(&messages::connect(&control.local_id, &control.transport_id))?;

    let offer = Offer::new(&opts.offer_options())?;
    let seq = 1;
    debug!("cast: OFFER {:?}", offer.streams);
    channel.send(&CastMessage::json(
        control.local_id.clone(),
        control.transport_id.clone(),
        messages::NS_WEBRTC,
        &offer.message(seq),
    ))?;
    let answer = wait_for(&channel, ANSWER_TIMEOUT, "ANSWER", |msg| {
        if msg.namespace != messages::NS_WEBRTC {
            return Ok(None);
        }
        super::streaming::Answer::from_message(&msg.payload_json()?, seq)
    });
    let answer = match answer {
        Ok(a) => a,
        Err(e) => {
            let _ = channel.send(&messages::stop(3, &control.session_id));
            return Err(e);
        }
    };
    let negotiated = Negotiated::new(&offer, answer)?;
    let caps = negotiated.capabilities();
    info!(
        "cast: {name}: udp port {}, video {:?}, audio {:?}, max {}x{}@{}",
        negotiated.udp_port,
        negotiated.video.as_ref().map(|s| s.offer.codec),
        negotiated.audio.as_ref().map(|s| s.offer.codec),
        caps.max_width,
        caps.max_height,
        caps.max_fps
    );
    StreamingSink::new(name, addr.ip(), channel, control, negotiated, caps, opts)
}

/// Connects to a discovered device's Cast endpoint.
pub fn connect_device(
    dev: &crate::net::device::Device,
    opts: &CastOptions,
) -> Result<StreamingSink> {
    let cast = dev
        .cast
        .as_ref()
        .ok_or_else(|| Error::unsupported(format!("{} has no Cast endpoint", dev.name)))?;
    let addr = SocketAddr::new(cast.endpoint.addr(), cast.endpoint.port);
    connect(addr, &dev.name, opts)
}

fn launch(channel: &Channel) -> Result<messages::AppInfo> {
    let request_id = 1;
    channel.send(&messages::launch(request_id, messages::MIRRORING_APP_ID))?;
    wait_for(channel, LAUNCH_TIMEOUT, "the mirroring app", |msg| {
        if msg.namespace != messages::NS_RECEIVER {
            return Ok(None);
        }
        let m = ReceiverMessage::parse(&msg.payload_json()?)?;
        match &m {
            ReceiverMessage::LaunchError { reason, .. } => Err(Error::protocol(format!(
                "cast: receiver could not launch the mirroring app: {reason}"
            ))),
            ReceiverMessage::InvalidRequest {
                request_id: Some(id),
                reason,
            } if *id == request_id => Err(Error::protocol(format!(
                "cast: receiver rejected LAUNCH: {reason}"
            ))),
            _ => Ok(m
                .find_app(messages::MIRRORING_APP_ID)
                .filter(|a| a.transport_id.is_some() && a.session_id.is_some())
                .cloned()),
        }
    })
}

/// Reads messages until `pick` returns a value (or an error).
fn wait_for<T>(
    channel: &Channel,
    timeout: Duration,
    what: &str,
    mut pick: impl FnMut(&CastMessage) -> Result<Option<T>>,
) -> Result<T> {
    let deadline = Instant::now() + timeout;
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return Err(Error::timeout(format!("cast: no reply waiting for {what}")));
        }
        let Some(msg) = channel.recv_timeout(left.min(Duration::from_millis(250)))? else {
            continue;
        };
        match pick(&msg) {
            Ok(Some(v)) => return Ok(v),
            Ok(None) => trace!("cast: ignoring {} message", msg.namespace),
            Err(e) if e.kind() == ErrorKind::Malformed => {
                debug!("cast: bad message on {}: {e}", msg.namespace)
            }
            Err(e) => return Err(e),
        }
    }
}

/// The private clock's rule (a sink used without a fanout): early frames
/// keep their pts-derived (future) reference times (ffmpeg delivers in
/// bursts); frames more than [`MAX_LATENESS`] late (a stalled encoder) or
/// far in the future (a jump in the input) re-anchor it to now.
const PRIVATE_CLOCK: Tolerance = Tolerance {
    late: MAX_LATENESS,
    early: Duration::from_secs(2),
};

/// Maps media pts to reference instants (shared by audio and video): on
/// the session's clock (ARCHITECTURE.md) when the fanout handed one over,
/// else on a private one anchored on the first frame ([`PRIVATE_CLOCK`]).
fn reference_time(clock: &SinkClock, pts: u64, rate: u32, now: Instant) -> Instant {
    clock.instant(pts, rate, now)
}

/// Instant → NTP mapping fixed at session start.
#[derive(Debug, Clone, Copy)]
struct NtpClock {
    instant: Instant,
    ntp: NtpTime,
}

impl NtpClock {
    fn now() -> NtpClock {
        NtpClock {
            instant: Instant::now(),
            ntp: NtpTime::now(),
        }
    }

    fn at(&self, t: Instant) -> NtpTime {
        let to_ntp = |d: Duration| ((d.as_nanos() << 32) / 1_000_000_000) as u64;
        if t >= self.instant {
            NtpTime(self.ntp.0.wrapping_add(to_ntp(t - self.instant)))
        } else {
            NtpTime(self.ntp.0.wrapping_sub(to_ntp(self.instant - t)))
        }
    }
}

struct Track {
    sender: StreamSender,
    /// Input pts rate (90 kHz video, AudioInfo::sample_rate audio).
    input_rate: u32,
    /// Added to the rescaled pts (always 0; see `make_track`).
    rtp_offset: i64,
    last_rtp: Option<i64>,
}

impl Track {
    fn rtp_timestamp(&mut self, pts: u64) -> i64 {
        let rate = self.sender.config().rtp_timebase;
        let mut ts = rescale(pts, self.input_rate, rate) as i64 + self.rtp_offset;
        if let Some(last) = self.last_rtp {
            if ts <= last {
                ts = last + 1;
            }
        }
        self.last_rtp = Some(ts);
        ts
    }
}

struct MediaState {
    audio: Option<Track>,
    video: Option<Track>,
    clock: SinkClock,
    /// Dropping video until the next key frame (start, or our own drop).
    video_needs_key: bool,
    /// Something changed; the sender thread should look again.
    dirty: bool,
    stopped: bool,
    /// When the first RTP packet went out since the receiver's last RTCP
    /// (`None`: nothing unanswered).
    unanswered_since: Option<Instant>,
}

impl MediaState {
    fn tracks(&mut self) -> impl Iterator<Item = &mut Track> {
        self.audio.iter_mut().chain(self.video.iter_mut())
    }
}

struct Media {
    state: Arc<(Mutex<MediaState>, Condvar)>,
    threads: Vec<JoinHandle<()>>,
    avc: AvcConfig,
    scratch: Vec<u8>,
    /// AAC: how to frame units; the ADTS header fields for raw units.
    aac: Option<(AacFraming, Adts)>,
}

/// The fixed part of an ADTS header (ISO/IEC 13818-7 §6.2): profile
/// (object type - 1), sampling frequency index, channel configuration.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Adts {
    profile: u8,
    freq_index: u8,
    channels: u8,
}

impl Adts {
    /// From the AudioSpecificConfig, else from the track's rate/channels.
    fn new(info: &AudioInfo) -> Result<Adts> {
        const RATES: [u32; 13] = [
            96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350,
        ];
        let (aot, rate, channels) = match crate::media::formats::parse_asc(&info.config) {
            Ok((aot, rate, ch, _)) => (aot, rate, ch),
            Err(_) if info.config.is_empty() => (2, info.sample_rate, info.channels),
            Err(e) => return Err(e),
        };
        let freq_index = RATES.iter().position(|&r| r == rate).ok_or_else(|| {
            Error::unsupported(format!("cast: AAC at {rate} Hz has no ADTS index"))
        })? as u8;
        if !(1..=4).contains(&aot) || channels > 7 {
            return Err(Error::unsupported(format!(
                "cast: AAC object type {aot} with {channels} channels cannot be ADTS-framed"
            )));
        }
        Ok(Adts {
            profile: (aot - 1) as u8,
            freq_index,
            channels,
        })
    }

    /// Whether `data` already starts with an ADTS header.
    fn framed(data: &[u8]) -> bool {
        data.len() >= 7 && data[0] == 0xff && data[1] & 0xf6 == 0xf0
    }

    /// The raw access unit inside an ADTS frame (header of 7 bytes, 9 with
    /// CRC); `data` itself when it is not ADTS-framed.
    fn strip(data: &[u8]) -> &[u8] {
        if !Self::framed(data) {
            return data;
        }
        let header = if data[1] & 1 == 1 { 7 } else { 9 };
        data.get(header..).unwrap_or_default()
    }

    /// `au` with a 7-byte header (MPEG-4, no CRC, buffer fullness 0x7FF).
    fn wrap(&self, au: &[u8], out: &mut Vec<u8>) -> Result<()> {
        let len = au.len() + 7;
        if len >= 1 << 13 {
            return Err(Error::unsupported(
                "cast: AAC access unit too large for ADTS",
            ));
        }
        out.clear();
        out.extend_from_slice(&[
            0xff,
            0xf1,
            (self.profile << 6) | (self.freq_index << 2) | (self.channels >> 2),
            ((self.channels & 3) << 6) | (len >> 11) as u8,
            (len >> 3) as u8,
            (((len & 7) as u8) << 5) | 0x1f,
            0xfc,
        ]);
        out.extend_from_slice(au);
        Ok(())
    }
}

fn lock(state: &Mutex<MediaState>) -> MutexGuard<'_, MediaState> {
    state.lock().unwrap_or_else(|p| p.into_inner())
}

/// Why the connection to the receiver is gone, when the receiver did not
/// end the session itself (that is [`StreamingSink::finished`]): the
/// control channel broke, UDP is unreachable, or feedback stopped.
/// `push` reports it as an error, so the session may reconnect.
#[derive(Default)]
struct Lost(Mutex<Option<Error>>);

impl Lost {
    fn set(&self, e: Error) {
        let mut l = self.0.lock().unwrap_or_else(|p| p.into_inner());
        if l.is_none() {
            debug!("cast: connection lost: {e}");
            *l = Some(e);
        }
    }

    fn take(&self) -> Option<Error> {
        self.0.lock().unwrap_or_else(|p| p.into_inner()).take()
    }
}

/// The Cast Streaming sink.
pub struct StreamingSink {
    name: String,
    receiver_ip: IpAddr,
    caps: Capabilities,
    negotiated: Negotiated,
    burst_bitrate: u32,
    media_relay: Option<SocketAddr>,
    aac_framing: AacFraming,
    control_tx: ChannelSender,
    control: Option<Control>,
    control_thread: Option<JoinHandle<()>>,
    control_stop: Arc<AtomicBool>,
    /// The receiver ended the session (CLOSE, the app stopped).
    finished: Arc<AtomicBool>,
    lost: Arc<Lost>,
    /// `lost` was reported; later pushes fail as well.
    gone: bool,
    feedback_timeout: Duration,
    media: Option<Media>,
    /// The session's media clock (from the fanout), if any.
    clock: Option<SessionClock>,
    stopped: bool,
}

impl StreamingSink {
    fn new(
        name: &str,
        receiver_ip: IpAddr,
        channel: Channel,
        control: Control,
        negotiated: Negotiated,
        caps: Capabilities,
        opts: &CastOptions,
    ) -> Result<StreamingSink> {
        let finished = Arc::new(AtomicBool::new(false));
        let lost = Arc::new(Lost::default());
        let control_stop = Arc::new(AtomicBool::new(false));
        let control_tx = channel.sender();
        let thread = {
            let finished = finished.clone();
            let lost = lost.clone();
            let stop = control_stop.clone();
            let transport = control.transport_id.clone();
            std::thread::Builder::new()
                .name("cast-control".into())
                .spawn(move || control_loop(channel, &transport, &stop, &finished, &lost))
                .map_err(|e| Error::io("cast: spawn control thread", e))?
        };
        let video_bps = negotiated.video.as_ref().map_or(0, |v| v.offer.bit_rate);
        Ok(StreamingSink {
            name: name.to_owned(),
            receiver_ip,
            caps,
            negotiated,
            burst_bitrate: opts
                .burst_bitrate
                .unwrap_or_else(|| DEFAULT_BURST_BITRATE.max(video_bps.saturating_mul(3))),
            media_relay: opts.media_relay,
            aac_framing: opts.aac_framing,
            control_tx,
            control: Some(control),
            control_thread: Some(thread),
            control_stop,
            finished,
            lost,
            gone: false,
            feedback_timeout: opts.feedback_timeout,
            media: None,
            clock: None,
            stopped: false,
        })
    }

    pub fn negotiated(&self) -> &Negotiated {
        &self.negotiated
    }

    /// Per-stream counters (audio, video), for logs and tests.
    pub fn stats(
        &self,
    ) -> (
        Option<super::retransmit::Stats>,
        Option<super::retransmit::Stats>,
    ) {
        match &self.media {
            Some(m) => {
                let st = lock(&m.state.0);
                (
                    st.audio.as_ref().map(|t| t.sender.stats()),
                    st.video.as_ref().map(|t| t.sender.stats()),
                )
            }
            None => (None, None),
        }
    }

    fn make_track(
        &self,
        sel: &SelectedStream,
        input_rate: u32,
        packet_size: usize,
    ) -> Result<Track> {
        let o = &sel.offer;
        Ok(Track {
            sender: StreamSender::new(StreamConfig {
                ssrc: o.ssrc,
                receiver_ssrc: sel.receiver_ssrc,
                payload_type: o.payload_type,
                rtp_timebase: o.rtp_timebase,
                target_delay: Duration::from_millis(o.target_delay_ms as u64),
                aes_key: o.aes_key,
                aes_iv_mask: o.aes_iv_mask,
                max_packet_size: packet_size,
                first_sequence: u16::from_be_bytes(random_array()?),
            })?,
            input_rate,
            // RTP timestamps are the media time (pts in the stream's
            // timebase), like openscreen's and Chromium's senders, not
            // randomly offset as RFC 3550 suggests: a Google TV receiver
            // (Sony XR, 2026-11-18) stops pulling audio after ~200 ms (and
            // video freezes later) in most sessions with random offsets.
            rtp_offset: 0,
            last_rtp: None,
        })
    }
}

impl Sink for StreamingSink {
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
            return Err(Error::protocol("cast: sink already started"));
        }
        let vsel = self.negotiated.video.clone();
        if let Some(v) = &vsel {
            if Codec::from_video(video.codec) != v.offer.codec {
                return Err(Error::unsupported(format!(
                    "cast: negotiated {:?} but the encode is {:?}",
                    v.offer.codec, video.codec
                )));
            }
        }
        let avc = AvcConfig::parse(&video.avcc)?;
        let mut aac = None;
        let asel = match (self.negotiated.audio.clone(), audio) {
            (Some(sel), Some(info)) => {
                if Codec::from_audio(info.codec) != Some(sel.offer.codec) {
                    return Err(Error::unsupported(format!(
                        "cast: negotiated {:?} audio but the encode is {:?}",
                        sel.offer.codec, info.codec
                    )));
                }
                if sel.offer.codec == Codec::Aac {
                    aac = Some((self.aac_framing, Adts::new(info)?));
                }
                Some((sel, info.sample_rate.max(1)))
            }
            (Some(_), None) => {
                debug!("cast: no audio track; sending video only");
                None
            }
            (None, _) => None,
        };
        let peer = self
            .media_relay
            .unwrap_or(SocketAddr::new(self.receiver_ip, self.negotiated.udp_port));
        let bind = if peer.is_ipv4() {
            SocketAddr::from((std::net::Ipv4Addr::UNSPECIFIED, 0))
        } else {
            SocketAddr::from((std::net::Ipv6Addr::UNSPECIFIED, 0))
        };
        let sock = UdpSocket::bind(bind).map_err(|e| Error::io("cast: bind UDP", e))?;
        sock.connect(peer)
            .map_err(|e| Error::io(format!("cast: UDP connect to {peer}"), e))?;
        sock.set_read_timeout(Some(Duration::from_millis(100)))
            .map_err(|e| Error::io("cast: UDP options", e))?;
        let packet_size = if peer.is_ipv4() {
            MAX_PACKET_SIZE_IPV4
        } else {
            MAX_PACKET_SIZE_IPV6
        };
        let state = MediaState {
            audio: asel
                .map(|(sel, rate)| self.make_track(&sel, rate, packet_size))
                .transpose()?,
            video: vsel
                .map(|sel| self.make_track(&sel, VIDEO_CLOCK_RATE, packet_size))
                .transpose()?,
            clock: self
                .clock
                .clone()
                .map_or_else(|| SinkClock::private(PRIVATE_CLOCK), SinkClock::shared),
            video_needs_key: true,
            dirty: false,
            stopped: false,
            unanswered_since: None,
        };
        let state = Arc::new((Mutex::new(state), Condvar::new()));
        let burst = ((self.burst_bitrate as u64 / 8 / packet_size as u64)
            * BURST_INTERVAL.as_millis() as u64
            / 1000)
            .max(1) as usize;
        let send_sock = sock
            .try_clone()
            .map_err(|e| Error::io("cast: clone UDP socket", e))?;
        let ntp = NtpClock::now();
        let mut threads = Vec::new();
        {
            let state = state.clone();
            let lost = self.lost.clone();
            let timeout = self.feedback_timeout;
            threads.push(
                std::thread::Builder::new()
                    .name("cast-send".into())
                    .spawn(move || send_loop(&state, &send_sock, burst, ntp, &lost, timeout))
                    .map_err(|e| Error::io("cast: spawn sender", e))?,
            );
        }
        {
            let state = state.clone();
            threads.push(
                std::thread::Builder::new()
                    .name("cast-rtcp".into())
                    .spawn(move || rtcp_loop(&state, &sock))
                    .map_err(|e| Error::io("cast: spawn RTCP reader", e))?,
            );
        }
        debug!(
            "cast: {}: streaming to {peer} ({burst} packets per {:?} burst)",
            self.name, BURST_INTERVAL
        );
        self.media = Some(Media {
            state,
            threads,
            avc,
            scratch: Vec::new(),
            aac,
        });
        Ok(())
    }

    fn push(&mut self, frame: &EncodedFrame) -> Result<SinkStatus> {
        if self.finished.load(Ordering::Acquire) {
            return Ok(SinkStatus::Finished);
        }
        if let Some(e) = self.lost.take() {
            self.gone = true;
            return Err(e);
        }
        if self.gone {
            return Err(Error::closed("cast: connection lost"));
        }
        let Some(media) = self.media.as_mut() else {
            return Err(Error::protocol("cast: push before start"));
        };
        let now = Instant::now();
        let (lock_ref, cv) = &*media.state;
        match frame.track {
            TrackKind::Video => {
                let st = lock(lock_ref);
                if st.video.is_none() {
                    return Ok(SinkStatus::Dropped);
                }
                if st.video_needs_key && !frame.keyframe {
                    return Ok(SinkStatus::Dropped);
                }
                drop(st);
                avcc_to_annexb(&frame.data, &media.avc, frame.keyframe, &mut media.scratch)?;
                let mut st = lock(lock_ref);
                let reference = reference_time(&st.clock, frame.pts, VIDEO_CLOCK_RATE, now);
                let Some(track) = st.video.as_mut() else {
                    return Ok(SinkStatus::Dropped);
                };
                let rtp = track.rtp_timestamp(frame.pts);
                match track
                    .sender
                    .enqueue(&media.scratch, frame.keyframe, rtp, reference)
                {
                    Ok(_) => {
                        if frame.keyframe {
                            st.video_needs_key = false;
                        }
                    }
                    Err(e) => {
                        debug!("cast: dropping video frame: {e:?}");
                        st.video_needs_key = true;
                        return Ok(SinkStatus::Dropped);
                    }
                }
                st.dirty = true;
            }
            TrackKind::Audio(AudioFamily::Cast) => {
                let data = match &media.aac {
                    Some((AacFraming::Raw, _)) => Adts::strip(&frame.data),
                    Some((AacFraming::Adts, a)) if !Adts::framed(&frame.data) => {
                        a.wrap(&frame.data, &mut media.scratch)?;
                        &media.scratch[..]
                    }
                    _ => &frame.data[..],
                };
                let mut st = lock(lock_ref);
                let Some(rate) = st.audio.as_ref().map(|t| t.input_rate) else {
                    return Ok(SinkStatus::Dropped);
                };
                let reference = reference_time(&st.clock, frame.pts, rate, now);
                let Some(track) = st.audio.as_mut() else {
                    return Ok(SinkStatus::Dropped);
                };
                let rtp = track.rtp_timestamp(frame.pts);
                if let Err(e) = track.sender.enqueue(data, true, rtp, reference) {
                    trace!("cast: dropping audio frame: {e:?}");
                    return Ok(SinkStatus::Dropped);
                }
                st.dirty = true;
            }
            TrackKind::Audio(_) => return Ok(SinkStatus::Dropped),
        }
        cv.notify_one();
        Ok(SinkStatus::Accepted)
    }

    fn wants_keyframe(&self) -> bool {
        match &self.media {
            Some(m) => {
                let st = lock(&m.state.0);
                st.video_needs_key || st.video.as_ref().is_some_and(|t| t.sender.needs_keyframe())
            }
            None => true,
        }
    }

    /// The video media in flight (sent or waiting for the pacer, not
    /// acknowledged) against the window past which frames are dropped.
    fn backlog(&self) -> Option<Backlog> {
        let m = self.media.as_ref()?;
        let st = lock(&m.state.0);
        let s = &st.video.as_ref()?.sender;
        Some(Backlog {
            delay: s.backlog(),
            limit: s.max_in_flight(),
            dropped: s.stats().dropped,
        })
    }

    fn stop(&mut self) -> Result<()> {
        if self.stopped {
            return Ok(());
        }
        self.stopped = true;
        if let Some(media) = self.media.take() {
            {
                let mut st = lock(&media.state.0);
                st.stopped = true;
                let a = st.audio.as_ref().map(|t| t.sender.stats());
                let v = st.video.as_ref().map(|t| t.sender.stats());
                debug!("cast: final stats audio {a:?} video {v:?}");
            }
            media.state.1.notify_all();
            for t in media.threads {
                let _ = t.join();
            }
        }
        if let Some(c) = self.control.take() {
            if !self.control_tx.is_closed() {
                let _ = self.control_tx.send(&messages::stop(2, &c.session_id));
                let _ = self
                    .control_tx
                    .send(&messages::close(&c.local_id, &c.transport_id));
                let _ = self.control_tx.send(&messages::close(
                    messages::PLATFORM_SENDER_ID,
                    messages::PLATFORM_RECEIVER_ID,
                ));
            }
        }
        self.control_stop.store(true, Ordering::Release);
        if let Some(t) = self.control_thread.take() {
            let _ = t.join();
        }
        debug!("cast: {}: stopped", self.name);
        Ok(())
    }
}

impl Drop for StreamingSink {
    fn drop(&mut self) {
        let _ = self.stop();
    }
}

fn control_loop(
    mut channel: Channel,
    transport: &str,
    stop: &AtomicBool,
    finished: &AtomicBool,
    lost: &Lost,
) {
    // Grace period after STOP so the receiver sees our messages before the
    // socket closes.
    let mut stop_seen: Option<Instant> = None;
    loop {
        if stop.load(Ordering::Acquire) {
            let at = *stop_seen.get_or_insert_with(Instant::now);
            if at.elapsed() > Duration::from_millis(200) {
                break;
            }
        }
        match channel.recv_timeout(Duration::from_millis(50)) {
            Ok(None) => {}
            Ok(Some(msg)) => {
                if messages::is_close(&msg) && msg.source_id == transport {
                    info!("cast: receiver closed the mirroring session");
                    finished.store(true, Ordering::Release);
                } else if msg.namespace == messages::NS_RECEIVER {
                    if let Ok(m) = msg.payload_json().and_then(|v| ReceiverMessage::parse(&v)) {
                        if matches!(m, ReceiverMessage::Status { .. })
                            && m.find_app(messages::MIRRORING_APP_ID).is_none()
                        {
                            info!("cast: the mirroring app is no longer running");
                            finished.store(true, Ordering::Release);
                        }
                    }
                } else {
                    debug!(
                        "cast: {} message: {}",
                        msg.namespace,
                        msg.payload_str().unwrap_or("<binary>")
                    );
                }
            }
            Err(e) => {
                // Without a CLOSE first, the receiver did not end the
                // session: the connection is lost (the TV went off the
                // network or changed its address).
                if !stop.load(Ordering::Acquire) && !finished.load(Ordering::Acquire) {
                    debug!("cast: control channel ended: {e}");
                    lost.set(Error::closed(format!("cast: control channel ended: {e}")));
                }
                break;
            }
        }
    }
    channel.close();
}

fn send_loop(
    state: &(Mutex<MediaState>, Condvar),
    sock: &UdpSocket,
    burst: usize,
    ntp: NtpClock,
    lost: &Lost,
    feedback_timeout: Duration,
) {
    let (m, cv) = state;
    let mut batch: Vec<Vec<u8>> = Vec::new();
    let mut buf = Vec::new();
    let mut last_burst = Instant::now() - BURST_INTERVAL;
    let mut last_stats = Instant::now();
    let mut send_errors = 0u32;
    let mut st = lock(m);
    loop {
        if st.stopped {
            return;
        }
        let now = Instant::now();
        st.dirty = false;
        batch.clear();
        let mut more = false;
        if let Some(t) = st.unanswered_since {
            if now.duration_since(t) >= feedback_timeout {
                lost.set(Error::timeout(format!(
                    "cast: no feedback from the receiver for {} s",
                    feedback_timeout.as_secs_f64()
                )));
                st.unanswered_since = None;
            }
        }
        if now >= last_burst + BURST_INTERVAL {
            for t in st.tracks() {
                if let Some(sr) = t.sender.sender_report(now, |i| ntp.at(i)) {
                    batch.push(sr);
                }
            }
            let reports = batch.len();
            let mut budget = burst.saturating_sub(batch.len()).max(1);
            for t in st.tracks() {
                while budget > 0 && t.sender.next_packet(now, &mut buf) {
                    batch.push(std::mem::take(&mut buf));
                    budget -= 1;
                }
                more |= t.sender.has_pending();
            }
            if batch.len() > reports && st.unanswered_since.is_none() {
                st.unanswered_since = Some(now);
            }
            if !batch.is_empty() {
                last_burst = now;
            }
        } else {
            more = true;
        }
        if now.duration_since(last_stats) >= STATS_INTERVAL {
            last_stats = now;
            for (kind, t) in [("audio", &st.audio), ("video", &st.video)] {
                if let Some(t) = t {
                    let s = t.sender.stats();
                    debug!(
                        "cast {kind}: frames {} packets {} resent {} kick {} nacks {} plis {} dropped {} rtt {:?} in flight {}",
                        s.frames, s.packets, s.retransmissions, s.kickstarts, s.nacks, s.plis,
                        s.dropped, t.sender.rtt(), t.sender.in_flight()
                    );
                }
            }
        }
        let mut wake = st
            .audio
            .iter()
            .chain(st.video.iter())
            .filter_map(|t| t.sender.next_wakeup(now))
            .min();
        if more {
            let next_burst = last_burst + BURST_INTERVAL;
            wake = Some(wake.map_or(next_burst, |w| w.max(next_burst)));
        }
        if !batch.is_empty() {
            drop(st);
            for p in &batch {
                match sock.send(p) {
                    Ok(_) => send_errors = 0,
                    Err(e) => {
                        send_errors += 1;
                        if send_errors == 1 || send_errors % 1000 == 0 {
                            debug!("cast: UDP send failed ({send_errors}x): {e}");
                        }
                        if send_errors > 5000 {
                            lost.set(Error::io("cast: receiver unreachable over UDP", e));
                        }
                    }
                }
            }
            st = lock(m);
            continue;
        }
        if st.dirty {
            continue;
        }
        // Never spin: nothing was sent this round, so wait at least a bit.
        let timeout = wake
            .map(|w| w.saturating_duration_since(Instant::now()))
            .unwrap_or(Duration::from_millis(100))
            .clamp(Duration::from_millis(1), Duration::from_millis(100));
        st = cv
            .wait_timeout(st, timeout)
            .map(|(g, _)| g)
            .unwrap_or_else(|p| p.into_inner().0);
    }
}

fn rtcp_loop(state: &(Mutex<MediaState>, Condvar), sock: &UdpSocket) {
    let (m, cv) = state;
    let mut buf = vec![0u8; 2048];
    loop {
        if lock(m).stopped {
            return;
        }
        let n = match sock.recv(&mut buf) {
            Ok(n) => n,
            Err(e)
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::WouldBlock
                        | std::io::ErrorKind::TimedOut
                        | std::io::ErrorKind::Interrupted
                        | std::io::ErrorKind::ConnectionRefused
                        | std::io::ErrorKind::ConnectionReset
                ) =>
            {
                continue
            }
            Err(e) => {
                debug!("cast: UDP receive failed: {e}");
                std::thread::sleep(Duration::from_millis(50));
                continue;
            }
        };
        let pkt = &buf[..n];
        if !rtcp::is_rtcp(pkt) {
            trace!("cast: ignoring non-RTCP packet of {n} bytes");
            continue;
        }
        let Some(author) = rtcp::author_ssrc(pkt) else {
            continue;
        };
        let arrival = Instant::now();
        let mut st = lock(m);
        if st
            .tracks()
            .any(|t| t.sender.config().receiver_ssrc == author)
        {
            // The receiver is there.
            st.unanswered_since = None;
        }
        let Some(track) = st
            .tracks()
            .find(|t| t.sender.config().receiver_ssrc == author)
        else {
            trace!("cast: RTCP from unknown ssrc {author}");
            continue;
        };
        match track.sender.on_rtcp(pkt, arrival) {
            Ok(out) => {
                if out.picture_lost {
                    debug!("cast: receiver reported picture loss");
                }
                if out.resend || out.acked {
                    st.dirty = true;
                    cv.notify_one();
                }
            }
            Err(e) => debug!("cast: bad RTCP: {e}"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::util::ratio::Ratio;

    #[test]
    fn sink_is_send() {
        fn assert_send<T: Send>() {}
        assert_send::<StreamingSink>();
        assert_send::<Box<dyn Sink>>();
    }

    #[test]
    fn media_clock_anchors_and_reanchors() {
        let c = SinkClock::private(PRIVATE_CLOCK);
        let r = |secs: f64, now| reference_time(&c, (secs * 90_000.0) as u64, 90_000, now);
        let t0 = Instant::now();
        assert_eq!(r(10.0, t0), t0);
        // Audio on the same timeline.
        assert_eq!(
            reference_time(
                &c,
                48_000 * 10 + 24_000,
                48_000,
                t0 + Duration::from_millis(500)
            ),
            t0 + Duration::from_millis(500)
        );
        // On time.
        let t1 = t0 + Duration::from_secs(1);
        assert_eq!(r(11.0, t1), t1);
        // 50 ms late: tolerated.
        let t2 = t0 + Duration::from_millis(1550);
        assert_eq!(r(11.5, t2), t0 + Duration::from_millis(1500));
        // 300 ms late: re-anchored to now.
        let t3 = t0 + Duration::from_millis(2300);
        assert_eq!(r(12.0, t3), t3);
        // Early frames (a burst) keep their place on the timeline.
        assert_eq!(
            r(12.5, t3 + Duration::from_millis(100)),
            t3 + Duration::from_millis(500)
        );
        // A jump far ahead re-anchors too.
        assert_eq!(
            r(100.0, t3 + Duration::from_millis(200)),
            t3 + Duration::from_millis(200)
        );
    }

    #[test]
    fn ntp_clock_is_monotonic_offset() {
        let c = NtpClock {
            instant: Instant::now(),
            ntp: NtpTime(10 << 32),
        };
        assert_eq!(
            c.at(c.instant + Duration::from_millis(500)).0,
            (10 << 32) + (1 << 31)
        );
        assert_eq!(c.at(c.instant - Duration::from_secs(1)).0, 9 << 32);
    }

    #[test]
    fn offer_options_from_cast_options() {
        let o = CastOptions {
            max_width: 3840,
            max_height: 2160,
            audio: false,
            ..CastOptions::default()
        }
        .offer_options();
        assert!(o.audio.is_empty());
        assert_eq!(
            o.video.unwrap().resolutions,
            vec![(3840, 2160), (1920, 1080), (1280, 720)]
        );
        let o = CastOptions::default().offer_options();
        let codecs: Vec<AudioCodec> = o.audio.iter().map(|a| a.codec).collect();
        assert_eq!(codecs, [AudioCodec::Opus, AudioCodec::AacLc]);
        let o = CastOptions {
            audio_codecs: vec![AudioCodec::AacLc, AudioCodec::Alac],
            audio_sample_rate: 44_100,
            ..CastOptions::default()
        }
        .offer_options();
        assert_eq!(o.audio.len(), 1);
        assert_eq!(
            (o.audio[0].codec, o.audio[0].sample_rate),
            (AudioCodec::AacLc, 44_100)
        );
    }

    #[test]
    fn adts_headers() {
        let info = |config: Vec<u8>| AudioInfo {
            codec: AudioCodec::AacLc,
            sample_rate: 44_100,
            channels: 2,
            frame_samples: 1024,
            config,
        };
        // AAC-LC 48 kHz stereo (ASC 0x1190), 100-byte unit: frame length 107.
        let a = Adts::new(&info(vec![0x11, 0x90])).unwrap();
        let mut out = Vec::new();
        a.wrap(&[0xaa; 100], &mut out).unwrap();
        assert_eq!(&out[..7], [0xff, 0xf1, 0x4c, 0x80, 0x0d, 0x7f, 0xfc]);
        assert_eq!(out.len(), 107);
        assert!(Adts::framed(&out));
        assert!(!Adts::framed(&[0xaa; 100]));
        // No config: from the track (44.1 kHz: index 4).
        let b = Adts::new(&info(Vec::new())).unwrap();
        assert_eq!((b.profile, b.freq_index, b.channels), (1, 4, 2));
        // AAC-ELD cannot be ADTS-framed.
        assert!(Adts::new(&info(vec![0xf8, 0xe8, 0x50])).is_err());
        assert!(a.wrap(&vec![0; 9000], &mut out).is_err());
    }

    /// Sends one raw and one ADTS-framed AAC unit with `framing`; returns
    /// the two frames the receiver got.
    fn aac_session(framing: AacFraming) -> (Vec<u8>, Vec<u8>) {
        let rx = FakeReceiver::spawn(fake_receiver::Options::default());
        let o = CastOptions {
            audio_codecs: vec![AudioCodec::AacLc],
            aac_framing: framing,
            ..opts()
        };
        let mut sink = connect(rx.addr, "fake", &o).unwrap();
        let caps = sink.capabilities().clone();
        assert_eq!(caps.audio_formats[0].codec, AudioCodec::AacLc);
        let ai = AudioInfo {
            codec: AudioCodec::AacLc,
            sample_rate: 48_000,
            channels: 2,
            frame_samples: 1024,
            config: vec![0x11, 0x90],
        };
        sink.start(&video_info(), Some(&ai)).unwrap();
        assert_eq!(
            sink.push(&video_frame(0, 30)).unwrap(),
            SinkStatus::Accepted
        );
        let raw = EncodedFrame {
            track: TrackKind::Audio(AudioFamily::Cast),
            pts: 0,
            keyframe: true,
            data: StdArc::from(vec![0x21u8; 50]),
        };
        assert_eq!(sink.push(&raw).unwrap(), SinkStatus::Accepted);
        let mut framed = vec![0xff, 0xf1, 0x4c, 0x80, 0x07, 0x3f, 0xfc];
        framed.extend([0x22u8; 50]);
        let pre = EncodedFrame {
            pts: 1024,
            data: StdArc::from(framed),
            ..raw.clone()
        };
        assert_eq!(sink.push(&pre).unwrap(), SinkStatus::Accepted);
        wait_until("audio frames", || {
            let st = rx.state.lock().unwrap();
            st.streams
                .iter()
                .any(|s| s.codec == "aac" && s.frames.len() == 2)
        });
        sink.stop().unwrap();
        let state = rx.shutdown();
        let st = state.lock().unwrap();
        let s = st.streams.iter().find(|s| s.codec == "aac").unwrap();
        (s.frames[&0].data.clone(), s.frames[&1].data.clone())
    }

    /// Raw mode: raw units as is, ADTS headers stripped.
    #[test]
    fn aac_raw_when_asked() {
        let (a, b) = aac_session(AacFraming::Raw);
        assert_eq!(a, [0x21u8; 50]);
        assert_eq!(b, [0x22u8; 50]);
    }

    /// Default: raw units get an ADTS header, framed ones pass as is.
    #[test]
    fn aac_adts_by_default() {
        assert_eq!(CastOptions::default().aac_framing, AacFraming::Adts);
        let (a, b) = aac_session(AacFraming::Adts);
        assert_eq!(&a[..7], [0xff, 0xf1, 0x4c, 0x80, 0x07, 0x3f, 0xfc]);
        assert_eq!(&a[7..], [0x21u8; 50]);
        assert_eq!(&b[..7], [0xff, 0xf1, 0x4c, 0x80, 0x07, 0x3f, 0xfc]);
        assert_eq!(&b[7..], [0x22u8; 50]);
    }

    #[test]
    fn adts_strip() {
        let mut f = vec![0xff, 0xf1, 0x4c, 0x80, 0x07, 0x3f, 0xfc];
        f.extend([1, 2, 3]);
        assert_eq!(Adts::strip(&f), [1, 2, 3]);
        // With CRC (protection_absent = 0): 9-byte header.
        let mut c = vec![0xff, 0xf0, 0x4c, 0x80, 0x07, 0x3f, 0xfc, 0xab, 0xcd];
        c.extend([4, 5]);
        assert_eq!(Adts::strip(&c), [4, 5]);
        assert_eq!(Adts::strip(&[9, 9, 9]), [9, 9, 9]);
        assert!(Adts::strip(&[0xff, 0xf0, 0, 0, 0, 0, 0]).is_empty());
    }

    use crate::cast::fake_receiver::{self, FakeReceiver};
    use std::sync::Arc as StdArc;

    const AVCC: [u8; 19] = [
        1, 0x64, 0, 0x1f, 0xff, 0xe1, 0, 4, 0x67, 0x64, 0, 0x1f, 1, 0, 4, 0x68, 0xeb, 0xe3, 0xcb,
    ];

    fn video_info() -> VideoInfo {
        VideoInfo {
            codec: VideoCodec::H264,
            width: 1280,
            height: 720,
            fps: Ratio::new(30, 1),
            avcc: AVCC.to_vec(),
        }
    }

    fn audio_info() -> AudioInfo {
        AudioInfo {
            codec: AudioCodec::Opus,
            sample_rate: 48_000,
            channels: 2,
            frame_samples: 480,
            config: Vec::new(),
        }
    }

    fn video_frame(i: u64, gop: u64) -> EncodedFrame {
        let key = i % gop == 0;
        let len = if key {
            20_000
        } else {
            2_000 + (i as usize * 37) % 1500
        };
        let mut nal = vec![if key { 0x65 } else { 0x41 }];
        nal.extend((0..len).map(|j| (j as u64 ^ i) as u8));
        let mut data = (nal.len() as u32).to_be_bytes().to_vec();
        data.extend_from_slice(&nal);
        EncodedFrame {
            track: TrackKind::Video,
            pts: i * 3000,
            keyframe: key,
            data: StdArc::from(data),
        }
    }

    fn audio_frame(i: u64) -> EncodedFrame {
        EncodedFrame {
            track: TrackKind::Audio(AudioFamily::Cast),
            pts: i * 960,
            keyframe: true,
            data: StdArc::from(vec![i as u8; 120]),
        }
    }

    /// Streams `secs` of 30 fps video + 20 ms audio in real time.
    fn stream(
        sink: &mut StreamingSink,
        secs: u64,
        gop: u64,
    ) -> (Vec<EncodedFrame>, Vec<EncodedFrame>) {
        let start = Instant::now();
        let (mut sent_v, mut sent_a) = (Vec::new(), Vec::new());
        let mut a = 0;
        for i in 0..secs * 30 {
            let due = start + Duration::from_micros(i * 33_333);
            std::thread::sleep(due.saturating_duration_since(Instant::now()));
            let f = video_frame(i, gop);
            if sink.push(&f).unwrap() == SinkStatus::Accepted {
                sent_v.push(f);
            }
            while a * 20 <= (i + 1) * 33 {
                let f = audio_frame(a);
                if sink.push(&f).unwrap() == SinkStatus::Accepted {
                    sent_a.push(f);
                }
                a += 1;
            }
        }
        (sent_v, sent_a)
    }

    fn wait_until(what: &str, mut f: impl FnMut() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(5);
        while !f() {
            assert!(Instant::now() < deadline, "timed out waiting for {what}");
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    fn opts() -> CastOptions {
        CastOptions {
            latency_ms: 400,
            ..CastOptions::default()
        }
    }

    fn run_session(loss: f64) {
        let rx = FakeReceiver::spawn(fake_receiver::Options {
            loss,
            ..Default::default()
        });
        let mut sink = connect(rx.addr, "fake", &opts()).unwrap();
        let caps = sink.capabilities().clone();
        assert_eq!((caps.max_width, caps.max_height), (1280, 720));
        assert_eq!(caps.max_fps, Ratio::new(30, 1));
        assert_eq!(caps.audio_formats[0].codec, AudioCodec::Opus);
        assert!(sink.wants_keyframe());
        assert!(sink.push(&video_frame(0, 30)).is_err()); // before start
        sink.start(&video_info(), Some(&audio_info())).unwrap();
        assert!(sink.start(&video_info(), None).is_err());
        // Video before the first key frame is dropped.
        assert_eq!(sink.push(&video_frame(1, 30)).unwrap(), SinkStatus::Dropped);
        let (sent_v, sent_a) = stream(&mut sink, 2, 30);
        assert_eq!(sent_v.len(), 60, "video frames dropped");
        assert!(!sink.wants_keyframe());
        {
            let st = rx.state.lock().unwrap();
            assert_eq!(st.connects.len(), 2);
            assert_eq!(st.connects[1].1, fake_receiver::TRANSPORT_ID);
        }
        let last_a = sent_a.len() as i64 - 1;
        wait_until("all frames acknowledged", || {
            let st = rx.state.lock().unwrap();
            st.streams.iter().all(|s| {
                let want = if s.codec == "h264" { 59 } else { last_a };
                s.checkpoint == want
            })
        });
        let (a_stats, v_stats) = sink.stats();
        sink.stop().unwrap();
        sink.stop().unwrap();
        let state = rx.shutdown();
        let st = state.lock().unwrap();
        assert!(st.stopped, "STOP not received");
        let avc = AvcConfig::parse(&AVCC).unwrap();
        for s in &st.streams {
            assert!(
                !s.sender_reports.is_empty(),
                "{}: no sender reports",
                s.codec
            );

            if s.codec == "h264" {
                assert_eq!(s.frames.len(), 60);
                for (i, f) in sent_v.iter().enumerate() {
                    let got = &s.frames[&(i as i64)];
                    let mut want = Vec::new();
                    avcc_to_annexb(&f.data, &avc, f.keyframe, &mut want).unwrap();
                    assert_eq!(got.data, want, "video frame {i}");
                    assert_eq!(got.keyframe, f.keyframe);
                    assert_eq!(
                        got.referenced,
                        if f.keyframe { i as i64 } else { i as i64 - 1 }
                    );
                }
                // RTP timestamps are the pts (no random offset).
                for (i, f) in sent_v.iter().enumerate() {
                    assert_eq!(s.frames[&(i as i64)].rtp_timestamp as u64, f.pts);
                }
            } else {
                assert_eq!(s.codec, "opus");
                assert_eq!(s.frames.len(), sent_a.len());
                for (i, f) in sent_a.iter().enumerate() {
                    let got = &s.frames[&(i as i64)];
                    assert_eq!(got.data, &f.data[..], "audio frame {i}");
                    assert_eq!(got.rtp_timestamp as u64, f.pts);
                }
            }
            if loss > 0.0 {
                assert!(s.dropped > 0);
            }
        }
        if loss > 0.0 {
            let resent = a_stats.unwrap().retransmissions + v_stats.unwrap().retransmissions;
            assert!(resent > 0, "no retransmissions under loss");
        }
    }

    #[test]
    fn streams_to_fake_receiver() {
        run_session(0.0);
    }

    #[test]
    fn survives_packet_loss() {
        run_session(0.05);
    }

    #[test]
    fn picture_loss_requests_keyframe() {
        let rx = FakeReceiver::spawn(Default::default());
        let mut sink = connect(rx.addr, "fake", &opts()).unwrap();
        sink.start(&video_info(), None).unwrap();
        stream(&mut sink, 1, 1000);
        wait_until("checkpoint", || {
            let st = rx.state.lock().unwrap();
            st.streams
                .iter()
                .any(|s| s.codec == "h264" && s.checkpoint == 29)
        });
        assert!(!sink.wants_keyframe());
        rx.request_keyframe();
        wait_until("PLI", || sink.wants_keyframe());
        // Delta frames still flow ("limping along"), a key frame clears it.
        assert_eq!(
            sink.push(&video_frame(31, 1000)).unwrap(),
            SinkStatus::Accepted
        );
        assert!(sink.wants_keyframe());
        assert_eq!(
            sink.push(&video_frame(32, 1)).unwrap(),
            SinkStatus::Accepted
        );
        assert!(!sink.wants_keyframe());
        // Audio for another family is ignored.
        let mut f = audio_frame(0);
        f.track = TrackKind::Audio(AudioFamily::AirPlay);
        assert_eq!(sink.push(&f).unwrap(), SinkStatus::Dropped);
        sink.stop().unwrap();
        rx.shutdown();
    }

    #[test]
    fn launch_error_fails_connect() {
        let rx = FakeReceiver::spawn(fake_receiver::Options {
            fail_launch: true,
            ..Default::default()
        });
        let err = connect(rx.addr, "fake", &opts()).err().unwrap();
        assert!(err.to_string().contains("NOT_FOUND"), "{err}");
        rx.shutdown();
    }

    /// Streams video until `push` says something other than Accepted or
    /// Dropped; returns that.
    fn push_until_end(sink: &mut StreamingSink) -> Result<SinkStatus> {
        let deadline = Instant::now() + Duration::from_secs(10);
        for i in 1.. {
            assert!(Instant::now() < deadline, "the sink never noticed");
            match sink.push(&video_frame(i, 30)) {
                Ok(SinkStatus::Accepted | SinkStatus::Dropped) => {}
                other => return other,
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        unreachable!()
    }

    /// The user stops the cast on the TV: CLOSE and a status without the
    /// app. The session is over (`Finished`), not lost.
    #[test]
    fn receiver_ending_the_session_finishes_sink() {
        let rx = FakeReceiver::spawn(Default::default());
        let mut sink = connect(rx.addr, "fake", &opts()).unwrap();
        sink.start(&video_info(), None).unwrap();
        assert_eq!(
            sink.push(&video_frame(0, 30)).unwrap(),
            SinkStatus::Accepted
        );
        rx.end_session();
        assert_eq!(push_until_end(&mut sink).unwrap(), SinkStatus::Finished);
        sink.stop().unwrap();
        rx.shutdown();
    }

    /// The connection breaks without a CLOSE (the TV left the network,
    /// changed its address): `push` fails, so the session may reconnect.
    #[test]
    fn lost_connection_fails_sink() {
        let rx = FakeReceiver::spawn(Default::default());
        let mut sink = connect(rx.addr, "fake", &opts()).unwrap();
        sink.start(&video_info(), None).unwrap();
        assert_eq!(
            sink.push(&video_frame(0, 30)).unwrap(),
            SinkStatus::Accepted
        );
        rx.drop_connection();
        let e = push_until_end(&mut sink).unwrap_err();
        assert_eq!(e.kind(), ErrorKind::Closed, "{e}");
        // And stays failed.
        assert!(sink.push(&video_frame(99, 30)).is_err());
        sink.stop().unwrap();
        // The receiver serves the next connection as a new session.
        let mut again = connect(rx.addr, "fake", &opts()).unwrap();
        again.start(&video_info(), None).unwrap();
        stream(&mut again, 1, 30);
        wait_until("second session", || {
            let st = rx.state.lock().unwrap();
            st.streams
                .iter()
                .any(|s| s.session == 1 && s.codec == "h264" && s.checkpoint == 29)
        });
        again.stop().unwrap();
        let state = rx.shutdown();
        assert_eq!(state.lock().unwrap().sessions, 2);
    }

    /// RTP goes out and nothing comes back: lost after the feedback
    /// timeout, although the control channel is fine.
    #[test]
    fn silent_receiver_fails_sink() {
        let rx = FakeReceiver::spawn(Default::default());
        let hole = UdpSocket::bind("127.0.0.1:0").unwrap();
        let o = CastOptions {
            media_relay: Some(hole.local_addr().unwrap()),
            feedback_timeout: Duration::from_millis(300),
            ..opts()
        };
        let mut sink = connect(rx.addr, "fake", &o).unwrap();
        sink.start(&video_info(), None).unwrap();
        let t0 = Instant::now();
        let e = push_until_end(&mut sink).unwrap_err();
        assert_eq!(e.kind(), ErrorKind::Timeout, "{e}");
        assert!(t0.elapsed() >= Duration::from_millis(300));
        sink.stop().unwrap();
        rx.shutdown();
    }
}
