//! Per-stream Cast sender state: the history of in-flight
//! frames, ACK/NACK handling, retransmission and kickstart, the
//! max-frames-in-flight limits, PLI bookkeeping, round-trip time, and the
//! Sender Report contents.
//!
//! [`StreamSender`] does no I/O and takes the current time as an argument,
//! so it is driven by the sink's threads and tested deterministically.
//!
//! Behaviour follows openscreen's `SenderImpl`, except for the in-flight
//! window:
//!
//! - At most [`MAX_UNACKED_FRAMES`] frame ids between the checkpoint and the
//!   newest frame, and at most [`StreamSender::max_in_flight`] of media
//!   duration in flight: target delay + RTT / 2 (at least 81.667 ms), like
//!   Chromium's `FrameSender::GetAllowedInFlightMediaDuration`. openscreen
//!   uses 2 × RTT capped at ⅔ of the target delay, which drops frames on
//!   Wi-Fi: a Google TV receiver (Sony XR, 2026-11-18) sends its feedback in
//!   bursts with 80–220 ms gaps. A dropped video frame costs us a whole GOP
//!   (no key frames on demand from ffmpeg), so we only drop once frames
//!   would be late anyway.
//! - NACKed packets are re-sent unless they were (re)sent less than one RTT
//!   before the NACK arrived (the NACK is then likely stale).
//! - When everything was sent but the receiver has not acknowledged the
//!   newest frame, the last packet of the newest frame is re-sent after
//!   max(target delay / 20, 2 × RTT) ("kickstart").
//! - A PLI is ignored while a key frame is in flight; otherwise
//!   [`StreamSender::needs_keyframe`] stays true until a key frame is
//!   enqueued.
//!
//! Sources: openscreen `cast/streaming/impl/sender_impl.{h,cc}`,
//! `cast/streaming/sender_packet_router.cc`, `cast/streaming/public/
//! constants.h` and `sender_impl_unittest.cc`.

use std::collections::VecDeque;
use std::time::{Duration, Instant};

use super::rtcp::{Feedback, SenderReport};
use super::rtp::{FrameCrypto, FrameId, OutFrame, Packetizer, ALL_PACKETS_LOST, LEADER};
use crate::error::Result;
use crate::util::time::NtpTime;

/// Span of frame ids that may be unacknowledged (fits the 8-bit wire ids
/// with room for wrap-around).
pub const MAX_UNACKED_FRAMES: usize = 120;
/// Floor of the in-flight window: two 30 fps frames plus 15 ms jitter.
pub const MIN_IN_FLIGHT: Duration = Duration::from_micros(81_667);
/// Interval between Sender Reports.
pub const RTCP_REPORT_INTERVAL: Duration = Duration::from_millis(500);
/// RTT assumed when a measurement comes out at or below zero.
const NEAR_ZERO_RTT: Duration = Duration::from_micros(75);
/// Sender Reports remembered for RTT measurement.
const SR_HISTORY: usize = 32;

/// Static parameters of one stream.
#[derive(Debug, Clone)]
pub struct StreamConfig {
    pub ssrc: u32,
    pub receiver_ssrc: u32,
    pub payload_type: u8,
    pub rtp_timebase: u32,
    pub target_delay: Duration,
    pub aes_key: [u8; 16],
    pub aes_iv_mask: [u8; 16],
    pub max_packet_size: usize,
    pub first_sequence: u16,
}

/// Why a frame was not accepted.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EnqueueError {
    /// Too many frame ids since the last acknowledged one.
    IdSpanLimit,
    /// Too much media duration waits for acknowledgement.
    MaxDurationInFlight,
    /// The frame needs more than 65535 packets.
    PayloadTooLarge,
}

#[derive(Debug, Clone)]
struct Slot {
    frame: OutFrame,
    rtp_timestamp: i64,
    /// Packets that need (re)sending.
    send: Vec<bool>,
    sent_at: Vec<Option<Instant>>,
}

/// What an RTCP packet changed, for the caller.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct RtcpOutcome {
    /// Packets were marked for retransmission.
    pub resend: bool,
    /// The receiver asked for a key frame and we accepted the request.
    pub picture_lost: bool,
    /// Frames were acknowledged (capacity freed).
    pub acked: bool,
}

