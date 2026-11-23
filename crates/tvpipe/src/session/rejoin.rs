//! Reconnecting receivers that drop out mid-session (`--reconnect`).
//!
//! Every Cast and AirPlay sink of a session is wrapped in a
//! [`Rejoining`] sink. When the inner sink fails with a connection error
//! (the control channel broke, writes or feedback timed out: the
//! receiver left the network or changed its address), the wrapper keeps
//! its place in the fanout and a worker thread connects again with
//! backoff ([`Backoff`]) for at most [`Rejoin::window`]:
//!
//! - a receiver given by name is looked up again (mDNS; it may have a new
//!   address), with the same protocol (`cast:NAME` / `airplay:NAME`); one
//!   given as an address is retried at that address;
//! - the connection uses the session's options (Cast: the OFFER of the
//!   session, its audio restricted to the running track; AirPlay:
//!   pair-verify with the stored credentials, FairPlay, SETUP);
//! - the new sink must take the running stream ([`compatible`]: codec,
//!   size, frame rate, audio family); otherwise it stays dropped;
//! - it gets the session's clock and the running stream's
//!   [`VideoInfo`]/[`AudioInfo`], so it joins the shared timeline, and
//!   its first video frame is a keyframe (the wrapper asks the fanout for
//!   one, which asks the input).
//!
//! While the receiver is away, frames are dropped for it; the other sinks
//! are not affected (each has its own fanout thread). A receiver that
//! ended the session itself ([`SinkStatus::Finished`]: the user stopped
//! mirroring, the Cast app stopped, the AirPlay receiver closed the
//! stream) is not reconnected, and neither is a sink that failed for
//! another reason (bad media, a protocol error).
//!
//! Logs (INFO): "lost X (reason); reconnecting…", "X back after N s",
//! "gave up on X after N s".

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, Sender, TryRecvError};
use std::sync::Arc;
use std::time::{Duration, Instant};

use super::{address_target, parse_target, resolve_target, Target};
use crate::airplay::MirrorOptions;
use crate::cast::CastOptions;
use crate::ctx::Ctx;
use crate::error::{Error, ErrorKind, Result};
use crate::events::{Events, ReceiverState};
use crate::media::clock::SessionClock;
use crate::types::{
    AudioFamily, AudioInfo, Capabilities, EncodedFrame, Sink, SinkStatus, TrackKind, VideoInfo,
};

/// Looks a `--to` up (`cast:NAME`, `airplay:NAME`, an address).
pub(super) type Resolve = Arc<dyn Fn(&str) -> Result<Target> + Send + Sync>;
/// Connects a target (like [`super::connect_one`]).
pub(super) type Connect =
    Arc<dyn Fn(&Target, &CastOptions, &MirrorOptions) -> Result<Box<dyn Sink>> + Send + Sync>;

/// Retry delays: `first`, doubled up to `max`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct Backoff {
    pub first: Duration,
    pub max: Duration,
}

impl Backoff {
    pub const DEFAULT: Backoff = Backoff {
        first: Duration::from_secs(1),
        max: Duration::from_secs(30),
    };

    fn next(&self, d: Duration) -> Duration {
        (d * 2).min(self.max)
    }
}

/// How lost receivers come back.
#[derive(Clone)]
pub(super) struct Rejoin {
    /// How long to keep trying after a loss; zero: never.
    pub window: Duration,
    pub backoff: Backoff,
    pub resolve: Resolve,
    pub connect: Connect,
    /// Where `lost`, `reconnected` and `gave-up` go.
    pub events: Events,
}

impl Rejoin {
    /// Discovery and the real protocols.
    pub fn system(window: Duration, ctx: &Ctx) -> Rejoin {
        let ctx = ctx.clone();
        Rejoin {
            window,
            backoff: Backoff::DEFAULT,
            resolve: Arc::new(resolve_target),
            events: ctx.events.clone(),
            connect: Arc::new(move |t, o, m| super::connect_one(t, o, m, &ctx)),
        }
    }
}

