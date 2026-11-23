//! Media inputs: where the session's frames come from (ARCHITECTURE.md,
//! "Inputs").
//!
//! An [`Input`] yields the stream info the sinks start with and then
//! [`EncodedFrame`]s in our conventions (ARCHITECTURE.md,
//! "Code Conventions"). Implementations:
//!
//! - [`FfmpegInput`]: ffmpeg encodes (files, URLs, capture, test pattern,
//!   raw SLRW through [`rawin`]); what `session.rs` did inline before.
//! - [`PassthroughInput`]: a compatible MP4/MOV or Matroska file is sent
//!   unchanged ([`passthrough`]), paced in real time on a [`MediaClock`],
//!   optionally looped. No ffmpeg at all.
//! - [`SlrwEncodedInput`]: a game sends encoded H.264 (and PCM) in SLRW
//!   (`--raw-video WxH@FPS:h264`, docs/slrw.md), with keyframes on
//!   demand through the stdout back channel. No ffmpeg for video.
//!
//! The session loop is the same for all three: `info()`, then
//! `next_frame()` until `None`, pushing into the fanout and calling
//! `request_keyframe()` while `Fanout::keyframe_wanted()`; then `finish()`.
//! Every implementation returns `None` soon after a stop request
//! (Ctrl-C), also while waiting for input.
//!
//! Sources: ARCHITECTURE.md, "Inputs"; docs/slrw.md; docs/measurements.md.

use std::collections::VecDeque;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::process::ChildStdout;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use crate::error::{Error, Result};
use crate::log::Level;
use crate::media::clock::MediaClock;
#[cfg(feature = "ffmpeg")]
use crate::media::ffmpeg::{self, Output, Process, Source};
use crate::media::h264::{self, AvcConfig};
#[cfg(feature = "files")]
use crate::media::passthrough::{self, CheckOptions, FileInfo, FileSource, PassPlan};
#[cfg(feature = "ffmpeg")]
use crate::media::rawin::{Forwarder, RawInput};
use crate::media::slrw::{self, Kind, Packet, SlrwReader};
#[cfg(feature = "ffmpeg")]
use crate::media::source::MediaReader;
use crate::opts::{PlayOptions, RawAudioSpec, RawVideoSpec};
use crate::types::StreamInfo;
use crate::types::{
    AudioCodec, AudioFamily, AudioFormat, AudioInfo, Capabilities, EncodePlan, EncodedFrame,
    Encoder, TrackKind, VideoCodec, VideoInfo, VIDEO_CLOCK_RATE,
};
use crate::util::time::ticks_to_duration;

/// How often blocking waits look at the stop flag.
pub(crate) const STOP_POLL: Duration = Duration::from_millis(50);
/// After a stop request, ffmpeg gets this long to exit by itself before
/// it is killed (it got SIGINT too).
const KILL_GRACE: Duration = Duration::from_millis(300);
/// Keyframe requests to the game are at most this frequent.
pub(crate) const KEYFRAME_REQUEST_INTERVAL: Duration = Duration::from_millis(200);
/// PCM frame size for AirPlay (what the ffmpeg path produces, too).
pub const AIRPLAY_PCM_FRAME_SAMPLES: u32 = 352;
/// Audio whose pts drifts this far from its sample count resyncs.
const AUDIO_RESYNC: Duration = Duration::from_millis(50);
/// SLRW records buffered between the reader thread and the session.
const SLRW_QUEUE: usize = 64;

/// The stop condition inputs poll (Ctrl-C by default; tests use their own).
pub use crate::util::stop::Stop;

/// A source of encoded frames for the fanout.
pub trait Input: Send {
    /// Video info plus the audio track of each family in use.
    fn info(&self) -> &StreamInfo;

    /// The next frame; `None` at the end of the input or after a stop
    /// request.
    fn next_frame(&mut self) -> Result<Option<EncodedFrame>>;

    /// A sink wants a keyframe (see `Fanout::keyframe_wanted`). Returns
    /// whether this input can make one on demand; inputs rate-limit.
    fn request_keyframe(&mut self) -> bool {
        false
    }

    /// The video bitrate (kbit/s) this input encodes at, when it can
    /// change it ([`Input::set_bitrate`]): the session then adapts it to
    /// the network (`media::abr`). `None`: fixed (ffmpeg, passthrough, a
    /// game's own H.264).
    fn bitrate_kbps(&self) -> Option<u32> {
        None
    }

    /// Encodes the next frames at `kbps`.
    fn set_bitrate(&mut self, kbps: u32) {
        let _ = kbps;
    }

    /// For logs: `"ffmpeg (libx264)"`, `"passthrough MP4"`, ...
    fn describe(&self) -> String;

    /// Ends the input. `clean_eof`: `next_frame` returned `None` without a
    /// stop request, so a subprocess should have exited by itself and its
    /// failure is reported; otherwise it is killed.
    fn finish(self: Box<Self>, clean_eof: bool) -> Result<()>;
}

// ---------------------------------------------------------------------------
// Choosing between passthrough and ffmpeg

/// The option that makes the user's intent "re-encode", if any.
pub fn encode_forced_by(opts: &PlayOptions) -> Option<&'static str> {
    if opts.size.is_some() {
        Some("--size")
    } else if opts.fps.is_some() {
        Some("--fps")
    } else if opts.bitrate_kbps.is_some() {
        Some("--bitrate")
    } else if opts.encoder != Encoder::Auto {
        Some("--encoder")
    } else {
        None
    }
}

#[cfg(feature = "files")]
/// What to do with a file input.
#[derive(Debug, Clone, PartialEq)]
pub enum FileDecision {
    Passthrough {
        info: Box<FileInfo>,
        plan: PassPlan,
    },
    /// Use ffmpeg; `why` is a sentence for the log.
    Ffmpeg {
        why: String,
    },
}

#[cfg(feature = "files")]
/// Decides how to send a file once every sink is connected. `probed` is
/// [`passthrough::probe`]'s result (run before connecting, so its size and
/// bitrate can shape the receivers' negotiation).
pub fn decide_file(
    probed: &Result<FileInfo>,
    opts: &PlayOptions,
    sinks: &[(&str, &Capabilities)],
) -> FileDecision {
    let info = match probed {
        Ok(i) => i,
        Err(e) => {
            return FileDecision::Ffmpeg {
                why: format!("cannot pass the file through: {e}"),
            }
        }
    };
    if let Some(flag) = encode_forced_by(opts) {
        return FileDecision::Ffmpeg {
            why: format!("re-encoding because of {flag}"),
        };
    }
    let reorder = reorder_experiment();
    if let Some(r) = reorder {
        warn!("experiment: B-frames pass through in decode order, stamped with their {r:?}");
    }
    let check = CheckOptions {
        audio: !opts.no_audio,
        allow_reordering: reorder.is_some(),
        ..CheckOptions::default()
    };
    match passthrough::check(info, sinks, check) {
        Ok(plan) => FileDecision::Passthrough {
            info: Box::new(info.clone()),
            plan,
        },
        Err(why) => FileDecision::Ffmpeg {
            why: format!("encoding with ffmpeg: {why}"),
        },
    }
}

// ---------------------------------------------------------------------------
// ffmpeg

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

