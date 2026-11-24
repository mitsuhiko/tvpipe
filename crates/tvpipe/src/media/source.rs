//! Turns ffmpeg's Matroska output into [`EncodedFrame`]s plus the
//! [`VideoInfo`] / [`AudioInfo`] the sinks need.
//!
//! Timestamps: every track is shifted by the largest CodecDelay so that the
//! first frames land at or after zero, then converted to 90 kHz (video) or
//! sample ticks (audio). Matroska stores 1 ms ticks, too coarse for audio,
//! so audio pts advance by each frame's sample count and only resync to the
//! container timestamp when it drifts by more than one container tick.
//!
//! Over a file (`R: Seek`), [`MediaReader::seek_cluster`] continues at a
//! Cluster (passthrough seeking, [`crate::media::passthrough`]).
//!
//! Sources: RFC 9559 (CodecID, CodecPrivate, CodecDelay); ISO/IEC 14496-3
//! §1.6.2.1 (AudioSpecificConfig); RFC 6716 §3.1 (Opus TOC byte); RFC 7845
//! §5.1 (OpusHead); ISO/IEC 14496-15 §5.3.3.1;
//! ARCHITECTURE.md, "Timing and Latency".

use std::io::{Read, Seek};
use std::sync::Arc;

use crate::error::{Error, Result};
use crate::media::h264;
use crate::media::mkv::{Demuxer, Track, TrackType};
pub use crate::types::StreamInfo;
use crate::types::{
    AudioCodec, AudioFamily, AudioInfo, EncodedFrame, TrackKind, VideoCodec, VideoInfo,
    VIDEO_CLOCK_RATE,
};
use crate::util::ratio::Ratio;

/// What one Matroska track carries (ffmpeg's output tracks, by plan).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TrackSpec {
    pub kind: TrackKind,
    /// Samples per frame the plan asked for (0 for video).
    pub frame_samples: u32,
}

/// A demuxed frame plus its container-level details (for debugging).
#[derive(Debug, Clone)]
pub struct DemuxedFrame {
    pub frame: EncodedFrame,
    /// Matroska track number.
    pub track_number: u64,
    /// The pts `ffprobe -show_packets` shows (Matroska ticks).
    pub container_pts: i64,
    /// The container's keyframe flag (for video `frame.keyframe` also
    /// requires an IDR NAL unit).
    pub container_keyframe: bool,
}

struct Mapped {
    number: u64,
    kind: TrackKind,
    /// Ticks per second of `EncodedFrame::pts`.
    rate: u32,
    /// Audio: samples per frame when fixed (0 = derive per packet).
    frame_samples: u32,
    codec: Codec,
    next_pts: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Codec {
    Video { length_size: usize, h264: bool },
    Opus,
    Pcm { bytes_per_frame: usize },
    Other,
}

pub struct MediaReader<R> {
    demux: Demuxer<R>,
    info: StreamInfo,
    tracks: Vec<Mapped>,
    /// Added to every pts (ns) so codec-delayed tracks start at >= 0.
    origin_ns: i64,
    dropped_negative: u64,
}

impl<R: Read> MediaReader<R> {
    /// Reads the Matroska header. `specs` describes the output tracks in
    /// order (from [`crate::media::ffmpeg::Invocation`]); when empty, the
    /// first video track becomes `Video` and the first two audio tracks
    /// `Audio(AirPlay)` and `Audio(Cast)`.
    pub fn new(input: R, specs: &[TrackSpec]) -> Result<MediaReader<R>> {
        let demux = Demuxer::new(input)?;
        let assigned = assign(demux.tracks(), specs)?;
        let mut video = None;
        let mut audio = Vec::new();
        let mut tracks = Vec::new();
        for (t, spec) in assigned {
            match spec.kind {
                TrackKind::Video => {
                    let (info, length_size) = video_info(t)?;
                    let h264 = info.codec == VideoCodec::H264;
                    video = Some(info);
                    tracks.push(Mapped {
                        number: t.number,
                        kind: spec.kind,
                        rate: VIDEO_CLOCK_RATE,
                        frame_samples: 0,
                        codec: Codec::Video { length_size, h264 },
                        next_pts: None,
                    });
                }
                TrackKind::Audio(family) => {
                    let info = audio_info(t, spec.frame_samples)?;
                    let codec = match info.codec {
                        AudioCodec::Opus => Codec::Opus,
                        AudioCodec::PcmS16le => Codec::Pcm {
                            bytes_per_frame: 2 * info.channels as usize,
                        },
                        _ => Codec::Other,
                    };
                    tracks.push(Mapped {
                        number: t.number,
                        kind: spec.kind,
                        rate: info.sample_rate,
                        frame_samples: info.frame_samples,
                        codec,
                        next_pts: None,
                    });
                    audio.push((family, info));
                }
            }
        }
        let video = video.ok_or_else(|| Error::unsupported("media: input has no video track"))?;
        let origin_ns = demux
            .tracks()
            .iter()
            .map(|t| t.codec_delay_ns.min(10_000_000_000) as i64)
            .max()
            .unwrap_or(0);
        Ok(MediaReader {
            demux,
            info: StreamInfo { video, audio },
            tracks,
            origin_ns,
            dropped_negative: 0,
        })
    }

