//! Skip frames: H.264 pictures that repeat the last decoded picture, for
//! pausing a file that is sent unchanged (passthrough). Their parameter
//! sets are the file's own, so they cannot carry a new picture. They have
//! to be coded against the file's state.
//!
//! A skip frame is one P slice whose every macroblock is P_Skip. With no
//! neighbours to predict from (the first macroblock) or with neighbours
//! that are P_Skip with refIdxL0 0 and a zero vector, the predicted vector
//! is zero (§8.4.1.1), so every macroblock copies RefPicList0\[0\]. That is
//! the last *reference* picture. Inter edges with the same reference, equal
//! vectors and no coefficients have bS 0, so deblocking changes nothing
//! (§8.7.2.1). Weighted prediction with all flags 0 uses the default
//! weights 2^logWD, which is the identity (§8.4.2.3).
//!
//! The skip frames leave the decoder's state as it was, so the file's next
//! frame decodes as if they had never been sent:
//!
//! - They are **non-reference** pictures (nal_ref_idc 0, nal_unit_type 1):
//!   the DPB, PrevRefFrameNum and the POC state of type 0 (both from the
//!   previous *reference* picture) do not change (§8.2.1, §8.2.5).
//! - frame_num is (PrevRefFrameNum + 1) % MaxFrameNum (§7.4.3: a non-IDR
//!   picture whose frame_num is not PrevRefFrameNum must use that one).
//!   Non-reference pictures in a row may share it. The file's next frame
//!   carries the same value or a later one. FrameNumOffset (POC types 1
//!   and 2, from the previous picture in decoding order) therefore counts
//!   the same wraps of frame_num with or without the skip frames.
//! - One reference index: RefPicList0\[0\] in its initial order is the short
//!   term picture with the highest PicNum. The last reference picture has
//!   PicNum CurrPicNum − 1, so it is first (§8.2.4.2.1). When it was
//!   marked long term (IDR long_term_reference_flag, MMCO 6), a
//!   ref_pic_list_modification with modification_of_pic_nums_idc 2 moves it
//!   to the front (§8.2.4.3.2).
//!
//! **POC.** Skip frames should come after the last picture and before the
//! next one in output order. The file's next POC is not known, and integers
//! between two neighbours run out after one value. So every skip frame
//! takes one POC: the last one + 1 when the stream was seen to step by 2 or
//! more (x264), otherwise the last one again (VideoToolbox steps by 1). A
//! copy then ties only with the picture it copies or with other copies, so
//! a decoder that orders ties either way shows the same images. (ffmpeg
//! tolerates ties; a POC past the next picture's makes it drop frames.) With type 0 that POC is coded in
//! pic_order_cnt_lsb (§8.2.1.1). Type 1 codes it in delta_pic_order_cnt\[0\]
//! unless delta_pic_order_always_zero_flag is set; then the formula of
//! §8.2.1.2 decides (with offset_for_non_ref_pic). Type 2 has nothing to
//! choose: a non-reference picture gets 2·(FrameNumOffset + frame_num) − 1
//! (§8.2.1.3), which is the last POC + 1 (x264 `-bf 0` and our own
//! encoder). Type 2 forbids two non-reference pictures in a row
//! (§7.4.2.1.1), a rule that keeps POCs unique. Every pause longer than one
//! skip frame breaks it. The decoders tested (ffmpeg) output in decoding
//! order, as type 2 implies.
//!
//! Only the last picture can be repeated, and only when it was a reference
//! picture: P_Skip cannot point at a non-reference picture. VideoToolbox
//! alternates reference and non-reference P frames;
//! [`SkipFrames::waits_for_reference`] tells a caller that pausing one
//! frame later will work.
//!
//! **Slice data.** With CAVLC: mb_skip_run = PicSizeInMbs (§7.3.4). With
//! CABAC: cabac_alignment_one_bit, then per macroblock mb_skip_flag 1
//! (ctxIdx 11: neighbours that are skipped give ctxIdxInc 0, §9.3.3.1.1.1)
//! and end_of_slice_flag. Both are written with the arithmetic encoder of
//! §9.3.4, with context init from Table 9-13 and §9.3.1.1, and Tables
//! 9-44/9-45. SliceQPY 51 with cabac_init_idc 2 starts the context at
//! pStateIdx 44 with skip as the most probable symbol, so a 1080p frame
//! takes a few dozen bytes.
//!
//! **Not supported** (`new` refuses, or [`SkipFrames::frame`] says `None`):
//! field and MBAFF coding (frame_mbs_only_flag 0), separate colour planes,
//! a PPS with slice groups (FMO) when no other PPS fits, data partitioning,
//! SVC/MVC NAL units, streams before their first IDR, and a last picture
//! that was no reference picture.
//!
//! Sources: ITU-T H.264 (08/2021) §7.3.2.1.1 (SPS), §7.3.2.2 (PPS), §7.3.3
//! (slice header), §7.3.4 (slice data), §7.4.3 (frame_num), §8.2.1 (POC),
//! §8.2.4 (reference lists), §8.2.5 (reference marking), §8.4.1.1 (P_Skip),
//! §9.3 (CABAC).

use crate::error::{Error, Result};
use crate::media::h264::{avcc_nals, nal_type, unescape_rbsp, AvcConfig};

/// SliceQPY of CABAC skip frames (any value works; this one starts the
/// skip context far in the most-probable state).
const CABAC_QP: i32 = 51;
const CABAC_INIT_IDC: u32 = 2;

/// Pictures larger than this are refused (level 6.2 allows 139 264
/// macroblocks).
const MAX_PIC_SIZE_IN_MBS: u32 = 1 << 20;

/// Makes skip frames for one H.264 stream. Feed it every access unit sent,
/// in decoding order, with [`observe`](SkipFrames::observe) (never the skip
/// frames themselves).
#[derive(Debug, Clone)]
pub struct SkipFrames {
    sps: Vec<Option<Sps>>,
    pps: Vec<Option<Pps>>,
    /// The decoder's state after the last access unit; `None` before the
    /// first IDR and after anything it could not follow.
    state: Option<State>,
    /// Set for good: the stream has SVC or MVC NAL units.
    blocked: bool,
}

