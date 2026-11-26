//! The ffmpeg subprocess: locating the binary, probing its encoders and
//! filters, building the command line from an [`EncodePlan`] and an input
//! [`Source`], and running it with stdout piped and stderr logged.
//!
//! Sources: ffmpeg documentation (ffmpeg(1), ffmpeg-formats(1) matroska
//! muxer options, ffmpeg-codecs(1) encoder options, ffmpeg-filters(1)) and
//! black-box behaviour of ffmpeg 8; ARCHITECTURE.md, "Inputs".

use std::collections::{BTreeSet, VecDeque};
use std::ffi::{OsStr, OsString};
use std::io::{BufRead, BufReader};
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdout, Command, ExitStatus, Stdio};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

use crate::error::{Error, Result};
use crate::log::Level;
use crate::types::{
    AudioCodec, AudioFamily, AudioPlan, EncodePlan, Encoder, TrackKind, VideoCodec,
};
use crate::util::ratio::Ratio;

/// Environment variable naming the ffmpeg binary.
pub const FFMPEG_ENV: &str = "TVPIPE_FFMPEG";

/// Finds ffmpeg: an explicit path, then `$TVPIPE_FFMPEG`, then `PATH`.
pub fn locate(explicit: Option<&Path>) -> Result<PathBuf> {
    if let Some(p) = explicit {
        return Ok(p.to_owned());
    }
    if let Some(p) = std::env::var_os(FFMPEG_ENV).filter(|p| !p.is_empty()) {
        return Ok(PathBuf::from(p));
    }
    let path = std::env::var_os("PATH").unwrap_or_default();
    find_in_path("ffmpeg", &path).ok_or_else(|| {
        Error::not_found("ffmpeg not found in PATH (use --ffmpeg PATH or $TVPIPE_FFMPEG)")
            .with_code("ffmpeg-missing")
    })
}

/// Finds `ffprobe` next to a located ffmpeg, else in `PATH`.
pub fn locate_sibling(ffmpeg: &Path, name: &str) -> Option<PathBuf> {
    let exe = format!("{name}{}", std::env::consts::EXE_SUFFIX);
    if let Some(dir) = ffmpeg.parent() {
        let p = dir.join(&exe);
        if p.is_file() {
            return Some(p);
        }
    }
    find_in_path(name, &std::env::var_os("PATH").unwrap_or_default())
}

fn find_in_path(name: &str, path: &OsStr) -> Option<PathBuf> {
    let exe = format!("{name}{}", std::env::consts::EXE_SUFFIX);
    std::env::split_paths(path)
        .map(|dir| dir.join(&exe))
        .find(|p| p.is_file())
}

/// What a given ffmpeg binary can do.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Probe {
    /// `(major, minor)` from `ffmpeg -version`, if it parses (git builds
    /// print a revision instead of a version).
    pub version: Option<(u32, u32)>,
    pub encoders: BTreeSet<String>,
    pub filters: BTreeSet<String>,
}

impl Probe {
    /// Runs `ffmpeg -encoders` and `ffmpeg -filters`.
    pub fn run(ffmpeg: &Path) -> Result<Probe> {
        let run = |what: &str| -> Result<String> {
            let out = Command::new(ffmpeg)
                .args(["-hide_banner", "-nostdin", what])
                .stdin(Stdio::null())
                .stderr(Stdio::null())
                .output()
                .map_err(|e| Error::io(format!("run {}", ffmpeg.display()), e))?;
            if !out.status.success() {
                return Err(Error::process(format!(
                    "{} {what} failed: {}",
                    ffmpeg.display(),
                    out.status
                )));
            }
            Ok(String::from_utf8_lossy(&out.stdout).into_owned())
        };
        let version = parse_version(&run("-version")?);
        match version {
            Some((major, _)) if major < MIN_MAJOR_VERSION => warn!(
                "ffmpeg {major} is older than {MIN_MAJOR_VERSION}.x; options like -ch_layout may fail"
            ),
            _ => {}
        }
        Ok(Probe {
            version,
            encoders: parse_listing(&run("-encoders")?),
            filters: parse_listing(&run("-filters")?),
        })
    }

    pub fn has_encoder(&self, name: &str) -> bool {
        self.encoders.contains(name)
    }

    pub fn has_filter(&self, name: &str) -> bool {
        self.filters.contains(name)
    }

    /// [`Source::Url`]'s `freeze` works (ffmpeg 4.3 and later).
    pub fn can_freeze(&self) -> bool {
        ["split", "freezeframes", "volume"]
            .iter()
            .all(|f| self.has_filter(f))
    }
}

/// The oldest ffmpeg major version we test against (we need `-ch_layout`,
/// new in 5.1).
pub const MIN_MAJOR_VERSION: u32 = 6;

/// `ffmpeg version 8.1 ...` → `(8, 1)`; `n7.0.2` → `(7, 0)`.
pub fn parse_version(text: &str) -> Option<(u32, u32)> {
    let v = text.lines().next()?.strip_prefix("ffmpeg version ")?;
    let v = v.split_whitespace().next()?.trim_start_matches('n');
    let mut parts = v.split(|c: char| !c.is_ascii_digit());
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next().and_then(|m| m.parse().ok()).unwrap_or(0);
    Some((major, minor))
}

/// Parses `-encoders` / `-filters` output: a heading (`Filters:`), a
/// legend (`FLAGS = meaning`), then each line `FLAGS NAME ...`. The legend
/// ends in a `------` line, except for `-filters` before ffmpeg 7, so the
/// legend's lines are told apart by their `=`, not by their place.
pub fn parse_listing(text: &str) -> BTreeSet<String> {
    text.lines()
        .filter_map(|l| {
            let mut words = l.split_whitespace();
            let flags = words.next()?;
            let name = words.next()?;
            let is_flags = flags
                .chars()
                .all(|c| c.is_ascii_alphabetic() || c == '.' || c == '|');
            (is_flags && name != "=").then(|| name.to_owned())
        })
        .collect()
}

