//! Orchestration: connect → choose the input → fanout → teardown
//! (ARCHITECTURE.md, "Session Lifecycle").
//!
//! Owner: lead.
//!
//! `play` / `debug pattern`:
//!
//! 1. Probe the input: an MP4/MOV/Matroska file with our own demuxer
//!    (`media::passthrough::probe`), anything else with `ffprobe`: size,
//!    frame rate, audio or not, finite (paced) or live.
//! 2. Resolve every `--to` (discovery for names; `ADDR[:PORT]` skips it)
//!    and connect all sinks before any input starts. Cast sinks negotiate
//!    OFFER/ANSWER here, so their capabilities are final; the offer keeps
//!    a passable file's bitrate and AAC, and offers AAC for an encoding
//!    game.
//! 3. Choose the input (`media::input`): a file that fits every receiver
//!    is sent unchanged (`PassthroughInput`), `--raw-video ...:h264` reads
//!    the game's H.264 (`SlrwEncodedInput`), raw SLRW and the test pattern
//!    use the built-in encoder (`media::builtin`) with `--encoder builtin`
//!    or when ffmpeg is missing, everything else is encoded by ffmpeg
//!    (`FfmpegInput`) after planning the encode from the user's options
//!    and the sinks' capabilities. ffmpeg is only located when needed.
//! 4. Push every frame through the fanout; while a sink wants a keyframe,
//!    ask the input for one (only an encoding game can). A receiver that
//!    drops out is reconnected meanwhile (`rejoin`, `--reconnect`).
//! 5. Tear down on EOF (after one playout delay, so the tail plays), on
//!    Ctrl-C / SIGTERM / `q` (see `util::interrupt`, without draining), or
//!    when every receiver has ended the session. Every sink's `stop()` runs
//!    (Cast: STOP + CLOSE) and the input finishes (ffmpeg is reaped).

use std::ffi::OsString;
use std::net::{IpAddr, SocketAddr};
use std::path::Path;
use std::process::{Command as StdCommand, Stdio};
use std::time::{Duration, Instant};

use crate::browser::layout;
#[cfg(feature = "player")]
use crate::browser::player::BrowserSink;
use crate::browser::player_options::PlayerOptions;
use crate::browser::protocol::{CaptureInfo, PageConfig, SharePlan};
#[cfg(feature = "share")]
use crate::browser::share::{ShareInputOptions, ShareServer};
use crate::cast::{self, CastOptions};
use crate::ctx::Ctx;
use crate::error::{Error, Result};
use crate::events::{
    self, AudioStarted, CaptureEvent, ConnectedEvent, EndInfo, Event, Events, Progress,
    ReceiverEnd, ReceiverEndInfo, ReceiverEvent, ReceiverState, ReceiverStats, SharePageEvent,
    Started, Stats, Step, VideoStarted,
};
#[cfg(feature = "h264")]
use crate::media::builtin::{BuiltinInput, BuiltinOptions, VideoOut};
use crate::media::fanout::{Fanout, FanoutConfig, SinkEnd};
#[cfg(feature = "ffmpeg")]
use crate::media::ffmpeg::{self, Source};
#[cfg(feature = "ffmpeg")]
use crate::media::input::FfmpegInput;
#[cfg(feature = "files")]
use crate::media::input::PassthroughInput;
use crate::media::input::{self, EncodedOptions, Input, SlrwEncodedInput};
#[cfg(feature = "files")]
use crate::media::passthrough;
#[cfg(feature = "ffmpeg")]
use crate::media::rawin;
use crate::opts::{
    BrowserOptions, Command, InputSpec, PlayOptions, RawAudioSpec, ShareOptions, Size,
    BROWSER_TARGET,
};
use crate::types::{
    AudioCodec, AudioFamily, AudioFormat, AudioPlan, Capabilities, EncodePlan, Encoder, Sink,
    TrackKind, VideoCodec, VideoPlan,
};
use crate::util::ratio::Ratio;

pub fn run(cmd: Command, ctx: &Ctx, io: GameIo) -> Result<()> {
    let cmd_name = cmd.name();
    match cmd {
        Command::Discover { .. }
        | Command::Pair { .. }
        | Command::Unpair { .. }
        | Command::Tunnel { .. }
        | Command::Qr { .. } => Err(Error::usage(format!("{} is not a session", cmd_name))),
        #[cfg(feature = "playshare")]
        Command::Playshare(_) | Command::GameTool(_) => {
            Err(Error::usage(format!("{} is not a session", cmd_name)))
        }
        Command::Play(opts) | Command::TestPattern(opts) => play_io(opts, io, ctx),
        #[cfg(feature = "headless")]
        Command::Share(opts) if opts.page.is_some() => browse::browse(opts, ctx),
        #[cfg(not(feature = "headless"))]
        Command::Share(opts) if opts.page.is_some() => Err(Error::feature("headless", "share URL")),
        #[cfg(feature = "share")]
        Command::Share(opts) => share(opts, ctx, &*io.approve),
        #[cfg(not(feature = "share"))]
        Command::Share(_) => Err(Error::feature("share", "share")),
        #[cfg(feature = "headless")]
        Command::Screen(opts) => screen::screen(opts, ctx),
        #[cfg(not(feature = "headless"))]
        Command::Screen(_) => Err(Error::feature("headless", "screen")),
        #[cfg(feature = "ffmpeg")]
        Command::DebugPipeline(o) => crate::media::debug::run(&o),
        #[cfg(not(feature = "ffmpeg"))]
        Command::DebugPipeline(_) => Err(Error::feature("ffmpeg", "debug pipeline")),
    }
}

/// How long `--to NAME` browses before giving up.
const DISCOVER_TIMEOUT: Duration = Duration::from_secs(4);
/// Cast control port.
const CAST_PORT: u16 = 8009;
/// AirPlay control port (for `ADDR:7000` and `airplay:ADDR`).
const AIRPLAY_PORT: u16 = 7000;
/// Target playout delay without `--latency`. Cast needs room for a
/// retransmission or two on Wi-Fi. openscreen's sender default is 200 ms,
/// but a Google TV on Wi-Fi has feedback gaps of ~220 ms, which overflow
/// the in-flight window a few times per 5 minutes at 200 ms (each costing
/// up to a GOP); docs/measurements.md. `--latency` goes lower on good networks.
pub const DEFAULT_LATENCY_MS: u32 = 300;
/// The least playout delay of a share over the tunnel (docs/tunnels.md).
pub const REMOTE_SHARE_LATENCY_MS: u32 = 300;
/// Largest default output (an input larger than this is scaled down).
const DEFAULT_MAX_SIZE: Size = Size {
    width: 1920,
    height: 1080,
};
/// Output size when neither `--size` nor the input says.
const FALLBACK_SIZE: Size = Size {
    width: 1280,
    height: 720,
};
const FALLBACK_FPS: Ratio = Ratio::integer(30);
const MAX_DEFAULT_FPS: u32 = 60;
/// Default bitrate: bits per pixel per frame, clamped below.
const DEFAULT_BITS_PER_PIXEL: f64 = 0.1;
const MIN_DEFAULT_KBPS: u32 = 1_000;
const MAX_DEFAULT_KBPS: u32 = 20_000;
/// How long `ffprobe` may take before we go on without it.
const PROBE_TIMEOUT: Duration = Duration::from_secs(10);
/// Opus frames: 10 ms (lowest latency libopus offers without overhead
/// blowing up).
const OPUS_FRAME_SAMPLES: u32 = 480;
const AAC_FRAME_SAMPLES: u32 = 1024;
const AUDIO_KBPS: u32 = 128;
/// How long the session waits for every sink's `start()` before it pulls
/// the input anyway.
const SINK_START_WAIT: Duration = Duration::from_secs(5);

// ---------------------------------------------------------------------------
// Targets

/// A resolved `--to`.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Target {
    Cast {
        addr: SocketAddr,
        name: String,
    },
    AirPlay {
        name: String,
        addr: SocketAddr,
        /// The discovered device (for the credentials lookup).
        device: Option<Box<crate::net::device::Device>>,
    },
    /// `--to browser`: a player page on 127.0.0.1. The options
    /// are filled in once the budget is known ([`configure_browsers`]).
    Browser(Box<PlayerOptions>),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Protocol {
    Cast,
    AirPlay,
}

/// `cast:` / `airplay:` prefixes force a protocol; `ADDR[:PORT]` skips
/// discovery (bare addresses are Cast on 8009, port 7000 is AirPlay).
fn parse_target(query: &str) -> (Option<Protocol>, &str) {
    for (prefix, proto) in [("cast:", Protocol::Cast), ("airplay:", Protocol::AirPlay)] {
        // `get`: a multi-byte character may sit where the prefix ends.
        let head = query.get(..prefix.len());
        if query.len() > prefix.len() && head.is_some_and(|h| h.eq_ignore_ascii_case(prefix)) {
            return (Some(proto), &query[prefix.len()..]);
        }
    }
    (None, query)
}

fn address_target(forced: Option<Protocol>, rest: &str) -> Option<Target> {
    let addr = match rest.parse::<SocketAddr>() {
        Ok(a) => a,
        Err(_) => {
            let ip = rest
                .trim_start_matches('[')
                .trim_end_matches(']')
                .parse::<IpAddr>()
                .ok()?;
            let port = match forced {
                Some(Protocol::AirPlay) => AIRPLAY_PORT,
                _ => CAST_PORT,
            };
            SocketAddr::new(ip, port)
        }
    };
    let proto = forced.unwrap_or(if addr.port() == AIRPLAY_PORT {
        Protocol::AirPlay
    } else {
        Protocol::Cast
    });
    let name = addr.to_string();
    Some(match proto {
        Protocol::Cast => Target::Cast { addr, name },
        Protocol::AirPlay => Target::AirPlay {
            name,
            addr,
            device: None,
        },
    })
}

fn device_target(dev: &crate::net::device::Device, forced: Option<Protocol>) -> Result<Target> {
    let name = dev.name.clone();
    let cast = dev
        .cast
        .as_ref()
        .filter(|_| forced != Some(Protocol::AirPlay));
    match cast {
        // AirPlay mirroring is not implemented yet, so a device with both
        // (Samsung, LG) goes over Cast.
        Some(c) if dev.cast_video() => Ok(Target::Cast {
            addr: SocketAddr::new(c.endpoint.addr(), c.endpoint.port),
            name,
        }),
        Some(_) if dev.airplay.is_none() => Err(Error::unsupported(format!(
            "{name} is a Cast audio device (no video output)"
        ))),
        _ if dev.airplay.is_some() && forced != Some(Protocol::Cast) => {
            let ep = dev
                .airplay
                .as_ref()
                .or(dev.raop.as_ref())
                .map(|a| &a.endpoint)
                .ok_or_else(|| Error::not_found(format!("{name} has no AirPlay endpoint")))?;
            Ok(Target::AirPlay {
                name,
                addr: SocketAddr::new(ep.addr(), ep.port),
                device: Some(Box::new(dev.clone())),
            })
        }
        _ => Err(Error::not_found(format!(
            "{name} has no {} endpoint",
            if forced == Some(Protocol::AirPlay) {
                "AirPlay"
            } else {
                "Cast"
            }
        ))),
    }
}

fn resolve_target(query: &str) -> Result<Target> {
    if query.eq_ignore_ascii_case(BROWSER_TARGET) {
        return Ok(Target::Browser(Box::default()));
    }
    let (forced, rest) = parse_target(query);
    if let Some(t) = address_target(forced, rest) {
        return Ok(t);
    }
    let dev = crate::net::discover::resolve(rest, DISCOVER_TIMEOUT, &[])?.ok_or_else(|| {
        Error::not_found(format!("no receiver named {rest:?}"))
            .with_code("no-receiver")
            .with_device(rest)
    })?;
    let t = device_target(&dev, forced)?;
    debug!("resolved {query:?} to {t:?}");
    Ok(t)
}

// ---------------------------------------------------------------------------
// Input probing

/// What `ffprobe` says about the input. Every field is optional: unknown
/// inputs (capture devices, URLs that time out) keep the defaults.
#[derive(Debug, Clone, Default, PartialEq)]
struct InputInfo {
    width: Option<u32>,
    height: Option<u32>,
    fps: Option<Ratio>,
    /// `None`: unknown (ffmpeg maps `0:a:0?`, so a missing track is fine).
    has_audio: Option<bool>,
    has_video: Option<bool>,
    /// Finite media (a file): paced with `-re` by default.
    duration: Option<f64>,
}

/// Parses `ffprobe -of compact` output (`stream|codec_type=video|width=...`
/// and `format|duration=...` lines).
fn parse_ffprobe(text: &str) -> InputInfo {
    let mut info = InputInfo {
        has_audio: Some(false),
        has_video: Some(false),
        ..InputInfo::default()
    };
    for line in text.lines() {
        let mut fields = line.trim().split('|');
        let section = fields.next().unwrap_or("");
        let kv: Vec<(&str, &str)> = fields.filter_map(|f| f.split_once('=')).collect();
        let get = |k: &str| kv.iter().find(|(key, _)| *key == k).map(|(_, v)| *v);
        match section {
            "stream" => match get("codec_type") {
                Some("video") if info.has_video != Some(true) => {
                    // Cover art and the like are "video" with no frame rate.
                    let fps = get("avg_frame_rate")
                        .and_then(|r| r.parse::<Ratio>().ok())
                        .filter(|r| r.den > 0 && r.num > 0 && r.as_f64() <= 240.0);
                    info.has_video = Some(true);
                    info.width = get("width").and_then(|w| w.parse().ok()).filter(|&w| w > 0);
                    info.height = get("height")
                        .and_then(|h| h.parse().ok())
                        .filter(|&h| h > 0);
                    info.fps = fps;
                }
                Some("audio") => info.has_audio = Some(true),
                _ => {}
            },
            "format" => {
                info.duration = get("duration")
                    .and_then(|d| d.parse::<f64>().ok())
                    .filter(|d| d.is_finite() && *d > 0.0);
            }
            _ => {}
        }
    }
    info
}

/// What ffprobe says about a file or URL, if there is an ffmpeg.
fn probe_with_ffmpeg(tools: &mut Tools<'_>, url: &OsString) -> InputInfo {
    match tools.get() {
        #[cfg(feature = "ffmpeg")]
        Ok((bin, _)) => probe_input(bin, url),
        #[cfg(not(feature = "ffmpeg"))]
        Ok((_, never)) => match *never {},
        Err(e) => {
            debug!("not probing the input: {e}");
            InputInfo::default()
        }
    }
}

#[cfg(feature = "ffmpeg")]
/// Runs ffprobe on a file or URL. Any failure means "unknown".
fn probe_input(ffmpeg: &Path, url: &OsString) -> InputInfo {
    let Some(ffprobe) = ffmpeg::locate_sibling(ffmpeg, "ffprobe") else {
        debug!("ffprobe not found; not probing the input");
        return InputInfo::default();
    };
    let child = StdCommand::new(&ffprobe)
        .args(["-v", "error", "-show_entries"])
        .arg("stream=codec_type,width,height,avg_frame_rate:format=duration")
        .args(["-of", "compact"])
        .arg(url)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn();
    let mut child = match child {
        Ok(c) => c,
        Err(e) => {
            debug!("cannot run {}: {e}", ffprobe.display());
            return InputInfo::default();
        }
    };
    let read = |pipe: Option<Box<dyn std::io::Read + Send>>| {
        std::thread::spawn(move || {
            let mut s = Vec::new();
            if let Some(mut p) = pipe {
                let _ = p.read_to_end(&mut s);
            }
            String::from_utf8_lossy(&s).into_owned()
        })
    };
    let out = read(child.stdout.take().map(|p| Box::new(p) as _));
    let err = read(child.stderr.take().map(|p| Box::new(p) as _));
    let deadline = Instant::now() + PROBE_TIMEOUT;
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break Some(s),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            _ => {
                warn!("ffprobe did not finish; going on without it");
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
        }
    };
    let out = out.join().unwrap_or_default();
    let err = err.join().unwrap_or_default();
    match status {
        Some(s) if s.success() => {
            let info = parse_ffprobe(&out);
            debug!("ffprobe: {info:?}");
            info
        }
        Some(s) => {
            let last = err.lines().last().unwrap_or("").trim();
            warn!("ffprobe failed ({s}): {last}");
            InputInfo::default()
        }
        None => InputInfo::default(),
    }
}

// ---------------------------------------------------------------------------
// Planning

/// What we would like to send, before the receivers had their say.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Desired {
    size: Size,
    fps: Ratio,
    bitrate_kbps: u32,
    latency_ms: u32,
}

