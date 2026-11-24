//! [`Options`]: one builder for every command.

use std::ffi::OsString;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use crate::ctx::Ctx;
use crate::events::{Event, PinRequest};
use crate::net::discover::DeviceInfo;
use crate::opts::{
    BrowserOptions, InputSpec, PageOptions, PlayOptions, RawAudioSpec, RawVideoSpec, ShareOptions,
    Size, DEFAULT_RECONNECT,
};
use crate::storage::Storage;
use crate::types::{Encoder, Resolution};
use crate::util::ratio::Ratio;

pub use crate::net::tunnel::Provider as TunnelProvider;

/// The pixel layout of raw frames given to a [`Stream`](crate::Stream).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[non_exhaustive]
pub enum PixelFormat {
    /// 4 bytes per pixel: R, G, B, A (A ignored).
    Rgba,
    /// 4 bytes per pixel: B, G, R, A (A ignored).
    Bgra,
    /// 4 bytes per pixel: R, G, B, unused.
    Rgb0,
    /// 4 bytes per pixel: B, G, R, unused: a little-endian `u32`
    /// `0x00RRGGBB` (softbuffer, minifb).
    Bgr0,
    /// 3 bytes per pixel: R, G, B.
    Rgb24,
    /// 3 bytes per pixel: B, G, R.
    Bgr24,
    /// Planar Y, then interleaved U/V at half resolution (two planes).
    Nv12,
    /// Planar Y, U, V, the chroma planes at half resolution (three planes).
    Yuv420p,
}

impl PixelFormat {
    /// The name in `--raw-video` (docs/slrw.md).
    pub fn as_str(self) -> &'static str {
        match self {
            PixelFormat::Rgba => "rgba",
            PixelFormat::Bgra => "bgra",
            PixelFormat::Rgb0 => "rgb0",
            PixelFormat::Bgr0 => "bgr0",
            PixelFormat::Rgb24 => "rgb24",
            PixelFormat::Bgr24 => "bgr24",
            PixelFormat::Nv12 => "nv12",
            PixelFormat::Yuv420p => "yuv420p",
        }
    }

    /// Bytes per pixel of the first plane.
    pub(crate) fn bytes_per_pixel(self) -> usize {
        match self {
            PixelFormat::Rgba | PixelFormat::Bgra | PixelFormat::Rgb0 | PixelFormat::Bgr0 => 4,
            PixelFormat::Rgb24 | PixelFormat::Bgr24 => 3,
            PixelFormat::Nv12 | PixelFormat::Yuv420p => 1,
        }
    }

    /// The planes: (bytes per row per pixel column numerator, row count)
    /// as fractions of the frame size, for packing.
    pub(crate) fn planes(self, width: usize, height: usize) -> Vec<(usize, usize)> {
        let (cw, ch) = (width.div_ceil(2), height.div_ceil(2));
        match self {
            PixelFormat::Nv12 => vec![(width, height), (cw * 2, ch)],
            PixelFormat::Yuv420p => vec![(width, height), (cw, ch), (cw, ch)],
            f => vec![(width * f.bytes_per_pixel(), height)],
        }
    }

    /// Bytes of one packed frame.
    pub fn frame_size(self, width: u32, height: u32) -> usize {
        self.planes(width as usize, height as usize)
            .iter()
            .map(|(row, rows)| row * rows)
            .sum()
    }
}

/// What [`play`](crate::play) streams.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum Input {
    /// A local file: MP4/MOV/Matroska that fits every receiver is sent
    /// unchanged (`files`), anything else goes through ffmpeg (`ffmpeg`).
    Path(PathBuf),
    /// A URL ffmpeg opens (`ffmpeg`).
    Url(String),
    /// ffmpeg input arguments, e.g. a capture device (`ffmpeg`).
    Ffmpeg(Vec<OsString>),
}

impl Input {
    /// A local file.
    pub fn path(p: impl Into<PathBuf>) -> Input {
        Input::Path(p.into())
    }