/// The ffmpeg encoder name for an [`Encoder`] choice and codec.
pub fn encoder_name(encoder: Encoder, codec: VideoCodec) -> Option<&'static str> {
    use Encoder::*;
    Some(match (codec, encoder) {
        (_, Auto | Builtin) => return None,
        (VideoCodec::H264, X264) => "libx264",
        (VideoCodec::H264, VideoToolbox) => "h264_videotoolbox",
        (VideoCodec::H264, Nvenc) => "h264_nvenc",
        (VideoCodec::H264, Qsv) => "h264_qsv",
        (VideoCodec::H264, Vaapi) => "h264_vaapi",
        (VideoCodec::H264, MediaFoundation) => "h264_mf",
        (VideoCodec::Hevc, X264) => "libx265",
        (VideoCodec::Hevc, VideoToolbox) => "hevc_videotoolbox",
        (VideoCodec::Hevc, Nvenc) => "hevc_nvenc",
        (VideoCodec::Hevc, Qsv) => "hevc_qsv",
        (VideoCodec::Hevc, Vaapi) => "hevc_vaapi",
        (VideoCodec::Hevc, MediaFoundation) => "hevc_mf",
    })
}

/// Picks a concrete encoder. `Auto` prefers the software encoder (its
/// output is the most predictable: no B-frames, stable SPS), then the
/// hardware encoders in a fixed order. Hardware encoders can be listed by
/// `-encoders` without a usable device; that shows up when ffmpeg starts.
pub fn resolve_encoder(requested: Encoder, codec: VideoCodec, probe: &Probe) -> Result<Encoder> {
    use Encoder::*;
    let candidates: &[Encoder] = match requested {
        Auto => &[X264, VideoToolbox, Nvenc, Qsv, MediaFoundation, Vaapi],
        _ => std::slice::from_ref(&requested),
    };
    for &e in candidates {
        if encoder_name(e, codec).is_some_and(|n| probe.has_encoder(n)) {
            return Ok(e);
        }
    }
    Err(Error::unsupported(match requested {
        Auto => format!("ffmpeg has no {codec:?} encoder we know"),
        e => format!(
            "ffmpeg lacks the {} encoder",
            encoder_name(e, codec).unwrap_or("?")
        ),
    }))
}

/// Raw game video arriving on a localhost TCP port (docs/slrw.md).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RawVideoInput {
    pub width: u32,
    pub height: u32,
    pub fps: Ratio,
    pub pix_fmt: String,
    pub addr: SocketAddr,
}

/// Raw game audio arriving on a localhost TCP port.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RawAudioInput {
    pub sample_rate: u32,
    pub channels: u8,
    pub sample_fmt: String,
    pub addr: SocketAddr,
}

/// Where ffmpeg reads from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Source {
    /// A file or URL. `realtime` adds `-re`; `looped` adds `-stream_loop -1`.
    Url {
        url: OsString,
        realtime: bool,
        looped: bool,
        /// Where to start (`-ss` before `-i`: ffmpeg decodes from the
        /// keyframe before and starts exactly there; the output's
        /// timestamps still start at zero).
        start: Option<std::time::Duration>,
        /// Paused: the picture at `start` over and over (the
        /// `freezeframes` filter), silence, paced like the input and
        /// looped so it never ends. Needs [`Probe::can_freeze`].
        freeze: bool,
    },
    /// User-given input arguments (they include `-i`). The first input's
    /// first video stream is used, and the first audio stream of the
    /// first input, or of the last one when there are several (a screen
    /// and a sound device: `-f x11grab -i :0 -f pulse -i default`).
    Args(Vec<OsString>),
    /// `testsrc2` plus a beeping sine; `clock` burns in the wallclock with
    /// `drawtext` when ffmpeg has it.
    TestPattern { clock: bool },
    /// SLRW raw input forwarded over localhost TCP (see `rawin`).
    Raw {
        video: Option<RawVideoInput>,
        audio: Option<RawAudioInput>,
    },
}

/// What ffmpeg writes.
#[derive(Debug, Clone, Copy)]
pub enum Output<'a> {
    /// Encode per the plan.
    Encode(&'a EncodePlan),
    /// Stream copy of every video and audio stream (debugging: the packets
    /// are the input's own).
    Copy,
}

pub use crate::media::source::TrackSpec;

/// A built command line and how its Matroska tracks map to our tracks.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Invocation {
    pub args: Vec<OsString>,
    /// `tracks[i]` describes Matroska track number `i + 1`. Empty for
    /// [`Output::Copy`], where the input decides.
    pub tracks: Vec<TrackSpec>,
    /// The encoder chosen for `Auto`.
    pub encoder: Option<Encoder>,
}

struct ArgList(Vec<OsString>);

impl ArgList {
    fn push(&mut self, a: impl AsRef<OsStr>) -> &mut Self {
        self.0.push(a.as_ref().to_owned());
        self
    }
    fn extend<I: IntoIterator<Item = S>, S: AsRef<OsStr>>(&mut self, it: I) -> &mut Self {
        for a in it {
            self.push(a);
        }
        self
    }
}

/// Where the inputs' streams land (`-map` specifiers).
struct InputMaps {
    video: String,
    audio: Option<String>,
    /// The input's constant frame rate, when we know it.
    video_fps: Option<Ratio>,
    /// [`Source::Url`]'s `freeze`.
    freeze: bool,
}

