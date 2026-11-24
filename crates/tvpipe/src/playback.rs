//! Seeking and pausing a running `play` (docs/playback.md).
//!
//! A [`PlaybackControl`] is shared by whoever asks (the CLI's keys,
//! `Session::seek`, the machine interface's `seek`/`pause`/`resume`
//! commands) and the input that does it (`media::input`: the passthrough
//! input and ffmpeg). Requests are coalesced: the latest pause state wins,
//! and relative seeks add up to one target until the input takes it, so
//! holding a key down costs one seek. The input reports back where it is
//! ([`PlaybackStatus`]); the session turns changes into
//! [`Event::Playback`](crate::Event::Playback).
//!
//! No I/O and no clock of its own: positions are media time, set by the
//! input.

use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

/// Forward seeks stop this far before the end of the input, so a seek
/// never ends the session by itself.
pub const END_MARGIN: Duration = Duration::from_secs(3);

/// Where a running `play` is (see [`PlaybackControl::status`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
#[non_exhaustive]
pub struct PlaybackStatus {
    /// The input can seek and pause (a file, or a URL with a duration).
    pub seekable: bool,
    /// The input's position (media time of the frames going out, or the
    /// target of a seek in progress).
    pub position: Duration,
    /// The input's length, if known.
    pub duration: Option<Duration>,
    /// Paused (or a pause is being applied).
    pub paused: bool,
    /// Counts applied seeks and pauses: a change means the position jumped
    /// or the pause state changed.
    pub changes: u64,
}

#[derive(Default)]
struct State {
    status: PlaybackStatus,
    /// Where [`Event::Playback`](crate::Event::Playback) goes, once the
    /// session streams.
    events: Option<crate::events::Events>,
    looped: bool,
    /// A seek not taken by the input yet (and whether it goes forward
    /// from the position at the time it was asked).
    target: Option<(Duration, bool)>,
    /// The pause state asked for, if it differs from the applied one.
    want_paused: Option<bool>,
}

/// Asks a running `play` to seek or pause; shared, cheap to clone.
#[derive(Clone, Default)]
pub struct PlaybackControl(Arc<Mutex<State>>);

impl PlaybackControl {
    /// A control nobody uses yet.
    pub fn new() -> PlaybackControl {
        PlaybackControl::default()
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Sends an [`Event::Playback`](crate::Event::Playback) with the
    /// applied state (`st` is the locked state).
    fn notify(st: MutexGuard<'_, State>) {
        if !st.status.seekable {
            return;
        }
        let Some(events) = st.events.clone() else {
            return;
        };
        let e = crate::Event::Playback(st.status.into());
        drop(st);
        events.emit(e);
    }

    // -----------------------------------------------------------------
    // Asking

    /// Moves by `delta_ms` (negative: back) from where the input is, or
    /// from the target of a seek it has not taken yet. False: the input
    /// cannot seek (or is not open yet).
    pub fn seek_by(&self, delta_ms: i64) -> bool {
        let mut st = self.lock();
        if !st.status.seekable {
            return false;
        }
        let base = st.target.map_or(st.status.position, |(t, _)| t);
        let base_ms = base.as_millis().min(i64::MAX as u128) as i64;
        let to = Duration::from_millis(base_ms.saturating_add(delta_ms).max(0) as u64);
        st.set_target(to);
        true
    }

    /// Moves to `position`. False: the input cannot seek.
    pub fn seek_to(&self, position: Duration) -> bool {
        let mut st = self.lock();
        if !st.status.seekable {
            return false;
        }
        st.set_target(position);
        true
    }

    /// Pauses (`true`) or resumes. False: the input cannot pause.
    pub fn set_paused(&self, paused: bool) -> bool {
        let mut st = self.lock();
        if !st.status.seekable {
            return false;
        }
        st.want_paused = (paused != st.status.paused).then_some(paused);
        true
    }

    /// Pauses when playing, resumes when paused (as asked last). False:
    /// the input cannot pause.
    pub fn toggle_pause(&self) -> bool {
        let paused = {
            let st = self.lock();
            st.want_paused.unwrap_or(st.status.paused)
        };
        self.set_paused(!paused)
    }

    /// Where the input is; `seekable` is false until an input that can
    /// seek is open.
    pub fn status(&self) -> PlaybackStatus {
        let st = self.lock();
        let mut s = st.status;
        if let Some((t, _)) = st.target {
            s.position = t;
        }
        if let Some(p) = st.want_paused {
            s.paused = p;
        }
        s
    }

    // -----------------------------------------------------------------
    // The input's side

    /// The input can seek and pause: its length (`None`: unknown) and
    /// whether it loops (then seeks wrap around). Public for front ends'
    /// tests; inputs call it.
    pub fn enable(&self, duration: Option<Duration>, looped: bool) {
        let mut st = self.lock();
        st.status.seekable = true;
        st.status.duration = duration.filter(|d| !d.is_zero());
        st.looped = looped;
    }

    /// The session streams: changes go to `events` from now on (and the
    /// state as it is now, if the input can seek).
    pub(crate) fn attach(&self, events: crate::events::Events) {
        let mut st = self.lock();
        st.events = Some(events);
        PlaybackControl::notify(st);
    }

    /// The input ended: nothing more to ask.
    pub(crate) fn disable(&self) {
        let mut st = self.lock();
        st.status.seekable = false;
        st.target = None;
        st.want_paused = None;
    }

    /// A seek or a pause change is waiting (an input sleeping until its
    /// next frame wakes up for it).
    pub(crate) fn pending(&self) -> bool {
        let st = self.lock();
        st.target.is_some() || st.want_paused.is_some()
    }

    /// The seek asked for, if any: the position and whether it goes
    /// forward. The status shows the target as the position until
    /// [`PlaybackControl::seeked`].
    pub(crate) fn take_seek(&self) -> Option<(Duration, bool)> {
        let mut st = self.lock();
        let t = st.target.take()?;
        st.status.position = t.0;
        Some(t)
    }

    /// The pause state asked for, if it changed.
    pub(crate) fn take_pause(&self) -> Option<bool> {
        self.lock().want_paused.take()
    }

    /// A seek landed at `position` (a keyframe near the target).
    pub(crate) fn seeked(&self, position: Duration) {
        let mut st = self.lock();
        st.status.position = position;
        st.status.changes += 1;
        PlaybackControl::notify(st);
    }

    /// The pause state is now `paused`.
    pub(crate) fn paused(&self, paused: bool) {
        let mut st = self.lock();
        if st.status.paused != paused {
            st.status.paused = paused;
            st.status.changes += 1;
            PlaybackControl::notify(st);
        }
    }

    /// The frames going out are at `position`.
    pub(crate) fn set_position(&self, position: Duration) {
        let mut st = self.lock();
        st.status.position = match (st.looped, st.status.duration) {
            (true, Some(d)) => wrap(position, d),
            _ => position,
        };
    }
}

impl State {
    fn set_target(&mut self, to: Duration) {
        let to = match (self.looped, self.status.duration) {
            (true, Some(d)) => wrap(to, d),
            (false, Some(d)) => to.min(d.saturating_sub(END_MARGIN)),
            (_, None) => to,
        };
        let forward = to > self.status.position;
        self.target = Some((to, forward));
    }
}

/// `t` within one pass of a looped input of length `d`.
fn wrap(t: Duration, d: Duration) -> Duration {
    let d_ns = d.as_nanos().max(1);
    Duration::from_nanos((t.as_nanos() % d_ns) as u64)
}

impl std::fmt::Debug for PlaybackControl {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("PlaybackControl")
    }
}