    /// A URL (http, rtsp, …) for ffmpeg.
    pub fn url(u: impl Into<String>) -> Input {
        Input::Url(u.into())
    }

    /// ffmpeg input arguments (`["-f", "avfoundation", "-i", "1:0"]`).
    pub fn ffmpeg<I, S>(args: I) -> Input
    where
        I: IntoIterator<Item = S>,
        S: Into<OsString>,
    {
        Input::Ffmpeg(args.into_iter().map(Into::into).collect())
    }

    pub(crate) fn spec(&self) -> InputSpec {
        match self {
            Input::Path(p) => InputSpec::Path(p.clone().into_os_string()),
            Input::Url(u) => InputSpec::Path(u.into()),
            Input::Ffmpeg(a) => InputSpec::FfmpegArgs(a.clone()),
        }
    }
}

/// The `browser` receiver: a page on 127.0.0.1 that plays the stream in
/// a browser tab (`player`).
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub struct PlayerOptions {
    port: Option<u16>,
    open: bool,
    wait_for_viewer: bool,
    new_token: bool,
    tunnel: Option<TunnelProvider>,
    tunnel_ttl: Option<Duration>,
}

impl Default for PlayerOptions {
    fn default() -> PlayerOptions {
        PlayerOptions::new()
    }
}

impl PlayerOptions {
    /// Any free port, no browser opened.
    pub fn new() -> PlayerOptions {
        PlayerOptions {
            port: Some(0),
            open: false,
            wait_for_viewer: false,
            new_token: false,
            tunnel: None,
            tunnel_ttl: None,
        }
    }

    /// The page's port on 127.0.0.1 (0: any free one, the default). A
    /// fixed port keeps the URL across runs (its token is kept in the
    /// storage).
    pub fn port(mut self, port: u16) -> Self {
        self.port = Some(port);
        self
    }

    /// The fixed default port (8765), or any free one when it is taken.
    pub fn default_port(mut self) -> Self {
        self.port = None;
        self
    }

    /// Opens the page with the OS's opener.
    pub fn open(mut self, open: bool) -> Self {
        self.open = open;
        self
    }

    /// Waits for a tab to connect before the stream starts.
    pub fn wait_for_viewer(mut self, wait: bool) -> Self {
        self.wait_for_viewer = wait;
        self
    }

    /// Makes a new lasting token (old URLs stop working).
    pub fn new_token(mut self, new: bool) -> Self {
        self.new_token = new;
        self
    }

    /// Also serves the page on a public HTTPS link (`tunnel`).
    pub fn tunnel(mut self, provider: TunnelProvider) -> Self {
        self.tunnel = Some(provider);
        self
    }

    /// The public link lets new viewers in for this long.
    pub fn tunnel_ttl(mut self, ttl: Duration) -> Self {
        self.tunnel_ttl = Some(ttl);
        self
    }

    pub(crate) fn browser(&self) -> BrowserOptions {
        BrowserOptions {
            port: self.port,
            open: self.open,
            wait_for_viewer: self.wait_for_viewer,
            new_token: self.new_token,
            tunnel: self.tunnel,
            tunnel_ttl: self.tunnel_ttl,
        }
    }
}

/// Raw frames in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct VideoSpec {
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    /// `None`: the program's own H.264.
    pub format: Option<PixelFormat>,
}

type PinFn = dyn FnMut(&PinRequest) -> Option<String> + Send;
type EventFn = dyn FnMut(&Event) + Send;
type ApproveFn = dyn Fn(&str, &dyn Fn() -> bool) -> bool + Send + Sync;

