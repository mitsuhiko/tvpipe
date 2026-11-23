//! Fanout: one encode to many sinks (ARCHITECTURE.md, "Fanout").
//!
//! Each sink gets a bounded queue and its own thread, so a slow receiver
//! never stalls the demuxer or the other receivers. Policy per sink:
//!
//! - Audio of another [`AudioFamily`] is not queued.
//! - A sink starts in "waiting for keyframe" state; video is dropped until
//!   the next keyframe.
//! - When the queue is full, the new frame is dropped; if it was video, the
//!   sink waits for the next keyframe again (later frames would reference
//!   the dropped one).
//! - When the sink reports [`Sink::wants_keyframe`] (PLI, loss), queued and
//!   new non-key video is dropped until the next keyframe.
//! - [`SinkStatus::Finished`] or an error removes the sink; the others go on.
//! - [`Fanout::backlogs`]: how far behind each sink is (its own
//!   [`Sink::backlog`], sampled after each video frame, plus this queue),
//!   for adaptive bitrate (`media::abr`).
//!
//! Timing (ARCHITECTURE.md, "Several Receivers"): the fanout owns the session's [`MediaClock`]
//! and hands it to every sink ([`Sink::set_clock`]) before `start()`.
//! Each frame is scheduled on it as it leaves the input
//! ([`MediaClock::schedule`]: anchored on the first frame, re-anchored
//! after a stall or a jump), before any per-sink queueing, so every
//! receiver gets the same capture instant for the same frame.
//!
//! Sources: ARCHITECTURE.md, "Fanout" (no keyframes on demand: skip to the
//! next IDR), "Timing and Latency" (one budget for every receiver).

use std::collections::VecDeque;
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use crate::error::{Error, Result};
use crate::events::{Events, ReceiverState};
use crate::media::clock::{MediaClock, SessionClock, Tolerance};
use crate::types::StreamInfo;
use crate::types::{
    AudioFamily, Backlog, EncodedFrame, Sink, SinkStatus, TrackKind, VIDEO_CLOCK_RATE,
};
use crate::util::stop::Stop;

/// The backlog limit of a sink that reports none: past it, about half of
/// the default queue is full at 60 fps.
pub const FANOUT_BACKLOG_LIMIT: Duration = Duration::from_millis(500);

#[derive(Debug, Clone)]
pub struct FanoutConfig {
    /// Frames queued per sink (video and audio together).
    pub max_frames: usize,
    /// Bytes queued per sink.
    pub max_bytes: usize,
    /// Where receiver state changes go.
    pub events: Events,
}

impl Default for FanoutConfig {
    fn default() -> FanoutConfig {
        // About half a second of 60 fps video plus 10 ms audio.
        FanoutConfig {
            max_frames: 96,
            max_bytes: 16 << 20,
            events: Events::none(),
        }
    }
}

/// Per-sink counters.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SinkStats {
    /// Frames handed to `Sink::push`.
    pub pushed: u64,
    /// `push` returned `Dropped`.
    pub sink_dropped: u64,
    /// Dropped because the queue was full.
    pub dropped_full: u64,
    /// Video dropped while waiting for a keyframe.
    pub dropped_waiting: u64,
}

/// How a sink ended.
#[derive(Debug)]
pub enum SinkEnd {
    /// Ran until the fanout closed and `stop()` succeeded.
    Stopped,
    /// The receiver ended the session.
    Finished,
    /// `start`, `push` or `stop` failed.
    Failed(Error),
}

/// A queued frame with the instant the session scheduled it at.
struct Queued {
    frame: EncodedFrame,
    /// `(rate, instant)`; `None` for audio of a family without a track.
    at: Option<(u32, Instant)>,
    /// When it was queued (the queue's age, [`Fanout::backlogs`]).
    queued: Instant,
}