/// Input options for low decoder delay (apply to the next `-i`). Not
/// `-fflags +nobuffer`: it makes ffmpeg drop the packets it read while
/// probing (half the frames of a short file in tests).
const LOW_DELAY_INPUT: [&str; 2] = ["-flags", "low_delay"];
/// Raw game video: the game paces it; frames are stamped with their
/// arrival time, so dropped frames leave gaps instead of shifting the
/// timeline. Raw audio is timed by its sample count instead (arrival
/// times of TCP reads would jitter).
///
/// `-probesize 32`: the format is given, so there is nothing to probe.
/// ffmpeg 7.1 otherwise reads the raw audio socket for about a second
/// while opening it; the video read meanwhile stalls, and its frames, all
/// stamped on arrival in one burst, are dropped as duplicates (3 of 30
/// frames survived on Debian 13's ffmpeg 7.1; ffmpeg 8 is unaffected).
const RAW_VIDEO_INPUT: [&str; 6] = [
    "-use_wallclock_as_timestamps",
    "1",
    "-probesize",
    "32",
    "-thread_queue_size",
    "64",
];
const RAW_AUDIO_INPUT: [&str; 4] = ["-probesize", "32", "-thread_queue_size", "64"];

/// `-re` for the next input, without ffmpeg's default initial burst
/// (`-readrate_initial_burst`, 0.5 s since ffmpeg 6.1): a burst arrives
/// faster than real time and overruns the sinks' in-flight windows. ffmpeg
/// 8 treats `0` as "default", so the burst is 1 ms.
fn push_realtime(a: &mut ArgList, probe: &Probe) {
    a.push("-re");
    // Unknown versions are git builds, i.e. new.
    if probe.version.is_none_or(|v| v >= (6, 1)) {
        a.extend(["-readrate_initial_burst", "0.001"]);
    }
}

fn push_inputs(
    a: &mut ArgList,
    source: &Source,
    plan: Option<&EncodePlan>,
    probe: &Probe,
) -> Result<InputMaps> {
    match source {
        Source::Url {
            url,
            realtime,
            looped,
            start,
            freeze,
        } => {
            // A paced local file with audio is opened twice, once per
            // stream: `-re` paces each input as a whole, and with files
            // whose audio is interleaved far from the video (QuickTime
            // screen recordings put audio ~1 s behind in multi-second
            // chunks) the reader stalls on one stream while it is ahead
            // on the other; ffmpeg then lags and never catches up (about
            // 0.88x real time). Separate inputs pace independently.
            let split = *realtime
                && plan.is_some_and(|p| !p.audio.is_empty())
                && std::path::Path::new(url).is_file();
            for _ in 0..if split { 2 } else { 1 } {
                if *realtime {
                    push_realtime(a, probe);
                }
                if *looped || *freeze {
                    a.extend(["-stream_loop", "-1"]);
                }
                if let Some(t) = start.filter(|t| !t.is_zero()) {
                    a.push("-ss").push(format!("{:.3}", t.as_secs_f64()));
                }
                a.extend(LOW_DELAY_INPUT).push("-i").push(url);
            }
            Ok(InputMaps {
                video: "0:v:0".into(),
                audio: Some(if split { "1:a:0?" } else { "0:a:0?" }.into()),
                video_fps: None,
                freeze: *freeze,
            })
        }
        Source::Args(args) => {
            if !args.iter().any(|x| x == "-i") {
                return Err(Error::usage("ffmpeg input arguments must contain -i"));
            }
            a.extend(LOW_DELAY_INPUT).extend(args);
            let inputs = args.iter().filter(|x| *x == "-i").count();
            Ok(InputMaps {
                video: "0:v:0".into(),
                audio: Some(format!("{}:a:0?", inputs.saturating_sub(1))),
                video_fps: None,
                freeze: false,
            })
        }
        Source::TestPattern { clock } => {
            let (w, h, fps) = plan.map_or((1280, 720, Ratio::integer(30)), |p| {
                (p.video.width, p.video.height, p.video.fps)
            });
            let mut video = format!("testsrc2=size={w}x{h}:rate={fps}");
            if *clock {
                if probe.has_filter("drawtext") {
                    // Wallclock, media time and frame number.
                    video.push_str(
                        ",drawtext=text='%{localtime\\:%X} %{pts\\:hms} #%{n}'\
                         :x=20:y=20:fontsize=48:fontcolor=white:box=1:boxcolor=black",
                    );
                } else {
                    debug!("ffmpeg lacks the drawtext filter; test pattern without wallclock");
                }
            }
            push_realtime(a, probe);
            a.extend(["-f", "lavfi", "-i"]).push(video);
            // A 1 kHz beep at every full second (beep_factor: louder beep).
            push_realtime(a, probe);
            a.extend([
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=1000:beep_factor=4:sample_rate=48000",
            ]);
            Ok(InputMaps {
                video: "0:v:0".into(),
                audio: Some("1:a:0".into()),
                video_fps: None,
                freeze: false,
            })
        }
        Source::Raw { video, audio } => {
            let Some(v) = video else {
                return Err(Error::unsupported("raw input needs video (--raw-video)"));
            };
            a.extend(LOW_DELAY_INPUT)
                .extend(RAW_VIDEO_INPUT)
                .extend(["-f", "rawvideo", "-pixel_format"])
                .push(&v.pix_fmt)
                .push("-video_size")
                .push(format!("{}x{}", v.width, v.height))
                .push("-framerate")
                .push(v.fps.to_string())
                .push("-i")
                .push(format!("tcp://{}", v.addr));
            let audio_map = match audio {
                Some(au) => {
                    a.extend(RAW_AUDIO_INPUT)
                        .push("-f")
                        .push(&au.sample_fmt)
                        .push("-sample_rate")
                        .push(au.sample_rate.to_string())
                        .push("-ch_layout")
                        .push(layout_name(au.channels))
                        .push("-i")
                        .push(format!("tcp://{}", au.addr));
                    Some("1:a:0".into())
                }
                None => None,
            };
            Ok(InputMaps {
                video: "0:v:0".into(),
                audio: audio_map,
                video_fps: Some(v.fps),
                freeze: false,
            })
        }
    }
}

/// ffmpeg channel layout names for interleaved raw audio.
fn layout_name(channels: u8) -> String {
    match channels {
        1 => "mono".into(),
        2 => "stereo".into(),
        6 => "5.1".into(),
        8 => "7.1".into(),
        n => format!("{n}c"),
    }
}