/// The settings of a command: receivers, the stream's shape, the browser
/// receiver, storage and callbacks. Fields a command does not use are
/// ignored. Cloning shares the callbacks.
///
/// ```no_run
/// use tvpipe::{Options, PixelFormat};
/// let options = Options::new()
///     .to("Living Room")
///     .video(1280, 720, 60, PixelFormat::Rgba)
///     .audio(48_000, 2);
/// ```
#[derive(Clone)]
#[non_exhaustive]
pub struct Options {
    pub(crate) to: Vec<String>,
    pub(crate) video: Option<VideoSpec>,
    pub(crate) audio: Option<(u32, u8)>,
    pub(crate) size: Option<(u32, u32)>,
    pub(crate) fps: Option<u32>,
    pub(crate) bitrate_kbps: Option<u32>,
    pub(crate) latency: Option<Duration>,
    pub(crate) reconnect: Duration,
    pub(crate) encoder: Encoder,
    pub(crate) encoder_threads: usize,
    pub(crate) ffmpeg: Option<PathBuf>,
    pub(crate) no_audio: bool,
    pub(crate) looped: bool,
    pub(crate) realtime: Option<bool>,
    pub(crate) player: PlayerOptions,
    pub(crate) storage: Option<Storage>,
    pub(crate) on_pin: Option<Arc<Mutex<PinFn>>>,
    pub(crate) on_event: Option<Arc<Mutex<EventFn>>>,
    pub(crate) approve_remote: Option<Arc<ApproveFn>>,
    pub(crate) share_tunnel: Option<TunnelProvider>,
    pub(crate) open_share_page: bool,
    pub(crate) page: Option<PageOptions>,
}

impl std::fmt::Debug for Options {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Options")
            .field("to", &self.to)
            .field("video", &self.video)
            .field("audio", &self.audio)
            .field("size", &self.size)
            .field("bitrate_kbps", &self.bitrate_kbps)
            .field("latency", &self.latency)
            .field("player", &self.player)
            .field("storage", &self.storage)
            .finish_non_exhaustive()
    }
}

impl Default for Options {
    fn default() -> Options {
        Options::new()
    }
}

impl Options {
    /// No receivers yet, defaults everywhere.
    pub fn new() -> Options {
        Options {
            to: Vec::new(),
            video: None,
            audio: None,
            size: None,
            fps: None,
            bitrate_kbps: None,
            latency: None,
            reconnect: DEFAULT_RECONNECT,
            encoder: Encoder::Auto,
            encoder_threads: 0,
            ffmpeg: None,
            no_audio: false,
            looped: false,
            realtime: None,
            player: PlayerOptions::new(),
            storage: None,
            on_pin: None,
            on_event: None,
            approve_remote: None,
            share_tunnel: None,
            open_share_page: false,
            page: None,
        }
    }

    /// A receiver (repeatable): a name from [`discover`](crate::discover)
    /// (`"Living Room"`), forced to a protocol (`"airplay:Living Room"`,
    /// `"cast:Office"`), an address (`"192.168.1.20"`, `"cast:10.0.0.5"`),
    /// or `"browser"` for a browser tab ([`PlayerOptions`]).
    pub fn to(mut self, target: impl Into<String>) -> Self {
        self.to.push(target.into());
        self
    }

    /// A receiver from [`discover`](crate::discover): Cast when it plays
    /// video over Cast, else AirPlay.
    pub fn to_device(self, device: &DeviceInfo) -> Self {
        let proto = if device.cast.as_ref().is_some_and(|c| c.video) {
            "cast"
        } else if device.airplay.is_some() || device.raop.is_some() {
            "airplay"
        } else {
            "cast"
        };
        self.to(format!("{proto}:{}", device.name))
    }

    /// Raw frames of this size, rate and layout go to the built-in H.264
    /// encoder ([`Stream::write_video`](crate::Stream::write_video)).
    pub fn video(mut self, width: u32, height: u32, fps: u32, format: PixelFormat) -> Self {
        self.video = Some(VideoSpec {
            width,
            height,
            fps,
            format: Some(format),
        });
        self
    }

    /// The program's own H.264 of this size and rate
    /// ([`Stream::write_h264`](crate::Stream::write_h264)).
    pub fn h264(mut self, width: u32, height: u32, fps: u32) -> Self {
        self.video = Some(VideoSpec {
            width,
            height,
            fps,
            format: None,
        });
        self
    }

    /// Interleaved PCM at this rate and channel count
    /// ([`Stream::write_audio`](crate::Stream::write_audio)).
    pub fn audio(mut self, sample_rate: u32, channels: u8) -> Self {
        self.audio = Some((sample_rate, channels));
        self
    }