/// Sender state of one RTP stream.
#[derive(Debug)]
pub struct StreamSender {
    cfg: StreamConfig,
    crypto: FrameCrypto,
    packetizer: Packetizer,
    slots: Vec<Option<Slot>>,
    in_flight: usize,
    last_enqueued: FrameId,
    checkpoint: FrameId,
    latest_expected: FrameId,
    picture_lost_at: FrameId,
    last_key: FrameId,
    target_delay: Duration,
    rtt: Duration,
    // Sender Report state: the newest frame's timing, plus counters.
    sr_reference: Option<Instant>,
    sr_rtp: i64,
    packet_count: u32,
    octet_count: u32,
    sr_history: VecDeque<(u32, Instant)>,
    next_sr: Option<Instant>,
    latest_receiver_ref: Option<u64>,
    last_was_retransmission: bool,
    stats: Stats,
}

/// Counters for logs and tests.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Stats {
    pub frames: u64,
    pub packets: u64,
    pub retransmissions: u64,
    pub kickstarts: u64,
    pub nacks: u64,
    pub plis: u64,
    pub dropped: u64,
}

impl StreamSender {
    pub fn new(cfg: StreamConfig) -> Result<StreamSender> {
        Ok(StreamSender {
            crypto: FrameCrypto::new(&cfg.aes_key, &cfg.aes_iv_mask)?,
            packetizer: Packetizer::new(
                cfg.payload_type,
                cfg.ssrc,
                cfg.max_packet_size,
                cfg.first_sequence,
            ),
            slots: vec![None; MAX_UNACKED_FRAMES],
            in_flight: 0,
            last_enqueued: LEADER,
            checkpoint: LEADER,
            latest_expected: LEADER,
            picture_lost_at: LEADER,
            last_key: LEADER,
            target_delay: cfg.target_delay,
            rtt: Duration::ZERO,
            sr_reference: None,
            sr_rtp: 0,
            packet_count: 0,
            octet_count: 0,
            sr_history: VecDeque::new(),
            next_sr: None,
            latest_receiver_ref: None,
            last_was_retransmission: false,
            stats: Stats::default(),
            cfg,
        })
    }

    pub fn config(&self) -> &StreamConfig {
        &self.cfg
    }

    pub fn stats(&self) -> Stats {
        self.stats
    }

    pub fn rtt(&self) -> Duration {
        self.rtt
    }

    pub fn checkpoint(&self) -> FrameId {
        self.checkpoint
    }

    pub fn last_enqueued(&self) -> FrameId {
        self.last_enqueued
    }

    pub fn in_flight(&self) -> usize {
        self.in_flight
    }

    pub fn was_last_retransmission(&self) -> bool {
        self.last_was_retransmission
    }

    /// True after an accepted PLI until a key frame is enqueued.
    pub fn needs_keyframe(&self) -> bool {
        self.last_key <= self.picture_lost_at && self.picture_lost_at != LEADER
    }

    fn index(id: FrameId) -> usize {
        id.rem_euclid(MAX_UNACKED_FRAMES as i64) as usize
    }

    fn slot(&self, id: FrameId) -> Option<&Slot> {
        self.slots[Self::index(id)]
            .as_ref()
            .filter(|s| s.frame.frame_id == id)
    }

    fn slot_mut(&mut self, id: FrameId) -> Option<&mut Slot> {
        self.slots[Self::index(id)]
            .as_mut()
            .filter(|s| s.frame.frame_id == id)
    }

    /// The in-flight media duration if a frame with `rtp_timestamp` were
    /// added now.
    pub fn in_flight_duration(&self, rtp_timestamp: i64) -> Duration {
        if self.in_flight == 0 {
            return Duration::ZERO;
        }
        let Some(oldest) = self.slot(self.checkpoint + 1) else {
            return Duration::ZERO;
        };
        let ticks = (rtp_timestamp - oldest.rtp_timestamp).max(0) as u64;
        crate::util::time::ticks_to_duration(ticks, self.cfg.rtp_timebase)
    }

    /// The media duration from the oldest unacknowledged frame to the
    /// newest one (adaptive bitrate's backlog; `max_in_flight` is where
    /// frames are dropped).
    pub fn backlog(&self) -> Duration {
        match self.slot(self.last_enqueued) {
            Some(newest) => self.in_flight_duration(newest.rtp_timestamp),
            None => Duration::ZERO,
        }
    }

