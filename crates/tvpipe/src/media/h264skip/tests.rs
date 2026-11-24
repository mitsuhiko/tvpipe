//! Known answers for the bit writing and the CABAC encoder, and oracle
//! tests: streams from libx264, VideoToolbox and our own encoder, with skip
//! frames spliced in, decoded by ffmpeg (a black box) must show the
//! repeated picture and then exactly the frames of the unmodified stream.
//! The oracle tests are skipped without ffmpeg (or without the encoder).

use std::path::{Path, PathBuf};
use std::process::Command;

use super::*;
use crate::error::ErrorKind;
use crate::media::h264::annexb_nals;

// ---------------------------------------------------------------------
// Synthetic parameter sets and slices.

fn rbsp_nal(header: u8, w: BitWriter) -> Vec<u8> {
    let mut out = Vec::new();
    put_nal_avcc(&mut out, header >> 5, header & 0x1f, &w.into_bytes());
    out.drain(..4);
    out
}

/// What a synthetic SPS says.
#[derive(Clone)]
struct TestSps {
    profile_idc: u32,
    chroma_format_idc: u32,
    separate_planes: bool,
    poc_type: u32,
    log2_max_poc_lsb: u32,
    frame_mbs_only: bool,
}

impl Default for TestSps {
    fn default() -> TestSps {
        TestSps {
            profile_idc: 66,
            chroma_format_idc: 1,
            separate_planes: false,
            poc_type: 2,
            log2_max_poc_lsb: 4,
            frame_mbs_only: true,
        }
    }
}

/// An SPS for 176x144 (11 x 9 macroblocks), log2_max_frame_num 4.
fn sps_nal(t: &TestSps) -> Vec<u8> {
    let mut w = BitWriter::default();
    w.put(8, t.profile_idc);
    w.put(8, 0);
    w.put(8, 30);
    w.ue(0); // seq_parameter_set_id
    if has_chroma_info(t.profile_idc) {
        w.ue(t.chroma_format_idc);
        if t.chroma_format_idc == 3 {
            w.flag(t.separate_planes);
        }
        w.ue(0);
        w.ue(0);
        w.flag(false);
        w.flag(false);
    }
    w.ue(0); // log2_max_frame_num_minus4
    w.ue(t.poc_type);
    if t.poc_type == 0 {
        w.ue(t.log2_max_poc_lsb - 4);
    }
    w.ue(1); // max_num_ref_frames
    w.flag(false);
    w.ue(10);
    w.ue(8);
    w.flag(t.frame_mbs_only);
    if !t.frame_mbs_only {
        w.flag(false);
    }
    w.flag(true);
    w.flag(false);
    w.flag(false);
    w.trailing();
    rbsp_nal(0x67, w)
}

#[derive(Clone, Default)]
struct TestPps {
    slice_groups: u32,
    cabac: bool,
    bottom_present: bool,
    ref_idx_minus1: u32,
    weighted: bool,
    no_deblocking_control: bool,
    redundant: bool,
}

fn pps_nal(t: &TestPps) -> Vec<u8> {
    let mut w = BitWriter::default();
    w.ue(0);
    w.ue(0);
    w.flag(t.cabac);
    w.flag(t.bottom_present);
    w.ue(t.slice_groups);
    if t.slice_groups > 0 {
        w.ue(0); // interleaved
        for _ in 0..=t.slice_groups {
            w.ue(3);
        }
    }
    w.ue(t.ref_idx_minus1);
    w.ue(0);
    w.flag(t.weighted);
    w.put(2, 0);
    w.se(0);
    w.se(0);
    w.se(0);
    w.flag(!t.no_deblocking_control);
    w.flag(false);
    w.flag(t.redundant);
    w.trailing();
    rbsp_nal(0x68, w)
}

fn avcc_of(sps: &[u8], pps: &[u8]) -> Vec<u8> {
    AvcConfig::from_parameter_sets(vec![sps.to_vec()], vec![pps.to_vec()])
        .unwrap()
        .to_bytes()
        .unwrap()
}

/// The head of a slice of picture parameter set 0 for the synthetic SPS
/// (log2_max_frame_num 4), up to the POC fields; `rest` writes the others.
fn slice(
    idr: bool,
    nal_ref_idc: u8,
    slice_type: u32,
    frame_num: u32,
    rest: impl Fn(&mut BitWriter),
) -> Vec<u8> {
    let mut w = BitWriter::default();
    w.ue(0);
    w.ue(slice_type);
    w.ue(0);
    w.put(4, frame_num);
    if idr {
        w.ue(0);
    }
    rest(&mut w);
    // The rest of the header and data do not matter to `observe`.
    w.put(8, 0x55);
    w.trailing();
    let mut au = Vec::new();
    put_nal_avcc(
        &mut au,
        nal_ref_idc,
        if idr { 5 } else { 1 },
        &w.into_bytes(),
    );
    au
}

fn bits(s: &str) -> Vec<u8> {
    let mut w = BitWriter::default();
    for c in s.chars().filter(|c| !c.is_whitespace()) {
        w.bit(c == '1');
    }
    w.align_zero();
    w.into_bytes()
}

#[test]
fn writer_and_reader() {
    let mut w = BitWriter::default();
    w.ue(0);
    w.ue(1);
    w.ue(2);
    w.ue(3);
    w.se(1);
    w.se(-1);
    w.ue(u32::MAX - 1);
    w.se(i32::MIN + 1);
    w.put(3, 5);
    w.trailing();
    let data = w.into_bytes();
    assert_eq!(&data[..2], &[0b1010_0110, 0b0100_0100]);
    let mut r = BitReader::new(&data);
    assert_eq!(r.ue().unwrap(), 0);
    assert_eq!(r.ue().unwrap(), 1);
    assert_eq!(r.ue().unwrap(), 2);
    assert_eq!(r.ue().unwrap(), 3);
    assert_eq!(r.se().unwrap(), 1);
    assert_eq!(r.se().unwrap(), -1);
    assert_eq!(r.ue().unwrap(), u32::MAX - 1);
    assert_eq!(r.se().unwrap(), i32::MIN + 1);
    assert_eq!(r.u(3).unwrap(), 5);
    let mut out = Vec::new();
    put_nal_avcc(&mut out, 0, 1, &[0, 0, 0, 0, 0, 1, 0, 0, 4]);
    assert_eq!(out, [0, 0, 0, 12, 1, 0, 0, 3, 0, 0, 3, 0, 1, 0, 0, 4]);
}