/// What `frame` can do now.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Last {
    /// The last picture was a reference picture, marked short term or
    /// (`Some`) long term with this LongTermFrameIdx.
    Reference(Option<u32>),
    /// The last picture was no reference picture.
    NonReference,
    /// The last picture cannot be repeated (its marking removed it).
    Unusable,
}

#[derive(Debug, Clone)]
struct State {
    sps_id: u32,
    /// The active SPS, as it was when the stream's last IDR activated it.
    sps: Sps,
    pps_id: u32,
    prev_ref_frame_num: u32,
    poc: PocState,
    /// The last picture's POC (Min(TopFieldOrderCnt, BottomFieldOrderCnt),
    /// after MMCO 5).
    last_poc: i64,
    /// The last POC step between two pictures of one sequence (no IDR or
    /// MMCO 5 between them).
    step: Option<i64>,
    last: Last,
}

/// POC derivation state (§8.2.1).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct PocState {
    /// Type 0: prevPicOrderCntMsb and prevPicOrderCntLsb (of the previous
    /// reference picture, after MMCO 5).
    prev_msb: i64,
    prev_lsb: i64,
    /// Types 1 and 2: frame_num and FrameNumOffset of the previous picture.
    prev_frame_num: u32,
    prev_frame_num_offset: i64,
}

impl SkipFrames {
    /// From the stream's `avcC` record (every SPS and PPS). Fails with
    /// `unsupported` when no skip frame could be made for this stream, and
    /// with `malformed` for a record that does not parse.
    pub fn new(avcc: &[u8]) -> Result<SkipFrames> {
        let cfg = AvcConfig::parse(avcc)?;
        let mut s = SkipFrames {
            sps: vec![None; 32],
            pps: vec![None; 256],
            state: None,
            blocked: false,
        };
        for nal in cfg.sps.iter().chain(&cfg.pps) {
            s.parameter_set(nal)?;
        }
        let mut usable = false;
        let mut why = "h264 skip: no SPS and PPS";
        for pps in s.pps.iter().flatten() {
            match s.sps.get(pps.sps_id as usize).and_then(|s| s.as_ref()) {
                None => why = "h264 skip: PPS refers to a missing SPS",
                Some(sps) => match sps.unsupported.or(pps.unsupported) {
                    Some(reason) => why = reason,
                    None => usable = true,
                },
            }
        }
        if !usable {
            return Err(Error::unsupported(why));
        }
        Ok(s)
    }

    /// Follows one access unit (AVCC with 4-byte lengths), as sent, in
    /// decoding order. Fails only on malformed data, after which nothing
    /// is repeated until the next IDR.
    pub fn observe(&mut self, au: &[u8]) -> Result<()> {
        let rv = self.observe_inner(au);
        if rv.is_err() {
            self.state = None;
        }
        rv
    }

    fn observe_inner(&mut self, au: &[u8]) -> Result<()> {
        let mut seen_slice = false;
        for nal in avcc_nals(au, 4) {
            let nal = nal?;
            let Some(&b0) = nal.first() else {
                return Err(Error::malformed("h264 skip: empty NAL unit"));
            };
            if b0 & 0x80 != 0 {
                return Err(Error::malformed("h264 skip: forbidden_zero_bit set"));
            }
            match b0 & 0x1f {
                nal_type::SPS | nal_type::PPS => self.parameter_set(nal)?,
                nal_type::NON_IDR | nal_type::IDR if !seen_slice => {
                    seen_slice = true;
                    self.picture(nal)?;
                }
                // Data partitioning (Extended profile): not followed.
                2..=4 if !seen_slice => {
                    seen_slice = true;
                    self.state = None;
                }
                // SVC / MVC / 3D-AVC slices: the other layers would miss
                // their pictures.
                20 | 21 => {
                    self.blocked = true;
                    self.state = None;
                }
                _ => {}
            }
        }
        Ok(())
    }

    /// Whether [`frame`](SkipFrames::frame) is `None` only because the
    /// last picture was no reference picture: after the next reference
    /// picture it will work.
    pub fn waits_for_reference(&self) -> bool {
        !self.blocked
            && self
                .state
                .as_ref()
                .is_some_and(|st| st.last == Last::NonReference)
    }

    /// An access unit (AVCC, 4-byte lengths) that repeats the last decoded
    /// picture, or `None` when it cannot. The same access unit may be sent
    /// any number of times in a row.
    pub fn frame(&self) -> Option<Vec<u8>> {
        self.frame_with(CABAC_QP, CABAC_INIT_IDC)
    }

    fn frame_with(&self, cabac_qp: i32, cabac_init_idc: u32) -> Option<Vec<u8>> {
        if self.blocked {
            return None;
        }
        let st = self.state.as_ref()?;
        let Last::Reference(long_term) = st.last else {
            return None;
        };
        // The SPS cannot change without an IDR; a stream that changes it
        // anyway is not followed.
        let sps = self.sps.get(st.sps_id as usize)?.as_ref()?;
        if *sps != st.sps || sps.unsupported.is_some() {
            return None;
        }
        let (pps_id, pps) = self.pps_for(st)?;
        let frame_num = (st.prev_ref_frame_num + 1) % (1 << sps.log2_max_frame_num);
        let poc = skip_poc(sps, st, frame_num)?;
        let rbsp = write_skip_slice(&SkipSlice {
            sps,
            pps,
            pps_id,
            frame_num,
            poc,
            long_term,
            cabac_qp,
            cabac_init_idc,
        });
        let mut out = Vec::with_capacity(rbsp.len() + 8);
        put_nal_avcc(&mut out, 0, nal_type::NON_IDR, &rbsp);
        Some(out)
    }

    /// The PPS for skip frames: the last picture's, or else another one of
    /// the same SPS that has no slice groups.
    fn pps_for(&self, st: &State) -> Option<(u32, &Pps)> {
        let fits = |p: &Pps| p.sps_id == st.sps_id && p.unsupported.is_none();
        if let Some(p) = self.pps[st.pps_id as usize].as_ref().filter(|p| fits(p)) {
            return Some((st.pps_id, p));
        }
        self.pps
            .iter()
            .enumerate()
            .find_map(|(id, p)| p.as_ref().filter(|p| fits(p)).map(|p| (id as u32, p)))
    }