    /// The current in-flight window: the target delay plus the time an ACK
    /// takes to come back.
    pub fn max_in_flight(&self) -> Duration {
        (self.target_delay + self.rtt / 2).max(MIN_IN_FLIGHT)
    }

    /// Encrypts and queues a frame. `rtp_timestamp` is full-width and must
    /// increase; `reference_time` is when the frame was captured (the
    /// receiver plays it out at `reference_time + target delay`).
    pub fn enqueue(
        &mut self,
        data: &[u8],
        keyframe: bool,
        rtp_timestamp: i64,
        reference_time: Instant,
    ) -> std::result::Result<FrameId, EnqueueError> {
        let id = self.last_enqueued + 1;
        if (id - self.checkpoint) as usize > MAX_UNACKED_FRAMES {
            self.stats.dropped += 1;
            return Err(EnqueueError::IdSpanLimit);
        }
        if self.in_flight_duration(rtp_timestamp) > self.max_in_flight() {
            self.stats.dropped += 1;
            return Err(EnqueueError::MaxDurationInFlight);
        }
        let Some(count) = self.packetizer.packet_count(data.len()) else {
            self.stats.dropped += 1;
            return Err(EnqueueError::PayloadTooLarge);
        };
        let mut enc = data.to_vec();
        self.crypto.apply(id, &mut enc);
        let frame = OutFrame {
            frame_id: id,
            keyframe,
            referenced_frame_id: if keyframe { id } else { id - 1 },
            rtp_timestamp: rtp_timestamp as u32,
            new_playout_delay_ms: 0,
            data: enc,
        };
        self.slots[Self::index(id)] = Some(Slot {
            frame,
            rtp_timestamp,
            send: vec![true; count as usize],
            sent_at: vec![None; count as usize],
        });
        self.in_flight += 1;
        self.last_enqueued = id;
        if keyframe {
            self.last_key = id;
        }
        self.sr_reference = Some(match self.sr_reference {
            Some(prev) if id != 0 => prev.max(reference_time),
            _ => reference_time,
        });
        self.sr_rtp = rtp_timestamp;
        // Until the receiver has reported once, send a Sender Report right
        // away: it needs one to map RTP to wall-clock time.
        if self.rtt.is_zero() {
            self.next_sr = None;
        }
        self.stats.frames += 1;
        Ok(id)
    }

    /// True if [`StreamSender::next_packet`] has a packet now.
    pub fn has_pending(&self) -> bool {
        self.first_pending().is_some()
    }

    fn first_pending(&self) -> Option<(FrameId, u16)> {
        (self.checkpoint + 1..=self.last_enqueued).find_map(|id| {
            let s = self.slot(id)?;
            s.send.iter().position(|&b| b).map(|p| (id, p as u16))
        })
    }

    /// When a kickstart packet would be due, if one is needed.
    fn kickstart(&self) -> Option<(Instant, FrameId, u16)> {
        if self.latest_expected >= self.last_enqueued {
            return None;
        }
        let s = self.slot(self.last_enqueued)?;
        let pid = s.send.len() - 1;
        let sent = s.sent_at[pid]?;
        let interval = (self.target_delay / 20).max(self.rtt * 2);
        Some((sent + interval, self.last_enqueued, pid as u16))
    }

    /// Earliest time this stream wants to send something (RTP or RTCP).
    pub fn next_wakeup(&self, now: Instant) -> Option<Instant> {
        let rtp = if self.has_pending() {
            Some(now)
        } else {
            self.kickstart().map(|(t, _, _)| t)
        };
        let rtcp = self.sr_reference.map(|_| self.next_sr.unwrap_or(now));
        match (rtp, rtcp) {
            (Some(a), Some(b)) => Some(a.min(b)),
            (a, b) => a.or(b),
        }
    }