#[cfg(feature = "ffmpeg")]
/// Kills ffmpeg a grace period after a stop request so the demuxer's
/// read ends.
struct Watcher {
    done: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

#[cfg(feature = "ffmpeg")]
impl Watcher {
    fn start(proc: Arc<Mutex<Process>>, stop: Stop) -> Result<Watcher> {
        let done = Arc::new(AtomicBool::new(false));
        let flag = done.clone();
        let thread = std::thread::Builder::new()
            .name("ffmpeg-watch".into())
            .spawn(move || {
                let mut stop_at = None;
                while !flag.load(Ordering::Acquire) {
                    if stop.requested() {
                        let at = *stop_at.get_or_insert_with(|| Instant::now() + KILL_GRACE);
                        if Instant::now() >= at {
                            lock(&proc).kill();
                            return;
                        }
                    }
                    std::thread::sleep(Duration::from_millis(20));
                }
            })
            .map_err(|e| Error::io("spawn ffmpeg watcher", e))?;
        Ok(Watcher {
            done,
            thread: Some(thread),
        })
    }
}

#[cfg(feature = "ffmpeg")]
impl Drop for Watcher {
    fn drop(&mut self) {
        self.done.store(true, Ordering::Release);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

#[cfg(feature = "ffmpeg")]
/// ffmpeg → Matroska → [`MediaReader`].
pub struct FfmpegInput {
    proc: Arc<Mutex<Process>>,
    watcher: Option<Watcher>,
    forwarder: Option<Forwarder>,
    reader: MediaReader<ChildStdout>,
    info: StreamInfo,
    encoder: Option<Encoder>,
    stop: Stop,
}

#[cfg(feature = "ffmpeg")]
impl FfmpegInput {
    /// Starts ffmpeg on `source` with `plan`. For SLRW raw input pass the
    /// bound [`RawInput`] (whose [`RawInput::source`] is `source`) and the
    /// game's stream.
    pub fn start(
        bin: &Path,
        probe: &ffmpeg::Probe,
        source: &Source,
        plan: &EncodePlan,
        raw: Option<(RawInput, Box<dyn Read + Send>)>,
        stop: Stop,
    ) -> Result<FfmpegInput> {
        let (loglevel, level) = if crate::log::enabled(Level::Debug) {
            ("info", Level::Debug)
        } else {
            ("warning", Level::Warn)
        };
        let inv = ffmpeg::build(source, Output::Encode(plan), probe, loglevel)?;
        let mut proc = Process::spawn_logging(bin, &inv.args, level)?;
        let stdout = proc
            .take_stdout()
            .ok_or_else(|| Error::process("ffmpeg stdout not piped"))?;
        let proc = Arc::new(Mutex::new(proc));
        let watcher = Watcher::start(proc.clone(), stop.clone())?;
        let forwarder = raw.map(|(r, input)| r.start(input)).transpose()?;
        let reader = match MediaReader::new(stdout, &inv.tracks) {
            Ok(r) => r,
            Err(e) => return Err(lock(&proc).failure().unwrap_or(e)),
        };
        let info = reader.info().clone();
        Ok(FfmpegInput {
            proc,
            watcher: Some(watcher),
            forwarder,
            reader,
            info,
            encoder: inv.encoder,
            stop,
        })
    }
}

#[cfg(feature = "ffmpeg")]
impl Input for FfmpegInput {
    fn info(&self) -> &StreamInfo {
        &self.info
    }

    fn next_frame(&mut self) -> Result<Option<EncodedFrame>> {
        match self.reader.next_frame() {
            Ok(f) => Ok(f.map(|f| f.frame)),
            Err(e) if self.stop.requested() => {
                debug!("demuxer after stop request: {e}");
                Ok(None)
            }
            Err(e) => Err(lock(&self.proc).failure().unwrap_or(e)),
        }
    }

    fn describe(&self) -> String {
        match self.encoder {
            Some(e) => format!("ffmpeg ({e:?})"),
            None => "ffmpeg".into(),
        }
    }

    fn finish(mut self: Box<Self>, clean_eof: bool) -> Result<()> {
        drop(self.watcher.take());
        let result = {
            let mut p = lock(&self.proc);
            if clean_eof {
                p.wait().map(|_| ())
            } else {
                p.kill();
                let _ = p.wait();
                Ok(())
            }
        };
        if let Some(f) = self.forwarder.take() {
            match f.finish() {
                Ok(s) => debug!("raw input: {s:?}"),
                Err(e) => debug!("raw input: {e}"),
            }
        }
        result
    }
}

// ---------------------------------------------------------------------------
// Passthrough

#[cfg(feature = "files")]
/// Sleeps until `due`, in slices, returning `false` on a stop request.
fn sleep_until(due: Instant, stop: &Stop) -> bool {
    loop {
        if stop.requested() {
            return false;
        }
        let now = Instant::now();
        if now >= due {
            return true;
        }
        std::thread::sleep((due - now).min(STOP_POLL));
    }
}

#[cfg(feature = "files")]
/// A compatible file sent unchanged (see [`passthrough::check`]).
pub struct PassthroughInput {
    src: FileSource,
    info: StreamInfo,
    families: Vec<AudioFamily>,
    realtime: bool,
    looped: bool,
    clock: MediaClock,
    /// Added to every pts (ns) for loop passes after the first.
    loop_offset_ns: u128,
    /// End of the current pass's media (ns, pass-relative).
    pass_end_ns: u128,
    last_video_pts: Option<u64>,
    pending: VecDeque<EncodedFrame>,
    /// PCM audio is re-cut into AirPlay-sized frames.
    pcm: Option<PcmFramer>,
    /// B-frame experiment (see [`reorder_experiment`]).
    reorder: Option<ReorderStamp>,
    stop: Stop,
}

#[cfg(feature = "files")]
/// The timestamp B-frames carry in the reordering experiment.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReorderStamp {
    /// Each frame's presentation time (goes back and forth).
    Pts,
    /// Each frame's decode time (increases; pictures come out of the
    /// decoder in presentation order).
    Dts,
}

#[cfg(feature = "files")]
/// Environment variable for the B-frame experiment: `dts` or `pts`.
pub const REORDER_EXPERIMENT_ENV: &str = "TVPIPE_EXPERIMENT_BFRAMES";

#[cfg(feature = "files")]
/// `$TVPIPE_EXPERIMENT_BFRAMES`: pass files with B-frames through
/// anyway (decode order, stamped as said), to try receivers
/// (docs/measurements.md). Unset: B-frames go through ffmpeg.
pub fn reorder_experiment() -> Option<ReorderStamp> {
    match std::env::var(REORDER_EXPERIMENT_ENV).ok()?.as_str() {
        "dts" => Some(ReorderStamp::Dts),
        "pts" => Some(ReorderStamp::Pts),
        other => {
            warn!("{REORDER_EXPERIMENT_ENV}={other:?}: expected dts or pts; ignored");
            None
        }
    }
}

#[cfg(feature = "files")]
/// Cuts PCM packets into fixed frames, keeping their sample timeline.
struct PcmFramer {
    bytes_per_sample: usize,
    frame: usize,
    buf: Vec<u8>,
    pts: u64,
}

#[cfg(feature = "files")]
impl PcmFramer {
    /// Adds a packet at `pts`; returns the complete frames. A gap (a
    /// loop, a cut) flushes the partial frame first.
    fn push(&mut self, pts: u64, data: &[u8]) -> Vec<(u64, Vec<u8>)> {
        let mut out = Vec::new();
        let buffered = (self.buf.len() / self.bytes_per_sample) as u64;
        if self.buf.is_empty() || self.pts + buffered != pts {
            out.extend(self.flush());
            self.pts = pts;
        }
        self.buf.extend_from_slice(data);
        let n = self.frame * self.bytes_per_sample;
        while self.buf.len() >= n {
            out.push((self.pts, self.buf.drain(..n).collect()));
            self.pts += self.frame as u64;
        }
        out
    }

    fn flush(&mut self) -> Option<(u64, Vec<u8>)> {
        if self.buf.is_empty() {
            return None;
        }
        let pts = self.pts;
        self.pts += (self.buf.len() / self.bytes_per_sample) as u64;
        Some((pts, std::mem::take(&mut self.buf)))
    }
}

#[cfg(feature = "files")]
impl PassthroughInput {
    /// Opens `path` for sending as checked: `plan` from
    /// [`passthrough::check`]. `realtime` paces frames at their pts (like
    /// ffmpeg's `-re`); `looped` starts over at the end.
    pub fn open(
        path: &Path,
        plan: &PassPlan,
        realtime: bool,
        looped: bool,
        stop: Stop,
    ) -> Result<Self> {
        let src = FileSource::open(path)?;
        let fi = src.info();
        let mut families = plan.audio_families.clone();
        let mut pcm = None;
        let audio = match &fi.audio {
            Some(a) => {
                let mut a = a.clone();
                if a.codec == AudioCodec::PcmS16le && a.channels > 0 {
                    // The only PCM taker is the AirPlay sink (352 frames).
                    a.frame_samples = AIRPLAY_PCM_FRAME_SAMPLES;
                    pcm = Some(PcmFramer {
                        bytes_per_sample: a.channels as usize * 2,
                        frame: AIRPLAY_PCM_FRAME_SAMPLES as usize,
                        buf: Vec::new(),
                        pts: 0,
                    });
                }
                families.iter().map(|&f| (f, a.clone())).collect()
            }
            None => {
                families.clear();
                Vec::new()
            }
        };
        let info = StreamInfo {
            video: fi.video.clone(),
            audio,
        };
        Ok(PassthroughInput {
            src,
            info,
            families,
            realtime,
            looped,
            clock: MediaClock::new(),
            loop_offset_ns: 0,
            pass_end_ns: 0,
            last_video_pts: None,
            pending: VecDeque::new(),
            pcm,
            reorder: reorder_experiment(),
            stop,
        })
    }

    /// Overrides [`reorder_experiment`] (tests, experiments).
    pub fn set_reorder(&mut self, r: Option<ReorderStamp>) {
        self.reorder = r;
    }

    fn queue_audio(&mut self, frame: &EncodedFrame) {
        for &family in &self.families {
            self.pending.push_back(EncodedFrame {
                track: TrackKind::Audio(family),
                ..frame.clone()
            });
        }
    }

    fn rate(&self, kind: TrackKind) -> u32 {
        match kind {
            TrackKind::Video => VIDEO_CLOCK_RATE,
            TrackKind::Audio(_) => self.info.audio.first().map_or(48_000, |a| a.1.sample_rate),
        }
    }

    /// A frame's nominal duration in ns when the container gave none.
    fn fallback_duration_ns(&self, kind: TrackKind) -> u128 {
        match kind {
            TrackKind::Video => {
                let fps = self.info.video.fps;
                if fps.num == 0 {
                    33_333_333
                } else {
                    1_000_000_000u128 * fps.den as u128 / fps.num as u128
                }
            }
            TrackKind::Audio(_) => match self.info.audio.first() {
                Some((_, a)) if a.sample_rate > 0 && a.frame_samples > 0 => {
                    a.frame_samples as u128 * 1_000_000_000 / a.sample_rate as u128
                }
                _ => 20_000_000,
            },
        }
    }

    fn next_file_frame(&mut self) -> Result<Option<passthrough::FileFrame>> {
        if let Some(f) = self.src.next_frame()? {
            return Ok(Some(f));
        }
        if !self.looped || self.pass_end_ns == 0 {
            return Ok(None);
        }
        debug!("passthrough: looping");
        self.src.rewind()?;
        self.loop_offset_ns += self.pass_end_ns;
        self.pass_end_ns = 0;
        self.src.next_frame()
    }
}

#[cfg(feature = "files")]
fn shift(pts: u64, rate: u32, offset_ns: u128) -> u64 {
    let add = offset_ns * rate as u128 / 1_000_000_000;
    pts.saturating_add(add.min(u64::MAX as u128) as u64)
}

#[cfg(feature = "files")]
impl Input for PassthroughInput {
    fn info(&self) -> &StreamInfo {
        &self.info
    }