/// The largest even size with `w:h`'s aspect ratio that fits `max`.
fn fit(w: u32, h: u32, max_w: u32, max_h: u32) -> Size {
    let even = |x: u64| (x.max(2) & !1) as u32;
    let (w64, h64) = (w.max(1) as u64, h.max(1) as u64);
    if w <= max_w && h <= max_h {
        return Size {
            width: even(w64),
            height: even(h64),
        };
    }
    // Scale by the tighter of the two limits.
    if w64 * max_h as u64 >= h64 * max_w as u64 {
        Size {
            width: even(max_w as u64),
            height: even(h64 * max_w as u64 / w64),
        }
    } else {
        Size {
            width: even(w64 * max_h as u64 / h64),
            height: even(max_h as u64),
        }
    }
}

fn default_bitrate(size: Size, fps: Ratio) -> u32 {
    let kbps =
        size.width as f64 * size.height as f64 * fps.as_f64() * DEFAULT_BITS_PER_PIXEL / 1000.0;
    (kbps as u32).clamp(MIN_DEFAULT_KBPS, MAX_DEFAULT_KBPS)
}

fn ratio_min(a: Ratio, b: Ratio) -> Ratio {
    if b.as_f64() < a.as_f64() {
        b
    } else {
        a
    }
}

fn desired(opts: &PlayOptions, input: &InputInfo) -> Desired {
    let raw = opts.raw_video.as_ref();
    let size = opts.size.unwrap_or_else(|| {
        let (w, h) = match (raw, input.width, input.height) {
            (Some(r), _, _) => (r.size.width, r.size.height),
            (None, Some(w), Some(h)) => (w, h),
            _ => (FALLBACK_SIZE.width, FALLBACK_SIZE.height),
        };
        fit(w, h, DEFAULT_MAX_SIZE.width, DEFAULT_MAX_SIZE.height)
    });
    let fps = opts.fps.unwrap_or_else(|| {
        let f = raw.map(|r| r.fps).or(input.fps).unwrap_or(FALLBACK_FPS);
        ratio_min(f, Ratio::integer(MAX_DEFAULT_FPS))
    });
    Desired {
        size,
        fps,
        bitrate_kbps: opts
            .bitrate_kbps
            .unwrap_or_else(|| default_bitrate(size, fps)),
        latency_ms: opts.latency_ms.unwrap_or(DEFAULT_LATENCY_MS),
    }
}

fn cast_options(d: &Desired, audio: bool) -> CastOptions {
    CastOptions {
        latency_ms: d.latency_ms,
        max_width: d.size.width,
        max_height: d.size.height,
        max_fps: d.fps,
        max_bitrate_kbps: d.bitrate_kbps,
        audio,
        ..CastOptions::default()
    }
}

/// The first audio format of the family that every sink of it accepts.
fn common_audio(caps: &[&Capabilities]) -> Option<AudioFormat> {
    let first = caps.first()?;
    first
        .audio_formats
        .iter()
        .find(|f| caps.iter().all(|c| c.accepts_audio(f)))
        .copied()
}

fn audio_plan(family: AudioFamily, f: AudioFormat) -> Option<AudioPlan> {
    if family == AudioFamily::AirPlay && f.codec == AudioCodec::Alac {
        // ffmpeg's ALAC encoder only makes 4096-sample frames; the AirPlay
        // sink wraps 352-sample PCM frames as verbatim ALAC instead.
        return Some(AudioPlan {
            family,
            codec: AudioCodec::PcmS16le,
            sample_rate: f.sample_rate,
            channels: f.channels,
            frame_samples: crate::airplay::ALAC_FRAME_SAMPLES,
            bitrate_kbps: None,
        });
    }
    let (frame_samples, bitrate) = match f.codec {
        AudioCodec::Opus => (OPUS_FRAME_SAMPLES, Some(AUDIO_KBPS)),
        AudioCodec::AacLc => (AAC_FRAME_SAMPLES, Some(AUDIO_KBPS)),
        _ => return None,
    };
    Some(AudioPlan {
        family,
        codec: f.codec,
        sample_rate: f.sample_rate,
        channels: f.channels,
        frame_samples,
        bitrate_kbps: bitrate,
    })
}

/// "PCM 48000 Hz 2 ch": an audio track by its codec, not its family (the
/// AirPlay family's PCM also feeds browsers).
fn audio_label(codec: AudioCodec, sample_rate: u32, channels: u8) -> String {
    let name = match codec {
        AudioCodec::PcmS16le => "PCM",
        AudioCodec::AacLc => "AAC-LC",
        AudioCodec::AacEld => "AAC-ELD",
        AudioCodec::Opus => "Opus",
        AudioCodec::Alac => "ALAC",
    };
    format!("{name} {sample_rate} Hz {channels} ch")
}

/// The encode plan: `d` clamped by every sink's capabilities.
fn plan(d: &Desired, encoder: Encoder, caps: &[&Capabilities], audio: bool) -> Result<EncodePlan> {
    if caps.is_empty() {
        return Err(Error::usage("no receivers"));
    }
    if let Some(c) = caps
        .iter()
        .find(|c| !c.video_codecs.contains(&VideoCodec::H264))
    {
        return Err(Error::unsupported(format!(
            "a receiver does not take H.264 (it offers {:?})",
            c.video_codecs
        )));
    }
    let max_w = caps.iter().map(|c| c.max_width).min().unwrap_or(0);
    let max_h = caps.iter().map(|c| c.max_height).min().unwrap_or(0);
    if max_w < 2 || max_h < 2 {
        return Err(Error::unsupported("a receiver allows no video size"));
    }
    let size = fit(d.size.width, d.size.height, max_w, max_h);
    let fps = caps
        .iter()
        .map(|c| c.max_fps)
        .filter(|f| f.num > 0 && f.den > 0)
        .fold(d.fps, ratio_min);
    // A Cast receiver's maxPixelsPerSecond: a smaller picture, the same
    // frame rate.
    let rate = caps.iter().filter_map(|c| c.max_pixels_per_second).min();
    let fitted = fit_pixel_rate(size, fps, rate);
    if fitted != size {
        info!(
            "plan: {}x{}@{fps} is more than a receiver decodes ({} pixels/s): {}x{}",
            size.width,
            size.height,
            rate.unwrap_or(0),
            fitted.width,
            fitted.height
        );
    }
    let size = fitted;
    let mut bitrate = d.bitrate_kbps;
    for c in caps {
        if let Some(b) = c.max_bitrate_kbps.filter(|&b| b > 0) {
            bitrate = bitrate.min(b);
        }
    }
    let latency_ms = latency(d, caps);
    let key_ms = caps
        .iter()
        .filter_map(|c| c.max_key_interval_ms)
        .min()
        .unwrap_or(1000);
    let mut audio_plans = Vec::new();
    if audio {
        for family in [AudioFamily::Cast, AudioFamily::AirPlay] {
            let of: Vec<&Capabilities> = caps
                .iter()
                .copied()
                .filter(|c| c.audio_family == family)
                .collect();
            if of.is_empty() {
                continue;
            }
            match common_audio(&of).and_then(|f| audio_plan(family, f)) {
                Some(p) => audio_plans.push(p),
                None => warn!("no audio format all {family:?} receivers take; video only"),
            }
        }
    }
    Ok(EncodePlan {
        video: VideoPlan {
            codec: VideoCodec::H264,
            encoder,
            width: size.width,
            height: size.height,
            fps,
            bitrate_kbps: bitrate.max(100),
            // An IDR a second, or as often as a receiver wants (AirPlay:
            // every ~0.5 s). The browser player takes AirPlay's audio but
            // not its rule: more keyframes cost the other pictures bits.
            gop: (fps.ceil() as u64 * key_ms as u64)
                .div_ceil(1000)
                .clamp(1, u32::MAX as u64) as u32,
        },
        audio: audio_plans,
        latency_ms,
    })
}

// ---------------------------------------------------------------------------
// The session

/// Connects one target (the tests substitute fakes).
type Connector<'a> = &'a (dyn Fn(&Target, &CastOptions, &crate::airplay::MirrorOptions) -> Result<Box<dyn Sink>>
         + Sync);

fn connect_one(
    t: &Target,
    opts: &CastOptions,
    mirror: &crate::airplay::MirrorOptions,
    ctx: &Ctx,
) -> Result<Box<dyn Sink>> {
    match t {
        #[cfg(feature = "cast")]
        Target::Cast { addr, name } => Ok(Box::new(cast::connect(*addr, name, opts)?)),
        #[cfg(not(feature = "cast"))]
        Target::Cast { name, .. } => Err(Error::feature("cast", name)),
        #[cfg(not(feature = "airplay"))]
        Target::AirPlay { name, .. } => Err(Error::feature("airplay", name)),
        #[cfg(feature = "airplay")]
        Target::AirPlay { addr, device, .. } => {
            let target = crate::airplay::pair::Target {
                addr: *addr,
                device: device.as_deref().cloned(),
            };
            Ok(Box::new(crate::airplay::sink::connect_mirror(
                &target,
                mirror,
                &ctx.storage,
            )?))
        }
        #[cfg(feature = "player")]
        Target::Browser(o) => Ok(Box::new(BrowserSink::bind(o, ctx)?)),
        #[cfg(not(feature = "player"))]
        Target::Browser(o) => Err(Error::feature("player", &o.name)),
    }
}

fn target_name(t: &Target) -> &str {
    match t {
        Target::Cast { name, .. } | Target::AirPlay { name, .. } => name,
        Target::Browser(o) => &o.name,
    }
}

/// Sets up the `--to browser` targets: the page's options, the session's
/// playout budget and whether audio goes there.
fn configure_browsers(
    targets: &mut [Target],
    opts: &BrowserOptions,
    latency_ms: u32,
    audio: bool,
    storage: &crate::storage::Storage,
) {
    if !targets.iter().any(|t| matches!(t, Target::Browser(_))) {
        return;
    }
    // One URL across runs on a fixed port (docs/player-protocol.md); a
    // storage we cannot write only costs that. Any free port (0) makes a
    // new URL anyway, so nothing is kept.
    let token = match opts.port {
        Some(0) => None,
        _ => match crate::browser::player_options::persistent_token(storage, opts.new_token) {
            Ok(t) => Some(t),
            Err(e) => {
                warn!("browser: cannot keep the page's token ({e}); the URL is new this time");
                None
            }
        },
    };
    for t in targets {
        if let Target::Browser(o) = t {
            **o = PlayerOptions {
                name: BROWSER_TARGET.into(),
                port: opts.port,
                token: token.clone(),
                open: opts.open,
                wait_for_viewer: opts.wait_for_viewer,
                latency_ms,
                audio,
                tunnel: opts.tunnel,
                tunnel_ttl: opts.tunnel_ttl,
            };
        }
    }
}

/// Keeps what worked: with several receivers, one that cannot be resolved
/// or connected is logged and left out, and the session goes on with the
/// others; it fails only when none is left (ARCHITECTURE.md).
fn keep_working<T>(what: &str, results: Vec<(String, Result<T>)>) -> Result<Vec<T>> {
    let total = results.len();
    let mut ok = Vec::new();
    let mut first_err = None;
    for (name, r) in results {
        match r {
            Ok(v) => ok.push(v),
            Err(e) => {
                error!("{name}: {e}");
                first_err.get_or_insert(e);
            }
        }
    }
    match first_err {
        Some(e) if ok.is_empty() => Err(e),
        Some(_) => {
            warn!(
                "{} of {total} receivers {what}; going on without the others",
                ok.len()
            );
            Ok(ok)
        }
        None => Ok(ok),
    }
}

/// Resolves every `--to` in parallel (discovery browses for names), with
/// the reconnect hooks' resolver when there are some.
fn resolve_all(
    queries: &[String],
    rejoin: Option<&Rejoin>,
    events: &Events,
) -> Result<Vec<Target>> {
    let resolve: &(dyn Fn(&str) -> Result<Target> + Sync) = match rejoin {
        Some(r) => &*r.resolve,
        None => &resolve_target,
    };
    // Names are looked up on the network (seconds); `browser` and
    // addresses are not.
    let finds = |q: &str| {
        !q.eq_ignore_ascii_case(BROWSER_TARGET) && {
            let (forced, rest) = parse_target(q);
            address_target(forced, rest).is_none()
        }
    };
    let results = std::thread::scope(|s| {
        let handles: Vec<_> = queries
            .iter()
            .map(|q| {
                if finds(q) {
                    events.progress(Progress::Begin(Step::Find(q.clone())));
                }
                s.spawn(move || resolve(q))
            })
            .collect();
        queries
            .iter()
            .zip(handles)
            .map(|(q, h)| {
                let r = h
                    .join()
                    .unwrap_or_else(|_| Err(Error::process("resolve thread panicked")));
                match &r {
                    Err(e) => events.receiver(q, None, ReceiverState::Failed, Some(e)),
                    Ok(_) if finds(q) => {
                        events.progress(Progress::Done(Step::Find(q.clone()), None))
                    }
                    Ok(_) => {}
                }
                (q.clone(), r)
            })
            .collect()
    });
    keep_working("resolved", results)
}

/// Connects every target in parallel; with `rejoin`, the sinks reconnect
/// when their receiver drops out (`session::rejoin`).
fn connect_all(
    targets: &[Target],
    connect: Connector<'_>,
    opts: &CastOptions,
    mirror: &crate::airplay::MirrorOptions,
    rejoin: Option<&Rejoin>,
    events: &Events,
) -> Result<Vec<Box<dyn Sink>>> {
    let results: Vec<(String, Result<Box<dyn Sink>>)> = std::thread::scope(|s| {
        let handles: Vec<_> = targets
            .iter()
            .map(|t| {
                // The browser's page binds at once (its `player` event
                // says where).
                if !matches!(t, Target::Browser(_)) {
                    events.progress(Progress::Begin(Step::Connect(target_name(t).to_owned())));
                }
                s.spawn(move || {
                    let sink = connect(t, opts, mirror)?;
                    Ok(match rejoin {
                        Some(r) => rejoin::wrap(t, sink, r, opts, mirror),
                        None => sink,
                    })
                })
            })
            .collect();
        targets
            .iter()
            .zip(handles)
            .map(|(t, h)| {
                let r = h
                    .join()
                    .unwrap_or_else(|_| Err(Error::process("connect thread panicked")));
                let name = target_name(t).to_owned();
                match &r {
                    Ok(sink) => events.emit(Event::Receiver(
                        ReceiverEvent::new(
                            &name,
                            Some(target_protocol(t)),
                            ReceiverState::Connected,
                            None,
                        )
                        .with_delay(connected_delay_ms(
                            t,
                            sink.as_ref(),
                            opts,
                            mirror,
                        )),
                    )),
                    Err(e) => events.receiver(
                        &name,
                        Some(target_protocol(t)),
                        ReceiverState::Failed,
                        Some(e),
                    ),
                }
                (name, r)
            })
            .collect()
    });
    let sinks = keep_working("connected", results)?;
    events.emit(Event::Connected(ConnectedEvent {
        receivers: sinks.iter().map(|s| s.name().to_owned()).collect(),
    }));
    Ok(sinks)
}

/// The playout delay a target shows video with (the `connected`
/// event's `delay_ms`): Cast's target delay, AirPlay's video lead, the
/// player page's delay.
fn target_delay_ms(t: &Target, opts: &CastOptions, mirror: &crate::airplay::MirrorOptions) -> u32 {
    match t {
        Target::Cast { .. } => opts.latency_ms,
        #[cfg(feature = "airplay")]
        Target::AirPlay { .. } => crate::airplay::policy::Leads::new(mirror.latency_ms).video_ms,
        #[cfg(not(feature = "airplay"))]
        Target::AirPlay { .. } => mirror.latency_ms.unwrap_or(0),
        Target::Browser(o) => o.latency_ms,
    }
}

/// [`target_delay_ms`], with an AirPlay session's own video lead.
fn connected_delay_ms(
    t: &Target,
    sink: &dyn Sink,
    opts: &CastOptions,
    mirror: &crate::airplay::MirrorOptions,
) -> u32 {
    match (t, sink.capabilities().preferred_latency_ms) {
        (Target::AirPlay { .. }, Some(ms)) => ms,
        _ => target_delay_ms(t, opts, mirror),
    }
}

/// The receiver's protocol in events.
fn target_protocol(t: &Target) -> events::Protocol {
    match t {
        Target::Cast { .. } => events::Protocol::Cast,
        Target::AirPlay { .. } => events::Protocol::AirPlay,
        Target::Browser(_) => events::Protocol::Browser,
    }
}

