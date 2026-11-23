//! What the API drives: discovery, pairing and the cast. The real one uses
//! the public API ([`Discovery`](crate::api::Discovery), `Pairing`,
//! [`share`](crate::api::share)); tests put fakes in its place.

use std::path::PathBuf;
use std::sync::Mutex;

use super::resolution::Picture;
use crate::codec::json::Value;
use crate::error::Result;
use crate::storage::Storage;

/// Discovery while the launcher watches.
pub trait Discover: Send {
    /// The receivers found so far (the API's device objects).
    fn devices(&self) -> Vec<Value>;
}

/// One pairing.
pub trait Pair: Send {
    /// `{state: connecting|pin|done|failed, error?}`.
    fn state(&self) -> Value;
    fn submit(&self, pin: &str) -> Result<()>;
    fn cancel(&self);
}

/// One cast session.
pub trait Cast: Send {
    /// `{state: starting|streaming|failed|stopped, receivers, player?, error?}`.
    fn status(&mut self) -> Value;
    /// TEARDOWN to the receivers, the headless browser quits.
    fn stop(self: Box<Self>);
    /// Shows another page in the same tab: the receivers keep their
    /// sessions (docs/game-switching.md). `Err`: cast it anew.
    fn navigate(&mut self, url: &str) -> Result<()> {
        let _ = url;
        Err(crate::error::Error::unsupported("this cast shows one page"))
    }
}

/// What a surface streams (docs/playshare-design.md §17).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SurfaceSpec {
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    /// PCM: sample rate and channels.
    pub audio: Option<(u32, u8)>,
    pub bitrate_kbps: Option<u32>,
}

/// One surface's session: the page's H.264 and PCM in, receivers out
/// (the program's-own-H.264 path of [`Stream`](crate::api::Stream)).
pub trait SurfaceSink: Send {
    /// The decoder configuration (avcC, or Annex B parameter sets).
    fn config(&mut self, data: &[u8], annex_b: bool) -> Result<()>;
    /// One access unit; false when it was dropped.
    fn video(
        &mut self,
        au: &[u8],
        pts: std::time::Duration,
        key: bool,
        annex_b: bool,
    ) -> Result<bool>;
    /// Interleaved s16 PCM.
    fn audio(&mut self, pcm: &[i16], pts: std::time::Duration) -> Result<()>;
    /// Whether a receiver wants an IDR (since the last call).
    fn keyframe_wanted(&mut self) -> bool;
    /// The stream's clock (what pts are measured on).
    fn elapsed(&self) -> std::time::Duration;
    /// `{state: starting|streaming|failed|stopped, receivers, player?}`.
    fn status(&mut self) -> Value;
    fn stop(self: Box<Self>);
}

pub trait Backend: Send + Sync {
    fn discover(&self) -> Result<Box<dyn Discover>>;
    fn pair(&self, device: &str) -> Result<Box<dyn Pair>>;
    /// Casts the page at `url` (on the local origin) to `to`.
    fn cast(&self, url: &str, to: &[String], picture: Picture) -> Result<Box<dyn Cast>>;
    /// A session for a surface's encoded frames.
    fn surface(&self, to: &[String], spec: SurfaceSpec) -> Result<Box<dyn SurfaceSink>>;
    /// Where the TVs' lags are kept (none: for this run only).
    fn storage(&self) -> Option<&Storage> {
        None
    }
}

/// Receivers as the status objects show them.
fn receivers_value(list: &[crate::api::ReceiverInfo]) -> Value {
    Value::array(
        list.iter()
            .map(|r| {
                Value::object()
                    .with("name", r.name.as_str())
                    .with_opt("protocol", r.protocol.map(|p| p.as_str()))
                    .with("state", r.state.as_str())
                    .with_opt("error", r.error.as_deref())
                    .with_opt("code", r.code.as_deref())
                    .with_opt("delayMs", r.delay_ms)
            })
            .collect::<Vec<_>>(),
    )
}

