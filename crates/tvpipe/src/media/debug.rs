//! `tvpipe debug pipeline`: runs ffmpeg and the demuxer and prints the
//! stream info and one line per frame.
//!
//! Output (stdout), one record per line, `key=value` fields:
//!
//! ```text
//! # ffmpeg ARGS...
//! video codec=H264 width=1280 height=720 fps=30 avcc=01640028...
//! audio family=AirPlay codec=PcmS16le rate=44100 channels=2 frame_samples=352 config=
//! frame track=1 kind=video pts=0 mkv_pts=0 key=1 size=5971 t_ms=12.3
//! ...
//! summary track=1 kind=video frames=300 keys=10 bytes=123456 kbps=987.6
//! ```
//!
//! `mkv_pts` and `size` match what `ffprobe -show_packets` reports for the
//! same Matroska stream; `pts` is the [`EncodedFrame`] pts (90 kHz or
//! sample ticks); `t_ms` is when the frame left the demuxer, relative to
//! the ffmpeg start (the pipeline's overhead plus the encoder's).
//!
//! `--raw` stream-copies the input instead of encoding, so for a Matroska
//! or MP4 input the frames are the input's own packets (see
//! `scripts/check-pipeline.sh`).

use std::collections::BTreeMap;
use std::io::{self, Write};
use std::time::Instant;

use crate::error::{Error, Result};
use crate::log::Level;
use crate::media::ffmpeg::{self, Output, Process, Source};
use crate::media::source::MediaReader;
use crate::opts::{InputSpec, PipelineOptions};
use crate::types::{
    AudioCodec, AudioFamily, AudioPlan, EncodePlan, Encoder, TrackKind, VideoCodec, VideoPlan,
};
use crate::util::hex;
use crate::util::ratio::Ratio;

/// The plan `debug pipeline` encodes with: one AirPlay-style PCM track
/// (352-sample frames) and one Cast-style Opus track (10 ms).
pub fn default_plan() -> EncodePlan {
    EncodePlan {
        video: VideoPlan {
            codec: VideoCodec::H264,
            encoder: Encoder::Auto,
            width: 1280,
            height: 720,
            fps: Ratio::integer(30),
            bitrate_kbps: 4000,
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
                bitrate_kbps: Some(128),
            },
        ],
        latency_ms: 200,
    }
}

fn kind_name(k: TrackKind) -> &'static str {
    match k {
        TrackKind::Video => "video",
        TrackKind::Audio(AudioFamily::AirPlay) => "audio-airplay",
        TrackKind::Audio(AudioFamily::Cast) => "audio-cast",
    }
}

#[derive(Default)]
struct Stats {
    kind: Option<TrackKind>,
    frames: u64,
    keys: u64,
    bytes: u64,
    first_pts: Option<u64>,
    last_pts: u64,
}