fn stop_all(sinks: Vec<Box<dyn Sink>>) {
    for mut s in sinks {
        if let Err(e) = s.stop() {
            warn!("{}: stop: {e}", s.name());
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum EndReason {
    Eof,
    Interrupted,
    ReceiversGone,
}

#[cfg(feature = "ffmpeg")]
type FfProbe = ffmpeg::Probe;
/// Without the `ffmpeg` feature there is no ffmpeg to find.
#[cfg(not(feature = "ffmpeg"))]
enum FfProbe {}

/// ffmpeg, located and probed on first use: passthrough, encoded SLRW and
/// the built-in test pattern never need it.
struct Tools<'a> {
    explicit: Option<&'a Path>,
    found: Option<(std::path::PathBuf, FfProbe)>,
}

impl<'a> Tools<'a> {
    fn new(explicit: Option<&'a Path>) -> Tools<'a> {
        Tools {
            explicit,
            found: None,
        }
    }

    fn get(&mut self) -> Result<(&Path, &FfProbe)> {
        #[cfg(not(feature = "ffmpeg"))]
        return Err(Error::feature("ffmpeg", "this input"));
        #[cfg(feature = "ffmpeg")]
        if self.found.is_none() {
            let bin = ffmpeg::locate(self.explicit)?;
            let probe = ffmpeg::Probe::run(&bin)?;
            self.found = Some((bin, probe));
        }
        match &self.found {
            Some((bin, probe)) => Ok((bin, probe)),
            None => Err(Error::not_found("ffmpeg")),
        }
    }
}

#[cfg(feature = "files")]
/// What a probed file says, in the form `desired` takes.
fn file_input_info(fi: &passthrough::FileInfo) -> InputInfo {
    InputInfo {
        width: Some(fi.video.width).filter(|&w| w > 0),
        height: Some(fi.video.height).filter(|&h| h > 0),
        fps: Some(fi.video.fps).filter(|f| f.num > 0 && f.den > 0),
        has_audio: Some(fi.audio.is_some() || fi.unsupported_audio.is_some()),
        has_video: Some(true),
        duration: fi.duration,
    }
}

/// Where the frames come from, decided once the receivers are known.
enum Route {
    #[cfg(feature = "files")]
    Passthrough(std::path::PathBuf, passthrough::PassPlan),
    Encoded,
    /// Raw SLRW or the test pattern through `media::h264enc`.
    Builtin,
    Ffmpeg,
}

/// Whether raw SLRW input or the test pattern goes through the built-in
/// encoder instead of ffmpeg. The test pattern always does unless an
/// ffmpeg encoder is named (`--encoder x264` etc. selects ffmpeg's
/// `testsrc2`); raw input does when asked (`--encoder builtin`), or with
/// `--encoder auto` when ffmpeg is missing.
fn use_builtin(opts: &PlayOptions, encoded: bool, tools: &mut Tools<'_>) -> Result<bool> {
    let raw = opts.input == InputSpec::Stdin && !encoded;
    let pattern = opts.input == InputSpec::TestPattern;
    let builtin = match opts.encoder {
        _ if encoded => false,
        Encoder::Builtin if raw || pattern => true,
        Encoder::Builtin => {
            return Err(Error::usage(
                "--encoder builtin encodes raw SLRW input (-) and the test pattern; \
                 files, URLs and capture devices need ffmpeg",
            ))
        }
        Encoder::Auto if raw => match tools.get() {
            Ok(_) => false,
            Err(e) => {
                debug!("{e}; encoding the raw input with the built-in H.264 encoder");
                true
            }
        },
        Encoder::Auto if pattern => true,
        _ => false,
    };
    if builtin && !cfg!(feature = "h264") {
        return Err(Error::feature("h264", "the built-in H.264 encoder"));
    }
    if builtin && raw {
        let v = opts
            .raw_video
            .as_ref()
            .ok_or_else(|| Error::usage("raw input (-) needs --raw-video WxH@FPS:PIXFMT"))?;
        if crate::media::convert::PixelFormat::from_name(&v.pix_fmt).is_none() {
            return Err(Error::unsupported(format!(
                "the built-in encoder cannot read {:?} frames (rgba, bgra, rgb0, bgr0, rgb24, \
                 bgr24, nv12, yuv420p) and ffmpeg is {}",
                v.pix_fmt,
                if opts.encoder == Encoder::Builtin {
                    "not used with --encoder builtin"
                } else {
                    "not available"
                }
            )));
        }
    }
    Ok(builtin)
}

/// The game's ends of our stdio (SLRW in, keyframe requests out): the
/// CLI's stdin and stdout, or the machine interface's router.
pub struct GameIo {
    pub stdin: Box<dyn std::io::Read + Send>,
    pub stdout: Box<dyn std::io::Write + Send>,
    /// Whether a share from over the tunnel may reach the receivers
    /// (without `--yes`).
    pub approve: Box<RemoteApprover>,
}

impl GameIo {
    /// No game: an empty input, requests go nowhere.
    pub fn none() -> GameIo {
        GameIo {
            stdin: Box::new(std::io::empty()),
            stdout: Box::new(std::io::sink()),
            approve: Box::new(|_, _| false),
        }
    }
}

fn play(opts: PlayOptions, ctx: &Ctx) -> Result<()> {
    play_io(opts, GameIo::none(), ctx)
}

fn play_io(opts: PlayOptions, io: GameIo, ctx: &Ctx) -> Result<()> {
    let rejoin = Rejoin::system(opts.reconnect, ctx);
    let connect =
        |t: &Target, o: &CastOptions, m: &crate::airplay::MirrorOptions| connect_one(t, o, m, ctx);
    play_rejoin(opts, io, &connect, ctx, Some(&rejoin))
}

/// `play` with the connector and the stop request (Ctrl-C, SIGTERM, `q`)
/// given: the tests use fakes and their own stop flag.
fn play_with(opts: PlayOptions, io: GameIo, connect: Connector<'_>, ctx: &Ctx) -> Result<()> {
    play_rejoin(opts, io, connect, ctx, None)
}

/// `play_with` with the reconnect hooks (`None`: no reconnecting; names
/// are resolved by discovery).
fn play_rejoin(
    opts: PlayOptions,
    io: GameIo,
    connect: Connector<'_>,
    ctx: &Ctx,
    rejoin: Option<&Rejoin>,
) -> Result<()> {
    // Also here for the tests, which do not go through `main`.
    crate::util::timer::raise_resolution();
    let stop = &ctx.stop;
    let mut tools = Tools::new(opts.ffmpeg.as_deref());

    // 1. The input. A missing local file fails before any TV is touched.
    if let InputSpec::Path(p) = &opts.input {
        let looks_like_url = p.to_string_lossy().contains("://");
        if !looks_like_url && !Path::new(p).exists() {
            return Err(
                Error::not_found(format!("{}: no such file", Path::new(p).display()))
                    .with_code("input-not-found"),
            );
        }
    }
    let encoded = opts
        .raw_video
        .as_ref()
        .is_some_and(|v| v.pix_fmt == crate::media::slrw::ENCODED_PIX_FMT);
    if encoded && opts.input != InputSpec::Stdin {
        return Err(Error::usage(
            "--raw-video ...:h264 reads SLRW from stdin (-)",
        ));
    }
    let builtin = use_builtin(&opts, encoded, &mut tools)?;
    #[cfg(feature = "files")]
    let candidate = input::passthrough_candidate(&opts);
    #[cfg(feature = "files")]
    let probed = candidate.as_deref().map(passthrough::probe);
    #[cfg(feature = "files")]
    let file_info = match &probed {
        Some(Ok(fi)) => Some(file_input_info(fi)),
        _ => None,
    };
    #[cfg(not(feature = "files"))]
    let file_info: Option<InputInfo> = None;
    let input = match &opts.input {
        InputSpec::Path(p) => match file_info {
            Some(i) => i,
            None => probe_with_ffmpeg(&mut tools, p),
        },
        InputSpec::TestPattern => InputInfo {
            has_audio: Some(true),
            has_video: Some(true),
            ..InputInfo::default()
        },
        InputSpec::Stdin => InputInfo {
            has_audio: Some(opts.raw_audio.is_some()),
            has_video: Some(true),
            ..InputInfo::default()
        },
        InputSpec::FfmpegArgs(_) => InputInfo::default(),
    };
    if input.has_video == Some(false) {
        return Err(Error::unsupported("the input has no video stream"));
    }
    let audio = !opts.no_audio && input.has_audio != Some(false);
    if !opts.no_audio && !audio {
        info!("the input has no audio; streaming video only");
    }
    let mut d = desired(&opts, &input);

    // 2. Receivers, before ffmpeg. Offers follow what we can send: a file
    // that may pass keeps its bitrate and its AAC; an encoding game's PCM
    // becomes AAC for Cast.
    let mut cast_opts = cast_options(&d, audio);
    #[cfg(feature = "files")]
    let check = passthrough::CheckOptions {
        audio,
        ..Default::default()
    };
    #[cfg(feature = "files")]
    if let Some(Ok(fi)) = &probed {
        if input::encode_forced_by(&opts).is_none() && passthrough::file_ok(fi, check) {
            if let Some(k) = fi.peak_video_kbps.or(fi.video_kbps) {
                cast_opts.max_bitrate_kbps =
                    cast_opts.max_bitrate_kbps.max(k.min(MAX_DEFAULT_KBPS));
            }
            if let Some(a) = fi
                .audio
                .as_ref()
                .filter(|a| audio && a.codec == AudioCodec::AacLc)
            {
                cast_opts.audio_codecs = vec![AudioCodec::AacLc];
                cast_opts.audio_sample_rate = a.sample_rate;
                cast_opts.audio_channels = a.channels;
            }
        }
    }
    let mut targets = resolve_all(&opts.to, rejoin, &ctx.events)?;
    // The built-in test pattern's beep: 44.1 kHz when AirPlay listens.
    let pattern_audio =
        RawAudioSpec::session_pcm(targets.iter().any(|t| matches!(t, Target::AirPlay { .. })));
    let pattern_rate = pattern_audio.sample_rate;
    let game_audio = match &opts.input {
        InputSpec::TestPattern if builtin => Some(&pattern_audio),
        InputSpec::Stdin if encoded || builtin => opts.raw_audio.as_ref(),
        _ => None,
    };
    if audio {
        // In-process audio for Cast is AAC (media::aacenc).
        if let Some(f) = game_audio.and_then(|a| input::encoded_cast_audio(Some(a))) {
            cast_opts.audio_codecs = vec![AudioCodec::AacLc];
            cast_opts.audio_sample_rate = f.sample_rate;
            cast_opts.audio_channels = f.channels;
        }
    }
    let budget = shared_budget(opts.latency_ms, &targets);
    cast_opts.latency_ms = budget.cast_ms;
    configure_browsers(
        &mut targets,
        &opts.browser,
        budget.browser_ms,
        audio,
        &ctx.storage,
    );
    d.latency_ms = budget.session_ms;
    let mirror = crate::airplay::MirrorOptions {
        latency_ms: budget.airplay_ms,
        audio,
        ..Default::default()
    };
    let sinks = connect_all(&targets, connect, &cast_opts, &mirror, rejoin, &ctx.events)?;
    if stop.requested() {
        stop_all(sinks);
        return Ok(());
    }

    // 3. The route, then the input.
    let caps: Vec<&Capabilities> = sinks.iter().map(|s| s.capabilities()).collect();
    let named: Vec<(&str, &Capabilities)> =
        sinks.iter().map(|s| (s.name(), s.capabilities())).collect();
    #[cfg(not(feature = "files"))]
    let route = match () {
        _ if encoded => Route::Encoded,
        _ if builtin => Route::Builtin,
        _ => Route::Ffmpeg,
    };
    #[cfg(feature = "files")]
    let route = match (&candidate, &probed) {
        _ if encoded => Route::Encoded,
        _ if builtin => Route::Builtin,
        (Some(path), Some(probed)) => match input::decide_file(probed, &opts, &named) {
            input::FileDecision::Passthrough { info: fi, plan } => {
                info!(
                    "passthrough: sending {} unchanged ({:?} {}x{}@{}{})",
                    path.display(),
                    fi.video.codec,
                    fi.video.width,
                    fi.video.height,
                    fi.video.fps,
                    match (&fi.audio, plan.audio_families.is_empty()) {
                        (Some(a), false) => format!(", {:?} audio", a.codec),
                        _ => String::new(),
                    }
                );
                Route::Passthrough(path.clone(), plan)
            }
            input::FileDecision::Ffmpeg { why } => {
                info!("{why}");
                Route::Ffmpeg
            }
        },
        _ => Route::Ffmpeg,
    };
    let route_name = match &route {
        #[cfg(feature = "files")]
        Route::Passthrough(..) => events::Route::Passthrough,
        Route::Encoded => events::Route::Encoded,
        Route::Builtin => events::Route::Builtin,
        Route::Ffmpeg => events::Route::Ffmpeg,
    };
    let opened: Result<(Box<dyn Input>, u32)> = (|| match route {
        #[cfg(feature = "files")]
        Route::Passthrough(path, plan) => {
            let realtime = opts.realtime.unwrap_or(true);
            let i = PassthroughInput::open(&path, &plan, realtime, opts.looped, stop.clone())?;
            Ok((Box::new(i) as Box<dyn Input>, latency(&d, &caps)))
        }
        Route::Encoded => {
            if let Some(c) = caps
                .iter()
                .find(|c| !c.video_codecs.contains(&VideoCodec::H264))
            {
                return Err(Error::unsupported(format!(
                    "a receiver does not take H.264 (it offers {:?})",
                    c.video_codecs
                )));
            }
            let raw_audio = opts.raw_audio.as_ref().filter(|_| audio);
            let (families, warnings) = input::encoded_audio_families(raw_audio, &named);
            for w in warnings {
                warn!("{w}");
            }
            let video = opts
                .raw_video
                .clone()
                .ok_or_else(|| Error::usage("--raw-video missing"))?;
            let i = SlrwEncodedInput::open(
                io.stdin,
                EncodedOptions {
                    video,
                    audio: raw_audio.cloned(),
                    audio_families: families,
                    back_channel: Some(io.stdout),
                },
                stop.clone(),
            )?;
            Ok((Box::new(i) as Box<dyn Input>, latency(&d, &caps)))
        }
        #[cfg(not(feature = "h264"))]
        Route::Builtin => Err(Error::feature("h264", "the built-in H.264 encoder")),
        #[cfg(feature = "h264")]
        Route::Builtin => {
            // Audio is planned like the encoded-SLRW path's, below.
            let plan = plan(&d, Encoder::Builtin, &caps, false)?;
            info!(
                "plan: {}x{}@{} {} kbit/s, gop {}, latency {} ms (built-in encoder)",
                plan.video.width,
                plan.video.height,
                plan.video.fps,
                plan.video.bitrate_kbps,
                plan.video.gop,
                plan.latency_ms
            );
            let out = VideoOut {
                size: Size {
                    width: plan.video.width,
                    height: plan.video.height,
                },
                fps: plan.video.fps,
                bitrate_kbps: plan.video.bitrate_kbps,
                gop: plan.video.gop,
            };
            let (families, warnings) =
                input::encoded_audio_families(game_audio.filter(|_| audio), &named);
            for w in warnings {
                warn!("{w}");
            }
            let i = if opts.input == InputSpec::TestPattern {
                BuiltinInput::test_pattern(out, pattern_rate, families, stop.clone())?
            } else {
                let video_in = opts
                    .raw_video
                    .clone()
                    .ok_or_else(|| Error::usage("--raw-video missing"))?;
                BuiltinInput::open_slrw(
                    io.stdin,
                    BuiltinOptions {
                        video_in,
                        video_out: out,
                        audio: opts.raw_audio.clone().filter(|_| audio),
                        audio_families: families,
                        threads: opts.threads.min(u32::MAX as usize) as u32,
                    },
                    stop.clone(),
                )?
            };
            Ok((Box::new(i) as Box<dyn Input>, plan.latency_ms))
        }
        #[cfg(not(feature = "ffmpeg"))]
        Route::Ffmpeg => Err(Error::feature("ffmpeg", "this input")),
        #[cfg(feature = "ffmpeg")]
        Route::Ffmpeg => {
            let plan = plan(&d, opts.encoder, &caps, audio)?;
            info!(
                "plan: {}x{}@{} {} kbit/s, gop {}, audio {}, latency {} ms",
                plan.video.width,
                plan.video.height,
                plan.video.fps,
                plan.video.bitrate_kbps,
                plan.video.gop,
                plan.audio
                    .iter()
                    .map(|a| audio_label(a.codec, a.sample_rate, a.channels))
                    .reduce(|a, b| format!("{a}, {b}"))
                    .unwrap_or_else(|| "none".into()),
                plan.latency_ms
            );
            let (bin, probe) = tools.get()?;
            let (source, raw) = ffmpeg_source(&opts, &input, io.stdin)?;
            let i = FfmpegInput::start(bin, probe, &source, &plan, raw, stop.clone())?;
            Ok((Box::new(i) as Box<dyn Input>, plan.latency_ms))
        }
    })();
    drop(caps);
    drop(named);
    let (input, latency_ms) = match opened {
        Ok(v) => v,
        Err(e) => {
            stop_all(sinks);
            if stop.requested() {
                info!("stopped");
                return Ok(());
            }
            return Err(e);
        }
    };
    match stream(input, route_name, latency_ms, sinks, ctx) {
        Ok(EndReason::Interrupted) => {
            info!("stopped");
            Ok(())
        }
        Ok(_) => Ok(()),
        Err(e) => Err(e),
    }
}

// ---------------------------------------------------------------------------
// Share a browser tab

#[cfg(feature = "share")]
/// `share`'s frame rate without `--fps`.
const SHARE_FPS: Ratio = Ratio::integer(30);
#[cfg(feature = "share")]
/// The most `share` offers Cast without `--size`/`--fps`; the ANSWER may
/// allow less.
const SHARE_OFFER_SIZE: Size = Size {
    width: 1920,
    height: 1080,
};
#[cfg(feature = "share")]
const SHARE_OFFER_FPS: Ratio = Ratio::integer(60);

#[cfg(feature = "share")]
/// What `share` offers Cast: upper bounds, not the stream's size.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ShareOffer {
    size: Size,
    fps: Ratio,
    bitrate_kbps: u32,
}

#[cfg(feature = "share")]
impl ShareOffer {
    fn new(opts: &ShareOptions) -> ShareOffer {
        let size = opts.size.unwrap_or(SHARE_OFFER_SIZE);
        let fps = opts.fps.unwrap_or(SHARE_OFFER_FPS);
        ShareOffer {
            size,
            fps,
            bitrate_kbps: opts
                .bitrate_kbps
                .unwrap_or_else(|| default_bitrate(size, fps)),
        }
    }
}

#[cfg(feature = "share")]
/// "1920x1080@60, 12000 kbit/s": the tightest limits of all receivers.
fn receiver_limits(caps: &[&Capabilities]) -> String {
    let w = caps.iter().map(|c| c.max_width).min().unwrap_or(0);
    let h = caps.iter().map(|c| c.max_height).min().unwrap_or(0);
    let fps = caps
        .iter()
        .map(|c| c.max_fps)
        .filter(|f| f.num > 0 && f.den > 0)
        .reduce(ratio_min);
    let kbps = caps.iter().filter_map(|c| c.max_bitrate_kbps).min();
    format!(
        "{w}x{h}{}{}",
        fps.map(|f| format!("@{f}")).unwrap_or_default(),
        kbps.map(|k| format!(", {k} kbit/s")).unwrap_or_default()
    )
}

#[cfg(feature = "share")]
fn share(opts: ShareOptions, ctx: &Ctx, ask: &RemoteApprover) -> Result<()> {
    let rejoin = Rejoin::system(opts.reconnect, ctx);
    let connect =
        |t: &Target, o: &CastOptions, m: &crate::airplay::MirrorOptions| connect_one(t, o, m, ctx);
    let yes = opts.yes;
    share_rejoin(
        opts,
        &connect,
        ctx,
        &|_| Ok(Box::new(())),
        Some(&rejoin),
        ShareKind::Page,
        &|cap, cancel| yes || ask(&describe_remote(cap), cancel),
    )
}

#[cfg(feature = "share")]
/// `capture`: what the page shares.
fn capture_event(cap: &crate::browser::protocol::CaptureInfo, events: &Events) {
    events.emit(Event::Capture(CaptureEvent {
        surface: cap.surface.clone(),
        label: cap.label.clone(),
        width: cap.width,
        height: cap.height,
        audio: cap.audio,
    }));
}

#[cfg(feature = "share")]
/// What feeds a share: the user's page (`share`) or tvpipe's browser
/// capturing the screen (`screen`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ShareKind {
    Page,
    Screen,
}

#[cfg(feature = "share")]
/// Starts the page source once the share server listens; the guard
/// stops it when dropped (a fake page in the tests, tvpipe's browser
/// for `screen`).
type ShareSource<'a> = &'a dyn Fn(&ShareServer) -> Result<Box<dyn std::any::Any>>;

#[cfg(feature = "share")]
/// Decides whether a capture from over the tunnel may reach the
/// receivers; the second argument says the question is moot (the page
/// left, or tvpipe stops).
pub type Approver<'a> = &'a dyn Fn(&CaptureInfo, &dyn Fn() -> bool) -> bool;

/// The program's answer to a share from over the tunnel, given its
/// description ("203.0.113.9 (Chrome on macOS) wants to share a window");
/// the second argument says the question is moot. The CLI asks on the
/// terminal.
pub type RemoteApprover = dyn Fn(&str, &dyn Fn() -> bool) -> bool + Send + Sync;

#[cfg(feature = "share")]
/// Text from a remote page for the terminal: no control characters (no
/// escape sequences), at most `max` characters.
fn printable(s: &str, max: usize) -> String {
    let mut out: String = s
        .chars()
        .map(|c| if c.is_control() { '?' } else { c })
        .take(max)
        .collect();
    if s.chars().count() > max {
        out.push('…');
    }
    out
}

#[cfg(feature = "share")]
/// The address of `ipv4:port`, `[ipv6]:port` or a bare address.
fn peer_host(peer: &str) -> &str {
    if let Some(v6) = peer.strip_prefix('[') {
        return v6.split(']').next().unwrap_or(v6);
    }
    match peer.split_once(':') {
        Some((h, p)) if !p.contains(':') => h,
        _ => peer,
    }
}

#[cfg(feature = "share")]
/// "203.0.113.9 (Chrome 157 on macOS) wants to share a window 1280x720".
fn describe_remote(cap: &CaptureInfo) -> String {
    let remote = cap.remote.as_ref();
    let peer = remote
        .and_then(|r| r.peer.as_deref())
        .map(peer_host)
        .filter(|p| !p.is_empty())
        .unwrap_or("someone (address unknown)");
    let agent = remote
        .map(|r| crate::browser::agent::describe(&r.agent))
        .filter(|a| !a.is_empty())
        .map(|a| format!(" ({a})"))
        .unwrap_or_default();
    let text = format!(
        "{peer}{agent} wants to share {} {}x{}{}{}",
        cap.surface.as_deref().unwrap_or("a surface"),
        cap.width,
        cap.height,
        cap.label
            .as_deref()
            .filter(|l| !l.is_empty())
            .map(|l| format!(" \"{}\"", printable(l, 60)))
            .unwrap_or_default(),
        if cap.audio { " with sound" } else { "" }
    );
    // All of it comes from the remote page (but the address).
    printable(&text, 300)
}

#[cfg(feature = "share")]
/// `share` with the connector and stop request given, and a hook that
/// sees the server once it listens (the tests start a fake page there).
///
/// The page comes first: once it captured something, its size decides
/// the offer; then the receivers connect, the plan goes to the page and
/// its stream runs through `stream` like an encoded-SLRW game's.
fn share_with(
    opts: ShareOptions,
    connect: Connector<'_>,
    ctx: &Ctx,
    on_listening: &dyn Fn(&ShareServer),
) -> Result<()> {
    let yes = opts.yes;
    let source = |server: &ShareServer| -> Result<Box<dyn std::any::Any>> {
        on_listening(server);
        Ok(Box::new(()))
    };
    share_rejoin(
        opts,
        connect,
        ctx,
        &source,
        None,
        ShareKind::Page,
        &|_, _| yes,
    )
}

#[cfg(feature = "share")]
/// `share_with` with the reconnect hooks and the source.
fn share_rejoin(
    opts: ShareOptions,
    connect: Connector<'_>,
    ctx: &Ctx,
    source: ShareSource<'_>,
    rejoin: Option<&Rejoin>,
    kind: ShareKind,
    approve: Approver<'_>,
) -> Result<()> {
    crate::util::timer::raise_resolution();
    let stop = &ctx.stop;
    let mut server = ShareServer::bind(0)?;
    if kind == ShareKind::Page {
        info!(
            "open {} in a browser and choose what to share (Ctrl-C to stop)",
            server.url()
        );
        ctx.events.emit(Event::SharePage(SharePageEvent {
            url: server.url().to_owned(),
        }));
        if opts.open {
            if let Err(e) = crate::browser::platform::open_url(server.url()) {
                warn!("--open: {e}");
            }
        }
    }
    if let (Some(provider), ShareKind::Page) = (opts.tunnel, kind) {
        info!("share: starting a public tunnel");
        ctx.events.progress(Progress::Begin(Step::Tunnel));
        let url = server
            .expose(provider, opts.tunnel_ttl, &|| stop.requested())
            .inspect_err(|e| {
                ctx.events
                    .progress(Progress::Failed(Step::Tunnel, e.to_string()))
            })?;
        info!(
            "share: someone with {url} can ask to share their screen to the receivers \
             (the link is new every run{}; you confirm each share here{})",
            opts.tunnel_ttl
                .map(|d| format!(" and lets people in for {} min", d.as_secs() / 60))
                .unwrap_or_default(),
            if opts.yes { ", unless --yes" } else { "" }
        );
        ctx.events.emit(Event::Tunnel(events::TunnelEvent {
            page: events::TunnelPage::Share,
            name: None,
            provider: provider.name().to_owned(),
            url: url.clone(),
        }));
    }
    let fail = |server: &mut ShareServer, e: Error| {
        server.set_end_reason(&e.to_string());
        e
    };
    // Stopped (a browser quits) when this function returns.
    let _source = source(&server).map_err(|e| fail(&mut server, e))?;
    let mut targets =
        resolve_all(&opts.to, rejoin, &ctx.events).map_err(|e| fail(&mut server, e))?;
    let names: Vec<String> = targets.iter().map(|t| target_name(t).to_owned()).collect();
    // One PCM stream for both families: 44.1 kHz when AirPlay listens.
    let pcm =
        RawAudioSpec::session_pcm(targets.iter().any(|t| matches!(t, Target::AirPlay { .. })));
    let fps = opts.fps.unwrap_or(SHARE_FPS);
    server.configure(&PageConfig {
        fps: fps.as_f64(),
        audio: !opts.no_audio,
        sample_rate: pcm.sample_rate,
        channels: pcm.channels,
        receivers: names.clone(),
    });
    server.set_status("waiting", "Press Share and pick what to show.", &names);
    ctx.events.progress(Progress::Begin(Step::Capture));
    // A capture over the tunnel waits for the local user's yes.
    let cap = loop {
        let Some(cap) = server.wait_capture(stop) else {
            return match server.failure() {
                Some(e) => Err(e),
                None => Ok(()),
            };
        };
        if cap.remote.is_none() {
            break cap;
        }
        info!("share: {}", describe_remote(&cap));
        server.set_status("connecting", "Waiting for the host to accept…", &names);
        let gone = || stop.requested() || !server.capture_pending();
        if approve(&cap, &gone) && server.capture_pending() {
            break cap;
        }
        if stop.requested() {
            return Ok(());
        }
        info!("share: not shown");
        server.decline("the host did not accept the share");
        server.set_status("waiting", "Press Share and pick what to show.", &names);
    };
    capture_event(&cap, &ctx.events);
    let audio = !opts.no_audio && cap.audio;
    if !opts.no_audio && !cap.audio {
        match kind {
            ShareKind::Page => info!(
                "share: the capture has no audio (Chrome/Edge: tick \"Also share tab audio\" \
                 in the picker; Safari and Firefox cannot share sound)"
            ),
            ShareKind::Screen => warn!(
                "screen: the browser captures no sound here (docs/screen.md: what each system \
                 allows); streaming the picture only"
            ),
        }
    }
    // Sizing: the stream is the capture's size (or --size), scaled down
    // only as far as the receivers' real limits require. The Cast offer
    // is therefore not the capture size but the most we would send
    // (--size/--fps/--bitrate or 1920x1080@60), and the ANSWER's
    // constraints narrow it; AirPlay's limit is the canvas from SETUP.
    // `plan` then fits the capture's aspect into the tightest of them.
    let offer = ShareOffer::new(&opts);
    let fps = opts.fps.unwrap_or(SHARE_FPS);
    // Over the internet the page's records arrive with jitter: a remote
    // share gets at least REMOTE_SHARE_LATENCY_MS (docs/tunnels.md).
    let latency = match (cap.remote.is_some(), opts.latency_ms) {
        (true, l) if l.is_none_or(|l| l < REMOTE_SHARE_LATENCY_MS) => {
            info!("share: remote share: latency {REMOTE_SHARE_LATENCY_MS} ms");
            Some(REMOTE_SHARE_LATENCY_MS)
        }
        (_, l) => l,
    };
    let budget = shared_budget(latency, &targets);
    let d = Desired {
        size: opts.size.unwrap_or(Size {
            width: cap.width.max(2),
            height: cap.height.max(2),
        }),
        fps,
        // Without --bitrate: chosen from the planned size, below.
        bitrate_kbps: opts.bitrate_kbps.unwrap_or(offer.bitrate_kbps),
        latency_ms: budget.session_ms,
    };
    let mut cast_opts = share_cast_options(&d, &offer, audio, &pcm);
    cast_opts.latency_ms = budget.cast_ms;
    configure_browsers(
        &mut targets,
        &player_options(&opts),
        budget.browser_ms,
        audio,
        &ctx.storage,
    );
    let mirror = crate::airplay::MirrorOptions {
        latency_ms: budget.airplay_ms,
        audio,
        ..Default::default()
    };
    server.set_status("connecting", "", &names);
    let sinks = connect_all(&targets, connect, &cast_opts, &mirror, rejoin, &ctx.events)
        .map_err(|e| fail(&mut server, e))?;
    if stop.requested() {
        stop_all(sinks);
        return Ok(());
    }
    let names: Vec<String> = sinks.iter().map(|s| s.name().to_owned()).collect();
    let caps: Vec<&Capabilities> = sinks.iter().map(|s| s.capabilities()).collect();
    let named: Vec<(&str, &Capabilities)> =
        sinks.iter().map(|s| (s.name(), s.capabilities())).collect();
    let limits = receiver_limits(&caps);
    // The receivers' screen shape: the stream has it, the capture is
    // centered inside (bars), since receivers stretch to fill. Browser
    // players alone take any shape: the capture's own (no bars).
    let (screen, max) = screen_shape(&caps);
    let aspect = screen
        .or_else(|| crate::types::aspect_of(cap.width, cap.height))
        .unwrap_or(layout::DEFAULT_ASPECT);
    let d = Desired {
        size: opts.size.unwrap_or_else(|| {
            let (width, height) = layout::output_size((cap.width, cap.height), aspect, max);
            Size { width, height }
        }),
        ..d
    };
    let planned = share_plan(&d, &caps, opts.bitrate_kbps.is_some());
    let (families, warnings) = if audio {
        input::encoded_audio_families(Some(&pcm), &named)
    } else {
        (Vec::new(), Vec::new())
    };
    drop((caps, named));
    let plan = match planned {
        Ok(p) => p,
        Err(e) => {
            stop_all(sinks);
            return Err(fail(&mut server, e));
        }
    };
    for w in warnings {
        warn!("{w}");
    }
    let page_audio = (!families.is_empty()).then_some((pcm.sample_rate, pcm.channels));
    let content = layout::place(
        (cap.width, cap.height),
        (plan.video.width, plan.video.height),
    );
    info!(
        "share: capture {}x{}, receivers allow {limits}, {}; the capture fills {}x{} at +{}+{}",
        cap.width,
        cap.height,
        screen_label(screen),
        content.width,
        content.height,
        content.x,
        content.y
    );
    info!(
        "plan: {}x{}@{} {} kbit/s, keyframe every {} frames, {}, latency {} ms (encoded by the browser)",
        plan.video.width,
        plan.video.height,
        plan.video.fps,
        plan.video.bitrate_kbps,
        plan.video.gop,
        match page_audio {
            Some((rate, ch)) => format!("PCM {rate} Hz {ch} ch"),
            None => "no audio".into(),
        },
        plan.latency_ms
    );
    server.set_status("streaming", "", &names);
    let share_plan = SharePlan {
        width: plan.video.width,
        height: plan.video.height,
        fps: plan.video.fps.as_f64(),
        bitrate_bps: plan.video.bitrate_kbps as u64 * 1000,
        key_interval: plan.video.gop,
        audio: page_audio,
        content,
    };
    let opened = server.start(
        &share_plan,
        ShareInputOptions {
            fps: plan.video.fps,
            audio: page_audio.map(|_| pcm.clone()),
            audio_families: families,
        },
        stop.clone(),
    );
    let input = match opened {
        Ok(i) => i,
        Err(e) => {
            stop_all(sinks);
            if stop.requested() {
                info!("stopped");
                return Ok(());
            }
            return Err(e);
        }
    };
    match stream(
        Box::new(input),
        events::Route::Browser,
        plan.latency_ms,
        sinks,
        ctx,
    ) {
        Ok(EndReason::Interrupted) => {
            info!("stopped");
            Ok(())
        }
        Ok(_) => Ok(()),
        Err(e) => Err(e),
    }
}

#[cfg(feature = "share")]
/// The Cast offer of a page-encoded stream (`share`, `share URL`): the
/// upper bounds of `offer`, AAC from the page's PCM.
fn share_cast_options(
    d: &Desired,
    offer: &ShareOffer,
    audio: bool,
    pcm: &RawAudioSpec,
) -> CastOptions {
    let mut cast_opts = cast_options(d, audio);
    cast_opts.max_width = offer.size.width;
    cast_opts.max_height = offer.size.height;
    cast_opts.max_fps = offer.fps;
    cast_opts.max_bitrate_kbps = offer.bitrate_kbps;
    if let Some(f) = input::encoded_cast_audio(Some(pcm)).filter(|_| audio) {
        cast_opts.audio_codecs = vec![AudioCodec::AacLc];
        cast_opts.audio_sample_rate = f.sample_rate;
        cast_opts.audio_channels = f.channels;
    }
    cast_opts
}

#[cfg(feature = "share")]
/// The stream's shape (the receivers' screens, which stretch what they
/// get; a warning when they differ; `None` when no receiver has a screen
/// shape, only browser players) and the tightest size limit.
fn screen_shape(caps: &[&Capabilities]) -> (Option<(u32, u32)>, (u32, u32)) {
    let aspects: Vec<Option<(u32, u32)>> = caps.iter().map(|c| c.display_aspect).collect();
    let aspect = layout::output_aspect(&aspects);
    let mut shapes: Vec<(u32, u32)> = aspects.iter().flatten().copied().collect();
    shapes.sort_unstable();
    shapes.dedup();
    if let (Some(aspect), true) = (aspect, shapes.len() > 1) {
        warn!(
            "share: the receivers' screens differ in shape ({}); streaming {}:{}, the others stretch it",
            shapes
                .iter()
                .map(|(w, h)| format!("{w}:{h}"))
                .collect::<Vec<_>>()
                .join(", "),
            aspect.0,
            aspect.1
        );
    }
    let max = (
        caps.iter().map(|c| c.max_width).min().unwrap_or(0),
        caps.iter().map(|c| c.max_height).min().unwrap_or(0),
    );
    (aspect, max)
}

#[cfg(feature = "share")]
/// The `--to browser` player's options of `share` (`--open` opens it
/// too).
fn player_options(opts: &ShareOptions) -> BrowserOptions {
    BrowserOptions {
        open: opts.open,
        ..opts.player.clone()
    }
}

#[cfg(feature = "share")]
/// "screen 16:9", or "any shape" without screens.
fn screen_label(screen: Option<(u32, u32)>) -> String {
    match screen {
        Some((w, h)) => format!("screen {w}:{h}"),
        None => "any shape".into(),
    }
}

#[cfg(feature = "share")]
/// The encode plan of a page-encoded stream: without `--bitrate`, the
/// default for the planned size (not the offer's).
fn share_plan(d: &Desired, caps: &[&Capabilities], bitrate_given: bool) -> Result<EncodePlan> {
    // plan() already fits the receivers' pixel rate.
    plan(d, Encoder::Auto, caps, false).map(|mut p| {
        if !bitrate_given {
            let size = Size {
                width: p.video.width,
                height: p.video.height,
            };
            p.video.bitrate_kbps = p.video.bitrate_kbps.min(default_bitrate(size, p.video.fps));
        }
        p
    })
}

/// `size` at `fps` made small enough (same shape, even sides) that its
/// pixel rate is at most `max` (a Cast receiver's `maxPixelsPerSecond`).
/// The frame rate stays: the encoder lowers the size instead.
fn fit_pixel_rate(size: Size, fps: Ratio, max: Option<u64>) -> Size {
    let Some(max) = max.filter(|&m| m > 0) else {
        return size;
    };
    let rate = size.width as f64 * size.height as f64 * fps.as_f64().max(1.0);
    if rate <= max as f64 {
        return size;
    }
    let k = (max as f64 / rate).sqrt();
    let w = ((size.width as f64 * k).floor() as u32).max(2);
    let h = ((size.height as f64 * k).floor() as u32).max(2);
    // The same shape, even sides.
    fit(size.width, size.height, w, h)
}

/// `--latency` bounds (AirPlay accepts 5–2000 ms, Cast 1–5000 ms; the
/// intersection keeps one budget valid for both).
const MIN_LATENCY_MS: u32 = 5;
const MAX_LATENCY_MS: u32 = 2000;

/// The playout budget each family is set up with (ARCHITECTURE.md).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Budget {
    /// Cast target delay (audio and video).
    cast_ms: u32,
    /// AirPlay leads: `Some(L)` = video and audio lead L; `None` = the
    /// automatic profile ("wireless": video 100 ms, audio 170 ms).
    airplay_ms: Option<u32>,
    /// Browser tabs' playout delay (`--to browser`).
    browser_ms: u32,
    /// The session's own delay, the same rule for `play`, `debug pattern`,
    /// `preview` and `share` (with or without URL): what the plan says
    /// and how long the tail plays out at the end. `--latency`, else the
    /// browsers' when only browsers watch, else [`DEFAULT_LATENCY_MS`].
    session_ms: u32,
}