/// The API's view of a receiver.
pub fn device_value(d: &crate::net::discover::DeviceInfo) -> Option<Value> {
    let airplay = d.airplay.as_ref().filter(|a| a.mirroring);
    let cast = d.cast.as_ref().filter(|c| c.video && !c.group);
    let kind = match (airplay.is_some(), cast.is_some()) {
        (true, true) => "both",
        (true, false) => "airplay",
        (false, true) => "cast",
        (false, false) => return None,
    };
    let paired = airplay.and_then(|a| a.paired);
    // Its Apple Home takes only its members, and there is no pairing to try.
    let home_only =
        kind == "airplay" && airplay.is_some_and(|a| a.home_only) && paired != Some(true);
    // A receiver that shows a PIN (or takes its password) and has no
    // pairing here needs one
    // (cast picks Cast for "both", so only AirPlay-only ones).
    let needs_pin = kind == "airplay"
        && !home_only
        && airplay.is_some_and(|a| a.pin || a.password_pin)
        && paired != Some(true);
    Some(
        Value::object()
            .with("name", d.name.as_str())
            .with("kind", kind)
            .with_opt("model", d.model.as_deref())
            .with("needsPairing", needs_pin)
            .with("homeOnly", home_only)
            .with_opt("paired", paired),
    )
}

/// The real thing.
pub struct Real {
    pub storage: Storage,
    pub browser: Option<PathBuf>,
    /// `--bitrate`: the TV page's stream (a surface's page picks its own).
    pub bitrate_kbps: Option<u32>,
}

struct RealDiscover(crate::api::Discovery);

impl Discover for RealDiscover {
    fn devices(&self) -> Vec<Value> {
        self.0.devices().iter().filter_map(device_value).collect()
    }
}

#[cfg(feature = "airplay")]
struct RealPair(crate::api::Pairing);

#[cfg(feature = "airplay")]
impl Pair for RealPair {
    fn state(&self) -> Value {
        use crate::api::PairingState;
        match self.0.state() {
            PairingState::Connecting => Value::object().with("state", "connecting"),
            PairingState::NeedPin(req) => Value::object()
                .with("state", "pin")
                .with("password", req.password),
            PairingState::Done(_) => Value::object().with("state", "done"),
            PairingState::Failed(e) => Value::object()
                .with("state", "failed")
                .with("error", e.message()),
        }
    }

    fn submit(&self, pin: &str) -> Result<()> {
        self.0.submit_pin(pin)
    }

    fn cancel(&self) {
        self.0.cancel();
    }
}

struct RealCast {
    session: Mutex<crate::api::Session>,
    error: Option<String>,
}

impl Cast for RealCast {
    fn status(&mut self) -> Value {
        use crate::api::SessionState;
        let s = self.session.get_mut().unwrap_or_else(|e| e.into_inner());
        for e in s.poll_events() {
            if let crate::events::Event::Error(info) = e {
                self.error = Some(info.message.clone());
            }
        }
        let state = match s.state() {
            SessionState::Connecting => "starting",
            SessionState::Streaming => "streaming",
            _ if self.error.is_some() => "failed",
            _ => "stopped",
        };
        Value::object()
            .with("state", state)
            .with("receivers", receivers_value(&s.receivers()))
            .with_opt("player", s.player_url())
            .with_opt("error", self.error.as_deref())
    }

    fn stop(self: Box<Self>) {
        let s = self.session.into_inner().unwrap_or_else(|e| e.into_inner());
        let _ = s.stop();
    }

    fn navigate(&mut self, url: &str) -> Result<()> {
        let s = self.session.get_mut().unwrap_or_else(|e| e.into_inner());
        s.navigate(url)
    }
}

struct RealSurface {
    stream: crate::api::Stream,
    error: Option<String>,
}

impl SurfaceSink for RealSurface {
    fn config(&mut self, data: &[u8], annex_b: bool) -> Result<()> {
        let f = if annex_b {
            crate::api::ConfigFormat::AnnexB
        } else {
            crate::api::ConfigFormat::Avcc
        };
        self.stream.write_h264_config(data, f)
    }

    fn video(
        &mut self,
        au: &[u8],
        pts: std::time::Duration,
        key: bool,
        annex_b: bool,
    ) -> Result<bool> {
        let w = self
            .stream
            .write_h264(au, crate::api::H264::new(pts, key, annex_b))?;
        Ok(matches!(w, crate::api::Written::Queued))
    }

    fn audio(&mut self, pcm: &[i16], pts: std::time::Duration) -> Result<()> {
        self.stream.write_audio(pcm, pts)
    }

    fn keyframe_wanted(&mut self) -> bool {
        self.stream.take_keyframe_request()
    }

    fn elapsed(&self) -> std::time::Duration {
        self.stream.elapsed()
    }

    fn status(&mut self) -> Value {
        use crate::api::SessionState;
        for e in self.stream.poll_events() {
            if let crate::events::Event::Error(info) = e {
                self.error = Some(info.message.clone());
            }
        }
        let state = match self.stream.state() {
            SessionState::Connecting => "starting",
            SessionState::Streaming => "streaming",
            _ if self.error.is_some() => "failed",
            _ => "stopped",
        };
        Value::object()
            .with("state", state)
            .with("receivers", receivers_value(&self.stream.receivers()))
            .with_opt("player", self.stream.player_url())
            .with_opt("error", self.error.as_deref())
    }