    fn parameter_set(&mut self, nal: &[u8]) -> Result<()> {
        match nal.first().map(|b| b & 0x1f) {
            Some(nal_type::SPS) => {
                let sps = parse_sps(nal)?;
                let id = sps.id as usize;
                self.sps[id] = Some(sps);
            }
            Some(nal_type::PPS) => {
                let pps = parse_pps(nal)?;
                let id = pps.id as usize;
                self.pps[id] = Some(pps);
            }
            _ => return Err(Error::malformed("h264 skip: not a parameter set")),
        }
        Ok(())
    }

    /// Follows the picture whose first slice is `nal`.
    fn picture(&mut self, nal: &[u8]) -> Result<()> {
        let nal_ref_idc = (nal[0] >> 5) & 3;
        let idr = nal[0] & 0x1f == nal_type::IDR;
        if idr && nal_ref_idc == 0 {
            return Err(Error::malformed("h264 skip: IDR with nal_ref_idc 0"));
        }
        let rbsp = unescape_rbsp(&nal[1..]);
        let mut br = BitReader::new(&rbsp);
        let _first_mb_in_slice = br.ue()?;
        let slice_type = br.ue()?;
        if slice_type > 9 {
            return Err(Error::malformed("h264 skip: slice_type out of range"));
        }
        let pps_id = br.ue()?;
        let pps = self
            .pps
            .get(pps_id as usize)
            .and_then(|p| p.as_ref())
            .ok_or_else(|| Error::malformed("h264 skip: slice refers to a missing PPS"))?;
        let sps = self
            .sps
            .get(pps.sps_id as usize)
            .and_then(|s| s.as_ref())
            .ok_or_else(|| Error::malformed("h264 skip: PPS refers to a missing SPS"))?;
        if sps.unsupported.is_some() {
            // Field coding or colour planes: the slice header differs and
            // nothing is repeated until an IDR of a supported SPS.
            self.state = None;
            return Ok(());
        }
        let hdr = parse_slice_header(&mut br, sps, pps, slice_type % 5, nal_ref_idc, idr)?;
        // The step of the previous sequence is the best guess after an IDR.
        let step = self.state.as_ref().and_then(|st| st.step);
        let mut st = match (idr, self.state.take()) {
            (true, _) => State {
                sps_id: pps.sps_id,
                sps: sps.clone(),
                pps_id,
                prev_ref_frame_num: 0,
                poc: PocState {
                    prev_msb: 0,
                    prev_lsb: 0,
                    prev_frame_num: 0,
                    prev_frame_num_offset: 0,
                },
                last_poc: 0,
                step,
                last: Last::Unusable,
            },
            (false, Some(st)) if st.sps_id == pps.sps_id && st.sps == *sps => st,
            // Before the first IDR, or a new SPS without an IDR.
            (false, _) => return Ok(()),
        };
        if idr && hdr.frame_num != 0 {
            return Err(Error::malformed("h264 skip: IDR with frame_num not 0"));
        }
        let pic = derive_poc(sps, &st.poc, idr, nal_ref_idc, hdr.frame_num, &hdr.poc);
        let mut poc = pic.min();
        let mmco5 = hdr.marking.mmco5;
        if mmco5 {
            // §8.2.1: the picture's POCs become relative to their minimum.
            let temp = pic.top.min(pic.bottom);
            st.poc.prev_msb = 0;
            st.poc.prev_lsb = pic.top - temp;
            poc = 0;
        } else if nal_ref_idc != 0 {
            st.poc.prev_msb = pic.msb;
            st.poc.prev_lsb = hdr.poc.lsb as i64;
        }
        // Types 1 and 2: the previous picture's frame_num and offset; after
        // MMCO 5 frame_num is inferred to be 0 and the offset is 0.
        st.poc.prev_frame_num = if mmco5 { 0 } else { hdr.frame_num };
        st.poc.prev_frame_num_offset = if mmco5 { 0 } else { pic.frame_num_offset };
        if !idr {
            st.step = Some(pic.min() - st.last_poc);
        }
        st.last_poc = poc;
        if nal_ref_idc != 0 {
            st.prev_ref_frame_num = if mmco5 { 0 } else { hdr.frame_num };
        }
        st.last = if nal_ref_idc == 0 {
            Last::NonReference
        } else {
            hdr.marking.current
        };
        st.pps_id = pps_id;
        self.state = Some(st);
        Ok(())
    }
}

/// The POC fields of a slice header.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct PocFields {
    lsb: u32,
    delta_bottom: i32,
    delta: [i32; 2],
}

/// A picture's POCs (§8.2.1).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct PicPoc {
    top: i64,
    bottom: i64,
    /// Type 0: PicOrderCntMsb.
    msb: i64,
    /// Types 1 and 2: FrameNumOffset.
    frame_num_offset: i64,
}

impl PicPoc {
    /// The frame's POC (§8.2.1: PicOrderCnt of a frame).
    fn min(&self) -> i64 {
        self.top.min(self.bottom)
    }
}

