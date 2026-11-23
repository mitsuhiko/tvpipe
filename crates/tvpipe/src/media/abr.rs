//! Adaptive bitrate: the encoder's target follows what the network takes
//! (ARCHITECTURE.md, "Adaptive Bitrate").
//!
//! The signal is each sink's [`Backlog`] (`Fanout::backlogs`): how long
//! its oldest video that is not through yet has waited, against the delay
//! at which frames come late or are dropped. Like CoDel, the *least*
//! backlog over a [`WINDOW`] is the standing queue: a keyframe or a burst
//! of feedback makes the backlog jump for a moment and does not count; a
//! queue that does not drain within a window does.
//!
//! - A drop, or a standing backlog past the limit: the bitrate is cut to
//!   [`CUT_HARD`] (at most once a window).
//! - A standing backlog past [`HIGH`] of the limit: cut to [`CUT`], at
//!   most once per [`HOLD`] (the queue still drains at the old rate's
//!   bytes for a while).
//! - Below [`LOW`] for [`CLEAR_BEFORE_RAISE`]: raised by [`RAISE`] every
//!   [`RAISE_EVERY`] up to the planned bitrate; within 10 % of the rate
//!   the last cut came at (for [`KNEE_MEMORY`]) only by
//!   [`RAISE_NEAR_KNEE`]: that is where the network gave up last time.
//!
//! The slowest receiver sets the rate: there is one encode for all.
//! Pure logic with the time passed in; the session loop feeds it and
//! tells the input ([`crate::media::input::Input::set_bitrate`]).

use std::time::{Duration, Instant};

use crate::types::Backlog;

/// How long the least backlog is taken over.
pub const WINDOW: Duration = Duration::from_millis(500);
/// A standing backlog of this much of the limit: the network is behind.
pub const HIGH: f64 = 0.3;
/// Below this much of the limit: the network keeps up.
pub const LOW: f64 = 0.1;
/// The cut when behind.
pub const CUT: f64 = 0.8;
/// The cut after a drop or past the limit.
pub const CUT_HARD: f64 = 0.6;
/// After a cut, a mild backlog waits this long before the next one.
pub const HOLD: Duration = Duration::from_secs(1);
/// How long the network keeps up before the bitrate goes up again.
pub const CLEAR_BEFORE_RAISE: Duration = Duration::from_secs(3);
/// Between raises.
pub const RAISE_EVERY: Duration = Duration::from_secs(1);
/// A raise.
pub const RAISE: f64 = 1.06;
/// A raise near the rate of the last cut.
pub const RAISE_NEAR_KNEE: f64 = 1.02;
/// How long the rate of the last cut slows the raises down.
pub const KNEE_MEMORY: Duration = Duration::from_secs(30);
/// The floor: this fraction of the planned bitrate, at least
/// [`FLOOR_KBPS`].
pub const FLOOR_FRACTION: u32 = 8;
pub const FLOOR_KBPS: u32 = 500;

