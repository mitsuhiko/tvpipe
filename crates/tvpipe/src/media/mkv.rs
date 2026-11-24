//! Live EBML/Matroska demuxer over any [`Read`].
//!
//! Reads the EBML header, the Segment's Info and Tracks, then yields blocks
//! as they arrive. Built for ffmpeg's `-f matroska -live 1` output on a
//! pipe: no seeking, unknown-size Segment and Cluster elements, SimpleBlock
//! and BlockGroup, all three lacing modes.
//!
//! Files can be seeked by Cluster: [`index_clusters`] lists the Clusters
//! (position and Timestamp) by skipping each one by its size, reading a
//! few bytes per Cluster on its own handle; [`Demuxer::seek_cluster`]
//! continues there (`R: Seek`). An unknown-size Cluster ends the index (its
//! end is only found by reading it), so later times are reached by reading
//! on from the last indexed Cluster. Cues are not used.
//!
//! Master elements we descend into (Segment, Cluster, BlockGroup content
//! is read whole) are parsed *flat*: their header is consumed and their
//! children are read as if they were siblings. That makes known and unknown
//! sizes behave the same and needs no end-of-element bookkeeping; the
//! element IDs we act on are unique within a Segment.
//!
//! Sources: RFC 8794 (EBML: §4 VINT, §5 Element ID, §6 Element Data Size,
//! §6.2 unknown size, §7 data types, §11.2 EBML header); IETF CELLAR
//! Matroska spec (RFC 9559: §5.1 element IDs, §10 block structure, §10.4
//! lacing, §11 timestamps, track timestamp scale).

use std::io::{self, BufReader, Read, Seek, SeekFrom};

use crate::error::{Error, Result};
use crate::util::bytes::Reader;

/// Element IDs (RFC 8794 §11.2, RFC 9559 §5.1). IDs keep their VINT marker.
pub mod id {
    pub const EBML: u32 = 0x1A45_DFA3;
    pub const EBML_READ_VERSION: u32 = 0x42F7;
    pub const EBML_MAX_ID_LENGTH: u32 = 0x42F2;
    pub const EBML_MAX_SIZE_LENGTH: u32 = 0x42F3;
    pub const DOC_TYPE: u32 = 0x4282;
    pub const DOC_TYPE_READ_VERSION: u32 = 0x4285;
    pub const VOID: u32 = 0xEC;
    pub const CRC32: u32 = 0xBF;

    pub const SEGMENT: u32 = 0x1853_8067;
    pub const SEEK_HEAD: u32 = 0x114D_9B74;
    pub const INFO: u32 = 0x1549_A966;
    pub const TIMESTAMP_SCALE: u32 = 0x2A_D7B1;
    pub const TRACKS: u32 = 0x1654_AE6B;
    pub const TRACK_ENTRY: u32 = 0xAE;
    pub const TRACK_NUMBER: u32 = 0xD7;
    pub const TRACK_TYPE: u32 = 0x83;
    pub const CODEC_ID: u32 = 0x86;
    pub const CODEC_PRIVATE: u32 = 0x63A2;
    pub const CODEC_DELAY: u32 = 0x56AA;
    pub const DEFAULT_DURATION: u32 = 0x23_E383;
    pub const TRACK_TIMESTAMP_SCALE: u32 = 0x23_314F;
    pub const CONTENT_ENCODINGS: u32 = 0x6D80;
    pub const VIDEO: u32 = 0xE0;
    pub const PIXEL_WIDTH: u32 = 0xB0;
    pub const PIXEL_HEIGHT: u32 = 0xBA;
    pub const AUDIO: u32 = 0xE1;
    pub const SAMPLING_FREQUENCY: u32 = 0xB5;
    pub const CHANNELS: u32 = 0x9F;
    pub const BIT_DEPTH: u32 = 0x6264;

    pub const CLUSTER: u32 = 0x1F43_B675;
    pub const CLUSTER_TIMESTAMP: u32 = 0xE7;
    pub const SIMPLE_BLOCK: u32 = 0xA3;
    pub const BLOCK_GROUP: u32 = 0xA0;
    pub const BLOCK: u32 = 0xA1;
    pub const BLOCK_DURATION: u32 = 0x9B;
    pub const REFERENCE_BLOCK: u32 = 0xFB;
}

/// Largest header-like element (EBML header, Info, Tracks) we buffer.
const MAX_HEADER_SIZE: u64 = 16 << 20;
/// Largest block (one encoded access unit, or a laced group) we buffer.
const MAX_BLOCK_SIZE: u64 = 64 << 20;
/// Largest element we skip (by reading and discarding).
const MAX_SKIP_SIZE: u64 = 1 << 30;
/// Most frames in one laced block (the count is a u8 + 1 anyway).
const MAX_LACED_FRAMES: usize = 256;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrackType {
    Video,
    Audio,
    Other(u64),
}

#[derive(Debug, Clone, PartialEq)]
pub struct Track {
    pub number: u64,
    pub track_type: TrackType,
    pub codec_id: String,
    pub codec_private: Vec<u8>,
    /// Nanoseconds; 0 if absent.
    pub codec_delay_ns: u64,
    /// Nanoseconds per frame, if the muxer wrote it.
    pub default_duration_ns: Option<u64>,
    /// Deprecated TrackTimestampScale (default 1.0).
    pub timestamp_scale: f64,
    pub pixel_width: Option<u32>,
    pub pixel_height: Option<u32>,
    pub sampling_frequency: Option<f64>,
    pub channels: Option<u8>,
    pub bit_depth: Option<u8>,
}

impl Track {
    fn new() -> Track {
        Track {
            number: 0,
            track_type: TrackType::Other(0),
            codec_id: String::new(),
            codec_private: Vec::new(),
            codec_delay_ns: 0,
            default_duration_ns: None,
            timestamp_scale: 1.0,
            pixel_width: None,
            pixel_height: None,
            sampling_frequency: None,
            channels: None,
            bit_depth: None,
        }
    }
}