    /// Writes the next RTP packet due at `now` into `out`. Returns false if
    /// nothing is due.
    pub fn next_packet(&mut self, now: Instant, out: &mut Vec<u8>) -> bool {
        let (id, pid, kick) = match self.first_pending() {
            Some((id, pid)) => (id, pid, false),
            None => match self.kickstart() {
                Some((when, id, pid)) if when <= now => (id, pid, true),
                _ => return false,
            },
        };
        let Some(i) = self.slot(id).map(|_| Self::index(id)) else {
            return false;
        };
        let Some(slot) = self.slots[i].as_mut() else {
            return false;
        };
        let retrans = slot.sent_at[pid as usize].is_some();
        if self.packetizer.packet(&slot.frame, pid, out).is_err() {
            slot.send[pid as usize] = false;
            return false;
        }
        slot.send[pid as usize] = false;
        slot.sent_at[pid as usize] = Some(now);
        self.last_was_retransmission = retrans;
        self.packet_count = self.packet_count.wrapping_add(1);
        self.octet_count = self
            .octet_count
            .wrapping_add(out.len().saturating_sub(super::rtp::BASE_HEADER_SIZE) as u32);
        self.stats.packets += 1;
        if kick {
            self.stats.kickstarts += 1;
            trace!("kickstart ssrc {} frame {id} packet {pid}", self.cfg.ssrc);
        } else if retrans {
            self.stats.retransmissions += 1;
        }
        true
    }

    /// The Sender Report due at `now`, if any. `ntp` maps instants to NTP.
    pub fn sender_report(
        &mut self,
        now: Instant,
        ntp: impl Fn(Instant) -> NtpTime,
    ) -> Option<Vec<u8>> {
        let reference = self.sr_reference?;
        if self.next_sr.is_some_and(|t| t > now) {
            return None;
        }
        // Project the newest frame's RTP timestamp to the send time.
        let rtp = if now >= reference {
            self.sr_rtp
                + crate::util::time::duration_to_ticks(now - reference, self.cfg.rtp_timebase)
                    as i64
        } else {
            self.sr_rtp
                - crate::util::time::duration_to_ticks(reference - now, self.cfg.rtp_timebase)
                    as i64
        };
        let sr = SenderReport {
            ssrc: self.cfg.ssrc,
            ntp: ntp(now).0,
            rtp_timestamp: rtp as u32,
            packet_count: self.packet_count,
            octet_count: self.octet_count,
        };
        if self.sr_history.len() == SR_HISTORY {
            self.sr_history.pop_front();
        }
        self.sr_history.push_back((sr.report_id(), now));
        self.next_sr = Some(now + RTCP_REPORT_INTERVAL);
        Some(sr.build())
    }

    /// Handles one compound RTCP packet from the receiver.
    pub fn on_rtcp(&mut self, buf: &[u8], arrival: Instant) -> Result<RtcpOutcome> {
        let fb = Feedback::parse(
            buf,
            self.cfg.receiver_ssrc,
            self.cfg.ssrc,
            self.last_enqueued,
        )?;
        trace!(
            "rtcp ssrc {}: checkpoint {:?} acks {:?} nacks {:?} pli {} report {:?} logs {} (last sent {})",
            self.cfg.ssrc,
            fb.checkpoint,
            fb.received_frames,
            fb.nacks,
            fb.picture_loss,
            fb.report.map(|r| (r.last_sr, r.delay_since_last_sr, r.cumulative_lost)),
            fb.logs.len(),
            self.last_enqueued
        );
        let mut out = RtcpOutcome::default();
        if let Some(t) = fb.receiver_reference_ntp {
            // Drop stale packets the network reordered.
            if self.latest_receiver_ref.is_some_and(|l| t < l) {
                return Ok(out);
            }
            self.latest_receiver_ref = Some(t);
        }
        if let Some(rb) = fb.report {
            self.on_report(rb.last_sr, rb.delay_since_last_sr, arrival);
        }
        if let Some((cp, delay)) = fb.checkpoint {
            out.acked |= self.on_checkpoint(cp, delay);
        }
        if !fb.received_frames.is_empty() {
            out.acked |= self.on_acks(&fb.received_frames);
        }
        if !fb.nacks.is_empty() {
            out.resend = self.on_nacks(&fb.nacks, arrival);
        }
        if fb.picture_loss {
            out.picture_lost = self.on_pli();
        }
        Ok(out)
    }

    fn on_report(&mut self, last_sr: u32, delay: u32, arrival: Instant) {
        if last_sr == 0 {
            return;
        }
        let Some(&(_, sent)) = self.sr_history.iter().rev().find(|(id, _)| *id == last_sr) else {
            return;
        };
        let total = arrival.saturating_duration_since(sent);
        let non_network = Duration::from_nanos((delay as u64 * 1_000_000_000) >> 16);
        let measured = total
            .saturating_sub(non_network)
            .max(NEAR_ZERO_RTT)
            .min(self.target_delay);
        self.rtt = smooth_rtt(self.rtt, measured);
    }