struct State {
    queue: VecDeque<Queued>,
    bytes: usize,
    /// Drop non-key video until a keyframe is queued.
    waiting_for_key: bool,
    /// No more frames will come.
    closed: bool,
    /// Discard the queue instead of draining it on close.
    abort: bool,
    /// The sink thread is gone; drop everything.
    dead: bool,
    /// `start()` returned (successfully or not).
    started: bool,
    /// What the sink's `wants_keyframe()` said when last polled (before
    /// pushing a video frame).
    sink_wants_key: bool,
    /// What the sink's `backlog()` said after its last video frame.
    backlog: Option<Backlog>,
    stats: SinkStats,
}

struct Shared {
    state: Mutex<State>,
    cond: Condvar,
}

impl Shared {
    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }
}

struct Handle {
    name: String,
    family: AudioFamily,
    shared: Arc<Shared>,
    thread: Option<JoinHandle<SinkEnd>>,
}

pub struct Fanout {
    sinks: Vec<Handle>,
    config: FanoutConfig,
    clock: Arc<MediaClock>,
    /// Sample rate per audio family (for scheduling audio on the clock).
    audio_rates: Vec<(AudioFamily, u32)>,
}

impl Fanout {
    /// Starts one thread per sink; each calls `start()` with the video
    /// info and the audio track of its family, then pushes frames.
    pub fn new(
        sinks: Vec<Box<dyn Sink>>,
        info: &StreamInfo,
        config: FanoutConfig,
    ) -> Result<Fanout> {
        let clock = Arc::new(MediaClock::new());
        let mut handles = Vec::with_capacity(sinks.len());
        for mut sink in sinks {
            let view = SessionClock::new(clock.clone());
            sink.set_clock(view.clone());
            let name = sink.name().to_owned();
            let family = sink.capabilities().audio_family;
            let shared = Arc::new(Shared {
                state: Mutex::new(State {
                    queue: VecDeque::new(),
                    bytes: 0,
                    waiting_for_key: true,
                    closed: false,
                    abort: false,
                    dead: false,
                    started: false,
                    sink_wants_key: false,
                    backlog: None,
                    stats: SinkStats::default(),
                }),
                cond: Condvar::new(),
            });
            let video = info.video.clone();
            let audio = info.audio_for(family).cloned();
            let thread_shared = shared.clone();
            let events = config.events.clone();
            let thread = std::thread::Builder::new()
                .name(format!("sink-{name}"))
                .spawn(move || {
                    let end =
                        run_sink(sink, &video, audio.as_ref(), &thread_shared, &view, &events);
                    let mut st = thread_shared.lock();
                    st.dead = true;
                    st.started = true;
                    st.queue.clear();
                    st.bytes = 0;
                    drop(st);
                    thread_shared.cond.notify_all();
                    end
                })
                .map_err(|e| Error::io("spawn sink thread", e))?;
            handles.push(Handle {
                name,
                family,
                shared,
                thread: Some(thread),
            });
        }
        Ok(Fanout {
            sinks: handles,
            config,
            clock,
            audio_rates: info
                .audio
                .iter()
                .map(|(f, a)| (*f, a.sample_rate.max(1)))
                .collect(),
        })
    }

    /// The session's media clock (the one every sink was given).
    pub fn clock(&self) -> &Arc<MediaClock> {
        &self.clock
    }

    /// Queues a frame for every sink that takes it. Never blocks on sinks.
    pub fn push(&self, frame: &EncodedFrame) {
        let rate = match frame.track {
            TrackKind::Video => Some(VIDEO_CLOCK_RATE),
            TrackKind::Audio(f) => self
                .audio_rates
                .iter()
                .find(|(family, _)| *family == f)
                .map(|(_, r)| *r),
        };
        let now = Instant::now();
        let at = rate.map(|rate| {
            let t = self
                .clock
                .schedule(frame.pts, rate, now, Tolerance::DEFAULT);
            (rate, t)
        });
        for h in &self.sinks {
            if let TrackKind::Audio(f) = frame.track {
                if f != h.family {
                    continue;
                }
            }
            let mut st = h.shared.lock();
            if st.dead || st.closed {
                continue;
            }
            let video = frame.track == TrackKind::Video;
            if video && st.waiting_for_key {
                if !frame.keyframe {
                    st.stats.dropped_waiting += 1;
                    continue;
                }
                st.waiting_for_key = false;
            }
            let full = st.queue.len() >= self.config.max_frames
                || st.bytes + frame.data.len() > self.config.max_bytes;
            if full {
                st.stats.dropped_full += 1;
                if video {
                    if !st.waiting_for_key {
                        debug!("{}: queue full, skipping to the next keyframe", h.name);
                    }
                    st.waiting_for_key = true;
                }
                continue;
            }
            st.bytes += frame.data.len();
            st.queue.push_back(Queued {
                frame: frame.clone(),
                at,
                queued: now,
            });
            drop(st);
            h.shared.cond.notify_one();
        }
    }

