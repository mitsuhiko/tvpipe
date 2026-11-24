//! Passthrough: sending a file's own encoded frames, without ffmpeg
//! (ARCHITECTURE.md, "Inputs").
//!
//! - [`FileSource`] demuxes MP4/MOV ([`mp4`](super::mp4)) or Matroska/WebM
//!   ([`source::MediaReader`] over [`mkv`](super::mkv)) into
//!   [`EncodedFrame`]s in our conventions: AVCC with 4-byte lengths, pts in
//!   90 kHz / sample ticks on one timeline starting near zero.
//!   [`FileSource::seek`] jumps to a video IDR picture near a time: MP4 by
//!   walking the sample tables (or the `moof`s) without reading media
//!   data, Matroska by an index of the Clusters and reading from the
//!   nearest one.
//! - [`probe`] opens a file and scans its first seconds: stream info, SPS,
//!   B-frame reordering, bitrate.
//! - [`check`] decides from that and every sink's [`Capabilities`] whether
//!   the file can be sent unchanged, and otherwise says precisely why not
//!   (so the log can say why ffmpeg is used).
//!
//! Sources: ISO/IEC 14496-3 §1.6.2.1 (AudioSpecificConfig, Table 1.16
//! sampling frequencies); ITU-T H.264 §7.4.2.1.1, Annex E.2.1;
//! ARCHITECTURE.md, "Inputs"; docs/measurements.md.

use std::cmp::Ordering;
use std::collections::VecDeque;
use std::fmt;
use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use crate::error::{Error, Result};
pub use crate::media::formats::{parse_asc, sink_takes};
use crate::media::h264::{self, AvcConfig, Sps};
use crate::media::mkv;
use crate::media::mp4::{self, Codec as Mp4Codec, TrackType as Mp4TrackType};
use crate::media::source::{self, MediaReader};
use crate::types::{
    AudioCodec, AudioFamily, AudioFormat, AudioInfo, Capabilities, EncodedFrame, TrackKind,
    VideoCodec, VideoInfo, VIDEO_CLOCK_RATE,
};
use crate::util::ratio::Ratio;

/// How much of the file [`probe`] reads.
const PROBE_SECONDS: f64 = 5.0;
const PROBE_MAX_FRAMES: usize = 2000;
/// Samples buffered at open to find each track's first timestamp.
const ORIGIN_LOOKAHEAD: usize = 512;
/// Frame rate slack when comparing with a receiver's maximum.
const FPS_TOLERANCE: f64 = 1.005;
/// Most audio frames held back while landing on a seek's keyframe.
const MAX_LANDING_AUDIO: usize = 1024;
const NS_PER_S: i128 = 1_000_000_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Container {
    Mp4,
    Matroska,
}

impl fmt::Display for Container {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Container::Mp4 => "MP4",
            Container::Matroska => "Matroska",
        })
    }
}

/// The container from the first bytes, if we can demux it.
pub fn sniff(head: &[u8]) -> Option<Container> {
    if head.starts_with(&[0x1a, 0x45, 0xdf, 0xa3]) {
        return Some(Container::Matroska);
    }
    let typ = head.get(4..8)?;
    let mp4 = [
        &b"ftyp"[..],
        b"moov",
        b"mdat",
        b"free",
        b"skip",
        b"wide",
        b"pnot",
        b"styp",
    ];
    mp4.contains(&typ).then_some(Container::Mp4)
}

/// Whether `path` names a regular file we can demux.
pub fn container_of(path: &Path) -> Option<Container> {
    if !path.is_file() {
        return None;
    }
    let mut head = [0u8; 12];
    let mut f = File::open(path).ok()?;
    let mut got = 0;
    while got < head.len() {
        match f.read(&mut head[got..]) {
            Ok(0) => break,
            Ok(n) => got += n,
            Err(_) => return None,
        }
    }
    sniff(&head[..got])
}

/// What the file holds, in our types, plus what the compatibility check
/// needs to know.
#[derive(Debug, Clone, PartialEq)]
pub struct FileInfo {
    pub container: Container,
    pub video: VideoInfo,
    /// Parsed first SPS (H.264 only).
    pub sps: Option<Sps>,
    /// The first audio track, if it maps to an [`AudioCodec`].
    pub audio: Option<AudioInfo>,
    /// An audio track we cannot pass through (e.g. `"mp4a/0x6b"`), when
    /// `audio` is `None` because of it.
    pub unsupported_audio: Option<String>,
    /// Container-level problems that rule passthrough out (codec config
    /// changes, cuts, rotation).
    pub problems: Vec<String>,
    /// Whether the whole sample table was checked for reordering (MP4
    /// without fragments) rather than just the probed prefix.
    pub reorder_checked_fully: bool,
    /// Presentation order differs from decode order (B-frames) in what
    /// was checked.
    pub reorders: bool,
    /// Duration in seconds, if the container says.
    pub duration: Option<f64>,
    /// Average video bitrate, from the whole file (MP4) or the probe.
    pub video_kbps: Option<u32>,
    /// Peak video bitrate over one-second windows of the probed prefix.
    pub peak_video_kbps: Option<u32>,
    /// Longest gap between video keyframes in the probed prefix, in
    /// seconds (receivers recover from loss only at keyframes). When the
    /// prefix had a single keyframe, its length.
    pub keyframe_interval: Option<f64>,
}

/// A frame from a [`FileSource`].
#[derive(Debug, Clone)]
pub struct FileFrame {
    /// `Video` or `Audio(AudioFamily::AirPlay)`: the file's one audio
    /// track (the caller fans it out to the families in use).
    pub frame: EncodedFrame,
    /// Media duration of the frame in its pts ticks, if known.
    pub duration: u64,
    /// Decode time in the same ticks (MP4; equal to the pts for
    /// Matroska, which does not store it). Can be negative before the
    /// shift to zero: then 0.
    pub dts: u64,
}

enum Inner {
    Mp4(Mp4State),
    Mkv(MediaReader<File>),
}

struct Mp4State {
    demux: mp4::Demuxer<File>,
    video_id: u32,
    video_scale: u32,
    audio: Option<(u32, u32)>,
    length_size: usize,
    is_h264: bool,
    origin_ns: i128,
    lookahead: VecDeque<mp4::Sample>,
}

/// A Matroska Cluster for seeking.
#[derive(Debug, Clone, Copy)]
struct ClusterMark {
    pos: u64,
    /// Its Timestamp on the [`FileSource`] timeline, in ns (the video's
    /// CodecDelay and TrackTimestampScale ignored: a starting point only).
    ns: i128,
}

/// A demuxed file yielding frames in our conventions. Not paced.
pub struct FileSource {
    path: PathBuf,
    info: FileInfo,
    inner: Inner,
    /// Frames dropped because their pts fell before the stream start.
    dropped_negative: u64,
    /// Frames to return before reading on: audio read while landing on a
    /// seek's keyframe.
    ready: VecDeque<FileFrame>,
    /// Audio goes to `ready` (until the keyframe is returned).
    buffering: bool,
    /// After a seek: video is dropped until the keyframe at or after this
    /// pts (90 kHz).
    awaiting_key: Option<u64>,
    /// After a seek: audio presented before this pts (90 kHz) is dropped,
    /// until the first frame at or after it.
    audio_from: Option<u64>,
    /// Matroska Clusters, indexed at the first seek.
    clusters: Option<Vec<ClusterMark>>,
}

impl FileSource {
    pub fn open(path: &Path) -> Result<FileSource> {
        let container = container_of(path).ok_or_else(|| {
            Error::unsupported(format!(
                "{}: not an MP4/MOV or Matroska/WebM file",
                path.display()
            ))
        })?;
        let file =
            File::open(path).map_err(|e| Error::io(format!("open {}", path.display()), e))?;
        let (inner, info) = match container {
            Container::Mp4 => open_mp4(file)?,
            Container::Matroska => open_mkv(file)?,
        };
        Ok(FileSource {
            path: path.to_owned(),
            info,
            inner,
            dropped_negative: 0,
            ready: VecDeque::new(),
            buffering: false,
            awaiting_key: None,
            audio_from: None,
            clusters: None,
        })
    }

