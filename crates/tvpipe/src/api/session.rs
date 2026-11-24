//! [`Session`]: a running command (`play`, `test_pattern`, `preview`,
//! `share`, and the session inside a [`Stream`](crate::Stream)) on a
//! thread of its own, with its events, its state and its end.

use std::collections::{BTreeMap, VecDeque};
use std::sync::mpsc;
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use crate::ctx::Ctx;
use crate::error::{Error, Result};
use crate::events::{EndInfo, EndReason, Event, Events, Protocol, ReceiverState, Started, Stats};
use crate::opts::Command;
use crate::playback::PlaybackStatus;
use crate::session::GameIo;
use crate::util::stop::Stop;

/// Events kept for [`Session::poll_events`]; older ones are dropped.
const EVENT_QUEUE: usize = 256;

/// Where a session is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum SessionState {
    /// Finding and connecting the receivers, opening the input.
    Connecting,
    /// Frames flow.
    Streaming,
    /// Over (see [`Session::wait`]).
    Ended,
}

/// The latest state of one receiver.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub struct ReceiverInfo {
    /// The receiver, as given or as discovered.
    pub name: String,
    /// Known once it connected (or failed while connecting).
    pub protocol: Option<Protocol>,
    /// Its latest state.
    pub state: ReceiverState,
    /// What went wrong, with `failed`, `lost`, `gave-up`.
    pub error: Option<String>,
    /// A stable code for the error, e.g. `pairing-required`.
    pub code: Option<String>,
    /// The playout delay it shows video with, ms after a frame's
    /// instant (known once connected; the display's own lag comes on top).
    pub delay_ms: Option<u32>,
}

/// A view of a session's state for writers on other threads.
#[derive(Clone)]
pub(crate) struct StateHandle(Arc<Shared>);

impl StateHandle {
    /// The receivers are connected and the session still runs.
    pub(crate) fn connected(&self) -> bool {
        let st = self.0.lock();
        st.connected && !st.finished
    }
}

/// A session's event callback (`Options::on_event`).
pub type Callback = Box<dyn FnMut(&Event) + Send>;

#[derive(Default)]
struct State {
    queue: VecDeque<Event>,
    receivers: BTreeMap<String, ReceiverInfo>,
    /// Receivers in the order they were first reported.
    order: Vec<String>,
    started: Option<Started>,
    stats: Option<Stats>,
    player_url: Option<String>,
    share_url: Option<String>,
    tunnel_urls: Vec<String>,
    connected: bool,
    end: Option<EndInfo>,
    /// The session thread returned (with this result, taken by `wait`).
    done: Option<Result<()>>,
    finished: bool,
}

pub(crate) struct Shared {
    state: Mutex<State>,
    cv: Condvar,
}

impl Shared {
    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn record(&self, e: &Event) {
        let mut st = self.lock();
        match e {
            Event::Receiver(r) => {
                if !st.receivers.contains_key(&r.name) {
                    st.order.push(r.name.clone());
                }
                let prev = st.receivers.get(&r.name);
                let protocol = r.protocol.or_else(|| prev.and_then(|i| i.protocol));
                let delay_ms = r.delay_ms.or_else(|| prev.and_then(|i| i.delay_ms));
                st.receivers.insert(
                    r.name.clone(),
                    ReceiverInfo {
                        name: r.name.clone(),
                        protocol,
                        state: r.state,
                        error: r.error.clone(),
                        code: r.code.clone(),
                        delay_ms,
                    },
                );
            }
            Event::Connected(_) => st.connected = true,
            Event::Started(s) => st.started = Some(s.clone()),
            Event::Stats(s) => st.stats = Some(s.clone()),
            Event::Player(p) => {
                st.player_url.get_or_insert_with(|| p.url.clone());
            }
            Event::SharePage(p) => st.share_url = Some(p.url.clone()),
            Event::Tunnel(t) => st.tunnel_urls.push(t.url.clone()),
            Event::End(e) => st.end = Some(e.clone()),
            _ => {}
        }
        if st.queue.len() >= EVENT_QUEUE {
            st.queue.pop_front();
        }
        st.queue.push_back(e.clone());
        drop(st);
        self.cv.notify_all();
    }
}

/// A running session. Stop it with [`stop`](Session::stop), let it end
/// with [`wait`](Session::wait); dropping it stops it (and blocks until
/// every receiver got its teardown, a few seconds at most).
///
/// Events: [`poll_events`](Session::poll_events) drains a queue (the
/// latest 256), `Options::on_event` calls a function on a thread of the
/// session's own; the snapshots ([`receivers`](Session::receivers),
/// [`stats`](Session::stats), …) need neither.
pub struct Session {
    shared: Arc<Shared>,
    stop: Stop,
    /// `share` of a URL: another page for its tab.
    page: Option<crate::opts::PageControl>,
    /// `play` of a file or URL: seeking and pausing.
    playback: Option<crate::playback::PlaybackControl>,
    thread: Option<JoinHandle<()>>,
    dispatcher: Option<JoinHandle<()>>,
}

impl std::fmt::Debug for Session {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Session")
            .field("state", &self.state())
            .finish_non_exhaustive()
    }
}

