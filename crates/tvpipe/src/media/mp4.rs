//! MP4 / QuickTime (MOV) demuxer over `Read + Seek`.
//!
//! Reads the `moov` box (wherever it is in the file), builds compact
//! per-track sample tables and yields samples interleaved by decode time.
//! Fragmented files (`mvex` + `moof`/`traf`/`trun`) are read fragment by
//! fragment after the samples of the `moov` itself (usually none).
//!
//! What is understood:
//!
//! - `stsd`: `avc1`..`avc4` (`avcC`), `hvc1`/`hev1` (`hvcC`), `mp4a`
//!   (`esds`, also inside QuickTime `wave`), `Opus` (`dOps`, converted to
//!   an `OpusHead`), `alac` (the `alac` config box, also inside `wave`),
//!   PCM (`sowt`, `twos`, `lpcm`); anything else is [`Codec::Other`].
//! - `stts`, `ctts` (signed offsets in either version), `stss`, `stsz` /
//!   `stz2`, `stsc`, `stco` / `co64`.
//! - Edit lists: leading empty edits and the first edit's `media_time`
//!   become a constant time offset per track; more edits are reported
//!   ([`Track::edits`]) and otherwise ignored.
//! - Fragments: `tfhd` defaults (and `trex`), `tfdt`, every `trun` field,
//!   `default-base-is-moof` and implicit base offsets.
//!
//! [`Demuxer::seek`] positions every track at a sync sample of one track
//! (the video) near a time: it walks the in-memory sample tables (for
//! fragmented files the `moof`s, with unbuffered reads of box headers and
//! `moof`s only, never `mdat` contents), reads only the candidate samples
//! a caller-given test accepts (an IDR picture), and drops other tracks'
//! samples presented before the one it lands on.
//!
//! PCM tracks store one sample per audio frame; like ffmpeg, consecutive
//! samples of one chunk are returned as packets of up to
//! [`PCM_PACKET_SAMPLES`] frames.
//!
//! Every size and count from the file is checked against the box it came
//! from and against fixed limits, so a hostile file cannot make us panic or
//! allocate unbounded memory.
//!
//! Sources: ISO/IEC 14496-12 (ISO BMFF: §4.2 box structure, §8.2 moov/
//! mvhd, §8.3 trak/tkhd, §8.4 mdia/mdhd/hdlr, §8.5 stsd and sample
//! entries, §8.6 stts/ctts/stss/edts/elst, §8.7 stsz/stz2/stsc/stco/co64,
//! §8.8 mvex/trex/moof/mfhd/traf/tfhd/trun/tfdt, sample flags §8.8.3.1);
//! ISO/IEC 14496-14 §5.6 (esds); ISO/IEC 14496-1 §7.2.6.5-7 (ES,
//! DecoderConfig and DecoderSpecificInfo descriptors); ISO/IEC 14496-15
//! (avcC, hvcC sample entries); "Encapsulation of Opus in ISO Base Media
//! File Format" v0.8.1 (dOps) and RFC 7845 §5.1 (OpusHead); Apple
//! QuickTime File Format Specification (sound sample description versions
//! 0-2, `wave`, `sowt`/`twos`/`lpcm`); Apple ALAC `ALACMagicCookieDescription.txt`
//! (Apache-2.0); black-box behaviour of ffprobe 8.1 for the fixtures.

use std::cmp::Ordering;
use std::collections::VecDeque;
use std::io::{self, BufReader, Read, Seek, SeekFrom};

use crate::error::{Error, Result};
use crate::util::bytes::Reader;

/// Largest `moov` we read into memory.
const MAX_MOOV_SIZE: u64 = 64 << 20;
/// Largest `moof` we read into memory.
const MAX_MOOF_SIZE: u64 = 16 << 20;
/// Largest single sample (one access unit).
pub const MAX_SAMPLE_SIZE: u32 = 64 << 20;
const MAX_TRACKS: usize = 64;
/// Most samples per track table / per fragment.
const MAX_SAMPLES: u64 = 1 << 26;
/// PCM frames per returned packet (ffmpeg's grouping).
pub const PCM_PACKET_SAMPLES: u32 = 1024;

pub type FourCc = [u8; 4];

/// A four-character code for messages (`avc1`, or hex if unprintable).
pub fn fourcc_str(f: FourCc) -> String {
    if f.iter().all(|b| b.is_ascii_graphic() || *b == b' ') {
        f.iter().map(|&b| b as char).collect()
    } else {
        format!("0x{:08x}", u32::from_be_bytes(f))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrackType {
    Video,
    Audio,
    /// Handler type (`text`, `tmcd`, `meta`, ...).
    Other(FourCc),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Codec {
    /// H.264. `avcc` is the `avcC` record; it may be missing for `avc3`
    /// (parameter sets in band).
    Avc { avcc: Option<Vec<u8>> },
    /// HEVC with its `hvcC` record.
    Hevc { hvcc: Vec<u8> },
    /// MPEG-4 / MPEG-2 AAC with its AudioSpecificConfig.
    Aac { asc: Vec<u8> },
    /// Opus; `head` is the equivalent `OpusHead` (RFC 7845 §5.1).
    Opus { head: Vec<u8> },
    /// ALAC; `config` is the ALACSpecificConfig (24 bytes, optionally
    /// followed by a channel layout).
    Alac { config: Vec<u8> },
    /// Uncompressed integer or float PCM.
    Pcm {
        bits: u16,
        big_endian: bool,
        float: bool,
    },
    /// Not understood. `object_type` is the `esds` objectTypeIndication
    /// for `mp4a` entries (e.g. 0x6b for MP3).
    Other {
        fourcc: FourCc,
        object_type: Option<u8>,
    },
}

/// One edit-list entry (movie timescale duration, media time, rate 16.16).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Edit {
    pub duration: u64,
    pub media_time: i64,
    pub rate: i32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Track {
    pub id: u32,
    pub track_type: TrackType,
    /// Media timescale (ticks per second of every timestamp below).
    pub timescale: u32,
    /// Media duration in `timescale` ticks (`mdhd`; 0 for fragmented).
    pub duration: u64,
    /// The first sample entry's type (`avc1`, `mp4a`, ...).
    pub fourcc: FourCc,
    pub codec: Codec,
    /// Number of sample descriptions (more than one: the codec
    /// configuration changes mid-stream).
    pub sample_descriptions: u32,
    /// Video: sample entry width/height (0 for audio).
    pub width: u32,
    pub height: u32,
    /// Audio: sample rate and channel count from the sample entry.
    pub sample_rate: u32,
    pub channels: u16,
    /// `tkhd` display matrix (a, b, u, c, d, v, x, y, w; 16.16 and 2.30
    /// fixed point). Phones rotate video with it.
    pub matrix: [i32; 9],
    /// Edit list as stored.
    pub edits: Vec<Edit>,
    /// Added to every dts/pts: leading empty edits minus the first edit's
    /// media time, in `timescale` ticks.
    pub time_offset: i64,
    /// Samples in the `moov` sample table (fragments not counted).
    pub sample_count: u64,
    /// Sum of the table's sample sizes in bytes.
    pub total_bytes: u64,
    /// Whether presentation order differs from decode order anywhere in
    /// the `moov` sample table (B-frames). Fragments are not covered.
    pub reorders: bool,
    table: SampleTable,
    defaults: Defaults,
}

/// The `tkhd` identity matrix.
pub const IDENTITY_MATRIX: [i32; 9] = [0x1_0000, 0, 0, 0, 0x1_0000, 0, 0, 0, 0x4000_0000];

impl Track {
    /// Whether the display matrix only translates (no rotation, flip or
    /// scaling).
    pub fn matrix_is_identity(&self) -> bool {
        self.matrix[..2] == IDENTITY_MATRIX[..2] && self.matrix[3..5] == IDENTITY_MATRIX[3..5]
    }

    /// Edits that are not leading empty edits; more than one means the
    /// file is cut (we play the media as is).
    pub fn media_edits(&self) -> usize {
        self.edits.iter().filter(|e| e.media_time != -1).count()
    }

    /// Seconds of media, if known.
    pub fn duration_secs(&self) -> Option<f64> {
        (self.timescale > 0 && self.duration > 0)
            .then(|| self.duration as f64 / self.timescale as f64)
    }
}

/// One demuxed sample.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Sample {
    pub track_id: u32,
    /// Decode and presentation time in the track's timescale, edit list
    /// offset applied (so they can be negative: encoder delay).
    pub dts: i64,
    pub pts: i64,
    pub duration: u32,
    /// Sync sample (`stss`, or not `sample_is_non_sync_sample`).
    pub keyframe: bool,
    /// File offset of the data.
    pub pos: u64,
    pub data: Vec<u8>,
}

/// Per-track sample table from `stbl` (compact: run-length tables).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct SampleTable {
    stts: Vec<(u32, u32)>,
    ctts: Vec<(u32, i32)>,
    stss: Option<Vec<u32>>,
    sizes: Sizes,
    stsc: Vec<(u32, u32)>,
    chunks: Vec<u64>,
    /// Group consecutive samples into packets (PCM).
    group: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Sizes {
    Constant { size: u32, count: u32 },
    Table(Vec<u32>),
}

impl Default for Sizes {
    fn default() -> Sizes {
        Sizes::Constant { size: 0, count: 0 }
    }
}

impl Sizes {
    fn count(&self) -> u32 {
        match self {
            Sizes::Constant { count, .. } => *count,
            Sizes::Table(t) => t.len() as u32,
        }
    }
    fn get(&self, i: u32) -> u32 {
        match self {
            Sizes::Constant { size, .. } => *size,
            Sizes::Table(t) => t.get(i as usize).copied().unwrap_or(0),
        }
    }
}

/// `trex` defaults for fragments.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct Defaults {
    duration: u32,
    size: u32,
    flags: u32,
}

/// Position in a [`SampleTable`].
#[derive(Debug, Clone, Default)]
struct Cursor {
    sample: u32,
    stts_i: usize,
    stts_left: u32,
    last_delta: u32,
    ctts_i: usize,
    ctts_left: u32,
    stsc_i: usize,
    chunk: usize,
    in_chunk: u32,
    per_chunk: u32,
    offset: u64,
    stss_i: usize,
    dts: i64,
    started: bool,
    done: bool,
}

/// One sample's place in the file, before reading.
#[derive(Debug, Clone, Copy)]
struct SampleRef {
    track: usize,
    dts: i64,
    pts: i64,
    duration: u32,
    keyframe: bool,
    pos: u64,
    size: u32,
}

impl Cursor {
    /// Moves to the chunk `self.chunk` (or later, skipping empty ones).
    fn enter_chunk(&mut self, t: &SampleTable) -> bool {
        while self.chunk < t.chunks.len() {
            let c = self.chunk as u64 + 1;
            while self.stsc_i + 1 < t.stsc.len() && c >= t.stsc[self.stsc_i + 1].0 as u64 {
                self.stsc_i += 1;
            }
            self.per_chunk = t.stsc.get(self.stsc_i).map_or(0, |e| e.1);
            if t.stsc.first().is_some_and(|e| c >= e.0 as u64) && self.per_chunk > 0 {
                self.offset = t.chunks[self.chunk];
                self.in_chunk = 0;
                return true;
            }
            self.chunk += 1;
        }
        false
    }

    /// The next sample of the table, or `None` at its end.
    fn next(&mut self, t: &SampleTable, track: usize) -> Option<SampleRef> {
        if self.done || self.sample >= t.sizes.count() {
            self.done = true;
            return None;
        }
        if !self.started {
            self.started = true;
            if !self.enter_chunk(t) {
                self.done = true;
                return None;
            }
        } else if self.in_chunk >= self.per_chunk {
            self.chunk += 1;
            if !self.enter_chunk(t) {
                self.done = true;
                return None;
            }
        }
        // stts: decode deltas.
        while self.stts_left == 0 && self.stts_i < t.stts.len() {
            self.stts_left = t.stts[self.stts_i].0;
            self.last_delta = t.stts[self.stts_i].1;
            self.stts_i += 1;
        }
        let delta = self.last_delta;
        self.stts_left = self.stts_left.saturating_sub(1);
        // ctts: composition offsets.
        while self.ctts_left == 0 && self.ctts_i < t.ctts.len() {
            self.ctts_left = t.ctts[self.ctts_i].0;
            self.ctts_i += 1;
        }
        let cts = if self.ctts_left > 0 {
            self.ctts_left -= 1;
            t.ctts[self.ctts_i - 1].1 as i64
        } else {
            0
        };
        let number = self.sample + 1;
        let keyframe = match &t.stss {
            None => true,
            Some(list) => {
                while self.stss_i < list.len() && list[self.stss_i] < number {
                    self.stss_i += 1;
                }
                list.get(self.stss_i) == Some(&number)
            }
        };
        let size = t.sizes.get(self.sample);
        let r = SampleRef {
            track,
            dts: self.dts,
            pts: self.dts.saturating_add(cts),
            duration: delta,
            keyframe,
            pos: self.offset,
            size,
        };
        self.dts = self.dts.saturating_add(delta as i64);
        self.offset = self.offset.saturating_add(size as u64);
        self.in_chunk += 1;
        self.sample += 1;
        Some(r)
    }

    /// Whether the next sample continues the current chunk.
    fn continues_chunk(&self, t: &SampleTable) -> bool {
        self.started
            && !self.done
            && self.in_chunk < self.per_chunk
            && self.sample < t.sizes.count()
    }
}

// ---------------------------------------------------------------------------
// In-memory box parsing

/// Iterates the boxes in `data`: `(type, body)`.
fn boxes(data: &[u8]) -> impl Iterator<Item = Result<(FourCc, &[u8])>> + '_ {
    let mut r = Reader::new(data, "mp4");
    let mut failed = false;
    std::iter::from_fn(move || {
        if failed || r.remaining() < 8 {
            // Fewer than 8 trailing bytes: padding (QuickTime writes a
            // 4-byte zero terminator in some atoms).
            return None;
        }
        let rv = (|| {
            let start = r.position();
            let size = r.u32_be()? as u64;
            let typ: FourCc = r.array()?;
            let size = match size {
                0 => (r.len() - start) as u64,
                1 => r.u64_be()?,
                n => n,
            };
            let header = (r.position() - start) as u64;
            if size < header {
                return Err(r.error("box size smaller than its header"));
            }
            let body = usize::try_from(size - header).map_err(|_| r.error("box too large"))?;
            Ok((typ, r.bytes(body)?))
        })();
        failed = rv.is_err();
        Some(rv)
    })
}