/// One frame out of a (Simple)Block.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Frame {
    pub track: u64,
    /// Block timestamp in Matroska ticks (cluster + block offset, in
    /// TimestampScale units), as stored. Can be negative.
    pub timestamp: i64,
    /// Presentation timestamp in nanoseconds: track timestamp scale applied
    /// and the track's CodecDelay subtracted (RFC 9559 §5.1.4.1.18).
    pub pts_ns: i64,
    /// SimpleBlock keyframe flag, or a BlockGroup without ReferenceBlock.
    pub keyframe: bool,
    /// BlockDuration in Matroska ticks, if a BlockGroup gave one.
    pub duration: Option<u64>,
    pub data: Vec<u8>,
}

/// Counting reader that turns EOF into clean "end" at element boundaries.
struct Input<R> {
    inner: R,
    pos: u64,
}

impl<R: Read> Input<R> {
    /// Reads one byte; `None` on EOF.
    fn byte(&mut self) -> Result<Option<u8>> {
        let mut b = [0u8];
        loop {
            match self.inner.read(&mut b) {
                Ok(0) => return Ok(None),
                Ok(_) => {
                    self.pos += 1;
                    return Ok(Some(b[0]));
                }
                Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
                Err(e) => return Err(Error::io("mkv: read", e)),
            }
        }
    }

    fn exact(&mut self, buf: &mut [u8]) -> Result<()> {
        self.inner.read_exact(buf).map_err(|e| {
            if e.kind() == io::ErrorKind::UnexpectedEof {
                Error::malformed(format!("mkv: truncated element at offset {}", self.pos))
            } else {
                Error::io("mkv: read", e)
            }
        })?;
        self.pos += buf.len() as u64;
        Ok(())
    }

    fn take(&mut self, n: u64) -> Result<Vec<u8>> {
        let mut buf = vec![0u8; n as usize];
        self.exact(&mut buf)?;
        Ok(buf)
    }

    fn skip(&mut self, mut n: u64) -> Result<()> {
        let mut buf = [0u8; 8192];
        while n > 0 {
            let chunk = n.min(buf.len() as u64) as usize;
            self.exact(&mut buf[..chunk])?;
            n -= chunk as u64;
        }
        Ok(())
    }

    /// The rest of a VINT whose first byte is `first`: (length, value with
    /// the marker bit cleared, all value bits set).
    fn vint_rest(&mut self, first: u8, max_len: u32) -> Result<(u32, u64, bool)> {
        let len = first.leading_zeros() + 1;
        if len > max_len {
            return Err(Error::malformed(format!(
                "mkv: invalid variable-size integer at offset {}",
                self.pos
            )));
        }
        let mut v = (first as u64) & (0xff >> len);
        let mut all_ones = v == (0xff >> len);
        for _ in 1..len {
            let b = self.byte()?.ok_or_else(|| {
                Error::malformed(format!(
                    "mkv: truncated element header at offset {}",
                    self.pos
                ))
            })?;
            all_ones &= b == 0xff;
            v = (v << 8) | b as u64;
        }
        Ok((len, v, all_ones))
    }

    /// Reads an element header. `None` on clean EOF before its first byte.
    fn header(&mut self) -> Result<Option<Header>> {
        let Some(first) = self.byte()? else {
            return Ok(None);
        };
        let (len, raw, _) = self.vint_rest(first, 4)?;
        // Re-add the marker so IDs read as their usual hex form.
        let id = (raw | (1u64 << (7 * len))) as u32;
        let Some(first) = self.byte()? else {
            return Err(Error::malformed("mkv: truncated element header"));
        };
        let (_, size, all_ones) = self.vint_rest(first, 8)?;
        Ok(Some(Header {
            id,
            size: if all_ones { None } else { Some(size) },
        }))
    }
}

#[derive(Debug, Clone, Copy)]
struct Header {
    id: u32,
    /// `None` = unknown size.
    size: Option<u64>,
}

impl Header {
    fn known(&self, limit: u64) -> Result<u64> {
        match self.size {
            Some(n) if n <= limit => Ok(n),
            Some(n) => Err(Error::malformed(format!(
                "mkv: element {:#x} too large ({} bytes)",
                self.id, n
            ))),
            None => Err(Error::malformed(format!(
                "mkv: element {:#x} has unknown size",
                self.id
            ))),
        }
    }
}

/// Reads a VINT from a buffer (track numbers, lace sizes).
fn buf_vint(r: &mut Reader<'_>) -> Result<(u32, u64)> {
    let first = r.u8()?;
    let len = first.leading_zeros() + 1;
    if len > 8 {
        return Err(r.error("invalid variable-size integer"));
    }
    let mut v = (first as u64) & (0xff >> len);
    for _ in 1..len {
        v = (v << 8) | r.u8()? as u64;
    }
    Ok((len, v))
}