/// The `-vf` chain: letterbox into the target size, fixed fps. `fps` is
/// `None` when the input already runs at the plan's rate (raw game input):
/// the fps filter holds one frame back to decide, which costs a frame of
/// latency.
fn video_filter(w: u32, h: u32, fps: Option<Ratio>, encoder: Encoder) -> String {
    let mut f = format!(
        "scale={w}:{h}:force_original_aspect_ratio=decrease,\
         pad={w}:{h}:(ow-iw)/2:(oh-ih)/2,setsar=1"
    );
    if let Some(fps) = fps {
        f.push_str(&format!(",fps={fps}"));
    }
    match encoder {
        Encoder::Vaapi => f.push_str(",format=nv12,hwupload"),
        Encoder::Qsv | Encoder::Nvenc | Encoder::VideoToolbox => f.push_str(",format=nv12"),
        _ => f.push_str(",format=yuv420p"),
    }
    f
}

/// Every frame replaced by the first (ffmpeg-filters(1), freezeframes:
/// its second input gives the replacement), at the input's pace.
const FREEZE_FILTER: &str =
    "split[f][r];[f][r]freezeframes=first=1:last=9223372036854775807:replace=0,";

fn push_video(
    a: &mut ArgList,
    plan: &EncodePlan,
    encoder: Encoder,
    maps: &InputMaps,
) -> Result<()> {
    let v = &plan.video;
    if v.width == 0 || v.height == 0 || v.fps.num == 0 || v.fps.den == 0 || v.bitrate_kbps == 0 {
        return Err(Error::usage("video plan needs size, fps and bitrate"));
    }
    let name =
        encoder_name(encoder, v.codec).ok_or_else(|| Error::usage("encoder not resolved"))?;
    let gop = v.gop.max(1).to_string();
    let kbps = v.bitrate_kbps;
    // VBV buffer of about two frames keeps per-frame sizes even.
    let bufsize = ((kbps as u64 * 2 * v.fps.den as u64) / v.fps.num as u64).max(1);
    a.extend(["-map", &maps.video, "-c:v", name])
        .push("-vf")
        .push(format!(
            "{}{}",
            if maps.freeze { FREEZE_FILTER } else { "" },
            video_filter(
                v.width,
                v.height,
                (maps.video_fps != Some(v.fps)).then_some(v.fps),
                encoder,
            )
        ))
        .extend(["-bf", "0", "-g"])
        .push(&gop)
        .push("-b:v")
        .push(format!("{kbps}k"))
        .push("-maxrate")
        .push(format!("{kbps}k"))
        .push("-bufsize")
        .push(format!("{bufsize}k"));
    let h264 = v.codec == VideoCodec::H264;
    match encoder {
        Encoder::X264 if h264 => {
            a.extend([
                "-preset",
                "veryfast",
                "-tune",
                "zerolatency",
                "-profile:v",
                "high",
            ])
            .extend(["-keyint_min", &gop, "-sc_threshold", "0"]);
        }
        Encoder::X264 => {
            a.extend(["-preset", "veryfast", "-tune", "zerolatency"])
                .push("-x265-params")
                .push(format!(
                    "bframes=0:keyint={gop}:min-keyint={gop}:scenecut=0"
                ));
        }
        Encoder::VideoToolbox => {
            a.extend(["-realtime", "1", "-prio_speed", "1"]);
            if h264 {
                a.extend(["-profile:v", "high"]);
            }
        }
        Encoder::Nvenc => {
            a.extend(["-preset", "p1", "-tune", "ull", "-zerolatency", "1"])
                .extend(["-rc", "cbr", "-delay", "0", "-forced-idr", "1"]);
        }
        Encoder::Qsv => {
            a.extend([
                "-preset",
                "veryfast",
                "-look_ahead",
                "0",
                "-async_depth",
                "1",
            ]);
        }
        Encoder::Vaapi => {
            a.extend(["-rc_mode", "CBR"]);
        }
        Encoder::MediaFoundation => {
            a.extend(["-rate_control", "cbr", "-scenario", "display_remoting"]);
        }
        Encoder::Auto | Encoder::Builtin => return Err(Error::usage("encoder not resolved")),
    }
    Ok(())
}

/// Opus frame durations libopus accepts, in ms, by samples at 48 kHz.
fn opus_frame_duration(samples: u32) -> Option<&'static str> {
    Some(match samples {
        120 => "2.5",
        240 => "5",
        480 => "10",
        960 => "20",
        1920 => "40",
        2880 => "60",
        _ => return None,
    })
}

/// ffmpeg's ALAC encoder always produces frames of this many samples.
pub const FFMPEG_ALAC_FRAME_SAMPLES: u32 = 4096;