    fn cancel(&mut self, id: FrameId) -> bool {
        let i = Self::index(id);
        if self.slots[i]
            .as_ref()
            .is_some_and(|s| s.frame.frame_id == id)
        {
            self.slots[i] = None;
            self.in_flight -= 1;
            true
        } else {
            false
        }
    }

    fn on_checkpoint(&mut self, cp: FrameId, delay_ms: u16) -> bool {
        if cp > self.last_enqueued {
            debug!(
                "ignoring checkpoint {cp} beyond frame {}",
                self.last_enqueued
            );
            return false;
        }
        let mut acked = false;
        while self.checkpoint < cp {
            self.checkpoint += 1;
            acked |= self.cancel(self.checkpoint);
        }
        self.latest_expected = self.latest_expected.max(cp);
        if delay_ms as u128 != self.target_delay.as_millis() {
            trace!(
                "receiver playout delay {delay_ms} ms, ours {:?}",
                self.target_delay
            );
        }
        acked
    }

    fn on_acks(&mut self, acks: &[FrameId]) -> bool {
        let Some(&last) = acks.last() else {
            return false;
        };
        if last > self.last_enqueued {
            return false;
        }
        let mut acked = false;
        for &id in acks {
            acked |= self.cancel(id);
        }
        self.latest_expected = self.latest_expected.max(last);
        acked
    }

    fn on_nacks(&mut self, nacks: &[super::rtcp::PacketNack], arrival: Instant) -> bool {
        // A NACK may have crossed the packet in flight; only resend what
        // was sent at least one RTT before the NACK arrived.
        let too_recent = arrival.checked_sub(self.rtt);
        let mut resend = false;
        let mut i = 0;
        while i < nacks.len() {
            let id = nacks[i].frame_id;
            let mut j = i;
            while j < nacks.len() && nacks[j].frame_id == id {
                j += 1;
            }
            if id <= self.last_enqueued {
                if let Some(slot) = self.slot_mut(id) {
                    let n = slot.send.len();
                    let mark = |p: usize, slot: &mut Slot| {
                        let old_enough = match (slot.sent_at[p], too_recent) {
                            (None, _) => true,
                            (Some(t), Some(limit)) => t <= limit,
                            (Some(_), None) => false,
                        };
                        if old_enough {
                            slot.send[p] = true;
                        }
                        old_enough
                    };
                    let mut any = false;
                    for nack in &nacks[i..j] {
                        if nack.packet_id == ALL_PACKETS_LOST {
                            for p in 0..n {
                                any |= mark(p, slot);
                            }
                        } else if (nack.packet_id as usize) < n {
                            any |= mark(nack.packet_id as usize, slot);
                        }
                    }
                    resend |= any;
                    self.latest_expected = self.latest_expected.max(id);
                }
            }
            self.stats.nacks += (j - i) as u64;
            i = j;
        }
        resend
    }

    fn on_pli(&mut self) -> bool {
        self.stats.plis += 1;
        if self.checkpoint < self.last_key {
            // A key frame is already on its way.
            return false;
        }
        self.picture_lost_at = self.checkpoint.max(self.last_key);
        true
    }
}