    fn next_frame(&mut self) -> Result<Option<EncodedFrame>> {
        loop {
            if let Some(f) = self.pending.pop_front() {
                return Ok(Some(f));
            }
            if self.stop.requested() {
                return Ok(None);
            }
            let Some(ff) = self.next_file_frame()? else {
                if let Some((pts, data)) = self.pcm.as_mut().and_then(PcmFramer::flush) {
                    let f = EncodedFrame {
                        track: TrackKind::Audio(AudioFamily::AirPlay),
                        pts,
                        keyframe: true,
                        data: Arc::from(data),
                    };
                    self.queue_audio(&f);
                    continue;
                }
                return Ok(None);
            };
            let kind = ff.frame.track;
            if kind != TrackKind::Video && self.families.is_empty() {
                continue;
            }
            let rate = self.rate(kind);
            let dur_ns = if ff.duration > 0 {
                ff.duration as u128 * 1_000_000_000 / rate as u128
            } else {
                self.fallback_duration_ns(kind)
            };
            let start_ns = ticks_to_duration(ff.frame.pts, rate).as_nanos();
            self.pass_end_ns = self.pass_end_ns.max(start_ns + dur_ns);
            let mut pts = shift(ff.frame.pts, rate, self.loop_offset_ns);
            // Frames leave in decode order at their decode time.
            let dts = shift(ff.dts, rate, self.loop_offset_ns);
            if kind == TrackKind::Video {
                match self.reorder {
                    None if self.last_video_pts.is_some_and(|l| pts <= l) => {
                        return Err(Error::unsupported(
                            "passthrough: the video has B-frames after the probed part; \
                             run again with --encoder auto|x264|... to re-encode",
                        ));
                    }
                    Some(ReorderStamp::Dts) => pts = dts,
                    _ => {}
                }
                self.last_video_pts = Some(pts);
            }
            if self.realtime {
                if !self.clock.is_anchored() {
                    self.clock.observe(dts, rate);
                }
                let due = self
                    .clock
                    .instant_for(dts, rate)
                    .unwrap_or_else(Instant::now);
                if !sleep_until(due, &self.stop) {
                    return Ok(None);
                }
            }
            let frame = EncodedFrame { pts, ..ff.frame };
            if kind == TrackKind::Video {
                return Ok(Some(frame));
            }
            match self.pcm.as_mut() {
                Some(p) => {
                    for (pts, data) in p.push(pts, &frame.data) {
                        let f = EncodedFrame {
                            pts,
                            data: Arc::from(data),
                            ..frame.clone()
                        };
                        self.queue_audio(&f);
                    }
                }
                None => self.queue_audio(&frame),
            }
        }
    }

    fn describe(&self) -> String {
        format!("passthrough {}", self.src.info().container)
    }

    fn finish(self: Box<Self>, _clean_eof: bool) -> Result<()> {
        if self.src.dropped_negative() > 0 {
            debug!(
                "passthrough: dropped {} frames before the stream start",
                self.src.dropped_negative()
            );
        }
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// SLRW with encoded H.264

/// How one audio family gets an encoded-SLRW game's PCM.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AudioOut {
    /// s16le PCM cut into frames of this many samples (AirPlay: the sink
    /// wraps them as verbatim ALAC).
    Pcm { frame_samples: u32 },
    /// Encoded in-process with `media::aacenc` (Cast).
    AacLc { bitrate_bps: u32 },
}

/// Bitrate for in-process AAC (what the ffmpeg path uses for AAC too).
pub const AAC_BITRATE_BPS: u32 = 128_000;

/// The Cast audio offer for an encoded-SLRW game: AAC-LC at the game's
/// rate and channels, when `aacenc` can encode that (`None`: offer the
/// default; the check below then finds no match and warns).
pub fn encoded_cast_audio(audio: Option<&RawAudioSpec>) -> Option<AudioFormat> {
    let a = audio?;
    let ok = a.sample_fmt == "s16le"
        && crate::media::aacenc::Encoder::new(a.sample_rate, a.channels, AAC_BITRATE_BPS).is_ok();
    ok.then_some(AudioFormat {
        codec: AudioCodec::AacLc,
        sample_rate: a.sample_rate,
        channels: a.channels,
    })
}

/// Which audio families an encoded-SLRW game's PCM can reach without
/// ffmpeg: AirPlay as PCM when its sinks take the game's rate and
/// channels, Cast as AAC-LC (`aacenc`) when its sinks negotiated AAC at
/// them (see [`encoded_cast_audio`]); plus a warning per family that gets
/// video only.
pub fn encoded_audio_families(
    audio: Option<&RawAudioSpec>,
    sinks: &[(&str, &Capabilities)],
) -> (Vec<(AudioFamily, AudioOut)>, Vec<String>) {
    let mut out = Vec::new();
    let mut warnings = Vec::new();
    let Some(a) = audio else {
        return (out, warnings);
    };
    for family in [AudioFamily::AirPlay, AudioFamily::Cast] {
        let of: Vec<_> = sinks
            .iter()
            .filter(|(_, c)| c.audio_family == family)
            .collect();
        if of.is_empty() {
            continue;
        }
        let (fmt, how) = match family {
            AudioFamily::AirPlay => (
                Some(AudioFormat {
                    codec: AudioCodec::PcmS16le,
                    sample_rate: a.sample_rate,
                    channels: a.channels,
                }),
                AudioOut::Pcm {
                    frame_samples: AIRPLAY_PCM_FRAME_SAMPLES,
                },
            ),
            AudioFamily::Cast => (
                encoded_cast_audio(Some(a)),
                AudioOut::AacLc {
                    bitrate_bps: AAC_BITRATE_BPS,
                },
            ),
        };
        let ok = a.sample_fmt == "s16le"
            && fmt.is_some_and(|f| {
                of.iter()
                    .all(|(_, c)| crate::media::formats::sink_takes(c, &f))
            });
        if ok {
            out.push((family, how));
        } else {
            // By name: the browser shares the AirPlay family's PCM.
            let names: Vec<&str> = of.iter().map(|(n, _)| *n).collect();
            warnings.push(format!(
                "{} cannot take the game's {} {} Hz {} ch audio; sending video only",
                names.join(", "),
                a.sample_fmt,
                a.sample_rate,
                a.channels
            ));
        }
    }
    (out, warnings)
}

/// Writes keyframe requests to the game (docs/slrw.md).
struct BackChannel {
    state: Arc<(Mutex<(bool, bool)>, Condvar)>,
    last: Option<Instant>,
}

impl BackChannel {
    fn start(mut out: Box<dyn Write + Send>) -> Result<BackChannel> {
        let state = Arc::new((Mutex::new((false, false)), Condvar::new()));
        let st = state.clone();
        std::thread::Builder::new()
            .name("slrw-keyframe".into())
            .spawn(move || loop {
                {
                    let (m, cv) = &*st;
                    let mut g = lock(m);
                    // (requested, shut down)
                    while !g.0 && !g.1 {
                        g = cv.wait(g).unwrap_or_else(|e| e.into_inner());
                    }
                    if g.1 {
                        return;
                    }
                    g.0 = false;
                }
                let r = out
                    .write_all(slrw::KEYFRAME_REQUEST_LINE)
                    .and_then(|()| out.flush());
                if let Err(e) = r {
                    debug!("slrw: keyframe back channel closed: {e}");
                    return;
                }
            })
            .map_err(|e| Error::io("spawn keyframe back channel", e))?;
        Ok(BackChannel { state, last: None })
    }

    fn request(&mut self) {
        let now = Instant::now();
        if self
            .last
            .is_some_and(|l| now.duration_since(l) < KEYFRAME_REQUEST_INTERVAL)
        {
            return;
        }
        self.last = Some(now);
        let (m, cv) = &*self.state;
        lock(m).0 = true;
        cv.notify_one();
    }
}

impl Drop for BackChannel {
    fn drop(&mut self) {
        let (m, cv) = &*self.state;
        lock(m).1 = true;
        cv.notify_one();
    }
}

/// Options for [`SlrwEncodedInput`].
pub struct EncodedOptions {
    pub video: RawVideoSpec,
    pub audio: Option<RawAudioSpec>,
    /// From [`encoded_audio_families`].
    pub audio_families: Vec<(AudioFamily, AudioOut)>,
    /// Where keyframe requests go once the game enables them (stdout).
    pub back_channel: Option<Box<dyn Write + Send>>,
}

/// Encoded H.264 + PCM from a game over SLRW (docs/slrw.md).
pub struct SlrwEncodedInput {
    rx: Receiver<std::io::Result<Option<Packet>>>,
    info: StreamInfo,
    st: EncodedState,
    stop: Stop,
}

/// One family's audio path for an encoded-SLRW game.
struct FamilyAudio {
    family: AudioFamily,
    /// Samples per channel per frame.
    frame: usize,
    /// PCM not yet cut into frames, and the pts (sample ticks) of its
    /// first sample.
    pcm: Vec<u8>,
    pcm_pts: Option<u64>,
    aac: Option<AacState>,
}

struct AacState {
    enc: crate::media::aacenc::Encoder,
    /// pts of input frame 0 (moved on a resync).
    base: i64,
    /// Frames fed / access units produced so far.
    fed: u64,
    produced: u64,
}

impl FamilyAudio {
    fn new(family: AudioFamily, how: AudioOut, a: &RawAudioSpec) -> Result<FamilyAudio> {
        let (frame, aac) = match how {
            AudioOut::Pcm { frame_samples } => (frame_samples.max(1) as usize, None),
            AudioOut::AacLc { bitrate_bps } => (
                crate::media::aacenc::FRAME_LEN,
                Some(AacState {
                    enc: crate::media::aacenc::Encoder::new(
                        a.sample_rate,
                        a.channels,
                        bitrate_bps,
                    )?,
                    base: 0,
                    fed: 0,
                    produced: 0,
                }),
            ),
        };
        Ok(FamilyAudio {
            family,
            frame,
            pcm: Vec::new(),
            pcm_pts: None,
            aac,
        })
    }

    fn info(&self, a: &RawAudioSpec) -> AudioInfo {
        match &self.aac {
            Some(s) => AudioInfo {
                codec: AudioCodec::AacLc,
                sample_rate: a.sample_rate,
                channels: a.channels,
                frame_samples: crate::media::aacenc::FRAME_LEN as u32,
                config: s.enc.audio_specific_config(),
            },
            None => AudioInfo {
                codec: AudioCodec::PcmS16le,
                sample_rate: a.sample_rate,
                channels: a.channels,
                frame_samples: self.frame as u32,
                config: Vec::new(),
            },
        }
    }