fn push_audio(
    a: &mut ArgList,
    i: usize,
    p: &AudioPlan,
    map: &str,
    probe: &Probe,
    silent: bool,
) -> Result<()> {
    let s = |opt: &str| format!("{opt}:a:{i}");
    // `volume=0` while paused (a frozen picture).
    let mute = if silent { "volume=0," } else { "" };
    if p.sample_rate == 0 || p.channels == 0 {
        return Err(Error::usage("audio plan needs sample rate and channels"));
    }
    a.extend(["-map", map])
        .push(s("-ar"))
        .push(p.sample_rate.to_string())
        .push(s("-ac"))
        .push(p.channels.to_string());
    let need = |name: &str| -> Result<()> {
        if probe.has_encoder(name) {
            Ok(())
        } else {
            Err(Error::unsupported(format!(
                "ffmpeg lacks the {name} audio encoder"
            )))
        }
    };
    let bitrate = |a: &mut ArgList, default: u32| {
        a.push(s("-b"))
            .push(format!("{}k", p.bitrate_kbps.unwrap_or(default)));
    };
    match p.codec {
        AudioCodec::Alac => {
            need("alac")?;
            if p.frame_samples != FFMPEG_ALAC_FRAME_SAMPLES {
                return Err(Error::unsupported(format!(
                    "ffmpeg's ALAC encoder only makes {FFMPEG_ALAC_FRAME_SAMPLES}-sample frames, \
                     not {}; plan PcmS16le and frame it as ALAC instead",
                    p.frame_samples
                )));
            }
            a.push(s("-c"))
                .push("alac")
                .push(s("-sample_fmt"))
                .push("s16p");
        }
        AudioCodec::Opus => {
            need("libopus")?;
            if p.sample_rate != 48_000 {
                return Err(Error::unsupported("Opus output must be 48 kHz"));
            }
            let fd = opus_frame_duration(p.frame_samples).ok_or_else(|| {
                Error::unsupported(format!("Opus frame of {} samples", p.frame_samples))
            })?;
            a.push(s("-c")).push("libopus");
            bitrate(a, 128);
            a.push(s("-frame_duration"))
                .push(fd)
                .push(s("-application"))
                .push("lowdelay")
                .push(s("-vbr"))
                .push("off");
        }
        AudioCodec::AacLc => {
            need("aac")?;
            if p.frame_samples != 1024 {
                return Err(Error::unsupported("AAC-LC frames are 1024 samples"));
            }
            a.push(s("-c")).push("aac");
            bitrate(a, 128);
        }
        AudioCodec::AacEld => {
            need("libfdk_aac")?;
            let len = match p.frame_samples {
                480 | 512 => p.frame_samples.to_string(),
                n => return Err(Error::unsupported(format!("AAC-ELD frame of {n} samples"))),
            };
            a.push(s("-c"))
                .push("libfdk_aac")
                .push(s("-profile"))
                .push("aac_eld");
            a.push(s("-frame_length")).push(len);
            bitrate(a, 128);
        }
        AudioCodec::PcmS16le => {
            if p.frame_samples == 0 {
                return Err(Error::usage("PCM plan needs frame_samples"));
            }
            // PCM has no frame size of its own; cut fixed-size packets.
            // Resample first: `-ar`/`-ac` conversions run after this filter.
            a.push(s("-c")).push("pcm_s16le").push(s("-filter")).push(format!(
                "{mute}aresample={rate},aformat=sample_fmts=s16:sample_rates={rate}:channel_layouts={layout},\
                 asetnsamples=n={n}:p=0",
                rate = p.sample_rate,
                layout = layout_name(p.channels),
                n = p.frame_samples
            ));
            return Ok(());
        }
    }
    if silent {
        a.push(s("-filter")).push("volume=0");
    }
    Ok(())
}

/// Builds the full ffmpeg command line (without the program name).
pub fn build(
    source: &Source,
    output: Output<'_>,
    probe: &Probe,
    loglevel: &str,
) -> Result<Invocation> {
    let mut a = ArgList(Vec::new());
    a.extend([
        "-hide_banner",
        "-nostdin",
        "-nostats",
        "-loglevel",
        loglevel,
    ]);
    let plan = match output {
        Output::Encode(p) => Some(p),
        Output::Copy => None,
    };
    let mut encoder = None;
    if let Some(p) = plan {
        let e = resolve_encoder(p.video.encoder, p.video.codec, probe)?;
        if e == Encoder::Vaapi {
            a.extend(["-vaapi_device", "/dev/dri/renderD128"]);
        }
        encoder = Some(e);
    }
    let maps = push_inputs(&mut a, source, plan, probe)?;
    let mut tracks = Vec::new();
    match plan {
        Some(p) => {
            push_video(&mut a, p, encoder.unwrap_or_default(), &maps)?;
            tracks.push(TrackSpec {
                kind: TrackKind::Video,
                frame_samples: 0,
            });
            let mut seen: Vec<AudioFamily> = Vec::new();
            match &maps.audio {
                Some(map) => {
                    for (i, ap) in p.audio.iter().enumerate() {
                        if seen.contains(&ap.family) {
                            return Err(Error::usage("two audio plans for one family"));
                        }
                        seen.push(ap.family);
                        push_audio(&mut a, i, ap, map, probe, maps.freeze)?;
                        tracks.push(TrackSpec {
                            kind: TrackKind::Audio(ap.family),
                            frame_samples: ap.frame_samples,
                        });
                    }
                }
                None if !p.audio.is_empty() => {
                    warn!("input has no audio; encoding video only");
                }
                None => {}
            }
        }
        None => {
            a.extend(["-map", "0:v?", "-map", "0:a?", "-c", "copy"]);
        }
    }
    // Live Matroska on stdout: no cues, no interleaving delay, flush every
    // packet (ffmpeg-formats(1), matroska muxer; ffmpeg(1) -max_interleave_delta).
    a.extend([
        "-max_interleave_delta",
        "0",
        "-muxdelay",
        "0",
        "-muxpreload",
        "0",
    ])
    .extend(["-f", "matroska", "-live", "1", "-cluster_time_limit", "0"])
    .extend(["-flush_packets", "1", "pipe:1"]);
    Ok(Invocation {
        args: a.0,
        tracks,
        encoder,
    })
}

/// How many stderr lines to keep for error messages.
const STDERR_TAIL: usize = 20;

/// A running ffmpeg. Killed and reaped on drop.
pub struct Process {
    child: Child,
    stdout: Option<ChildStdout>,
    pump: Option<JoinHandle<()>>,
    tail: Arc<Mutex<VecDeque<String>>>,
    program: String,
}

impl Process {
    /// Starts `ffmpeg args...` with stdout piped and stderr pumped into the
    /// logger (each line at warn level; ffmpeg runs at `-loglevel warning`).
    pub fn spawn(ffmpeg: &Path, args: &[OsString]) -> Result<Process> {
        Process::spawn_logging(ffmpeg, args, Level::Warn)
    }