/// The playout delay of a browser alone (`preview`): nothing between
/// tvpipe and the tab but loopback, so it only has to absorb the input's
/// burstiness and decoding.
pub const BROWSER_LATENCY_MS: u32 = 100;

/// One budget for every receiver (ARCHITECTURE.md, "Timing and Latency"):
/// `--latency L` is the delay from the shared capture instant to presentation on all of them.
/// Without it, Cast uses [`DEFAULT_LATENCY_MS`] and AirPlay-only sessions
/// keep the automatic profile; a session with both families gives
/// AirPlay [`DEFAULT_LATENCY_MS`] as well, so the screens show a frame at
/// the same time instead of 100 ms apart.
fn shared_budget(user: Option<u32>, targets: &[Target]) -> Budget {
    let cast = targets.iter().any(|t| matches!(t, Target::Cast { .. }));
    let airplay = targets.iter().any(|t| matches!(t, Target::AirPlay { .. }));
    let b = match user {
        Some(l) => {
            let c = l.clamp(MIN_LATENCY_MS, MAX_LATENCY_MS);
            if c != l {
                warn!("--latency {l} ms is out of range; using {c} ms");
            }
            Budget {
                cast_ms: c,
                airplay_ms: Some(c),
                browser_ms: c,
                session_ms: c,
            }
        }
        None if cast && airplay => Budget {
            cast_ms: DEFAULT_LATENCY_MS,
            airplay_ms: Some(DEFAULT_LATENCY_MS),
            browser_ms: DEFAULT_LATENCY_MS,
            session_ms: DEFAULT_LATENCY_MS,
        },
        // Browsers show frames when the TVs do: Cast's delay, or the
        // AirPlay automatic profile's video lead (which is the browser's
        // own default as well).
        None => Budget {
            cast_ms: DEFAULT_LATENCY_MS,
            airplay_ms: None,
            browser_ms: if cast {
                DEFAULT_LATENCY_MS
            } else {
                BROWSER_LATENCY_MS
            },
            session_ms: if !targets.is_empty() && !cast && !airplay {
                BROWSER_LATENCY_MS
            } else {
                DEFAULT_LATENCY_MS
            },
        },
    };
    if targets.len() > 1 {
        let ms = |v: u32| format!("{v} ms");
        let browser = targets.iter().any(|t| matches!(t, Target::Browser(_)));
        let auto = "AirPlay automatic (video 100 ms, audio 170 ms)";
        info!(
            "{} receivers on one timeline; playout budget {}",
            targets.len(),
            match (cast, airplay, b.airplay_ms) {
                (_, true, None) if browser => format!("{auto}, browser {}", ms(b.browser_ms)),
                (_, true, None) => auto.to_owned(),
                (_, true, Some(a)) => ms(a),
                (true, _, _) => ms(b.cast_ms),
                _ => ms(b.browser_ms),
            }
        );
    }
    b
}