/// Requests a session's stop from anywhere (another thread, a signal
/// handler's thread). Cloneable; see [`Session::stopper`].
#[derive(Clone, Debug)]
pub struct Stopper(Stop);

impl Stopper {
    /// Stops the session now (no playout of what is queued); the
    /// receivers get their TEARDOWN/STOP.
    pub fn stop(&self) {
        self.0.request();
    }

    /// Whether a stop was requested.
    pub fn stopped(&self) -> bool {
        self.0.requested()
    }
}

impl Session {
    /// Runs `cmd` on a thread of its own. `ctx` brings the stop token and
    /// the storage; its events go to the session (and then to `ctx.events`
    /// if that listens, synchronously, as the CLI's `--machine` wants).
    pub(crate) fn spawn(
        cmd: Command,
        mut ctx: Ctx,
        io: GameIo,
        mut callback: Option<Callback>,
    ) -> Result<Session> {
        crate::util::timer::raise_resolution();
        let page = match &cmd {
            Command::Share(o) => o.page.as_ref().and_then(|p| p.control.clone()),
            _ => None,
        };
        let playback = match &cmd {
            Command::Play(o) => o.playback.clone(),
            _ => None,
        };
        let shared = Arc::new(Shared {
            state: Mutex::new(State::default()),
            cv: Condvar::new(),
        });
        let (tx, rx) = mpsc::channel::<Event>();
        let dispatcher = match callback.take() {
            Some(mut f) => Some(
                std::thread::Builder::new()
                    .name("tvpipe-events".into())
                    .spawn(move || {
                        while let Ok(e) = rx.recv() {
                            f(&e);
                        }
                    })
                    .map_err(|e| Error::io("spawn the event thread", e))?,
            ),
            None => None,
        };
        let outer = ctx.events.clone();
        let s = shared.clone();
        let send = dispatcher.is_some().then_some(tx);
        let send = send.map(Mutex::new);
        ctx.events = Events::to(move |e| {
            s.record(&e);
            if let Some(tx) = &send {
                let _ = tx.lock().unwrap_or_else(|e| e.into_inner()).send(e.clone());
            }
            outer.emit(e);
        });
        let stop = ctx.stop.clone();
        let s = shared.clone();
        let thread = std::thread::Builder::new()
            .name("tvpipe-session".into())
            .spawn(move || {
                let rv = crate::session::run(cmd, &ctx, io);
                // The events handle (and with it the dispatcher's sender)
                // goes before the result is published.
                drop(ctx);
                let mut st = s.lock();
                st.done = Some(rv);
                st.finished = true;
                drop(st);
                s.cv.notify_all();
            })
            .map_err(|e| Error::io("spawn the session thread", e))?;
        Ok(Session {
            shared,
            stop,
            page,
            playback,
            thread: Some(thread),
            dispatcher,
        })
    }

    /// Blocks until the receivers are connected (the input opens next),
    /// or the session ended (then its error).
    pub(crate) fn wait_connected(&self) -> Result<()> {
        let mut st = self.shared.lock();
        loop {
            if st.connected {
                return Ok(());
            }
            if st.finished {
                return match st.done.take() {
                    Some(Err(e)) => {
                        st.done = Some(Err(e.clone_lossy()));
                        Err(e)
                    }
                    _ => Err(Error::closed("the session ended before it connected")),
                };
            }
            st = self.shared.cv.wait(st).unwrap_or_else(|e| e.into_inner());
        }
    }

    pub(crate) fn state_handle(&self) -> StateHandle {
        StateHandle(self.shared.clone())
    }

    /// Where the session is.
    pub fn state(&self) -> SessionState {
        let st = self.shared.lock();
        if st.finished || st.end.is_some() {
            SessionState::Ended
        } else if st.started.is_some() {
            SessionState::Streaming
        } else {
            SessionState::Connecting
        }
    }

    /// The events since the last call (at most the latest 256).
    pub fn poll_events(&mut self) -> Vec<Event> {
        self.shared.lock().queue.drain(..).collect()
    }

    /// The next event, waiting up to `timeout`; `None` when there was none
    /// (or the session is over and every event was taken).
    pub fn next_event(&mut self, timeout: Duration) -> Option<Event> {
        let until = Instant::now() + timeout;
        let mut st = self.shared.lock();
        loop {
            if let Some(e) = st.queue.pop_front() {
                return Some(e);
            }
            let now = Instant::now();
            if st.finished || now >= until {
                return None;
            }
            st = self
                .shared
                .cv
                .wait_timeout(st, until - now)
                .unwrap_or_else(|e| e.into_inner())
                .0;
        }
    }

    /// Every receiver's latest state, in the order they were first
    /// reported.
    pub fn receivers(&self) -> Vec<ReceiverInfo> {
        let st = self.shared.lock();
        st.order
            .iter()
            .filter_map(|n| st.receivers.get(n).cloned())
            .collect()
    }

    /// The latest counters (once a second while frames flow).
    pub fn stats(&self) -> Option<Stats> {
        self.shared.lock().stats.clone()
    }