/// Iterates child elements of an in-memory master element body.
fn children<'a>(data: &'a [u8]) -> impl Iterator<Item = Result<(u32, &'a [u8])>> + 'a {
    let mut r = Reader::new(data, "mkv");
    let mut failed = false;
    std::iter::from_fn(move || {
        if failed || r.is_at_end() {
            return None;
        }
        let rv = (|| {
            let (len, raw) = buf_vint(&mut r)?;
            if len > 4 {
                return Err(r.error("invalid element ID"));
            }
            let id = (raw | (1u64 << (7 * len))) as u32;
            let (slen, size) = buf_vint(&mut r)?;
            if size == (1u64 << (7 * slen)) - 1 {
                return Err(r.error("unknown size inside a sized element"));
            }
            let size = usize::try_from(size).map_err(|_| r.error("element too large"))?;
            Ok((id, r.bytes(size)?))
        })();
        failed = rv.is_err();
        Some(rv)
    })
}

fn uint(data: &[u8]) -> Result<u64> {
    if data.len() > 8 {
        return Err(Error::malformed("mkv: unsigned integer wider than 8 bytes"));
    }
    Ok(data.iter().fold(0u64, |a, &b| (a << 8) | b as u64))
}

fn float(data: &[u8]) -> Result<f64> {
    match data.len() {
        0 => Ok(0.0),
        4 => Ok(f32::from_be_bytes([data[0], data[1], data[2], data[3]]) as f64),
        8 => {
            let mut b = [0u8; 8];
            b.copy_from_slice(data);
            Ok(f64::from_be_bytes(b))
        }
        _ => Err(Error::malformed("mkv: float must be 0, 4 or 8 bytes")),
    }
}

fn string(data: &[u8]) -> Result<String> {
    // Strings may be zero-padded (RFC 8794 §7.4).
    let end = data.iter().position(|&b| b == 0).unwrap_or(data.len());
    std::str::from_utf8(&data[..end])
        .map(str::to_owned)
        .map_err(|_| Error::malformed("mkv: invalid UTF-8 string"))
}

fn parse_ebml_header(body: &[u8]) -> Result<()> {
    let mut doc_type = String::from("matroska");
    for child in children(body) {
        let (id, data) = child?;
        match id {
            id::DOC_TYPE => doc_type = string(data)?,
            id::EBML_READ_VERSION if uint(data)? > 1 => {
                return Err(Error::unsupported("mkv: EBMLReadVersion > 1"));
            }
            id::EBML_MAX_ID_LENGTH if uint(data)? > 4 => {
                return Err(Error::unsupported("mkv: EBMLMaxIDLength > 4"));
            }
            id::EBML_MAX_SIZE_LENGTH if uint(data)? > 8 => {
                return Err(Error::unsupported("mkv: EBMLMaxSizeLength > 8"));
            }
            id::DOC_TYPE_READ_VERSION if uint(data)? > 4 => {
                return Err(Error::unsupported("mkv: DocTypeReadVersion > 4"));
            }
            _ => {}
        }
    }
    if doc_type != "matroska" && doc_type != "webm" {
        return Err(Error::unsupported(format!(
            "mkv: unsupported DocType {doc_type:?}"
        )));
    }
    Ok(())
}

fn parse_track(body: &[u8]) -> Result<Track> {
    let mut t = Track::new();
    let mut have_type = false;
    for child in children(body) {
        let (id, data) = child?;
        match id {
            id::TRACK_NUMBER => t.number = uint(data)?,
            id::TRACK_TYPE => {
                have_type = true;
                t.track_type = match uint(data)? {
                    1 => TrackType::Video,
                    2 => TrackType::Audio,
                    n => TrackType::Other(n),
                }
            }
            id::CODEC_ID => t.codec_id = string(data)?,
            id::CODEC_PRIVATE => t.codec_private = data.to_vec(),
            id::CODEC_DELAY => t.codec_delay_ns = uint(data)?,
            id::DEFAULT_DURATION => t.default_duration_ns = Some(uint(data)?),
            id::TRACK_TIMESTAMP_SCALE => {
                let s = float(data)?;
                if !(s.is_finite() && s > 0.0) {
                    return Err(Error::malformed("mkv: invalid TrackTimestampScale"));
                }
                t.timestamp_scale = s;
            }
            id::CONTENT_ENCODINGS => {
                return Err(Error::unsupported(
                    "mkv: tracks with ContentEncodings (compression/encryption) are not supported",
                ));
            }
            id::VIDEO => {
                for child in children(data) {
                    let (id, data) = child?;
                    let v = uint(data).ok().and_then(|v| u32::try_from(v).ok());
                    match id {
                        id::PIXEL_WIDTH => t.pixel_width = v,
                        id::PIXEL_HEIGHT => t.pixel_height = v,
                        _ => {}
                    }
                }
            }
            id::AUDIO => {
                for child in children(data) {
                    let (id, data) = child?;
                    match id {
                        id::SAMPLING_FREQUENCY => t.sampling_frequency = Some(float(data)?),
                        id::CHANNELS => t.channels = u8::try_from(uint(data)?).ok(),
                        id::BIT_DEPTH => t.bit_depth = u8::try_from(uint(data)?).ok(),
                        _ => {}
                    }
                }
            }
            _ => {}
        }
    }
    if t.number == 0 || !have_type || t.codec_id.is_empty() {
        return Err(Error::malformed(
            "mkv: TrackEntry without TrackNumber, TrackType or CodecID",
        ));
    }
    Ok(t)
}

/// Splits a laced block payload into frames (RFC 9559 §10.4).
fn unlace(lacing: u8, r: &mut Reader<'_>) -> Result<Vec<Vec<u8>>> {
    if lacing == 0 {
        return Ok(vec![r.rest().to_vec()]);
    }
    let count = r.u8()? as usize + 1;
    if count > MAX_LACED_FRAMES {
        return Err(r.error("too many laced frames"));
    }
    let mut sizes = Vec::with_capacity(count);
    match lacing {
        // Xiph: each size is a run of 255s plus a final byte.
        1 => {
            for _ in 0..count - 1 {
                let mut size = 0usize;
                loop {
                    let b = r.u8()?;
                    size += b as usize;
                    if b != 255 {
                        break;
                    }
                }
                sizes.push(size);
            }
        }
        // EBML: first size is a VINT, the rest signed VINT differences.
        3 if count > 1 => {
            let (_, first) = buf_vint(r)?;
            let mut prev = i64::try_from(first).map_err(|_| r.error("lace size too large"))?;
            sizes.push(prev as usize);
            for _ in 1..count - 1 {
                let (len, raw) = buf_vint(r)?;
                let bias = (1i64 << (7 * len - 1)) - 1;
                prev = prev
                    .checked_add(raw as i64 - bias)
                    .filter(|&s| s >= 0)
                    .ok_or_else(|| r.error("invalid EBML lace size"))?;
                sizes.push(prev as usize);
            }
        }
        3 => {}
        // Fixed: equal sizes.
        2 => {
            let rest = r.remaining();
            if rest % count != 0 {
                return Err(r.error("fixed lacing size not divisible by frame count"));
            }
            sizes = vec![rest / count; count - 1];
        }
        _ => return Err(r.error("invalid lacing mode")),
    }
    let total: usize = sizes
        .iter()
        .try_fold(0usize, |a, &s| a.checked_add(s))
        .ok_or_else(|| r.error("lace sizes overflow"))?;
    if total > r.remaining() {
        return Err(r.error("lace sizes exceed block size"));
    }
    let mut frames = Vec::with_capacity(count);
    for size in sizes {
        frames.push(r.bytes(size)?.to_vec());
    }
    frames.push(r.rest().to_vec());
    Ok(frames)
}

/// The live demuxer.
pub struct Demuxer<R> {
    input: Input<BufReader<R>>,
    timestamp_scale: u64,
    tracks: Vec<Track>,
    cluster_timestamp: Option<u64>,
    pending: std::collections::VecDeque<Frame>,
    /// A Cluster header read while scanning for Tracks.
    in_cluster: bool,
    /// Where the first Cluster's header starts.
    first_cluster: u64,
    /// Where the header of the Cluster being read starts.
    cluster_pos: u64,
}

impl<R: Read> Demuxer<R> {
    /// Reads up to the first Cluster (EBML header, Info, Tracks). The
    /// input is buffered internally; a `BufReader` returns whatever a pipe
    /// has ready, so this adds no latency.
    pub fn new(inner: R) -> Result<Demuxer<R>> {
        let mut d = Demuxer {
            input: Input {
                inner: BufReader::with_capacity(64 * 1024, inner),
                pos: 0,
            },
            timestamp_scale: 1_000_000,
            tracks: Vec::new(),
            cluster_timestamp: None,
            pending: Default::default(),
            in_cluster: false,
            first_cluster: 0,
            cluster_pos: 0,
        };
        let h = d
            .input
            .header()?
            .ok_or_else(|| Error::malformed("mkv: empty input"))?;
        if h.id != id::EBML {
            return Err(Error::malformed("mkv: missing EBML header"));
        }
        let body = d.input.take(h.known(MAX_HEADER_SIZE)?)?;
        parse_ebml_header(&body)?;
        loop {
            let start = d.input.pos;
            let h = d
                .input
                .header()?
                .ok_or_else(|| Error::malformed("mkv: no Tracks before end of input"))?;
            match h.id {
                id::SEGMENT => {}
                id::INFO => {
                    let body = d.input.take(h.known(MAX_HEADER_SIZE)?)?;
                    d.parse_info(&body)?;
                }
                id::TRACKS => {
                    let body = d.input.take(h.known(MAX_HEADER_SIZE)?)?;
                    d.parse_tracks(&body)?;
                }
                id::CLUSTER => {
                    if d.tracks.is_empty() {
                        return Err(Error::malformed("mkv: Cluster before Tracks"));
                    }
                    d.in_cluster = true;
                    d.first_cluster = start;
                    d.cluster_pos = start;
                    return Ok(d);
                }
                _ => d.skip(h)?,
            }
        }
    }

    pub fn tracks(&self) -> &[Track] {
        &self.tracks
    }

    pub fn track(&self, number: u64) -> Option<&Track> {
        self.tracks.iter().find(|t| t.number == number)
    }

    /// Segment TimestampScale in nanoseconds per tick (default 1 ms).
    pub fn timestamp_scale(&self) -> u64 {
        self.timestamp_scale
    }

    /// Bytes consumed so far.
    pub fn position(&self) -> u64 {
        self.input.pos
    }

    /// Where the first Cluster's header starts (for [`index_clusters`]).
    pub fn first_cluster(&self) -> u64 {
        self.first_cluster
    }

    /// Where the header of the Cluster holding the last frame starts.
    pub fn cluster_position(&self) -> u64 {
        self.cluster_pos
    }

    fn parse_info(&mut self, body: &[u8]) -> Result<()> {
        for child in children(body) {
            let (id, data) = child?;
            if id == id::TIMESTAMP_SCALE {
                let s = uint(data)?;
                if s == 0 {
                    return Err(Error::malformed("mkv: TimestampScale is zero"));
                }
                self.timestamp_scale = s;
            }
        }
        Ok(())
    }

    fn parse_tracks(&mut self, body: &[u8]) -> Result<()> {
        for child in children(body) {
            let (id, data) = child?;
            if id == id::TRACK_ENTRY {
                let t = parse_track(data)?;
                if self.track(t.number).is_some() {
                    return Err(Error::malformed("mkv: duplicate TrackNumber"));
                }
                self.tracks.push(t);
            }
        }
        if self.tracks.is_empty() {
            return Err(Error::malformed("mkv: Tracks without TrackEntry"));
        }
        Ok(())
    }

    fn skip(&mut self, h: Header) -> Result<()> {
        let n = h.known(MAX_SKIP_SIZE)?;
        self.input.skip(n)
    }

    /// The next frame, or `None` at the end of the stream.
    pub fn next_frame(&mut self) -> Result<Option<Frame>> {
        loop {
            if let Some(f) = self.pending.pop_front() {
                return Ok(Some(f));
            }
            if self.in_cluster {
                self.in_cluster = false;
                self.cluster_timestamp = None;
            }
            let start = self.input.pos;
            let Some(h) = self.input.header()? else {
                return Ok(None);
            };
            match h.id {
                id::SEGMENT => {}
                id::CLUSTER => {
                    self.cluster_timestamp = None;
                    self.cluster_pos = start;
                }
                id::CLUSTER_TIMESTAMP => {
                    let body = self.input.take(h.known(8)?)?;
                    self.cluster_timestamp = Some(uint(&body)?);
                }
                id::SIMPLE_BLOCK => {
                    let body = self.input.take(h.known(MAX_BLOCK_SIZE)?)?;
                    self.parse_block(&body, None, None)?;
                }
                id::BLOCK_GROUP => {
                    let body = self.input.take(h.known(MAX_BLOCK_SIZE)?)?;
                    self.parse_block_group(&body)?;
                }
                id::TRACKS => {
                    return Err(Error::unsupported("mkv: Tracks changed mid-stream"));
                }
                id::EBML => {
                    return Err(Error::unsupported("mkv: chained segments"));
                }
                _ => self.skip(h)?,
            }
        }
    }

    fn parse_block_group(&mut self, body: &[u8]) -> Result<()> {
        let mut block = None;
        let mut has_reference = false;
        let mut duration = None;
        for child in children(body) {
            let (id, data) = child?;
            match id {
                id::BLOCK => block = Some(data),
                id::REFERENCE_BLOCK => has_reference = true,
                id::BLOCK_DURATION => duration = Some(uint(data)?),
                _ => {}
            }
        }
        let block = block.ok_or_else(|| Error::malformed("mkv: BlockGroup without Block"))?;
        self.parse_block(block, Some(!has_reference), duration)
    }

    /// Parses a Block / SimpleBlock body. `group_keyframe` is `None` for a
    /// SimpleBlock (its flag decides) and the BlockGroup's answer otherwise.
    fn parse_block(
        &mut self,
        body: &[u8],
        group_keyframe: Option<bool>,
        duration: Option<u64>,
    ) -> Result<()> {
        let mut r = Reader::new(body, "mkv block");
        let (_, track) = buf_vint(&mut r)?;
        let rel = r.i16_be()? as i64;
        let flags = r.u8()?;
        let Some(t) = self.track(track) else {
            return Err(r.error("block for unknown track"));
        };
        let track_scale = t.timestamp_scale;
        let default_duration = t.default_duration_ns;
        let codec_delay = i64::try_from(t.codec_delay_ns).unwrap_or(i64::MAX);
        let cluster = self
            .cluster_timestamp
            .ok_or_else(|| Error::malformed("mkv: block before cluster Timestamp"))?;
        let cluster = i64::try_from(cluster).map_err(|_| r.error("cluster timestamp too large"))?;
        let timestamp = cluster
            .checked_add(rel)
            .ok_or_else(|| r.error("timestamp overflow"))?;
        // SimpleBlock flags (RFC 9559 §10.2): 0x80 keyframe; Block leaves
        // that bit reserved (zero), so use the BlockGroup's answer.
        let keyframe = group_keyframe.unwrap_or(flags & 0x80 != 0);
        let frames = unlace((flags >> 1) & 0x03, &mut r)?;
        let pts_ns = self
            .ticks_to_ns(timestamp, track_scale)?
            .saturating_sub(codec_delay);
        for (i, data) in frames.into_iter().enumerate() {
            let offset = default_duration.unwrap_or(0).saturating_mul(i as u64);
            self.pending.push_back(Frame {
                track,
                timestamp,
                pts_ns: pts_ns.saturating_add(offset as i64),
                keyframe,
                duration,
                data,
            });
        }
        Ok(())
    }

    /// The timestamp `ffprobe -show_packets` reports as `pts` for this
    /// frame (Matroska ticks with CodecDelay subtracted, rounded to the
    /// nearest tick, halves away from zero).
    pub fn ffprobe_pts(&self, f: &Frame) -> i64 {
        let delay = self.track(f.track).map_or(0, |t| t.codec_delay_ns);
        let scale = self.timestamp_scale;
        let delay_ticks = (delay + scale / 2) / scale;
        f.timestamp.saturating_sub(delay_ticks as i64)
    }

    fn ticks_to_ns(&self, ticks: i64, track_scale: f64) -> Result<i64> {
        let ns = ticks as i128 * self.timestamp_scale as i128;
        let ns = if track_scale == 1.0 {
            ns
        } else {
            (ns as f64 * track_scale) as i128
        };
        i64::try_from(ns).map_err(|_| Error::malformed("mkv: timestamp out of range"))
    }
}

impl<R: Read + Seek> Demuxer<R> {
    /// Continues with the element at byte `pos`, a Cluster header from
    /// [`index_clusters`] or [`Demuxer::cluster_position`]. Frames read
    /// but not yet returned are dropped.
    pub fn seek_cluster(&mut self, pos: u64) -> Result<()> {
        self.input
            .inner
            .seek(SeekFrom::Start(pos))
            .map_err(|e| Error::io("mkv: seek", e))?;
        self.input.pos = pos;
        self.pending.clear();
        self.cluster_timestamp = None;
        self.in_cluster = false;
        self.cluster_pos = pos;
        Ok(())
    }
}

/// A Cluster found by [`index_clusters`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ClusterEntry {
    /// Where its header starts.
    pub pos: u64,
    /// Its Timestamp, in Segment ticks (TimestampScale).
    pub timestamp: u64,
}