/// The playout delay shared by all sinks: `--latency` or the default,
/// raised to every receiver's minimum.
fn latency(d: &Desired, caps: &[&Capabilities]) -> u32 {
    caps.iter()
        .filter_map(|c| c.min_latency_ms)
        .fold(d.latency_ms, u32::max)
}

#[cfg(feature = "ffmpeg")]
/// Raw SLRW for ffmpeg: the bound listeners and the game's stream.
type RawFeed = (rawin::RawInput, Box<dyn std::io::Read + Send>);

#[cfg(feature = "ffmpeg")]
/// The ffmpeg input for `opts`.
fn ffmpeg_source(
    opts: &PlayOptions,
    input: &InputInfo,
    stdin: Box<dyn std::io::Read + Send>,
) -> Result<(Source, Option<RawFeed>)> {
    Ok(match &opts.input {
        InputSpec::Path(p) => (
            Source::Url {
                url: p.clone(),
                realtime: opts
                    .realtime
                    .unwrap_or(input.duration.is_some() || Path::new(p).is_file()),
                looped: opts.looped,
            },
            None,
        ),
        InputSpec::FfmpegArgs(a) => (Source::Args(a.clone()), None),
        InputSpec::TestPattern => (Source::TestPattern { clock: true }, None),
        InputSpec::Stdin => {
            let r = rawin::RawInput::bind(opts.raw_video.as_ref(), opts.raw_audio.as_ref())?;
            let s = r.source();
            (s, Some((r, stdin)))
        }
    })
}

/// Steps 4 and 5: input → fanout, then teardown. Consumes the sinks; they
/// are stopped on every path.
fn stream(
    mut input: Box<dyn Input>,
    route: events::Route,
    latency_ms: u32,
    sinks: Vec<Box<dyn Sink>>,
    ctx: &Ctx,
) -> Result<EndReason> {
    let stop = &ctx.stop;
    let info = input.info().clone();
    let v = &info.video;
    debug!(
        "{}: {:?} {}x{}@{}{}",
        input.describe(),
        v.codec,
        v.width,
        v.height,
        v.fps,
        info.audio
            .iter()
            .map(|(_, a)| format!(
                ", audio {}",
                audio_label(a.codec, a.sample_rate, a.channels)
            ))
            .collect::<String>()
    );
    // On failure the sinks are dropped, which stops them.
    let config = FanoutConfig {
        events: ctx.events.clone(),
        ..FanoutConfig::default()
    };
    let fanout = match Fanout::new(sinks, &info, config) {
        Ok(f) => f,
        Err(e) => {
            let _ = input.finish(false);
            return Err(e);
        }
    };

    // Pull the first frame only once every sink is set up: live inputs
    // (the built-in encoder, games) start their clock with it, so nothing
    // piles up in the queues of sinks still in start().
    let ready = Instant::now();
    if !fanout.wait_started(SINK_START_WAIT, stop) && !stop.requested() {
        warn!("a receiver is slow to start; streaming anyway");
    }
    debug!("sinks started in {} ms", ready.elapsed().as_millis());
    ctx.events
        .emit(Event::Started(started_event(route, &info, latency_ms)));
    let t0 = Instant::now();
    let mut frames = [0u64; 2];
    let mut video_bytes = 0u64;
    let mut input_error = None;
    let mut next_stats = t0 + STATS_INTERVAL;
    let end = loop {
        if stop.requested() {
            break EndReason::Interrupted;
        }
        if ctx.events.active() && Instant::now() >= next_stats {
            next_stats += STATS_INTERVAL;
            ctx.events.emit(Event::Stats(stats_event(
                t0.elapsed(),
                frames,
                video_bytes,
                &fanout.stats(),
            )));
        }
        match input.next_frame() {
            Ok(Some(f)) => {
                frames[(f.track != TrackKind::Video) as usize] += 1;
                if f.track == TrackKind::Video {
                    video_bytes += f.data.len() as u64;
                }
                fanout.push(&f);
                if fanout.keyframe_wanted() {
                    input.request_keyframe();
                }
                if fanout.active() == 0 {
                    debug!("every receiver ended the session");
                    break EndReason::ReceiversGone;
                }
            }
            Ok(None) if stop.requested() => break EndReason::Interrupted,
            Ok(None) => break EndReason::Eof,
            Err(e) if stop.requested() => {
                debug!("input after stop request: {e}");
                break EndReason::Interrupted;
            }
            Err(e) => {
                input_error = Some(e);
                break EndReason::Eof;
            }
        }
    };
    let elapsed = t0.elapsed();
    let clean_eof = end == EndReason::Eof && input_error.is_none();
    if clean_eof {
        // Let the last frames play out before STOP.
        std::thread::sleep(Duration::from_millis(latency_ms as u64 + 100));
    }
    let stats = fanout.stats();
    let ends = fanout.close(end == EndReason::Eof);
    // ffmpeg: on a clean EOF it has exited (its status counts); otherwise
    // it is killed.
    let input_result = input.finish(clean_eof);

    info!(
        "sent {} video and {} audio frames in {:.1} s",
        frames[0],
        frames[1],
        elapsed.as_secs_f64()
    );
    let mut failed = 0;
    for ((name, end), (_, st)) in ends.iter().zip(&stats) {
        let how = match end {
            SinkEnd::Stopped => "stopped".to_owned(),
            SinkEnd::Finished => "ended by the receiver".to_owned(),
            SinkEnd::Failed(e) => {
                failed += 1;
                format!("failed: {e}")
            }
        };
        info!(
            "{name}: {how}; {} frames pushed, {} dropped by the sink, {} on a full queue, \
             {} waiting for a keyframe",
            st.pushed, st.sink_dropped, st.dropped_full, st.dropped_waiting
        );
    }
    ctx.events.emit(Event::End(end_event(
        end,
        input_error.as_ref(),
        &ends,
        &stats,
    )));
    if let Some(e) = input_error {
        return Err(e);
    }
    input_result?;
    if failed > 0 && failed == ends.len() {
        let msg = ends.into_iter().find_map(|(name, e)| match e {
            SinkEnd::Failed(e) => Some(format!("{name}: {e}")),
            _ => None,
        });
        return Err(Error::protocol(
            msg.unwrap_or_else(|| "every receiver failed".into()),
        ));
    }
    Ok(end)
}

/// How often `stats` events go out (`--machine`).
const STATS_INTERVAL: Duration = Duration::from_secs(1);

/// The `started` event.
fn started_event(
    route: events::Route,
    info: &crate::types::StreamInfo,
    latency_ms: u32,
) -> Started {
    let v = &info.video;
    Started {
        route,
        video: VideoStarted {
            codec: match v.codec {
                VideoCodec::H264 => "h264",
                VideoCodec::Hevc => "hevc",
            }
            .to_owned(),
            width: v.width,
            height: v.height,
            fps: v.fps.as_f64(),
        },
        audio: info
            .audio
            .iter()
            .map(|(_, a)| AudioStarted {
                codec: match a.codec {
                    AudioCodec::Alac => "alac",
                    AudioCodec::AacLc => "aac-lc",
                    AudioCodec::AacEld => "aac-eld",
                    AudioCodec::Opus => "opus",
                    AudioCodec::PcmS16le => "pcm-s16le",
                }
                .to_owned(),
                sample_rate: a.sample_rate,
                channels: a.channels,
            })
            .collect(),
        latency_ms,
    }
}

fn receiver_stats(name: &str, st: &crate::media::fanout::SinkStats) -> ReceiverStats {
    ReceiverStats {
        name: name.to_owned(),
        pushed: st.pushed,
        dropped: st.sink_dropped,
        dropped_full: st.dropped_full,
        dropped_waiting: st.dropped_waiting,
    }
}

/// The `stats` event.
fn stats_event(
    elapsed: Duration,
    frames: [u64; 2],
    video_bytes: u64,
    stats: &[(String, crate::media::fanout::SinkStats)],
) -> Stats {
    Stats {
        elapsed_ms: elapsed.as_millis() as u64,
        video_frames: frames[0],
        audio_frames: frames[1],
        receivers: stats.iter().map(|(n, st)| receiver_stats(n, st)).collect(),
        video_bytes,
    }
}

