//! Core types shared by every module.
//!
//! Changing anything public here needs the owner's approval
//! (ARCHITECTURE.md, "Code Conventions"). Adding helper methods
//! is fine.

use std::sync::Arc;

use crate::error::Result;
use crate::util::ratio::Ratio;

/// Video timestamps are always in this clock rate.
pub const VIDEO_CLOCK_RATE: u32 = 90_000;

/// Which audio encode a track belongs to. AirPlay and Cast want different
/// audio codecs, so ffmpeg produces one audio track per family in use.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum AudioFamily {
    AirPlay,
    Cast,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum TrackKind {
    Video,
    Audio(AudioFamily),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum VideoCodec {
    H264,
    Hevc,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum AudioCodec {
    /// Apple Lossless.
    Alac,
    /// AAC-LC (raw access units, no ADTS).
    AacLc,
    /// AAC-ELD (AirPlay; needs libfdk_aac in ffmpeg).
    AacEld,
    Opus,
    /// Signed 16-bit little-endian interleaved PCM.
    PcmS16le,
}

/// One encoded access unit as it leaves the demuxer.
#[derive(Debug, Clone)]
pub struct EncodedFrame {
    pub track: TrackKind,
    /// Presentation timestamp: [`VIDEO_CLOCK_RATE`] ticks for video, sample
    /// ticks (`AudioInfo::sample_rate`) for audio. Starts near zero and is
    /// monotonic per track (no B-frames, so pts == dts for video).
    pub pts: u64,
    /// Video: IDR frame. Audio: always `true`.
    pub keyframe: bool,
    /// Video: AVCC (4-byte big-endian length-prefixed NAL units, no start
    /// codes, no in-band SPS/PPS required). Audio: one raw codec frame.
    pub data: Arc<[u8]>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VideoInfo {
    pub codec: VideoCodec,
    pub width: u32,
    pub height: u32,
    pub fps: Ratio,
    /// The `avcC` (AVCDecoderConfigurationRecord) or `hvcC` record.
    pub avcc: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AudioInfo {
    pub codec: AudioCodec,
    pub sample_rate: u32,
    pub channels: u8,
    /// Samples per channel per frame (e.g. 352 for AirPlay ALAC, 480 for
    /// 10 ms Opus at 48 kHz).
    pub frame_samples: u32,
    /// Codec configuration (ALAC magic cookie, AudioSpecificConfig, Opus
    /// header); empty if the codec has none.
    pub config: Vec<u8>,
}

/// An audio format a receiver accepts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct AudioFormat {
    pub codec: AudioCodec,
    pub sample_rate: u32,
    pub channels: u8,
}

/// What a connected receiver can take. Filled in by the sink after its
/// connect/negotiation phase, before ffmpeg starts.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Capabilities {
    pub max_width: u32,
    pub max_height: u32,
    pub max_fps: Ratio,
    /// Preferred first.
    pub video_codecs: Vec<VideoCodec>,
    /// Preferred first. Empty means the receiver takes no audio.
    pub audio_formats: Vec<AudioFormat>,
    /// Which audio encode this receiver consumes.
    pub audio_family: AudioFamily,
    pub max_bitrate_kbps: Option<u32>,
    /// The most pixels per second it decodes (width × height × fps), if
    /// it says (a Cast ANSWER's `maxPixelsPerSecond`). Page-encoded
    /// streams (`share`) lower their size to fit it.
    pub max_pixels_per_second: Option<u64>,
    /// The lowest playout delay the receiver accepts, if it says.
    pub min_latency_ms: Option<u32>,
    /// The playout delay the receiver prefers, if it says.
    pub preferred_latency_ms: Option<u32>,
    /// The shape of the receiver's screen, reduced (e.g. `(16, 9)`): it
    /// stretches pictures of another shape to fill it, so senders that
    /// choose their own frame size (`share`) match it and pad.
    /// TVs that do not say report [`DEFAULT_DISPLAY_ASPECT`]. `None`: any
    /// shape, the receiver fits the picture into its window itself (the
    /// browser player).
    pub display_aspect: Option<(u32, u32)>,
    /// The longest the receiver wants to wait for the next IDR, if it
    /// says (AirPlay: about 0.5 s, docs/airplay-mirroring.md §6.6);
    /// otherwise encodes plan one a second.
    pub max_key_interval_ms: Option<u32>,
}

/// The screen shape of a TV that does not say (TVs and projectors are
/// 16:9).
pub const DEFAULT_DISPLAY_ASPECT: (u32, u32) = (16, 9);

/// A resolution for pages tvpipe's browser renders (`share URL
/// --resolution`, `game play`'s TV picture): the page keeps its CSS
/// layout and is rendered at a device scale factor that fills this box.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Resolution {
    /// What the receivers take, at most 1920x1080.
    #[default]
    Auto,
    /// 1280x720.
    P720,
    /// 1920x1080.
    P1080,
    /// 3840x2160 (4K).
    P2160,
}

/// The largest picture [`Resolution::Auto`] picks (4K only when chosen:
/// it costs the computer much more).
pub const AUTO_MAX: (u32, u32) = (1920, 1080);

impl Resolution {
    /// Every choice, in the order the launcher shows them.
    pub const ALL: [Resolution; 4] = [
        Resolution::Auto,
        Resolution::P720,
        Resolution::P1080,
        Resolution::P2160,
    ];

    /// `auto`, `720p`, `1080p`, `2160p` (or `4k`).
    pub fn parse(s: &str) -> Option<Resolution> {
        match s {
            "auto" => Some(Resolution::Auto),
            "720p" => Some(Resolution::P720),
            "1080p" => Some(Resolution::P1080),
            "2160p" | "4k" | "4K" => Some(Resolution::P2160),
            _ => None,
        }
    }

    /// Its name on the API (`auto`, `720p`, `1080p`, `2160p`).
    pub fn as_str(self) -> &'static str {
        match self {
            Resolution::Auto => "auto",
            Resolution::P720 => "720p",
            Resolution::P1080 => "1080p",
            Resolution::P2160 => "2160p",
        }
    }

    /// The box the picture fits in (16:9; other shapes fit inside it).
    pub fn bounds(self) -> (u32, u32) {
        match self {
            Resolution::Auto => AUTO_MAX,
            Resolution::P720 => (1280, 720),
            Resolution::P1080 => (1920, 1080),
            Resolution::P2160 => (3840, 2160),
        }
    }

    /// Chosen explicitly (not `Auto`): receivers may be asked for more
    /// than their nominal screen (an AirPlay receiver's decoder maximum).
    pub fn explicit(self) -> bool {
        self != Resolution::Auto
    }
}