/// The Clusters of a file, see [`index_clusters`].
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ClusterIndex {
    pub clusters: Vec<ClusterEntry>,
    /// The index reached the end of the Segment. Otherwise it stopped at an
    /// unknown-size element or one it could not parse: what follows the
    /// last Cluster is only found by reading it.
    pub complete: bool,
}

/// Cluster headers read at once (header, CRC-32 and Timestamp fit).
const INDEX_PEEK: usize = 64;
/// Children looked at for the Timestamp (CRC-32, Void come first).
const INDEX_CHILDREN: usize = 8;

/// Lists the Clusters from the one at `first` (a Cluster header, see
/// [`Demuxer::first_cluster`]) on: each Cluster's header and Timestamp
/// are read (one small read, more if CRC-32 or Void elements come
/// first) and the rest skipped by its size, as are the elements between
/// Clusters (Cues, Tags). Reads `r` unbuffered; give it its own handle.
/// Stops without error on anything unexpected (see
/// [`ClusterIndex::complete`]); fails only on I/O errors.
pub fn index_clusters<R: Read + Seek>(r: &mut R, first: u64) -> Result<ClusterIndex> {
    let mut index = ClusterIndex::default();
    let mut at = first;
    let mut buf = [0u8; INDEX_PEEK];
    loop {
        let n = read_upto(r, at, &mut buf)?;
        if n == 0 {
            index.complete = true;
            return Ok(index);
        }
        let Some((id, size, hlen)) = peek_header(&buf[..n]) else {
            return Ok(index);
        };
        let body = at.saturating_add(hlen as u64);
        if id == id::CLUSTER {
            let end = size.map(|s| body.saturating_add(s));
            let Some(timestamp) = cluster_timestamp(r, body, end, &mut buf)? else {
                return Ok(index);
            };
            if index.clusters.len() as u64 >= MAX_INDEX_CLUSTERS {
                return Ok(index);
            }
            index.clusters.push(ClusterEntry { pos: at, timestamp });
        } else if id == id::EBML {
            // A chained Segment: the demuxer stops there too.
            index.complete = true;
            return Ok(index);
        }
        match size {
            Some(s) => at = body.saturating_add(s),
            None => return Ok(index),
        }
    }
}