/// A CAVLC skip frame, every bit by hand (§7.3.3, §7.3.4).
#[test]
fn cavlc_slice_bits() {
    let sps = sps_nal(&TestSps::default());
    let pps = pps_nal(&TestPps::default());
    let mut s = SkipFrames::new(&avcc_of(&sps, &pps)).unwrap();
    assert_eq!(s.frame(), None);
    // IDR: no_output_of_prior_pics_flag, long_term_reference_flag.
    s.observe(&slice(true, 3, 7, 0, |w| w.put(2, 0))).unwrap();
    for fnum in 1..=2 {
        // P, num_ref_idx_active_override_flag 0, no modification, sliding window.
        s.observe(&slice(false, 2, 5, fnum, |w| w.put(3, 0)))
            .unwrap();
    }
    let expect = bits(
        "1 00110 1 0011 \
         0 0 \
         1 010 \
         0000001100100 1",
    );
    let mut au = vec![0, 0, 0, expect.len() as u8 + 1, 0x01];
    au.extend_from_slice(&expect);
    assert_eq!(expect, [0x9a, 0x65, 0x01, 0x92]);
    assert_eq!(s.frame().unwrap(), au);
    // Skip frames do not change the state: the same frame again.
    assert_eq!(s.frame().unwrap(), au);
}

/// POC type 0, a long-term IDR, weighted prediction, an override, a
/// redundant_pic_cnt and no deblocking control: every bit by hand. No POC
/// step is known yet, so the skip frame takes the IDR's POC (lsb 0).
#[test]
fn long_term_weighted_slice_bits() {
    let sps = sps_nal(&TestSps {
        poc_type: 0,
        ..TestSps::default()
    });
    let pps = pps_nal(&TestPps {
        bottom_present: true,
        ref_idx_minus1: 2,
        weighted: true,
        no_deblocking_control: true,
        redundant: true,
        ..TestPps::default()
    });
    let mut s = SkipFrames::new(&avcc_of(&sps, &pps)).unwrap();
    s.observe(&slice(true, 3, 7, 0, |w| {
        w.put(4, 0); // pic_order_cnt_lsb
        w.se(0); // delta_pic_order_cnt_bottom
        w.ue(0); // redundant_pic_cnt
        w.flag(false); // no_output_of_prior_pics_flag
        w.flag(true); // long_term_reference_flag
    }))
    .unwrap();
    let expect = bits(
        "1 00110 1 0001 \
         0000 1 \
         1 \
         1 1 \
         1 011 1 00100 \
         1 1 0 0 \
         1 \
         0000001100100 1",
    );
    assert_eq!(expect, [0x9a, 0x21, 0xf7, 0x26, 0x40, 0xc9]);
    let mut au = vec![0, 0, 0, expect.len() as u8 + 1, 0x01];
    au.extend_from_slice(&expect);
    assert_eq!(s.frame().unwrap(), au);
}

/// Parses a skip frame back with the module's own slice header parser.
fn reparse(s: &SkipFrames, au: &[u8]) -> (u32, SliceHeader) {
    let nal = avcc_nals(au, 4).next().unwrap().unwrap();
    assert_eq!(nal[0], 0x01);
    let rbsp = unescape_rbsp(&nal[1..]);
    let mut br = BitReader::new(&rbsp);
    assert_eq!(br.ue().unwrap(), 0);
    let slice_type = br.ue().unwrap();
    assert_eq!(slice_type, 5);
    let pps = s.pps[br.ue().unwrap() as usize].as_ref().unwrap();
    let sps = s.sps[pps.sps_id as usize].as_ref().unwrap();
    let hdr = parse_slice_header(&mut br, sps, pps, 0, 0, false).unwrap();
    (pps.id, hdr)
}

#[test]
fn state_frame_num_poc_and_marking() {
    let sps = sps_nal(&TestSps {
        poc_type: 0,
        ..TestSps::default()
    });
    let pps = pps_nal(&TestPps::default());
    let mut s = SkipFrames::new(&avcc_of(&sps, &pps)).unwrap();
    // Before an IDR: nothing.
    s.observe(&slice(false, 2, 5, 3, |w| {
        w.put(4, 6);
        w.put(3, 0);
    }))
    .unwrap();
    assert_eq!(s.frame(), None);
    assert!(!s.waits_for_reference());
    let idr = |s: &mut SkipFrames| {
        s.observe(&slice(true, 3, 7, 0, |w| {
            w.put(4, 0);
            w.put(2, 0);
        }))
        .unwrap()
    };
    idr(&mut s);
    // P frames with POC lsb 2n, frame_num n, up to the wrap of both.
    for n in 1..=8u32 {
        s.observe(&slice(false, 2, 5, n % 16, |w| {
            w.put(4, (2 * n) % 16);
            w.put(3, 0);
        }))
        .unwrap();
        let (_, hdr) = reparse(&s, &s.frame().unwrap());
        assert_eq!(hdr.frame_num, (n + 1) % 16);
        // Step 2: one after the last picture.
        assert_eq!(hdr.poc.lsb, (2 * n + 1) % 16, "n {n}");
        assert_eq!(s.state.as_ref().unwrap().last_poc, 2 * n as i64);
    }
    // A non-reference picture: nothing, but after the next reference.
    s.observe(&slice(false, 0, 5, 9, |w| {
        w.put(4, 3);
        w.put(2, 0);
    }))
    .unwrap();
    assert_eq!(s.frame(), None);
    assert!(s.waits_for_reference());
    // MMCO 5: frame_num and POC start again.
    s.observe(&slice(false, 2, 5, 9, |w| {
        w.put(4, 8);
        w.put(2, 0);
        w.flag(true); // adaptive_ref_pic_marking_mode_flag
        w.ue(5);
        w.ue(0);
    }))
    .unwrap();
    let st = s.state.as_ref().unwrap();
    assert_eq!((st.prev_ref_frame_num, st.last_poc), (0, 0));
    let (_, hdr) = reparse(&s, &s.frame().unwrap());
    assert_eq!((hdr.frame_num, hdr.poc.lsb), (1, 1));
    // MMCO 6: the last picture is long term with index 2.
    s.observe(&slice(false, 2, 5, 1, |w| {
        w.put(4, 2);
        w.put(2, 0);
        w.flag(true);
        w.ue(4); // max_long_term_frame_idx_plus1
        w.ue(3);
        w.ue(6);
        w.ue(2);
        w.ue(0);
    }))
    .unwrap();
    assert_eq!(s.state.as_ref().unwrap().last, Last::Reference(Some(2)));
    assert!(s.frame().is_some());
    // MMCO 6 then MMCO 4 that drops its index: unusable.
    s.observe(&slice(false, 2, 5, 2, |w| {
        w.put(4, 4);
        w.put(2, 0);
        w.flag(true);
        w.ue(6);
        w.ue(3);
        w.ue(4);
        w.ue(3);
        w.ue(0);
    }))
    .unwrap();
    assert_eq!(s.frame(), None);
    assert!(!s.waits_for_reference());
    // A POC step of 1 (VideoToolbox): the same POC as the last picture.
    idr(&mut s);
    for n in 1..=3u32 {
        s.observe(&slice(false, 2, 5, n, |w| {
            w.put(4, n);
            w.put(3, 0);
        }))
        .unwrap();
    }
    let (_, hdr) = reparse(&s, &s.frame().unwrap());
    assert_eq!((hdr.frame_num, hdr.poc.lsb), (4, 3));
}