/// `w:h` reduced (`(1920, 1080)` → `(16, 9)`); `None` for a zero side.
pub fn aspect_of(w: u32, h: u32) -> Option<(u32, u32)> {
    fn gcd(a: u32, b: u32) -> u32 {
        if b == 0 {
            a
        } else {
            gcd(b, a % b)
        }
    }
    if w == 0 || h == 0 {
        return None;
    }
    let g = gcd(w, h);
    Some((w / g, h / g))
}

/// Which encoder makes the video: one of ffmpeg's, or our own.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
#[non_exhaustive]
pub enum Encoder {
    /// Probe `ffmpeg -encoders` and pick the best available (the built-in
    /// encoder when raw input has no ffmpeg).
    #[default]
    Auto,
    /// `media::h264enc` in-process (raw SLRW input and the test pattern;
    /// ARCHITECTURE.md). Never handed to ffmpeg.
    Builtin,
    /// ffmpeg's libx264.
    X264,
    /// ffmpeg's h264_videotoolbox (macOS).
    VideoToolbox,
    /// ffmpeg's h264_nvenc (NVIDIA).
    Nvenc,
    /// ffmpeg's h264_qsv (Intel).
    Qsv,
    /// ffmpeg's h264_vaapi (Linux).
    Vaapi,
    /// ffmpeg's h264_mf (Windows).
    MediaFoundation,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VideoPlan {
    pub codec: VideoCodec,
    pub encoder: Encoder,
    pub width: u32,
    pub height: u32,
    pub fps: Ratio,
    pub bitrate_kbps: u32,
    /// Keyframe interval in frames.
    pub gop: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AudioPlan {
    pub family: AudioFamily,
    pub codec: AudioCodec,
    pub sample_rate: u32,
    pub channels: u8,
    pub frame_samples: u32,
    pub bitrate_kbps: Option<u32>,
}

/// What ffmpeg must produce. Built by `session.rs` from the intersection of
/// all sinks' [`Capabilities`] and the user's options.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EncodePlan {
    pub video: VideoPlan,
    /// At most one entry per [`AudioFamily`]; empty for `--no-audio`.
    pub audio: Vec<AudioPlan>,
    /// Target playout delay shared by all sinks.
    pub latency_ms: u32,
}

/// Result of [`Sink::push`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SinkStatus {
    /// The frame was queued or sent.
    Accepted,
    /// The frame was dropped (congestion, or waiting for a keyframe). Not an
    /// error; the fanout keeps going.
    Dropped,
    /// The receiver ended the session (user stopped mirroring on the TV).
    /// The session removes the sink.
    Finished,
}