    fn stop(self: Box<Self>) {
        let _ = self.stream.stop();
    }
}

impl Backend for Real {
    fn storage(&self) -> Option<&Storage> {
        Some(&self.storage)
    }

    fn surface(&self, to: &[String], spec: SurfaceSpec) -> Result<Box<dyn SurfaceSink>> {
        let mut opts = crate::api::Options::new()
            .storage(self.storage.clone())
            .h264(spec.width, spec.height, spec.fps);
        for t in to {
            opts = opts.to(t.as_str());
        }
        if let Some((rate, ch)) = spec.audio {
            opts = opts.audio(rate, ch);
        }
        if let Some(k) = spec.bitrate_kbps {
            opts = opts.bitrate_kbps(k);
        }
        Ok(Box::new(RealSurface {
            stream: crate::api::Stream::start(opts)?,
            error: None,
        }))
    }

    fn discover(&self) -> Result<Box<dyn Discover>> {
        let opts = crate::api::Options::new().storage(self.storage.clone());
        Ok(Box::new(RealDiscover(crate::api::Discovery::start(&opts)?)))
    }

    #[cfg(feature = "airplay")]
    fn pair(&self, device: &str) -> Result<Box<dyn Pair>> {
        let opts = crate::api::Options::new().storage(self.storage.clone());
        Ok(Box::new(RealPair(crate::api::Pairing::start(
            device, &opts,
        )?)))
    }

    #[cfg(not(feature = "airplay"))]
    fn pair(&self, _device: &str) -> Result<Box<dyn Pair>> {
        Err(crate::error::Error::unsupported("pairing needs AirPlay"))
    }

    fn cast(&self, url: &str, to: &[String], picture: Picture) -> Result<Box<dyn Cast>> {
        let mut opts = crate::api::Options::new().storage(self.storage.clone());
        for t in to {
            opts = opts.to(t.as_str());
        }
        opts = picture_options(opts, picture);
        if let Some(k) = self.bitrate_kbps {
            opts = opts.bitrate_kbps(k);
        }
        if let Some(b) = &self.browser {
            opts = opts.browser_path(b.clone());
        }
        let session = crate::api::share(Some(url), opts)?;
        Ok(Box::new(RealCast {
            session: Mutex::new(session),
            error: None,
        }))
    }
}

/// The share options of a TV picture: fixed (`tv.resolution: "fixed"`)
/// is exactly the layout at scale 1, as the stream's size (the receivers'
/// shape without one); a chosen resolution renders the layout (`None`:
/// the receivers' shape within 1920x1080) at the device scale factor
/// that fills the resolution's box (docs/playshare-design.md §9.1).
fn picture_options(opts: crate::api::Options, picture: Picture) -> crate::api::Options {
    let opts = match picture.layout {
        Some((w, h)) => opts.size(w, h),
        None => opts,
    };
    match picture.resolution {
        Some(r) => opts.resolution(r),
        None => opts,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::playshare::resolution::Resolution;

    /// (`--size`, the page's resolution) of a picture's `share URL`.
    fn mapped(picture: Picture) -> (Option<(u32, u32)>, Option<Resolution>) {
        let o =
            picture_options(crate::api::Options::new(), picture).share_options(Some("http://x/"));
        (
            o.size.map(|s| (s.width, s.height)),
            o.page.and_then(|p| p.resolution),
        )
    }

    #[test]
    fn pictures_map_to_share_options() {
        // Fixed: the layout is the stream, at scale 1 (no resolution).
        let fixed = Picture {
            layout: Some((1280, 720)),
            resolution: None,
        };
        assert_eq!(mapped(fixed), (Some((1280, 720)), None));
        // A choice: the layout rendered at the resolution.
        let chosen = Picture {
            layout: Some((1280, 720)),
            resolution: Some(Resolution::P2160),
        };
        assert_eq!(mapped(chosen), (Some((1280, 720)), Some(Resolution::P2160)));
        // No layout: the receivers' shape within 1920x1080, at auto.
        let shaped = Picture {
            layout: None,
            resolution: Some(Resolution::Auto),
        };
        assert_eq!(mapped(shaped), (None, Some(Resolution::Auto)));
        let neither = Picture {
            layout: None,
            resolution: None,
        };
        assert_eq!(mapped(neither), (None, None));
    }
}