    /// The plan, once streaming started.
    pub fn started(&self) -> Option<Started> {
        self.shared.lock().started.clone()
    }

    /// The page of the `browser` receiver, once it listens.
    pub fn player_url(&self) -> Option<String> {
        self.shared.lock().player_url.clone()
    }

    /// `share` without a URL: the page to open and share from.
    pub fn share_url(&self) -> Option<String> {
        self.shared.lock().share_url.clone()
    }

    /// The public links (`tunnel`), once they work.
    pub fn tunnel_urls(&self) -> Vec<String> {
        self.shared.lock().tunnel_urls.clone()
    }

    /// [`share`](crate::share) of a URL: shows `url` in the same tab
    /// instead (an `http(s)://` or `file://` URL, or a file). The
    /// receivers keep their sessions and the browser's window stays; the
    /// picture pauses while the page loads and shares again, a second or
    /// so, instead of the receivers starting over. The latest request
    /// wins; the page is opened by the browser's keeper within a moment.
    #[cfg(feature = "headless")]
    pub fn navigate(&self, url: &str) -> Result<()> {
        let page = self.page.as_ref().ok_or_else(|| {
            Error::usage("navigate: only a share of a URL shows pages").with_code("unsupported")
        })?;
        if self.shared.lock().finished {
            return Err(Error::closed("navigate: the session is over"));
        }
        let url = crate::browser::headless::page_url(url)?;
        crate::browser::headless::check_url(&url)?;
        page.navigate(url);
        Ok(())
    }

    /// [`play`](crate::play) of a file or a URL with a length: where it
    /// is, and whether it can seek and pause (`seekable` is false until
    /// the input is open, for live inputs, and after the end).
    pub fn playback(&self) -> PlaybackStatus {
        self.playback
            .as_ref()
            .map(|c| c.status())
            .unwrap_or_default()
    }

    /// Jumps to `position` in the input. Files sent unchanged land on a
    /// keyframe near it (in the direction of the jump); re-encoded ones
    /// exactly. Forward jumps stop a few seconds before the end.
    /// [`Event::Playback`] says where it landed. A later seek replaces a
    /// pending one.
    pub fn seek(&self, position: Duration) -> Result<()> {
        self.control("seek", |c| c.seek_to(position))
    }

    /// Jumps by `delta_ms` from where the input is (negative: back),
    /// or from where a seek not done yet goes; see [`Session::seek`].
    pub fn seek_by(&self, delta_ms: i64) -> Result<()> {
        self.control("seek", |c| c.seek_by(delta_ms))
    }

    /// Pauses: the receivers keep showing the picture (and get no sound)
    /// until [`resume`](Session::resume).
    pub fn pause(&self) -> Result<()> {
        self.control("pause", |c| c.set_paused(true))
    }

    /// Plays on after [`pause`](Session::pause).
    pub fn resume(&self) -> Result<()> {
        self.control("resume", |c| c.set_paused(false))
    }

    fn control(
        &self,
        what: &str,
        f: impl FnOnce(&crate::playback::PlaybackControl) -> bool,
    ) -> Result<()> {
        if self.shared.lock().finished {
            return Err(Error::closed(format!("{what}: the session is over")));
        }
        match &self.playback {
            Some(c) if f(c) => Ok(()),
            _ => Err(Error::usage(format!(
                "{what}: only play of a file or a URL with a length seeks and pauses, once it streams"
            ))
            .with_code("unsupported")),
        }
    }

    /// A handle that stops the session from another thread.
    pub fn stopper(&self) -> Stopper {
        Stopper(self.stop.clone())
    }

    /// Stops now (no playout of what is queued): every receiver gets its
    /// TEARDOWN/STOP. Returns how the session ended.
    pub fn stop(mut self) -> Result<EndInfo> {
        self.stop.request();
        self.join()
    }

    /// Waits until the session ends by itself (the input ended, every
    /// receiver left) or is stopped.
    pub fn wait(mut self) -> Result<EndInfo> {
        self.join()
    }

    /// Waits up to `timeout`; `true` when the session is over (then
    /// [`wait`](Session::wait) returns at once).
    pub fn wait_timeout(&self, timeout: Duration) -> bool {
        let until = Instant::now() + timeout;
        let mut st = self.shared.lock();
        while !st.finished {
            let now = Instant::now();
            if now >= until {
                return false;
            }
            st = self
                .shared
                .cv
                .wait_timeout(st, until - now)
                .unwrap_or_else(|e| e.into_inner())
                .0;
        }
        true
    }

    fn join(&mut self) -> Result<EndInfo> {
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
        if let Some(d) = self.dispatcher.take() {
            let _ = d.join();
        }
        let mut st = self.shared.lock();
        let end = st.end.clone();
        match st.done.take() {
            Some(Err(e)) => Err(e),
            _ => Ok(end.unwrap_or_else(|| {
                EndInfo::new(if self.stop.requested() {
                    EndReason::Stopped
                } else {
                    EndReason::Done
                })
            })),
        }
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        if self.thread.is_some() {
            self.stop.request();
            let _ = self.join();
        }
    }
}