    pub fn info(&self) -> &FileInfo {
        &self.info
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn dropped_negative(&self) -> u64 {
        self.dropped_negative
    }

    /// Starts over (for `--loop`): the same timestamps as the first pass.
    pub fn rewind(&mut self) -> Result<()> {
        self.ready.clear();
        self.buffering = false;
        self.awaiting_key = None;
        self.audio_from = None;
        match &mut self.inner {
            Inner::Mp4(m) => {
                m.demux.rewind();
                m.lookahead.clear();
            }
            Inner::Mkv(_) => {
                let file = File::open(&self.path)
                    .map_err(|e| Error::io(format!("open {}", self.path.display()), e))?;
                self.inner = open_mkv(file)?.0;
            }
        }
        Ok(())
    }

    /// The next video or audio frame; `None` at the end of the file.
    pub fn next_frame(&mut self) -> Result<Option<FileFrame>> {
        loop {
            if !self.buffering {
                if let Some(f) = self.ready.pop_front() {
                    return Ok(Some(f));
                }
            }
            let got = match &mut self.inner {
                Inner::Mp4(m) => next_mp4(m)?,
                Inner::Mkv(r) => next_mkv(r)?,
            };
            match got {
                Next::End => {
                    self.buffering = false;
                    self.awaiting_key = None;
                    return Ok(self.ready.pop_front());
                }
                Next::Skip => continue,
                Next::Negative => {
                    self.dropped_negative += 1;
                    continue;
                }
                Next::Frame(f) => {
                    if let Some(f) = self.after_seek(f) {
                        return Ok(Some(f));
                    }
                }
            }
        }
    }

    /// Positions the source at a video keyframe (an IDR picture for H.264;
    /// any sync sample / keyframe for HEVC) near `target_ns`, a time on the
    /// timeline of the frames' pts (ns since that timeline's zero):
    ///
    /// - `forward`: the first keyframe at or after the target, or if there
    ///   is none the last one before it;
    /// - otherwise the last keyframe at or before the target, or if there is
    ///   none the first one after it.
    ///
    /// The target is compared at 90 kHz (rounded to the nearest tick), so
    /// seeking to a returned time lands on the same keyframe either way.
    /// Returns the keyframe's pts in ns (its 90 kHz pts, rounded to the
    /// nearest ns). Then
    /// [`next_frame`](Self::next_frame) returns that keyframe first, then
    /// the audio read before it in the file that is presented at or after
    /// it, then the frames as usual, except that audio presented before the
    /// keyframe is dropped (only until the first audio frame at or after
    /// it). Video before the keyframe never comes. Works at any position,
    /// also after the end of the file; [`rewind`](Self::rewind) still
    /// starts over.
    ///
    /// `Ok(None)`: the file has no keyframe to land on. MP4 is left where
    /// it was; Matroska is rewound to its first Cluster. After an error the
    /// position is unspecified (seek again or rewind).
    ///
    /// MP4 walks the sample tables in memory (fragmented: reads the `moof`
    /// boxes from the start) and reads only candidate keyframes' data.
    /// Matroska indexes the Clusters once (one small read per Cluster),
    /// then reads from the Cluster before the first one that starts after
    /// the target (backwards: then earlier Clusters, one by one, until a
    /// keyframe is found), and lands by reading its Cluster again from its
    /// start. A keyframe stored in an earlier Cluster than one starting
    /// after it is not found going forward. After an unknown-size Cluster
    /// the index ends and seeks beyond it read the file from there.
    pub fn seek(&mut self, target_ns: u128, forward: bool) -> Result<Option<u128>> {
        let target = ticks(target_ns.min(u64::MAX as u128) as i128, VIDEO_CLOCK_RATE);
        let key = match &mut self.inner {
            Inner::Mp4(m) => seek_mp4(m, target, forward)?,
            Inner::Mkv(_) => self.seek_mkv(target, forward)?,
        };
        let Some(key) = key else {
            return Ok(None);
        };
        self.ready.clear();
        self.buffering = true;
        self.awaiting_key = Some(key);
        self.audio_from = Some(key);
        let rate = VIDEO_CLOCK_RATE as u128;
        Ok(Some((key as u128 * NS_PER_S as u128 + rate / 2) / rate))
    }

    /// Applies a seek's landing rules to a frame read; `None` when it is
    /// dropped or held back in `ready`.
    fn after_seek(&mut self, f: FileFrame) -> Option<FileFrame> {
        if f.frame.track == TrackKind::Video {
            let Some(key) = self.awaiting_key else {
                return Some(f);
            };
            if f.frame.keyframe && f.frame.pts >= key {
                self.awaiting_key = None;
                self.buffering = false;
                return Some(f);
            }
            return None;
        }
        if let Some(from) = self.audio_from {
            let rate = self.info.audio.as_ref().map_or(1, |a| a.sample_rate.max(1));
            if (f.frame.pts as u128) * (VIDEO_CLOCK_RATE as u128) < from as u128 * rate as u128 {
                return None;
            }
            self.audio_from = None;
        }
        if self.buffering {
            if self.ready.len() + 1 >= MAX_LANDING_AUDIO {
                // No keyframe in sight: stop holding audio back.
                self.buffering = false;
            }
            self.ready.push_back(f);
            return None;
        }
        Some(f)
    }

    /// `target` in 90 kHz ticks.
    fn seek_mkv(&mut self, target: i128, forward: bool) -> Result<Option<u64>> {
        let clusters = match self.clusters.take() {
            Some(c) => c,
            None => self.index_clusters()?,
        };
        let Inner::Mkv(r) = &mut self.inner else {
            return Ok(None);
        };
        let rv = seek_mkv(r, &clusters, target, forward);
        if let Ok(None) = rv {
            self.ready.clear();
            self.buffering = false;
            self.awaiting_key = None;
            self.audio_from = None;
        }
        self.clusters = Some(clusters);
        rv
    }

    /// Lists the Clusters on a handle of its own (never empty: the first
    /// Cluster is always there).
    fn index_clusters(&self) -> Result<Vec<ClusterMark>> {
        let Inner::Mkv(r) = &self.inner else {
            return Ok(Vec::new());
        };
        let first = r.demuxer().first_cluster();
        let scale = r.demuxer().timestamp_scale() as i128;
        let origin = r.origin_ns() as i128;
        let mut file = File::open(&self.path)
            .map_err(|e| Error::io(format!("open {}", self.path.display()), e))?;
        let index = mkv::index_clusters(&mut file, first)?;
        let mut out: Vec<ClusterMark> = index
            .clusters
            .iter()
            .map(|c| ClusterMark {
                pos: c.pos,
                ns: c.timestamp as i128 * scale + origin,
            })
            .collect();
        if out.first().map(|c| c.pos) != Some(first) {
            out.insert(
                0,
                ClusterMark {
                    pos: first,
                    ns: i128::MIN,
                },
            );
        }
        if !index.complete {
            debug!(
                "{}: {} Clusters indexed, seeking beyond reads on",
                self.path.display(),
                out.len()
            );
        }
        Ok(out)
    }
}

/// Where a 90 kHz pts lies relative to a target (90 kHz).
fn relative(pts: i128, target: i128) -> Ordering {
    pts.cmp(&target)
}

/// [`FileSource::seek`] for MP4 (`target` in 90 kHz ticks): the
/// keyframe's 90 kHz pts.
fn seek_mp4(m: &mut Mp4State, target: i128, forward: bool) -> Result<Option<u64>> {
    let (scale, origin) = (m.video_scale, m.origin_ns);
    let (length_size, is_h264) = (m.length_size, m.is_h264);
    // The pts next_mp4 gives the sample.
    let to_90k = move |pts: i64| ticks(to_ns(pts, scale) - origin, VIDEO_CLOCK_RATE);
    let cmp = |pts: i64| relative(to_90k(pts), target);
    let accept = |data: &[u8]| !is_h264 || h264::is_idr(data, length_size).unwrap_or(false);
    let Some(point) = m.demux.seek(m.video_id, forward, cmp, accept)? else {
        return Ok(None);
    };
    m.lookahead.clear();
    Ok(Some(to_90k(point.pts).max(0) as u64))
}

/// [`FileSource::seek`] for Matroska (`target` in 90 kHz ticks): leaves `r`
/// at the start of the keyframe's Cluster and returns its pts.
fn seek_mkv(
    r: &mut MediaReader<File>,
    clusters: &[ClusterMark],
    target: i128,
    forward: bool,
) -> Result<Option<u64>> {
    let Some(first) = clusters.first() else {
        return Ok(None);
    };
    // The Cluster before the first that starts after the target: Clusters
    // can start a little before the previous one (an audio track's own).
    let target_ns = target * NS_PER_S / VIDEO_CLOCK_RATE as i128;
    let k = clusters
        .iter()
        .position(|c| c.ns > target_ns)
        .map_or(clusters.len() - 1, |i| i.saturating_sub(1));
    let found = if forward {
        match mkv_key_after(r, clusters[k].pos, target)? {
            Some(f) => Some(f),
            None => mkv_key_before(r, clusters, k, target)?,
        }
    } else {
        match mkv_key_before(r, clusters, k, target)? {
            Some(f) => Some(f),
            None => mkv_key_after(r, clusters[k].pos, target)?,
        }
    };
    match found {
        Some((pos, pts)) => {
            r.seek_cluster(pos)?;
            Ok(Some(pts))
        }
        None => {
            r.seek_cluster(first.pos)?;
            Ok(None)
        }
    }
}

/// The first keyframe at or after `target` reading from the Cluster at
/// `pos`: (its Cluster's position, its pts).
fn mkv_key_after(r: &mut MediaReader<File>, pos: u64, target: i128) -> Result<Option<(u64, u64)>> {
    r.seek_cluster(pos)?;
    while let Some(f) = r.next_frame()? {
        let fr = &f.frame;
        if fr.track == TrackKind::Video
            && fr.keyframe
            && relative(fr.pts as i128, target) != Ordering::Less
        {
            return Ok(Some((r.demuxer().cluster_position(), fr.pts)));
        }
    }
    Ok(None)
}

/// The last keyframe at or before `target`, looking from Cluster `k` on,
/// then in the Clusters before it one by one.
fn mkv_key_before(
    r: &mut MediaReader<File>,
    clusters: &[ClusterMark],
    k: usize,
    target: i128,
) -> Result<Option<(u64, u64)>> {
    for start in (0..=k.min(clusters.len().saturating_sub(1))).rev() {
        // Below `k`, a Cluster's own frames: the later ones were read.
        let stop = clusters.get(start + 1).filter(|_| start < k).map(|c| c.pos);
        r.seek_cluster(clusters[start].pos)?;
        let mut best = None;
        while let Some(f) = r.next_frame()? {
            let at = r.demuxer().cluster_position();
            if stop.is_some_and(|s| at >= s) {
                break;
            }
            let fr = &f.frame;
            if fr.track != TrackKind::Video {
                continue;
            }
            if relative(fr.pts as i128, target) == Ordering::Greater {
                break;
            }
            if fr.keyframe {
                best = Some((at, fr.pts));
            }
        }
        if best.is_some() {
            return Ok(best);
        }
    }
    Ok(None)
}

enum Next {
    Frame(FileFrame),
    Skip,
    Negative,
    End,
}

fn ticks(ns: i128, rate: u32) -> i128 {
    // Round to nearest (also for negative values).
    let v = ns * rate as i128;
    if v >= 0 {
        (v + 500_000_000) / 1_000_000_000
    } else {
        (v - 500_000_000) / 1_000_000_000
    }
}

fn to_ns(t: i64, scale: u32) -> i128 {
    t as i128 * 1_000_000_000 / scale.max(1) as i128
}

/// Rewrites length prefixes to 4 bytes (a copy for 4).
fn avcc4(data: Vec<u8>, length_size: usize) -> Result<Vec<u8>> {
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

fn next_mp4(m: &mut Mp4State) -> Result<Next> {
    let s = match m.lookahead.pop_front() {
        Some(s) => s,
        None => match m.demux.next_sample()? {
            Some(s) => s,
            None => return Ok(Next::End),
        },
    };
    let (kind, scale, rate) = if s.track_id == m.video_id {
        (TrackKind::Video, m.video_scale, VIDEO_CLOCK_RATE)
    } else {
        match m.audio {
            Some((id, rate)) if id == s.track_id => {
                let scale = m.demux.track(id).map_or(rate, |t| t.timescale);
                (TrackKind::Audio(AudioFamily::AirPlay), scale, rate)
            }
            _ => return Ok(Next::Skip),
        }
    };
    let pts = ticks(to_ns(s.pts, scale) - m.origin_ns, rate);
    if pts < 0 {
        return Ok(Next::Negative);
    }
    let dts = ticks(to_ns(s.dts, scale) - m.origin_ns, rate).max(0) as u64;
    let duration = ticks(to_ns(s.duration as i64, scale), rate).max(0) as u64;
    let (keyframe, data) = if kind == TrackKind::Video {
        let data = avcc4(s.data, m.length_size)?;
        let idr = !m.is_h264 || h264::is_idr(&data, 4).unwrap_or(false);
        (s.keyframe && idr, data)
    } else {
        (true, s.data)
    };
    Ok(Next::Frame(FileFrame {
        frame: EncodedFrame {
            track: kind,
            pts: pts as u64,
            keyframe,
            data: Arc::from(data),
        },
        duration,
        dts,
    }))
}

fn next_mkv(r: &mut MediaReader<File>) -> Result<Next> {
    let Some(f) = r.next_frame()? else {
        return Ok(Next::End);
    };
    match f.frame.track {
        TrackKind::Video | TrackKind::Audio(AudioFamily::AirPlay) => Ok(Next::Frame(FileFrame {
            dts: f.frame.pts,
            frame: f.frame,
            duration: 0,
        })),
        // A second audio track.
        TrackKind::Audio(_) => Ok(Next::Skip),
    }
}

fn mp4_audio_info(t: &mp4::Track) -> std::result::Result<AudioInfo, String> {
    let name = mp4::fourcc_str(t.fourcc);
    let channels = u8::try_from(t.channels).unwrap_or(0);
    let rate = if t.sample_rate > 0 {
        t.sample_rate
    } else {
        t.timescale
    };
    let info = |codec, sample_rate, channels, frame_samples, config: &[u8]| AudioInfo {
        codec,
        sample_rate,
        channels,
        frame_samples,
        config: config.to_vec(),
    };
    match &t.codec {
        Mp4Codec::Aac { asc } => {
            let (aot, asc_rate, asc_channels, frame) =
                parse_asc(asc).map_err(|e| format!("{name}: {e}"))?;
            let codec = match aot {
                2 => AudioCodec::AacLc,
                39 => AudioCodec::AacEld,
                n => return Err(format!("AAC object type {n} (only AAC-LC and AAC-ELD)")),
            };
            let channels = if asc_channels > 0 {
                asc_channels
            } else {
                channels
            };
            Ok(info(codec, asc_rate, channels, frame, asc))
        }
        Mp4Codec::Opus { head } => Ok(info(AudioCodec::Opus, 48_000, head[9], 0, head)),
        Mp4Codec::Alac { config } => {
            let frame = u32::from_be_bytes([config[0], config[1], config[2], config[3]]);
            Ok(info(AudioCodec::Alac, rate, channels, frame, config))
        }
        Mp4Codec::Pcm {
            bits: 16,
            big_endian: false,
            float: false,
        } => Ok(info(
            AudioCodec::PcmS16le,
            rate,
            channels,
            mp4::PCM_PACKET_SAMPLES,
            &[],
        )),
        Mp4Codec::Pcm {
            bits,
            big_endian,
            float,
        } => Err(format!(
            "{bits}-bit {}{} PCM",
            if *float { "float " } else { "" },
            if *big_endian {
                "big-endian"
            } else {
                "little-endian"
            }
        )),
        Mp4Codec::Other {
            fourcc,
            object_type: Some(ot),
        } => Err(format!("{}/0x{ot:02x}", mp4::fourcc_str(*fourcc))),
        Mp4Codec::Other { fourcc, .. } => Err(mp4::fourcc_str(*fourcc)),
        Mp4Codec::Avc { .. } | Mp4Codec::Hevc { .. } => Err(name),
    }
}

/// avcC → (4-byte avcC, length size, SPS).
fn avc_config(avcc: &[u8]) -> Result<(Vec<u8>, usize, Sps)> {
    let cfg = AvcConfig::parse(avcc)?;
    let sps = h264::parse_sps(
        cfg.sps
            .first()
            .ok_or_else(|| Error::malformed("h264: avcC without SPS"))?,
    )?;
    let length_size = cfg.length_size as usize;
    let avcc = if length_size == 4 {
        avcc.to_vec()
    } else {
        AvcConfig {
            length_size: 4,
            ..cfg
        }
        .to_bytes()?
    };
    Ok((avcc, length_size, sps))
}

/// Builds an avcC from the parameter sets in an AVCC access unit (`avc3`).
fn avcc_from_in_band(au: &[u8], length_size: usize) -> Result<Vec<u8>> {
    let mut sps = Vec::new();
    let mut pps = Vec::new();
    for nal in h264::avcc_nals(au, length_size) {
        let nal = nal?;
        match h264::nal_unit_type(nal) {
            Some(h264::nal_type::SPS) => sps.push(nal.to_vec()),
            Some(h264::nal_type::PPS) => pps.push(nal.to_vec()),
            _ => {}
        }
    }
    AvcConfig::from_parameter_sets(sps, pps)?.to_bytes()
}

fn open_mp4(file: File) -> Result<(Inner, FileInfo)> {
    let mut demux = mp4::Demuxer::new(file)?;
    let tracks = demux.tracks().to_vec();
    let v = tracks
        .iter()
        .find(|t| t.track_type == Mp4TrackType::Video)
        .ok_or_else(|| Error::unsupported("mp4: no video track"))?;
    let mut problems = Vec::new();
    if v.sample_descriptions > 1 {
        problems.push(format!(
            "the video has {} sample descriptions (codec configuration changes)",
            v.sample_descriptions
        ));
    }
    if !v.matrix_is_identity() {
        problems.push("the video is rotated or flipped (display matrix)".into());
    }
    if v.media_edits() > 1 {
        problems.push(format!(
            "the video edit list has {} edits (cuts)",
            v.media_edits()
        ));
    }
    let mut lookahead = VecDeque::new();
    let (video, sps, length_size, is_h264) = match &v.codec {
        Mp4Codec::Avc { avcc } => {
            let raw = match avcc {
                Some(a) => a.clone(),
                None => {
                    // avc3: parameter sets in band; take the first sample's.
                    let mut found = None;
                    while lookahead.len() < ORIGIN_LOOKAHEAD {
                        let Some(s) = demux.next_sample()? else { break };
                        let mine = s.track_id == v.id;
                        if mine && found.is_none() {
                            found = Some(avcc_from_in_band(&s.data, 4)?);
                        }
                        lookahead.push_back(s);
                        if found.is_some() {
                            break;
                        }
                    }
                    found.ok_or_else(|| Error::malformed("mp4: avc3 without parameter sets"))?
                }
            };
            let (avcc, length_size, sps) = avc_config(&raw)?;
            (
                VideoInfo {
                    codec: VideoCodec::H264,
                    width: sps.width,
                    height: sps.height,
                    fps: Ratio::integer(0),
                    avcc,
                },
                Some(sps),
                length_size,
                true,
            )
        }
        Mp4Codec::Hevc { hvcc } => {
            // lengthSizeMinusOne: low 2 bits of byte 21.
            let length_size = hvcc.get(21).map_or(4, |b| (b & 3) as usize + 1);
            if length_size != 4 {
                problems.push(format!("HEVC with {length_size}-byte NAL lengths"));
            }
            (
                VideoInfo {
                    codec: VideoCodec::Hevc,
                    width: v.width,
                    height: v.height,
                    fps: Ratio::integer(0),
                    avcc: hvcc.clone(),
                },
                None,
                4,
                false,
            )
        }
        _ => {
            return Err(Error::unsupported(format!(
                "mp4: video codec {} (only H.264 and HEVC)",
                mp4::fourcc_str(v.fourcc)
            )))
        }
    };
    let mut video = video;
    let mean_ns = (v.sample_count > 0 && v.duration > 0)
        .then(|| (to_ns(v.duration as i64, v.timescale) / v.sample_count as i128) as u64);
    video.fps = sps
        .as_ref()
        .and_then(|s| s.fps)
        .or_else(|| mean_ns.and_then(source::fps_from_duration))
        .unwrap_or(Ratio::integer(0));
    let audio_track = tracks.iter().find(|t| t.track_type == Mp4TrackType::Audio);
    let (audio, unsupported_audio) = match audio_track.map(mp4_audio_info) {
        Some(Ok(a)) => (Some(a), None),
        Some(Err(why)) => (None, Some(why)),
        None => (None, None),
    };
    let audio_ids = audio
        .as_ref()
        .and_then(|a| audio_track.map(|t| (t.id, a.sample_rate)));
    // Each used track's earliest pts: the shared timeline starts there.
    let used = |id: u32| id == v.id || audio_ids.is_some_and(|(a, _)| a == id);
    while lookahead.len() < ORIGIN_LOOKAHEAD {
        let seen_all = [Some(v.id), audio_ids.map(|a| a.0)]
            .into_iter()
            .flatten()
            .all(|id| lookahead.iter().filter(|s| s.track_id == id).count() >= 8);
        if seen_all {
            break;
        }
        match demux.next_sample()? {
            Some(s) => lookahead.push_back(s),
            None => break,
        }
    }
    let origin_ns = lookahead
        .iter()
        .filter(|s| used(s.track_id))
        // Decode times too: with B-frames they start before the first
        // presentation, and must not go negative.
        .filter_map(|s| {
            demux
                .track(s.track_id)
                .map(|t| to_ns(s.pts.min(s.dts), t.timescale))
        })
        .min()
        .unwrap_or(0);
    let duration = v.duration_secs();
    let fragmented = demux.is_fragmented();
    let full = !fragmented;
    let video_kbps = duration
        .filter(|&d| d > 0.0 && !fragmented)
        .map(|d| (v.total_bytes as f64 * 8.0 / d / 1000.0).round() as u32);
    let info = FileInfo {
        container: Container::Mp4,
        video,
        sps,
        audio,
        unsupported_audio,
        problems,
        reorder_checked_fully: full,
        reorders: v.reorders,
        duration,
        video_kbps,
        peak_video_kbps: None,
        keyframe_interval: None,
    };
    let state = Mp4State {
        video_id: v.id,
        video_scale: v.timescale,
        audio: audio_ids,
        length_size,
        is_h264,
        origin_ns,
        lookahead,
        demux,
    };
    Ok((Inner::Mp4(state), info))
}

fn open_mkv(file: File) -> Result<(Inner, FileInfo)> {
    // The demuxer buffers its input itself.
    let reader = MediaReader::new(file, &[])?;
    let si = reader.info().clone();
    let sps = if si.video.codec == VideoCodec::H264 {
        let cfg = AvcConfig::parse(&si.video.avcc)?;
        cfg.sps.first().map(|s| h264::parse_sps(s)).transpose()?
    } else {
        None
    };
    let mut problems = Vec::new();
    if si.video.codec == VideoCodec::Hevc && si.video.avcc.get(21).is_some_and(|b| b & 3 != 3) {
        problems.push("HEVC with non-4-byte NAL lengths".into());
    }
    let info = FileInfo {
        container: Container::Matroska,
        video: si.video.clone(),
        sps,
        audio: si.audio_for(AudioFamily::AirPlay).cloned(),
        unsupported_audio: None,
        problems,
        reorder_checked_fully: false,
        reorders: false,
        duration: None,
        video_kbps: None,
        peak_video_kbps: None,
        keyframe_interval: None,
    };
    Ok((Inner::Mkv(reader), info))
}

/// Opens `path` and reads its first seconds to fill in what the
/// container header does not say: B-frame reordering (MKV, fragmented
/// MP4), the Opus frame size, bitrates.
pub fn probe(path: &Path) -> Result<FileInfo> {
    let mut src = FileSource::open(path)?;
    let mut info = src.info().clone();
    let mut last_video_pts: Option<u64> = None;
    let mut reorders = false;
    let mut first_pts: Option<u64> = None;
    let mut last_pts = 0u64;
    let mut video_bytes = 0u64;
    let mut window: VecDeque<(u64, usize)> = VecDeque::new();
    let mut window_bytes = 0usize;
    let mut peak_bytes = 0usize;
    let mut frames = 0;
    let mut opus_samples = None;
    let mut last_key: Option<u64> = None;
    let mut max_key_gap = 0u64;
    while frames < PROBE_MAX_FRAMES {
        let Some(f) = src.next_frame()? else { break };
        frames += 1;
        let fr = &f.frame;
        match fr.track {
            TrackKind::Video => {
                if last_video_pts.is_some_and(|l| fr.pts <= l) {
                    reorders = true;
                }
                last_video_pts = Some(last_video_pts.map_or(fr.pts, |l| l.max(fr.pts)));
                first_pts.get_or_insert(fr.pts);
                last_pts = last_pts.max(fr.pts);
                if fr.keyframe {
                    if let Some(k) = last_key {
                        max_key_gap = max_key_gap.max(fr.pts.saturating_sub(k));
                    }
                    last_key = Some(fr.pts);
                }
                video_bytes += fr.data.len() as u64;
                window.push_back((fr.pts, fr.data.len()));
                window_bytes += fr.data.len();
                while window
                    .front()
                    .is_some_and(|&(p, _)| p + VIDEO_CLOCK_RATE as u64 <= fr.pts)
                {
                    let (_, n) = window.pop_front().unwrap_or_default();
                    window_bytes -= n;
                }
                peak_bytes = peak_bytes.max(window_bytes);
                let elapsed = (fr.pts - first_pts.unwrap_or(fr.pts)) as f64 / 90_000.0;
                if elapsed >= PROBE_SECONDS {
                    break;
                }
            }
            TrackKind::Audio(_) => {
                if opus_samples.is_none()
                    && info
                        .audio
                        .as_ref()
                        .is_some_and(|a| a.codec == AudioCodec::Opus)
                {
                    opus_samples = source::opus_packet_samples(&fr.data);
                }
            }
        }
    }
    if !info.reorder_checked_fully {
        info.reorders = reorders;
    } else if reorders && !info.reorders {
        // Cannot happen for a consistent table; trust what we saw.
        info.reorders = true;
    }
    if let (Some(a), Some(n)) = (info.audio.as_mut(), opus_samples) {
        if a.frame_samples == 0 {
            a.frame_samples = n;
        }
    }
    let span = last_pts.saturating_sub(first_pts.unwrap_or(0)) as f64 / 90_000.0;
    if let Some(k) = last_key {
        // The tail after the last keyframe counts too.
        let tail = last_pts.saturating_sub(k);
        let gap = max_key_gap.max(tail) as f64 / 90_000.0;
        info.keyframe_interval = Some(gap);
    }
    if span >= 1.0 {
        peak_bytes = peak_bytes.max(1);
        info.peak_video_kbps = Some((peak_bytes as f64 * 8.0 / 1000.0).round() as u32);
        if info.video_kbps.is_none() {
            info.video_kbps = Some((video_bytes as f64 * 8.0 / span / 1000.0).round() as u32);
        }
    }
    Ok(info)
}

/// Why a file cannot be sent unchanged. Display lists every reason.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Incompatible {
    pub reasons: Vec<String>,
}

impl fmt::Display for Incompatible {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.reasons.join("; "))
    }
}