/// §8.2.1.1 to §8.2.1.3 for a frame (field_pic_flag 0).
fn derive_poc(
    sps: &Sps,
    st: &PocState,
    idr: bool,
    nal_ref_idc: u8,
    frame_num: u32,
    f: &PocFields,
) -> PicPoc {
    let max_frame_num = 1i64 << sps.log2_max_frame_num;
    let frame_num_offset = if idr {
        0
    } else if st.prev_frame_num > frame_num {
        st.prev_frame_num_offset + max_frame_num
    } else {
        st.prev_frame_num_offset
    };
    match sps.poc_type {
        0 => {
            let (prev_msb, prev_lsb) = if idr {
                (0, 0)
            } else {
                (st.prev_msb, st.prev_lsb)
            };
            let max = 1i64 << sps.log2_max_poc_lsb;
            let lsb = f.lsb as i64;
            let msb = if lsb < prev_lsb && prev_lsb - lsb >= max / 2 {
                prev_msb + max
            } else if lsb > prev_lsb && lsb - prev_lsb > max / 2 {
                prev_msb - max
            } else {
                prev_msb
            };
            let top = msb + lsb;
            PicPoc {
                top,
                bottom: top + f.delta_bottom as i64,
                msb,
                frame_num_offset,
            }
        }
        1 => {
            let cycle = &sps.offset_for_ref_frame;
            let mut abs = if cycle.is_empty() {
                0
            } else {
                frame_num_offset + frame_num as i64
            };
            if nal_ref_idc == 0 && abs > 0 {
                abs -= 1;
            }
            let mut expected = 0i64;
            if abs > 0 {
                let n = cycle.len() as i64;
                let per_cycle: i64 = cycle.iter().map(|&o| o as i64).sum();
                let cycle_cnt = (abs - 1) / n;
                let in_cycle = ((abs - 1) % n) as usize;
                // Wrapping: only a stream of absurd length or offsets gets
                // there, and it must not panic.
                expected = cycle_cnt
                    .wrapping_mul(per_cycle)
                    .wrapping_add(cycle[..=in_cycle].iter().map(|&o| o as i64).sum::<i64>());
            }
            if nal_ref_idc == 0 {
                expected += sps.offset_for_non_ref_pic as i64;
            }
            let top = expected + f.delta[0] as i64;
            PicPoc {
                top,
                bottom: top + sps.offset_for_top_to_bottom_field as i64 + f.delta[1] as i64,
                msb: 0,
                frame_num_offset,
            }
        }
        _ => {
            let poc = if idr {
                0
            } else if nal_ref_idc == 0 {
                2 * (frame_num_offset + frame_num as i64) - 1
            } else {
                2 * (frame_num_offset + frame_num as i64)
            };
            PicPoc {
                top: poc,
                bottom: poc,
                msb: 0,
                frame_num_offset,
            }
        }
    }
}

/// The POC fields of the skip frames (see the module documentation), or
/// `None` when the wanted POC cannot be coded.
fn skip_poc(sps: &Sps, st: &State, frame_num: u32) -> Option<PocFields> {
    let want = st.last_poc
        + if st.step.is_some_and(|s| s >= 2) {
            1
        } else {
            0
        };
    let mut f = PocFields::default();
    match sps.poc_type {
        0 => {
            let max = 1i64 << sps.log2_max_poc_lsb;
            f.lsb = want.rem_euclid(max) as u32;
        }
        1 if !sps.delta_pic_order_always_zero => {
            let base = derive_poc(sps, &st.poc, false, 0, frame_num, &f);
            // Bottom = Top + offset_for_top_to_bottom_field; the frame's POC
            // is the smaller one.
            let delta = want - base.top - (sps.offset_for_top_to_bottom_field as i64).min(0);
            f.delta[0] = i32::try_from(delta).ok().filter(|&d| d != i32::MIN)?;
        }
        _ => {}
    }
    let got = derive_poc(sps, &st.poc, false, 0, frame_num, &f);
    // Type 0 can only say the POC within half the lsb range of the last
    // reference picture's.
    (sps.poc_type != 0 || got.min() == want).then_some(f)
}

/// What a skip slice needs.
struct SkipSlice<'a> {
    sps: &'a Sps,
    pps: &'a Pps,
    pps_id: u32,
    frame_num: u32,
    poc: PocFields,
    long_term: Option<u32>,
    cabac_qp: i32,
    cabac_init_idc: u32,
}

/// The RBSP of a skip slice: slice_header() (§7.3.3) and slice_data()
/// (§7.3.4).
fn write_skip_slice(s: &SkipSlice<'_>) -> Vec<u8> {
    let (sps, pps) = (s.sps, s.pps);
    let mut w = BitWriter::default();
    w.ue(0); // first_mb_in_slice
    w.ue(5); // slice_type: P, every slice of the picture
    w.ue(s.pps_id);
    w.put(sps.log2_max_frame_num, s.frame_num);
    // frame_mbs_only_flag is 1: no field_pic_flag. Not IDR: no idr_pic_id.
    match sps.poc_type {
        0 => {
            w.put(sps.log2_max_poc_lsb, s.poc.lsb);
            if pps.bottom_field_pic_order_in_frame_present {
                w.se(0); // delta_pic_order_cnt_bottom
            }
        }
        1 if !sps.delta_pic_order_always_zero => {
            w.se(s.poc.delta[0]);
            if pps.bottom_field_pic_order_in_frame_present {
                w.se(0);
            }
        }
        _ => {}
    }
    if pps.redundant_pic_cnt_present {
        w.ue(0); // redundant_pic_cnt: the primary picture
    }
    // num_ref_idx_active_override_flag: one reference index.
    if pps.num_ref_idx_l0_default_minus1 == 0 {
        w.flag(false);
    } else {
        w.flag(true);
        w.ue(0);
    }
    // ref_pic_list_modification()
    match s.long_term {
        None => w.flag(false),
        Some(idx) => {
            w.flag(true);
            w.ue(2); // modification_of_pic_nums_idc: long_term_pic_num
            w.ue(idx); // LongTermPicNum = LongTermFrameIdx for frames
            w.ue(3); // end of the list
        }
    }
    if pps.weighted_pred {
        // pred_weight_table(): default weights.
        w.ue(0); // luma_log2_weight_denom
        if sps.chroma_array_type != 0 {
            w.ue(0); // chroma_log2_weight_denom
        }
        w.flag(false); // luma_weight_l0_flag[0]
        if sps.chroma_array_type != 0 {
            w.flag(false); // chroma_weight_l0_flag[0]
        }
    }
    // nal_ref_idc 0: no dec_ref_pic_marking().
    let slice_qp = if pps.cabac {
        s.cabac_qp
    } else {
        26 + pps.pic_init_qp_minus26
    };
    if pps.cabac {
        w.ue(s.cabac_init_idc);
    }
    w.se(slice_qp - 26 - pps.pic_init_qp_minus26); // slice_qp_delta
    if pps.deblocking_filter_control_present {
        w.ue(1); // disable_deblocking_filter_idc
    }
    // num_slice_groups_minus1 is 0: no slice_group_change_cycle.
    let mbs = sps.pic_size_in_mbs;
    if pps.cabac {
        while !w.is_aligned() {
            w.flag(true); // cabac_alignment_one_bit
        }
        let (m, n) = MB_SKIP_FLAG_INIT[s.cabac_init_idc as usize];
        let mut ctx = Context::new(m, n, slice_qp);
        let mut enc = CabacEncoder::new(&mut w);
        for i in 0..mbs {
            enc.decision(&mut ctx, 1); // mb_skip_flag
            enc.terminate(i + 1 == mbs); // end_of_slice_flag
        }
        // The flush wrote rbsp_stop_one_bit.
        w.align_zero();
    } else {
        w.ue(mbs); // mb_skip_run
        w.trailing();
    }
    w.into_bytes()
}