/// The first child box of type `typ`.
fn child<'a>(data: &'a [u8], typ: &FourCc) -> Result<Option<&'a [u8]>> {
    for b in boxes(data) {
        let (t, body) = b?;
        if &t == typ {
            return Ok(Some(body));
        }
    }
    Ok(None)
}

/// Splits a full box body into (version, flags, rest).
fn full_box<'a>(body: &'a [u8], what: &'static str) -> Result<(u8, u32, Reader<'a>)> {
    let mut r = Reader::new(body, what);
    let vf = r.u32_be()?;
    Ok(((vf >> 24) as u8, vf & 0x00ff_ffff, r))
}

/// A count of entries of `entry_size` bytes that must fit in `r`.
fn count(r: &mut Reader<'_>, entry_size: usize) -> Result<usize> {
    let n = r.u32_be()? as usize;
    if n.checked_mul(entry_size).is_none_or(|b| b > r.remaining()) {
        return Err(r.error("entry count exceeds box size"));
    }
    if n as u64 > MAX_SAMPLES {
        return Err(r.error("too many entries"));
    }
    Ok(n)
}

fn parse_mvhd(body: &[u8]) -> Result<u32> {
    let (v, _, mut r) = full_box(body, "mp4 mvhd")?;
    r.skip(if v == 1 { 16 } else { 8 })?;
    r.u32_be()
}

fn parse_elst(body: &[u8]) -> Result<Vec<Edit>> {
    let (v, _, mut r) = full_box(body, "mp4 elst")?;
    let n = count(&mut r, if v == 1 { 20 } else { 12 })?;
    let mut out = Vec::with_capacity(n);
    for _ in 0..n {
        let (duration, media_time) = if v == 1 {
            (r.u64_be()?, r.i64_be()?)
        } else {
            (r.u32_be()? as u64, r.i32_be()? as i64)
        };
        let rate = r.i32_be()?;
        out.push(Edit {
            duration,
            media_time,
            rate,
        });
    }
    Ok(out)
}

/// The constant offset an edit list applies (see the module docs).
fn edit_offset(edits: &[Edit], movie_timescale: u32, timescale: u32) -> i64 {
    let mut empty: u64 = 0;
    for e in edits {
        if e.media_time == -1 {
            empty = empty.saturating_add(e.duration);
            continue;
        }
        let empty_ticks = if movie_timescale == 0 {
            0
        } else {
            (empty as u128 * timescale as u128 / movie_timescale as u128).min(i64::MAX as u128)
                as i64
        };
        return empty_ticks.saturating_sub(e.media_time);
    }
    0
}

/// Reads an MPEG-4 descriptor header (ISO/IEC 14496-1 §8.3.3).
fn descriptor<'a>(r: &mut Reader<'a>) -> Result<(u8, Reader<'a>)> {
    let tag = r.u8()?;
    let mut len = 0usize;
    for _ in 0..4 {
        let b = r.u8()?;
        len = (len << 7) | (b & 0x7f) as usize;
        if b & 0x80 == 0 {
            break;
        }
    }
    Ok((tag, r.sub(len)?))
}

/// `esds` → (objectTypeIndication, DecoderSpecificInfo).
fn parse_esds(body: &[u8]) -> Result<(u8, Vec<u8>)> {
    let (_, _, mut r) = full_box(body, "mp4 esds")?;
    let (tag, mut es) = descriptor(&mut r)?;
    if tag != 0x03 {
        return Err(es.error("esds without ES_Descriptor"));
    }
    es.skip(2)?; // ES_ID
    let flags = es.u8()?;
    if flags & 0x80 != 0 {
        es.skip(2)?; // dependsOn_ES_ID
    }
    if flags & 0x40 != 0 {
        let n = es.u8()? as usize;
        es.skip(n)?; // URL
    }
    if flags & 0x20 != 0 {
        es.skip(2)?; // OCR_ES_Id
    }
    while !es.is_at_end() {
        let (tag, mut dc) = descriptor(&mut es)?;
        if tag != 0x04 {
            continue;
        }
        let object_type = dc.u8()?;
        dc.skip(12)?; // streamType, bufferSizeDB, maxBitrate, avgBitrate
        while !dc.is_at_end() {
            let (tag, dsi) = descriptor(&mut dc)?;
            if tag == 0x05 {
                return Ok((object_type, dsi.rest().to_vec()));
            }
        }
        return Ok((object_type, Vec::new()));
    }
    Err(Error::malformed("mp4 esds: no DecoderConfigDescriptor"))
}

/// `dOps` (big-endian) → `OpusHead` (little-endian, RFC 7845 §5.1).
fn dops_to_opus_head(body: &[u8]) -> Result<Vec<u8>> {
    let mut r = Reader::new(body, "mp4 dOps");
    if r.u8()? != 0 {
        return Err(r.error("unsupported dOps version"));
    }
    let channels = r.u8()?;
    let pre_skip = r.u16_be()?;
    let rate = r.u32_be()?;
    let gain = r.i16_be()?;
    let family = r.u8()?;
    let mut head = Vec::with_capacity(19 + 2 + channels as usize);
    head.extend_from_slice(b"OpusHead");
    head.push(1);
    head.push(channels);
    head.extend_from_slice(&pre_skip.to_le_bytes());
    head.extend_from_slice(&rate.to_le_bytes());
    head.extend_from_slice(&gain.to_le_bytes());
    head.push(family);
    if family != 0 {
        let streams = r.u8()?;
        let coupled = r.u8()?;
        head.push(streams);
        head.push(coupled);
        head.extend_from_slice(r.bytes(channels as usize)?);
    }
    Ok(head)
}