    /// Caps the output size (default: the input's, at most 1920x1080).
    pub fn size(mut self, width: u32, height: u32) -> Self {
        self.size = Some((width, height));
        self
    }

    /// The output frame rate (default: the input's, at most 60).
    pub fn fps(mut self, fps: u32) -> Self {
        self.fps = Some(fps);
        self
    }

    /// The video bitrate (default: from the size and rate).
    pub fn bitrate_kbps(mut self, kbps: u32) -> Self {
        self.bitrate_kbps = Some(kbps);
        self
    }

    /// The playout delay every receiver presents frames with (5–2000 ms;
    /// default: 300 ms with Cast, AirPlay's automatic leads, 100 ms for
    /// browser tabs).
    pub fn latency(mut self, latency: Duration) -> Self {
        self.latency = Some(latency);
        self
    }

    /// How long a receiver whose connection was lost is reconnected
    /// (default 120 s; zero: never).
    pub fn reconnect(mut self, window: Duration) -> Self {
        self.reconnect = window;
        self
    }

    /// Threads of the built-in encoder (0, the default: one per core, up
    /// to its slice limit).
    pub fn encoder_threads(mut self, threads: usize) -> Self {
        self.encoder_threads = threads;
        self
    }

    /// Which encoder makes the video for [`play`](crate::play) (default:
    /// the best ffmpeg has).
    pub fn encoder(mut self, encoder: Encoder) -> Self {
        self.encoder = encoder;
        self
    }

    /// The ffmpeg to use (default: `PATH`, or next to the program).
    pub fn ffmpeg_path(mut self, path: impl Into<PathBuf>) -> Self {
        self.ffmpeg = Some(path.into());
        self
    }

    /// Video only.
    pub fn no_audio(mut self) -> Self {
        self.no_audio = true;
        self
    }

    /// Starts a file over at its end.
    pub fn looped(mut self, looped: bool) -> Self {
        self.looped = looped;
        self
    }

    /// Paces a file at its timestamps (default for files) or reads it as
    /// fast as it comes (default for live inputs).
    pub fn realtime(mut self, realtime: bool) -> Self {
        self.realtime = Some(realtime);
        self
    }

    /// The `browser` receiver's settings.
    pub fn player(mut self, player: PlayerOptions) -> Self {
        self.player = player;
        self
    }

    /// Where pairings and the player token are kept (default:
    /// [`Storage::default_app`]).
    pub fn storage(mut self, storage: Storage) -> Self {
        self.storage = Some(storage);
        self
    }

    /// Pairs an AirPlay receiver that needs it during
    /// [`stream`](crate::stream)/[`play`](crate::play): `f` gets the
    /// request and returns the PIN the TV shows (`None`: give up).
    pub fn on_pin(mut self, f: impl FnMut(&PinRequest) -> Option<String> + Send + 'static) -> Self {
        self.on_pin = Some(Arc::new(Mutex::new(f)));
        self
    }

    /// Calls `f` for every event, on a thread of the session's own (so a
    /// slow callback never stalls the media threads).
    pub fn on_event(mut self, f: impl FnMut(&Event) + Send + 'static) -> Self {
        self.on_event = Some(Arc::new(Mutex::new(f)));
        self
    }

    /// `share` with a public link: decides whether a capture from over
    /// the tunnel may reach the receivers, given its description; the
    /// second argument says the question is moot. Without it, remote
    /// shares are refused.
    pub fn approve_remote(
        mut self,
        f: impl Fn(&str, &dyn Fn() -> bool) -> bool + Send + Sync + 'static,
    ) -> Self {
        self.approve_remote = Some(Arc::new(f));
        self
    }

    /// `share` without a URL: also serves the share page on a public link
    /// (`tunnel`), so someone elsewhere can share to the receivers.
    pub fn share_tunnel(mut self, provider: TunnelProvider) -> Self {
        self.share_tunnel = Some(provider);
        self
    }