/// How to send a compatible file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PassPlan {
    /// The families that get the file's audio track (each sink of such a
    /// family accepts its format). Empty: video only.
    pub audio_families: Vec<AudioFamily>,
}

/// Options for [`check`].
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CheckOptions {
    /// The user wants audio (no `--no-audio`).
    pub audio: bool,
    /// Accept B-frame reordering (frames are sent in decode order). Off
    /// until the receivers are known to cope (docs/measurements.md).
    pub allow_reordering: bool,
    /// Longest keyframe interval (seconds) we accept: after a loss or a
    /// queue overflow a receiver shows nothing until the next keyframe.
    pub max_keyframe_interval: f64,
}

/// Default for [`CheckOptions::max_keyframe_interval`]. Below the probe
/// length, so a file with a single keyframe in its first seconds fails.
pub const MAX_KEYFRAME_INTERVAL: f64 = 4.0;

impl Default for CheckOptions {
    fn default() -> CheckOptions {
        CheckOptions {
            audio: true,
            allow_reordering: false,
            max_keyframe_interval: MAX_KEYFRAME_INTERVAL,
        }
    }
}

/// Decides whether `info` can go to every sink unchanged.
pub fn check(
    info: &FileInfo,
    sinks: &[(&str, &Capabilities)],
    opts: CheckOptions,
) -> std::result::Result<PassPlan, Incompatible> {
    let mut reasons = file_reasons(info, opts);
    if sinks.is_empty() {
        reasons.push("no receivers".into());
    }
    sink_reasons(info, sinks, opts, reasons)
}