    pub fn info(&self) -> &StreamInfo {
        &self.info
    }

    pub fn demuxer(&self) -> &Demuxer<R> {
        &self.demux
    }

    /// The next frame of a mapped track; `None` at the end of the stream.
    pub fn next_frame(&mut self) -> Result<Option<DemuxedFrame>> {
        loop {
            let Some(f) = self.demux.next_frame()? else {
                return Ok(None);
            };
            let container_pts = self.demux.ffprobe_pts(&f);
            let Some(idx) = self.tracks.iter().position(|t| t.number == f.track) else {
                continue;
            };
            let ns = f.pts_ns.saturating_add(self.origin_ns);
            if ns < 0 {
                self.dropped_negative += 1;
                debug!("dropping frame with negative pts on track {}", f.track);
                continue;
            }
            let scale = self.demux.timestamp_scale();
            let t = &mut self.tracks[idx];
            let measured = ns_to_ticks(ns as u64, t.rate);
            let (pts, keyframe, data) = match t.codec {
                Codec::Video { length_size, h264 } => {
                    let data = to_avcc4(f.data, length_size)?;
                    let idr = !h264 || h264::is_idr(&data, 4).unwrap_or(false);
                    (measured, f.keyframe && idr, data)
                }
                codec => {
                    let samples = match codec {
                        Codec::Opus => opus_packet_samples(&f.data)
                            .map(|n| n as u64 * t.rate as u64 / 48_000)
                            .unwrap_or(t.frame_samples as u64),
                        Codec::Pcm { bytes_per_frame } => (f.data.len() / bytes_per_frame) as u64,
                        _ => t.frame_samples as u64,
                    };
                    // One container tick of jitter is expected; more is a
                    // real gap (or overlap) and we follow the container.
                    let tolerance = ns_to_ticks(scale, t.rate) + 1;
                    let pts = match t.next_pts {
                        Some(p) if p.abs_diff(measured) <= tolerance => p,
                        Some(p) => {
                            debug!(
                                "audio track {} resync: expected {} got {} ticks",
                                f.track, p, measured
                            );
                            measured
                        }
                        None => measured,
                    };
                    t.next_pts = Some(pts + samples);
                    (pts, true, f.data)
                }
            };
            return Ok(Some(DemuxedFrame {
                frame: EncodedFrame {
                    track: t.kind,
                    pts,
                    keyframe,
                    data: Arc::from(data),
                },
                track_number: f.track,
                container_pts,
                container_keyframe: f.keyframe,
            }));
        }
    }

    /// Frames dropped because their pts was before the stream start.
    pub fn dropped_negative(&self) -> u64 {
        self.dropped_negative
    }