/// The parts of a sequence parameter set skip frames need (§7.3.2.1.1).
#[derive(Debug, Clone, PartialEq, Eq)]
struct Sps {
    id: u32,
    chroma_array_type: u32,
    log2_max_frame_num: u32,
    poc_type: u32,
    log2_max_poc_lsb: u32,
    delta_pic_order_always_zero: bool,
    offset_for_non_ref_pic: i32,
    offset_for_top_to_bottom_field: i32,
    offset_for_ref_frame: Vec<i32>,
    pic_size_in_mbs: u32,
    /// Why skip frames cannot be made for this SPS.
    unsupported: Option<&'static str>,
}

/// The parts of a picture parameter set skip frames need (§7.3.2.2).
#[derive(Debug, Clone, PartialEq, Eq)]
struct Pps {
    id: u32,
    sps_id: u32,
    cabac: bool,
    bottom_field_pic_order_in_frame_present: bool,
    num_ref_idx_l0_default_minus1: u32,
    num_ref_idx_l1_default_minus1: u32,
    weighted_pred: bool,
    weighted_bipred_idc: u32,
    pic_init_qp_minus26: i32,
    deblocking_filter_control_present: bool,
    redundant_pic_cnt_present: bool,
    unsupported: Option<&'static str>,
}

fn malformed(what: &'static str) -> Error {
    Error::malformed(what)
}

/// Profiles whose SPS has chroma_format_idc and the rest (§7.3.2.1.1).
fn has_chroma_info(profile_idc: u32) -> bool {
    matches!(
        profile_idc,
        100 | 110 | 122 | 244 | 44 | 83 | 86 | 118 | 128 | 138 | 139 | 134 | 135
    )
}

fn skip_scaling_list(br: &mut BitReader<'_>, size: usize) -> Result<()> {
    let (mut last, mut next) = (8i32, 8i32);
    for _ in 0..size {
        if next != 0 {
            let delta = br.se()?;
            if !(-128..=127).contains(&delta) {
                return Err(malformed("h264 sps: delta_scale out of range"));
            }
            next = (last + delta + 256) % 256;
        }
        if next != 0 {
            last = next;
        }
    }
    Ok(())
}

fn parse_sps(nal: &[u8]) -> Result<Sps> {
    let rbsp = unescape_rbsp(nal.get(1..).unwrap_or_default());
    let mut br = BitReader::new(&rbsp);
    let profile_idc = br.u(8)?;
    let _constraint_flags_and_level = br.u(16)?;
    let id = br.ue()?;
    if id > 31 {
        return Err(malformed("h264 sps: seq_parameter_set_id out of range"));
    }
    let mut unsupported = None;
    let mut chroma_array_type = 1;
    if has_chroma_info(profile_idc) {
        let chroma_format_idc = br.ue()?;
        if chroma_format_idc > 3 {
            return Err(malformed("h264 sps: chroma_format_idc out of range"));
        }
        chroma_array_type = chroma_format_idc;
        if chroma_format_idc == 3 && br.flag()? {
            chroma_array_type = 0;
            unsupported = Some("h264 skip: separate colour planes");
        }
        let _bit_depth_luma_minus8 = br.ue()?;
        let _bit_depth_chroma_minus8 = br.ue()?;
        let _qpprime_y_zero_transform_bypass = br.flag()?;
        if br.flag()? {
            for i in 0..if chroma_format_idc == 3 { 12 } else { 8 } {
                if br.flag()? {
                    skip_scaling_list(&mut br, if i < 6 { 16 } else { 64 })?;
                }
            }
        }
    }
    let log2_max_frame_num = br.ue()?.saturating_add(4);
    if log2_max_frame_num > 16 {
        return Err(malformed("h264 sps: log2_max_frame_num out of range"));
    }
    let poc_type = br.ue()?;
    let mut sps = Sps {
        id,
        chroma_array_type,
        log2_max_frame_num,
        poc_type,
        log2_max_poc_lsb: 0,
        delta_pic_order_always_zero: false,
        offset_for_non_ref_pic: 0,
        offset_for_top_to_bottom_field: 0,
        offset_for_ref_frame: Vec::new(),
        pic_size_in_mbs: 0,
        unsupported,
    };
    match poc_type {
        0 => {
            sps.log2_max_poc_lsb = br.ue()?.saturating_add(4);
            if sps.log2_max_poc_lsb > 16 {
                return Err(malformed(
                    "h264 sps: log2_max_pic_order_cnt_lsb out of range",
                ));
            }
        }
        1 => {
            sps.delta_pic_order_always_zero = br.flag()?;
            sps.offset_for_non_ref_pic = br.se()?;
            sps.offset_for_top_to_bottom_field = br.se()?;
            let n = br.ue()?;
            if n > 255 {
                return Err(malformed("h264 sps: too many ref frames in poc cycle"));
            }
            for _ in 0..n {
                sps.offset_for_ref_frame.push(br.se()?);
            }
        }
        2 => {}
        _ => return Err(malformed("h264 sps: pic_order_cnt_type out of range")),
    }
    let _max_num_ref_frames = br.ue()?;
    let _gaps_in_frame_num_value_allowed = br.flag()?;
    let width_mbs = br.ue()?.saturating_add(1);
    let height_map_units = br.ue()?.saturating_add(1);
    if !br.flag()? {
        sps.unsupported = Some("h264 skip: field or MBAFF coding");
    }
    let size = width_mbs as u64 * height_map_units as u64;
    if size > MAX_PIC_SIZE_IN_MBS as u64 {
        return Err(malformed("h264 sps: picture too large"));
    }
    // With frame_mbs_only_flag 1, FrameHeightInMbs = PicHeightInMapUnits.
    sps.pic_size_in_mbs = size as u32;
    // The rest (direct_8x8_inference_flag, cropping, VUI) does not matter.
    Ok(sps)
}