    /// Adds PCM whose first sample is due at `expected` (sample ticks).
    fn push(
        &mut self,
        payload: &[u8],
        expected: u64,
        bpf: usize,
        tolerance: u64,
        out: &mut VecDeque<EncodedFrame>,
    ) -> Result<()> {
        let buffered = (self.pcm.len() / bpf) as u64;
        let resync = match self.pcm_pts {
            Some(start) if (start + buffered).abs_diff(expected) <= tolerance => false,
            Some(start) => {
                debug!(
                    "slrw: {:?} audio resync: expected {} got {} samples",
                    self.family,
                    start + buffered,
                    expected
                );
                true
            }
            None => true,
        };
        if resync {
            self.pcm.clear();
            self.pcm_pts = Some(expected);
            if let Some(s) = &mut self.aac {
                s.base = expected as i64 - (s.fed * self.frame as u64) as i64;
            }
        }
        self.pcm.extend_from_slice(payload);
        let frame_bytes = self.frame * bpf;
        while self.pcm.len() >= frame_bytes {
            let chunk: Vec<u8> = self.pcm.drain(..frame_bytes).collect();
            let pts = self.pcm_pts.unwrap_or(0);
            self.pcm_pts = Some(pts + self.frame as u64);
            match &mut self.aac {
                None => out.push_back(self.frame_out(pts, chunk)),
                Some(s) => {
                    let samples: Vec<i16> = chunk
                        .chunks_exact(2)
                        .map(|b| i16::from_le_bytes([b[0], b[1]]))
                        .collect();
                    let au = s.enc.encode(&samples)?;
                    s.fed += 1;
                    self.emit_aac(au, out);
                }
            }
        }
        Ok(())
    }

    /// The access units still inside the AAC encoder (end of stream).
    fn flush(&mut self, out: &mut VecDeque<EncodedFrame>) {
        let units = match &mut self.aac {
            Some(s) => s.enc.flush(),
            None => return,
        };
        for au in units {
            self.emit_aac(au, out);
        }
    }

    fn emit_aac(&mut self, au: Vec<u8>, out: &mut VecDeque<EncodedFrame>) {
        let Some(s) = &mut self.aac else { return };
        // Access unit k holds input frame k - delay / frame.
        let pts = s.base + (s.produced * self.frame as u64) as i64 - s.enc.delay_samples() as i64;
        s.produced += 1;
        if pts >= 0 {
            out.push_back(self.frame_out(pts as u64, au));
        }
    }

    fn frame_out(&self, pts: u64, data: Vec<u8>) -> EncodedFrame {
        EncodedFrame {
            track: TrackKind::Audio(self.family),
            pts,
            keyframe: true,
            data: Arc::from(data),
        }
    }
}

/// The encoded-SLRW timeline and audio paths (docs/slrw.md), shared with
/// `media::builtin`, which feeds it the access units it encodes.
pub(crate) struct EncodedState {
    video: RawVideoSpec,
    audio: Option<RawAudioSpec>,
    families: Vec<FamilyAudio>,
    avcc: Option<Vec<u8>>,
    first_sps: Option<Vec<u8>>,
    /// A later SPS differed in its VUI only (logged once).
    vui_changed: bool,
    started: bool,
    origin_us: Option<u64>,
    last_video_pts: Option<u64>,
    bumped: bool,
    flag_mismatch: bool,
    dropped_before_key: u64,
    out: VecDeque<EncodedFrame>,
    back_out: Option<Box<dyn Write + Send>>,
    back: Option<BackChannel>,
    ended: bool,
}

impl SlrwEncodedInput {
    /// Starts reading `input` (the game's SLRW stream) and waits for the
    /// decoder configuration (an `h264-config` record or the first
    /// keyframe's SPS/PPS).
    pub fn open<R: Read + Send + 'static>(
        input: R,
        opts: EncodedOptions,
        stop: Stop,
    ) -> Result<Self> {
        if opts.video.pix_fmt != crate::media::slrw::ENCODED_PIX_FMT {
            return Err(Error::usage(
                "encoded SLRW input needs --raw-video WxH@FPS:h264",
            ));
        }
        let (tx, rx) = mpsc::sync_channel(SLRW_QUEUE);
        std::thread::Builder::new()
            .name("slrw-encoded".into())
            .spawn(move || {
                let mut r = SlrwReader::new(input).with_limits(slrw::MAX_H264_PAYLOAD, 16 << 20);
                loop {
                    let p = r.next_packet();
                    let last = !matches!(p, Ok(Some(_)));
                    if tx.send(p).is_err() || last {
                        return;
                    }
                }
            })
            .map_err(|e| Error::io("spawn SLRW reader", e))?;
        let mut me = SlrwEncodedInput {
            rx,
            info: StreamInfo {
                video: VideoInfo {
                    codec: VideoCodec::H264,
                    width: 0,
                    height: 0,
                    fps: opts.video.fps,
                    avcc: Vec::new(),
                },
                audio: Vec::new(),
            },
            st: EncodedState::new(
                opts.video,
                opts.audio,
                &opts.audio_families,
                opts.back_channel,
            )?,
            stop,
        };
        while !me.st.started {
            if me.st.ended {
                return Err(Error::closed(
                    "slrw: the game's stream ended before the first keyframe",
                ));
            }
            if !me.pump()? {
                return Err(Error::closed("slrw: stopped before the first keyframe"));
            }
        }
        me.info = me.st.stream_info()?;
        Ok(me)
    }

    /// Handles one record; `false` on a stop request.
    fn pump(&mut self) -> Result<bool> {
        loop {
            if self.stop.requested() {
                return Ok(false);
            }
            match self.rx.recv_timeout(STOP_POLL) {
                Ok(Ok(Some(p))) => {
                    self.st.handle(p)?;
                    return Ok(true);
                }
                Ok(Ok(None)) | Err(RecvTimeoutError::Disconnected) => {
                    self.st.end();
                    return Ok(true);
                }
                Ok(Err(e)) if e.kind() == io::ErrorKind::InvalidData => {
                    return Err(Error::malformed(e.to_string()))
                }
                Ok(Err(e)) => return Err(Error::io("read SLRW input", e)),
                Err(RecvTimeoutError::Timeout) => {}
            }
        }
    }
}

impl EncodedState {
    pub(crate) fn new(
        video: RawVideoSpec,
        audio: Option<RawAudioSpec>,
        audio_families: &[(AudioFamily, AudioOut)],
        back_out: Option<Box<dyn Write + Send>>,
    ) -> Result<EncodedState> {
        let mut families = Vec::new();
        if let Some(a) = &audio {
            if a.sample_fmt == "s16le" && a.channels > 0 {
                for &(family, how) in audio_families {
                    families.push(FamilyAudio::new(family, how, a)?);
                }
            }
        }
        Ok(EncodedState {
            video,
            audio,
            families,
            avcc: None,
            first_sps: None,
            vui_changed: false,
            started: false,
            origin_us: None,
            last_video_pts: None,
            bumped: false,
            flag_mismatch: false,
            dropped_before_key: 0,
            out: VecDeque::new(),
            back_out,
            back: None,
            ended: false,
        })
    }

    /// Fixes media time 0 (for records already relative to it).
    pub(crate) fn set_origin(&mut self, us: u64) {
        self.origin_us = Some(us);
    }

    pub(crate) fn started(&self) -> bool {
        self.started
    }

    pub(crate) fn ended(&self) -> bool {
        self.ended
    }

    /// The next frame ready for the fanout.
    pub(crate) fn pop(&mut self) -> Option<EncodedFrame> {
        self.out.pop_front()
    }

    /// The game's stream ended: emit what the encoders still hold.
    pub(crate) fn end(&mut self) {
        if !self.ended {
            self.ended = true;
            for f in &mut self.families {
                f.flush(&mut self.out);
            }
        }
    }

    pub(crate) fn stream_info(&self) -> Result<StreamInfo> {
        let avcc = self
            .avcc
            .clone()
            .ok_or_else(|| Error::malformed("slrw: no H.264 configuration"))?;
        let cfg = AvcConfig::parse(&avcc)?;
        let sps = h264::parse_sps(
            cfg.sps
                .first()
                .ok_or_else(|| Error::malformed("slrw: avcC without SPS"))?,
        )?;
        let want = &self.video.size;
        if (sps.width, sps.height) != (want.width, want.height) {
            warn!(
                "slrw: the game's H.264 is {}x{}, --raw-video says {}x{}",
                sps.width, sps.height, want.width, want.height
            );
        }
        let audio = match &self.audio {
            Some(a) => self
                .families
                .iter()
                .map(|f| (f.family, f.info(a)))
                .collect(),
            None => Vec::new(),
        };
        Ok(StreamInfo {
            video: VideoInfo {
                codec: VideoCodec::H264,
                width: sps.width,
                height: sps.height,
                fps: sps.fps.unwrap_or(self.video.fps),
                avcc,
            },
            audio,
        })
    }

    fn set_config(&mut self, avcc: Vec<u8>) -> Result<()> {
        let cfg = AvcConfig::parse(&avcc)?;
        let sps = cfg.sps.first().cloned();
        if self.started {
            if sps != self.first_sps && !self.vui_only(sps.as_deref()) {
                return Err(Error::unsupported(
                    "slrw: the H.264 configuration changed mid-stream",
                ));
            }
            return Ok(());
        }
        // Validate before accepting.
        h264::parse_sps(
            sps.as_deref()
                .ok_or_else(|| Error::malformed("slrw: H.264 configuration without SPS"))?,
        )?;
        let avcc = if cfg.length_size == 4 {
            avcc
        } else {
            AvcConfig {
                length_size: 4,
                ..cfg
            }
            .to_bytes()?
        };
        self.first_sps = sps;
        self.avcc = Some(avcc);
        Ok(())
    }