    /// Added to the container's nanoseconds to get this reader's
    /// timeline (the largest CodecDelay).
    pub fn origin_ns(&self) -> i64 {
        self.origin_ns
    }
}

impl<R: Read + Seek> MediaReader<R> {
    /// Continues at the Cluster whose header starts at byte `pos`
    /// ([`Demuxer::seek_cluster`]); audio pts restart from the container
    /// timestamps.
    pub fn seek_cluster(&mut self, pos: u64) -> Result<()> {
        self.demux.seek_cluster(pos)?;
        for t in &mut self.tracks {
            t.next_pts = None;
        }
        Ok(())
    }
}

fn ns_to_ticks(ns: u64, rate: u32) -> u64 {
    // Round to nearest.
    ((ns as u128 * rate as u128 + 500_000_000) / 1_000_000_000) as u64
}

fn assign<'a>(tracks: &'a [Track], specs: &[TrackSpec]) -> Result<Vec<(&'a Track, TrackSpec)>> {
    if specs.is_empty() {
        let mut out = Vec::new();
        if let Some(v) = tracks.iter().find(|t| t.track_type == TrackType::Video) {
            out.push((
                v,
                TrackSpec {
                    kind: TrackKind::Video,
                    frame_samples: 0,
                },
            ));
        }
        let families = [AudioFamily::AirPlay, AudioFamily::Cast];
        for (t, family) in tracks
            .iter()
            .filter(|t| t.track_type == TrackType::Audio)
            .zip(families)
        {
            out.push((
                t,
                TrackSpec {
                    kind: TrackKind::Audio(family),
                    frame_samples: 0,
                },
            ));
        }
        return Ok(out);
    }
    // `-map 0:a:0?` drops the audio outputs when the input has none.
    let audio_less = tracks.len() == 1
        && tracks[0].track_type == TrackType::Video
        && specs.first().is_some_and(|s| s.kind == TrackKind::Video);
    if audio_less && specs.len() > 1 {
        warn!("input has no audio; streaming video only");
        return Ok(vec![(&tracks[0], specs[0])]);
    }
    if tracks.len() != specs.len() {
        return Err(Error::protocol(format!(
            "media: ffmpeg wrote {} tracks, expected {}",
            tracks.len(),
            specs.len()
        )));
    }
    tracks
        .iter()
        .zip(specs)
        .map(|(t, s)| {
            let ok = matches!(
                (t.track_type, s.kind),
                (TrackType::Video, TrackKind::Video) | (TrackType::Audio, TrackKind::Audio(_))
            );
            if ok {
                Ok((t, *s))
            } else {
                Err(Error::protocol(format!(
                    "media: track {} is {:?}, expected {:?}",
                    t.number, t.track_type, s.kind
                )))
            }
        })
        .collect()
}

/// Frame rate from a frame duration, snapped to integer and NTSC rates.
pub fn fps_from_duration(ns: u64) -> Option<Ratio> {
    if ns == 0 {
        return None;
    }
    let fps = 1e9 / ns as f64;
    let int = fps.round();
    if int >= 1.0 && (fps - int).abs() < 0.01 {
        return Some(Ratio::integer(int as u32));
    }
    let ntsc = (fps * 1.001).round();
    if ntsc >= 1.0 && (fps - ntsc / 1.001).abs() < 0.01 {
        return Some(Ratio::new(ntsc as u32 * 1000, 1001));
    }
    u32::try_from(ns).ok().map(|d| {
        let g = gcd(1_000_000_000, d);
        Ratio::new(1_000_000_000 / g, d / g)
    })
}

fn gcd(mut a: u32, mut b: u32) -> u32 {
    while b != 0 {
        (a, b) = (b, a % b);
    }
    a
}

fn video_info(t: &Track) -> Result<(VideoInfo, usize)> {
    match t.codec_id.as_str() {
        "V_MPEG4/ISO/AVC" => {
            let cfg = h264::AvcConfig::parse(&t.codec_private)?;
            let sps = cfg
                .sps
                .first()
                .ok_or_else(|| Error::malformed("media: avcC without SPS"))?;
            let sps = h264::parse_sps(sps)?;
            let fps = sps
                .fps
                .or_else(|| t.default_duration_ns.and_then(fps_from_duration))
                .unwrap_or(Ratio::integer(30));
            let length_size = cfg.length_size as usize;
            // Frames are rewritten to 4-byte lengths; say so in the record.
            let avcc = if length_size == 4 {
                t.codec_private.clone()
            } else {
                h264::AvcConfig {
                    length_size: 4,
                    ..cfg
                }
                .to_bytes()?
            };
            Ok((
                VideoInfo {
                    codec: VideoCodec::H264,
                    width: sps.width,
                    height: sps.height,
                    fps,
                    avcc,
                },
                length_size,
            ))
        }
        "V_MPEGH/ISO/HEVC" => {
            // hvcC lengthSizeMinusOne is the low 2 bits of byte 21.
            let length_size = t.codec_private.get(21).map_or(4, |b| (b & 3) as usize + 1);
            Ok((
                VideoInfo {
                    codec: VideoCodec::Hevc,
                    width: t.pixel_width.unwrap_or(0),
                    height: t.pixel_height.unwrap_or(0),
                    fps: t
                        .default_duration_ns
                        .and_then(fps_from_duration)
                        .unwrap_or(Ratio::integer(30)),
                    avcc: t.codec_private.clone(),
                },
                length_size,
            ))
        }
        other => Err(Error::unsupported(format!(
            "media: unsupported video codec {other}"
        ))),
    }
}