    /// Like [`Process::spawn`], logging stderr lines at `level` (use
    /// `Debug` with `-loglevel info`).
    pub fn spawn_logging(ffmpeg: &Path, args: &[OsString], level: Level) -> Result<Process> {
        debug!(
            "spawn {} {}",
            ffmpeg.display(),
            args.iter()
                .map(|a| shell_quote(&a.to_string_lossy()))
                .collect::<Vec<_>>()
                .join(" ")
        );
        let mut child = Command::new(ffmpeg)
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| Error::io(format!("start {}", ffmpeg.display()), e))?;
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        let tail = Arc::new(Mutex::new(VecDeque::new()));
        let pump = match stderr {
            Some(stderr) => {
                let tail = tail.clone();
                let spawned = std::thread::Builder::new()
                    .name("ffmpeg-stderr".into())
                    .spawn(move || pump_stderr(stderr, &tail, level));
                match spawned {
                    Ok(h) => Some(h),
                    Err(e) => {
                        let _ = child.kill();
                        let _ = child.wait();
                        return Err(Error::io("spawn ffmpeg stderr thread", e));
                    }
                }
            }
            None => None,
        };
        Ok(Process {
            child,
            stdout,
            pump,
            tail,
            program: ffmpeg.display().to_string(),
        })
    }

    /// The Matroska stream. Can be taken once.
    pub fn take_stdout(&mut self) -> Option<ChildStdout> {
        self.stdout.take()
    }

    pub fn id(&self) -> u32 {
        self.child.id()
    }

    /// The last lines ffmpeg wrote to stderr.
    pub fn stderr_tail(&self) -> Vec<String> {
        self.tail
            .lock()
            .map(|t| t.iter().cloned().collect())
            .unwrap_or_default()
    }

    pub fn kill(&mut self) {
        let _ = self.child.kill();
    }

    /// After a demux error: if ffmpeg exits with a failure within a short
    /// grace period, its error (with its last stderr line); else `None`, and
    /// the process is killed.
    pub fn failure(&mut self) -> Option<Error> {
        let deadline = std::time::Instant::now() + std::time::Duration::from_millis(500);
        loop {
            match self.child.try_wait() {
                Ok(Some(status)) if status.success() => return None,
                Ok(Some(_)) => return self.wait().err(),
                Ok(None) if std::time::Instant::now() < deadline => {
                    std::thread::sleep(std::time::Duration::from_millis(10));
                }
                _ => {
                    self.kill();
                    return None;
                }
            }
        }
    }

    /// Waits for exit. A failure status becomes an error carrying ffmpeg's
    /// last stderr line.
    pub fn wait(&mut self) -> Result<ExitStatus> {
        let status = self
            .child
            .wait()
            .map_err(|e| Error::io("wait for ffmpeg", e))?;
        if let Some(p) = self.pump.take() {
            let _ = p.join();
        }
        if status.success() {
            return Ok(status);
        }
        let last = self.stderr_tail().pop().unwrap_or_default();
        Err(Error::process(if last.is_empty() {
            format!("{} exited with {status}", self.program)
        } else {
            format!("{} exited with {status}: {last}", self.program)
        }))
    }
}

impl Drop for Process {
    fn drop(&mut self) {
        // Closing stdout first lets ffmpeg die of EPIPE if kill fails.
        self.stdout = None;
        let _ = self.child.kill();
        let _ = self.child.wait();
        if let Some(p) = self.pump.take() {
            let _ = p.join();
        }
    }
}