    /// A new SPS that differs from the first only in its VUI (slices
    /// decode the same; receivers keep the first). Logged once.
    fn vui_only(&mut self, sps: Option<&[u8]>) -> bool {
        let same = match (sps, &self.first_sps) {
            (Some(new), Some(first)) => h264::same_decoding(first, new),
            _ => false,
        };
        if same && !self.vui_changed {
            self.vui_changed = true;
            debug!("slrw: the H.264 SPS changed in its VUI only; keeping the first");
        }
        same
    }

    pub(crate) fn handle(&mut self, p: Packet) -> Result<()> {
        match p.kind {
            Kind::End => self.end(),
            Kind::Video => {
                return Err(Error::malformed(format!(
                    "slrw: raw video record in encoded mode (--raw-video ...:{}); \
                     use a pixel format for raw frames",
                    crate::media::slrw::ENCODED_PIX_FMT
                )))
            }
            Kind::Control => {
                let flags =
                    u32::from_le_bytes([p.payload[0], p.payload[1], p.payload[2], p.payload[3]]);
                if flags & slrw::CONTROL_KEYFRAME_REQUESTS != 0 {
                    if self.back.is_none() {
                        match self.back_out.take() {
                            Some(out) => {
                                debug!("slrw: keyframe requests enabled");
                                self.back = Some(BackChannel::start(out)?);
                            }
                            None => debug!("slrw: keyframe requests unavailable"),
                        }
                    }
                } else if self.back.is_some() {
                    // Disabling drops the writer; it cannot be enabled again.
                    self.back = None;
                }
            }
            Kind::H264Config => {
                let data = &p.payload[1..];
                let avcc = match p.payload[0] {
                    slrw::CONFIG_AVCC => {
                        let mut cfg = AvcConfig::parse(data)?;
                        if cfg.undouble_headers() {
                            debug!("slrw: the avcC's parameter sets have doubled NAL headers (Firefox); removed");
                            cfg.to_bytes()?
                        } else {
                            data.to_vec()
                        }
                    }
                    slrw::CONFIG_ANNEX_B => {
                        let (sps, pps) = parameter_sets(h264::annexb_nals(data));
                        AvcConfig::from_parameter_sets(sps, pps)?.to_bytes()?
                    }
                    n => {
                        return Err(Error::malformed(format!(
                            "slrw: unknown h264-config format {n}"
                        )))
                    }
                };
                self.set_config(avcc)?;
            }
            Kind::H264 => self.video(p)?,
            Kind::Audio => self.audio(p)?,
        }
        Ok(())
    }

    fn video(&mut self, p: Packet) -> Result<()> {
        let flags = p.payload[0];
        let body = &p.payload[1..];
        let data = if flags & slrw::H264_ANNEX_B != 0 {
            h264::annexb_to_avcc(body)
        } else {
            for nal in h264::avcc_nals(body, 4) {
                nal.map_err(|_| {
                    Error::malformed("slrw: h264 record is not AVCC (4-byte lengths)")
                })?;
            }
            body.to_vec()
        };
        if data.is_empty() {
            return Err(Error::malformed("slrw: empty h264 access unit"));
        }
        let (sps, pps) = parameter_sets(h264::avcc_nals(&data, 4).filter_map(|n| n.ok()));
        if !sps.is_empty() && !pps.is_empty() {
            if !self.started && self.avcc.is_none() {
                self.set_config(AvcConfig::from_parameter_sets(sps, pps)?.to_bytes()?)?;
            } else if self.started
                && sps.first() != self.first_sps.as_ref()
                && !self.vui_only(sps.first().map(Vec::as_slice))
            {
                return Err(Error::unsupported(
                    "slrw: the H.264 SPS changed mid-stream (a resolution change?)",
                ));
            }
        }
        let key = h264::is_idr(&data, 4)?;
        if key != (flags & slrw::H264_KEYFRAME != 0) && !self.flag_mismatch {
            self.flag_mismatch = true;
            warn!("slrw: h264 keyframe flag does not match the access unit (IDR: {key}); using the access unit");
        }
        if !self.started {
            if !key {
                self.dropped_before_key += 1;
                return Ok(());
            }
            if self.avcc.is_none() {
                return Err(Error::malformed(
                    "slrw: first keyframe without SPS/PPS and no h264-config record",
                ));
            }
            self.started = true;
            if self.dropped_before_key > 0 {
                debug!(
                    "slrw: dropped {} frames before the first keyframe",
                    self.dropped_before_key
                );
            }
        }
        let origin = *self.origin_us.get_or_insert(p.pts_us);
        let rel = p.pts_us.saturating_sub(origin) as u128;
        let mut pts = ((rel * VIDEO_CLOCK_RATE as u128 + 500_000) / 1_000_000) as u64;
        if let Some(last) = self.last_video_pts {
            if pts <= last {
                if !self.bumped {
                    self.bumped = true;
                    warn!("slrw: h264 pts_us does not increase (B-frames?); adjusting");
                }
                pts = last + 1;
            }
        }
        self.last_video_pts = Some(pts);
        self.out.push_back(EncodedFrame {
            track: TrackKind::Video,
            pts,
            keyframe: key,
            data: Arc::from(data),
        });
        Ok(())
    }

    fn audio(&mut self, p: Packet) -> Result<()> {
        let (Some(a), false) = (&self.audio, self.families.is_empty()) else {
            return Ok(());
        };
        let bpf = a.channels as usize * 2;
        if a.sample_fmt != "s16le" || bpf == 0 {
            return Ok(());
        }
        if p.payload.len() % bpf != 0 {
            return Err(Error::malformed(format!(
                "slrw: audio record of {} bytes is not a whole number of samples",
                p.payload.len()
            )));
        }
        let rate = a.sample_rate as u128;
        let origin = *self.origin_us.get_or_insert(p.pts_us);
        let expected = (p.pts_us.saturating_sub(origin) as u128 * rate / 1_000_000) as u64;
        let tolerance = (AUDIO_RESYNC.as_micros() * rate / 1_000_000) as u64;
        for f in &mut self.families {
            f.push(&p.payload, expected, bpf, tolerance, &mut self.out)?;
        }
        Ok(())
    }
}

fn parameter_sets<'a>(nals: impl Iterator<Item = &'a [u8]>) -> (Vec<Vec<u8>>, Vec<Vec<u8>>) {
    let (mut sps, mut pps) = (Vec::new(), Vec::new());
    for nal in nals {
        match h264::nal_unit_type(nal) {
            Some(h264::nal_type::SPS) => sps.push(nal.to_vec()),
            Some(h264::nal_type::PPS) => pps.push(nal.to_vec()),
            _ => {}
        }
    }
    (sps, pps)
}

impl Input for SlrwEncodedInput {
    fn info(&self) -> &StreamInfo {
        &self.info
    }

    fn next_frame(&mut self) -> Result<Option<EncodedFrame>> {
        loop {
            if let Some(f) = self.st.out.pop_front() {
                return Ok(Some(f));
            }
            if self.st.ended {
                return Ok(None);
            }
            if !self.pump()? {
                return Ok(None);
            }
        }
    }

    fn request_keyframe(&mut self) -> bool {
        match &mut self.st.back {
            Some(b) => {
                b.request();
                true
            }
            None => false,
        }
    }

    fn describe(&self) -> String {
        "SLRW encoded H.264".into()
    }

    fn finish(self: Box<Self>, _clean_eof: bool) -> Result<()> {
        // The reader thread may be blocked on the game's stdin; it ends
        // with the process (like the raw forwarder).
        Ok(())
    }
}

#[cfg(feature = "files")]
/// The paths a file input could be passed through from (`play FILE`).
pub fn passthrough_candidate(opts: &PlayOptions) -> Option<PathBuf> {
    match &opts.input {
        crate::opts::InputSpec::Path(p) => {
            let p = Path::new(p);
            passthrough::container_of(p).map(|_| p.to_owned())
        }
        _ => None,
    }
}

#[cfg(all(test, feature = "ffmpeg", feature = "cast"))]
pub(crate) mod tests {
    use super::*;
    use crate::media::passthrough::tests::{caps, fixture};
    use crate::opts::Size;
    use crate::util::ratio::Ratio;

    fn never() -> crate::util::stop::Stop {
        crate::util::stop::Stop::new()
    }

    fn drain(input: &mut dyn Input) -> Vec<EncodedFrame> {
        let mut out = Vec::new();
        while let Some(f) = input.next_frame().unwrap() {
            out.push(f);
        }
        out
    }

    #[test]
    fn passthrough_paced_and_looped() {
        let plan = PassPlan {
            audio_families: vec![AudioFamily::AirPlay, AudioFamily::Cast],
        };
        let mut input =
            PassthroughInput::open(&fixture("bf0.mp4"), &plan, true, true, never()).unwrap();
        assert_eq!(input.info().audio.len(), 2);
        assert_eq!(input.describe(), "passthrough MP4");
        let t0 = Instant::now();
        let mut frames = Vec::new();
        // Two passes of the 1 s file plus a bit: 30 video frames each.
        while frames
            .iter()
            .filter(|f: &&EncodedFrame| f.track == TrackKind::Video)
            .count()
            < 65
        {
            frames.push(input.next_frame().unwrap().unwrap());
        }
        let elapsed = t0.elapsed();
        // Paced: frame 64 is due ~2.13 s after frame 0.
        assert!(elapsed >= Duration::from_millis(2050), "{elapsed:?}");
        assert!(elapsed < Duration::from_millis(2600), "{elapsed:?}");
        let video: Vec<u64> = frames
            .iter()
            .filter(|f| f.track == TrackKind::Video)
            .map(|f| f.pts)
            .collect();
        assert!(video.windows(2).all(|w| w[1] > w[0]));
        // The second pass continues the timeline (frame 30 = 1 s + start).
        let pass = video[30] - video[0];
        assert!((90_000..=93_000).contains(&pass), "{pass}");
        assert!(video[30] - video[29] >= 3000);
        let airplay = frames
            .iter()
            .filter(|f| f.track == TrackKind::Audio(AudioFamily::AirPlay))
            .count();
        let cast = frames
            .iter()
            .filter(|f| f.track == TrackKind::Audio(AudioFamily::Cast))
            .count();
        assert_eq!(airplay, cast);
        assert!(airplay > 90);
        Box::new(input).finish(true).unwrap();
    }