fn parse_pps(nal: &[u8]) -> Result<Pps> {
    let rbsp = unescape_rbsp(nal.get(1..).unwrap_or_default());
    let mut br = BitReader::new(&rbsp);
    let id = br.ue()?;
    let sps_id = br.ue()?;
    if id > 255 || sps_id > 31 {
        return Err(malformed("h264 pps: parameter set id out of range"));
    }
    let cabac = br.flag()?;
    let bottom_field_pic_order_in_frame_present = br.flag()?;
    let num_slice_groups_minus1 = br.ue()?;
    let mut unsupported = None;
    if num_slice_groups_minus1 > 0 {
        if num_slice_groups_minus1 > 7 {
            return Err(malformed("h264 pps: too many slice groups"));
        }
        unsupported = Some("h264 skip: slice groups (FMO)");
        match br.ue()? {
            0 => {
                for _ in 0..=num_slice_groups_minus1 {
                    let _run_length_minus1 = br.ue()?;
                }
            }
            1 => {}
            2 => {
                for _ in 0..num_slice_groups_minus1 {
                    let _top_left = br.ue()?;
                    let _bottom_right = br.ue()?;
                }
            }
            3..=5 => {
                let _slice_group_change_direction = br.flag()?;
                let _slice_group_change_rate_minus1 = br.ue()?;
            }
            6 => {
                let n = br.ue()? as u64 + 1;
                if n > MAX_PIC_SIZE_IN_MBS as u64 {
                    return Err(malformed("h264 pps: too many map units"));
                }
                let bits = 32 - num_slice_groups_minus1.leading_zeros();
                for _ in 0..n {
                    br.u(bits)?;
                }
            }
            _ => return Err(malformed("h264 pps: slice_group_map_type out of range")),
        }
    }
    let num_ref_idx_l0_default_minus1 = br.ue()?;
    let num_ref_idx_l1_default_minus1 = br.ue()?;
    if num_ref_idx_l0_default_minus1 > 31 || num_ref_idx_l1_default_minus1 > 31 {
        return Err(malformed(
            "h264 pps: num_ref_idx_default_active out of range",
        ));
    }
    let weighted_pred = br.flag()?;
    let weighted_bipred_idc = br.u(2)?;
    let pic_init_qp_minus26 = br.se()?;
    if !(-(26 + 6 * 6)..=25).contains(&pic_init_qp_minus26) {
        return Err(malformed("h264 pps: pic_init_qp out of range"));
    }
    let _pic_init_qs_minus26 = br.se()?;
    let _chroma_qp_index_offset = br.se()?;
    let deblocking_filter_control_present = br.flag()?;
    let _constrained_intra_pred = br.flag()?;
    let redundant_pic_cnt_present = br.flag()?;
    // transform_8x8_mode_flag and the rest do not change slice headers.
    Ok(Pps {
        id,
        sps_id,
        cabac,
        bottom_field_pic_order_in_frame_present,
        num_ref_idx_l0_default_minus1,
        num_ref_idx_l1_default_minus1,
        weighted_pred,
        weighted_bipred_idc,
        pic_init_qp_minus26,
        deblocking_filter_control_present,
        redundant_pic_cnt_present,
        unsupported,
    })
}

/// What dec_ref_pic_marking() did to the current picture.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Marking {
    mmco5: bool,
    current: Last,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct SliceHeader {
    frame_num: u32,
    poc: PocFields,
    marking: Marking,
}

/// The slice header of §7.3.3 up to dec_ref_pic_marking(), after
/// pic_parameter_set_id. `slice_type` is modulo 5 (0 P, 1 B, 2 I, 3 SP,
/// 4 SI).
fn parse_slice_header(
    br: &mut BitReader<'_>,
    sps: &Sps,
    pps: &Pps,
    slice_type: u32,
    nal_ref_idc: u8,
    idr: bool,
) -> Result<SliceHeader> {
    // separate_colour_plane_flag and field coding are refused before.
    let frame_num = br.u(sps.log2_max_frame_num)?;
    if idr {
        let _idr_pic_id = br.ue()?;
    }
    let mut poc = PocFields::default();
    match sps.poc_type {
        0 => {
            poc.lsb = br.u(sps.log2_max_poc_lsb)?;
            if pps.bottom_field_pic_order_in_frame_present {
                poc.delta_bottom = br.se()?;
            }
        }
        1 if !sps.delta_pic_order_always_zero => {
            poc.delta[0] = br.se()?;
            if pps.bottom_field_pic_order_in_frame_present {
                poc.delta[1] = br.se()?;
            }
        }
        _ => {}
    }
    if pps.redundant_pic_cnt_present && br.ue()? != 0 {
        return Err(malformed(
            "h264 slice: access unit starts with a redundant slice",
        ));
    }
    let (p, b) = (matches!(slice_type, 0 | 3), slice_type == 1);
    if b {
        let _direct_spatial_mv_pred = br.flag()?;
    }
    let mut refs = [
        pps.num_ref_idx_l0_default_minus1,
        pps.num_ref_idx_l1_default_minus1,
    ];
    if (p || b) && br.flag()? {
        refs[0] = br.ue()?;
        if b {
            refs[1] = br.ue()?;
        }
        if refs[0] > 31 || refs[1] > 31 {
            return Err(malformed("h264 slice: num_ref_idx_active out of range"));
        }
    }
    let lists = if b {
        2
    } else if p {
        1
    } else {
        0
    };
    // ref_pic_list_modification()
    for _ in 0..lists {
        if br.flag()? {
            loop {
                match br.ue()? {
                    0..=2 => {
                        br.ue()?;
                    }
                    3 => break,
                    _ => return Err(malformed("h264 slice: modification_of_pic_nums_idc")),
                }
            }
        }
    }
    if (pps.weighted_pred && p) || (pps.weighted_bipred_idc == 1 && b) {
        // pred_weight_table()
        let _luma_log2_weight_denom = br.ue()?;
        let chroma = sps.chroma_array_type != 0;
        if chroma {
            let _chroma_log2_weight_denom = br.ue()?;
        }
        for &n in &refs[..lists] {
            for _ in 0..=n {
                if br.flag()? {
                    br.se()?;
                    br.se()?;
                }
                if chroma && br.flag()? {
                    for _ in 0..4 {
                        br.se()?;
                    }
                }
            }
        }
    }
    let mut marking = Marking {
        mmco5: false,
        current: Last::Reference(None),
    };
    if nal_ref_idc != 0 {
        // dec_ref_pic_marking()
        if idr {
            let _no_output_of_prior_pics = br.flag()?;
            if br.flag()? {
                marking.current = Last::Reference(Some(0)); // long_term_reference_flag
            }
        } else if br.flag()? {
            // adaptive_ref_pic_marking_mode_flag
            let mut long_term: Option<u32> = None;
            let mut gone = false;
            loop {
                match br.ue()? {
                    0 => break,
                    1 => {
                        br.ue()?; // difference_of_pic_nums_minus1
                    }
                    2 => {
                        // long_term_pic_num: the current picture if 6 made it long term.
                        gone |= long_term == Some(br.ue()?);
                    }
                    3 => {
                        br.ue()?;
                        // Another picture takes the current one's index.
                        gone |= long_term == Some(br.ue()?);
                    }
                    4 => {
                        let max_plus1 = br.ue()?;
                        gone |= long_term.is_some_and(|i| i >= max_plus1);
                    }
                    5 => {
                        marking.mmco5 = true;
                        gone |= long_term.is_some();
                    }
                    6 => {
                        long_term = Some(br.ue()?);
                        gone = false;
                    }
                    _ => return Err(malformed("h264 slice: memory_management_control_operation")),
                }
            }
            marking.current = if gone {
                Last::Unusable
            } else {
                Last::Reference(long_term)
            };
        }
    }
    Ok(SliceHeader {
        frame_num,
        poc,
        marking,
    })
}