fn pump_stderr(stderr: std::process::ChildStderr, tail: &Mutex<VecDeque<String>>, level: Level) {
    let mut r = BufReader::new(stderr);
    let mut buf = Vec::new();
    loop {
        buf.clear();
        match r.read_until(b'\n', &mut buf) {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
        // ffmpeg rewrites lines with '\r' for progress; split on both.
        for line in String::from_utf8_lossy(&buf).split(['\r', '\n']) {
            let line = line.trim_end();
            if line.is_empty() {
                continue;
            }
            crate::log_at!(level, "ffmpeg: {line}");
            if let Ok(mut t) = tail.lock() {
                if t.len() == STDERR_TAIL {
                    t.pop_front();
                }
                t.push_back(line.to_owned());
            }
        }
    }
}

/// Quotes an argument for display in logs (POSIX shell style).
pub fn shell_quote(s: &str) -> String {
    if !s.is_empty()
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_./:=+,@%".contains(&b))
    {
        s.to_owned()
    } else {
        format!("'{}'", s.replace('\'', "'\\''"))
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::types::VideoPlan;

    pub(crate) fn plan() -> EncodePlan {
        EncodePlan {
            video: VideoPlan {
                codec: VideoCodec::H264,
                encoder: Encoder::Auto,
                width: 1280,
                height: 720,
                fps: Ratio::integer(30),
                bitrate_kbps: 3000,
                gop: 30,
            },
            audio: vec![
                AudioPlan {
                    family: AudioFamily::AirPlay,
                    codec: AudioCodec::PcmS16le,
                    sample_rate: 44_100,
                    channels: 2,
                    frame_samples: 352,
                    bitrate_kbps: None,
                },
                AudioPlan {
                    family: AudioFamily::Cast,
                    codec: AudioCodec::Opus,
                    sample_rate: 48_000,
                    channels: 2,
                    frame_samples: 480,
                    bitrate_kbps: Some(96),
                },
            ],
            latency_ms: 200,
        }
    }

    /// The real ffmpeg if it is installed, recent and has libx264 and
    /// libopus; tests that need it skip otherwise.
    pub(crate) fn real_ffmpeg() -> Option<(PathBuf, Probe)> {
        let bin = locate(None).ok()?;
        let probe = Probe::run(&bin).ok()?;
        let ok = probe.version.is_some_and(|(m, _)| m >= MIN_MAJOR_VERSION)
            && probe.has_encoder("libx264")
            && probe.has_encoder("libopus");
        if !ok {
            eprintln!("ffmpeg missing, too old or without libx264/libopus; skipping");
            return None;
        }
        Some((bin, probe))
    }

    #[test]
    fn version_parse() {
        assert_eq!(
            parse_version("ffmpeg version 8.1 Copyright (c) 2000-2026"),
            Some((8, 1))
        );
        assert_eq!(
            parse_version("ffmpeg version n7.0.2-static https://"),
            Some((7, 0))
        );
        assert_eq!(
            parse_version("ffmpeg version 6.1.1-3ubuntu5 Copyright"),
            Some((6, 1))
        );
        assert_eq!(parse_version("ffmpeg version N-112345-gdeadbeef"), None);
    }

    pub(crate) fn probe() -> Probe {
        Probe {
            version: Some((8, 1)),
            encoders: ["libx264", "h264_videotoolbox", "libopus", "alac", "aac"]
                .map(String::from)
                .into(),
            filters: ["scale", "pad", "fps"].map(String::from).into(),
        }
    }

    fn joined(inv: &Invocation) -> String {
        inv.args
            .iter()
            .map(|a| a.to_string_lossy().into_owned())
            .collect::<Vec<_>>()
            .join(" ")
    }

    #[test]
    fn listing_parse() {
        let text = "Encoders:\n V..... = Video\n ------\n V....D libx264              libx264 H.264\n A....D alac  ALAC\n";
        let set = parse_listing(text);
        assert_eq!(set.into_iter().collect::<Vec<_>>(), ["alac", "libx264"]);
        let filters = "Filters:\n  T.. = Timeline support\n  ------\n TS aap  AA->A  x\n .. drawtext V->V y\n";
        assert!(parse_listing(filters).contains("drawtext"));
    }

    /// The start of `ffmpeg -filters` from real builds: 6.1 (Ubuntu
    /// 24.04) has no `------` line after the legend, 8.1 has one.
    #[test]
    fn listing_parse_real_filters() {
        let v6 = "Filters:\n  T.. = Timeline support\n  .S. = Slice threading\n  ..C = Command support\n  A = Audio input/output\n  V = Video input/output\n  N = Dynamic number and/or type of input/output\n  | = Source or sink filter\n ... abench            A->A       Benchmark part of a filtergraph.\n ..C acompressor       A->A       Audio compressor.\n T.C volume            A->A       Change input volume.\n ... freezeframes      VV->V      Freeze video frames.\n ... split             V->N       Pass on the input to N video outputs.\n ... abuffer           |->A       Buffer audio frames, and make them accessible to the filterchain.\n";
        let v8 = "Filters:\n  T.. = Timeline support\n  .S. = Slice threading\n  A = Audio input/output\n  V = Video input/output\n  N = Dynamic number and/or type of input/output\n  | = Source or sink filter\n  ------\n TS aap               AA->A      Apply Affine Projection algorithm to first audio stream.\n .. abench            A->A       Benchmark part of a filtergraph.\n T. volume            A->A       Change input volume.\n .. freezeframes      VV->V      Freeze video frames.\n .. split             V->N       Pass on the input to N video outputs.\n";
        let six = parse_listing(v6);
        assert_eq!(
            six.iter().map(String::as_str).collect::<Vec<_>>(),
            [
                "abench",
                "abuffer",
                "acompressor",
                "freezeframes",
                "split",
                "volume"
            ]
        );
        let eight = parse_listing(v8);
        assert_eq!(
            eight.iter().map(String::as_str).collect::<Vec<_>>(),
            ["aap", "abench", "freezeframes", "split", "volume"]
        );
        for set in [six, eight] {
            let p = Probe {
                filters: set,
                ..Probe::default()
            };
            assert!(p.can_freeze());
        }
    }

    #[test]
    fn encoder_resolution() {
        let p = probe();
        assert_eq!(
            resolve_encoder(Encoder::Auto, VideoCodec::H264, &p).unwrap(),
            Encoder::X264
        );
        assert_eq!(
            resolve_encoder(Encoder::VideoToolbox, VideoCodec::H264, &p).unwrap(),
            Encoder::VideoToolbox
        );
        assert!(resolve_encoder(Encoder::Nvenc, VideoCodec::H264, &p).is_err());
        assert!(resolve_encoder(Encoder::Auto, VideoCodec::Hevc, &p).is_err());
        let mut hw = p.clone();
        hw.encoders.remove("libx264");
        assert_eq!(
            resolve_encoder(Encoder::Auto, VideoCodec::H264, &hw).unwrap(),
            Encoder::VideoToolbox
        );
    }

    #[test]
    fn file_invocation() {
        let src = Source::Url {
            url: "movie file.mkv".into(),
            realtime: true,
            looped: false,
            start: None,
            freeze: false,
        };
        let inv = build(&src, Output::Encode(&plan()), &probe(), "warning").unwrap();
        assert_eq!(
            inv.tracks.iter().map(|t| t.kind).collect::<Vec<_>>(),
            [
                TrackKind::Video,
                TrackKind::Audio(AudioFamily::AirPlay),
                TrackKind::Audio(AudioFamily::Cast)
            ]
        );
        assert_eq!(inv.encoder, Some(Encoder::X264));
        assert_eq!(
            joined(&inv),
            "-hide_banner -nostdin -nostats -loglevel warning \
             -re -readrate_initial_burst 0.001 -flags low_delay -i movie file.mkv \
             -map 0:v:0 -c:v libx264 -vf scale=1280:720:force_original_aspect_ratio=decrease,\
             pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,format=yuv420p \
             -bf 0 -g 30 -b:v 3000k -maxrate 3000k -bufsize 200k \
             -preset veryfast -tune zerolatency -profile:v high -keyint_min 30 -sc_threshold 0 \
             -map 0:a:0? -ar:a:0 44100 -ac:a:0 2 -c:a:0 pcm_s16le -filter:a:0 aresample=44100,\
             aformat=sample_fmts=s16:sample_rates=44100:channel_layouts=stereo,asetnsamples=n=352:p=0 \
             -map 0:a:0? -ar:a:1 48000 -ac:a:1 2 -c:a:1 libopus -b:a:1 96k -frame_duration:a:1 10 \
             -application:a:1 lowdelay -vbr:a:1 off \
             -max_interleave_delta 0 -muxdelay 0 -muxpreload 0 -f matroska -live 1 \
             -cluster_time_limit 0 -flush_packets 1 pipe:1"
        );
    }

    /// A paced local file with audio is opened twice so each stream is
    /// paced on its own (badly interleaved files made `-re` lag).
    #[test]
    fn paced_local_file_opens_one_input_per_stream() {
        let dir = std::env::temp_dir().join(format!("tvpipe-ffmpeg-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("movie.mov");
        std::fs::write(&file, b"x").unwrap();
        let src = |realtime| Source::Url {
            url: file.clone().into_os_string(),
            realtime,
            looped: true,
            start: None,
            freeze: false,
        };
        let inv = build(&src(true), Output::Encode(&plan()), &probe(), "warning").unwrap();
        let j = joined(&inv);
        assert_eq!(j.matches(" -i ").count(), 2, "{j}");
        assert_eq!(
            j.matches("-re -readrate_initial_burst 0.001 -stream_loop -1")
                .count(),
            2
        );
        assert!(j.contains("-map 0:v:0 "), "{j}");
        assert_eq!(j.matches("-map 1:a:0? ").count(), 2, "{j}");
        // Not paced, or video only: one input as before.
        let inv = build(&src(false), Output::Encode(&plan()), &probe(), "warning").unwrap();
        assert_eq!(joined(&inv).matches(" -i ").count(), 1);
        let mut video_only = plan();
        video_only.audio.clear();
        let inv = build(&src(true), Output::Encode(&video_only), &probe(), "warning").unwrap();
        assert_eq!(joined(&inv).matches(" -i ").count(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn raw_and_copy_invocations() {
        let src = Source::Raw {
            video: Some(RawVideoInput {
                width: 640,
                height: 360,
                fps: Ratio::integer(30),
                pix_fmt: "rgba".into(),
                addr: "127.0.0.1:5000".parse().unwrap(),
            }),
            audio: Some(RawAudioInput {
                sample_rate: 48_000,
                channels: 2,
                sample_fmt: "s16le".into(),
                addr: "127.0.0.1:5001".parse().unwrap(),
            }),
        };
        let mut p = plan();
        p.video.encoder = Encoder::VideoToolbox;
        let s = joined(&build(&src, Output::Encode(&p), &probe(), "warning").unwrap());
        assert!(s.contains(
            "-f rawvideo -pixel_format rgba -video_size 640x360 -framerate 30 -i tcp://127.0.0.1:5000"
        ));
        assert!(s.contains("-f s16le -sample_rate 48000 -ch_layout stereo -i tcp://127.0.0.1:5001"));
        assert!(s.contains("-map 1:a:0 -ar:a:0 44100"));
        assert!(s.contains("-c:v h264_videotoolbox"));
        assert!(s.contains("-realtime 1"));
        // Raw input already runs at the plan's rate: no fps filter delay.
        assert!(s.contains("setsar=1,format=nv12 "), "{s}");

        let copy = build(&src, Output::Copy, &probe(), "warning").unwrap();
        assert!(copy.tracks.is_empty());
        assert!(joined(&copy).contains("-map 0:v? -map 0:a? -c copy"));

        let args = Source::Args(vec!["-f".into(), "lavfi".into()]);
        assert!(build(&args, Output::Copy, &probe(), "warning").is_err());

        // Input args: sound from the first input, or from the last of
        // several (a screen and a sound device).
        let args = |a: &[&str]| Source::Args(a.iter().map(|x| x.into()).collect());
        let one = joined(
            &build(
                &args(&["-f", "avfoundation", "-i", "1:0"]),
                Output::Encode(&plan()),
                &probe(),
                "warning",
            )
            .unwrap(),
        );
        assert!(
            one.contains("-map 0:v:0 ") && one.contains("-map 0:a:0? "),
            "{one}"
        );
        let two = args(&[
            "-f",
            "x11grab",
            "-i",
            ":0",
            "-f",
            "pulse",
            "-i",
            "@DEFAULT_MONITOR@",
        ]);
        let two = joined(&build(&two, Output::Encode(&plan()), &probe(), "warning").unwrap());
        assert!(
            two.contains("-map 0:v:0 ") && two.contains("-map 1:a:0? "),
            "{two}"
        );
        assert!(!two.contains("-map 0:a"), "{two}");
    }

    #[test]
    fn audio_plan_errors() {
        let src = Source::TestPattern { clock: false };
        let mut p = plan();
        p.audio[0].codec = AudioCodec::Alac;
        let err = build(&src, Output::Encode(&p), &probe(), "warning").unwrap_err();
        assert!(err.to_string().contains("4096"));
        p.audio[0].frame_samples = 4096;
        assert!(build(&src, Output::Encode(&p), &probe(), "warning").is_ok());
        p.audio[0].codec = AudioCodec::AacEld;
        p.audio[0].frame_samples = 480;
        assert!(build(&src, Output::Encode(&p), &probe(), "warning").is_err());
        let mut p = plan();
        p.audio[1].frame_samples = 500;
        assert!(build(&src, Output::Encode(&p), &probe(), "warning").is_err());
        let mut p = plan();
        p.audio[1].family = AudioFamily::AirPlay;
        assert!(build(&src, Output::Encode(&p), &probe(), "warning").is_err());
    }

    #[test]
    fn quoting() {
        assert_eq!(shell_quote("a-b"), "a-b");
        assert_eq!(shell_quote("it's"), "'it'\\''s'");
        assert_eq!(shell_quote(""), "''");
    }

    #[test]
    fn locate_prefers_explicit() {
        let p = locate(Some(Path::new("/x/ffmpeg"))).unwrap();
        assert_eq!(p, Path::new("/x/ffmpeg"));
        assert!(find_in_path("definitely-not-a-binary-xyz", OsStr::new("/nonexistent")).is_none());
    }
}