/// Whether the file itself could pass (receivers aside): lets the session
/// shape its offers (bitrate, AAC) before connecting.
pub fn file_ok(info: &FileInfo, opts: CheckOptions) -> bool {
    file_reasons(info, opts).is_empty()
}

/// The reasons that do not depend on the receivers.
fn file_reasons(info: &FileInfo, opts: CheckOptions) -> Vec<String> {
    let mut reasons: Vec<String> = info.problems.clone();
    let v = &info.video;
    if let Some(sps) = &info.sps {
        if sps.chroma_format_idc != 1 {
            let name = match sps.chroma_format_idc {
                0 => "monochrome",
                2 => "4:2:2",
                _ => "4:4:4",
            };
            reasons.push(format!("H.264 is {name}, receivers take 4:2:0"));
        }
        if sps.bit_depth_luma != 8 || sps.bit_depth_chroma != 8 {
            reasons.push(format!(
                "H.264 is {}-bit, receivers take 8-bit",
                sps.bit_depth_luma.max(sps.bit_depth_chroma)
            ));
        }
        if !sps.frame_mbs_only {
            reasons.push("H.264 is interlaced".into());
        }
    }
    if !opts.allow_reordering {
        if info.reorders {
            reasons.push(format!(
                "the video has B-frames (presentation order differs from decode order{})",
                if info.reorder_checked_fully {
                    ""
                } else {
                    " in the first seconds"
                }
            ));
        } else if !info.reorder_checked_fully {
            if let Some(n) = info.sps.as_ref().and_then(|s| s.max_num_reorder_frames) {
                if n > 0 {
                    reasons.push(format!(
                        "the H.264 SPS allows B-frame reordering (max_num_reorder_frames = {n})"
                    ));
                }
            }
        }
    }
    if v.fps.num == 0 || v.fps.den == 0 {
        reasons.push("the frame rate is unknown".into());
    }
    if let Some(gap) = info.keyframe_interval {
        if gap > opts.max_keyframe_interval {
            reasons.push(format!(
                "keyframes are {gap:.1} s apart (at most {:.0} s, receivers recover only at keyframes)",
                opts.max_keyframe_interval
            ));
        }
    }
    reasons
}