/// Most Clusters indexed (a day of one-second Clusters).
const MAX_INDEX_CLUSTERS: u64 = 1 << 17;

/// The Timestamp among the first children of a Cluster whose body starts
/// at `at` (and ends at `end`, if known).
fn cluster_timestamp<R: Read + Seek>(
    r: &mut R,
    mut at: u64,
    end: Option<u64>,
    buf: &mut [u8; INDEX_PEEK],
) -> Result<Option<u64>> {
    for _ in 0..INDEX_CHILDREN {
        if end.is_some_and(|e| at >= e) {
            return Ok(None);
        }
        let n = read_upto(r, at, buf)?;
        let Some((id, Some(size), hlen)) = peek_header(&buf[..n]) else {
            return Ok(None);
        };
        match id {
            id::CLUSTER_TIMESTAMP => {
                let Some(data) = usize::try_from(size)
                    .ok()
                    .and_then(|s| buf[..n].get(hlen..hlen.checked_add(s)?))
                else {
                    return Ok(None);
                };
                return Ok(uint(data).ok());
            }
            id::CRC32 | id::VOID => at = at.saturating_add(hlen as u64).saturating_add(size),
            _ => return Ok(None),
        }
    }
    Ok(None)
}

/// Reads up to `buf.len()` bytes at `pos`; fewer only at the end.
fn read_upto<R: Read + Seek>(r: &mut R, pos: u64, buf: &mut [u8]) -> Result<usize> {
    r.seek(SeekFrom::Start(pos))
        .map_err(|e| Error::io("mkv: seek", e))?;
    let mut got = 0;
    while got < buf.len() {
        match r.read(&mut buf[got..]) {
            Ok(0) => break,
            Ok(k) => got += k,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
            Err(e) => return Err(Error::io("mkv: read", e)),
        }
    }
    Ok(got)
}