/// Why the bitrate changed (`sink`: the index in the backlogs).
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Cause {
    /// The sink dropped frames.
    Dropped { sink: usize },
    /// The sink's standing backlog.
    Behind { sink: usize, delay: Duration },
    /// The network kept up.
    Clear,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Change {
    pub kbps: u32,
    pub cause: Cause,
}

/// The least backlog of one sink in the window.
#[derive(Debug, Clone, Copy)]
struct Least {
    ratio: f64,
    delay: Duration,
}

#[derive(Debug)]
pub struct Abr {
    max: u32,
    min: u32,
    current: u32,
    window_start: Instant,
    least: Vec<Option<Least>>,
    /// The last drop counter of each sink.
    dropped: Vec<Option<u64>>,
    /// A sink whose counter went up in this window.
    dropped_now: Option<usize>,
    last_cut: Option<Instant>,
    clear_since: Option<Instant>,
    last_raise: Option<Instant>,
    /// The rate before the last cut, and when.
    knee: Option<(u32, Instant)>,
}

impl Abr {
    /// Starts at the planned bitrate, which is also the ceiling.
    pub fn new(max_kbps: u32, now: Instant) -> Abr {
        let max = max_kbps.max(1);
        Abr {
            max,
            min: (max / FLOOR_FRACTION).max(FLOOR_KBPS).min(max),
            current: max,
            window_start: now,
            least: Vec::new(),
            dropped: Vec::new(),
            dropped_now: None,
            last_cut: None,
            clear_since: None,
            last_raise: None,
            knee: None,
        }
    }

    pub fn kbps(&self) -> u32 {
        self.current
    }

    /// Takes one sample of every sink's backlog (`None`: ended); at the
    /// end of a window, returns the new bitrate if it changes.
    pub fn update(&mut self, now: Instant, backlogs: &[Option<Backlog>]) -> Option<Change> {
        if self.least.len() < backlogs.len() {
            self.least.resize(backlogs.len(), None);
            self.dropped.resize(backlogs.len(), None);
        }
        for (i, b) in backlogs.iter().enumerate() {
            let Some(b) = b else {
                self.least[i] = None;
                self.dropped[i] = None;
                continue;
            };
            let limit = b.limit.max(Duration::from_millis(1));
            let ratio = b.delay.as_secs_f64() / limit.as_secs_f64();
            if self.least[i].is_none_or(|l| ratio < l.ratio) {
                self.least[i] = Some(Least {
                    ratio,
                    delay: b.delay,
                });
            }
            // A counter that went down started over (a reconnect).
            if self.dropped[i].is_some_and(|d| b.dropped > d) {
                self.dropped_now.get_or_insert(i);
            }
            self.dropped[i] = Some(b.dropped);
        }
        if now.duration_since(self.window_start) < WINDOW {
            return None;
        }
        self.window_start = now;
        let worst = self
            .least
            .iter_mut()
            .enumerate()
            .filter_map(|(i, l)| l.take().map(|l| (i, l)))
            .max_by(|a, b| a.1.ratio.total_cmp(&b.1.ratio));
        let dropped = self.dropped_now.take();
        let since_cut = self.last_cut.map(|t| now.duration_since(t));
        if let Some(sink) = dropped {
            if since_cut.is_none_or(|d| d >= WINDOW) {
                return self.cut(now, CUT_HARD, Cause::Dropped { sink });
            }
            return None;
        }
        match worst {
            Some((sink, l)) if l.ratio >= 1.0 => {
                self.clear_since = None;
                if since_cut.is_none_or(|d| d >= WINDOW) {
                    return self.cut(
                        now,
                        CUT_HARD,
                        Cause::Behind {
                            sink,
                            delay: l.delay,
                        },
                    );
                }
                None
            }
            Some((sink, l)) if l.ratio >= HIGH => {
                self.clear_since = None;
                if since_cut.is_none_or(|d| d >= HOLD) {
                    return self.cut(
                        now,
                        CUT,
                        Cause::Behind {
                            sink,
                            delay: l.delay,
                        },
                    );
                }
                None
            }
            Some((_, l)) if l.ratio >= LOW => {
                // Near what the network takes: stay.
                self.clear_since = None;
                None
            }
            _ => self.raise(now),
        }
    }

    fn cut(&mut self, now: Instant, factor: f64, cause: Cause) -> Option<Change> {
        self.clear_since = None;
        let kbps = ((self.current as f64 * factor) as u32).max(self.min);
        if kbps >= self.current {
            return None;
        }
        self.knee = Some((self.current, now));
        self.last_cut = Some(now);
        self.current = kbps;
        Some(Change { kbps, cause })
    }

    fn raise(&mut self, now: Instant) -> Option<Change> {
        let since = *self.clear_since.get_or_insert(now);
        if self.current >= self.max
            || now.duration_since(since) < CLEAR_BEFORE_RAISE
            || self
                .last_raise
                .is_some_and(|t| now.duration_since(t) < RAISE_EVERY)
        {
            return None;
        }
        let near_knee = self.knee.is_some_and(|(k, at)| {
            let c = self.current as f64;
            now.duration_since(at) < KNEE_MEMORY && c >= k as f64 * 0.9 && c <= k as f64 * 1.1
        });
        let step = if near_knee { RAISE_NEAR_KNEE } else { RAISE };
        let kbps = ((self.current as f64 * step) as u32)
            .max(self.current + 50)
            .min(self.max);
        self.last_raise = Some(now);
        self.current = kbps;
        Some(Change {
            kbps,
            cause: Cause::Clear,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn b(delay_ms: u64, limit_ms: u64, dropped: u64) -> Option<Backlog> {
        Some(Backlog {
            delay: Duration::from_millis(delay_ms),
            limit: Duration::from_millis(limit_ms),
            dropped,
        })
    }

    /// Feeds `sample` every 10 ms for `ms`; the changes.
    fn run(
        abr: &mut Abr,
        t: &mut Instant,
        ms: u64,
        mut sample: impl FnMut(u64) -> Vec<Option<Backlog>>,
    ) -> Vec<Change> {
        let mut out = Vec::new();
        for i in 0..ms / 10 {
            *t += Duration::from_millis(10);
            if let Some(c) = abr.update(*t, &sample(i * 10)) {
                out.push(c);
            }
        }
        out
    }

    #[test]
    fn a_network_that_keeps_up_keeps_the_plan() {
        let mut t = Instant::now();
        let mut abr = Abr::new(12_000, t);
        // Keyframe bursts every 500 ms (200 of a 300 ms limit) drain at once.
        let c = run(&mut abr, &mut t, 10_000, |ms| {
            vec![b(if ms % 500 < 30 { 200 } else { 0 }, 300, 0)]
        });
        assert_eq!(c, []);
        assert_eq!(abr.kbps(), 12_000);
    }

    #[test]
    fn a_standing_backlog_cuts_and_holds() {
        let mut t = Instant::now();
        let mut abr = Abr::new(10_000, t);
        // 120 of 300 ms that never drains: a cut to 80 % at the first
        // window's end, the next only after HOLD.
        let c = run(&mut abr, &mut t, 1_200, |_| vec![b(120, 300, 0)]);
        assert_eq!(
            c.iter().map(|c| c.kbps).collect::<Vec<_>>(),
            [8_000],
            "{c:?}"
        );
        assert!(matches!(c[0].cause, Cause::Behind { sink: 0, .. }));
        let c = run(&mut abr, &mut t, 1_000, |_| vec![b(120, 300, 0)]);
        assert_eq!(c.iter().map(|c| c.kbps).collect::<Vec<_>>(), [6_400]);
    }

    #[test]
    fn drops_and_late_frames_cut_hard() {
        let mut t = Instant::now();
        let mut abr = Abr::new(10_000, t);
        let c = run(&mut abr, &mut t, 500, |ms| {
            vec![b(0, 300, if ms >= 200 { 1 } else { 0 })]
        });
        assert_eq!(
            c,
            [Change {
                kbps: 6_000,
                cause: Cause::Dropped { sink: 0 }
            }]
        );
        // Past the limit: once a window.
        let c = run(&mut abr, &mut t, 1_000, |_| vec![b(400, 300, 1)]);
        assert_eq!(c.iter().map(|c| c.kbps).collect::<Vec<_>>(), [3_600, 2_160]);
    }

    #[test]
    fn the_floor_holds() {
        let mut t = Instant::now();
        let mut abr = Abr::new(8_000, t);
        let c = run(&mut abr, &mut t, 20_000, |_| vec![b(1_000, 300, 0)]);
        assert_eq!(abr.kbps(), 1_000, "{c:?}");
        assert_eq!(c.last().map(|c| c.kbps), Some(1_000));
    }

    #[test]
    fn it_comes_back_after_the_network_cleared() {
        let mut t = Instant::now();
        let mut abr = Abr::new(10_000, t);
        run(&mut abr, &mut t, 500, |_| vec![b(200, 300, 0)]);
        assert_eq!(abr.kbps(), 8_000);
        // Clear: nothing for CLEAR_BEFORE_RAISE, then a raise a second,
        // small ones within 10 % of the knee (10000), up to the plan and
        // no more.
        let c = run(&mut abr, &mut t, 2_900, |_| vec![b(0, 300, 0)]);
        assert_eq!(c, []);
        let c = run(&mut abr, &mut t, 60_000, |_| vec![b(0, 300, 0)]);
        assert!(c.iter().all(|c| c.cause == Cause::Clear));
        let rates: Vec<u32> = c.iter().map(|c| c.kbps).collect();
        assert_eq!(rates[..4], [8_480, 8_988, 9_527, 9_717], "{rates:?}");
        assert_eq!(rates.last(), Some(&10_000));
        assert_eq!(abr.kbps(), 10_000);
    }

    #[test]
    fn raises_are_fast_again_past_the_knee() {
        let mut t = Instant::now();
        let mut abr = Abr::new(20_000, t);
        // Four cuts by 20 %: the last from 10240 (the knee) to 8192.
        let cuts = run(&mut abr, &mut t, 3_600, |_| vec![b(120, 300, 0)]);
        let cuts: Vec<u32> = cuts.iter().map(|c| c.kbps).collect();
        assert_eq!(cuts, [16_000, 12_800, 10_240, 8_192]);
        let c = run(&mut abr, &mut t, 30_000, |_| vec![b(0, 300, 0)]);
        let rates: Vec<u32> = c.iter().map(|c| c.kbps).collect();
        for w in rates.windows(2) {
            let step = w[1] as f64 / w[0] as f64;
            if (9_216..=11_264).contains(&w[0]) {
                assert!(step < 1.03, "near the knee: {rates:?}");
            } else if w[1] < 20_000 {
                assert!(step > 1.05, "away from it: {rates:?}");
            }
        }
        assert_eq!(abr.kbps(), 20_000);
    }

    #[test]
    fn a_mild_backlog_neither_cuts_nor_raises() {
        let mut t = Instant::now();
        let mut abr = Abr::new(10_000, t);
        run(&mut abr, &mut t, 500, |_| vec![b(200, 300, 0)]);
        let c = run(&mut abr, &mut t, 10_000, |_| vec![b(50, 300, 0)]);
        assert_eq!(c, []);
        assert_eq!(abr.kbps(), 8_000);
    }

    #[test]
    fn the_slowest_sink_decides_and_ended_ones_do_not() {
        let mut t = Instant::now();
        let mut abr = Abr::new(10_000, t);
        let c = run(&mut abr, &mut t, 500, |_| {
            vec![b(0, 300, 0), b(150, 300, 0)]
        });
        assert!(matches!(
            c[..],
            [Change {
                kbps: 8_000,
                cause: Cause::Behind { sink: 1, .. }
            }]
        ));
        // The slow one ended (and its counter goes with it).
        let c = run(&mut abr, &mut t, 10_000, |_| vec![b(0, 300, 0), None]);
        assert!(c.iter().all(|c| c.cause == Cause::Clear) && !c.is_empty());
        // It reconnects: a first count is no drop.
        let before = abr.kbps();
        let c = run(&mut abr, &mut t, 500, |_| vec![b(0, 300, 0), b(0, 300, 3)]);
        assert!(c.iter().all(|c| c.kbps >= before), "{c:?}");
    }
}