    /// Waits until every sink's `start()` returned, at most `timeout`
    /// (polling `stop`). A live source pulled before that piles up frames
    /// in the queues of sinks that are still setting up, and they anchor
    /// their clocks on the stale first one: the backlog would become
    /// latency. Returns whether all sinks started in time.
    pub fn wait_started(&self, timeout: Duration, stop: &Stop) -> bool {
        let until = Instant::now() + timeout;
        for h in &self.sinks {
            let mut st = h.shared.lock();
            while !st.started {
                let now = Instant::now();
                if now >= until || stop.requested() {
                    return false;
                }
                let wait = (until - now).min(Duration::from_millis(50));
                st = h
                    .shared
                    .cond
                    .wait_timeout(st, wait)
                    .map(|(g, _)| g)
                    .unwrap_or_else(|e| e.into_inner().0);
            }
        }
        true
    }

    /// Whether some running sink is waiting for a keyframe: it just
    /// joined, its queue overflowed, or its receiver asked (PLI, loss).
    ///
    /// A *hint* polled by the session, not an event: it stays true until
    /// a keyframe went through, and the sink's own `wants_keyframe()` is
    /// only sampled when a video frame is about to be pushed to it. A
    /// source that can make keyframes on demand (an encoding game) is
    /// asked for one while this is true, rate-limited by the source.
    pub fn keyframe_wanted(&self) -> bool {
        self.sinks.iter().any(|h| {
            let st = h.shared.lock();
            !st.dead && !st.closed && (st.waiting_for_key || st.sink_wants_key)
        })
    }

    /// How far behind each sink is (adaptive bitrate, `media::abr`), in
    /// the fanout's order; `None` for sinks that ended. The fanout's own
    /// queue comes on top of what the sink says (a sink that cannot tell
    /// gets [`FANOUT_BACKLOG_LIMIT`]), and frames dropped on a full queue
    /// count as dropped.
    pub fn backlogs(&self) -> Vec<Option<Backlog>> {
        let now = Instant::now();
        self.sinks
            .iter()
            .map(|h| {
                let st = h.shared.lock();
                if st.dead || st.closed || !st.started {
                    return None;
                }
                let queued = st
                    .queue
                    .front()
                    .map_or(Duration::ZERO, |q| now.saturating_duration_since(q.queued));
                let sink = st.backlog.unwrap_or(Backlog {
                    limit: FANOUT_BACKLOG_LIMIT,
                    ..Backlog::default()
                });
                Some(Backlog {
                    delay: sink.delay + queued,
                    limit: sink.limit,
                    dropped: sink.dropped + st.stats.dropped_full,
                })
            })
            .collect()
    }

    /// Sinks still running.
    pub fn active(&self) -> usize {
        self.sinks.iter().filter(|h| !h.shared.lock().dead).count()
    }

    /// Frames currently queued per sink.
    pub fn queued(&self) -> Vec<(String, usize)> {
        self.sinks
            .iter()
            .map(|h| (h.name.clone(), h.shared.lock().queue.len()))
            .collect()
    }

    pub fn stats(&self) -> Vec<(String, SinkStats)> {
        self.sinks
            .iter()
            .map(|h| (h.name.clone(), h.shared.lock().stats.clone()))
            .collect()
    }