/// MSB-first bit reader with Exp-Golomb codes (§7.2, §9.1).
struct BitReader<'a> {
    data: &'a [u8],
    bit: usize,
}

impl<'a> BitReader<'a> {
    fn new(data: &'a [u8]) -> BitReader<'a> {
        BitReader { data, bit: 0 }
    }

    fn u1(&mut self) -> Result<u32> {
        let byte = *self
            .data
            .get(self.bit / 8)
            .ok_or_else(|| malformed("h264 skip: unexpected end of data"))?;
        self.bit += 1;
        Ok(((byte >> (7 - (self.bit - 1) % 8)) & 1) as u32)
    }

    fn flag(&mut self) -> Result<bool> {
        Ok(self.u1()? == 1)
    }

    fn u(&mut self, n: u32) -> Result<u32> {
        let mut v = 0u32;
        for _ in 0..n.min(32) {
            v = (v << 1) | self.u1()?;
        }
        Ok(v)
    }

    fn ue(&mut self) -> Result<u32> {
        let mut zeros = 0;
        while self.u1()? == 0 {
            zeros += 1;
            if zeros > 31 {
                return Err(malformed("h264 skip: exp-golomb code too long"));
            }
        }
        let v = (1u64 << zeros) - 1 + self.u(zeros)? as u64;
        u32::try_from(v).map_err(|_| malformed("h264 skip: exp-golomb value too large"))
    }

    fn se(&mut self) -> Result<i32> {
        let k = self.ue()? as i64;
        Ok(if k % 2 == 1 { (k + 1) / 2 } else { -(k / 2) } as i32)
    }
}

/// MSB-first bit writer with Exp-Golomb codes (§7.2, §9.1).
#[derive(Debug, Default)]
struct BitWriter {
    buf: Vec<u8>,
    cur: u8,
    n: u32,
}

impl BitWriter {
    fn bit(&mut self, b: bool) {
        self.cur = (self.cur << 1) | b as u8;
        self.n += 1;
        if self.n == 8 {
            self.buf.push(self.cur);
            self.cur = 0;
            self.n = 0;
        }
    }

    fn flag(&mut self, b: bool) {
        self.bit(b);
    }

    /// The low `nbits` bits of `v`, MSB first.
    fn put(&mut self, nbits: u32, v: u32) {
        for i in (0..nbits.min(32)).rev() {
            self.bit((v >> i) & 1 == 1);
        }
    }

    fn ue(&mut self, v: u32) {
        let code = v as u64 + 1;
        let len = 64 - code.leading_zeros();
        for _ in 1..len {
            self.bit(false);
        }
        for i in (0..len).rev() {
            self.bit((code >> i) & 1 == 1);
        }
    }

    fn se(&mut self, v: i32) {
        let code = if v > 0 {
            (v as u32) * 2 - 1
        } else {
            v.unsigned_abs() * 2
        };
        self.ue(code);
    }

    fn is_aligned(&self) -> bool {
        self.n == 0
    }

    fn align_zero(&mut self) {
        while !self.is_aligned() {
            self.bit(false);
        }
    }

    /// rbsp_trailing_bits() (§7.3.2.11).
    fn trailing(&mut self) {
        self.bit(true);
        self.align_zero();
    }