/// Rewrites length prefixes to 4 bytes (a no-op copy for 4).
fn to_avcc4(data: Vec<u8>, length_size: usize) -> Result<Vec<u8>> {
    if length_size == 4 {
        return Ok(data);
    }
    let mut out = Vec::with_capacity(data.len() + 16);
    for nal in h264::avcc_nals(&data, length_size) {
        let nal = nal?;
        out.extend_from_slice(&(nal.len() as u32).to_be_bytes());
        out.extend_from_slice(nal);
    }
    Ok(out)
}

fn audio_info(t: &Track, planned_samples: u32) -> Result<AudioInfo> {
    let sample_rate = t.sampling_frequency.unwrap_or(8000.0);
    if !(sample_rate.is_finite() && (1.0..=1_000_000.0).contains(&sample_rate)) {
        return Err(Error::malformed("media: invalid audio sampling frequency"));
    }
    let sample_rate = sample_rate.round() as u32;
    let channels = t.channels.unwrap_or(1).max(1);
    let duration_samples = t
        .default_duration_ns
        .map(|ns| ns_to_ticks(ns, sample_rate) as u32)
        .filter(|&n| n > 0);
    let pick = |default: u32| {
        if planned_samples > 0 {
            planned_samples
        } else {
            duration_samples.unwrap_or(default)
        }
    };
    let (codec, frame_samples) = match t.codec_id.as_str() {
        "A_ALAC" => {
            // ALACSpecificConfig: frameLength is the first u32 (BE).
            let n = t
                .codec_private
                .get(..4)
                .map(|b| u32::from_be_bytes([b[0], b[1], b[2], b[3]]))
                .ok_or_else(|| Error::malformed("media: ALAC track without config"))?;
            (AudioCodec::Alac, n)
        }
        // Unknown (0) unless planned: Opus packets carry their own duration.
        "A_OPUS" => (AudioCodec::Opus, pick(0)),
        "A_AAC" => {
            let (aot, frame) = aac_config(&t.codec_private)?;
            match aot {
                2 => (AudioCodec::AacLc, frame),
                39 => (AudioCodec::AacEld, frame),
                n => {
                    return Err(Error::unsupported(format!(
                        "media: AAC object type {n} not supported"
                    )))
                }
            }
        }
        "A_PCM/INT/LIT" if t.bit_depth.unwrap_or(16) == 16 => (AudioCodec::PcmS16le, pick(0)),
        other => {
            return Err(Error::unsupported(format!(
                "media: unsupported audio codec {other}"
            )))
        }
    };
    Ok(AudioInfo {
        codec,
        sample_rate,
        channels,
        frame_samples,
        config: t.codec_private.clone(),
    })
}

/// (audioObjectType, samples per frame) from an AudioSpecificConfig.
fn aac_config(asc: &[u8]) -> Result<(u32, u32)> {
    let bad = || Error::malformed("media: truncated AudioSpecificConfig");
    let bit = |i: usize| -> Result<u32> {
        asc.get(i / 8)
            .map(|b| ((b >> (7 - i % 8)) & 1) as u32)
            .ok_or_else(bad)
    };
    let bits = |at: &mut usize, n: usize| -> Result<u32> {
        let mut v = 0;
        for _ in 0..n {
            v = (v << 1) | bit(*at)?;
            *at += 1;
        }
        Ok(v)
    };
    let mut at = 0;
    let mut aot = bits(&mut at, 5)?;
    if aot == 31 {
        aot = 32 + bits(&mut at, 6)?;
    }
    let freq_index = bits(&mut at, 4)?;
    if freq_index == 15 {
        bits(&mut at, 24)?;
    }
    let _channel_config = bits(&mut at, 4)?;
    let frame = match aot {
        // ELDSpecificConfig starts with frameLengthFlag: 1 = 480.
        39 => {
            if bits(&mut at, 1)? == 1 {
                480
            } else {
                512
            }
        }
        // GASpecificConfig frameLengthFlag: 1 = 960.
        _ => {
            if bits(&mut at, 1)? == 1 {
                960
            } else {
                1024
            }
        }
    };
    Ok((aot, frame))
}