/// Fast attack, slow decay (openscreen `SmoothRoundTripTime`).
pub fn smooth_rtt(estimate: Duration, measurement: Duration) -> Duration {
    if estimate.is_zero() {
        measurement
    } else if measurement > estimate {
        (estimate + measurement) / 2
    } else {
        (estimate * 7 + measurement) / 8
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cast::rtcp::{PacketNack, ReceiverPacket, ReportBlock};
    use crate::cast::rtp::{RtpPacket, MAX_PACKET_SIZE_IPV4};

    const SSRC: u32 = 50_001;
    const RX: u32 = 99;

    fn sender(delay_ms: u64) -> StreamSender {
        StreamSender::new(StreamConfig {
            ssrc: SSRC,
            receiver_ssrc: RX,
            payload_type: 101,
            rtp_timebase: 90_000,
            target_delay: Duration::from_millis(delay_ms),
            aes_key: [1; 16],
            aes_iv_mask: [2; 16],
            max_packet_size: MAX_PACKET_SIZE_IPV4,
            first_sequence: 0,
        })
        .unwrap()
    }

    fn drain(s: &mut StreamSender, now: Instant) -> Vec<Vec<u8>> {
        let mut out = Vec::new();
        let mut buf = Vec::new();
        while s.next_packet(now, &mut buf) {
            out.push(buf.clone());
        }
        out
    }

    fn feedback(checkpoint: FrameId, nacks: Vec<PacketNack>, acks: Vec<FrameId>) -> Vec<u8> {
        ReceiverPacket {
            receiver_ssrc: RX,
            sender_ssrc: SSRC,
            checkpoint,
            playout_delay_ms: 400,
            nacks,
            acks,
            ..Default::default()
        }
        .build()
    }

    const FRAME_TICKS: i64 = 3000; // 30 fps

    #[test]
    fn sends_encrypted_frames_and_acks() {
        let t0 = Instant::now();
        let mut s = sender(400);
        let data = vec![7u8; 3000];
        assert_eq!(s.enqueue(&data, true, 1000, t0), Ok(0));
        let pkts = drain(&mut s, t0);
        assert_eq!(pkts.len(), 3);
        let mut joined = Vec::new();
        for (i, p) in pkts.iter().enumerate() {
            let rp = RtpPacket::parse(p).unwrap();
            assert_eq!(rp.packet_id as usize, i);
            assert_eq!(rp.max_packet_id, 2);
            assert!(rp.keyframe);
            assert_eq!(rp.rtp_timestamp, 1000);
            joined.extend_from_slice(rp.payload);
        }
        FrameCrypto::new(&[1; 16], &[2; 16])
            .unwrap()
            .apply(0, &mut joined);
        assert_eq!(joined, data);
        assert_eq!(s.in_flight(), 1);
        let out = s.on_rtcp(&feedback(0, vec![], vec![]), t0).unwrap();
        assert!(out.acked);
        assert_eq!(s.in_flight(), 0);
        assert_eq!(s.checkpoint(), 0);
        // Nothing left: no kickstart either.
        assert!(!s.next_packet(t0 + Duration::from_secs(1), &mut Vec::new()));
    }

    #[test]
    fn frame_level_acks_and_bogus_feedback() {
        let t0 = Instant::now();
        let mut s = sender(400);
        s.rtt = Duration::from_millis(100);
        for i in 0..4 {
            s.enqueue(&[i as u8; 10], i == 0, i * FRAME_TICKS, t0)
                .unwrap();
        }
        drain(&mut s, t0);
        // ACK 2 and 3 individually while 1 is missing.
        s.on_rtcp(&feedback(0, vec![], vec![2, 3]), t0).unwrap();
        assert_eq!(s.in_flight(), 1);
        // A checkpoint beyond what we sent is ignored.
        s.on_rtcp(&feedback(9, vec![], vec![]), t0).unwrap();
        assert_eq!(s.checkpoint(), 0);
        s.on_rtcp(&feedback(3, vec![], vec![]), t0).unwrap();
        assert_eq!(s.in_flight(), 0);
        assert_eq!(s.checkpoint(), 3);
        // Garbage is an error, not a panic.
        assert!(s.on_rtcp(&[0xff; 9], t0).is_err());
    }

    #[test]
    fn resends_nacked_packets_after_rtt() {
        let t0 = Instant::now();
        let mut s = sender(400);
        s.enqueue(&vec![1u8; 5000], true, 0, t0).unwrap();
        let first = drain(&mut s, t0);
        assert_eq!(first.len(), 4);
        // RTT unknown (zero): any NACK after sending is honoured.
        let n = |p| PacketNack {
            frame_id: 0,
            packet_id: p,
        };
        let t1 = t0 + Duration::from_millis(5);
        let out = s
            .on_rtcp(&feedback(LEADER, vec![n(1), n(3)], vec![]), t1)
            .unwrap();
        assert!(out.resend);
        let again = drain(&mut s, t1);
        assert_eq!(again.len(), 2);
        let ids: Vec<u16> = again
            .iter()
            .map(|p| RtpPacket::parse(p).unwrap().packet_id)
            .collect();
        assert_eq!(ids, vec![1, 3]);
        // Retransmissions get fresh sequence numbers.
        assert_eq!(RtpPacket::parse(&again[0]).unwrap().sequence, 4);
        assert_eq!(s.stats().retransmissions, 2);
        // With an RTT of 20 ms, a NACK 5 ms after the resend is stale.
        s.rtt = Duration::from_millis(20);
        let out = s
            .on_rtcp(
                &feedback(LEADER, vec![n(1)], vec![]),
                t1 + Duration::from_millis(5),
            )
            .unwrap();
        assert!(!out.resend);
        let out = s
            .on_rtcp(
                &feedback(
                    LEADER,
                    vec![PacketNack {
                        frame_id: 0,
                        packet_id: ALL_PACKETS_LOST,
                    }],
                    vec![],
                ),
                t1 + Duration::from_millis(30),
            )
            .unwrap();
        assert!(out.resend);
        assert_eq!(drain(&mut s, t1 + Duration::from_millis(30)).len(), 4);
        // NACKs for unknown frames or packets are ignored.
        let out = s
            .on_rtcp(
                &feedback(
                    LEADER,
                    vec![
                        PacketNack {
                            frame_id: 5,
                            packet_id: 0,
                        },
                        n(77),
                    ],
                    vec![],
                ),
                t1 + Duration::from_secs(1),
            )
            .unwrap();
        assert!(!out.resend);
    }

    #[test]
    fn kickstarts_when_receiver_is_silent() {
        let t0 = Instant::now();
        let mut s = sender(400);
        s.enqueue(&vec![1u8; 3000], true, 0, t0).unwrap();
        drain(&mut s, t0);
        let mut buf = Vec::new();
        // target delay / 20 = 20 ms.
        let t1 = t0 + Duration::from_millis(1);
        assert_eq!(s.next_wakeup(t1), Some(t1)); // Sender Report due
        s.sender_report(t0, |_| NtpTime(0)).unwrap();
        assert_eq!(
            s.next_wakeup(t0).map(|t| t - t0),
            Some(Duration::from_millis(20))
        );
        assert!(!s.next_packet(t0 + Duration::from_millis(19), &mut buf));
        assert!(s.next_packet(t0 + Duration::from_millis(20), &mut buf));
        let p = RtpPacket::parse(&buf).unwrap();
        assert_eq!(p.packet_id, 2); // the last packet
        assert_eq!(s.stats().kickstarts, 1);
        // Once the receiver knows the frame (a NACK names it), no kickstart.
        s.on_rtcp(
            &feedback(
                LEADER,
                vec![PacketNack {
                    frame_id: 0,
                    packet_id: 0,
                }],
                vec![],
            ),
            t0 + Duration::from_millis(21),
        )
        .unwrap();
        drain(&mut s, t0 + Duration::from_millis(21));
        assert!(!s.next_packet(t0 + Duration::from_secs(5), &mut buf));
    }

    #[test]
    fn limits_frames_in_flight() {
        let t0 = Instant::now();
        let mut s = sender(200);
        // Target delay 200 ms, RTT unknown: frames 0..=6 fit (the seventh
        // spans 200 ms), the eighth would make 233 ms.
        for i in 0..7 {
            assert!(s.enqueue(&[0; 100], i == 0, i * FRAME_TICKS, t0).is_ok());
        }
        assert_eq!(
            s.enqueue(&[0; 100], false, 7 * FRAME_TICKS, t0),
            Err(EnqueueError::MaxDurationInFlight)
        );
        assert_eq!(s.stats().dropped, 1);
        // Half the RTT is added: with 100 ms, 250 ms fit.
        s.rtt = Duration::from_millis(100);
        assert_eq!(s.max_in_flight(), Duration::from_millis(250));
        assert!(s.enqueue(&[0; 100], false, 7 * FRAME_TICKS, t0).is_ok());
        // Tiny target delays keep the floor.
        assert_eq!(sender(10).max_in_flight(), MIN_IN_FLIGHT);

        // The id span limit applies even with tiny durations.
        let mut s = sender(400);
        s.rtt = Duration::from_secs(1);
        for i in 0..MAX_UNACKED_FRAMES as i64 {
            assert!(s.enqueue(&[0; 1], false, i, t0).is_ok(), "frame {i}");
        }
        assert_eq!(
            s.enqueue(&[0; 1], false, 1000, t0),
            Err(EnqueueError::IdSpanLimit)
        );
        s.on_rtcp(&feedback(0, vec![], vec![]), t0).unwrap();
        assert!(s.enqueue(&[0; 1], false, 1001, t0).is_ok());
        // Frame ids wrap around the slot ring correctly.
        assert_eq!(s.last_enqueued(), MAX_UNACKED_FRAMES as i64);
        assert!(s.has_pending());
    }

    #[test]
    fn picture_loss_workflow() {
        let t0 = Instant::now();
        let mut s = sender(400);
        s.enqueue(&[0; 10], true, 0, t0).unwrap();
        s.enqueue(&[0; 10], false, FRAME_TICKS, t0).unwrap();
        drain(&mut s, t0);
        let pli = ReceiverPacket {
            receiver_ssrc: RX,
            sender_ssrc: SSRC,
            picture_loss: true,
            checkpoint: LEADER,
            playout_delay_ms: 400,
            ..Default::default()
        };
        // Key frame 0 still in flight: PLI ignored.
        assert!(!s.on_rtcp(&pli.build(), t0).unwrap().picture_lost);
        assert!(!s.needs_keyframe());
        let pli = ReceiverPacket {
            checkpoint: 1,
            ..pli
        };
        assert!(s.on_rtcp(&pli.build(), t0).unwrap().picture_lost);
        assert!(s.needs_keyframe());
        s.enqueue(&[0; 10], false, 2 * FRAME_TICKS, t0).unwrap();
        assert!(s.needs_keyframe());
        s.enqueue(&[0; 10], true, 3 * FRAME_TICKS, t0).unwrap();
        assert!(!s.needs_keyframe());
    }

    #[test]
    fn sender_reports_and_rtt() {
        let t0 = Instant::now();
        let base = NtpTime(0xe073_2e54_0000_0000);
        let ntp =
            |t: Instant| NtpTime(base.0 + (((t - t0).as_nanos() << 32) / 1_000_000_000) as u64);
        let mut s = sender(400);
        assert!(s.sender_report(t0, ntp).is_none()); // no frame yet
        s.enqueue(&[0; 10], true, 90_000, t0).unwrap();
        let t1 = t0 + Duration::from_millis(100);
        let sr_bytes = s.sender_report(t1, ntp).unwrap();
        let sr = SenderReport::parse(&sr_bytes, SSRC).unwrap().unwrap();
        assert_eq!(sr.rtp_timestamp, 90_000 + 9000);
        assert_eq!(sr.ntp, ntp(t1).0);
        assert!(s
            .sender_report(t1 + Duration::from_millis(10), ntp)
            .is_none());
        drain(&mut s, t1);
        // Next: a kickstart (frame not acknowledged) before the next report.
        assert_eq!(
            s.next_wakeup(t1 + Duration::from_millis(10)),
            Some(t1 + Duration::from_millis(20))
        );
        // Receiver answers 30 ms later, having held the report for 10 ms.
        let rr = ReceiverPacket {
            receiver_ssrc: RX,
            sender_ssrc: SSRC,
            report: Some(ReportBlock {
                ssrc: SSRC,
                last_sr: sr.report_id(),
                delay_since_last_sr: 655, // ~10 ms
                ..Default::default()
            }),
            checkpoint: LEADER,
            playout_delay_ms: 400,
            ..Default::default()
        };
        s.on_rtcp(&rr.build(), t1 + Duration::from_millis(30))
            .unwrap();
        let rtt = s.rtt().as_micros();
        assert!((19_900..=20_100).contains(&rtt), "rtt {rtt}");
        assert_eq!(sr.packet_count, 0);
        let sr2 = s.sender_report(t1 + RTCP_REPORT_INTERVAL, ntp).unwrap();
        let sr2 = SenderReport::parse(&sr2, SSRC).unwrap().unwrap();
        assert_eq!(sr2.packet_count, 1);
        assert_eq!(sr2.octet_count, 10);
    }

    #[test]
    fn rtt_smoothing() {
        let ms = Duration::from_millis;
        assert_eq!(smooth_rtt(Duration::ZERO, ms(10)), ms(10));
        assert_eq!(smooth_rtt(ms(10), ms(30)), ms(20));
        assert_eq!(smooth_rtt(ms(80), ms(0)), ms(70));
    }
}