#[test]
fn poc_type_1() {
    // offset_for_ref_frame [2, 4], offset_for_non_ref_pic -3,
    // offset_for_top_to_bottom_field -1.
    let mut sps = Sps {
        id: 0,
        chroma_array_type: 1,
        log2_max_frame_num: 4,
        poc_type: 1,
        log2_max_poc_lsb: 0,
        delta_pic_order_always_zero: false,
        offset_for_non_ref_pic: -3,
        offset_for_top_to_bottom_field: -1,
        offset_for_ref_frame: vec![2, 4],
        pic_size_in_mbs: 99,
        unsupported: None,
    };
    let st0 = PocState {
        prev_msb: 0,
        prev_lsb: 0,
        prev_frame_num: 14,
        prev_frame_num_offset: 16,
    };
    let f = PocFields::default();
    // frame_num 15 (no wrap): abs 31, (31-1)/2 = 15 cycles of 6, in cycle 0.
    let p = derive_poc(&sps, &st0, false, 1, 15, &f);
    assert_eq!((p.top, p.bottom, p.frame_num_offset), (92, 91, 16));
    // frame_num 0 after 15: a wrap, abs 32 → 15 * 6 + 2 + 4.
    let st1 = PocState {
        prev_frame_num: 15,
        ..st0
    };
    let p = derive_poc(&sps, &st1, false, 1, 0, &f);
    assert_eq!((p.top, p.frame_num_offset), (96, 32));
    // Non-reference at frame_num 0: abs 31 → 92, then -3.
    let p = derive_poc(&sps, &st1, false, 0, 0, &f);
    assert_eq!((p.top, p.bottom), (89, 88));
    // Skip frame after the reference picture of POC 91 (frame 92/91).
    let st = State {
        sps_id: 0,
        sps: sps.clone(),
        pps_id: 0,
        prev_ref_frame_num: 15,
        poc: st1,
        last_poc: 91,
        step: Some(4),
        last: Last::Reference(None),
    };
    let f = skip_poc(&sps, &st, 0).unwrap();
    let got = derive_poc(&sps, &st.poc, false, 0, 0, &f);
    assert_eq!(got.min(), 92);
    assert_eq!(f.delta[0], 92 - 89 + 1);
    // Always zero: the formula decides.
    sps.delta_pic_order_always_zero = true;
    let f = skip_poc(
        &sps,
        &State {
            sps: sps.clone(),
            ..st
        },
        0,
    )
    .unwrap();
    assert_eq!(f, PocFields::default());
}

#[test]
fn poc_type_2_and_frame_num_wrap() {
    let sps = sps_nal(&TestSps::default());
    let pps = pps_nal(&TestPps::default());
    let mut s = SkipFrames::new(&avcc_of(&sps, &pps)).unwrap();
    s.observe(&slice(true, 3, 7, 0, |w| w.put(2, 0))).unwrap();
    for n in 1..=40u32 {
        s.observe(&slice(false, 2, 5, n % 16, |w| w.put(3, 0)))
            .unwrap();
        let st = s.state.as_ref().unwrap();
        assert_eq!(st.last_poc, 2 * n as i64);
        let (_, hdr) = reparse(&s, &s.frame().unwrap());
        assert_eq!(hdr.frame_num, (n + 1) % 16);
    }
}

#[test]
fn context_init() {
    // §9.3.1.1 by hand.
    assert_eq!(Context::new(29, 16, 51), Context { state: 44, mps: 1 });
    assert_eq!(Context::new(23, 33, 0), Context { state: 30, mps: 0 });
    assert_eq!(Context::new(23, 33, 22), Context { state: 0, mps: 1 });
    assert_eq!(Context::new(23, 33, 21), Context { state: 0, mps: 0 });
    // Clip3(1, 126, ...)
    assert_eq!(Context::new(-50, 0, 51), Context { state: 62, mps: 0 });
    assert_eq!(Context::new(50, 120, 51), Context { state: 62, mps: 1 });
}