/// Wraps a connected sink so it is reconnected when it drops out; the
/// browser player and sessions without `--reconnect` stay as they are.
pub(super) fn wrap(
    target: &Target,
    sink: Box<dyn Sink>,
    rejoin: &Rejoin,
    cast: &CastOptions,
    mirror: &MirrorOptions,
) -> Box<dyn Sink> {
    let (proto, name) = match target {
        Target::Cast { name, .. } => ("cast", name),
        Target::AirPlay { name, .. } => ("airplay", name),
        Target::Browser(_) => return sink,
    };
    if rejoin.window.is_zero() {
        return sink;
    }
    let query = format!("{proto}:{name}");
    let (forced, rest) = parse_target(&query);
    let by_name = address_target(forced, rest).is_none();
    Box::new(Rejoining {
        name: sink.name().to_owned(),
        caps: sink.capabilities().clone(),
        job: Arc::new(Job {
            name: sink.name().to_owned(),
            query,
            by_name,
            target: target.clone(),
            rejoin: rejoin.clone(),
            cast: cast.clone(),
            mirror: mirror.clone(),
        }),
        clock: None,
        media: None,
        state: State::Live {
            sink,
            need_key: false,
        },
    })
}

/// Whether a sink's error means the receiver is out of reach (and might
/// come back), rather than that the stream or the protocol went wrong.
pub(super) fn is_loss(e: &Error) -> bool {
    matches!(
        e.kind(),
        ErrorKind::Io | ErrorKind::Closed | ErrorKind::Timeout
    )
}

/// Whether a (re)connected receiver takes the running stream: its limits
/// may have changed (another device answers at that name, a different
/// screen), and the session's encode does not change for one receiver.
pub(super) fn compatible(
    caps: &Capabilities,
    video: &VideoInfo,
    family: AudioFamily,
) -> Result<()> {
    if !caps.video_codecs.contains(&video.codec) {
        return Err(Error::unsupported(format!(
            "it no longer takes {:?} (it offers {:?})",
            video.codec, caps.video_codecs
        )));
    }
    if video.width > caps.max_width || video.height > caps.max_height {
        return Err(Error::unsupported(format!(
            "the stream is {}x{}, it now takes at most {}x{}",
            video.width, video.height, caps.max_width, caps.max_height
        )));
    }
    let max_fps = caps.max_fps;
    if max_fps.num > 0 && max_fps.den > 0 && video.fps.as_f64() > max_fps.as_f64() + 0.01 {
        return Err(Error::unsupported(format!(
            "the stream has {} fps, it now takes at most {max_fps}",
            video.fps
        )));
    }
    if caps.audio_family != family {
        return Err(Error::unsupported(format!(
            "it now takes {:?} audio instead of {family:?}",
            caps.audio_family
        )));
    }
    Ok(())
}

/// What the wrapper needs to connect again.
struct Job {
    /// For logs.
    name: String,
    /// `cast:NAME` / `airplay:NAME` (or the address).
    query: String,
    /// Looked up again (else `target` is retried).
    by_name: bool,
    target: Target,
    rejoin: Rejoin,
    cast: CastOptions,
    mirror: MirrorOptions,
}

/// What a reconnect worker reports.
enum Outcome {
    /// Connected and started.
    Back(Box<dyn Sink>),
    /// Every attempt failed within the window: the last error.
    GaveUp(Error),
    /// It answered but cannot take the running stream.
    Incompatible(Error),
}

enum State {
    Live {
        sink: Box<dyn Sink>,
        /// Rejoined: drop video until a keyframe went through.
        need_key: bool,
    },
    Away {
        since: Instant,
        outcome: Receiver<Outcome>,
        cancel: Arc<AtomicBool>,
    },
    Gone,
}

/// A sink that reconnects its receiver (module docs).
pub(super) struct Rejoining {
    name: String,
    /// The first connection's, which the fanout planned with.
    caps: Capabilities,
    job: Arc<Job>,
    clock: Option<SessionClock>,
    /// What `start` got, for the sinks that replace this one.
    media: Option<(VideoInfo, Option<AudioInfo>)>,
    state: State,
}