    fn into_bytes(self) -> Vec<u8> {
        debug_assert!(self.n == 0);
        self.buf
    }
}

/// Appends a NAL unit with a 4-byte length: the header byte, then the RBSP
/// with emulation_prevention_three_byte after every `00 00` that a byte
/// ≤ 3 follows (§7.4.1).
fn put_nal_avcc(out: &mut Vec<u8>, nal_ref_idc: u8, nal_unit_type: u8, rbsp: &[u8]) {
    let len_at = out.len();
    out.extend_from_slice(&[0; 4]);
    out.push(((nal_ref_idc & 3) << 5) | (nal_unit_type & 0x1f));
    let mut zeros = 0;
    for &b in rbsp {
        if zeros >= 2 && b <= 3 {
            out.push(3);
            zeros = 0;
        }
        out.push(b);
        zeros = if b == 0 { zeros + 1 } else { 0 };
    }
    let len = (out.len() - len_at - 4) as u32;
    out[len_at..len_at + 4].copy_from_slice(&len.to_be_bytes());
}

/// (m, n) of ctxIdx 11, mb_skip_flag of P and SP slices, for cabac_init_idc
/// 0 to 2 (Table 9-13).
const MB_SKIP_FLAG_INIT: [(i32, i32); 3] = [(23, 33), (22, 25), (29, 16)];

/// rangeTabLPS\[pStateIdx\]\[qCodIRangeIdx\] (Table 9-44).
const RANGE_TAB_LPS: [[u8; 4]; 64] = [
    [128, 176, 208, 240],
    [128, 167, 197, 227],
    [128, 158, 187, 216],
    [123, 150, 178, 205],
    [116, 142, 169, 195],
    [111, 135, 160, 185],
    [105, 128, 152, 175],
    [100, 122, 144, 166],
    [95, 116, 137, 158],
    [90, 110, 130, 150],
    [85, 104, 123, 142],
    [81, 99, 117, 135],
    [77, 94, 111, 128],
    [73, 89, 105, 122],
    [69, 85, 100, 116],
    [66, 80, 95, 110],
    [62, 76, 90, 104],
    [59, 72, 86, 99],
    [56, 69, 81, 94],
    [53, 65, 77, 89],
    [51, 62, 73, 85],
    [48, 59, 69, 80],
    [46, 56, 66, 76],
    [43, 53, 63, 72],
    [41, 50, 59, 69],
    [39, 48, 56, 65],
    [37, 45, 54, 62],
    [35, 43, 51, 59],
    [33, 41, 48, 56],
    [32, 39, 46, 53],
    [30, 37, 43, 50],
    [29, 35, 41, 48],
    [27, 33, 39, 45],
    [26, 31, 37, 43],
    [24, 30, 35, 41],
    [23, 28, 33, 39],
    [22, 27, 32, 37],
    [21, 26, 30, 35],
    [20, 24, 29, 33],
    [19, 23, 27, 31],
    [18, 22, 26, 30],
    [17, 21, 25, 28],
    [16, 20, 23, 27],
    [15, 19, 22, 25],
    [14, 18, 21, 24],
    [14, 17, 20, 23],
    [13, 16, 19, 22],
    [12, 15, 18, 21],
    [12, 14, 17, 20],
    [11, 14, 16, 19],
    [11, 13, 15, 18],
    [10, 12, 15, 17],
    [10, 12, 14, 16],
    [9, 11, 13, 15],
    [9, 11, 12, 14],
    [8, 10, 12, 14],
    [8, 9, 11, 13],
    [7, 9, 11, 12],
    [7, 9, 10, 12],
    [7, 8, 10, 11],
    [6, 8, 9, 11],
    [6, 7, 9, 10],
    [6, 7, 8, 9],
    [2, 2, 2, 2],
];

/// transIdxLPS (Table 9-45); transIdxMPS is pStateIdx + 1 up to 62.
const TRANS_IDX_LPS: [u8; 64] = [
    0, 0, 1, 2, 2, 4, 4, 5, 6, 7, 8, 9, 9, 11, 11, 12, 13, 13, 15, 15, 16, 16, 18, 18, 19, 19, 21,
    21, 22, 22, 23, 24, 24, 25, 26, 26, 27, 27, 28, 29, 29, 30, 30, 30, 31, 32, 32, 33, 33, 33, 34,
    34, 35, 35, 35, 36, 36, 36, 37, 37, 37, 38, 38, 63,
];

/// A CABAC context variable.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Context {
    state: u8,
    mps: u8,
}

impl Context {
    /// §9.3.1.1.
    fn new(m: i32, n: i32, slice_qp: i32) -> Context {
        let pre = (((m * slice_qp.clamp(0, 51)) >> 4) + n).clamp(1, 126);
        if pre <= 63 {
            Context {
                state: (63 - pre) as u8,
                mps: 0,
            }
        } else {
            Context {
                state: (pre - 64) as u8,
                mps: 1,
            }
        }
    }
}

/// The arithmetic encoder of §9.3.4.
struct CabacEncoder<'a> {
    w: &'a mut BitWriter,
    low: u32,
    range: u32,
    outstanding: u32,
    first: bool,
}

impl<'a> CabacEncoder<'a> {
    /// InitEncoder (§9.3.4.1).
    fn new(w: &'a mut BitWriter) -> CabacEncoder<'a> {
        CabacEncoder {
            w,
            low: 0,
            range: 510,
            outstanding: 0,
            first: true,
        }
    }

    /// EncodeDecision (§9.3.4.2).
    fn decision(&mut self, ctx: &mut Context, bin: u8) {
        let q = ((self.range >> 6) & 3) as usize;
        let lps = RANGE_TAB_LPS[ctx.state as usize][q] as u32;
        self.range -= lps;
        if bin != ctx.mps {
            self.low += self.range;
            self.range = lps;
            if ctx.state == 0 {
                ctx.mps = 1 - ctx.mps;
            }
            ctx.state = TRANS_IDX_LPS[ctx.state as usize];
        } else if ctx.state < 62 {
            ctx.state += 1;
        }
        self.renorm();
    }

    /// EncodeTerminate (§9.3.4.5); a 1 also flushes.
    fn terminate(&mut self, bin: bool) {
        self.range -= 2;
        if bin {
            self.low += self.range;
            self.flush();
        } else {
            self.renorm();
        }
    }

    /// EncodeFlush (§9.3.4.5): its last bit is rbsp_stop_one_bit.
    fn flush(&mut self) {
        self.range = 2;
        self.renorm();
        self.put_bit(((self.low >> 9) & 1) as u8);
        self.w.put(2, ((self.low >> 7) & 3) | 1);
    }

    /// RenormE (§9.3.4.3).
    fn renorm(&mut self) {
        while self.range < 256 {
            if self.low < 256 {
                self.put_bit(0);
            } else if self.low >= 512 {
                self.low -= 512;
                self.put_bit(1);
            } else {
                self.low -= 256;
                self.outstanding += 1;
            }
            self.range <<= 1;
            self.low <<= 1;
        }
    }

    /// PutBit (§9.3.4.3).
    fn put_bit(&mut self, b: u8) {
        if self.first {
            self.first = false;
        } else {
            self.w.bit(b == 1);
        }
        while self.outstanding > 0 {
            self.w.bit(b == 0);
            self.outstanding -= 1;
        }
    }
}

#[cfg(test)]
mod tests;