/// The tables against the design they come from (Marpe, Schwarz, Wiegand
/// 2003, and the notes to §9.3.3.2.1.1): pσ = 0.5 · α^σ with
/// α = (0.01875 / 0.5)^(1/63); rangeTabLPS ≈ pσ · Q for the interval
/// midpoints Q = 288 + 64 · q (at most 128 for q = 0), transIdxLPS ≈ the σ
/// of α · pσ + (1 − α). Catches a mistyped entry; the oracle tests
/// check the encoder against a decoder.
#[test]
fn cabac_tables() {
    let alpha = (0.01875f64 / 0.5).powf(1.0 / 63.0);
    for s in 0..63 {
        let p = 0.5 * alpha.powi(s as i32);
        for q in 0..4 {
            let mut want = p * (288 + 64 * q) as f64;
            if q == 0 {
                want = want.min(128.0);
            }
            let got = RANGE_TAB_LPS[s][q] as f64;
            assert!(
                (got - want).abs() <= 1.0,
                "rangeTabLPS[{s}][{q}] = {got}, ~{want:.1}"
            );
            if s > 0 {
                assert!(RANGE_TAB_LPS[s][q] <= RANGE_TAB_LPS[s - 1][q]);
            }
            if q > 0 {
                assert!(RANGE_TAB_LPS[s][q] > RANGE_TAB_LPS[s][q - 1] || s == 0);
            }
        }
        let next = ((alpha * p + 1.0 - alpha) / 0.5).ln() / alpha.ln();
        let got = TRANS_IDX_LPS[s] as f64;
        assert!(
            (got - next.max(0.0)).abs() < 1.0,
            "transIdxLPS[{s}] = {got}, ~{next:.2}"
        );
        if s > 0 {
            assert!(TRANS_IDX_LPS[s] >= TRANS_IDX_LPS[s - 1]);
        }
    }
    assert_eq!(RANGE_TAB_LPS[63], [2; 4]);
    assert_eq!(TRANS_IDX_LPS[63], 63);
}

#[test]
fn cabac_flush_by_hand() {
    // InitEncoder, then EncodeTerminate(1): codIRange 508, codILow 508;
    // EncodeFlush renormalises seven times (bitsOutstanding 7, the first
    // PutBit(0) is not written), then PutBit(0) writes the outstanding
    // ones and WriteBits(1, 2) "01" ends with the stop bit.
    let mut w = BitWriter::default();
    CabacEncoder::new(&mut w).terminate(true);
    w.align_zero();
    assert_eq!(w.into_bytes(), [0xfe, 0x80]);
}

/// The arithmetic decoder of §9.3.3.2, to check the encoder against.
struct CabacDecoder<'a> {
    r: BitReader<'a>,
    range: u32,
    offset: u32,
}