impl Rejoining {
    /// The receiver is out of reach: start reconnecting.
    fn lose(&mut self, e: Error) {
        let old = std::mem::replace(&mut self.state, State::Gone);
        if let State::Live { sink, .. } = old {
            // Tell it we are done, if it still listens (a TEARDOWN can
            // take seconds on a receiver that does not answer).
            stop_detached(sink);
        }
        let Some((video, audio)) = self.media.clone() else {
            // Lost before it started: nothing to rejoin.
            return;
        };
        info!("lost {} ({e}); reconnecting…", self.name);
        self.job
            .rejoin
            .events
            .receiver(&self.name, None, ReceiverState::Lost, Some(&e));
        let (tx, rx) = mpsc::channel();
        let cancel = Arc::new(AtomicBool::new(false));
        let worker = Worker {
            job: self.job.clone(),
            clock: self.clock.clone(),
            family: self.caps.audio_family,
            video,
            audio,
            cancel: cancel.clone(),
            outcome: tx,
            last: e,
        };
        let spawned = std::thread::Builder::new()
            .name(format!("rejoin-{}", self.name))
            .spawn(move || worker.run());
        if let Err(e) = spawned {
            error!("{}: cannot reconnect: {e}", self.name);
            return;
        }
        self.state = State::Away {
            since: Instant::now(),
            outcome: rx,
            cancel,
        };
    }

    /// Takes the worker's outcome, if there is one. `Err` once it gave up.
    fn poll(&mut self) -> Result<()> {
        let State::Away { since, outcome, .. } = &self.state else {
            return Ok(());
        };
        let secs = since.elapsed().as_secs_f64();
        match outcome.try_recv() {
            Err(TryRecvError::Empty) => Ok(()),
            Ok(Outcome::Back(sink)) => {
                info!("{} back after {secs:.1} s", self.name);
                self.job
                    .rejoin
                    .events
                    .receiver(&self.name, None, ReceiverState::Reconnected, None);
                self.state = State::Live {
                    sink,
                    need_key: true,
                };
                Ok(())
            }
            Ok(Outcome::GaveUp(e)) => {
                info!("gave up on {} after {secs:.1} s", self.name);
                self.state = State::Gone;
                let e = Error::new(
                    e.kind(),
                    format!("gave up reconnecting after {secs:.1} s: {e}"),
                );
                self.job
                    .rejoin
                    .events
                    .receiver(&self.name, None, ReceiverState::GaveUp, Some(&e));
                Err(e)
            }
            Ok(Outcome::Incompatible(e)) => {
                error!(
                    "{} is back but cannot take the running stream ({e}); leaving it out",
                    self.name
                );
                self.state = State::Gone;
                Err(e)
            }
            Err(TryRecvError::Disconnected) => {
                self.state = State::Gone;
                Err(Error::process(format!(
                    "{}: reconnect thread died",
                    self.name
                )))
            }
        }
    }
}

/// Stops a sink on a thread of its own.
fn stop_detached(mut sink: Box<dyn Sink>) {
    let name = sink.name().to_owned();
    let r = std::thread::Builder::new()
        .name(format!("rejoin-stop-{name}"))
        .spawn(move || {
            if let Err(e) = sink.stop() {
                debug!("{}: stop after the loss: {e}", sink.name());
            }
        });
    if let Err(e) = r {
        debug!("{name}: cannot stop the lost sink: {e}");
    }
}

impl Sink for Rejoining {
    fn name(&self) -> &str {
        &self.name
    }

    fn capabilities(&self) -> &Capabilities {
        &self.caps
    }

    fn set_clock(&mut self, clock: SessionClock) {
        self.clock = Some(clock.clone());
        if let State::Live { sink, .. } = &mut self.state {
            sink.set_clock(clock);
        }
    }

    fn start(&mut self, video: &VideoInfo, audio: Option<&AudioInfo>) -> Result<()> {
        let State::Live { sink, .. } = &mut self.state else {
            return Err(Error::protocol("rejoin: start after a loss"));
        };
        sink.start(video, audio)?;
        self.media = Some((video.clone(), audio.cloned()));
        Ok(())
    }