    #[test]
    fn bframe_experiment_orders() {
        let plan = PassPlan {
            audio_families: vec![],
        };
        let open = |r| {
            let mut i =
                PassthroughInput::open(&fixture("bframes.mp4"), &plan, false, false, never())
                    .unwrap();
            i.set_reorder(r);
            i
        };
        assert!(drain_result(&mut open(None)).is_err());
        let dts = drain(&mut open(Some(ReorderStamp::Dts)));
        assert_eq!(dts.len(), 30);
        assert!(dts.windows(2).all(|w| w[1].pts > w[0].pts));
        let pts = drain(&mut open(Some(ReorderStamp::Pts)));
        assert_eq!(pts.len(), 30);
        assert!(pts.windows(2).any(|w| w[1].pts < w[0].pts));
        // The same set of presentation times, decode-order shuffled.
        let mut sorted: Vec<u64> = pts.iter().map(|f| f.pts).collect();
        sorted.sort();
        assert!(sorted.windows(2).all(|w| w[1] - w[0] == 3000));
    }

    fn drain_result(input: &mut dyn Input) -> Result<usize> {
        let mut n = 0;
        while input.next_frame()?.is_some() {
            n += 1;
        }
        Ok(n)
    }

    #[test]
    fn passthrough_pcm_in_airplay_frames() {
        let plan = PassPlan {
            audio_families: vec![AudioFamily::AirPlay],
        };
        let mut input =
            PassthroughInput::open(&fixture("pcm.mov"), &plan, false, false, never()).unwrap();
        let a = input
            .info()
            .audio_for(AudioFamily::AirPlay)
            .unwrap()
            .clone();
        assert_eq!((a.codec, a.frame_samples), (AudioCodec::PcmS16le, 352));
        let audio: Vec<EncodedFrame> = drain(&mut input)
            .into_iter()
            .filter(|f| f.track != TrackKind::Video)
            .collect();
        let (last, full) = audio.split_last().unwrap();
        assert!(full.iter().all(|f| f.data.len() == 352 * 4));
        assert!(audio.windows(2).all(|w| w[1].pts - w[0].pts == 352));
        let total: usize = audio.iter().map(|f| f.data.len() / 4).sum();
        assert_eq!(total, 48_000);
        assert!(last.data.len() <= 352 * 4);
    }

    #[test]
    fn passthrough_unpaced_video_only() {
        let plan = PassPlan {
            audio_families: vec![],
        };
        let mut input =
            PassthroughInput::open(&fixture("live.mkv"), &plan, false, false, never()).unwrap();
        assert!(input.info().audio.is_empty());
        let t0 = Instant::now();
        let frames = drain(&mut input);
        assert!(t0.elapsed() < Duration::from_millis(500));
        assert_eq!(frames.len(), 30);
        assert!(frames.iter().all(|f| f.track == TrackKind::Video));
        assert_eq!(input.describe(), "passthrough Matroska");
    }