impl<'a> CabacDecoder<'a> {
    fn new(data: &'a [u8]) -> CabacDecoder<'a> {
        let mut r = BitReader::new(data);
        let offset = r.u(9).unwrap();
        CabacDecoder {
            r,
            range: 510,
            offset,
        }
    }

    fn decision(&mut self, ctx: &mut Context) -> u8 {
        let q = ((self.range >> 6) & 3) as usize;
        let lps = RANGE_TAB_LPS[ctx.state as usize][q] as u32;
        self.range -= lps;
        let bin;
        if self.offset >= self.range {
            bin = 1 - ctx.mps;
            self.offset -= self.range;
            self.range = lps;
            if ctx.state == 0 {
                ctx.mps = 1 - ctx.mps;
            }
            ctx.state = TRANS_IDX_LPS[ctx.state as usize];
        } else {
            bin = ctx.mps;
            ctx.state = (ctx.state + 1).min(62);
        }
        self.renorm();
        bin
    }

    fn terminate(&mut self) -> bool {
        self.range -= 2;
        if self.offset >= self.range {
            true
        } else {
            self.renorm();
            false
        }
    }

    fn renorm(&mut self) {
        while self.range < 256 {
            self.range <<= 1;
            self.offset = (self.offset << 1) | self.r.u1().unwrap_or(0);
        }
    }
}

#[test]
fn cabac_round_trip() {
    let mut seed = 0x1234_5678u32;
    let mut rand = move || {
        seed ^= seed << 13;
        seed ^= seed >> 17;
        seed ^= seed << 5;
        seed
    };
    for round in 0..200 {
        let qp = (rand() % 52) as i32;
        let inits = [(23, 33), (-28, 127), (0, 64), (14, 57), (-17, 73)];
        let mut ctxs: Vec<Context> = inits.iter().map(|&(m, n)| Context::new(m, n, qp)).collect();
        let start = ctxs.clone();
        let n = 1 + rand() as usize % 400;
        // Skewed bins per context, so states run high and low.
        let bins: Vec<(usize, u8, bool)> = (0..n)
            .map(|i| {
                let c = rand() as usize % ctxs.len();
                let bias = [2, 50, 98, 10, 90][c];
                let bin = (rand() % 100 < bias) as u8;
                (c, bin, i + 1 == n || rand() % 50 == 0 && round % 2 == 0)
            })
            .collect();
        let mut w = BitWriter::default();
        let mut enc = CabacEncoder::new(&mut w);
        for &(c, bin, _) in &bins {
            enc.decision(&mut ctxs[c], bin);
        }
        enc.terminate(true);
        w.align_zero();
        let data = w.into_bytes();
        let mut ctxs = start;
        let mut dec = CabacDecoder::new(&data);
        for (i, &(c, bin, _)) in bins.iter().enumerate() {
            assert_eq!(dec.decision(&mut ctxs[c]), bin, "round {round} bin {i}");
        }
        assert!(dec.terminate(), "round {round}");
    }
}

#[test]
fn cabac_terminate_round_trip() {
    // mb_skip_flag and end_of_slice_flag as a skip slice codes them.
    for (qp, idc) in [(51, 2), (0, 0), (22, 0), (30, 1)] {
        for mbs in [1u32, 2, 99, 8160] {
            let (m, n) = MB_SKIP_FLAG_INIT[idc];
            let mut ctx = Context::new(m, n, qp);
            let start = ctx;
            let mut w = BitWriter::default();
            let mut enc = CabacEncoder::new(&mut w);
            for i in 0..mbs {
                enc.decision(&mut ctx, 1);
                enc.terminate(i + 1 == mbs);
            }
            w.align_zero();
            let data = w.into_bytes();
            let mut ctx = start;
            let mut dec = CabacDecoder::new(&data);
            for i in 0..mbs {
                assert_eq!(dec.decision(&mut ctx), 1);
                assert_eq!(dec.terminate(), i + 1 == mbs, "qp {qp} mbs {mbs} mb {i}");
            }
            if qp == 51 && idc == 2 && mbs == 8160 {
                assert!(data.len() < 64, "{} bytes", data.len());
            }
        }
    }
}

#[test]
fn unsupported_streams() {
    let pps = pps_nal(&TestPps::default());
    let refuse = |sps: &[u8], pps: &[u8], why: &str| {
        let e = SkipFrames::new(&avcc_of(sps, pps)).unwrap_err();
        assert_eq!(e.kind(), ErrorKind::Unsupported, "{e}");
        assert!(e.to_string().contains(why), "{e}");
    };
    let fields = sps_nal(&TestSps {
        frame_mbs_only: false,
        ..TestSps::default()
    });
    refuse(&fields, &pps, "field or MBAFF");
    let planes = sps_nal(&TestSps {
        profile_idc: 244,
        chroma_format_idc: 3,
        separate_planes: true,
        ..TestSps::default()
    });
    refuse(&planes, &pps, "colour planes");
    let sps = sps_nal(&TestSps::default());
    let fmo = pps_nal(&TestPps {
        slice_groups: 2,
        ..TestPps::default()
    });
    refuse(&sps, &fmo, "slice groups");
    // 4:4:4 without separate planes and monochrome are fine.
    for chroma_format_idc in [0, 3] {
        let sps = sps_nal(&TestSps {
            profile_idc: 244,
            chroma_format_idc,
            ..TestSps::default()
        });
        SkipFrames::new(&avcc_of(&sps, &pps)).unwrap();
    }
    // An SVC/MVC NAL unit blocks for good.
    let mut s = SkipFrames::new(&avcc_of(&sps, &pps)).unwrap();
    s.observe(&slice(true, 3, 7, 0, |w| w.put(2, 0))).unwrap();
    assert!(s.frame().is_some());
    s.observe(&[0, 0, 0, 2, 0x74, 0x80]).unwrap();
    s.observe(&slice(true, 3, 7, 0, |w| w.put(2, 0))).unwrap();
    assert_eq!(s.frame(), None);
}

#[test]
fn garbage_does_not_panic() {
    let sps = sps_nal(&TestSps {
        poc_type: 0,
        ..TestSps::default()
    });
    let pps = pps_nal(&TestPps {
        cabac: true,
        weighted: true,
        ..TestPps::default()
    });
    let avcc = avcc_of(&sps, &pps);
    assert_eq!(
        SkipFrames::new(&[]).unwrap_err().kind(),
        ErrorKind::Malformed
    );
    assert!(SkipFrames::new(&avcc[..avcc.len() - 3]).is_err());
    let mut seed = 0x9e37_79b9u32;
    let mut rand = move || {
        seed ^= seed << 13;
        seed ^= seed >> 17;
        seed ^= seed << 5;
        seed
    };
    let good = slice(true, 3, 7, 0, |w| {
        w.put(4, 0);
        w.put(2, 0);
    });
    for i in 0..20_000 {
        let len = rand() as usize % 40;
        let mut data: Vec<u8> = (0..len).map(|_| rand() as u8).collect();
        // Mostly well-framed NAL units of the interesting types.
        if i % 4 != 0 && len > 5 {
            let n = (len - 4) as u32;
            data[..4].copy_from_slice(&n.to_be_bytes());
            data[4] = [0x65, 0x41, 0x01, 0x67, 0x68, 0x06][rand() as usize % 6];
        }
        let _ = SkipFrames::new(&data);
        let mut avcc2 = avcc.clone();
        let at = rand() as usize % avcc2.len();
        avcc2[at] ^= 1 << (rand() % 8);
        if let Ok(mut s) = SkipFrames::new(&avcc2) {
            let _ = s.observe(&good);
            let _ = s.observe(&data);
            let _ = s.frame();
        }
        let mut s = SkipFrames::new(&avcc).unwrap();
        s.observe(&good).unwrap();
        // A corrupted slice header.
        let mut bad = good.clone();
        let at = 5 + rand() as usize % (bad.len() - 5);
        bad[at] = rand() as u8;
        let _ = s.observe(&bad);
        let _ = s.observe(&data);
        let _ = s.frame();
    }
    // A truncated slice is an error, and nothing is repeated after it.
    let mut s = SkipFrames::new(&avcc).unwrap();
    s.observe(&good).unwrap();
    assert!(s.frame().is_some());
    assert!(s.observe(&[0, 0, 0, 2, 0x41, 0x9a]).is_err());
    assert_eq!(s.frame(), None);
    assert!(s.observe(&[0, 0, 0, 9, 0x41]).is_err());
    // A slice of an unknown PPS.
    assert!(s.observe(&[0, 0, 0, 2, 0x41, 0b1000_0101]).is_err());
}

// ---------------------------------------------------------------------
// Oracle tests.

fn ffmpeg() -> Option<PathBuf> {
    for cand in [
        "ffmpeg",
        "/opt/homebrew/bin/ffmpeg",
        "/usr/local/bin/ffmpeg",
        "/usr/bin/ffmpeg",
    ] {
        let ok = Command::new(cand)
            .arg("-version")
            .output()
            .is_ok_and(|o| o.status.success());
        if ok {
            return Some(PathBuf::from(cand));
        }
    }
    eprintln!("ffmpeg missing; skipping");
    None
}

fn has_encoder(ff: &Path, name: &str) -> bool {
    let has = Command::new(ff)
        .args(["-hide_banner", "-encoders"])
        .output()
        .is_ok_and(|o| {
            String::from_utf8_lossy(&o.stdout)
                .split_whitespace()
                .any(|w| w == name)
        });
    if !has {
        eprintln!("ffmpeg has no {name}; skipping");
    }
    has
}

fn tmp_path(name: &str) -> PathBuf {
    std::env::temp_dir().join(format!("tvpipe-h264skip-{}-{name}", std::process::id()))
}

/// Encodes ffmpeg's test source to Annex B with these encoder arguments;
/// `None` when the encoder refuses (a build without high bit depth).
fn encode(
    ff: &Path,
    size: &str,
    frames: u32,
    pix_fmt: &str,
    args: &[&str],
    name: &str,
) -> Option<Vec<u8>> {
    let out = tmp_path(&format!("{name}.264"));
    let o = Command::new(ff)
        .args(["-v", "error", "-y", "-f", "lavfi", "-i"])
        .arg(format!("testsrc2=size={size}:rate=25"))
        .args(["-frames:v", &frames.to_string(), "-pix_fmt", pix_fmt])
        .args(args)
        .args(["-f", "h264"])
        .arg(&out)
        .output()
        .unwrap();
    let data = std::fs::read(&out).ok();
    let _ = std::fs::remove_file(&out);
    if !o.status.success() {
        eprintln!(
            "{name}: encoder refused: {}",
            String::from_utf8_lossy(&o.stderr)
        );
        return None;
    }
    data
}

/// A stream: its parameter sets and access units (AVCC, 4-byte lengths).
struct Stream {
    sps: Vec<Vec<u8>>,
    pps: Vec<Vec<u8>>,
    aus: Vec<Vec<u8>>,
}

impl Stream {
    /// Splits Annex B into access units (§7.4.1.2.3: parameter sets, SEI
    /// and AUD start one; so does a slice with first_mb_in_slice 0).
    fn from_annexb(data: &[u8]) -> Stream {
        let mut s = Stream {
            sps: Vec::new(),
            pps: Vec::new(),
            aus: Vec::new(),
        };
        let mut au = Vec::new();
        let mut has_vcl = false;
        for nal in annexb_nals(data) {
            let t = nal[0] & 0x1f;
            let vcl = matches!(t, 1 | 5);
            let starts = if vcl {
                nal[1] & 0x80 != 0
            } else {
                matches!(t, 6..=9)
            };
            if starts && has_vcl {
                s.aus.push(std::mem::take(&mut au));
                has_vcl = false;
            }
            has_vcl |= vcl;
            if t == 7 && !s.sps.contains(&nal.to_vec()) {
                s.sps.push(nal.to_vec());
            }
            if t == 8 && !s.pps.contains(&nal.to_vec()) {
                s.pps.push(nal.to_vec());
            }
            au.extend_from_slice(&(nal.len() as u32).to_be_bytes());
            au.extend_from_slice(nal);
        }
        if has_vcl {
            s.aus.push(au);
        }
        s
    }