/// Samples (at 48 kHz) in an Opus packet, from its TOC byte (RFC 6716 §3.1).
pub fn opus_packet_samples(packet: &[u8]) -> Option<u32> {
    let toc = *packet.first()?;
    let config = toc >> 3;
    let per_frame = match config {
        0..=11 => [480, 960, 1920, 2880][(config % 4) as usize],
        12..=15 => [480, 960][(config % 2) as usize],
        _ => [120, 240, 480, 960][(config % 4) as usize],
    };
    let frames = match toc & 3 {
        0 => 1,
        1 | 2 => 2,
        _ => (*packet.get(1)? & 0x3f) as u32,
    };
    let total = per_frame * frames;
    // At most 120 ms per packet.
    (total > 0 && total <= 5760).then_some(total)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::util::vectors;

    #[test]
    fn fixture_to_encoded_frames() {
        let data = vectors::fixture("media/live.mkv");
        let mut r = MediaReader::new(&data[..], &[]).unwrap();
        let info = r.info().clone();
        assert_eq!(info.video.codec, VideoCodec::H264);
        assert_eq!((info.video.width, info.video.height), (160, 120));
        assert_eq!(info.video.fps, Ratio::integer(30));
        let alac = info.audio_for(AudioFamily::AirPlay).unwrap();
        assert_eq!(alac.codec, AudioCodec::Alac);
        assert_eq!(
            (alac.sample_rate, alac.channels, alac.frame_samples),
            (44100, 2, 4096)
        );
        let opus = info.audio_for(AudioFamily::Cast).unwrap();
        assert_eq!(opus.codec, AudioCodec::Opus);
        assert_eq!(opus.sample_rate, 48000);
        assert!(opus.config.starts_with(b"OpusHead"));

        let mut last: std::collections::HashMap<TrackKind, u64> = Default::default();
        let mut video_keys = 0;
        let mut first_video = None;
        let mut opus_pts = Vec::new();
        while let Some(f) = r.next_frame().unwrap() {
            let fr = &f.frame;
            if let Some(&prev) = last.get(&fr.track) {
                assert!(fr.pts > prev, "{:?} not monotonic", fr.track);
            }
            last.insert(fr.track, fr.pts);
            match fr.track {
                TrackKind::Video => {
                    first_video.get_or_insert(fr.pts);
                    if fr.keyframe {
                        video_keys += 1;
                    }
                    assert_eq!(fr.keyframe, f.container_keyframe);
                    assert!(h264::avcc_nals(&fr.data, 4).all(|n| n.is_ok()));
                }
                TrackKind::Audio(AudioFamily::Cast) => opus_pts.push(fr.pts),
                _ => {}
            }
        }
        // GOP of 15 at 30 fps for one second.
        assert_eq!(video_keys, 2);
        // Opus: every packet is exactly 480 samples after the first, and the
        // first starts at 0 once shifted by the 2.5 ms codec delay; video is
        // shifted by the same 2.5 ms (225 ticks at 90 kHz).
        assert_eq!(opus_pts[0], 0);
        assert!(opus_pts.windows(2).all(|w| w[1] - w[0] == 480));
        assert_eq!(first_video, Some(225));
        assert_eq!(r.dropped_negative(), 0);
    }

    /// Runs the real ffmpeg on the fixture with the default test plan.
    #[test]
    fn ffmpeg_encode_roundtrip() {
        use crate::media::ffmpeg::{self, Output, Process, Source};
        let Some((bin, probe)) = ffmpeg::tests::real_ffmpeg() else {
            return;
        };
        let mut plan = ffmpeg::tests::plan();
        plan.video.width = 320;
        plan.video.height = 240;
        plan.video.bitrate_kbps = 500;
        // Resampled from the fixture's 44.1 kHz.
        plan.audio[0].sample_rate = 48_000;
        let src = Source::Url {
            url: vectors::path("tests/fixtures/media/live.mkv").into(),
            realtime: false,
            looped: false,
            start: None,
            freeze: false,
        };
        let inv = ffmpeg::build(&src, Output::Encode(&plan), &probe, "error").unwrap();
        let mut proc = Process::spawn(&bin, &inv.args).unwrap();
        let mut r = MediaReader::new(proc.take_stdout().unwrap(), &inv.tracks).unwrap();
        let info = r.info().clone();
        assert_eq!((info.video.width, info.video.height), (320, 240));
        let pcm = info.audio_for(AudioFamily::AirPlay).unwrap();
        assert_eq!((pcm.codec, pcm.frame_samples), (AudioCodec::PcmS16le, 352));
        assert_eq!(
            info.audio_for(AudioFamily::Cast).unwrap().frame_samples,
            480
        );
        let mut counts = std::collections::HashMap::<TrackKind, Vec<u64>>::new();
        let mut keys = Vec::new();
        let mut pcm_sizes = Vec::new();
        while let Some(f) = r.next_frame().unwrap() {
            let fr = f.frame;
            if fr.track == TrackKind::Audio(AudioFamily::AirPlay) {
                pcm_sizes.push(fr.data.len());
            }
            if fr.track == TrackKind::Video && fr.keyframe {
                keys.push(counts.get(&TrackKind::Video).map_or(0, |v| v.len()));
            }
            counts.entry(fr.track).or_default().push(fr.pts);
        }
        proc.wait().unwrap();
        // Whole 352-sample stereo frames, except possibly the last.
        pcm_sizes.pop();
        assert!(pcm_sizes.iter().all(|&n| n == 352 * 4), "{pcm_sizes:?}");
        let video = &counts[&TrackKind::Video];
        assert_eq!(video.len(), 30);
        assert_eq!(keys, [0]);
        // 90 kHz at 30 fps: 3000 ticks per frame, +-1 ms container rounding.
        assert!(video
            .windows(2)
            .all(|w| w[1] - w[0] >= 2910 && w[1] - w[0] <= 3090));
        let pcm = &counts[&TrackKind::Audio(AudioFamily::AirPlay)];
        assert!(pcm.windows(2).all(|w| w[1] - w[0] == 352), "{pcm:?}");
        let opus = &counts[&TrackKind::Audio(AudioFamily::Cast)];
        assert!(opus.windows(2).all(|w| w[1] - w[0] == 480), "{opus:?}");
        assert!(opus.len() >= 99);
    }

    #[test]
    fn opus_toc() {
        assert_eq!(opus_packet_samples(&[0xfc]), Some(960)); // CELT 20 ms
        assert_eq!(opus_packet_samples(&[0xf0]), Some(480)); // CELT 10 ms
        assert_eq!(opus_packet_samples(&[0x80 | 0x01]), Some(240)); // 2x2.5 ms
        assert_eq!(opus_packet_samples(&[0x18 | 0x03, 3]), None); // 3x60 ms > 120 ms
        assert_eq!(opus_packet_samples(&[0x03, 0]), None);
        assert_eq!(opus_packet_samples(&[]), None);
    }

    #[test]
    fn asc() {
        // AAC-LC 44.1 kHz stereo: 0x1210.
        assert_eq!(aac_config(&[0x12, 0x10]).unwrap(), (2, 1024));
        // AAC-ELD (escape 31 + 7), 44.1 kHz, stereo, frameLengthFlag 1.
        // bits: 11111 000111 0100 0010 1 -> f8 e8 50 (padded)
        assert_eq!(aac_config(&[0xf8, 0xe8, 0x50]).unwrap(), (39, 480));
        assert!(aac_config(&[0x12]).is_err());
    }

    #[test]
    fn durations() {
        assert_eq!(fps_from_duration(33_333_333), Some(Ratio::integer(30)));
        assert_eq!(fps_from_duration(33_366_667), Some(Ratio::new(30000, 1001)));
        assert_eq!(fps_from_duration(16_683_333), Some(Ratio::new(60000, 1001)));
        assert_eq!(fps_from_duration(40_000_000), Some(Ratio::integer(25)));
        assert_eq!(fps_from_duration(0), None);
    }
}