    fn push(&mut self, frame: &EncodedFrame) -> Result<SinkStatus> {
        self.poll()?;
        let video = frame.track == TrackKind::Video;
        let r = match &mut self.state {
            State::Live { sink, need_key } => {
                if *need_key && video && !frame.keyframe {
                    return Ok(SinkStatus::Dropped);
                }
                let r = sink.push(frame);
                if *need_key && video && matches!(r, Ok(SinkStatus::Accepted)) {
                    *need_key = false;
                }
                r
            }
            State::Away { .. } => return Ok(SinkStatus::Dropped),
            State::Gone => return Err(Error::closed(format!("{} is gone", self.name))),
        };
        match r {
            Err(e) if is_loss(&e) && self.media.is_some() => {
                self.lose(e);
                Ok(SinkStatus::Dropped)
            }
            other => other,
        }
    }

    fn wants_keyframe(&self) -> bool {
        match &self.state {
            State::Live { sink, need_key } => *need_key || sink.wants_keyframe(),
            // Nobody to send one to.
            State::Away { .. } | State::Gone => false,
        }
    }

    fn backlog(&self) -> Option<crate::types::Backlog> {
        match &self.state {
            State::Live { sink, .. } => sink.backlog(),
            State::Away { .. } | State::Gone => None,
        }
    }

    fn stop(&mut self) -> Result<()> {
        match std::mem::replace(&mut self.state, State::Gone) {
            State::Live { mut sink, .. } => sink.stop(),
            State::Away { cancel, .. } => {
                cancel.store(true, Ordering::Release);
                Ok(())
            }
            State::Gone => Ok(()),
        }
    }
}

impl Drop for Rejoining {
    fn drop(&mut self) {
        let _ = self.stop();
    }
}

/// Connects a lost receiver again, on a thread of its own.
struct Worker {
    job: Arc<Job>,
    clock: Option<SessionClock>,
    family: AudioFamily,
    video: VideoInfo,
    audio: Option<AudioInfo>,
    cancel: Arc<AtomicBool>,
    outcome: Sender<Outcome>,
    /// Why the last attempt (or the stream) failed.
    last: Error,
}

/// What one attempt came to.
enum Attempt {
    Back(Box<dyn Sink>),
    Failed(Error),
    Incompatible(Error),
}

impl Worker {
    fn run(mut self) {
        let job = self.job.clone();
        let deadline = Instant::now() + job.rejoin.window;
        let mut delay = job.rejoin.backoff.first;
        loop {
            if self.cancelled() {
                return;
            }
            match self.attempt() {
                Attempt::Back(mut sink) => {
                    if self.cancelled() {
                        let _ = sink.stop();
                        return;
                    }
                    if let Err(mpsc::SendError(Outcome::Back(mut sink))) =
                        self.outcome.send(Outcome::Back(sink))
                    {
                        let _ = sink.stop();
                    }
                    return;
                }
                Attempt::Incompatible(e) => {
                    let _ = self.outcome.send(Outcome::Incompatible(e));
                    return;
                }
                Attempt::Failed(e) => {
                    debug!("{}: reconnecting: {e}", job.name);
                    self.last = e;
                }
            }
            let now = Instant::now();
            if now >= deadline {
                let _ = self.outcome.send(Outcome::GaveUp(self.last));
                return;
            }
            // The last attempt at the deadline.
            let until = (now + delay).min(deadline);
            while Instant::now() < until {
                if self.cancelled() {
                    return;
                }
                std::thread::sleep(Duration::from_millis(20).min(until - Instant::now()));
            }
            delay = job.rejoin.backoff.next(delay);
        }
    }

    fn cancelled(&self) -> bool {
        self.cancel.load(Ordering::Acquire)
    }