    fn avcc(&self) -> Vec<u8> {
        AvcConfig::from_parameter_sets(self.sps.clone(), self.pps.clone())
            .unwrap()
            .to_bytes()
            .unwrap()
    }

    fn annexb(&self, aus: &[Vec<u8>]) -> Vec<u8> {
        let mut out = Vec::new();
        for ps in self.sps.iter().chain(&self.pps) {
            out.extend_from_slice(&[0, 0, 0, 1]);
            out.extend_from_slice(ps);
        }
        for au in aus {
            for nal in avcc_nals(au, 4) {
                out.extend_from_slice(&[0, 0, 0, 1]);
                out.extend_from_slice(nal.unwrap());
            }
        }
        out
    }
}

/// The MD5 of every decoded frame, in output order.
fn decode(ff: &Path, stream: &[u8], name: &str) -> Vec<String> {
    let inp = tmp_path(&format!("{name}-in.264"));
    std::fs::write(&inp, stream).unwrap();
    let o = Command::new(ff)
        .args(["-v", "error", "-threads", "1", "-f", "h264", "-i"])
        .arg(&inp)
        .args(["-fps_mode", "passthrough", "-f", "framemd5", "-"])
        .output()
        .unwrap();
    let _ = std::fs::remove_file(&inp);
    let stderr = String::from_utf8_lossy(&o.stderr);
    assert!(o.status.success(), "{name}: ffmpeg failed: {stderr}");
    assert!(
        stderr.trim().is_empty(),
        "{name}: ffmpeg complained: {stderr}"
    );
    String::from_utf8_lossy(&o.stdout)
        .lines()
        .filter(|l| !l.starts_with('#'))
        .filter_map(|l| l.rsplit(',').next().map(|m| m.trim().to_string()))
        .collect()
}

/// Splices `n` skip frames after each access unit `k` of `pauses`,
/// decodes, and checks: each skip frame shows frame k, every other frame
/// is the unmodified stream's.
fn check_pauses(ff: &Path, s: &Stream, pauses: &[(usize, usize)], name: &str) {
    let plain = decode(ff, &s.annexb(&s.aus), &format!("{name}-plain"));
    assert_eq!(plain.len(), s.aus.len(), "{name}");
    let mut skip = SkipFrames::new(&s.avcc()).unwrap();
    let mut spliced = Vec::new();
    let mut expect = Vec::new();
    for (i, au) in s.aus.iter().enumerate() {
        skip.observe(au).unwrap();
        spliced.push(au.clone());
        expect.push(plain[i].clone());
        for &(_, n) in pauses.iter().filter(|p| p.0 == i) {
            let f = skip
                .frame()
                .unwrap_or_else(|| panic!("{name}: no skip frame after {i}"));
            for _ in 0..n {
                spliced.push(f.clone());
                expect.push(plain[i].clone());
            }
        }
    }
    let got = decode(ff, &s.annexb(&spliced), &format!("{name}-skips"));
    eprintln!(
        "DEBUG {name}: {} frames, {} distinct",
        got.len(),
        got.iter().collect::<std::collections::HashSet<_>>().len()
    );
    assert_eq!(got.len(), expect.len(), "{name}: frame count");
    for (i, (g, e)) in got.iter().zip(&expect).enumerate() {
        assert_eq!(g, e, "{name}: frame {i}");
    }
}

/// x264 pauses: at an IDR, mid-GOP, before an IDR, at the end.
fn x264_pauses(frames: usize) -> Vec<(usize, usize)> {
    vec![(0, 2), (4, 3), (9, 1), (10, 2), (23, 5), (frames - 1, 3)]
}

#[test]
fn oracle_x264() {
    let Some(ff) = ffmpeg() else { return };
    if !has_encoder(&ff, "libx264") {
        return;
    }
    let cases: &[(&str, &str, &[&str])] = &[
        (
            "baseline",
            "yuv420p",
            &["-profile:v", "baseline", "-x264-params", "ref=3"],
        ),
        ("main", "yuv420p", &["-profile:v", "main"]),
        (
            "high",
            "yuv420p",
            &["-profile:v", "high", "-x264-params", "ref=4:weightp=2"],
        ),
        (
            "high-slices",
            "yuv420p",
            &["-profile:v", "high", "-x264-params", "slices=3"],
        ),
        (
            "high-nodeblock",
            "yuv420p",
            &["-x264-params", "no-deblock=1:weightp=1"],
        ),
        ("high-cqp", "yuv420p", &["-qp", "10"]),
        ("high10", "yuv420p10le", &["-profile:v", "high10"]),
        ("high422", "yuv422p", &["-profile:v", "high422"]),
        ("high444-lossless", "yuv444p", &["-qp", "0"]),
        ("gray", "gray", &["-profile:v", "high"]),
        (
            "baseline-cabac-off-main",
            "yuv420p",
            &["-profile:v", "main", "-coder", "0"],
        ),
    ];
    let frames = 40;
    for (name, pix_fmt, args) in cases {
        let mut all = vec![
            "-c:v",
            "libx264",
            "-bf",
            "0",
            "-g",
            "10",
            "-sc_threshold",
            "0",
        ];
        all.extend_from_slice(args);
        let Some(data) = encode(&ff, "320x240", frames, pix_fmt, &all, name) else {
            continue;
        };
        let s = Stream::from_annexb(&data);
        assert_eq!(s.aus.len(), frames as usize, "{name}");
        check_pauses(&ff, &s, &x264_pauses(frames as usize), name);
    }
}

/// Every SliceQPY and cabac_init_idc, so the CABAC tables are checked from
/// every start state: one skip frame of each after one picture.
#[test]
fn oracle_cabac_every_init() {
    let Some(ff) = ffmpeg() else { return };
    if !has_encoder(&ff, "libx264") {
        return;
    }
    let args = [
        "-c:v",
        "libx264",
        "-bf",
        "0",
        "-g",
        "10",
        "-profile:v",
        "high",
    ];
    let Some(data) = encode(&ff, "352x288", 12, "yuv420p", &args, "every-init") else {
        return;
    };
    let s = Stream::from_annexb(&data);
    let plain = decode(&ff, &s.annexb(&s.aus), "every-init-plain");
    let mut skip = SkipFrames::new(&s.avcc()).unwrap();
    let (mut spliced, mut expect) = (Vec::new(), Vec::new());
    for (i, au) in s.aus.iter().enumerate() {
        skip.observe(au).unwrap();
        spliced.push(au.clone());
        expect.push(plain[i].clone());
        if i == 5 {
            for qp in 0..=51 {
                for idc in 0..3 {
                    spliced.push(skip.frame_with(qp, idc).unwrap());
                    expect.push(plain[i].clone());
                }
            }
        }
    }
    let got = decode(&ff, &s.annexb(&spliced), "every-init-skips");
    assert_eq!(got, expect);
}

#[test]
fn oracle_videotoolbox() {
    let Some(ff) = ffmpeg() else { return };
    if !has_encoder(&ff, "h264_videotoolbox") {
        return;
    }
    for profile in ["baseline", "main", "high"] {
        let name = format!("vt-{profile}");
        let args = [
            "-c:v",
            "h264_videotoolbox",
            "-bf",
            "0",
            "-g",
            "10",
            "-profile:v",
            profile,
        ];
        let Some(data) = encode(&ff, "320x240", 40, "yuv420p", &args, &name) else {
            continue;
        };
        let s = Stream::from_annexb(&data);
        // Pause after reference pictures; after the others, `frame` waits.
        let mut skip = SkipFrames::new(&s.avcc()).unwrap();
        let mut pauses = Vec::new();
        for (i, au) in s.aus.iter().enumerate() {
            skip.observe(au).unwrap();
            let nal = avcc_nals(au, 4)
                .map(|n| n.unwrap())
                .find(|n| matches!(n[0] & 0x1f, 1 | 5))
                .unwrap();
            if nal[0] >> 5 == 0 {
                assert_eq!(skip.frame(), None, "{name} {i}");
                assert!(skip.waits_for_reference());
            } else if i % 3 == 0 || i + 1 == s.aus.len() {
                pauses.push((i, 1 + i % 4));
            }
        }
        assert!(pauses.len() > 4, "{name}");
        check_pauses(&ff, &s, &pauses, &name);
    }
}

#[cfg(feature = "h264")]
#[test]
fn oracle_builtin_encoder() {
    use crate::media::convert::Yuv420Frame;
    use crate::media::h264enc::{Config, Encoder};
    use crate::util::ratio::Ratio;
    // Moving gradients and a moving block, so P frames have motion.
    let synth = |w: u32, h: u32, t: u32| {
        let mut f = Yuv420Frame::new(w, h);
        for y in 0..h {
            for x in 0..w {
                let inside = (x + 3 * t) % w < 64 && (y + t) % h < 48;
                let v = if inside {
                    235
                } else {
                    (x * 2 + y + 5 * t) % 200 + 20
                };
                f.y[(y * w + x) as usize] = v as u8;
            }
        }
        for (i, u) in f.u.iter_mut().enumerate() {
            *u = (100 + (i as u32 + t) % 50) as u8;
        }
        f
    };
    let Some(ff) = ffmpeg() else { return };
    for threads in [1, 4] {
        let mut enc = Encoder::new(Config {
            width: 320,
            height: 240,
            fps: Ratio::integer(25),
            bitrate_kbps: 800,
            gop: 10,
            threads,
            ..Config::default()
        })
        .unwrap();
        let (sps, pps) = enc.parameter_sets();
        let mut s = Stream {
            sps: vec![sps.to_vec()],
            pps: vec![pps.to_vec()],
            aus: Vec::new(),
        };
        for t in 0..40 {
            s.aus
                .push(enc.encode(&synth(320, 240, t), false).unwrap().data);
        }
        check_pauses(&ff, &s, &x264_pauses(40), &format!("builtin-{threads}"));
    }
}

// ---------------------------------------------------------------------
// Other POC types and a short frame_num, from x264's Baseline stream (POC
// type 2, CAVLC, so the slice data after the header can be copied bit for
// bit).

/// Copies bits [from, to) of `data`.
fn copy_bits(w: &mut BitWriter, data: &[u8], from: usize, to: usize) {
    for i in from..to {
        w.bit((data[i / 8] >> (7 - i % 8)) & 1 == 1);
    }
}

/// The end of the RBSP's data, before rbsp_stop_one_bit, in bits.
fn rbsp_end(rbsp: &[u8]) -> usize {
    let last = rbsp.iter().rposition(|&b| b != 0).unwrap();
    last * 8 + 7 - rbsp[last].trailing_zeros() as usize
}

#[derive(Clone, Copy)]
enum Poc {
    /// Type 0, pic_order_cnt_lsb = step · (pictures since the IDR), 4 bits.
    Lsb(u32),
    /// Type 1 with offset_for_ref_frame [2], these offset_for_non_ref_pic
    /// and delta_pic_order_always_zero_flag.
    Cycle(i32, bool),
    /// Type 2.
    Frames,
}

/// Rewrites a POC type 2 Baseline stream to log2_max_frame_num 4 and the
/// given POC coding.
fn rewrite(s: &Stream, poc: Poc) -> Stream {
    let reser = |nal: &[u8], f: &dyn Fn(&mut BitReader<'_>, &mut BitWriter, &[u8])| {
        let rbsp = unescape_rbsp(&nal[1..]);
        let mut br = BitReader::new(&rbsp);
        let mut w = BitWriter::default();
        f(&mut br, &mut w, &rbsp);
        copy_bits(&mut w, &rbsp, br.bit, rbsp_end(&rbsp));
        w.trailing();
        rbsp_nal(nal[0], w)
    };
    let log2_max_frame_num = {
        let rbsp = unescape_rbsp(&s.sps[0][1..]);
        let mut br = BitReader::new(&rbsp);
        br.u(24).unwrap();
        br.ue().unwrap();
        br.ue().unwrap() + 4
    };
    let sps = reser(&s.sps[0], &|br, w, rbsp| {
        assert_eq!(br.u(8).unwrap(), 66);
        br.u(16).unwrap();
        br.ue().unwrap();
        copy_bits(w, rbsp, 0, br.bit);
        let _ = br.ue().unwrap();
        assert_eq!(br.ue().unwrap(), 2);
        w.ue(0);
        match poc {
            Poc::Lsb(_) => {
                w.ue(0);
                w.ue(0);
            }
            Poc::Cycle(non_ref, zero) => {
                w.ue(1);
                w.flag(zero);
                w.se(non_ref);
                w.se(0);
                w.ue(1);
                w.se(2);
            }
            Poc::Frames => w.ue(2),
        }
    });
    let pps = &s.pps[0];
    let parsed = parse_pps(pps).unwrap();
    assert!(!parsed.cabac && !parsed.bottom_field_pic_order_in_frame_present);
    let mut since_idr = 0;
    let mut aus = Vec::new();
    for au in &s.aus {
        let mut out = Vec::new();
        let mut first = true;
        for nal in avcc_nals(au, 4) {
            let nal = nal.unwrap();
            let t = nal[0] & 0x1f;
            let new = match t {
                7 => sps.clone(),
                1 | 5 => {
                    if first && t == 5 {
                        since_idr = 0;
                    }
                    first = false;
                    let n = since_idr;
                    reser(nal, &|br, w, rbsp| {
                        br.ue().unwrap();
                        br.ue().unwrap();
                        br.ue().unwrap();
                        copy_bits(w, rbsp, 0, br.bit);
                        let frame_num = br.u(log2_max_frame_num).unwrap();
                        w.put(4, frame_num % 16);
                        if t == 5 {
                            w.ue(br.ue().unwrap());
                        }
                        assert!(
                            nal[0] >> 5 != 0,
                            "x264 Baseline: every picture is a reference"
                        );
                        match poc {
                            Poc::Lsb(step) => w.put(4, (step * n) % 16),
                            Poc::Cycle(_, false) => w.se(0),
                            _ => {}
                        }
                    })
                }
                _ => nal.to_vec(),
            };
            out.extend_from_slice(&(new.len() as u32).to_be_bytes());
            out.extend_from_slice(&new);
        }
        since_idr += 1;
        aus.push(out);
    }
    Stream {
        sps: vec![sps],
        pps: s.pps.clone(),
        aus,
    }
}

#[test]
fn oracle_poc_types() {
    let Some(ff) = ffmpeg() else { return };
    if !has_encoder(&ff, "libx264") {
        return;
    }
    let frames = 60;
    let args = [
        "-c:v",
        "libx264",
        "-bf",
        "0",
        "-g",
        "40",
        "-sc_threshold",
        "0",
        "-profile:v",
        "baseline",
        "-x264-params",
        "ref=3",
    ];
    let Some(data) = encode(&ff, "176x144", frames, "yuv420p", &args, "poc") else {
        return;
    };
    let s = Stream::from_annexb(&data);
    assert_eq!(parse_sps(&s.sps[0]).unwrap().poc_type, 2);
    let plain = decode(&ff, &s.annexb(&s.aus), "poc-orig");
    let pauses = [
        (0, 2),
        (7, 3),
        (15, 2),
        (16, 1),
        (31, 4),
        (39, 2),
        (40, 1),
        (55, 3),
        (59, 1),
    ];
    for (name, poc) in [
        ("lsb2", Poc::Lsb(2)),
        ("lsb1", Poc::Lsb(1)),
        ("cycle", Poc::Cycle(-1, false)),
        ("cycle-zero", Poc::Cycle(1, true)),
        ("frames", Poc::Frames),
    ] {
        let r = rewrite(&s, poc);
        let name = format!("poc-{name}");
        assert_eq!(
            decode(&ff, &r.annexb(&r.aus), &name),
            plain,
            "{name}: rewrite"
        );
        check_pauses(&ff, &r, &pauses, &name);
    }
}