/// Finds a box among `data`'s children, also inside a QuickTime `wave`.
fn audio_child<'a>(data: &'a [u8], typ: &FourCc) -> Result<Option<&'a [u8]>> {
    if let Some(b) = child(data, typ)? {
        return Ok(Some(b));
    }
    match child(data, b"wave")? {
        Some(wave) => child(wave, typ),
        None => Ok(None),
    }
}

struct Entry {
    fourcc: FourCc,
    codec: Codec,
    width: u32,
    height: u32,
    sample_rate: u32,
    channels: u16,
}

fn parse_stsd(body: &[u8], track_type: TrackType) -> Result<(Entry, u32)> {
    let (_, _, mut r) = full_box(body, "mp4 stsd")?;
    let n = r.u32_be()?;
    let (fourcc, entry) = boxes(r.rest())
        .next()
        .ok_or_else(|| Error::malformed("mp4 stsd: no sample entry"))??;
    let mut e = Entry {
        fourcc,
        codec: Codec::Other {
            fourcc,
            object_type: None,
        },
        width: 0,
        height: 0,
        sample_rate: 0,
        channels: 0,
    };
    let mut r = Reader::new(entry, "mp4 sample entry");
    r.skip(8)?; // reserved, data_reference_index
    match track_type {
        TrackType::Video => {
            r.skip(16)?;
            e.width = r.u16_be()? as u32;
            e.height = r.u16_be()? as u32;
            r.skip(50)?;
            let kids = r.rest();
            e.codec = match &fourcc {
                b"avc1" | b"avc2" | b"avc3" | b"avc4" => Codec::Avc {
                    avcc: child(kids, b"avcC")?.map(<[u8]>::to_vec),
                },
                b"hvc1" | b"hev1" => Codec::Hevc {
                    hvcc: child(kids, b"hvcC")?
                        .ok_or_else(|| Error::malformed("mp4: HEVC sample entry without hvcC"))?
                        .to_vec(),
                },
                _ => e.codec,
            };
        }
        TrackType::Audio => {
            let version = r.u16_be()?;
            r.skip(6)?; // revision, vendor
            e.channels = r.u16_be()?;
            let bits = r.u16_be()?;
            r.skip(4)?; // compression id, packet size
            e.sample_rate = r.u32_be()? >> 16;
            let mut flags = 0u32;
            let mut bits = bits;
            match version {
                0 => {}
                1 => r.skip(16)?,
                2 => {
                    r.skip(4)?; // sizeOfStructOnly
                    let rate = f64::from_bits(r.u64_be()?);
                    e.sample_rate = if rate.is_finite() && (1.0..=1e7).contains(&rate) {
                        rate.round() as u32
                    } else {
                        0
                    };
                    e.channels = u16::try_from(r.u32_be()?).unwrap_or(0);
                    r.skip(4)?; // always 0x7F000000
                    bits = u16::try_from(r.u32_be()?).unwrap_or(0);
                    flags = r.u32_be()?;
                    r.skip(8)?;
                }
                _ => return Err(r.error("unknown sound sample description version")),
            }
            let kids = r.rest();
            e.codec = match &fourcc {
                b"mp4a" => match audio_child(kids, b"esds")? {
                    Some(esds) => {
                        let (ot, dsi) = parse_esds(esds)?;
                        match ot {
                            // MPEG-4 audio; MPEG-2 AAC Main/LC/SSR.
                            0x40 | 0x66 | 0x67 | 0x68 => Codec::Aac { asc: dsi },
                            _ => Codec::Other {
                                fourcc,
                                object_type: Some(ot),
                            },
                        }
                    }
                    None => e.codec,
                },
                b"Opus" => Codec::Opus {
                    head: dops_to_opus_head(
                        child(kids, b"dOps")?
                            .ok_or_else(|| Error::malformed("mp4: Opus entry without dOps"))?,
                    )?,
                },
                b"alac" => {
                    let cfg = audio_child(kids, b"alac")?
                        .ok_or_else(|| Error::malformed("mp4: ALAC entry without config"))?;
                    let (_, _, cr) = full_box(cfg, "mp4 alac")?;
                    if cr.remaining() < 24 {
                        return Err(Error::malformed("mp4: ALAC config too short"));
                    }
                    Codec::Alac {
                        config: cr.rest().to_vec(),
                    }
                }
                b"sowt" => Codec::Pcm {
                    bits,
                    big_endian: false,
                    float: false,
                },
                b"twos" => Codec::Pcm {
                    bits,
                    big_endian: true,
                    float: false,
                },
                // kAudioFormatFlagIsFloat = 1, kAudioFormatFlagIsBigEndian = 2.
                b"lpcm" => Codec::Pcm {
                    bits,
                    big_endian: flags & 2 != 0,
                    float: flags & 1 != 0,
                },
                _ => e.codec,
            };
        }
        TrackType::Other(_) => {}
    }
    Ok((e, n))
}

fn parse_stbl(body: &[u8], track_type: TrackType) -> Result<(Entry, u32, SampleTable)> {
    let mut t = SampleTable::default();
    let mut entry = None;
    let mut have_sizes = false;
    for b in boxes(body) {
        let (typ, body) = b?;
        match &typ {
            b"stsd" => entry = Some(parse_stsd(body, track_type)?),
            b"stts" => {
                let (_, _, mut r) = full_box(body, "mp4 stts")?;
                let n = count(&mut r, 8)?;
                t.stts = (0..n)
                    .map(|_| Ok((r.u32_be()?, r.u32_be()?)))
                    .collect::<Result<_>>()?;
            }
            b"ctts" => {
                let (_, _, mut r) = full_box(body, "mp4 ctts")?;
                let n = count(&mut r, 8)?;
                // Version 0 offsets are unsigned in the spec, but writers
                // put negative values there too; read both as signed.
                t.ctts = (0..n)
                    .map(|_| Ok((r.u32_be()?, r.i32_be()?)))
                    .collect::<Result<_>>()?;
            }
            b"stss" => {
                let (_, _, mut r) = full_box(body, "mp4 stss")?;
                let n = count(&mut r, 4)?;
                t.stss = Some((0..n).map(|_| r.u32_be()).collect::<Result<_>>()?);
            }
            b"stsz" => {
                let (_, _, mut r) = full_box(body, "mp4 stsz")?;
                let size = r.u32_be()?;
                if size != 0 {
                    let count = r.u32_be()?;
                    if count as u64 > MAX_SAMPLES {
                        return Err(r.error("too many samples"));
                    }
                    t.sizes = Sizes::Constant { size, count };
                } else {
                    let n = count(&mut r, 4)?;
                    t.sizes = Sizes::Table((0..n).map(|_| r.u32_be()).collect::<Result<_>>()?);
                }
                have_sizes = true;
            }
            b"stz2" => {
                let (_, _, mut r) = full_box(body, "mp4 stz2")?;
                r.skip(3)?;
                let field = r.u8()?;
                let n = r.u32_be()? as usize;
                let bytes = match field {
                    4 => n.div_ceil(2),
                    8 => n,
                    16 => n.saturating_mul(2),
                    _ => return Err(r.error("invalid stz2 field size")),
                };
                if bytes > r.remaining() || n as u64 > MAX_SAMPLES {
                    return Err(r.error("entry count exceeds box size"));
                }
                let data = r.bytes(bytes)?;
                let sizes = (0..n)
                    .map(|i| match field {
                        4 => ((data[i / 2] >> if i % 2 == 0 { 4 } else { 0 }) & 0x0f) as u32,
                        8 => data[i] as u32,
                        _ => u16::from_be_bytes([data[2 * i], data[2 * i + 1]]) as u32,
                    })
                    .collect();
                t.sizes = Sizes::Table(sizes);
                have_sizes = true;
            }
            b"stsc" => {
                let (_, _, mut r) = full_box(body, "mp4 stsc")?;
                let n = count(&mut r, 12)?;
                let mut prev = 0;
                for _ in 0..n {
                    let first = r.u32_be()?;
                    let per = r.u32_be()?;
                    r.skip(4)?; // sample_description_index
                    if first == 0 || first < prev {
                        return Err(r.error("stsc first_chunk not increasing"));
                    }
                    prev = first;
                    t.stsc.push((first, per));
                }
            }
            b"stco" => {
                let (_, _, mut r) = full_box(body, "mp4 stco")?;
                let n = count(&mut r, 4)?;
                t.chunks = (0..n)
                    .map(|_| r.u32_be().map(u64::from))
                    .collect::<Result<_>>()?;
            }
            b"co64" => {
                let (_, _, mut r) = full_box(body, "mp4 co64")?;
                let n = count(&mut r, 8)?;
                t.chunks = (0..n).map(|_| r.u64_be()).collect::<Result<_>>()?;
            }
            _ => {}
        }
    }
    let (entry, n) = entry.ok_or_else(|| Error::malformed("mp4: stbl without stsd"))?;
    if !have_sizes && !t.chunks.is_empty() {
        return Err(Error::malformed("mp4: stbl without stsz"));
    }
    Ok((entry, n, t))
}

/// Walks the table without I/O: (total bytes, whether pts ever goes
/// backwards in decode order).
fn scan_table(t: &SampleTable) -> (u64, bool) {
    let mut total = 0u64;
    match &t.sizes {
        Sizes::Constant { size, count } => total = *size as u64 * *count as u64,
        Sizes::Table(s) => {
            for &n in s {
                total += n as u64;
            }
        }
    }
    if t.ctts.is_empty() {
        return (total, false);
    }
    let mut c = Cursor::default();
    let mut last: Option<i64> = None;
    let mut reorders = false;
    while let Some(s) = c.next(t, 0) {
        if last.is_some_and(|l| s.pts <= l) {
            reorders = true;
            break;
        }
        last = Some(s.pts);
    }
    (total, reorders)
}