/// The `end` event of a session.
fn end_event(
    end: EndReason,
    input_error: Option<&Error>,
    ends: &[(String, SinkEnd)],
    stats: &[(String, crate::media::fanout::SinkStats)],
) -> EndInfo {
    let reason = match end {
        _ if input_error.is_some() => events::EndReason::Error,
        EndReason::Eof => events::EndReason::Eof,
        EndReason::Interrupted => events::EndReason::Stopped,
        EndReason::ReceiversGone => events::EndReason::ReceiversGone,
    };
    let receivers = ends
        .iter()
        .zip(stats)
        .map(|((name, how), (_, st))| {
            let (end, error) = match how {
                SinkEnd::Stopped => (ReceiverEnd::Stopped, None),
                SinkEnd::Finished => (ReceiverEnd::Ended, None),
                SinkEnd::Failed(e) => (ReceiverEnd::Failed, Some(e.to_string())),
            };
            ReceiverEndInfo {
                stats: receiver_stats(name, st),
                end,
                error,
            }
        })
        .collect();
    EndInfo {
        reason,
        receivers: Some(receivers),
    }
}

#[cfg(feature = "headless")]
mod browse;
mod rejoin;
#[cfg(feature = "headless")]
mod screen;

use rejoin::Rejoin;

#[cfg(all(
    test,
    feature = "airplay",
    feature = "cast",
    feature = "player",
    feature = "h264",
    feature = "share",
    feature = "headless",
    feature = "files",
    feature = "ffmpeg"
))]
mod browse_tests;

#[cfg(all(
    test,
    feature = "airplay",
    feature = "cast",
    feature = "player",
    feature = "h264",
    feature = "share",
    feature = "headless",
    feature = "files",
    feature = "ffmpeg"
))]
mod multi_tests;

#[cfg(all(
    test,
    feature = "airplay",
    feature = "cast",
    feature = "player",
    feature = "h264",
    feature = "share",
    feature = "headless",
    feature = "files",
    feature = "ffmpeg"
))]
mod rejoin_tests;

#[cfg(all(
    test,
    feature = "airplay",
    feature = "cast",
    feature = "player",
    feature = "h264",
    feature = "share",
    feature = "headless",
    feature = "files",
    feature = "ffmpeg"
))]
mod share_tests;

#[cfg(all(
    test,
    feature = "airplay",
    feature = "cast",
    feature = "player",
    feature = "h264",
    feature = "share",
    feature = "headless",
    feature = "files",
    feature = "ffmpeg"
))]
mod screen_tests;

#[cfg(all(
    test,
    feature = "airplay",
    feature = "cast",
    feature = "player",
    feature = "h264",
    feature = "share",
    feature = "headless",
    feature = "files",
    feature = "ffmpeg"
))]
mod browser_tests;

#[cfg(all(
    test,
    feature = "airplay",
    feature = "cast",
    feature = "player",
    feature = "h264",
    feature = "share",
    feature = "headless",
    feature = "files",
    feature = "ffmpeg"
))]
mod player_tests;

#[cfg(all(
    test,
    feature = "airplay",
    feature = "cast",
    feature = "player",
    feature = "h264",
    feature = "share",
    feature = "headless",
    feature = "files",
    feature = "ffmpeg"
))]
mod tests {
    use super::*;
    use crate::media::builtin;

    #[test]
    fn remote_shares_are_described() {
        assert_eq!(peer_host("203.0.113.9:4000"), "203.0.113.9");
        assert_eq!(peer_host("203.0.113.9"), "203.0.113.9");
        assert_eq!(peer_host("[2001:db8::1]:443"), "2001:db8::1");
        assert_eq!(peer_host("2001:db8::1"), "2001:db8::1");
        let cap = CaptureInfo {
            width: 1280,
            height: 720,
            fps: None,
            audio: true,
            surface: Some("window".into()),
            label: Some("Slides".into()),
            remote: Some(crate::browser::protocol::Remote {
                peer: Some("203.0.113.9:4000".into()),
                agent: "Mozilla/5.0 Chrome/131.0.0.0 Safari/537.36".into(),
            }),
        };
        assert_eq!(
            describe_remote(&cap),
            "203.0.113.9 (Chrome 131) wants to share window 1280x720 \"Slides\" with sound"
        );
        let cap = CaptureInfo {
            remote: Some(crate::browser::protocol::Remote {
                peer: None,
                agent: String::new(),
            }),
            label: None,
            audio: false,
            ..cap
        };
        assert_eq!(
            describe_remote(&cap),
            "someone (address unknown) wants to share window 1280x720"
        );
        // The page cannot write escape sequences to the terminal.
        let cap = CaptureInfo {
            surface: Some("tab\x1b[2J".into()),
            label: Some(format!("a\u{7}b{}", "x".repeat(100))),
            ..cap
        };
        let d = describe_remote(&cap);
        assert!(!d.chars().any(char::is_control), "{d:?}");
        assert!(
            d.contains("tab?[2J") && d.contains("\"a?bxxx") && d.contains("x…\""),
            "{d}"
        );
    }
    use crate::media::ffmpeg::Output;

    fn caps(w: u32, h: u32, fps: u32, kbps: u32) -> Capabilities {
        Capabilities {
            max_width: w,
            max_height: h,
            max_fps: Ratio::integer(fps),
            video_codecs: vec![VideoCodec::H264],
            audio_formats: vec![AudioFormat {
                codec: AudioCodec::Opus,
                sample_rate: 48_000,
                channels: 2,
            }],
            audio_family: AudioFamily::Cast,
            max_bitrate_kbps: Some(kbps),
            max_pixels_per_second: None,
            min_latency_ms: None,
            preferred_latency_ms: Some(200),
            max_key_interval_ms: None,
            display_aspect: None,
        }
    }

    #[test]
    fn targets() {
        let cast = |a: &str| Target::Cast {
            addr: a.parse().unwrap(),
            name: a.into(),
        };
        let t = |q: &str| {
            let (f, rest) = parse_target(q);
            address_target(f, rest)
        };
        assert_eq!(t("127.0.0.1"), Some(cast("127.0.0.1:8009")));
        assert_eq!(t("127.0.0.1:8010"), Some(cast("127.0.0.1:8010")));
        assert_eq!(t("CAST:10.0.0.5:7000"), Some(cast("10.0.0.5:7000")));
        assert_eq!(t("[::1]"), Some(cast("[::1]:8009")));
        assert_eq!(t("[::1]:8010"), Some(cast("[::1]:8010")));
        let airplay = |a: &str| Target::AirPlay {
            name: a.into(),
            addr: a.parse().unwrap(),
            device: None,
        };
        assert_eq!(t("10.0.0.5:7000"), Some(airplay("10.0.0.5:7000")));
        assert_eq!(t("airplay:10.0.0.5"), Some(airplay("10.0.0.5:7000")));
        assert_eq!(t("Living Room"), None);
        assert_eq!(t("cast:Living Room"), None);
        assert_eq!(parse_target("cast:"), (None, "cast:"));
        assert_eq!(
            parse_target("John’s MacBook Pro"),
            (None, "John’s MacBook Pro")
        );
        assert_eq!(parse_target("Ariplay’s"), (None, "Ariplay’s"));
        assert_eq!(t("John’s MacBook Pro"), None);
    }

    #[test]
    fn target_delays() {
        let cast = Target::Cast {
            addr: "10.0.0.5:8009".parse().unwrap(),
            name: "Den".into(),
        };
        let airplay = Target::AirPlay {
            name: "Kitchen".into(),
            addr: "10.0.0.6:7000".parse().unwrap(),
            device: None,
        };
        let browser = Target::Browser(Box::new(PlayerOptions {
            latency_ms: 140,
            ..PlayerOptions::default()
        }));
        let opts = CastOptions {
            latency_ms: 300,
            ..CastOptions::default()
        };
        let auto = crate::airplay::MirrorOptions::default();
        assert_eq!(target_delay_ms(&cast, &opts, &auto), 300);
        // The automatic ("wireless") profile's video lead.
        assert_eq!(target_delay_ms(&airplay, &opts, &auto), 100);
        let given = crate::airplay::MirrorOptions {
            latency_ms: Some(250),
            ..crate::airplay::MirrorOptions::default()
        };
        assert_eq!(target_delay_ms(&airplay, &opts, &given), 250);
        assert_eq!(target_delay_ms(&browser, &opts, &auto), 140);
        let tv = ArrivalSink {
            caps: Capabilities {
                preferred_latency_ms: Some(600),
                ..caps(1920, 1080, 30, 8000)
            },
            arrivals: Default::default(),
            left: 0,
        };
        assert_eq!(connected_delay_ms(&airplay, &tv, &opts, &auto), 600);
        assert_eq!(connected_delay_ms(&cast, &tv, &opts, &auto), 300);
    }

    #[test]
    fn discovered_targets() {
        let devs = crate::net::device::tests::lan_devices();
        for d in &devs {
            let t = device_target(d, None);
            match (&d.cast, &d.airplay) {
                (Some(_), _) if d.cast_video() => {
                    assert!(matches!(t, Ok(Target::Cast { .. })), "{}", d.name)
                }
                (_, Some(_)) => assert!(matches!(t, Ok(Target::AirPlay { .. })), "{}", d.name),
                _ => assert!(t.is_err(), "{}", d.name),
            }
        }
        let tv = devs.iter().find(|d| d.name == "Livingroom (2)").unwrap();
        assert!(device_target(tv, Some(Protocol::Cast)).is_err());
    }

    #[test]
    fn ffprobe_output() {
        let info = parse_ffprobe(
            "stream|codec_type=video|width=1920|height=1080|avg_frame_rate=30000/1001\n\
             stream|codec_type=audio|width=N/A|height=N/A|avg_frame_rate=0/0\n\
             format|duration=12.345000\n",
        );
        assert_eq!(info.width, Some(1920));
        assert_eq!(info.height, Some(1080));
        assert_eq!(info.fps, Some(Ratio::new(30000, 1001)));
        assert_eq!(info.has_audio, Some(true));
        assert_eq!(info.has_video, Some(true));
        assert_eq!(info.duration, Some(12.345));
        let live = parse_ffprobe("stream|codec_type=video|width=640|height=480|avg_frame_rate=0/0\nformat|duration=N/A\n");
        assert_eq!(live.has_audio, Some(false));
        assert_eq!(live.fps, None);
        assert_eq!(live.duration, None);
        // Garbage never panics and yields "nothing found".
        let junk = parse_ffprobe(
            "stream|codec_type=video|width=-1|height=x|avg_frame_rate=1/0\n|||\n=\nformat",
        );
        assert_eq!(junk.width, None);
        assert_eq!(junk.fps, None);
        assert_eq!(parse_ffprobe("").has_video, Some(false));
    }

    #[test]
    fn fitting() {
        let s = |width, height| Size { width, height };
        assert_eq!(fit(1280, 720, 1920, 1080), s(1280, 720));
        assert_eq!(fit(3840, 2160, 1920, 1080), s(1920, 1080));
        assert_eq!(fit(1920, 800, 1280, 720), s(1280, 532));
        assert_eq!(fit(1080, 1920, 1920, 1080), s(606, 1080));
        assert_eq!(fit(641, 481, 1920, 1080), s(640, 480));
        assert_eq!(fit(0, 0, 1920, 1080), s(2, 2));
    }

    #[test]
    fn pixel_rate_lowers_the_size() {
        let s = |w, h| Size {
            width: w,
            height: h,
        };
        let fps30 = Ratio::integer(30);
        let rate_1080 = Some(1920 * 1080 * 30);
        assert_eq!(
            fit_pixel_rate(s(3840, 2160), fps30, rate_1080),
            s(1920, 1080)
        );
        assert_eq!(
            fit_pixel_rate(s(1920, 1080), fps30, rate_1080),
            s(1920, 1080)
        );
        assert_eq!(fit_pixel_rate(s(3840, 2160), fps30, None), s(3840, 2160));
        assert_eq!(fit_pixel_rate(s(3840, 2160), fps30, Some(0)), s(3840, 2160));
        // 60 fps keeps its rate: the picture gets smaller.
        let small = fit_pixel_rate(s(1920, 1080), Ratio::integer(60), rate_1080);
        assert!(small.width < 1920 && small.width % 2 == 0, "{small:?}");
        assert!(small.width as u64 * small.height as u64 * 60 <= 1920 * 1080 * 30);
        assert_eq!(fit_pixel_rate(s(3840, 2160), fps30, Some(1)), s(2, 2));
    }

    pub(super) fn opts() -> PlayOptions {
        PlayOptions {
            threads: 0,
            to: vec!["tv".into()],
            reconnect: Duration::ZERO,
            browser: Default::default(),
            latency_ms: None,
            size: None,
            fps: None,
            bitrate_kbps: None,
            encoder: Encoder::Auto,
            no_audio: false,
            looped: false,
            realtime: None,
            raw_video: None,
            raw_audio: None,
            ffmpeg: None,
            input: InputSpec::TestPattern,
        }
    }

    #[test]
    fn desired_from_input_and_options() {
        let d = desired(&opts(), &InputInfo::default());
        assert_eq!((d.size.width, d.size.height), (1280, 720));
        assert_eq!(d.fps, Ratio::integer(30));
        assert_eq!(d.bitrate_kbps, 2764);
        assert_eq!(d.latency_ms, DEFAULT_LATENCY_MS);
        let input = InputInfo {
            width: Some(3840),
            height: Some(2160),
            fps: Some(Ratio::integer(120)),
            ..InputInfo::default()
        };
        let d = desired(&opts(), &input);
        assert_eq!((d.size.width, d.size.height), (1920, 1080));
        assert_eq!(d.fps, Ratio::integer(60));
        assert_eq!(d.bitrate_kbps, 12441);
        let o = PlayOptions {
            size: Some(Size {
                width: 640,
                height: 360,
            }),
            fps: Some(Ratio::integer(25)),
            bitrate_kbps: Some(1500),
            latency_ms: Some(120),
            ..opts()
        };
        let d = desired(&o, &input);
        assert_eq!(
            d,
            Desired {
                size: Size {
                    width: 640,
                    height: 360
                },
                fps: Ratio::integer(25),
                bitrate_kbps: 1500,
                latency_ms: 120
            }
        );
        let c = cast_options(&d, false);
        assert_eq!(
            (c.max_width, c.max_height, c.max_bitrate_kbps),
            (640, 360, 1500)
        );
        assert_eq!((c.latency_ms, c.audio), (120, false));
    }

    #[test]
    fn plan_intersects_capabilities() {
        let d = Desired {
            size: Size {
                width: 1920,
                height: 1080,
            },
            fps: Ratio::integer(60),
            bitrate_kbps: 8000,
            latency_ms: 150,
        };
        let a = caps(1920, 1080, 60, 10_000);
        let mut b = caps(1280, 720, 30, 4000);
        b.min_latency_ms = Some(250);
        let p = plan(&d, Encoder::Auto, &[&a, &b], true).unwrap();
        assert_eq!((p.video.width, p.video.height), (1280, 720));
        assert_eq!(p.video.fps, Ratio::integer(30));
        // A pixel rate (Cast's maxPixelsPerSecond) for every encoded
        // stream (play too): 1080p60 into 1080p30's rate keeps 60 fps and
        // gets smaller.
        let mut r = caps(1920, 1080, 60, 10_000);
        r.max_pixels_per_second = Some(1920 * 1080 * 30);
        let q = plan(&d, Encoder::Auto, &[&r], false).unwrap();
        assert_eq!(q.video.fps, Ratio::integer(60));
        assert!(
            q.video.width < 1920 && q.video.width % 2 == 0,
            "{}",
            q.video.width
        );
        assert!(
            q.video.width as u64 * q.video.height as u64 * 60 <= 1920 * 1080 * 30,
            "{}x{}",
            q.video.width,
            q.video.height
        );
        assert_eq!(p.video.gop, 30);
        // A receiver wanting IDRs every 0.5 s (AirPlay) halves it, also at
        // 25 fps (12.5 frames: 13); AirPlay's audio alone (the browser
        // player) does not.
        let mut half = caps(1920, 1080, 30, 10_000);
        half.max_key_interval_ms = Some(500);
        assert_eq!(
            plan(&d, Encoder::Auto, &[&a, &half], false)
                .unwrap()
                .video
                .gop,
            15
        );
        let mut pal = half.clone();
        pal.max_fps = Ratio::integer(25);
        assert_eq!(
            plan(&d, Encoder::Auto, &[&pal], false).unwrap().video.gop,
            13
        );
        let mut player = caps(1920, 1080, 30, 10_000);
        player.audio_family = AudioFamily::AirPlay;
        assert_eq!(
            plan(&d, Encoder::Auto, &[&player], false)
                .unwrap()
                .video
                .gop,
            30
        );
        assert_eq!(p.video.bitrate_kbps, 4000);
        assert_eq!(p.latency_ms, 250);
        assert_eq!(p.audio.len(), 1);
        assert_eq!(p.audio[0].codec, AudioCodec::Opus);
        assert_eq!(p.audio[0].frame_samples, 480);
        // No audio requested, or no common format: video only.
        assert!(plan(&d, Encoder::Auto, &[&a], false)
            .unwrap()
            .audio
            .is_empty());
        b.audio_formats[0].codec = AudioCodec::AacLc;
        assert!(plan(&d, Encoder::Auto, &[&a, &b], true)
            .unwrap()
            .audio
            .is_empty());
        let p = plan(&d, Encoder::Auto, &[&b], true).unwrap();
        assert_eq!(p.audio[0].frame_samples, 1024);
        // A receiver without H.264 is an error.
        b.video_codecs = vec![VideoCodec::Hevc];
        assert!(plan(&d, Encoder::Auto, &[&a, &b], true).is_err());
        assert!(plan(&d, Encoder::Auto, &[], true).is_err());
    }