    /// Ends the stream: with `drain`, sinks get their queued frames first;
    /// otherwise queues are discarded (Ctrl-C). Then every sink's `stop()`
    /// runs and the threads are joined.
    pub fn close(mut self, drain: bool) -> Vec<(String, SinkEnd)> {
        for h in &self.sinks {
            let mut st = h.shared.lock();
            st.closed = true;
            st.abort = !drain;
            drop(st);
            h.shared.cond.notify_all();
        }
        let mut out = Vec::new();
        for h in &mut self.sinks {
            let end = match h.thread.take().map(JoinHandle::join) {
                Some(Ok(end)) => end,
                Some(Err(_)) => {
                    SinkEnd::Failed(Error::process(format!("{}: sink thread panicked", h.name)))
                }
                None => SinkEnd::Stopped,
            };
            out.push((h.name.clone(), end));
        }
        out
    }
}

impl Drop for Fanout {
    fn drop(&mut self) {
        // Not closed explicitly: abort and stop the sinks anyway.
        for h in &self.sinks {
            let mut st = h.shared.lock();
            st.closed = true;
            st.abort = true;
            drop(st);
            h.shared.cond.notify_all();
        }
        for h in &mut self.sinks {
            if let Some(t) = h.thread.take() {
                let _ = t.join();
            }
        }
    }
}