fn parse_trak(body: &[u8], movie_timescale: u32) -> Result<Option<Track>> {
    let mut id = 0;
    let mut edits = Vec::new();
    let mut mdia = None;
    let mut matrix = IDENTITY_MATRIX;
    for b in boxes(body) {
        let (typ, body) = b?;
        match &typ {
            b"tkhd" => {
                let (v, _, mut r) = full_box(body, "mp4 tkhd")?;
                r.skip(if v == 1 { 16 } else { 8 })?;
                id = r.u32_be()?;
                // reserved, duration, reserved[2], layer, alternate_group,
                // volume, reserved; then the 3x3 display matrix.
                r.skip(if v == 1 { 4 + 8 } else { 4 + 4 })?;
                r.skip(16)?;
                for m in matrix.iter_mut() {
                    *m = r.i32_be()?;
                }
            }
            b"edts" => {
                if let Some(elst) = child(body, b"elst")? {
                    edits = parse_elst(elst)?;
                }
            }
            b"mdia" => mdia = Some(body),
            _ => {}
        }
    }
    let mdia = mdia.ok_or_else(|| Error::malformed("mp4: trak without mdia"))?;
    let (mut timescale, mut duration, mut handler) = (0, 0, *b"\0\0\0\0");
    let mut stbl = None;
    for b in boxes(mdia) {
        let (typ, body) = b?;
        match &typ {
            b"mdhd" => {
                let (v, _, mut r) = full_box(body, "mp4 mdhd")?;
                if v == 1 {
                    r.skip(16)?;
                    timescale = r.u32_be()?;
                    duration = r.u64_be()?;
                } else {
                    r.skip(8)?;
                    timescale = r.u32_be()?;
                    duration = r.u32_be()? as u64;
                }
            }
            b"hdlr" => {
                let (_, _, mut r) = full_box(body, "mp4 hdlr")?;
                r.skip(4)?;
                handler = r.array()?;
            }
            b"minf" => stbl = child(body, b"stbl")?,
            _ => {}
        }
    }
    let track_type = match &handler {
        b"vide" => TrackType::Video,
        b"soun" => TrackType::Audio,
        _ => TrackType::Other(handler),
    };
    if matches!(track_type, TrackType::Other(_)) {
        return Ok(None);
    }
    let stbl = stbl.ok_or_else(|| Error::malformed("mp4: track without stbl"))?;
    if timescale == 0 {
        return Err(Error::malformed("mp4: track timescale is zero"));
    }
    let (entry, descriptions, mut table) = parse_stbl(stbl, track_type)?;
    if let Codec::Pcm { .. } = entry.codec {
        table.group = PCM_PACKET_SAMPLES;
    }
    let (total_bytes, reorders) = scan_table(&table);
    Ok(Some(Track {
        id,
        track_type,
        timescale,
        duration,
        fourcc: entry.fourcc,
        codec: entry.codec,
        sample_descriptions: descriptions,
        width: entry.width,
        height: entry.height,
        sample_rate: entry.sample_rate,
        channels: entry.channels,
        matrix,
        time_offset: edit_offset(&edits, movie_timescale, timescale),
        edits,
        sample_count: table.sizes.count() as u64,
        total_bytes,
        reorders,
        table,
        defaults: Defaults::default(),
    }))
}

struct Moov {
    tracks: Vec<Track>,
    fragmented: bool,
}

fn parse_moov(body: &[u8]) -> Result<Moov> {
    let movie_timescale = match child(body, b"mvhd")? {
        Some(m) => parse_mvhd(m)?,
        None => return Err(Error::malformed("mp4: moov without mvhd")),
    };
    let mut tracks: Vec<Track> = Vec::new();
    let mut fragmented = false;
    for b in boxes(body) {
        let (typ, body) = b?;
        match &typ {
            b"trak" => {
                if let Some(t) = parse_trak(body, movie_timescale)? {
                    if tracks.iter().any(|o| o.id == t.id) {
                        return Err(Error::malformed("mp4: duplicate track ID"));
                    }
                    if tracks.len() >= MAX_TRACKS {
                        return Err(Error::unsupported("mp4: too many tracks"));
                    }
                    tracks.push(t);
                }
            }
            b"mvex" => {
                fragmented = true;
                for b in boxes(body) {
                    let (typ, body) = b?;
                    if &typ != b"trex" {
                        continue;
                    }
                    let (_, _, mut r) = full_box(body, "mp4 trex")?;
                    let id = r.u32_be()?;
                    r.skip(4)?;
                    let d = Defaults {
                        duration: r.u32_be()?,
                        size: r.u32_be()?,
                        flags: r.u32_be()?,
                    };
                    if let Some(t) = tracks.iter_mut().find(|t| t.id == id) {
                        t.defaults = d;
                    }
                }
            }
            _ => {}
        }
    }
    Ok(Moov { tracks, fragmented })
}

/// `sample_is_non_sync_sample` (ISO/IEC 14496-12 §8.8.3.1).
const NON_SYNC: u32 = 0x0001_0000;