    #[test]
    fn plan_builds_ffmpeg_args() {
        let d = desired(&opts(), &InputInfo::default());
        let c = caps(1920, 1080, 60, 10_000);
        let p = plan(&d, Encoder::Auto, &[&c], true).unwrap();
        let inv = ffmpeg::build(
            &Source::TestPattern { clock: false },
            Output::Encode(&p),
            &crate::media::ffmpeg::tests::probe(),
            "warning",
        )
        .unwrap();
        assert_eq!(inv.tracks.len(), 2);
        assert_eq!(inv.tracks[1].kind, TrackKind::Audio(AudioFamily::Cast));
    }

    /// Generates a short file with ffmpeg; `None` if ffmpeg is unusable.
    fn media_file(name: &str, audio: bool) -> Option<(std::path::PathBuf, std::path::PathBuf)> {
        let (bin, _) = crate::media::ffmpeg::tests::real_ffmpeg()?;
        let dir = std::env::temp_dir().join(format!("tvpipe-session-{}", std::process::id()));
        std::fs::create_dir_all(&dir).ok()?;
        let path = dir.join(name);
        let mut cmd = StdCommand::new(&bin);
        cmd.args(["-hide_banner", "-loglevel", "error", "-y"])
            .args([
                "-f",
                "lavfi",
                "-i",
                "testsrc2=size=320x240:rate=30:duration=1",
            ]);
        if audio {
            cmd.args(["-f", "lavfi", "-i", "sine=frequency=440:duration=1"]);
        }
        cmd.args(["-c:v", "libx264", "-pix_fmt", "yuv420p"])
            .arg(&path);
        let ok = cmd.status().ok()?.success();
        ok.then_some((bin, path))
    }

    fn file_opts(bin: std::path::PathBuf, path: std::path::PathBuf, to: String) -> PlayOptions {
        PlayOptions {
            threads: 0,
            to: vec![to],
            latency_ms: Some(100),
            ffmpeg: Some(bin),
            input: InputSpec::Path(path.into()),
            ..opts()
        }
    }

    #[test]
    fn plays_a_file_to_a_cast_receiver() {
        use crate::cast::fake_receiver::{FakeReceiver, Options};
        let Some((bin, path)) = media_file("av.mp4", true) else {
            return;
        };
        let rx = FakeReceiver::spawn(Options::default());
        play(file_opts(bin, path, rx.addr.to_string()), &Ctx::new()).unwrap();
        let state = rx.shutdown();
        let st = state.lock().unwrap();
        assert!(st.stopped, "STOP not received");
        let offer = st.offer.as_ref().unwrap().to_string();
        assert!(offer.contains("\"opus\""), "{offer}");
        let v = st.streams.iter().find(|s| s.codec == "h264").unwrap();
        let a = st.streams.iter().find(|s| s.codec == "opus").unwrap();
        // 1 s at 30 fps; 10 ms Opus frames.
        assert!((28..=31).contains(&v.frames.len()), "{}", v.frames.len());
        assert!(v.frames[&0].keyframe);
        // (Up to 104: the AAC track of the 1 s file is a little longer.)
        assert!((90..=104).contains(&a.frames.len()), "{}", a.frames.len());
    }

    #[test]
    fn video_only_input_offers_no_audio() {
        use crate::cast::fake_receiver::{FakeReceiver, Options};
        let Some((bin, path)) = media_file("v.mp4", false) else {
            return;
        };
        let rx = FakeReceiver::spawn(Options::default());
        play(
            file_opts(bin, path, format!("cast:{}", rx.addr)),
            &Ctx::new(),
        )
        .unwrap();
        let state = rx.shutdown();
        let st = state.lock().unwrap();
        assert!(st.stopped);
        assert!(st.streams.iter().all(|s| s.codec == "h264"));
        let v = &st.streams[0];
        assert!((28..=31).contains(&v.frames.len()), "{}", v.frames.len());
    }

    /// A file x264 made without B-frames (1 s, GOP 15, AAC-LC 48 kHz).
    fn passthrough_file(name: &str) -> Option<std::path::PathBuf> {
        let (bin, _) = crate::media::ffmpeg::tests::real_ffmpeg()?;
        let dir = std::env::temp_dir().join(format!("tvpipe-session-{}", std::process::id()));
        std::fs::create_dir_all(&dir).ok()?;
        let path = dir.join(name);
        let ok = StdCommand::new(&bin)
            .args(["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi"])
            .args([
                "-i",
                "testsrc2=size=320x240:rate=30:duration=1",
                "-f",
                "lavfi",
            ])
            .args(["-i", "sine=frequency=440:sample_rate=48000:duration=1"])
            .args([
                "-c:v", "libx264", "-bf", "0", "-g", "15", "-pix_fmt", "yuv420p",
            ])
            .args(["-c:a", "aac", "-ac", "2"])
            .arg(&path)
            .status()
            .ok()?
            .success();
        ok.then_some(path)
    }

    const NO_FFMPEG: &str = "/nonexistent/tvpipe-test/ffmpeg";

    fn is_adts(data: &[u8]) -> bool {
        data.len() > 7 && data[0] == 0xff && data[1] & 0xf6 == 0xf0
    }

    #[test]
    fn passthrough_to_cast_without_ffmpeg() {
        use crate::cast::fake_receiver::{FakeReceiver, Options};
        let Some(path) = passthrough_file("pt.mp4") else {
            return;
        };
        let rx = FakeReceiver::spawn(Options::default());
        play(
            file_opts(NO_FFMPEG.into(), path, rx.addr.to_string()),
            &Ctx::new(),
        )
        .unwrap();
        let state = rx.shutdown();
        let st = state.lock().unwrap();
        assert!(st.stopped, "STOP not received");
        // The file's AAC is offered alone, so the receiver takes it.
        let offer = st.offer.as_ref().unwrap().to_string();
        assert!(
            offer.contains("\"aac\"") && !offer.contains("\"opus\""),
            "{offer}"
        );
        let v = st.streams.iter().find(|s| s.codec == "h264").unwrap();
        let a = st.streams.iter().find(|s| s.codec == "aac").unwrap();
        assert_eq!(v.frames.len(), 30);
        assert!(v.frames[&0].keyframe);
        // 1 s in 1024-sample units plus the encoder's priming unit.
        assert!((46..=49).contains(&a.frames.len()), "{}", a.frames.len());
        assert!(a.frames.values().all(|f| is_adts(&f.data)));
    }

    #[test]
    fn b_frames_need_ffmpeg() {
        use crate::cast::fake_receiver::{FakeReceiver, Options};
        let Some((_, path)) = media_file("bf.mp4", false) else {
            return;
        };
        let rx = FakeReceiver::spawn(Options::default());
        let e = play(
            file_opts(NO_FFMPEG.into(), path, rx.addr.to_string()),
            &Ctx::new(),
        )
        .unwrap_err();
        assert!(e.to_string().contains(NO_FFMPEG), "{e}");
        let state = rx.shutdown();
        assert!(state.lock().unwrap().stopped, "STOP not received");
    }

    /// Hands out SLRW records at their due times, like a game.
    struct PacedReader {
        chunks: std::collections::VecDeque<(Duration, Vec<u8>)>,
        start: Option<Instant>,
        cur: Vec<u8>,
        pos: usize,
    }