fn run_sink(
    mut sink: Box<dyn Sink>,
    video: &crate::types::VideoInfo,
    audio: Option<&crate::types::AudioInfo>,
    shared: &Shared,
    clock: &SessionClock,
    events: &Events,
) -> SinkEnd {
    let name = sink.name().to_owned();
    let started = sink.start(video, audio);
    shared.lock().started = true;
    shared.cond.notify_all();
    if let Err(e) = started {
        error!("{name}: start failed: {e}");
        events.receiver(&name, None, ReceiverState::Failed, Some(&e));
        let _ = sink.stop();
        return SinkEnd::Failed(e);
    }
    let mut end = SinkEnd::Stopped;
    loop {
        let frame = {
            let mut st = shared.lock();
            loop {
                if st.closed && (st.abort || st.queue.is_empty()) {
                    break None;
                }
                if let Some(q) = st.queue.pop_front() {
                    st.bytes -= q.frame.data.len();
                    break Some(q);
                }
                st = shared.cond.wait(st).unwrap_or_else(|e| e.into_inner());
            }
        };
        let Some(Queued { frame, at, .. }) = frame else {
            break;
        };
        let wants_key = frame.track == TrackKind::Video && sink.wants_keyframe();
        if frame.track == TrackKind::Video {
            shared.lock().sink_wants_key = wants_key && !frame.keyframe;
        }
        if wants_key {
            let mut st = shared.lock();
            if !frame.keyframe {
                // Skip this and everything queued up to the next keyframe.
                if !st.waiting_for_key {
                    debug!("{name}: receiver wants a keyframe; skipping to the next one");
                }
                st.stats.dropped_waiting += 1;
                let before = st.queue.len();
                let mut removed = 0usize;
                let mut seen_key = false;
                st.queue.retain(|q| {
                    let f = &q.frame;
                    seen_key |= f.track == TrackKind::Video && f.keyframe;
                    let drop = !seen_key && f.track == TrackKind::Video;
                    if drop {
                        removed += f.data.len();
                    }
                    !drop
                });
                st.bytes -= removed;
                let dropped = (before - st.queue.len()) as u64;
                st.stats.dropped_waiting += dropped;
                if !seen_key {
                    st.waiting_for_key = true;
                }
                continue;
            }
        }
        if let Some((rate, t)) = at {
            clock.pin(frame.pts, rate, t);
        }
        let pushed = sink.push(&frame);
        if frame.track == TrackKind::Video {
            let b = sink.backlog();
            shared.lock().backlog = b;
        }
        match pushed {
            Ok(SinkStatus::Accepted) => shared.lock().stats.pushed += 1,
            Ok(SinkStatus::Dropped) => {
                let mut st = shared.lock();
                st.stats.pushed += 1;
                st.stats.sink_dropped += 1;
            }
            Ok(SinkStatus::Finished) => {
                info!("{name}: receiver ended the session");
                end = SinkEnd::Finished;
                break;
            }
            Err(e) => {
                error!("{name}: {e}");
                end = SinkEnd::Failed(e);
                break;
            }
        }
    }
    if let Err(e) = sink.stop() {
        warn!("{name}: stop failed: {e}");
        if matches!(end, SinkEnd::Stopped) {
            end = SinkEnd::Failed(e);
        }
    }
    match &end {
        SinkEnd::Stopped => events.receiver(&name, None, ReceiverState::Stopped, None),
        SinkEnd::Finished => events.receiver(&name, None, ReceiverState::Ended, None),
        SinkEnd::Failed(e) => events.receiver(&name, None, ReceiverState::Failed, Some(e)),
    }
    end
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{AudioCodec, AudioInfo, Capabilities, VideoCodec, VideoInfo};
    use crate::util::ratio::Ratio;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::mpsc;

    #[derive(Default)]
    struct Log {
        frames: Mutex<Vec<(TrackKind, u64, bool)>>,
        started_audio: Mutex<Option<AudioCodec>>,
        stopped: AtomicBool,
        clock: Mutex<Option<SessionClock>>,
        /// The clock was set before start().
        clock_before_start: AtomicBool,
    }

    struct MockSink {
        name: String,
        caps: Capabilities,
        log: Arc<Log>,
        /// Each push waits for a token (to simulate a stalled receiver).
        gate: Option<mpsc::Receiver<()>>,
        wants_key: Arc<AtomicBool>,
        finish_after: Option<usize>,
    }

    impl Sink for MockSink {
        fn name(&self) -> &str {
            &self.name
        }
        fn capabilities(&self) -> &Capabilities {
            &self.caps
        }
        fn set_clock(&mut self, clock: SessionClock) {
            *self.log.clock.lock().unwrap() = Some(clock);
        }
        fn start(&mut self, _v: &VideoInfo, a: Option<&AudioInfo>) -> Result<()> {
            *self.log.started_audio.lock().unwrap() = a.map(|a| a.codec);
            let set = self.log.clock.lock().unwrap().is_some();
            self.log.clock_before_start.store(set, Ordering::SeqCst);
            Ok(())
        }
        fn push(&mut self, f: &EncodedFrame) -> Result<SinkStatus> {
            if let Some(g) = &self.gate {
                let _ = g.recv();
            }
            let mut frames = self.log.frames.lock().unwrap();
            frames.push((f.track, f.pts, f.keyframe));
            if f.keyframe && f.track == TrackKind::Video {
                self.wants_key.store(false, Ordering::SeqCst);
            }
            if self.finish_after.is_some_and(|n| frames.len() >= n) {
                return Ok(SinkStatus::Finished);
            }
            Ok(SinkStatus::Accepted)
        }
        fn wants_keyframe(&self) -> bool {
            self.wants_key.load(Ordering::SeqCst)
        }
        fn stop(&mut self) -> Result<()> {
            self.log.stopped.store(true, Ordering::SeqCst);
            Ok(())
        }
    }

    fn caps(family: AudioFamily) -> Capabilities {
        Capabilities {
            max_width: 1920,
            max_height: 1080,
            max_fps: Ratio::integer(60),
            video_codecs: vec![VideoCodec::H264],
            audio_formats: vec![],
            audio_family: family,
            max_bitrate_kbps: None,
            max_pixels_per_second: None,
            min_latency_ms: None,
            preferred_latency_ms: None,
            max_key_interval_ms: None,
            display_aspect: None,
        }
    }

    fn mock(name: &str, family: AudioFamily) -> (MockSink, Arc<Log>, Arc<AtomicBool>) {
        let log = Arc::new(Log::default());
        let wants = Arc::new(AtomicBool::new(false));
        (
            MockSink {
                name: name.into(),
                caps: caps(family),
                log: log.clone(),
                gate: None,
                wants_key: wants.clone(),
                finish_after: None,
            },
            log,
            wants,
        )
    }

    fn info() -> StreamInfo {
        let audio = |codec| AudioInfo {
            codec,
            sample_rate: 48_000,
            channels: 2,
            frame_samples: 480,
            config: vec![],
        };
        StreamInfo {
            video: VideoInfo {
                codec: VideoCodec::H264,
                width: 1280,
                height: 720,
                fps: Ratio::integer(30),
                avcc: vec![1],
            },
            audio: vec![
                (AudioFamily::AirPlay, audio(AudioCodec::PcmS16le)),
                (AudioFamily::Cast, audio(AudioCodec::Opus)),
            ],
        }
    }

    fn video(pts: u64, key: bool) -> EncodedFrame {
        EncodedFrame {
            track: TrackKind::Video,
            pts,
            keyframe: key,
            data: Arc::from(vec![0u8; 100]),
        }
    }

    fn audio(family: AudioFamily, pts: u64) -> EncodedFrame {
        EncodedFrame {
            track: TrackKind::Audio(family),
            pts,
            keyframe: true,
            data: Arc::from(vec![0u8; 10]),
        }
    }

    fn videos(log: &Log) -> Vec<u64> {
        log.frames
            .lock()
            .unwrap()
            .iter()
            .filter(|f| f.0 == TrackKind::Video)
            .map(|f| f.1)
            .collect()
    }

    #[test]
    fn routes_audio_and_waits_for_first_keyframe() {
        let (a, alog, _) = mock("airplay", AudioFamily::AirPlay);
        let (c, clog, _) = mock("cast", AudioFamily::Cast);
        let f = Fanout::new(
            vec![Box::new(a), Box::new(c)],
            &info(),
            FanoutConfig::default(),
        )
        .unwrap();
        f.push(&video(0, false)); // before the first keyframe: dropped
        f.push(&video(1, true));
        f.push(&audio(AudioFamily::AirPlay, 10));
        f.push(&audio(AudioFamily::Cast, 20));
        f.push(&video(2, false));
        let ends = f.close(true);
        assert!(ends.iter().all(|(_, e)| matches!(e, SinkEnd::Stopped)));
        assert_eq!(videos(&alog), [1, 2]);
        assert_eq!(videos(&clog), [1, 2]);
        let audio_pts = |log: &Log| -> Vec<u64> {
            log.frames
                .lock()
                .unwrap()
                .iter()
                .filter(|f| f.0 != TrackKind::Video)
                .map(|f| f.1)
                .collect()
        };
        assert_eq!(audio_pts(&alog), [10]);
        assert_eq!(audio_pts(&clog), [20]);
        assert_eq!(
            *alog.started_audio.lock().unwrap(),
            Some(AudioCodec::PcmS16le)
        );
        assert_eq!(*clog.started_audio.lock().unwrap(), Some(AudioCodec::Opus));
        assert!(alog.stopped.load(Ordering::SeqCst));
    }

    #[test]
    fn every_sink_gets_the_session_clock() {
        let (a, alog, _) = mock("airplay", AudioFamily::AirPlay);
        let (c, clog, _) = mock("cast", AudioFamily::Cast);
        let f = Fanout::new(
            vec![Box::new(a), Box::new(c)],
            &info(),
            FanoutConfig::default(),
        )
        .unwrap();
        let t0 = Instant::now();
        f.push(&video(9_000, true));
        let t1 = Instant::now();
        // Audio of a family is scheduled at its rate: 48 kHz, 100 ms.
        f.push(&audio(AudioFamily::Cast, 4_800));
        f.push(&video(12_000, false));
        let ends = f.close(true);
        assert!(ends.iter().all(|(_, e)| matches!(e, SinkEnd::Stopped)));
        for log in [&alog, &clog] {
            assert!(log.clock_before_start.load(Ordering::SeqCst));
        }
        let ca = alog.clock.lock().unwrap().clone().unwrap();
        let cc = clog.clock.lock().unwrap().clone().unwrap();
        assert!(Arc::ptr_eq(ca.clock(), cc.clock()));
        // Anchored when the first frame left the input.
        let at = ca.instant_for(9_000, VIDEO_CLOCK_RATE).unwrap();
        assert!(at >= t0 && at <= t1);
        assert_eq!(ca.instant_for(4_800, 48_000), Some(at));
    }

    #[test]
    fn slow_sink_skips_to_next_keyframe_without_blocking_others() {
        let (mut slow, slog, _) = mock("slow", AudioFamily::AirPlay);
        let (gate_tx, gate_rx) = mpsc::channel();
        slow.gate = Some(gate_rx);
        let (fast, flog, _) = mock("fast", AudioFamily::Cast);
        let cfg = FanoutConfig {
            max_frames: 3,
            max_bytes: 1 << 20,
            ..FanoutConfig::default()
        };
        let f = Fanout::new(vec![Box::new(slow), Box::new(fast)], &info(), cfg).unwrap();
        let wait_for = |log: &Log, n: usize| {
            while videos(log).len() < n {
                std::thread::yield_now();
            }
        };
        // GOP of 5: keyframes at 0, 5, 10. The fast sink keeps up.
        for i in 0..12u64 {
            f.push(&video(i, i % 5 == 0));
            wait_for(&flog, i as usize + 1);
            if i == 0 {
                // The slow sink has taken frame 0 and is stuck in push.
                while f.queued()[0].1 > 0 {
                    std::thread::yield_now();
                }
            }
        }
        // The slow sink is stuck in push(0) with 1..=3 queued; 4 hit the
        // full queue, so 5..=11 were skipped as well (5 and 10 because the
        // queue was still full, the rest waiting for a keyframe).
        // Its backlog: the queue's age, the full-queue drops; a mock tells
        // nothing itself, so the fanout's limit.
        std::thread::sleep(Duration::from_millis(30));
        let b = f.backlogs();
        let slow_b = b[0].unwrap();
        assert!(slow_b.delay >= Duration::from_millis(30), "{slow_b:?}");
        assert_eq!((slow_b.limit, slow_b.dropped), (FANOUT_BACKLOG_LIMIT, 3));
        assert_eq!(b[1].unwrap().delay, Duration::ZERO);
        for _ in 0..4 {
            gate_tx.send(()).unwrap();
        }
        wait_for(&slog, 4);
        while f.stats()[0].1.pushed < 4 {
            std::thread::yield_now();
        }
        // Deltas are still skipped; it resumes at the next keyframe.
        for i in 12..18u64 {
            f.push(&video(i, i == 15));
            wait_for(&flog, i as usize + 1);
        }
        for _ in 0..10 {
            let _ = gate_tx.send(());
        }
        drop(gate_tx);
        let stats = f.stats();
        f.close(true);
        assert_eq!(videos(&flog), (0..18).collect::<Vec<_>>());
        assert_eq!(videos(&slog), [0, 1, 2, 3, 15, 16, 17]);
        let slow_stats = &stats.iter().find(|s| s.0 == "slow").unwrap().1;
        assert_eq!(slow_stats.dropped_full, 3); // 4, 5, 10
        assert_eq!(slow_stats.dropped_waiting, 8); // 6..=9, 11..=14
    }

    #[test]
    fn wants_keyframe_drops_queued_and_new_deltas() {
        let (mut s, log, wants) = mock("pli", AudioFamily::Cast);
        let (gate_tx, gate_rx) = mpsc::channel();
        s.gate = Some(gate_rx);
        let f = Fanout::new(vec![Box::new(s)], &info(), FanoutConfig::default()).unwrap();
        // A new sink waits for its first keyframe.
        assert!(f.keyframe_wanted());
        f.push(&video(0, true));
        assert!(!f.keyframe_wanted());
        // Let frame 0 through, then the receiver reports loss.
        gate_tx.send(()).unwrap();
        while videos(&log).is_empty() {
            std::thread::yield_now();
        }
        wants.store(true, Ordering::SeqCst);
        for i in 1..8u64 {
            f.push(&video(i, i == 6));
            if i == 1 {
                // Seen when the sink thread takes the next video frame.
                let t0 = std::time::Instant::now();
                while !f.keyframe_wanted() && t0.elapsed() < std::time::Duration::from_secs(5) {
                    std::thread::yield_now();
                }
                assert!(f.keyframe_wanted());
            }
        }
        f.push(&audio(AudioFamily::Cast, 99));
        for _ in 0..20 {
            let _ = gate_tx.send(());
        }
        drop(gate_tx);
        while videos(&log).len() < 3 {
            std::thread::yield_now();
        }
        assert!(!f.keyframe_wanted());
        f.close(true);
        assert_eq!(videos(&log), [0, 6, 7]);
        // Audio is not dropped for a keyframe request.
        assert!(log.frames.lock().unwrap().iter().any(|f| f.1 == 99));
    }

    #[test]
    fn finished_sink_is_removed_and_abort_discards() {
        let (mut s, log, _) = mock("done", AudioFamily::Cast);
        s.finish_after = Some(2);
        let (other, olog, _) = mock("other", AudioFamily::AirPlay);
        let f = Fanout::new(
            vec![Box::new(s), Box::new(other)],
            &info(),
            FanoutConfig::default(),
        )
        .unwrap();
        for i in 0..5u64 {
            f.push(&video(i, i == 0));
        }
        while f.active() == 2 {
            std::thread::yield_now();
        }
        assert_eq!(f.active(), 1);
        let ends = f.close(false);
        assert!(matches!(ends[0].1, SinkEnd::Finished));
        assert_eq!(videos(&log), [0, 1]);
        assert!(log.stopped.load(Ordering::SeqCst));
        assert!(olog.stopped.load(Ordering::SeqCst));
    }

    /// A sink whose `start()` takes a while (an AirPlay SETUP) or fails.
    struct SlowStart {
        caps: Capabilities,
        delay: std::time::Duration,
        fail: bool,
    }

    impl Sink for SlowStart {
        fn name(&self) -> &str {
            "slow"
        }
        fn capabilities(&self) -> &Capabilities {
            &self.caps
        }
        fn start(&mut self, _v: &VideoInfo, _a: Option<&AudioInfo>) -> Result<()> {
            std::thread::sleep(self.delay);
            if self.fail {
                return Err(Error::protocol("no"));
            }
            Ok(())
        }
        fn push(&mut self, _f: &EncodedFrame) -> Result<SinkStatus> {
            Ok(SinkStatus::Accepted)
        }
        fn wants_keyframe(&self) -> bool {
            false
        }
        fn stop(&mut self) -> Result<()> {
            Ok(())
        }
    }

    #[test]
    fn waits_for_sinks_to_start() {
        let slow = |ms, fail| -> Box<dyn Sink> {
            Box::new(SlowStart {
                caps: caps(AudioFamily::Cast),
                delay: Duration::from_millis(ms),
                fail,
            })
        };
        let f = Fanout::new(
            vec![slow(150, false), slow(10, false)],
            &info(),
            FanoutConfig::default(),
        )
        .unwrap();
        let t0 = Instant::now();
        assert!(f.wait_started(Duration::from_secs(5), &Stop::new()));
        assert!(
            t0.elapsed() >= Duration::from_millis(140),
            "{:?}",
            t0.elapsed()
        );
        assert!(t0.elapsed() < Duration::from_secs(2));
        f.close(false);
        // A failed start counts as done; a hanging one times out.
        let f = Fanout::new(vec![slow(20, true)], &info(), FanoutConfig::default()).unwrap();
        assert!(f.wait_started(Duration::from_secs(5), &Stop::new()));
        f.close(false);
        let f = Fanout::new(vec![slow(400, false)], &info(), FanoutConfig::default()).unwrap();
        let t0 = Instant::now();
        assert!(!f.wait_started(Duration::from_millis(100), &Stop::new()));
        assert!(t0.elapsed() < Duration::from_millis(300));
        f.close(false);
    }
}