/// An element header at the start of `buf`: (ID, size or `None` if
/// unknown, header length). `None` if it is invalid or cut off.
fn peek_header(buf: &[u8]) -> Option<(u32, Option<u64>, usize)> {
    let mut r = Reader::new(buf, "mkv");
    let (len, raw) = buf_vint(&mut r).ok()?;
    if len > 4 {
        return None;
    }
    let id = (raw | (1u64 << (7 * len))) as u32;
    let (slen, size) = buf_vint(&mut r).ok()?;
    let unknown = size == (1u64 << (7 * slen)) - 1;
    Some((id, (!unknown).then_some(size), r.position()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::util::bytes::Writer;

    /// Minimal EBML writer for synthetic streams.
    fn el(w: &mut Writer, id: u32, body: &[u8]) {
        let id_len = 4 - (id.leading_zeros() / 8) as usize;
        w.uint_be(id as u64, id_len);
        size(w, Some(body.len() as u64));
        w.bytes(body);
    }

    fn size(w: &mut Writer, n: Option<u64>) {
        match n {
            None => {
                w.u8(0x01).bytes(&[0xff; 7]);
            }
            Some(n) => {
                w.u8(0x01).uint_be(n, 7);
            }
        }
    }

    fn uint_el(w: &mut Writer, id: u32, v: u64) {
        el(w, id, &v.to_be_bytes());
    }

    fn header(tracks: &[(u64, u64, &str)]) -> Writer {
        let mut w = Writer::new();
        let mut ebml = Writer::new();
        el(&mut ebml, id::DOC_TYPE, b"matroska");
        el(&mut w, id::EBML, ebml.as_slice());
        w.u32_be(id::SEGMENT);
        size(&mut w, None);
        let mut info = Writer::new();
        uint_el(&mut info, id::TIMESTAMP_SCALE, 1_000_000);
        el(&mut w, id::INFO, info.as_slice());
        let mut tw = Writer::new();
        for &(num, ty, codec) in tracks {
            let mut t = Writer::new();
            uint_el(&mut t, id::TRACK_NUMBER, num);
            uint_el(&mut t, id::TRACK_TYPE, ty);
            el(&mut t, id::CODEC_ID, codec.as_bytes());
            uint_el(&mut t, id::DEFAULT_DURATION, 10_000_000);
            el(&mut tw, id::TRACK_ENTRY, t.as_slice());
        }
        el(&mut w, id::TRACKS, tw.as_slice());
        w
    }

    fn cluster(w: &mut Writer, ts: u64) {
        w.u32_be(id::CLUSTER);
        size(w, None);
        uint_el(w, id::CLUSTER_TIMESTAMP, ts);
    }

    fn block(track: u8, rel: i16, flags: u8, payload: &[u8]) -> Vec<u8> {
        let mut b = Writer::new();
        b.u8(0x80 | track).i16_be(rel).u8(flags).bytes(payload);
        b.into_vec()
    }

    #[test]
    fn unknown_size_clusters_and_block_groups() {
        let mut w = header(&[(1, 1, "V_MPEG4/ISO/AVC"), (2, 2, "A_OPUS")]);
        cluster(&mut w, 1000);
        el(&mut w, id::SIMPLE_BLOCK, &block(1, 0, 0x80, b"key"));
        el(&mut w, id::VOID, &[0; 3]);
        el(&mut w, id::SIMPLE_BLOCK, &block(2, -5, 0x80, b"aud"));
        cluster(&mut w, 2000);
        let mut g = Writer::new();
        el(&mut g, id::BLOCK, &block(1, 33, 0, b"delta"));
        uint_el(&mut g, id::REFERENCE_BLOCK, 1);
        uint_el(&mut g, id::BLOCK_DURATION, 33);
        el(&mut w, id::BLOCK_GROUP, g.as_slice());
        let mut g = Writer::new();
        el(&mut g, id::BLOCK, &block(1, 66, 0, b"idr"));
        el(&mut w, id::BLOCK_GROUP, g.as_slice());
        let data = w.into_vec();

        let mut d = Demuxer::new(&data[..]).unwrap();
        assert_eq!(d.tracks().len(), 2);
        assert_eq!(d.track(2).unwrap().codec_id, "A_OPUS");
        let f = d.next_frame().unwrap().unwrap();
        assert_eq!((f.track, f.timestamp, f.keyframe), (1, 1000, true));
        assert_eq!(f.pts_ns, 1_000_000_000);
        assert_eq!(f.data, b"key");
        let f = d.next_frame().unwrap().unwrap();
        assert_eq!(
            (f.track, f.timestamp, f.data.as_slice()),
            (2, 995, &b"aud"[..])
        );
        let f = d.next_frame().unwrap().unwrap();
        assert_eq!(
            (f.timestamp, f.keyframe, f.duration),
            (2033, false, Some(33))
        );
        let f = d.next_frame().unwrap().unwrap();
        assert_eq!(
            (f.timestamp, f.keyframe, f.data.as_slice()),
            (2066, true, &b"idr"[..])
        );
        assert!(d.next_frame().unwrap().is_none());
    }

    #[test]
    fn lacing_modes() {
        let mut w = header(&[(1, 2, "A_OPUS")]);
        cluster(&mut w, 0);
        // Xiph: sizes 300 (255+45) and 2, last 1.
        let mut p = vec![2u8, 255, 45, 2];
        p.extend(vec![b'a'; 300]);
        p.extend(b"bbc");
        el(&mut w, id::SIMPLE_BLOCK, &block(1, 0, 0x80 | 0x02, &p));
        // EBML: sizes 3, 5 (diff +2), last 4.
        // 0x83 = first size 3; 0xc1 = 1-byte signed VINT 65 - bias 63 = +2.
        let mut p = vec![2u8, 0x83, 0xc1];
        p.extend(b"xxxyyyyyzzzz");
        el(&mut w, id::SIMPLE_BLOCK, &block(1, 30, 0x80 | 0x06, &p));
        // Fixed: three frames of 2.
        let mut p = vec![2u8];
        p.extend(b"112233");
        el(&mut w, id::SIMPLE_BLOCK, &block(1, 60, 0x80 | 0x04, &p));
        let data = w.into_vec();
        let mut d = Demuxer::new(&data[..]).unwrap();
        let mut got = Vec::new();
        while let Some(f) = d.next_frame().unwrap() {
            got.push((f.timestamp, f.pts_ns / 1_000_000, f.data));
        }
        let sizes: Vec<usize> = got.iter().map(|g| g.2.len()).collect();
        assert_eq!(sizes, [300, 2, 1, 3, 5, 4, 2, 2, 2]);
        assert_eq!(got[4].2, b"yyyyy");
        assert_eq!(got[8].2, b"33");
        // Later laced frames are offset by DefaultDuration (10 ms).
        assert_eq!((got[1].0, got[1].1), (0, 10));
        assert_eq!((got[5].0, got[5].1), (30, 50));
    }

    /// Demuxes a fixture and compares every packet with ffprobe's view.
    fn check_fixture(name: &str) {
        let blocks = crate::util::vectors::load(&format!("mkv/{name}.txt"));
        let b = &blocks[0];
        let expected: Vec<String> = b
            .str("packets")
            .split(';')
            .filter(|p| !p.is_empty())
            .map(|p| p.replace(' ', ""))
            .collect();
        let data = crate::util::vectors::fixture(&format!("media/{name}.mkv"));
        let mut d = Demuxer::new(&data[..]).unwrap();
        let codecs: Vec<&str> = d.tracks().iter().map(|t| t.codec_id.as_str()).collect();
        assert_eq!(codecs, ["V_MPEG4/ISO/AVC", "A_ALAC", "A_OPUS"]);
        assert_eq!(b.str("stream0"), "h264");
        let v = d.track(1).unwrap();
        assert_eq!((v.pixel_width, v.pixel_height), (Some(160), Some(120)));
        let a = d.track(2).unwrap();
        assert_eq!((a.sampling_frequency, a.channels), (Some(44100.0), Some(2)));
        assert_eq!(a.codec_private.len(), 24);
        let o = d.track(3).unwrap();
        assert!(o.codec_private.starts_with(b"OpusHead"));
        let mut got = Vec::new();
        while let Some(f) = d.next_frame().unwrap() {
            // ffprobe packet strings with spaces removed: stream pts flag size
            got.push(format!(
                "{}{}{}{}",
                f.track - 1,
                d.ffprobe_pts(&f),
                if f.keyframe { "K" } else { "_" },
                f.data.len()
            ));
        }
        assert_eq!(got.len(), expected.len(), "{name}: packet count");
        for (i, (g, e)) in got.iter().zip(&expected).enumerate() {
            assert_eq!(g, e, "{name}: packet {i}");
        }
        assert_eq!(d.position(), data.len() as u64);
    }

    #[test]
    fn ffmpeg_live_fixture() {
        check_fixture("live");
    }

    #[test]
    fn ffmpeg_file_fixture() {
        check_fixture("file");
    }

    #[test]
    fn cluster_index_and_seek() {
        use std::io::Cursor;
        let data = crate::util::vectors::fixture("media/file.mkv");
        let mut d = Demuxer::new(Cursor::new(data.clone())).unwrap();
        assert_eq!(d.first_cluster(), 962);
        let index = index_clusters(&mut Cursor::new(data.clone()), 962).unwrap();
        // Positions from the file, Timestamps as ffprobe shows the blocks.
        let at = |pos, timestamp| ClusterEntry { pos, timestamp };
        assert_eq!(
            index,
            ClusterIndex {
                clusters: vec![at(962, 0), at(22251, 501)],
                complete: true
            }
        );
        d.seek_cluster(22251).unwrap();
        // Opus at the Cluster's 501 ms, then the keyframe at 500 ms (a
        // block before its Cluster's Timestamp).
        let f = d.next_frame().unwrap().unwrap();
        assert_eq!(d.cluster_position(), 22251);
        assert_eq!((f.track, f.timestamp), (3, 501));
        let f = d.next_frame().unwrap().unwrap();
        assert_eq!((f.track, f.timestamp, f.keyframe), (1, 500, true));
        let mut n = 2;
        while d.next_frame().unwrap().is_some() {
            n += 1;
        }
        // Back to the start: everything again.
        d.seek_cluster(962).unwrap();
        let mut all = 0;
        while d.next_frame().unwrap().is_some() {
            all += 1;
        }
        assert!(all > n && n > 10, "{all} {n}");
        // ffmpeg's live output has known-size Clusters too.
        let data = crate::util::vectors::fixture("media/live.mkv");
        let index = index_clusters(&mut Cursor::new(data), 820).unwrap();
        assert!(index.complete);
        assert_eq!(index.clusters.len(), 111);
        assert_eq!(index.clusters[2], at(5172, 11));
        let back: Vec<usize> = (1..index.clusters.len())
            .filter(|&i| index.clusters[i].timestamp < index.clusters[i - 1].timestamp)
            .collect();
        // ALAC's 4096-sample packets get Clusters of their own, which start
        // up to 2 ms before the previous one.
        assert_eq!(back, [32, 73, 104]);
        assert_eq!(index.clusters[32], at(13825, 279));
    }

    #[test]
    fn cluster_index_never_panics() {
        use std::io::Cursor;
        let data = crate::util::vectors::fixture("media/file.mkv");
        for n in (0..data.len()).step_by(7) {
            let _ = index_clusters(&mut Cursor::new(data[..n].to_vec()), 962);
        }
        for i in (900..1100).chain(22200..22300) {
            let mut bad = data.clone();
            bad[i] ^= 0xa5;
            let _ = index_clusters(&mut Cursor::new(bad.clone()), 962);
            bad[i] = 0xff;
            let _ = index_clusters(&mut Cursor::new(bad), 962);
        }
        // Past the end, and an unknown size.
        let index = index_clusters(&mut Cursor::new(data.clone()), data.len() as u64 + 5).unwrap();
        assert!(index.complete && index.clusters.is_empty());
        let mut w = Writer::new();
        cluster(&mut w, 7);
        let index = index_clusters(&mut Cursor::new(w.into_vec()), 0).unwrap();
        assert_eq!(
            index.clusters,
            [ClusterEntry {
                pos: 0,
                timestamp: 7
            }]
        );
        assert!(!index.complete);
    }

    #[test]
    fn errors_not_panics() {
        let mut w = header(&[(1, 1, "V_MPEG4/ISO/AVC")]);
        cluster(&mut w, 0);
        el(&mut w, id::SIMPLE_BLOCK, &block(1, 0, 0x80, b"frame"));
        let data = w.into_vec();
        // Every truncation either ends cleanly, errors, or yields frames.
        for n in 0..data.len() {
            if let Ok(mut d) = Demuxer::new(&data[..n]) {
                while let Ok(Some(_)) = d.next_frame() {}
            }
        }
        // Flip every byte in turn.
        for i in 0..data.len() {
            let mut bad = data.clone();
            bad[i] ^= 0xff;
            if let Ok(mut d) = Demuxer::new(&bad[..]) {
                for _ in 0..16 {
                    if !matches!(d.next_frame(), Ok(Some(_))) {
                        break;
                    }
                }
            }
        }
        // Block for an unknown track.
        let mut w = header(&[(1, 1, "V_MPEG4/ISO/AVC")]);
        cluster(&mut w, 0);
        el(&mut w, id::SIMPLE_BLOCK, &block(7, 0, 0x80, b"x"));
        let data = w.into_vec();
        let mut d = Demuxer::new(&data[..]).unwrap();
        assert!(d.next_frame().is_err());
        // Oversized lace sizes.
        let mut w = header(&[(1, 2, "A_OPUS")]);
        cluster(&mut w, 0);
        el(&mut w, id::SIMPLE_BLOCK, &block(1, 0, 0x82, &[1, 200, 1]));
        let data = w.into_vec();
        let mut d = Demuxer::new(&data[..]).unwrap();
        assert!(d.next_frame().is_err());
        assert!(Demuxer::new(&b"not mkv at all"[..]).is_err());
        assert!(Demuxer::new(&[][..]).is_err());
    }
}