fn sink_reasons(
    info: &FileInfo,
    sinks: &[(&str, &Capabilities)],
    opts: CheckOptions,
    mut reasons: Vec<String>,
) -> std::result::Result<PassPlan, Incompatible> {
    let v = &info.video;
    for (name, c) in sinks {
        if !c.video_codecs.contains(&v.codec) {
            reasons.push(format!("{name} does not take {:?} video", v.codec));
        }
        if v.width > c.max_width || v.height > c.max_height {
            reasons.push(format!(
                "{}x{} is larger than {name}'s {}x{}",
                v.width, v.height, c.max_width, c.max_height
            ));
        }
        if c.max_fps.num > 0 && v.fps.as_f64() > c.max_fps.as_f64() * FPS_TOLERANCE {
            reasons.push(format!("{} fps is more than {name}'s {}", v.fps, c.max_fps));
        }
        if let Some(max) = c.max_pixels_per_second.filter(|&m| m > 0) {
            let rate = v.width as f64 * v.height as f64 * v.fps.as_f64();
            if rate > max as f64 * FPS_TOLERANCE {
                reasons.push(format!(
                    "{}x{} at {} fps is more than {name} decodes ({max} pixels/s)",
                    v.width, v.height, v.fps
                ));
            }
        }
        if let (Some(max), Some(have)) = (c.max_bitrate_kbps.filter(|&m| m > 0), info.video_kbps) {
            if have > max {
                reasons.push(format!(
                    "the video averages {have} kbit/s, more than {name}'s {max}"
                ));
            }
        }
    }
    let mut audio_families = Vec::new();
    if opts.audio {
        match (&info.audio, &info.unsupported_audio) {
            (Some(a), _) => {
                let fmt = AudioFormat {
                    codec: a.codec,
                    sample_rate: a.sample_rate,
                    channels: a.channels,
                };
                for family in [AudioFamily::AirPlay, AudioFamily::Cast] {
                    let of: Vec<_> = sinks
                        .iter()
                        .filter(|(_, c)| c.audio_family == family)
                        .collect();
                    if of.is_empty() {
                        continue;
                    }
                    let refusing: Vec<&str> = of
                        .iter()
                        .filter(|(_, c)| !sink_takes(c, &fmt))
                        .map(|(n, _)| *n)
                        .collect();
                    if refusing.is_empty() {
                        audio_families.push(family);
                    } else {
                        reasons.push(format!(
                            "{} does not take {:?} {} Hz {} ch audio",
                            refusing.join(", "),
                            a.codec,
                            a.sample_rate,
                            a.channels
                        ));
                    }
                }
            }
            (None, Some(why)) => reasons.push(format!("the audio is {why}")),
            (None, None) => {}
        }
    }
    if reasons.is_empty() {
        Ok(PassPlan { audio_families })
    } else {
        Err(Incompatible { reasons })
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::util::vectors;

    pub fn fixture(name: &str) -> PathBuf {
        vectors::path(&format!("tests/fixtures/media/{name}"))
    }

    pub fn caps(family: AudioFamily, formats: &[(AudioCodec, u32, u8)]) -> Capabilities {
        Capabilities {
            max_width: 1920,
            max_height: 1080,
            max_fps: Ratio::integer(60),
            video_codecs: vec![VideoCodec::H264],
            audio_formats: formats
                .iter()
                .map(|&(codec, sample_rate, channels)| AudioFormat {
                    codec,
                    sample_rate,
                    channels,
                })
                .collect(),
            audio_family: family,
            max_bitrate_kbps: Some(10_000),
            max_pixels_per_second: None,
            min_latency_ms: None,
            preferred_latency_ms: None,
            max_key_interval_ms: None,
            display_aspect: None,
        }
    }

    fn collect(src: &mut FileSource) -> Vec<FileFrame> {
        let mut out = Vec::new();
        while let Some(f) = src.next_frame().unwrap() {
            out.push(f);
        }
        out
    }

    #[test]
    fn sniffing() {
        assert_eq!(
            sniff(&[0x1a, 0x45, 0xdf, 0xa3, 1]),
            Some(Container::Matroska)
        );
        assert_eq!(sniff(b"\0\0\0\x20ftypisom"), Some(Container::Mp4));
        assert_eq!(sniff(b"\0\0\0\x08wide"), Some(Container::Mp4));
        assert_eq!(sniff(b"RIFF....AVI "), None);
        assert_eq!(sniff(b""), None);
        assert_eq!(
            container_of(&fixture("live.mkv")),
            Some(Container::Matroska)
        );
        assert_eq!(container_of(&fixture("alac.mov")), Some(Container::Mp4));
        assert_eq!(container_of(&fixture("nope.mp4")), None);
    }

    #[test]
    fn mp4_frames_in_our_conventions() {
        let mut src = FileSource::open(&fixture("bf0.mp4")).unwrap();
        let info = src.info().clone();
        assert_eq!(info.video.codec, VideoCodec::H264);
        assert_eq!((info.video.width, info.video.height), (160, 120));
        assert_eq!(info.video.fps, Ratio::integer(30));
        let a = info.audio.clone().unwrap();
        assert_eq!(
            (a.codec, a.sample_rate, a.channels, a.frame_samples),
            (AudioCodec::AacLc, 48_000, 2, 1024)
        );
        let frames = collect(&mut src);
        let video: Vec<_> = frames
            .iter()
            .filter(|f| f.frame.track == TrackKind::Video)
            .collect();
        let audio: Vec<_> = frames
            .iter()
            .filter(|f| f.frame.track != TrackKind::Video)
            .collect();
        assert_eq!(video.len(), 30);
        // AAC priming (edit list media_time 1024) starts the timeline: the
        // first audio packet is at 0, video 1024/48000 s later.
        assert_eq!(audio[0].frame.pts, 0);
        assert_eq!(video[0].frame.pts, 1920);
        assert!(video[0].frame.keyframe);
        assert_eq!(video.iter().filter(|f| f.frame.keyframe).count(), 2);
        assert!(video
            .windows(2)
            .all(|w| w[1].frame.pts - w[0].frame.pts == 3000));
        assert!(audio
            .windows(2)
            .all(|w| w[1].frame.pts - w[0].frame.pts == 1024));
        for f in &video {
            assert!(h264::avcc_nals(&f.frame.data, 4).all(|n| n.is_ok()));
        }
        // Rewind gives the same frames again.
        src.rewind().unwrap();
        let again = collect(&mut src);
        assert_eq!(again.len(), frames.len());
        assert_eq!(again[5].frame.pts, frames[5].frame.pts);
    }

    #[test]
    fn probe_and_check_fixtures() {
        let cast = caps(AudioFamily::Cast, &[(AudioCodec::Opus, 48_000, 2)]);
        let cast_aac = caps(AudioFamily::Cast, &[(AudioCodec::AacLc, 48_000, 2)]);
        let airplay = caps(
            AudioFamily::AirPlay,
            &[
                (AudioCodec::Alac, 44_100, 2),
                (AudioCodec::AacLc, 48_000, 2),
                (AudioCodec::PcmS16le, 48_000, 2),
            ],
        );
        let ok = |name: &str, sinks: &[(&str, &Capabilities)]| {
            let info = probe(&fixture(name)).unwrap();
            check(&info, sinks, CheckOptions::default())
        };
        // AAC-LC: fine for AirPlay and an AAC Cast receiver, not for Opus.
        assert_eq!(
            ok("bf0.mp4", &[("tv", &cast_aac), ("atv", &airplay)]).unwrap(),
            PassPlan {
                audio_families: vec![AudioFamily::AirPlay, AudioFamily::Cast]
            }
        );
        let e = ok("bf0.mp4", &[("tv", &cast)]).unwrap_err();
        assert_eq!(e.to_string(), "tv does not take AacLc 48000 Hz 2 ch audio");
        let no_audio = CheckOptions {
            audio: false,
            ..CheckOptions::default()
        };
        let info = probe(&fixture("bf0.mp4")).unwrap();
        assert_eq!(
            check(&info, &[("tv", &cast)], no_audio)
                .unwrap()
                .audio_families,
            []
        );
        // B-frames.
        let e = ok("bframes.mp4", &[("tv", &cast_aac)]).unwrap_err();
        assert_eq!(
            e.to_string(),
            "the video has B-frames (presentation order differs from decode order)"
        );
        // Fragmented + Opus: Cast yes, AirPlay no.
        assert!(ok("frag.mp4", &[("tv", &cast)]).is_ok());
        let e = ok("frag.mp4", &[("atv", &airplay)]).unwrap_err();
        assert!(e.to_string().contains("atv does not take Opus"), "{e}");
        // The AirPlay sink takes 44.1 kHz PCM (it advertises ALAC, which it
        // makes from PCM): an ALAC file needs decoding, 48 kHz PCM resampling.
        let atv = caps(AudioFamily::AirPlay, &[(AudioCodec::Alac, 44_100, 2)]);
        let e = ok("alac.mov", &[("atv", &atv)]).unwrap_err();
        assert_eq!(e.to_string(), "atv does not take Alac 44100 Hz 2 ch audio");
        let e = ok("pcm.mov", &[("atv", &atv)]).unwrap_err();
        assert_eq!(
            e.to_string(),
            "atv does not take PcmS16le 48000 Hz 2 ch audio"
        );
        let atv48 = caps(AudioFamily::AirPlay, &[(AudioCodec::Alac, 48_000, 2)]);
        assert!(ok("pcm.mov", &[("atv", &atv48)]).is_ok());
        // Matroska from ffmpeg (no B-frames, ALAC first audio track).
        let info = probe(&fixture("live.mkv")).unwrap();
        assert_eq!(info.container, Container::Matroska);
        // GOP 15 at 30 fps.
        assert_eq!(info.keyframe_interval, Some(0.5));
        assert!(!info.reorders);
        assert_eq!(info.audio.as_ref().unwrap().codec, AudioCodec::Alac);
        let e = check(&info, &[("atv", &airplay)], CheckOptions::default()).unwrap_err();
        assert!(e.to_string().contains("Alac 44100"), "{e}");
        let no_audio = CheckOptions {
            audio: false,
            ..CheckOptions::default()
        };
        assert!(check(&info, &[("atv", &airplay)], no_audio).is_ok());
        // HEVC to an H.264-only receiver.
        let e = ok("hevc.mp4", &[("tv", &cast)]).unwrap_err();
        assert_eq!(e.to_string(), "tv does not take Hevc video");
        // Limits.
        let mut small = cast_aac.clone();
        small.max_width = 128;
        small.max_fps = Ratio::integer(25);
        small.max_bitrate_kbps = Some(20);
        let e = ok("bf0.mp4", &[("tiny", &small)]).unwrap_err();
        assert_eq!(e.reasons.len(), 3, "{e}");
        assert!(e.reasons[0].contains("160x120 is larger than tiny's 128x1080"));
        assert!(e.reasons[1].contains("30 fps is more than tiny's 25"));
        assert!(e.reasons[2].contains("kbit/s, more than tiny's 20"));
        // A pixel rate (Cast's maxPixelsPerSecond): 160x120 at 30 fps is
        // 576000 pixels/s.
        let mut slow = cast_aac.clone();
        slow.max_pixels_per_second = Some(500_000);
        let e = ok("bf0.mp4", &[("slow", &slow)]).unwrap_err();
        assert_eq!(e.reasons.len(), 1, "{e}");
        assert!(
            e.reasons[0].contains("160x120 at 30 fps is more than slow decodes"),
            "{e}"
        );
        slow.max_pixels_per_second = Some(576_000);
        assert!(ok("bf0.mp4", &[("slow", &slow)]).is_ok());
    }

    #[test]
    fn bframes_in_matroska_are_detected() {
        let Some((bin, _)) = crate::media::ffmpeg::tests::real_ffmpeg() else {
            return;
        };
        let out = std::env::temp_dir().join(format!("tvpipe-pt-{}.mkv", std::process::id()));
        let ok = std::process::Command::new(bin)
            .args(["-hide_banner", "-loglevel", "error", "-y", "-i"])
            .arg(fixture("bframes.mp4"))
            .args(["-c", "copy"])
            .arg(&out)
            .status()
            .is_ok_and(|s| s.success());
        assert!(ok);
        let info = probe(&out).unwrap();
        let _ = std::fs::remove_file(&out);
        assert!(info.reorders);
        assert!(!info.reorder_checked_fully);
        assert_eq!(info.sps.as_ref().unwrap().max_num_reorder_frames, Some(2));
        let cast = caps(AudioFamily::Cast, &[(AudioCodec::AacLc, 48_000, 2)]);
        let e = check(&info, &[("tv", &cast)], CheckOptions::default()).unwrap_err();
        assert!(e.to_string().contains("in the first seconds"), "{e}");
    }

    #[test]
    fn asc_parsing() {
        assert_eq!(parse_asc(&[0x12, 0x10]).unwrap(), (2, 44_100, 2, 1024));
        assert_eq!(parse_asc(&[0x11, 0x90]).unwrap(), (2, 48_000, 2, 1024));
        assert_eq!(
            parse_asc(&[0xf8, 0xe8, 0x50]).unwrap(),
            (39, 44_100, 2, 480)
        );
        assert!(parse_asc(&[0x12]).is_err());
        assert!(parse_asc(&[0x16, 0x80]).is_err()); // index 13: reserved
    }

    #[test]
    fn reorder_check_uses_sps_when_unscanned() {
        let mut info = probe(&fixture("live.mkv")).unwrap();
        info.audio = None;
        let cast = caps(AudioFamily::AirPlay, &[(AudioCodec::Alac, 44_100, 2)]);
        assert!(check(&info, &[("a", &cast)], CheckOptions::default()).is_ok());
        info.sps.as_mut().unwrap().max_num_reorder_frames = Some(2);
        let e = check(&info, &[("a", &cast)], CheckOptions::default()).unwrap_err();
        assert!(e.to_string().contains("max_num_reorder_frames = 2"));
        let allow = CheckOptions {
            allow_reordering: true,
            ..CheckOptions::default()
        };
        assert!(check(&info, &[("a", &cast)], allow).is_ok());
        info.sps.as_mut().unwrap().bit_depth_luma = 10;
        info.sps.as_mut().unwrap().frame_mbs_only = false;
        let e = check(&info, &[("a", &cast)], allow).unwrap_err();
        assert_eq!(
            e.reasons,
            [
                "H.264 is 10-bit, receivers take 8-bit",
                "H.264 is interlaced"
            ]
        );
    }

    /// Every keyframe's pts in a full pass.
    fn keys(frames: &[FileFrame]) -> Vec<u64> {
        frames
            .iter()
            .filter(|f| f.frame.track == TrackKind::Video && f.frame.keyframe)
            .map(|f| f.frame.pts)
            .collect()
    }

    /// What `seek` should pick from `keys` (90 kHz), by its definition.
    fn expected_key(keys: &[u64], target_ns: u128, forward: bool) -> u64 {
        let t = (target_ns.min(u64::MAX as u128) * 90_000 + 500_000_000) / 1_000_000_000;
        let after = keys.iter().copied().find(|&k| k as u128 >= t);
        let before = keys.iter().copied().rev().find(|&k| k as u128 <= t);
        if forward {
            after.or(before).unwrap()
        } else {
            before.or(after).unwrap()
        }
    }

    fn ns(pts_90k: u64) -> u128 {
        (pts_90k as u128 * 1_000_000_000 + 45_000) / 90_000
    }

    /// Seeks, reads to the end and checks the landing against a full pass:
    /// the keyframe (an IDR) first, then exactly the full pass's video from
    /// it, and audio never presented before it, up to the same end.
    fn seek_and_check(
        src: &mut FileSource,
        full: &[FileFrame],
        target_ns: u128,
        forward: bool,
    ) -> u64 {
        let rate = src.info().audio.as_ref().map_or(1, |a| a.sample_rate) as u128;
        let got = src.seek(target_ns, forward).unwrap().unwrap();
        let key = ticks(got as i128, VIDEO_CLOCK_RATE) as u64;
        assert_eq!(ns(key), got);
        let want = expected_key(&keys(full), target_ns, forward);
        assert_eq!(key, want, "target {target_ns} ns forward {forward}");
        let after = collect(src);
        let first = &after[0].frame;
        assert_eq!(
            (first.track, first.keyframe, first.pts),
            (TrackKind::Video, true, key)
        );
        if src.info().video.codec == VideoCodec::H264 {
            assert!(h264::is_idr(&first.data, 4).unwrap());
        }
        let video = |fs: &[FileFrame], from: u64| -> Vec<(u64, Arc<[u8]>)> {
            fs.iter()
                .filter(|f| f.frame.track == TrackKind::Video && f.frame.pts >= from)
                .map(|f| (f.frame.pts, f.frame.data.clone()))
                .collect()
        };
        assert_eq!(video(&after, 0), video(full, key));
        let audio: Vec<u64> = after
            .iter()
            .filter(|f| f.frame.track != TrackKind::Video)
            .map(|f| f.frame.pts)
            .collect();
        for &a in &audio {
            assert!(
                a as u128 * 90_000 >= key as u128 * rate,
                "audio {a} before {key}"
            );
        }
        let full_audio: Vec<u64> = full
            .iter()
            .filter(|f| f.frame.track != TrackKind::Video)
            .map(|f| f.frame.pts)
            .filter(|&a| a as u128 * 90_000 >= key as u128 * rate)
            .collect();
        if src.info().container == Container::Mp4 {
            assert_eq!(audio, full_audio);
        } else {
            // Matroska audio pts restart from the 1 ms container
            // timestamps after a seek: the same frames, within a tick.
            assert!(audio.len().abs_diff(full_audio.len()) <= 1);
            assert!(
                audio.last().unwrap().abs_diff(*full_audio.last().unwrap())
                    <= rate as u64 / 1000 + 1
            );
        }
        key
    }

    /// Forward, backward, exact, off by one, zero, past the end, after the
    /// end, repeated, then rewind.
    fn seek_everywhere(name: &str, expect_keys: &[u64]) {
        let mut src = FileSource::open(&fixture(name)).unwrap();
        let full = collect(&mut src);
        assert_eq!(keys(&full), expect_keys, "{name}");
        let (k0, k1) = (expect_keys[0], expect_keys[1]);
        let cases = [
            (0, true, k0),
            (0, false, k0),
            (300_000_000, true, k1),
            (300_000_000, false, k0),
            (ns(k1), true, k1),
            (ns(k1), false, k1),
            // Half a tick (5555.6 ns) either side.
            (ns(k1) - 5_000, true, k1),
            (ns(k1) - 5_000, false, k1),
            (ns(k1) - 6_000, true, k1),
            (ns(k1) - 6_000, false, k0),
            (ns(k1) + 6_000, true, k1),
            (ns(k1) + 6_000, false, k1),
            (900_000_000, true, k1),
            (900_000_000, false, k1),
            (10_000_000_000, true, k1),
            (u128::MAX, false, k1),
        ];
        // Each seek starts where the previous one ended: at the end.
        for (target, forward, want) in cases {
            assert_eq!(
                seek_and_check(&mut src, &full, target, forward),
                want,
                "{name}"
            );
        }
        // Mid-stream, and back again.
        assert_eq!(src.seek(0, false).unwrap(), Some(ns(k0)));
        for _ in 0..10 {
            src.next_frame().unwrap().unwrap();
        }
        assert_eq!(seek_and_check(&mut src, &full, 700_000_000, false), k1);
        assert_eq!(src.seek(0, true).unwrap(), Some(ns(k0)));
        src.next_frame().unwrap().unwrap();
        src.rewind().unwrap();
        let again = collect(&mut src);
        assert_eq!(again.len(), full.len(), "{name}");
        for (a, b) in again.iter().zip(&full) {
            assert_eq!((a.frame.pts, &a.frame.data), (b.frame.pts, &b.frame.data));
        }
    }

    #[test]
    fn seek_mp4() {
        // Keyframes at frames 0 and 15 of 30 fps, after 1024 samples of
        // AAC priming at 48 kHz.
        seek_everywhere("bf0.mp4", &[1920, 46920]);
    }

    #[test]
    fn seek_fragmented_mp4() {
        // 15360 Hz: 0 and 7780 ticks.
        seek_everywhere("frag.mp4", &[0, 45586]);
    }

    #[test]
    fn seek_matroska() {
        // 0 and 500 ms, after Opus's 2.5 ms CodecDelay. Two sized
        // Clusters (the second starts at 501 ms, after its keyframe).
        seek_everywhere("file.mkv", &[225, 45225]);
        // One Cluster per few frames: backward seeks step back through
        // Clusters without keyframes.
        seek_everywhere("live.mkv", &[225, 45225]);
    }

    #[test]
    fn seek_matroska_unknown_size_clusters() {
        // file.mkv with both Cluster sizes (3-byte VINTs) made unknown: the
        // index ends at the first Cluster and seeks read on from there.
        let mut data = std::fs::read(fixture("file.mkv")).unwrap();
        for pos in [962, 22251] {
            assert_eq!(&data[pos..pos + 4], &[0x1f, 0x43, 0xb6, 0x75]);
            assert_eq!(data[pos + 4] & 0xe0, 0x20);
            data[pos + 4..pos + 7].copy_from_slice(&[0x3f, 0xff, 0xff]);
        }
        let path = std::env::temp_dir().join(format!("tvpipe-seek-{}.mkv", std::process::id()));
        std::fs::write(&path, &data).unwrap();
        let mut f = File::open(&path).unwrap();
        let index = mkv::index_clusters(&mut f, 962).unwrap();
        assert_eq!(index.clusters.len(), 1);
        assert!(!index.complete);
        let mut src = FileSource::open(&path).unwrap();
        let full = collect(&mut src);
        assert_eq!(keys(&full), [225, 45225]);
        assert_eq!(seek_and_check(&mut src, &full, 600_000_000, false), 45225);
        assert_eq!(seek_and_check(&mut src, &full, 100_000_000, true), 45225);
        assert_eq!(seek_and_check(&mut src, &full, 100_000_000, false), 225);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn seek_hevc_lands_on_sync_samples() {
        let mut src = FileSource::open(&fixture("hevc.mp4")).unwrap();
        let full = collect(&mut src);
        assert_eq!(keys(&full), [0]);
        assert_eq!(src.seek(300_000_000, true).unwrap(), Some(0));
        assert_eq!(collect(&mut src).len(), full.len());
    }
}