    fn attempt(&self) -> Attempt {
        let job = &self.job;
        let target = if job.by_name {
            match (job.rejoin.resolve)(&job.query) {
                Ok(t) => t,
                Err(e) => return Attempt::Failed(e),
            }
        } else {
            job.target.clone()
        };
        match (&job.target, &target) {
            (Target::Cast { addr: a, .. }, Target::Cast { addr: b, .. })
            | (Target::AirPlay { addr: a, .. }, Target::AirPlay { addr: b, .. }) => {
                if a != b {
                    debug!("{}: now at {b} (was {a})", job.name);
                }
            }
            _ => {
                return Attempt::Failed(Error::not_found(format!(
                    "{} resolved to another protocol",
                    job.name
                )))
            }
        }
        // The OFFER of the session, with the running audio track only
        // (the receiver must not pick another codec).
        let mut cast = job.cast.clone();
        if let Some(a) = self
            .audio
            .as_ref()
            .filter(|_| self.family == AudioFamily::Cast)
        {
            cast.audio_codecs = vec![a.codec];
            cast.audio_sample_rate = a.sample_rate;
            cast.audio_channels = a.channels;
        }
        let mut sink = match (job.rejoin.connect)(&target, &cast, &job.mirror) {
            Ok(s) => s,
            Err(e) => return Attempt::Failed(e),
        };
        if let Err(e) = compatible(sink.capabilities(), &self.video, self.family) {
            let _ = sink.stop();
            return Attempt::Incompatible(e);
        }
        if let Some(c) = &self.clock {
            sink.set_clock(c.clone());
        }
        match sink.start(&self.video, self.audio.as_ref()) {
            Ok(()) => Attempt::Back(sink),
            Err(e) => {
                let _ = sink.stop();
                if e.kind() == ErrorKind::Unsupported {
                    Attempt::Incompatible(e)
                } else {
                    Attempt::Failed(e)
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{AudioFormat, VideoCodec};
    use crate::util::ratio::Ratio;

    #[test]
    fn backoff_doubles_up_to_the_cap() {
        let b = Backoff::DEFAULT;
        let mut d = b.first;
        let mut seen = Vec::new();
        for _ in 0..8 {
            seen.push(d.as_secs());
            d = b.next(d);
        }
        assert_eq!(seen, [1, 2, 4, 8, 16, 30, 30, 30]);
    }

    #[test]
    fn losses() {
        let io = Error::io("x", std::io::Error::other("reset"));
        assert!(is_loss(&io));
        assert!(is_loss(&Error::closed("control channel ended")));
        assert!(is_loss(&Error::timeout("no feedback")));
        assert!(!is_loss(&Error::malformed("avcC")));
        assert!(!is_loss(&Error::protocol("audio too late")));
        assert!(!is_loss(&Error::unsupported("codec")));
    }

    #[test]
    fn compatibility() {
        let caps = Capabilities {
            max_width: 1280,
            max_height: 720,
            max_fps: Ratio::integer(30),
            video_codecs: vec![VideoCodec::H264],
            audio_formats: vec![AudioFormat {
                codec: crate::types::AudioCodec::Opus,
                sample_rate: 48_000,
                channels: 2,
            }],
            audio_family: AudioFamily::Cast,
            max_bitrate_kbps: None,
            max_pixels_per_second: None,
            min_latency_ms: None,
            preferred_latency_ms: None,
            max_key_interval_ms: None,
            display_aspect: None,
        };
        let video = VideoInfo {
            codec: VideoCodec::H264,
            width: 1280,
            height: 720,
            fps: Ratio::new(30000, 1001),
            avcc: Vec::new(),
        };
        assert!(compatible(&caps, &video, AudioFamily::Cast).is_ok());
        let e = compatible(&caps, &video, AudioFamily::AirPlay).unwrap_err();
        assert_eq!(e.kind(), ErrorKind::Unsupported);
        let big = VideoInfo {
            width: 1920,
            height: 1080,
            ..video.clone()
        };
        let e = compatible(&caps, &big, AudioFamily::Cast).unwrap_err();
        assert!(e.to_string().contains("1920x1080"), "{e}");
        let fast = VideoInfo {
            fps: Ratio::integer(60),
            ..video.clone()
        };
        assert!(compatible(&caps, &fast, AudioFamily::Cast).is_err());
        let hevc = Capabilities {
            video_codecs: vec![VideoCodec::Hevc],
            ..caps.clone()
        };
        assert!(compatible(&hevc, &video, AudioFamily::Cast).is_err());
    }
}