/// How far behind a sink's network is ([`Sink::backlog`]), for adaptive
/// bitrate (`media::abr`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Backlog {
    /// How long the oldest video that is not through yet has waited:
    /// queued, being written, or sent and not acknowledged.
    pub delay: std::time::Duration,
    /// The delay at which frames come late or are dropped.
    pub limit: std::time::Duration,
    /// Video frames dropped so far because the network was behind (a
    /// counter; it may start over when the sink reconnects).
    pub dropped: u64,
}

/// A receiver we stream to. One implementation per protocol family.
///
/// Lifecycle: construct + connect (protocol-specific, returns the sink) →
/// `capabilities()` → `start()` once ffmpeg's stream info is known →
/// `push()` for every frame → `stop()`.
pub trait Sink: Send {
    /// Human-readable receiver name, for logs.
    fn name(&self) -> &str;

    /// Valid after connect.
    fn capabilities(&self) -> &Capabilities;

    /// The session's media clock (ARCHITECTURE.md), handed over by the
    /// fanout before [`Sink::start`]: the sink maps pts to instants on it
    /// instead of anchoring a clock of its own on the first frame it gets,
    /// so every receiver shares one timeline. Wrappers must forward it.
    fn set_clock(&mut self, clock: crate::media::clock::SessionClock) {
        let _ = clock;
    }

    /// Sets up the media streams. `audio` is the track of this sink's
    /// [`AudioFamily`], if any.
    fn start(&mut self, video: &VideoInfo, audio: Option<&AudioInfo>) -> Result<()>;

    /// Hands over one frame. Must not block for long: queue internally and
    /// return [`SinkStatus::Dropped`] when full.
    fn push(&mut self, frame: &EncodedFrame) -> Result<SinkStatus>;

    /// True when the receiver asked for a keyframe (PLI, loss, join). The
    /// fanout then drops video for this sink until the next keyframe.
    fn wants_keyframe(&self) -> bool;

    /// How far behind sending is, for adaptive bitrate; `None` when the
    /// sink cannot tell. Sampled by the fanout after each video frame.
    /// Wrappers must forward it.
    fn backlog(&self) -> Option<Backlog> {
        None
    }

    /// Tears the session down so the TV leaves mirroring mode. Must be safe
    /// to call more than once.
    fn stop(&mut self) -> Result<()>;
}

impl Capabilities {
    /// Whether this receiver accepts a given audio format.
    pub fn accepts_audio(&self, fmt: &AudioFormat) -> bool {
        self.audio_formats.contains(fmt)
    }
}

/// What an input yields: the video and the audio track of each family.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StreamInfo {
    pub video: VideoInfo,
    pub audio: Vec<(AudioFamily, AudioInfo)>,
}

impl StreamInfo {
    pub fn audio_for(&self, family: AudioFamily) -> Option<&AudioInfo> {
        self.audio
            .iter()
            .find(|(f, _)| *f == family)
            .map(|(_, a)| a)
    }
}