    #[test]
    fn passthrough_stops_on_request() {
        let after_some = Stop::new();
        let s = after_some.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(300));
            s.request();
        });
        let plan = PassPlan {
            audio_families: vec![],
        };
        let mut input =
            PassthroughInput::open(&fixture("bf0.mp4"), &plan, true, true, after_some).unwrap();
        let t0 = Instant::now();
        let n = drain(&mut input).len();
        assert!(n < 30, "{n}");
        assert!(t0.elapsed() < Duration::from_secs(3));
    }

    fn decide(name: &str, opts: &PlayOptions, sinks: &[(&str, &Capabilities)]) -> FileDecision {
        decide_file(&passthrough::probe(&fixture(name)), opts, sinks)
    }

    fn play_opts() -> PlayOptions {
        PlayOptions {
            threads: 0,
            to: vec!["tv".into()],
            reconnect: std::time::Duration::ZERO,
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
            input: crate::opts::InputSpec::Path(fixture("bf0.mp4").into()),
        }
    }

    #[test]
    fn deciding() {
        let cast_aac = caps(AudioFamily::Cast, &[(AudioCodec::AacLc, 48_000, 2)]);
        let sinks = [("tv", &cast_aac)];
        assert!(matches!(
            decide("bf0.mp4", &play_opts(), &sinks),
            FileDecision::Passthrough { .. }
        ));
        assert_eq!(
            passthrough_candidate(&play_opts()),
            Some(fixture("bf0.mp4"))
        );
        let o = PlayOptions {
            bitrate_kbps: Some(500),
            ..play_opts()
        };
        assert_eq!(
            decide("bf0.mp4", &o, &sinks),
            FileDecision::Ffmpeg {
                why: "re-encoding because of --bitrate".into()
            }
        );
        let FileDecision::Ffmpeg { why } = decide("bframes.mp4", &play_opts(), &sinks) else {
            panic!()
        };
        assert!(
            why.starts_with("encoding with ffmpeg: the video has B-frames"),
            "{why}"
        );
        let FileDecision::Ffmpeg { why } = decide("nope.mp4", &play_opts(), &sinks) else {
            panic!()
        };
        assert!(why.starts_with("cannot pass the file through"), "{why}");
        let opus = caps(AudioFamily::Cast, &[(AudioCodec::Opus, 48_000, 2)]);
        let o = PlayOptions {
            no_audio: true,
            ..play_opts()
        };
        let FileDecision::Passthrough { plan, .. } = decide("bf0.mp4", &o, &[("tv", &opus)]) else {
            panic!()
        };
        assert!(plan.audio_families.is_empty());
    }

    /// An H.264 elementary stream (Annex B) from ffmpeg: 30 frames, GOP 10.
    pub(crate) fn annexb_stream() -> Option<Vec<u8>> {
        let (bin, _) = crate::media::ffmpeg::tests::real_ffmpeg()?;
        let out = std::process::Command::new(bin)
            .args(["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i"])
            .arg("testsrc2=size=160x120:rate=30")
            .args(["-frames:v", "30", "-c:v", "libx264", "-tune", "zerolatency"])
            .args(["-g", "10", "-bf", "0", "-pix_fmt", "yuv420p"])
            .args(["-bsf:v", "h264_metadata=aud=insert", "-f", "h264", "-"])
            .output()
            .ok()?;
        out.status.success().then_some(out.stdout)
    }

    /// Splits an Annex B stream with AUDs into access units.
    pub(crate) fn access_units(stream: &[u8]) -> Vec<Vec<u8>> {
        let mut aus: Vec<Vec<u8>> = Vec::new();
        for nal in h264::annexb_nals(stream) {
            if h264::nal_unit_type(nal) == Some(h264::nal_type::AUD) || aus.is_empty() {
                aus.push(Vec::new());
            }
            let au = aus.last_mut().unwrap();
            au.extend_from_slice(&[0, 0, 0, 1]);
            au.extend_from_slice(nal);
        }
        aus.retain(|a| h264::annexb_nals(a).any(|n| matches!(h264::nal_unit_type(n), Some(1 | 5))));
        aus
    }

    #[derive(Clone, Default)]
    pub(crate) struct SharedBuf(pub(crate) Arc<Mutex<Vec<u8>>>);

    impl Write for SharedBuf {
        fn write(&mut self, b: &[u8]) -> io::Result<usize> {
            lock(&self.0).extend_from_slice(b);
            Ok(b.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    fn encoded_opts(back: Option<Box<dyn Write + Send>>) -> EncodedOptions {
        EncodedOptions {
            video: RawVideoSpec {
                size: Size {
                    width: 160,
                    height: 120,
                },
                fps: Ratio::integer(30),
                pix_fmt: "h264".into(),
            },
            audio: Some(RawAudioSpec {
                sample_rate: 44_100,
                channels: 2,
                sample_fmt: "s16le".into(),
            }),
            audio_families: vec![
                (
                    AudioFamily::AirPlay,
                    AudioOut::Pcm {
                        frame_samples: AIRPLAY_PCM_FRAME_SAMPLES,
                    },
                ),
                (
                    AudioFamily::Cast,
                    AudioOut::AacLc {
                        bitrate_bps: AAC_BITRATE_BPS,
                    },
                ),
            ],
            back_channel: back,
        }
    }

    #[test]
    fn slrw_encoded_end_to_end() {
        let Some(stream) = annexb_stream() else {
            return;
        };
        let aus = access_units(&stream);
        assert_eq!(aus.len(), 30);
        let mut s = Vec::new();
        slrw::write_magic(&mut s).unwrap();
        slrw::write_control(&mut s, slrw::CONTROL_KEYFRAME_REQUESTS).unwrap();
        // A delta frame before the first keyframe is dropped; frames go as
        // AVCC for odd and Annex B for even indices.
        slrw::write_h264(&mut s, 0, false, true, &aus[1]).unwrap();
        let mut samples = 0u64;
        for (i, au) in aus.iter().enumerate() {
            let pts = 1_000_000 + i as u64 * 33_333;
            let key = i % 10 == 0;
            if i % 2 == 0 {
                slrw::write_h264(&mut s, pts, key, true, au).unwrap();
            } else {
                slrw::write_h264(&mut s, pts, key, false, &h264::annexb_to_avcc(au)).unwrap();
            }
            // 1470 samples (1/30 s at 44.1 kHz) per video frame.
            let audio_pts = 1_000_000 + samples * 1_000_000 / 44_100;
            slrw::write_packet(&mut s, Kind::Audio, audio_pts, &[7u8; 1470 * 4]).unwrap();
            samples += 1470;
        }
        slrw::write_packet(&mut s, Kind::End, 0, &[]).unwrap();
        let back = SharedBuf::default();
        let mut input = SlrwEncodedInput::open(
            io::Cursor::new(s),
            encoded_opts(Some(Box::new(back.clone()))),
            never(),
        )
        .unwrap();
        let info = input.info().clone();
        assert_eq!((info.video.width, info.video.height), (160, 120));
        assert_eq!(info.video.fps, Ratio::integer(30));
        assert_eq!(AvcConfig::parse(&info.video.avcc).unwrap().length_size, 4);
        let a = info.audio_for(AudioFamily::AirPlay).unwrap();
        assert_eq!((a.codec, a.frame_samples), (AudioCodec::PcmS16le, 352));
        let c = info.audio_for(AudioFamily::Cast).unwrap();
        assert_eq!((c.codec, c.frame_samples), (AudioCodec::AacLc, 1024));
        assert_eq!(
            crate::media::formats::parse_asc(&c.config).unwrap(),
            (2, 44_100, 2, 1024)
        );
        let frames = drain(&mut input);
        let video: Vec<&EncodedFrame> = frames
            .iter()
            .filter(|f| f.track == TrackKind::Video)
            .collect();
        assert_eq!(video.len(), 30);
        assert_eq!(video[0].pts, 0);
        assert_eq!(video[1].pts, 3000);
        let keys: Vec<usize> = video
            .iter()
            .enumerate()
            .filter(|(_, f)| f.keyframe)
            .map(|(i, _)| i)
            .collect();
        assert_eq!(keys, [0, 10, 20]);
        for f in &video {
            assert!(h264::avcc_nals(&f.data, 4).all(|n| n.is_ok()));
        }
        let audio: Vec<&EncodedFrame> = frames
            .iter()
            .filter(|f| f.track == TrackKind::Audio(AudioFamily::AirPlay))
            .collect();
        // AAC for Cast: 44100 samples in 1024-sample units; the encoder's
        // two units of delay are dropped at the start, flushed at the end.
        let aac: Vec<&EncodedFrame> = frames
            .iter()
            .filter(|f| f.track == TrackKind::Audio(AudioFamily::Cast))
            .collect();
        assert_eq!(aac.len(), 30 * 1470 / 1024);
        assert_eq!(aac[0].pts, 0);
        assert!(aac.windows(2).all(|w| w[1].pts - w[0].pts == 1024));
        assert!(aac
            .iter()
            .all(|f| !f.data.is_empty() && f.data.len() < 2000));
        assert_eq!(audio.len(), (30 * 1470) / 352);
        assert!(audio.iter().all(|f| f.data.len() == 352 * 4));
        assert!(audio.windows(2).all(|w| w[1].pts - w[0].pts == 352));
        assert_eq!(audio[0].pts, 0);
        // Keyframe requests: written once, then rate-limited.
        assert!(input.request_keyframe());
        assert!(input.request_keyframe());
        let t0 = Instant::now();
        while lock(&back.0).is_empty() && t0.elapsed() < Duration::from_secs(2) {
            std::thread::sleep(Duration::from_millis(5));
        }
        std::thread::sleep(Duration::from_millis(20));
        assert_eq!(&*lock(&back.0), b"keyframe\n");
        std::thread::sleep(KEYFRAME_REQUEST_INTERVAL);
        input.request_keyframe();
        let t0 = Instant::now();
        while lock(&back.0).len() < 18 && t0.elapsed() < Duration::from_secs(2) {
            std::thread::sleep(Duration::from_millis(5));
        }
        assert_eq!(&*lock(&back.0), b"keyframe\nkeyframe\n");
        Box::new(input).finish(true).unwrap();
    }

    #[test]
    fn slrw_encoded_config_record_and_errors() {
        let Some(stream) = annexb_stream() else {
            return;
        };
        let aus = access_units(&stream);
        // Parameter sets via h264-config (Annex B); frames stripped of them.
        let (sps, pps) = parameter_sets(h264::annexb_nals(&aus[0]));
        let mut cfg = Vec::new();
        for n in sps.iter().chain(&pps) {
            cfg.extend_from_slice(&[0, 0, 1]);
            cfg.extend_from_slice(n);
        }
        let strip = |au: &[u8]| -> Vec<u8> {
            let mut out = Vec::new();
            for n in h264::annexb_nals(au) {
                if !matches!(h264::nal_unit_type(n), Some(7 | 8)) {
                    out.extend_from_slice(&(n.len() as u32).to_be_bytes());
                    out.extend_from_slice(n);
                }
            }
            out
        };
        let mut s = Vec::new();
        slrw::write_magic(&mut s).unwrap();
        slrw::write_h264_config(&mut s, slrw::CONFIG_ANNEX_B, &cfg).unwrap();
        for (i, au) in aus.iter().take(3).enumerate() {
            slrw::write_h264(&mut s, i as u64 * 33_333, i == 0, false, &strip(au)).unwrap();
        }
        let mut input =
            SlrwEncodedInput::open(io::Cursor::new(s.clone()), encoded_opts(None), never())
                .unwrap();
        assert_eq!(drain(&mut input).len(), 3);
        // Keyframe requests are off without a control record.
        assert!(!input.request_keyframe());

        // A keyframe without parameter sets and no config record.
        let mut s = Vec::new();
        slrw::write_magic(&mut s).unwrap();
        slrw::write_h264(&mut s, 0, true, false, &strip(&aus[0])).unwrap();
        let e = SlrwEncodedInput::open(io::Cursor::new(s), encoded_opts(None), never())
            .err()
            .unwrap();
        assert!(e.to_string().contains("without SPS/PPS"), "{e}");
        // Raw video in encoded mode.
        let mut s = Vec::new();
        slrw::write_magic(&mut s).unwrap();
        slrw::write_packet(&mut s, Kind::Video, 0, &[0; 16]).unwrap();
        assert!(SlrwEncodedInput::open(io::Cursor::new(s), encoded_opts(None), never()).is_err());
        // Garbage that is not AVCC.
        let mut s = Vec::new();
        slrw::write_magic(&mut s).unwrap();
        slrw::write_h264(&mut s, 0, true, false, &[0, 0, 0, 9, 1]).unwrap();
        assert!(SlrwEncodedInput::open(io::Cursor::new(s), encoded_opts(None), never()).is_err());
        // Ends before a keyframe.
        let mut s = Vec::new();
        slrw::write_magic(&mut s).unwrap();
        assert!(SlrwEncodedInput::open(io::Cursor::new(s), encoded_opts(None), never()).is_err());
    }

    /// Firefox 160 on Linux doubles the NAL headers in its avcC (tvpipe
    /// issue #6): the stream gets the record without them.
    #[test]
    fn slrw_encoded_firefox_avcc() {
        let data = crate::util::hex::decode(h264::tests::FIREFOX_DOUBLED_AVCC).unwrap();
        let mut st = EncodedState::new(encoded_opts(None).video, None, &[], None).unwrap();
        let mut payload = vec![slrw::CONFIG_AVCC];
        payload.extend_from_slice(&data);
        st.handle(Packet {
            kind: Kind::H264Config,
            pts_us: 0,
            payload,
        })
        .unwrap();
        let info = st.stream_info().unwrap();
        assert_eq!((info.video.width, info.video.height), (1920, 1080));
        let cfg = AvcConfig::parse(&info.video.avcc).unwrap();
        assert_eq!(cfg.sps[0][..2], [0x67, 0x42]);
        assert_eq!(cfg.pps[0], [0x68, 0xcb, 0x8c, 0xb2]);
    }

    #[test]
    fn encoded_audio_routing() {
        let spec = RawAudioSpec {
            sample_rate: 44_100,
            channels: 2,
            sample_fmt: "s16le".into(),
        };
        // The AirPlay sink advertises ALAC and takes PCM.
        let ap = caps(AudioFamily::AirPlay, &[(AudioCodec::Alac, 44_100, 2)]);
        let cast = caps(AudioFamily::Cast, &[(AudioCodec::Opus, 48_000, 2)]);
        let (fams, warns) = encoded_audio_families(Some(&spec), &[("atv", &ap), ("tv", &cast)]);
        assert_eq!(
            fams,
            [(AudioFamily::AirPlay, AudioOut::Pcm { frame_samples: 352 })]
        );
        assert_eq!(warns.len(), 1);
        assert!(warns[0].starts_with("tv cannot take"), "{}", warns[0]);
        let cast_aac = caps(AudioFamily::Cast, &[(AudioCodec::AacLc, 44_100, 2)]);
        let (fams, warns) = encoded_audio_families(Some(&spec), &[("tv", &cast_aac)]);
        assert_eq!(
            fams,
            [(
                AudioFamily::Cast,
                AudioOut::AacLc {
                    bitrate_bps: AAC_BITRATE_BPS
                }
            )]
        );
        assert!(warns.is_empty());
        assert_eq!(
            encoded_cast_audio(Some(&spec)),
            Some(AudioFormat {
                codec: AudioCodec::AacLc,
                sample_rate: 44_100,
                channels: 2
            })
        );
        let odd = RawAudioSpec {
            sample_rate: 44_000,
            ..spec.clone()
        };
        assert_eq!(encoded_cast_audio(Some(&odd)), None);
        assert_eq!(encoded_audio_families(None, &[("atv", &ap)]).0, []);
    }

    /// ffmpeg through the trait (what session.rs does today).
    #[test]
    fn ffmpeg_input_through_the_trait() {
        let Some((bin, probe)) = crate::media::ffmpeg::tests::real_ffmpeg() else {
            return;
        };
        let mut plan = crate::media::ffmpeg::tests::plan();
        plan.video.width = 160;
        plan.video.height = 120;
        plan.video.bitrate_kbps = 200;
        let src = Source::Url {
            url: fixture("live.mkv").into(),
            realtime: false,
            looped: false,
        };
        let input = FfmpegInput::start(&bin, &probe, &src, &plan, None, never()).unwrap();
        let mut input: Box<dyn Input> = Box::new(input);
        assert!(input.describe().starts_with("ffmpeg"));
        let frames = drain(&mut *input);
        assert!(
            frames
                .iter()
                .filter(|f| f.track == TrackKind::Video)
                .count()
                >= 29
        );
        assert!(!input.request_keyframe());
        input.finish(true).unwrap();
    }
}

/// Experiments for docs/measurements.md: passthrough of ffmpeg-made
/// files to a real Cast receiver (openscreen's, see
/// `scripts/receivers/cast-receiver.sh`), frames sent in decode order.
///
/// ```sh
/// TVPIPE_PT_KIND=bframes TVPIPE_PT_ORDER=pts \
///     cargo test media::input::experiments -- --ignored --nocapture
/// ```
///
/// - `TVPIPE_CAST_ADDR` (default `127.0.0.1:8010`), `TVPIPE_PT_SECS`
///   (10), `TVPIPE_PT_LATENCY` (playout delay, 400 ms).
/// - `TVPIPE_PT_KIND`: `bf0` (no B-frames), `bframes` (x264 `-bf 3`,
///   B-pyramid), or `TVPIPE_PT_FILE` for any MP4/MKV file.
/// - `TVPIPE_PT_ORDER`: the timestamp each frame carries: `pts` (its
///   presentation time; the Cast sink keeps RTP timestamps increasing, so
///   reordered frames get bumped ones) or `dts` (its decode time).
/// - `TVPIPE_PT_AUDIO=1`: also send the file's audio (AAC-LC for the
///   generated files) if the receiver chose a matching codec;
///   `TVPIPE_PT_ADTS=1` wraps AAC access units in ADTS headers.
#[cfg(all(test, feature = "ffmpeg", feature = "cast"))]
mod experiments {
    use super::*;
    use crate::cast::{connect, CastOptions};
    use crate::types::{Sink, SinkStatus};
    use crate::util::ratio::Ratio;

    /// A 7-byte ADTS header (ISO/IEC 13818-7 §6.2, MPEG-4 ID, no CRC).
    fn adts(asc: &[u8], au: &[u8]) -> Vec<u8> {
        let (aot, _, ch, _) = crate::media::formats::parse_asc(asc).unwrap();
        let idx = ((asc[0] & 0x07) << 1) | (asc[1] >> 7);
        let len = au.len() + 7;
        let mut h = vec![
            0xff,
            0xf1,
            (((aot - 1) as u8) << 6) | (idx << 2) | (ch >> 2),
            ((ch & 3) << 6) | ((len >> 11) as u8 & 0x03),
            (len >> 3) as u8,
            (((len & 7) as u8) << 5) | 0x1f,
            0xfc,
        ];
        h.extend_from_slice(au);
        h
    }

    fn env(name: &str, default: &str) -> String {
        std::env::var(name).unwrap_or_else(|_| default.into())
    }

    fn generate(kind: &str, secs: u32) -> PathBuf {
        let (bin, _) = crate::media::ffmpeg::tests::real_ffmpeg().expect("ffmpeg");
        let path = std::env::temp_dir().join(format!("tvpipe-pt-{kind}-{secs}.mp4"));
        let bf: &[&str] = match kind {
            "bf0" => &["-bf", "0", "-tune", "zerolatency"],
            "bframes" => &["-bf", "3", "-b-pyramid", "normal"],
            other => panic!("unknown TVPIPE_PT_KIND {other}"),
        };
        let ok = std::process::Command::new(bin)
            .args(["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi"])
            .args(["-i", "testsrc2=size=1280x720:rate=30", "-f", "lavfi"])
            .args(["-i", "sine=frequency=440:sample_rate=48000", "-t"])
            .arg(secs.to_string())
            .args(["-c:v", "libx264", "-preset", "veryfast", "-g", "60"])
            .args(bf)
            .args([
                "-b:v", "3M", "-pix_fmt", "yuv420p", "-c:a", "aac", "-ac", "2",
            ])
            .arg(&path)
            .status()
            .is_ok_and(|s| s.success());
        assert!(ok, "ffmpeg failed");
        path
    }

    #[test]
    #[ignore = "needs a Cast receiver (scripts/receivers/cast-receiver.sh)"]
    fn passthrough_to_cast_receiver() {
        let addr: std::net::SocketAddr = env("TVPIPE_CAST_ADDR", "127.0.0.1:8010").parse().unwrap();
        let secs: u32 = env("TVPIPE_PT_SECS", "10").parse().unwrap();
        let order = env("TVPIPE_PT_ORDER", "pts");
        let path = match std::env::var("TVPIPE_PT_FILE") {
            Ok(p) => PathBuf::from(p),
            Err(_) => generate(&env("TVPIPE_PT_KIND", "bf0"), secs),
        };
        crate::log::set_level(Level::Debug);
        let info = passthrough::probe(&path).unwrap();
        eprintln!(
            "file: {:?} {}x{}@{} reorders={} reorder_frames={:?} kbps={:?}",
            info.video.codec,
            info.video.width,
            info.video.height,
            info.video.fps,
            info.reorders,
            info.sps.as_ref().and_then(|s| s.max_num_reorder_frames),
            info.video_kbps
        );
        let opts = CastOptions {
            latency_ms: env("TVPIPE_PT_LATENCY", "400").parse().unwrap(),
            max_width: info.video.width,
            max_height: info.video.height,
            max_fps: Ratio::integer(30),
            max_bitrate_kbps: 8000,
            audio: env("TVPIPE_PT_AUDIO", "0") == "1",
            ..CastOptions::default()
        };
        let mut sink = connect(addr, "cast-receiver", &opts).expect("connect");
        let caps = sink.capabilities().clone();
        let verdict = passthrough::check(&info, &[("rx", &caps)], CheckOptions::default());
        eprintln!("check: {verdict:?}");
        let audio = info.audio.clone().filter(|a| {
            caps.accepts_audio(&AudioFormat {
                codec: a.codec,
                sample_rate: a.sample_rate,
                channels: a.channels,
            })
        });
        eprintln!("audio: {:?}", audio.as_ref().map(|a| a.codec));
        sink.start(&info.video, audio.as_ref()).expect("start");
        let mut src = FileSource::open(&path).unwrap();
        let start = Instant::now();
        let (mut sent, mut dropped, mut reordered) = (0, 0, 0);
        let mut last_pts = None;
        let mut audio_frames = 0;
        while let Some(f) = src.next_frame().unwrap() {
            if f.frame.track != TrackKind::Video {
                let Some(a) = &audio else { continue };
                let due = start + ticks_to_duration(f.dts, a.sample_rate);
                std::thread::sleep(due.saturating_duration_since(Instant::now()));
                let data = if env("TVPIPE_PT_ADTS", "0") == "1" {
                    Arc::from(adts(&a.config, &f.frame.data))
                } else {
                    f.frame.data.clone()
                };
                let frame = EncodedFrame {
                    track: TrackKind::Audio(AudioFamily::Cast),
                    data,
                    ..f.frame
                };
                if sink.push(&frame).unwrap() == SinkStatus::Accepted {
                    audio_frames += 1;
                }
                continue;
            }
            // Frames leave in decode order at their decode time.
            let due = start + ticks_to_duration(f.dts, VIDEO_CLOCK_RATE);
            std::thread::sleep(due.saturating_duration_since(Instant::now()));
            if last_pts.is_some_and(|l| f.frame.pts < l) {
                reordered += 1;
            }
            last_pts = Some(f.frame.pts);
            let pts = if order == "dts" { f.dts } else { f.frame.pts };
            match sink.push(&EncodedFrame { pts, ..f.frame }).unwrap() {
                SinkStatus::Finished => panic!("receiver ended the session"),
                SinkStatus::Dropped => dropped += 1,
                SinkStatus::Accepted => sent += 1,
            }
        }
        std::thread::sleep(Duration::from_millis(800));
        eprintln!(
            "sent {sent}, dropped {dropped}, out of presentation order {reordered}, \
             audio {audio_frames}; sink stats {:?}",
            sink.stats()
        );
        sink.stop().unwrap();
    }

    /// Checks a recorded encoded-SLRW stream (e.g. from
    /// `slrw-gen --encoded > x.slrw`): `TVPIPE_SLRW_FILE=x.slrw
    /// TVPIPE_SLRW_VIDEO=640x360@30:h264 [TVPIPE_SLRW_AUDIO=48000:2:s16le]`.
    #[test]
    #[ignore = "needs TVPIPE_SLRW_FILE"]
    fn slrw_encoded_file() {
        let path = std::env::var("TVPIPE_SLRW_FILE").expect("TVPIPE_SLRW_FILE");
        let video: RawVideoSpec = env("TVPIPE_SLRW_VIDEO", "640x360@30:h264").parse().unwrap();
        let audio: Option<RawAudioSpec> = std::env::var("TVPIPE_SLRW_AUDIO")
            .ok()
            .map(|a| a.parse().unwrap());
        let families = if audio.is_some() {
            vec![
                (
                    AudioFamily::AirPlay,
                    AudioOut::Pcm {
                        frame_samples: AIRPLAY_PCM_FRAME_SAMPLES,
                    },
                ),
                (
                    AudioFamily::Cast,
                    AudioOut::AacLc {
                        bitrate_bps: AAC_BITRATE_BPS,
                    },
                ),
            ]
        } else {
            vec![]
        };
        let file = std::fs::File::open(path).unwrap();
        let mut input = SlrwEncodedInput::open(
            std::io::BufReader::new(file),
            EncodedOptions {
                video,
                audio,
                audio_families: families,
                back_channel: None,
            },
            Stop::new(),
        )
        .unwrap();
        let v = &input.info().video;
        eprintln!(
            "video {}x{}@{} avcC {} bytes",
            v.width,
            v.height,
            v.fps,
            v.avcc.len()
        );
        let (mut video, mut keys, mut audio, mut last) = (0, 0, 0, 0);
        while let Some(f) = input.next_frame().unwrap() {
            if f.track == TrackKind::Video {
                video += 1;
                keys += f.keyframe as u32;
                last = f.pts;
            } else {
                audio += 1;
            }
        }
        eprintln!(
            "{video} video frames ({keys} keyframes, last pts {:.3} s), {audio} audio frames",
            last as f64 / 90_000.0
        );
        assert!(video > 0);
    }
}