impl PartialEq for PlaybackControl {
    fn eq(&self, other: &PlaybackControl) -> bool {
        Arc::ptr_eq(&self.0, &other.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(secs: u64) -> Duration {
        Duration::from_secs(secs)
    }

    #[test]
    fn nothing_before_the_input_can_seek() {
        let c = PlaybackControl::new();
        assert!(!c.seek_by(10_000));
        assert!(!c.toggle_pause());
        assert!(!c.pending());
        assert!(!c.status().seekable);
    }

    #[test]
    fn relative_seeks_add_up_and_clamp() {
        let c = PlaybackControl::new();
        c.enable(Some(s(100)), false);
        c.set_position(s(50));
        assert!(c.seek_by(10_000));
        assert!(c.seek_by(10_000));
        assert_eq!(c.status().position, s(70));
        assert_eq!(c.take_seek(), Some((s(70), true)));
        assert_eq!(c.take_seek(), None);
        // Back from the target, not from a position not reached yet.
        assert!(c.seek_by(-60_000));
        assert!(c.seek_by(-60_000));
        assert_eq!(c.take_seek(), Some((s(0), false)));
        // Never past the end.
        c.seeked(s(0));
        c.seek_by(1_000_000);
        assert_eq!(c.take_seek(), Some((s(97), true)));
        assert_eq!(c.status().changes, 1);
    }

    #[test]
    fn looped_seeks_wrap() {
        let c = PlaybackControl::new();
        c.enable(Some(s(30)), true);
        c.set_position(s(25));
        c.seek_by(10_000);
        assert_eq!(c.take_seek(), Some((s(5), false)));
        c.set_position(s(65));
        assert_eq!(c.status().position, s(5));
    }

    #[test]
    fn pause_toggles_as_asked_last() {
        let c = PlaybackControl::new();
        c.enable(None, false);
        assert!(c.toggle_pause());
        assert!(c.status().paused);
        assert!(c.pending());
        // Twice before the input saw it: nothing to do.
        assert!(c.toggle_pause());
        assert!(!c.pending());
        c.toggle_pause();
        assert_eq!(c.take_pause(), Some(true));
        c.paused(true);
        assert!(c.status().paused);
        assert_eq!(c.status().changes, 1);
        c.toggle_pause();
        assert_eq!(c.take_pause(), Some(false));
        c.disable();
        assert!(!c.set_paused(true));
    }
}