    impl std::io::Read for PacedReader {
        fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
            let start = *self.start.get_or_insert_with(Instant::now);
            if self.pos == self.cur.len() {
                let Some((due, chunk)) = self.chunks.pop_front() else {
                    return Ok(0);
                };
                std::thread::sleep((start + due).saturating_duration_since(Instant::now()));
                self.cur = chunk;
                self.pos = 0;
            }
            let n = out.len().min(self.cur.len() - self.pos);
            out[..n].copy_from_slice(&self.cur[self.pos..self.pos + n]);
            self.pos += n;
            Ok(n)
        }
    }

    #[test]
    fn encoded_slrw_to_cast_without_ffmpeg() {
        use crate::cast::fake_receiver::{FakeReceiver, Options};
        use crate::media::input::tests::{access_units, annexb_stream, SharedBuf};
        use crate::media::slrw::{self, Kind};
        let Some(stream) = annexb_stream() else {
            return;
        };
        let aus = access_units(&stream);
        let mut chunks = std::collections::VecDeque::new();
        let mut head = Vec::new();
        slrw::write_magic(&mut head).unwrap();
        slrw::write_control(&mut head, slrw::CONTROL_KEYFRAME_REQUESTS).unwrap();
        chunks.push_back((Duration::ZERO, head));
        for (i, au) in aus.iter().enumerate() {
            let pts = i as u64 * 33_333;
            let mut rec = Vec::new();
            slrw::write_h264(&mut rec, pts, i % 10 == 0, true, au).unwrap();
            slrw::write_packet(&mut rec, Kind::Audio, pts, &[3u8; 1600 * 4]).unwrap();
            chunks.push_back((Duration::from_micros(pts), rec));
        }
        let mut end = Vec::new();
        slrw::write_packet(&mut end, Kind::End, 0, &[]).unwrap();
        chunks.push_back((Duration::from_millis(1000), end));
        let rx = FakeReceiver::spawn(Options::default());
        let o = PlayOptions {
            threads: 0,
            to: vec![rx.addr.to_string()],
            latency_ms: Some(100),
            ffmpeg: Some(NO_FFMPEG.into()),
            raw_video: Some("160x120@30:h264".parse().unwrap()),
            raw_audio: Some("48000:2:s16le".parse().unwrap()),
            input: InputSpec::Stdin,
            ..opts()
        };
        let out = SharedBuf::default();
        let io = GameIo {
            stdin: Box::new(PacedReader {
                chunks,
                start: None,
                cur: Vec::new(),
                pos: 0,
            }),
            stdout: Box::new(out.clone()),
            approve: Box::new(|_, _| false),
        };
        play_io(o, io, &Ctx::new()).unwrap();
        let state = rx.shutdown();
        let st = state.lock().unwrap();
        assert!(st.stopped, "STOP not received");
        let offer = st.offer.as_ref().unwrap().to_string();
        assert!(
            offer.contains("\"aac\"") && !offer.contains("\"opus\""),
            "{offer}"
        );
        let v = st.streams.iter().find(|s| s.codec == "h264").unwrap();
        let a = st.streams.iter().find(|s| s.codec == "aac").unwrap();
        assert_eq!(v.frames.len(), 30);
        // 48000 samples of PCM through aacenc: 46 full units (+ the flush).
        assert!((45..=48).contains(&a.frames.len()), "{}", a.frames.len());
        assert!(a.frames.values().all(|f| is_adts(&f.data)));
        // Only "keyframe" lines (if any) went to the game.
        let back = out.0.lock().unwrap().clone();
        assert!(back
            .split(|&b| b == b'\n')
            .all(|l| l.is_empty() || l == b"keyframe"));
    }

    /// What a sink did with the frames the session gave it, per track.
    #[derive(Debug, Default, Clone, Copy)]
    pub(super) struct Tally {
        pub(super) video: u64,
        pub(super) video_accepted: u64,
        pub(super) audio: u64,
        pub(super) audio_accepted: u64,
    }

    pub(super) type SharedTally = std::sync::Arc<std::sync::Mutex<Tally>>;

    /// Counts what the wrapped sink accepts; with `left`, ends the session
    /// after that many video frames (the test pattern never ends by
    /// itself).
    pub(super) struct Tallied {
        pub(super) inner: Box<dyn Sink>,
        pub(super) left: Option<usize>,
        pub(super) tally: SharedTally,
    }

    impl Tallied {
        pub(super) fn boxed(
            inner: Box<dyn Sink>,
            left: Option<usize>,
            tally: &SharedTally,
        ) -> Box<dyn Sink> {
            Box::new(Tallied {
                inner,
                left,
                tally: tally.clone(),
            })
        }
    }

    impl Sink for Tallied {
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
            self.inner.start(v, a)
        }
        fn push(&mut self, f: &crate::types::EncodedFrame) -> Result<crate::types::SinkStatus> {
            let video = f.track == TrackKind::Video;
            if video {
                match &mut self.left {
                    Some(0) => return Ok(crate::types::SinkStatus::Finished),
                    Some(left) => *left -= 1,
                    None => {}
                }
            }
            let status = self.inner.push(f)?;
            let accepted = (status == crate::types::SinkStatus::Accepted) as u64;
            let mut t = self.tally.lock().unwrap();
            if video {
                t.video += 1;
                t.video_accepted += accepted;
            } else {
                t.audio += 1;
                t.audio_accepted += accepted;
            }
            Ok(status)
        }
        fn wants_keyframe(&self) -> bool {
            self.inner.wants_keyframe()
        }
        fn stop(&mut self) -> Result<()> {
            self.inner.stop()
        }
    }

    /// Cast targets as usual, AirPlay ones to a fake mirror receiver
    /// (which skips pairing); each sink ends after `limit` video frames
    /// and counts into `tally`.
    fn fake_connector(
        fake: Option<&crate::airplay::fake_mirror::FakeMirror>,
        limit: Option<usize>,
        tally: &SharedTally,
        t: &Target,
        cast_opts: &CastOptions,
        mirror: &crate::airplay::MirrorOptions,
    ) -> Result<Box<dyn Sink>> {
        let sink: Box<dyn Sink> = match t {
            Target::Browser(_) => connect_test(t, cast_opts, mirror)?,
            Target::Cast { addr, name } => Box::new(cast::connect(*addr, name, cast_opts)?),
            Target::AirPlay { .. } => {
                let fake = fake.expect("fake AirPlay receiver");
                fake_airplay(fake, "fake", mirror)?
            }
        };
        Ok(Tallied::boxed(sink, limit, tally))
    }

    /// A mirror sink connected to `fake` (no pairing).
    pub(super) fn fake_airplay(
        fake: &crate::airplay::fake_mirror::FakeMirror,
        name: &str,
        mirror: &crate::airplay::MirrorOptions,
    ) -> Result<Box<dyn Sink>> {
        let (addr, secret) = (fake.addr, fake.secret.clone());
        Ok(Box::new(crate::airplay::sink::connect_with(
            name.into(),
            mirror,
            |_| {
                let tcp = std::net::TcpStream::connect(addr)
                    .map_err(|e| Error::io("fake airplay connect", e))?;
                Ok((
                    crate::net::rtsp::RtspClient::new(tcp),
                    addr,
                    secret.clone(),
                    crate::airplay::session::ControlAuth::Verified,
                ))
            },
        )?))
    }

    /// A context that never asks to stop.
    pub(super) fn never() -> Ctx {
        Ctx::new()
    }

    /// The real connector, with a context of its own.
    pub(super) fn connect_test(
        t: &Target,
        c: &CastOptions,
        m: &crate::airplay::MirrorOptions,
    ) -> Result<Box<dyn Sink>> {
        connect_one(t, c, m, &Ctx::new())
    }

    /// Paced raw RGBA SLRW (like `slrw-gen`), 1 s at 30 fps with PCM.
    fn raw_game_io(rate: u32) -> GameIo {
        use crate::media::builtin::tests::{rgba_bars, Paced};
        use crate::media::slrw::{self, Kind};
        let mut chunks = std::collections::VecDeque::new();
        let mut head = Vec::new();
        slrw::write_magic(&mut head).unwrap();
        chunks.push_back((Duration::ZERO, head));
        let per_frame = rate as usize / 30;
        for i in 0..30u64 {
            let pts = 1_000_000 + i * 33_333;
            let mut rec = Vec::new();
            slrw::write_packet(&mut rec, Kind::Video, pts, &rgba_bars(320, 180, i)).unwrap();
            let pcm: Vec<u8> = (0..per_frame * 2)
                .flat_map(|k| (((k as f64 * 0.07).sin() * 5000.0) as i16).to_le_bytes())
                .collect();
            slrw::write_packet(&mut rec, Kind::Audio, pts, &pcm).unwrap();
            chunks.push_back((Duration::from_micros(i * 33_333), rec));
        }
        let mut end = Vec::new();
        slrw::write_packet(&mut end, Kind::End, 0, &[]).unwrap();
        chunks.push_back((Duration::from_millis(1000), end));
        GameIo {
            stdin: Box::new(Paced::new(chunks)),
            stdout: Box::new(std::io::sink()),
            approve: Box::new(|_, _| false),
        }
    }

    fn raw_opts(to: String, rate: u32) -> PlayOptions {
        PlayOptions {
            threads: 0,
            to: vec![to],
            latency_ms: Some(100),
            ffmpeg: Some(NO_FFMPEG.into()),
            raw_video: Some("320x180@30:rgba".parse().unwrap()),
            raw_audio: Some(format!("{rate}:2:s16le").parse().unwrap()),
            input: InputSpec::Stdin,
            ..opts()
        }
    }

    /// The H.264 a Cast receiver got decodes (when ffmpeg is around).
    fn check_decodes(
        frames: &std::collections::BTreeMap<
            crate::cast::rtp::FrameId,
            crate::cast::fake_receiver::Frame,
        >,
    ) {
        let Some((bin, _)) = crate::media::ffmpeg::tests::real_ffmpeg() else {
            return;
        };
        let stream: Vec<u8> = frames.values().flat_map(|f| f.data.clone()).collect();
        let mut child = StdCommand::new(bin)
            .args(["-v", "error", "-f", "h264", "-i", "-", "-f", "null", "-"])
            .stdin(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        use std::io::Write;
        child.stdin.take().unwrap().write_all(&stream).unwrap();
        let out = child.wait_with_output().unwrap();
        assert!(
            out.status.success() && out.stderr.is_empty(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
    }

    /// Every game frame of [`raw_game_io`] is accounted for by the
    /// built-in input. How many the encoder drops while busy depends on
    /// machine load, and the first record may come before the session
    /// pulls.
    fn assert_all_frames_accounted(c: &builtin::Counts) {
        assert_eq!(c.frames, 30, "{c:?}");
        assert_eq!(c.rate, 0, "{c:?}");
        assert_eq!(c.early + c.busy + c.encoded, 30, "{c:?}");
        assert!(c.encoded >= 1, "{c:?}");
    }

    /// The PCM frames of `frame_samples` the game's records after the
    /// first `early` (whose video was dropped before the start) make; the
    /// gate may open between a record's video and its audio.
    fn audio_frames(
        c: &builtin::Counts,
        record_samples: u64,
        frame_samples: u64,
    ) -> std::ops::RangeInclusive<u64> {
        (30 - c.early) * record_samples / frame_samples
            ..=(31 - c.early) * record_samples / frame_samples + 1
    }

    /// What a Cast receiver got of a track whose sink accepted `accepted`
    /// frames: a prefix of them, from frame 0 without holes (losses are
    /// retransmitted). Frames still being paced out when STOP comes may
    /// be missing at the end.
    pub(super) fn assert_cast_frames(
        frames: &std::collections::BTreeMap<
            crate::cast::rtp::FrameId,
            crate::cast::fake_receiver::Frame,
        >,
        accepted: u64,
    ) {
        assert!(!frames.is_empty());
        assert_eq!(frames.keys().next(), Some(&0), "the first frame is missing");
        assert!(
            frames.len() as u64 <= accepted,
            "{} > {accepted}",
            frames.len()
        );
        let ids: Vec<_> = frames.values().map(|f| f.frame_id).collect();
        assert!(ids.windows(2).all(|w| w[1] == w[0] + 1), "holes in {ids:?}");
    }

    /// Video RTP timestamps are media time: frames dropped on the way
    /// leave gaps of whole frames (3000 ticks at 30 fps), they never shift
    /// the timeline.
    fn assert_on_frame_grid(ts: &[u32]) {
        for w in ts.windows(2) {
            let d = w[1].wrapping_sub(w[0]);
            let k = (d + 1500) / 3000;
            assert!(k >= 1 && d.abs_diff(k * 3000) <= 1, "{ts:?}");
        }
    }

    #[test]
    fn raw_slrw_to_cast_without_ffmpeg() {
        use crate::cast::fake_receiver::{FakeReceiver, Options};
        let rx = FakeReceiver::spawn(Options::default());
        let tally = SharedTally::default();
        let connect = |t: &Target, c: &CastOptions, m: &crate::airplay::MirrorOptions| {
            fake_connector(None, None, &tally, t, c, m)
        };
        play_with(
            raw_opts(rx.addr.to_string(), 48_000),
            raw_game_io(48_000),
            &connect,
            &never(),
        )
        .unwrap();
        let c = builtin::take_finished_counts().expect("built-in input");
        let t = *tally.lock().unwrap();
        let state = rx.shutdown();
        let st = state.lock().unwrap();
        assert!(st.stopped, "STOP not received");
        let offer = st.offer.as_ref().unwrap().to_string();
        assert!(
            offer.contains("\"aac\"") && !offer.contains("\"opus\""),
            "{offer}"
        );
        let v = st.streams.iter().find(|s| s.codec == "h264").unwrap();
        let a = st.streams.iter().find(|s| s.codec == "aac").unwrap();
        assert_all_frames_accounted(&c);
        // One sink: it got every encoded frame unless its queue was full.
        assert!(t.video <= c.encoded, "{t:?} {c:?}");
        assert_cast_frames(&v.frames, t.video_accepted);
        assert!(v.frames.values().next().unwrap().keyframe);
        let ts: Vec<u32> = v.frames.values().map(|f| f.rtp_timestamp).collect();
        assert_on_frame_grid(&ts);
        // PCM is never dropped for the encoder: 1600 samples per record in
        // 1024-sample AAC units.
        assert!(
            audio_frames(&c, 1600, 1024).contains(&t.audio),
            "{t:?} {c:?}"
        );
        assert_cast_frames(&a.frames, t.audio_accepted);
        assert!(a.frames.values().all(|f| is_adts(&f.data)));
        check_decodes(&v.frames);
    }

    #[test]
    fn test_pattern_to_cast_builtin() {
        use crate::cast::fake_receiver::{FakeReceiver, Options};
        let rx = FakeReceiver::spawn(Options::default());
        let tally = SharedTally::default();
        let connect = |t: &Target, c: &CastOptions, m: &crate::airplay::MirrorOptions| {
            fake_connector(None, Some(20), &tally, t, c, m)
        };
        let o = PlayOptions {
            threads: 0,
            to: vec![rx.addr.to_string()],
            latency_ms: Some(100),
            size: Some(Size {
                width: 640,
                height: 360,
            }),
            encoder: Encoder::Builtin,
            ..opts()
        };
        let io = GameIo {
            stdin: Box::new(std::io::empty()),
            stdout: Box::new(std::io::sink()),
            approve: Box::new(|_, _| false),
        };
        play_with(o, io, &connect, &never()).unwrap();
        let t = *tally.lock().unwrap();
        let state = rx.shutdown();
        let st = state.lock().unwrap();
        assert!(st.stopped, "STOP not received");
        let v = st.streams.iter().find(|s| s.codec == "h264").unwrap();
        let a = st.streams.iter().find(|s| s.codec == "aac").unwrap();
        // The pattern never ends: the session ran until the sink had 20.
        assert_eq!(t.video, 20, "{t:?}");
        assert_cast_frames(&v.frames, t.video_accepted);
        assert!(v.frames.values().next().unwrap().keyframe);
        assert_cast_frames(&a.frames, t.audio_accepted);
        check_decodes(&v.frames);
    }

    #[test]
    fn raw_slrw_and_test_pattern_to_airplay_without_ffmpeg() {
        use crate::airplay::fake_mirror::{Behaviour, FakeMirror};
        // Raw SLRW, --encoder auto with a bogus ffmpeg.
        let fake = FakeMirror::start(Behaviour::default());
        let tally = SharedTally::default();
        let connect = |t: &Target, c: &CastOptions, m: &crate::airplay::MirrorOptions| {
            fake_connector(Some(&fake), None, &tally, t, c, m)
        };
        let to = format!("airplay:{}", fake.addr);
        play_with(
            raw_opts(to.clone(), 44_100),
            raw_game_io(44_100),
            &connect,
            &never(),
        )
        .unwrap();
        {
            let c = builtin::take_finished_counts().expect("built-in input");
            let t = *tally.lock().unwrap();
            let r = fake.rec();
            assert!(r.teardown);
            let frames = r.video.iter().filter(|p| p.kind == 0).count();
            assert_all_frames_accounted(&c);
            assert!(t.video <= c.encoded, "{t:?} {c:?}");
            // Mirroring video is TCP, and the sink drains its queue on
            // stop: the receiver got every frame the sink accepted.
            assert_eq!(frames as u64, t.video_accepted, "{t:?} {c:?}");
            assert!(frames >= 1);
            assert!(r.video.iter().any(|p| p.kind == 1), "codec packet");
            assert!(r.video.iter().find(|p| p.kind == 0).unwrap().idr);
            // 1470 samples per record in 352-sample PCM frames. The sink
            // drops audio until the first video frame is out, and audio
            // is UDP.
            assert!(
                audio_frames(&c, 1470, 352).contains(&t.audio),
                "{t:?} {c:?}"
            );
            assert!(
                (1..=t.audio_accepted).contains(&(r.audio.len() as u64)),
                "{t:?}"
            );
        }
        // The test pattern, built in because ffmpeg is missing.
        let fake = FakeMirror::start(Behaviour::default());
        let tally = SharedTally::default();
        let connect = |t: &Target, c: &CastOptions, m: &crate::airplay::MirrorOptions| {
            fake_connector(Some(&fake), Some(15), &tally, t, c, m)
        };
        let o = PlayOptions {
            threads: 0,
            to: vec![format!("airplay:{}", fake.addr)],
            latency_ms: Some(100),
            ffmpeg: Some(NO_FFMPEG.into()),
            ..opts()
        };
        let io = GameIo {
            stdin: Box::new(std::io::empty()),
            stdout: Box::new(std::io::sink()),
            approve: Box::new(|_, _| false),
        };
        play_with(o, io, &connect, &never()).unwrap();
        let t = *tally.lock().unwrap();
        let r = fake.rec();
        assert!(r.teardown);
        let frames = r.video.iter().filter(|p| p.kind == 0).count();
        // The pattern never ends: the session ran until the sink had 15.
        assert_eq!(t.video, 15, "{t:?}");
        assert_eq!(frames as u64, t.video_accepted, "{t:?}");
        assert!(frames >= 1);
        assert!(
            (1..=t.audio_accepted).contains(&(r.audio.len() as u64)),
            "{t:?}"
        );
    }

    /// Records when each video frame reaches the sink; `start()` takes
    /// as long as an AirPlay SETUP.
    struct ArrivalSink {
        caps: Capabilities,
        arrivals: std::sync::Arc<std::sync::Mutex<Vec<(Instant, u64)>>>,
        left: usize,
    }

    impl Sink for ArrivalSink {
        fn name(&self) -> &str {
            "arrivals"
        }
        fn capabilities(&self) -> &Capabilities {
            &self.caps
        }
        fn start(
            &mut self,
            _v: &crate::types::VideoInfo,
            _a: Option<&crate::types::AudioInfo>,
        ) -> Result<()> {
            std::thread::sleep(Duration::from_millis(250));
            Ok(())
        }
        fn push(&mut self, f: &crate::types::EncodedFrame) -> Result<crate::types::SinkStatus> {
            if f.track == TrackKind::Video {
                if self.left == 0 {
                    return Ok(crate::types::SinkStatus::Finished);
                }
                self.left -= 1;
                self.arrivals.lock().unwrap().push((Instant::now(), f.pts));
            }
            Ok(crate::types::SinkStatus::Accepted)
        }
        fn wants_keyframe(&self) -> bool {
            false
        }
        fn stop(&mut self) -> Result<()> {
            Ok(())
        }
    }

    /// A live input must not run ahead while a sink is still starting:
    /// frames reach the sink on their pts schedule from the first one, no
    /// burst of backlog (which the sink's clock would turn into latency;
    /// seen as ~230 ms on the Apple TV).
    #[test]
    fn live_input_waits_for_slow_sink_start() {
        let out = VideoOut {
            size: Size {
                width: 160,
                height: 90,
            },
            fps: Ratio::integer(30),
            bitrate_kbps: 300,
            gop: 30,
        };
        let input = BuiltinInput::test_pattern(out, 48_000, vec![], never().stop).unwrap();
        let arrivals = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let sink = ArrivalSink {
            caps: caps(1920, 1080, 60, 10_000),
            arrivals: arrivals.clone(),
            left: 15,
        };
        stream(
            Box::new(input),
            events::Route::Builtin,
            0,
            vec![Box::new(sink)],
            &never(),
        )
        .unwrap();
        let a = arrivals.lock().unwrap();
        assert_eq!(a.len(), 15);
        let (t0, p0) = a[0];
        for &(t, pts) in a.iter() {
            let due = Duration::from_micros((pts - p0) * 1000 / 90);
            let at = t - t0;
            assert!(
                at + Duration::from_millis(40) >= due,
                "pts {due:?} arrived at {at:?}"
            );
        }
    }

    #[test]
    fn builtin_needs_raw_or_pattern() {
        let o = PlayOptions {
            encoder: Encoder::Builtin,
            input: InputSpec::Path("x.mp4".into()),
            ..opts()
        };
        let mut tools = Tools::new(None);
        assert!(use_builtin(&o, false, &mut tools).is_err());
        let o = PlayOptions {
            encoder: Encoder::Builtin,
            input: InputSpec::Stdin,
            raw_video: Some("64x64@30:yuyv422".parse().unwrap()),
            ..opts()
        };
        let e = use_builtin(&o, false, &mut tools).unwrap_err();
        assert!(e.to_string().contains("cannot read"), "{e}");
        let o = PlayOptions {
            raw_video: Some("64x64@30:bgra".parse().unwrap()),
            ..o
        };
        assert!(use_builtin(&o, false, &mut tools).unwrap());
        // Encoded SLRW never goes through the encoder.
        assert!(!use_builtin(&o, true, &mut tools).unwrap());
        // Auto with a bogus ffmpeg falls back to the built-in encoder.
        let bogus = std::path::PathBuf::from(NO_FFMPEG);
        let mut tools = Tools::new(Some(&bogus));
        let o = PlayOptions {
            encoder: Encoder::Auto,
            ..o
        };
        assert!(use_builtin(&o, false, &mut tools).unwrap());
        let o = PlayOptions {
            input: InputSpec::TestPattern,
            ..o
        };
        assert!(use_builtin(&o, false, &mut tools).unwrap());
    }

    #[test]
    fn test_pattern_is_builtin_unless_an_ffmpeg_encoder_is_named() {
        // Whatever ffmpeg is installed (and whether it has drawtext), the
        // test pattern is the built-in one; ffmpeg is not even probed.
        let bogus = std::path::PathBuf::from(NO_FFMPEG);
        for ffmpeg in [None, Some(&bogus)] {
            let mut tools = Tools::new(ffmpeg.map(|p| p.as_path()));
            for encoder in [Encoder::Auto, Encoder::Builtin] {
                let o = PlayOptions { encoder, ..opts() };
                assert!(use_builtin(&o, false, &mut tools).unwrap());
            }
            assert!(tools.found.is_none(), "ffmpeg was probed");
            // Naming an ffmpeg encoder selects ffmpeg's testsrc2.
            let o = PlayOptions {
                encoder: Encoder::X264,
                ..opts()
            };
            assert!(!use_builtin(&o, false, &mut tools).unwrap());
        }
    }

    #[test]
    fn airplay_target_connect_failure() {
        let o = PlayOptions {
            threads: 0,
            to: vec!["airplay:127.0.0.1:1".into()],
            ffmpeg: crate::media::ffmpeg::tests::real_ffmpeg().map(|(b, _)| b),
            ..opts()
        };
        if o.ffmpeg.is_none() {
            return;
        }
        let e = play(o, &Ctx::new()).unwrap_err();
        assert_ne!(e.kind(), crate::error::ErrorKind::Unsupported, "{e}");
        assert!(e.to_string().contains("airplay"), "{e}");
    }
}