/// Parses a `moof` into sample references. `frag_dts` holds each track's
/// next decode time (updated).
fn parse_moof(
    body: &[u8],
    moof_start: u64,
    tracks: &[Track],
    frag_dts: &mut [i64],
) -> Result<Vec<SampleRef>> {
    let mut out = Vec::new();
    // Where the previous traf's data ended (implicit base offsets).
    let mut prev_end = moof_start;
    let mut first_traf = true;
    for b in boxes(body) {
        let (typ, traf) = b?;
        if &typ != b"traf" {
            continue;
        }
        let tfhd =
            child(traf, b"tfhd")?.ok_or_else(|| Error::malformed("mp4: traf without tfhd"))?;
        let (_, tf, mut r) = full_box(tfhd, "mp4 tfhd")?;
        let id = r.u32_be()?;
        let Some(ti) = tracks.iter().position(|t| t.id == id) else {
            // A track we skipped (text, timecode).
            continue;
        };
        let mut d = tracks[ti].defaults;
        let base = if tf & 0x01 != 0 {
            r.u64_be()?
        } else if tf & 0x02_0000 != 0 || first_traf {
            moof_start
        } else {
            prev_end
        };
        first_traf = false;
        if tf & 0x02 != 0 {
            r.skip(4)?; // sample_description_index
        }
        if tf & 0x08 != 0 {
            d.duration = r.u32_be()?;
        }
        if tf & 0x10 != 0 {
            d.size = r.u32_be()?;
        }
        if tf & 0x20 != 0 {
            d.flags = r.u32_be()?;
        }
        if let Some(tfdt) = child(traf, b"tfdt")? {
            let (v, _, mut r) = full_box(tfdt, "mp4 tfdt")?;
            let t = if v == 1 {
                r.u64_be()?
            } else {
                r.u32_be()? as u64
            };
            frag_dts[ti] = i64::try_from(t).map_err(|_| Error::malformed("mp4: tfdt too large"))?;
        }
        let offset = tracks[ti].time_offset;
        let mut data_pos = base;
        for b in boxes(traf) {
            let (typ, trun) = b?;
            if &typ != b"trun" {
                continue;
            }
            let (v, fl, mut r) = full_box(trun, "mp4 trun")?;
            let n = r.u32_be()? as usize;
            if fl & 0x01 != 0 {
                let off = r.i32_be()? as i64;
                data_pos = (base as i64)
                    .checked_add(off)
                    .and_then(|p| u64::try_from(p).ok())
                    .ok_or_else(|| r.error("data offset out of range"))?;
            }
            let first_flags = if fl & 0x04 != 0 {
                Some(r.u32_be()?)
            } else {
                None
            };
            let per = [0x100, 0x200, 0x400, 0x800]
                .iter()
                .filter(|&&f| fl & f != 0)
                .count()
                * 4;
            if n.saturating_mul(per) > r.remaining()
                || out.len().saturating_add(n) as u64 > MAX_SAMPLES
            {
                return Err(r.error("trun sample count exceeds box size"));
            }
            for i in 0..n {
                let duration = if fl & 0x100 != 0 {
                    r.u32_be()?
                } else {
                    d.duration
                };
                let size = if fl & 0x200 != 0 { r.u32_be()? } else { d.size };
                let flags = if fl & 0x400 != 0 {
                    r.u32_be()?
                } else if i == 0 {
                    first_flags.unwrap_or(d.flags)
                } else {
                    d.flags
                };
                let cts = if fl & 0x800 != 0 {
                    let raw = r.u32_be()?;
                    if v == 0 {
                        raw as i64
                    } else {
                        raw as i32 as i64
                    }
                } else {
                    0
                };
                let dts = frag_dts[ti];
                out.push(SampleRef {
                    track: ti,
                    dts: dts.saturating_add(offset),
                    pts: dts.saturating_add(cts).saturating_add(offset),
                    duration,
                    keyframe: flags & NON_SYNC == 0,
                    pos: data_pos,
                    size,
                });
                frag_dts[ti] = dts.saturating_add(duration as i64);
                data_pos = data_pos.saturating_add(size as u64);
            }
        }
        prev_end = data_pos;
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// The demuxer

fn shifted(mut r: SampleRef, offset: i64) -> SampleRef {
    r.dts = r.dts.saturating_add(offset);
    r.pts = r.pts.saturating_add(offset);
    r
}

#[derive(Debug, Clone, Copy)]
struct BoxHeader {
    typ: FourCc,
    start: u64,
    header: u64,
    size: u64,
}

pub struct Demuxer<R> {
    input: BufReader<R>,
    pos: u64,
    len: u64,
    tracks: Vec<Track>,
    fragmented: bool,
    cursors: Vec<Cursor>,
    /// Next top-level box to look at for `moof`s.
    frag_scan: u64,
    /// Where fragments start (just after `moov`).
    frag_start: u64,
    frag_dts: Vec<i64>,
    pending: VecDeque<SampleRef>,
    major_brand: Option<FourCc>,
    /// Per track: what to drop after a [`Demuxer::seek`] (cleared at the
    /// first sample kept).
    skip: Vec<Option<Skip>>,
}

/// Where [`Demuxer::seek`] landed: a sync sample of the chosen track, in
/// its timescale with the edit offset applied (like [`Sample`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SeekPoint {
    pub dts: i64,
    pub pts: i64,
}

/// Samples dropped after a seek.
#[derive(Debug, Clone, Copy)]
enum Skip {
    /// The seek's track: samples decoded before the keyframe.
    Dts(i64),
    /// Other tracks: samples presented before `pts / timescale` seconds.
    Pts { pts: i64, timescale: u32 },
}

/// A sync sample [`Demuxer::seek`] may land on.
struct Candidate {
    place: Place,
    r: SampleRef,
    /// Whether `accept` took its data (read lazily).
    accepted: Option<bool>,
}

#[derive(Debug, Clone, Copy)]
enum Place {
    /// Index in the `moov` sample table.
    Table(u32),
    /// Index in the seek's [`FragMark`]s.
    Frag(usize),
}

/// A `moof` seen by [`Demuxer::seek`]: where to resume reading there.
struct FragMark {
    start: u64,
    /// Every track's next decode time before the `moof`.
    dts: Vec<i64>,
    /// Every track's latest pts in the `moof`.
    max_pts: Vec<Option<i64>>,
}

/// `Demuxer::pos` after reading around the buffer: unknown.
const RAW_POS: u64 = u64::MAX;

impl<R: Read + Seek> Demuxer<R> {
    /// Finds and parses the `moov`. Nothing else is read until
    /// [`Demuxer::next_sample`].
    pub fn new(inner: R) -> Result<Demuxer<R>> {
        let mut input = BufReader::with_capacity(64 * 1024, inner);
        let len = input
            .seek(SeekFrom::End(0))
            .map_err(|e| Error::io("mp4: seek", e))?;
        input
            .seek(SeekFrom::Start(0))
            .map_err(|e| Error::io("mp4: seek", e))?;
        let mut d = Demuxer {
            input,
            pos: 0,
            len,
            tracks: Vec::new(),
            fragmented: false,
            cursors: Vec::new(),
            frag_scan: 0,
            frag_start: 0,
            frag_dts: Vec::new(),
            pending: VecDeque::new(),
            major_brand: None,
            skip: Vec::new(),
        };
        let mut at = 0;
        let mut first = true;
        loop {
            let Some(h) = d.header_at(at, false)? else {
                return Err(Error::malformed("mp4: no moov box"));
            };
            if first {
                // Reject non-MP4 input early instead of scanning garbage.
                let known = [
                    b"ftyp", b"moov", b"mdat", b"free", b"skip", b"wide", b"pnot", b"styp",
                    b"sidx", b"uuid",
                ];
                if !known.contains(&&h.typ) {
                    return Err(Error::malformed(format!(
                        "mp4: unexpected first box {}",
                        fourcc_str(h.typ)
                    )));
                }
                first = false;
            }
            match &h.typ {
                b"ftyp" => {
                    let body = d.read_body(&h, 4096, false)?;
                    if body.len() >= 4 {
                        d.major_brand = Some([body[0], body[1], body[2], body[3]]);
                    }
                }
                b"moov" => {
                    let body = d.read_body(&h, MAX_MOOV_SIZE, false)?;
                    let moov = parse_moov(&body)?;
                    d.tracks = moov.tracks;
                    d.fragmented = moov.fragmented;
                    d.frag_start = h.start + h.size;
                    break;
                }
                _ => {}
            }
            at = h.start + h.size;
        }
        if d.tracks.is_empty() {
            return Err(Error::unsupported("mp4: no audio or video tracks"));
        }
        d.rewind();
        Ok(d)
    }

    pub fn tracks(&self) -> &[Track] {
        &self.tracks
    }

    pub fn track(&self, id: u32) -> Option<&Track> {
        self.tracks.iter().find(|t| t.id == id)
    }

    /// Whether the file has `mvex` (fragmented MP4).
    pub fn is_fragmented(&self) -> bool {
        self.fragmented
    }

    /// The `ftyp` major brand (`isom`, `qt  `, ...).
    pub fn major_brand(&self) -> Option<FourCc> {
        self.major_brand
    }

    /// Starts over from the first sample (for looping).
    pub fn rewind(&mut self) {
        self.cursors = vec![Cursor::default(); self.tracks.len()];
        self.frag_dts = vec![0; self.tracks.len()];
        self.frag_scan = self.frag_start;
        self.pending.clear();
        self.skip = vec![None; self.tracks.len()];
    }

    /// Positions every track near a target time at a sync sample of track
    /// `track_id` (the video), reading no media data on the way.
    ///
    /// - `cmp(pts)` places a pts of that track (its timescale, edit offset
    ///   applied) relative to the target: `Less` is before it.
    /// - `accept(data)` decides whether a sync sample may be landed on
    ///   (H.264: an IDR picture, as `stss` also lists recovery points).
    ///   Only candidates are read, usually one or two samples.
    ///
    /// `forward` lands on the first accepted sync sample at or after the
    /// target, or if there is none on the last one before it; otherwise on
    /// the last one at or before the target, or the first one after it.
    /// Then that track continues at the chosen sample and every other
    /// track at its first sample presented at or after it. `None`: no sync
    /// sample is accepted; the position is unchanged.
    ///
    /// Sample tables are walked in memory. Fragmented files are scanned
    /// `moof` by `moof` from the first one (box headers and `moof`s only,
    /// never `mdat` contents) up to the first accepted sync sample after
    /// the target. Assumes sync samples are presented in decode order.
    pub fn seek(
        &mut self,
        track_id: u32,
        forward: bool,
        cmp: impl Fn(i64) -> Ordering,
        mut accept: impl FnMut(&[u8]) -> bool,
    ) -> Result<Option<SeekPoint>> {
        let Some(vi) = self.tracks.iter().position(|t| t.id == track_id) else {
            return Ok(None);
        };
        let n = self.tracks.len();
        let mut cands: Vec<Candidate> = Vec::new();
        let mut marks: Vec<FragMark> = Vec::new();
        // Collect sync samples in decode order until one after the target
        // is accepted: then both directions have their answer.
        let mut found = false;
        let off = self.tracks[vi].time_offset;
        let mut c = Cursor::default();
        loop {
            let index = c.sample;
            let Some(r) = c.next(&self.tracks[vi].table, vi) else {
                break;
            };
            if !r.keyframe {
                continue;
            }
            let mut cand = Candidate {
                place: Place::Table(index),
                r: shifted(r, off),
                accepted: None,
            };
            found = cmp(cand.r.pts) == Ordering::Greater && self.accepts(&mut cand, &mut accept)?;
            cands.push(cand);
            if found {
                break;
            }
        }
        if self.fragmented && !found {
            let mut dts = vec![0i64; n];
            let mut at = self.frag_start;
            'frags: while let Some(h) = self.header_at(at, true)? {
                at = h.start + h.size;
                if &h.typ != b"moof" {
                    continue;
                }
                let body = self.read_body(&h, MAX_MOOF_SIZE, true)?;
                let before = dts.clone();
                let mut refs = parse_moof(&body, h.start, &self.tracks, &mut dts)?;
                let mut max_pts: Vec<Option<i64>> = vec![None; n];
                for r in &refs {
                    let m = &mut max_pts[r.track];
                    *m = Some(m.map_or(r.pts, |p| p.max(r.pts)));
                }
                let mark = marks.len();
                marks.push(FragMark {
                    start: h.start,
                    dts: before,
                    max_pts,
                });
                refs.retain(|r| r.track == vi && r.keyframe);
                refs.sort_by_key(|r| r.dts);
                for r in refs {
                    let mut cand = Candidate {
                        place: Place::Frag(mark),
                        r,
                        accepted: None,
                    };
                    let done =
                        cmp(r.pts) == Ordering::Greater && self.accepts(&mut cand, &mut accept)?;
                    cands.push(cand);
                    if done {
                        break 'frags;
                    }
                }
            }
        }
        let rel: Vec<Ordering> = cands.iter().map(|c| cmp(c.r.pts)).collect();
        let idx = |keep: &dyn Fn(Ordering) -> bool| -> Vec<usize> {
            (0..cands.len()).filter(|&i| keep(rel[i])).collect()
        };
        let mut order = Vec::with_capacity(cands.len());
        if forward {
            order.extend(idx(&|o| o != Ordering::Less));
            order.extend(idx(&|o| o == Ordering::Less).into_iter().rev());
        } else {
            order.extend(idx(&|o| o != Ordering::Greater).into_iter().rev());
            order.extend(idx(&|o| o == Ordering::Greater));
        }
        let mut chosen = None;
        for i in order {
            if self.accepts(&mut cands[i], &mut accept)? {
                chosen = Some(i);
                break;
            }
        }
        let Some(chosen) = chosen else {
            return Ok(None);
        };
        let (key, place) = (cands[chosen].r, cands[chosen].place);
        let vscale = self.tracks[vi].timescale;
        // Whether `pts` of track `ti` is presented at or after the key.
        let not_before =
            |pts: i64, scale: u32| pts as i128 * vscale as i128 >= key.pts as i128 * scale as i128;
        let mut cursors = Vec::with_capacity(n);
        for (ti, t) in self.tracks.iter().enumerate() {
            let mut c = Cursor::default();
            match place {
                Place::Table(index) if ti == vi => {
                    while c.sample < index && c.next(&t.table, ti).is_some() {}
                }
                Place::Frag(_) if ti == vi => c.done = true,
                _ => loop {
                    let before = c.clone();
                    match c.next(&t.table, ti) {
                        None => break,
                        Some(r) if not_before(r.pts.saturating_add(t.time_offset), t.timescale) => {
                            c = before;
                            break;
                        }
                        Some(_) => {}
                    }
                },
            }
            cursors.push(c);
        }
        match place {
            Place::Table(_) => {
                self.frag_scan = self.frag_start;
                self.frag_dts = vec![0; n];
            }
            Place::Frag(m) => {
                // Resume at the first `moof` with samples to keep: the key's,
                // or an earlier one holding other tracks' later samples.
                let tracks = &self.tracks;
                let restart = (0..m)
                    .find(|&i| {
                        marks[i].max_pts.iter().enumerate().any(|(ti, p)| {
                            ti != vi && p.is_some_and(|p| not_before(p, tracks[ti].timescale))
                        })
                    })
                    .unwrap_or(m);
                self.frag_scan = marks[restart].start;
                self.frag_dts = std::mem::take(&mut marks[restart].dts);
            }
        }
        self.cursors = cursors;
        self.pending.clear();
        self.skip = (0..n)
            .map(|ti| {
                Some(if ti == vi {
                    Skip::Dts(key.dts)
                } else {
                    Skip::Pts {
                        pts: key.pts,
                        timescale: vscale,
                    }
                })
            })
            .collect();
        Ok(Some(SeekPoint {
            dts: key.dts,
            pts: key.pts,
        }))
    }

    /// Whether `accept` takes a candidate's data (read once).
    fn accepts(
        &mut self,
        c: &mut Candidate,
        accept: &mut impl FnMut(&[u8]) -> bool,
    ) -> Result<bool> {
        if let Some(ok) = c.accepted {
            return Ok(ok);
        }
        let r = c.r;
        // A sample past the end (a truncated file) is no place to land.
        let ok = r.size <= MAX_SAMPLE_SIZE
            && r.pos.saturating_add(r.size as u64) <= self.len
            && accept(&self.read_raw(r.pos, r.size as usize)?);
        c.accepted = Some(ok);
        Ok(ok)
    }

    /// The next sample in decode-time order across tracks, or `None` at
    /// the end of the file.
    pub fn next_sample(&mut self) -> Result<Option<Sample>> {
        let Some(r) = self.next_ref()? else {
            return Ok(None);
        };
        if r.size > MAX_SAMPLE_SIZE {
            return Err(Error::malformed(format!(
                "mp4: sample of {} bytes is too large",
                r.size
            )));
        }
        let data = self.read_at(r.pos, r.size as usize)?;
        Ok(Some(Sample {
            track_id: self.tracks[r.track].id,
            dts: r.dts,
            pts: r.pts,
            duration: r.duration,
            keyframe: r.keyframe,
            pos: r.pos,
            data,
        }))
    }

    /// The next sample reference, without what a seek skips.
    fn next_ref(&mut self) -> Result<Option<SampleRef>> {
        loop {
            let Some(r) = self.next_ref_unfiltered()? else {
                return Ok(None);
            };
            let keep = match self.skip.get(r.track).copied().flatten() {
                None => true,
                Some(Skip::Dts(dts)) => r.dts >= dts,
                Some(Skip::Pts { pts, timescale }) => {
                    r.pts as i128 * timescale as i128
                        >= pts as i128 * self.tracks[r.track].timescale as i128
                }
            };
            if keep {
                if let Some(s) = self.skip.get_mut(r.track) {
                    *s = None;
                }
                return Ok(Some(r));
            }
        }
    }

    fn next_ref_unfiltered(&mut self) -> Result<Option<SampleRef>> {
        // Samples of the moov table first: the track whose next sample
        // decodes earliest (in seconds).
        let mut best: Option<(usize, SampleRef)> = None;
        for i in 0..self.tracks.len() {
            let Some(r) = self.peek_table(i) else {
                continue;
            };
            let earlier = best.is_none_or(|(bi, b)| {
                let (ta, tb) = (self.tracks[i].timescale, self.tracks[bi].timescale);
                let (a, b2) = (r.dts as i128 * tb as i128, b.dts as i128 * ta as i128);
                a < b2 || (a == b2 && r.pos < b.pos)
            });
            if earlier {
                best = Some((i, r));
            }
        }
        if let Some((i, _)) = best {
            return Ok(self.take_table(i));
        }
        if !self.fragmented {
            return Ok(None);
        }
        loop {
            if let Some(r) = self.pending.pop_front() {
                return Ok(Some(r));
            }
            if !self.next_fragment()? {
                return Ok(None);
            }
        }
    }

    fn peek_table(&self, i: usize) -> Option<SampleRef> {
        let mut c = self.cursors[i].clone();
        let off = self.tracks[i].time_offset;
        c.next(&self.tracks[i].table, i).map(|r| shifted(r, off))
    }

    /// Takes the next sample (or PCM packet) of track `i`'s table.
    fn take_table(&mut self, i: usize) -> Option<SampleRef> {
        let t = &self.tracks[i].table;
        let c = &mut self.cursors[i];
        let mut r = c.next(t, i)?;
        let mut frames = 1;
        while frames < t.group && c.continues_chunk(t) {
            let mut look = c.clone();
            let Some(n) = look.next(t, i) else { break };
            let size = r.size as u64 + n.size as u64;
            if n.pos != r.pos + r.size as u64 || size > MAX_SAMPLE_SIZE as u64 {
                break;
            }
            *c = look;
            r.size = size as u32;
            r.duration = r.duration.saturating_add(n.duration);
            frames += 1;
        }
        Some(shifted(r, self.tracks[i].time_offset))
    }

    /// Reads the next `moof` into `pending`; `false` at the end.
    fn next_fragment(&mut self) -> Result<bool> {
        loop {
            let Some(h) = self.header_at(self.frag_scan, false)? else {
                return Ok(false);
            };
            self.frag_scan = h.start + h.size;
            if &h.typ != b"moof" {
                continue;
            }
            let body = self.read_body(&h, MAX_MOOF_SIZE, false)?;
            let mut refs = parse_moof(&body, h.start, &self.tracks, &mut self.frag_dts)?;
            let tracks = &self.tracks;
            refs.sort_by(|a, b| {
                let (ta, tb) = (tracks[a.track].timescale, tracks[b.track].timescale);
                (a.dts as i128 * tb as i128)
                    .cmp(&(b.dts as i128 * ta as i128))
                    .then(a.pos.cmp(&b.pos))
            });
            self.pending.extend(refs);
            if !self.pending.is_empty() {
                return Ok(true);
            }
        }
    }

    fn seek_to(&mut self, pos: u64) -> Result<()> {
        if self.pos == RAW_POS {
            // Seeking a BufReader discards its (stale) buffer.
            self.input
                .seek(SeekFrom::Start(pos))
                .map_err(|e| Error::io("mp4: seek", e))?;
            self.pos = pos;
        } else if pos != self.pos {
            let delta = pos as i128 - self.pos as i128;
            match i64::try_from(delta) {
                Ok(d) => self.input.seek_relative(d),
                Err(_) => self.input.seek(SeekFrom::Start(pos)).map(|_| ()),
            }
            .map_err(|e| Error::io("mp4: seek", e))?;
            self.pos = pos;
        }
        Ok(())
    }

    /// Reads `len` bytes at `pos`, bypassing the buffer when `raw` (a seek's
    /// scattered small reads must not each fill 64 KiB of it).
    fn read_any(&mut self, pos: u64, len: usize, raw: bool) -> Result<Vec<u8>> {
        if raw {
            self.read_raw(pos, len)
        } else {
            self.read_at(pos, len)
        }
    }

    fn read_raw(&mut self, pos: u64, len: usize) -> Result<Vec<u8>> {
        if pos.saturating_add(len as u64) > self.len {
            return Err(Error::malformed(format!(
                "mp4: data at {pos}+{len} past the end of the file ({})",
                self.len
            )));
        }
        // The buffer no longer matches the inner position.
        self.pos = RAW_POS;
        let inner = self.input.get_mut();
        inner
            .seek(SeekFrom::Start(pos))
            .map_err(|e| Error::io("mp4: seek", e))?;
        let mut buf = vec![0u8; len];
        inner.read_exact(&mut buf).map_err(|e| {
            if e.kind() == io::ErrorKind::UnexpectedEof {
                Error::malformed("mp4: truncated file")
            } else {
                Error::io("mp4: read", e)
            }
        })?;
        Ok(buf)
    }

    fn read_at(&mut self, pos: u64, len: usize) -> Result<Vec<u8>> {
        if pos.saturating_add(len as u64) > self.len {
            return Err(Error::malformed(format!(
                "mp4: data at {pos}+{len} past the end of the file ({})",
                self.len
            )));
        }
        self.seek_to(pos)?;
        let mut buf = vec![0u8; len];
        self.input.read_exact(&mut buf).map_err(|e| {
            if e.kind() == io::ErrorKind::UnexpectedEof {
                Error::malformed("mp4: truncated file")
            } else {
                Error::io("mp4: read", e)
            }
        })?;
        self.pos += len as u64;
        Ok(buf)
    }

    /// The box header at `pos`; `None` at (or within 8 bytes of) the end.
    fn header_at(&mut self, pos: u64, raw: bool) -> Result<Option<BoxHeader>> {
        if pos.saturating_add(8) > self.len {
            return Ok(None);
        }
        let head = self.read_any(pos, 8, raw)?;
        let size32 = u32::from_be_bytes([head[0], head[1], head[2], head[3]]);
        let typ = [head[4], head[5], head[6], head[7]];
        let (size, header) = match size32 {
            0 => (self.len - pos, 8),
            1 => {
                if pos + 16 > self.len {
                    return Err(Error::malformed("mp4: truncated box header"));
                }
                let b = self.read_any(pos + 8, 8, raw)?;
                let mut a = [0u8; 8];
                a.copy_from_slice(&b);
                (u64::from_be_bytes(a), 16)
            }
            n => (n as u64, 8),
        };
        if size < header {
            return Err(Error::malformed(format!(
                "mp4: box {} at {pos} smaller than its header",
                fourcc_str(typ)
            )));
        }
        if pos.saturating_add(size) > self.len {
            // A truncated last box (an interrupted recording): read what is
            // there for mdat, fail for boxes we need whole.
            if &typ != b"mdat" {
                return Err(Error::malformed(format!(
                    "mp4: box {} at {pos} runs past the end of the file",
                    fourcc_str(typ)
                )));
            }
            return Ok(Some(BoxHeader {
                typ,
                start: pos,
                header,
                size: self.len - pos,
            }));
        }
        Ok(Some(BoxHeader {
            typ,
            start: pos,
            header,
            size,
        }))
    }

    fn read_body(&mut self, h: &BoxHeader, limit: u64, raw: bool) -> Result<Vec<u8>> {
        let n = h.size - h.header;
        if n > limit {
            return Err(Error::unsupported(format!(
                "mp4: {} box of {n} bytes is too large",
                fourcc_str(h.typ)
            )));
        }
        self.read_any(h.start + h.header, n as usize, raw)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::util::vectors;
    use std::io::Cursor as IoCursor;

    struct Expected {
        streams: Vec<Vec<String>>,
        /// Per ffprobe stream index: "pts dts duration flag size".
        packets: Vec<Vec<String>>,
    }

    fn expected(name: &str) -> (String, Expected) {
        let blocks = vectors::load(&format!("mp4/{name}.txt"));
        let b = &blocks[0];
        let streams: Vec<Vec<String>> = b
            .str("streams")
            .split(';')
            .filter(|s| !s.is_empty())
            .map(|s| s.split(',').map(str::to_owned).collect())
            .collect();
        let mut packets = vec![Vec::new(); streams.len()];
        for p in b.str("packets").split(';').filter(|p| !p.is_empty()) {
            let f: Vec<&str> = p.split(' ').collect();
            let idx: usize = f[0].parse().unwrap();
            packets[idx].push(f[1..].join(" "));
        }
        (b.str("file").to_owned(), Expected { streams, packets })
    }

    fn check(name: &str) -> Demuxer<IoCursor<Vec<u8>>> {
        let (file, exp) = expected(name);
        let data = vectors::fixture(&format!("media/{file}"));
        let mut d = Demuxer::new(IoCursor::new(data)).unwrap();
        assert_eq!(d.tracks().len(), exp.streams.len(), "{name}: tracks");
        for (t, s) in d.tracks().iter().zip(&exp.streams) {
            let tb = s.last().unwrap();
            assert_eq!(tb, &format!("1/{}", t.timescale), "{name}: time base");
            match t.track_type {
                TrackType::Video => {
                    assert_eq!(s[2], t.width.to_string(), "{name}: width");
                    assert_eq!(s[3], t.height.to_string(), "{name}: height");
                }
                TrackType::Audio => {
                    assert_eq!(s[2], t.sample_rate.to_string(), "{name}: rate");
                    assert_eq!(s[3], t.channels.to_string(), "{name}: channels");
                }
                TrackType::Other(_) => panic!("unexpected track"),
            }
        }
        let ids: Vec<u32> = d.tracks().iter().map(|t| t.id).collect();
        let mut got = vec![Vec::new(); ids.len()];
        let mut last_dts = vec![i64::MIN; ids.len()];
        while let Some(s) = d.next_sample().unwrap() {
            let i = ids.iter().position(|&id| id == s.track_id).unwrap();
            assert!(s.dts > last_dts[i], "{name}: dts not increasing");
            last_dts[i] = s.dts;
            got[i].push(format!(
                "{} {} {} {} {}",
                s.pts,
                s.dts,
                s.duration,
                if s.keyframe { "K" } else { "_" },
                s.data.len()
            ));
        }
        for (i, (g, e)) in got.iter().zip(&exp.packets).enumerate() {
            assert_eq!(g.len(), e.len(), "{name}: stream {i} packet count");
            for (k, (g, e)) in g.iter().zip(e).enumerate() {
                assert_eq!(g, e, "{name}: stream {i} packet {k}");
            }
        }
        d
    }

    #[test]
    fn progressive_no_bframes() {
        let d = check("bf0");
        let v = &d.tracks()[0];
        assert!(matches!(v.codec, Codec::Avc { avcc: Some(_) }));
        assert!(!v.reorders);
        assert!(!d.is_fragmented());
        assert!(v.matrix_is_identity());
        assert_eq!(v.media_edits(), 1);
        let a = &d.tracks()[1];
        let Codec::Aac { asc } = &a.codec else {
            panic!("{:?}", a.codec)
        };
        assert_eq!(asc[0] >> 3, 2, "AAC-LC");
    }

    #[test]
    fn rotated_track() {
        let tmp = std::env::temp_dir().join(format!("tvpipe-mp4-rot-{}.mp4", std::process::id()));
        let ok = std::process::Command::new("ffmpeg")
            .args([
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-display_rotation",
                "90",
                "-i",
            ])
            .arg(vectors::path("tests/fixtures/media/bf0.mp4"))
            .args(["-c", "copy"])
            .arg(&tmp)
            .status()
            .is_ok_and(|s| s.success());
        if !ok {
            return;
        }
        let d = Demuxer::new(std::fs::File::open(&tmp).unwrap()).unwrap();
        let _ = std::fs::remove_file(&tmp);
        assert!(!d.tracks()[0].matrix_is_identity());
        assert!(d.tracks()[1].matrix_is_identity());
    }

    #[test]
    fn bframes_faststart() {
        let d = check("bframes");
        assert!(d.tracks()[0].reorders);
        assert_eq!(d.tracks()[0].time_offset, -1024);
        assert!(!d.tracks()[1].reorders);
    }

    #[test]
    fn fragmented_opus() {
        let d = check("frag");
        assert!(d.is_fragmented());
        let Codec::Opus { head } = &d.tracks()[1].codec else {
            panic!()
        };
        assert!(head.starts_with(b"OpusHead\x01\x02"));
        assert_eq!(head.len(), 19);
        assert_eq!(u16::from_le_bytes([head[10], head[11]]), 312);
    }

    #[test]
    fn quicktime_alac() {
        let d = check("alac");
        assert_eq!(d.major_brand(), Some(*b"qt  "));
        let Codec::Alac { config } = &d.tracks()[1].codec else {
            panic!()
        };
        assert_eq!(config.len(), 24);
        assert_eq!(
            u32::from_be_bytes([config[0], config[1], config[2], config[3]]),
            4096
        );
    }

    #[test]
    fn quicktime_pcm() {
        let d = check("pcm");
        assert_eq!(
            d.tracks()[1].codec,
            Codec::Pcm {
                bits: 16,
                big_endian: false,
                float: false
            }
        );
    }

    #[test]
    fn hevc() {
        let d = check("hevc");
        assert!(matches!(&d.tracks()[0].codec, Codec::Hevc { hvcc } if hvcc[0] == 1));
    }

    #[test]
    fn rewind_repeats() {
        let data = vectors::fixture("media/frag.mp4");
        let mut d = Demuxer::new(IoCursor::new(data)).unwrap();
        let mut first = Vec::new();
        while let Some(s) = d.next_sample().unwrap() {
            first.push(s);
        }
        d.rewind();
        let mut second = Vec::new();
        while let Some(s) = d.next_sample().unwrap() {
            second.push(s);
        }
        assert_eq!(first, second);
    }

    #[test]
    fn edit_offsets() {
        let e = |duration, media_time| Edit {
            duration,
            media_time,
            rate: 1 << 16,
        };
        assert_eq!(edit_offset(&[], 1000, 90_000), 0);
        assert_eq!(edit_offset(&[e(1000, 1024)], 1000, 48_000), -1024);
        // 100 ms empty edit at movie timescale 1000, then media from 0.
        assert_eq!(edit_offset(&[e(100, -1), e(900, 0)], 1000, 90_000), 9000);
    }

    #[test]
    fn opus_head_from_dops() {
        let dops = [0, 2, 0x01, 0x38, 0, 0, 0xbb, 0x80, 0xff, 0xfe, 0];
        let head = dops_to_opus_head(&dops).unwrap();
        assert_eq!(
            head,
            [
                b'O', b'p', b'u', b's', b'H', b'e', b'a', b'd', 1, 2, 0x38, 0x01, 0x80, 0xbb, 0, 0,
                0xfe, 0xff, 0
            ]
        );
        assert!(dops_to_opus_head(&[1, 2]).is_err());
        assert!(dops_to_opus_head(&[0, 2, 0, 0, 0, 0, 0xbb, 0x80, 0, 0, 1, 1]).is_err());
    }

    /// `size | type | body`.
    fn bx(typ: &[u8; 4], parts: &[&[u8]]) -> Vec<u8> {
        let len: usize = parts.iter().map(|p| p.len()).sum();
        let mut out = ((len + 8) as u32).to_be_bytes().to_vec();
        out.extend_from_slice(typ);
        for p in parts {
            out.extend_from_slice(p);
        }
        out
    }

    fn be(vals: &[u32]) -> Vec<u8> {
        vals.iter().flat_map(|v| v.to_be_bytes()).collect()
    }

    /// A sample of the long file: an AVCC NAL of type 5 (IDR) or 1.
    fn long_sample(i: u32) -> [u8; 6] {
        [0, 0, 0, 2, if i % 60 == 0 { 0x65 } else { 0x41 }, 0x88]
    }

    /// A long progressive MP4: `n` video samples (track 1, 90 kHz, 3000
    /// per frame, 6 bytes each) in one chunk, a sync sample every 30, of
    /// which only every other is an IDR picture ([`long_sample`]), and an
    /// audio track (2, 48 kHz, 1024 per packet, 4 bytes) in a second chunk.
    fn long_mp4(n: u32) -> Vec<u8> {
        let audio_n = (n as u64 * 3000 * 48_000 / 90_000 / 1024) as u32;
        let ftyp = bx(b"ftyp", &[b"isom", &be(&[0x200]), b"isom"]);
        #[allow(clippy::too_many_arguments)]
        fn trak(
            id: u32,
            handler: &[u8; 4],
            scale: u32,
            count: u32,
            delta: u32,
            size: u32,
            entry: &[u8],
            stss: &[u8],
            offset: u32,
        ) -> Vec<u8> {
            let mut tkhd = be(&[0, 0, 0, id, 0, 0]);
            tkhd.extend([0; 16]);
            tkhd.extend(be(&[0x1_0000, 0, 0, 0, 0x1_0000, 0, 0, 0, 0x4000_0000]));
            let mdhd = be(&[0, 0, 0, scale, count * delta]);
            let mut hdlr = be(&[0, 0]);
            hdlr.extend_from_slice(handler);
            let stbl = bx(
                b"stbl",
                &[
                    &bx(b"stsd", &[&be(&[0, 1]), entry]),
                    &bx(b"stts", &[&be(&[0, 1, count, delta])]),
                    stss,
                    &bx(b"stsz", &[&be(&[0, size, count])]),
                    &bx(b"stsc", &[&be(&[0, 1, 1, count, 1])]),
                    &bx(b"stco", &[&be(&[0, 1, offset])]),
                ],
            );
            let mdia = bx(
                b"mdia",
                &[
                    &bx(b"mdhd", &[&mdhd]),
                    &bx(b"hdlr", &[&hdlr]),
                    &bx(b"minf", &[&stbl]),
                ],
            );
            bx(b"trak", &[&bx(b"tkhd", &[&tkhd]), &mdia])
        }
        let avc1 = bx(b"avc1", &[&[0; 24], &[0, 160, 0, 120], &[0; 50]]);
        let mp4a = bx(
            b"mp4a",
            &[
                &[0; 16],
                &[0, 2, 0, 16],
                &[0; 4],
                &(48_000u32 << 16).to_be_bytes(),
            ],
        );
        let syncs: Vec<u32> = (0..n).step_by(30).map(|i| i + 1).collect();
        let mut stss = be(&[0, syncs.len() as u32]);
        stss.extend(be(&syncs));
        let stss = bx(b"stss", &[&stss]);
        let moov = |video_at: u32| {
            let audio_at = video_at + 6 * n;
            let mvhd = be(&[0, 0, 0, 1000, n / 30 * 1000]);
            bx(
                b"moov",
                &[
                    &bx(b"mvhd", &[&mvhd]),
                    &trak(1, b"vide", 90_000, n, 3000, 6, &avc1, &stss, video_at),
                    &trak(2, b"soun", 48_000, audio_n, 1024, 4, &mp4a, &[], audio_at),
                ],
            )
        };
        let video_at = (ftyp.len() + moov(0).len() + 8) as u32;
        let mut data: Vec<u8> = (0..n).flat_map(long_sample).collect();
        data.extend((0..audio_n).flat_map(|_| [1, 2, 3, 4]));
        [ftyp, moov(video_at), bx(b"mdat", &[&data])].concat()
    }

    /// Counts the bytes read from the file.
    struct Counting {
        inner: IoCursor<Vec<u8>>,
        read: std::rc::Rc<std::cell::Cell<u64>>,
    }

    impl Read for Counting {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            let n = self.inner.read(buf)?;
            self.read.set(self.read.get() + n as u64);
            Ok(n)
        }
    }

    impl Seek for Counting {
        fn seek(&mut self, pos: SeekFrom) -> io::Result<u64> {
            self.inner.seek(pos)
        }
    }

    /// Seeking an hour of samples walks the tables and reads only the
    /// candidates; sync samples that are no IDR pictures are passed over.
    #[test]
    fn seek_long_table_reads_only_candidates() {
        let n = 108_000;
        let read = std::rc::Rc::new(std::cell::Cell::new(0));
        let file = Counting {
            inner: IoCursor::new(long_mp4(n)),
            read: read.clone(),
        };
        let mut d = Demuxer::new(file).unwrap();
        assert_eq!(d.tracks()[0].sample_count, n as u64);
        let idr = |data: &[u8]| data.get(4).is_some_and(|b| b & 0x1f == 5);
        let at = |i: i64| move |pts: i64| pts.cmp(&(i * 3000));
        let seek = |d: &mut Demuxer<Counting>, i: i64, forward: bool| {
            let before = read.get();
            let p = d.seek(1, forward, at(i), idr).unwrap();
            // A few 6-byte samples, nothing in between.
            assert!(
                read.get() - before <= 4 * 6,
                "{} bytes",
                read.get() - before
            );
            p.map(|p| {
                assert_eq!(p.dts, p.pts);
                p.pts / 3000
            })
        };
        // 50_010 is a sync sample but no IDR.
        assert_eq!(seek(&mut d, 50_005, true), Some(50_040));
        let mut video = Vec::new();
        let mut audio = Vec::new();
        for _ in 0..40 {
            let s = d.next_sample().unwrap().unwrap();
            if s.track_id == 1 {
                video.push(s);
            } else {
                audio.push(s);
            }
        }
        assert_eq!(video[0].pts, 50_040 * 3000);
        assert_eq!(video[0].data, long_sample(0));
        assert!(video.windows(2).all(|w| w[1].pts == w[0].pts + 3000));
        // Audio from the first packet presented at or after the keyframe.
        let key = 50_040 * 3000 * 48_000i64;
        assert!(audio[0].pts * 90_000 >= key);
        assert!((audio[0].pts - 1024) * 90_000 < key);
        assert!(audio.windows(2).all(|w| w[1].pts == w[0].pts + 1024));
        // Backwards past the non-IDR sync sample at 50_010.
        assert_eq!(seek(&mut d, 50_035, false), Some(49_980));
        assert_eq!(seek(&mut d, 50_040, false), Some(50_040));
        assert_eq!(seek(&mut d, 50_040, true), Some(50_040));
        assert_eq!(seek(&mut d, -5, false), Some(0));
        assert_eq!(seek(&mut d, 0, false), Some(0));
        // Past the end: the last IDR either way.
        assert_eq!(seek(&mut d, 1 << 40, true), Some(107_940));
        assert_eq!(seek(&mut d, 1 << 40, false), Some(107_940));
        // After the end.
        while d.next_sample().unwrap().is_some() {}
        assert_eq!(seek(&mut d, 30, false), Some(0));
        assert_eq!(d.next_sample().unwrap().unwrap().pts, 0);
        // Nothing to land on: the position is unchanged.
        let next = d.next_sample().unwrap().unwrap();
        assert!(d.seek(1, true, at(1000), |_| false).unwrap().is_none());
        let after = d.next_sample().unwrap().unwrap();
        assert!(after.dts >= next.dts && after.pos != next.pos);
        assert!(d.seek(7, true, at(1000), idr).unwrap().is_none());
    }

    /// Fragments: the moofs are scanned, never the mdat; the samples after
    /// the seek are those of a full pass from the keyframe on.
    #[test]
    fn seek_fragments() {
        let data = vectors::fixture("media/frag.mp4");
        let mut d = Demuxer::new(IoCursor::new(data)).unwrap();
        let mut all = Vec::new();
        while let Some(s) = d.next_sample().unwrap() {
            all.push(s);
        }
        let keys: Vec<i64> = all
            .iter()
            .filter(|s| s.track_id == 1 && s.keyframe)
            .map(|s| s.pts)
            .collect();
        assert_eq!(keys, [0, 7780]);
        for (target, forward, want) in [(4000, true, 7780), (4000, false, 0), (7780, false, 7780)] {
            let p = d
                .seek(1, forward, |pts| pts.cmp(&target), |_| true)
                .unwrap()
                .unwrap();
            assert_eq!(p.pts, want);
            let mut rest = Vec::new();
            while let Some(s) = d.next_sample().unwrap() {
                rest.push(s);
            }
            let audio_scale = d.tracks()[1].timescale as i64;
            let kept: Vec<&Sample> = all
                .iter()
                .filter(|s| {
                    if s.track_id == 1 {
                        s.dts >= p.dts
                    } else {
                        s.pts * 15_360 >= want * audio_scale
                    }
                })
                .collect();
            assert_eq!(rest.iter().collect::<Vec<_>>(), kept);
        }
    }

    /// Every truncation and many byte flips: errors or samples, no panics.
    #[test]
    fn hostile_input_never_panics() {
        for name in ["bf0.mp4", "frag.mp4", "alac.mov"] {
            let data = vectors::fixture(&format!("media/{name}"));
            let run = |bytes: Vec<u8>| {
                if let Ok(mut d) = Demuxer::new(IoCursor::new(bytes)) {
                    for _ in 0..4000 {
                        if !matches!(d.next_sample(), Ok(Some(_))) {
                            break;
                        }
                    }
                    let id = d.tracks()[0].id;
                    for (target, forward) in [(0, false), (1000, true), (i64::MAX, true)] {
                        if let Ok(Some(_)) = d.seek(id, forward, |p| p.cmp(&target), |_| true) {
                            let _ = d.next_sample();
                        }
                    }
                }
            };
            // Truncations near the boxes we parse.
            let step = (data.len() / 300).max(1);
            for n in (0..data.len()).step_by(step) {
                run(data[..n].to_vec());
            }
            // Flip bytes inside moov / moof (where the parsing happens).
            let moov = data
                .windows(4)
                .position(|w| w == b"moov")
                .unwrap()
                .saturating_sub(4);
            for i in (moov..data.len().min(moov + 2500)).step_by(3) {
                let mut bad = data.clone();
                bad[i] ^= 0xa5;
                run(bad.clone());
                bad[i] = 0xff;
                run(bad);
            }
        }
        assert!(Demuxer::new(IoCursor::new(b"not an mp4 file".to_vec())).is_err());
        assert!(Demuxer::new(IoCursor::new(Vec::new())).is_err());
        // Huge counts in a tiny box.
        let mut stsz = vec![0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, 0xff, 0xff];
        stsz.extend([0; 8]);
        let mut r = Reader::new(&stsz[8..], "t");
        assert!(count(&mut r, 4).is_err());
    }
}