    /// `share` without a URL: opens the share page with the OS's opener.
    pub fn open_share_page(mut self, open: bool) -> Self {
        self.open_share_page = open;
        self
    }

    /// `share URL` (`headless`): show tvpipe's browser window instead of
    /// running it headless.
    pub fn visible_browser(mut self, visible: bool) -> Self {
        self.page.get_or_insert_with(PageOptions::default).visible = visible;
        self
    }

    /// `share URL`: render the page at this resolution. The page keeps
    /// its CSS layout ([`size`](Options::size), default the receivers'
    /// screen shape within 1920x1080) and tvpipe's browser raises its
    /// device scale factor so the picture fills the resolution's box
    /// (within the receivers' limits; [`Resolution::Auto`]: at most
    /// 1080p). Without it, `size` is the stream's size and the page's,
    /// at scale 1.
    pub fn resolution(mut self, resolution: Resolution) -> Self {
        self.page
            .get_or_insert_with(PageOptions::default)
            .resolution = Some(resolution);
        self
    }

    /// `share URL`: the browser to start (default: the installed one).
    pub fn browser_path(mut self, path: impl Into<PathBuf>) -> Self {
        self.page.get_or_insert_with(PageOptions::default).browser = Some(path.into());
        self
    }

    // -----------------------------------------------------------------
    // To the internal options

    pub(crate) fn ctx(&self) -> Ctx {
        let mut ctx = Ctx::new();
        ctx.storage = self.storage.clone().unwrap_or_default();
        ctx
    }

    pub(crate) fn play_options(&self, input: InputSpec) -> PlayOptions {
        let (raw_video, raw_audio) = match input {
            InputSpec::Stdin => (
                self.video.map(|v| RawVideoSpec {
                    size: Size {
                        width: v.width,
                        height: v.height,
                    },
                    fps: Ratio::integer(v.fps.max(1)),
                    pix_fmt: v
                        .format
                        .map_or(crate::media::slrw::ENCODED_PIX_FMT, PixelFormat::as_str)
                        .to_owned(),
                }),
                self.audio.map(|(rate, ch)| RawAudioSpec {
                    sample_rate: rate,
                    channels: ch,
                    sample_fmt: "s16le".into(),
                }),
            ),
            _ => (None, None),
        };
        PlayOptions {
            to: self.to.clone(),
            reconnect: self.reconnect,
            browser: self.player.browser(),
            latency_ms: self
                .latency
                .map(|l| l.as_millis().min(u32::MAX as u128) as u32),
            size: self.size.map(|(width, height)| Size { width, height }),
            fps: self.fps.map(Ratio::integer),
            bitrate_kbps: self.bitrate_kbps,
            encoder: self.encoder,
            no_audio: self.no_audio || (input == InputSpec::Stdin && self.audio.is_none()),
            looped: self.looped,
            realtime: self.realtime,
            raw_video,
            raw_audio,
            ffmpeg: self.ffmpeg.clone(),
            input,
            threads: self.encoder_threads,
            playback: None,
        }
    }

    pub(crate) fn share_options(&self, url: Option<&str>) -> ShareOptions {
        let page = url.map(|u| PageOptions {
            url: u.to_owned(),
            // `Session::navigate`.
            control: Some(crate::opts::PageControl::default()),
            ..self.page.clone().unwrap_or_default()
        });
        ShareOptions {
            to: self.to.clone(),
            reconnect: self.reconnect,
            latency_ms: self
                .latency
                .map(|l| l.as_millis().min(u32::MAX as u128) as u32),
            size: self.size.map(|(width, height)| Size { width, height }),
            fps: self.fps.map(Ratio::integer),
            bitrate_kbps: self.bitrate_kbps,
            no_audio: self.no_audio,
            open: self.open_share_page || self.player.open,
            player: self.player.browser(),
            tunnel: self.share_tunnel,
            tunnel_ttl: self.share_tunnel.map(|_| crate::opts::SHARE_TUNNEL_TTL),
            yes: false,
            page,
        }
    }
}