/// Runs the pipeline and prints every frame until ffmpeg ends.
pub fn run(opts: &PipelineOptions) -> Result<()> {
    let bin = ffmpeg::locate(opts.ffmpeg.as_deref())?;
    let probe = ffmpeg::Probe::run(&bin)?;
    // Raw game input keeps its forwarder alive for the whole run.
    let mut raw = None;
    let source = match &opts.input {
        InputSpec::Path(p) => Source::Url {
            url: p.clone(),
            realtime: false,
            looped: false,
            start: None,
            freeze: false,
        },
        InputSpec::FfmpegArgs(a) => Source::Args(a.clone()),
        InputSpec::TestPattern => Source::TestPattern { clock: true },
        InputSpec::Stdin => {
            let r = crate::media::rawin::RawInput::bind(
                opts.raw_video.as_ref(),
                opts.raw_audio.as_ref(),
            )?;
            let src = r.source();
            raw = Some(r);
            src
        }
    };
    let plan = default_plan();
    let output = if opts.raw {
        Output::Copy
    } else {
        Output::Encode(&plan)
    };
    let (loglevel, level) = if crate::log::enabled(Level::Debug) {
        ("info", Level::Debug)
    } else {
        ("warning", Level::Warn)
    };
    let inv = ffmpeg::build(&source, output, &probe, loglevel)?;
    let out = io::stdout();
    let mut out = out.lock();
    let quoted: Vec<String> = inv
        .args
        .iter()
        .map(|a| ffmpeg::shell_quote(&a.to_string_lossy()))
        .collect();
    let started = Instant::now();
    let mut proc = Process::spawn_logging(&bin, &inv.args, level)?;
    let stdout = proc
        .take_stdout()
        .ok_or_else(|| Error::process("ffmpeg stdout not piped"))?;
    let forwarder = match raw.take() {
        Some(r) => Some(r.start(io::stdin())?),
        None => None,
    };
    let result = (|| -> Result<()> {
        emit(
            &mut out,
            format_args!("# {} {}", bin.display(), quoted.join(" ")),
        )?;
        let mut reader = MediaReader::new(stdout, &inv.tracks)?;
        let info = reader.info().clone();
        let v = &info.video;
        emit(
            &mut out,
            format_args!(
                "video codec={:?} width={} height={} fps={} avcc={}",
                v.codec,
                v.width,
                v.height,
                v.fps,
                hex::encode(&v.avcc)
            ),
        )?;
        for (family, a) in &info.audio {
            emit(
                &mut out,
                format_args!(
                    "audio family={:?} codec={:?} rate={} channels={} frame_samples={} config={}",
                    family,
                    a.codec,
                    a.sample_rate,
                    a.channels,
                    a.frame_samples,
                    hex::encode(&a.config)
                ),
            )?;
        }
        let mut stats: BTreeMap<u64, Stats> = BTreeMap::new();
        while let Some(f) = reader.next_frame()? {
            let fr = &f.frame;
            let t_ms = started.elapsed().as_secs_f64() * 1000.0;
            emit(
                &mut out,
                format_args!(
                    "frame track={} kind={} pts={} mkv_pts={} key={} size={} t_ms={:.1}",
                    f.track_number,
                    kind_name(fr.track),
                    fr.pts,
                    f.container_pts,
                    f.container_keyframe as u8,
                    fr.data.len(),
                    t_ms
                ),
            )?;
            let s = stats.entry(f.track_number).or_default();
            s.kind = Some(fr.track);
            s.frames += 1;
            s.keys += fr.keyframe as u64;
            s.bytes += fr.data.len() as u64;
            s.first_pts.get_or_insert(fr.pts);
            s.last_pts = fr.pts;
        }
        for (track, s) in &stats {
            let Some(kind) = s.kind else { continue };
            let rate = match kind {
                TrackKind::Video => crate::types::VIDEO_CLOCK_RATE,
                TrackKind::Audio(fam) => info.audio_for(fam).map_or(1, |a| a.sample_rate),
            };
            let span = s.last_pts.saturating_sub(s.first_pts.unwrap_or(0)) as f64 / rate as f64;
            let kbps = if span > 0.0 {
                s.bytes as f64 * 8.0 / span / 1000.0
            } else {
                0.0
            };
            emit(
                &mut out,
                format_args!(
                    "summary track={} kind={} frames={} keys={} bytes={} kbps={:.1}",
                    track,
                    kind_name(kind),
                    s.frames,
                    s.keys,
                    s.bytes,
                    kbps
                ),
            )?;
        }
        Ok(())
    })();
    match result {
        Ok(()) => {
            proc.wait()?;
        }
        // The reader of our stdout went away (e.g. `| head`): not an error.
        Err(e) if e.kind() == crate::error::ErrorKind::Closed => {}
        Err(e) => {
            // Prefer ffmpeg's own complaint if it died first.
            return Err(proc.failure().unwrap_or(e));
        }
    }
    if let Some(fw) = forwarder {
        let s = fw.finish()?;
        info!(
            "raw input: {} video frames ({} dropped), {} audio records ({} dropped), {} bytes{}",
            s.video_frames,
            s.video_dropped,
            s.audio_records,
            s.audio_dropped,
            s.bytes,
            if s.clean_end { "" } else { ", no end record" }
        );
    }
    Ok(())
}

fn emit(out: &mut impl Write, args: std::fmt::Arguments<'_>) -> Result<()> {
    out.write_fmt(args)
        .and_then(|()| out.write_all(b"\n"))
        .map_err(|e| Error::io("write stdout", e))
}
