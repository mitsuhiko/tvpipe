//! What a command does, as parsed from the command line (`cli`) or built
//! by the API: inputs, receivers, sizes, the per-command options.

use std::ffi::OsString;
use std::path::PathBuf;
use std::str::FromStr;
use std::time::Duration;

use crate::net::tunnel::Provider;
use crate::types::Encoder;
use crate::util::ratio::Ratio;

/// How long a receiver that dropped out is reconnected by default.
pub const DEFAULT_RECONNECT: Duration = Duration::from_secs(120);

/// The share page's public link lets people in for this long by default.
pub const SHARE_TUNNEL_TTL: Duration = Duration::from_secs(60 * 60);

/// Where the media comes from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InputSpec {
    /// A file path or URL given to ffmpeg's `-i`.
    Path(OsString),
    /// SLRW raw frames on stdin (`-`).
    Stdin,
    /// Raw ffmpeg input args after `--`.
    FfmpegArgs(Vec<OsString>),
    /// Generated test pattern.
    TestPattern,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Size {
    pub width: u32,
    pub height: u32,
}

impl FromStr for Size {
    type Err = &'static str;

    fn from_str(s: &str) -> Result<Size, Self::Err> {
        let (w, h) = s.split_once(['x', 'X']).ok_or("expected WxH")?;
        let width = w.parse().map_err(|_| "invalid width")?;
        let height = h.parse().map_err(|_| "invalid height")?;
        if width == 0 || height == 0 || width % 2 != 0 || height % 2 != 0 {
            return Err("width and height must be positive and even");
        }
        Ok(Size { width, height })
    }
}

/// `--raw-video WxH@FPS:PIXFMT`, e.g. `1920x1080@60:rgba`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RawVideoSpec {
    pub size: Size,
    pub fps: Ratio,
    pub pix_fmt: String,
}

impl FromStr for RawVideoSpec {
    type Err = &'static str;

    fn from_str(s: &str) -> Result<RawVideoSpec, Self::Err> {
        let (size, rest) = s.split_once('@').ok_or("expected WxH@FPS:PIXFMT")?;
        let (fps, pix_fmt) = rest.split_once(':').ok_or("expected WxH@FPS:PIXFMT")?;
        if pix_fmt.is_empty()
            || !pix_fmt
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_')
        {
            return Err("invalid pixel format");
        }
        Ok(RawVideoSpec {
            size: size.parse()?,
            fps: fps.parse()?,
            pix_fmt: pix_fmt.to_owned(),
        })
    }
}

/// `--raw-audio RATE:CH:FMT`, e.g. `48000:2:s16le`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RawAudioSpec {
    pub sample_rate: u32,
    pub channels: u8,
    pub sample_fmt: String,
}

impl RawAudioSpec {
    /// Stereo s16le PCM at a rate every receiver takes: 44.1 kHz when an
    /// AirPlay receiver listens, else 48 kHz (the test pattern's beep, a
    /// share's sound).
    pub fn session_pcm(airplay: bool) -> RawAudioSpec {
        RawAudioSpec {
            sample_rate: if airplay { 44_100 } else { 48_000 },
            channels: 2,
            sample_fmt: "s16le".into(),
        }
    }
}

impl FromStr for RawAudioSpec {
    type Err = &'static str;

    fn from_str(s: &str) -> Result<RawAudioSpec, Self::Err> {
        let mut parts = s.split(':');
        let (Some(rate), Some(ch), Some(fmt), None) =
            (parts.next(), parts.next(), parts.next(), parts.next())
        else {
            return Err("expected RATE:CH:FMT");
        };
        let sample_rate = rate.parse().map_err(|_| "invalid sample rate")?;
        let channels = ch.parse().map_err(|_| "invalid channel count")?;
        if sample_rate == 0 || channels == 0 {
            return Err("sample rate and channels must be positive");
        }
        if fmt.is_empty() || !fmt.bytes().all(|b| b.is_ascii_alphanumeric()) {
            return Err("invalid sample format");
        }
        Ok(RawAudioSpec {
            sample_rate,
            channels,
            sample_fmt: fmt.to_owned(),
        })
    }
}

#[derive(Debug, Clone)]
pub struct PlayOptions {
    pub to: Vec<String>,
    /// `--reconnect`: how long a lost receiver is reconnected (zero: off).
    pub reconnect: Duration,
    /// For `--to browser` receivers.
    pub browser: BrowserOptions,
    pub latency_ms: Option<u32>,
    pub size: Option<Size>,
    pub fps: Option<Ratio>,
    pub bitrate_kbps: Option<u32>,
    pub encoder: Encoder,
    pub no_audio: bool,
    pub looped: bool,
    /// `None` means: decide from the input (files yes, live no).
    pub realtime: Option<bool>,
    pub raw_video: Option<RawVideoSpec>,
    pub raw_audio: Option<RawAudioSpec>,
    pub ffmpeg: Option<PathBuf>,
    pub input: InputSpec,
    /// Threads of the built-in encoder (0: automatic).
    pub threads: usize,
}

/// The `--to` that names the browser receiver (`--to browser`).
pub const BROWSER_TARGET: &str = "browser";

/// Options of `--to browser` receivers.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct BrowserOptions {
    /// Port of the player page (`None`: the fixed default, 0: any free one).
    pub port: Option<u16>,
    pub open: bool,
    pub wait_for_viewer: bool,
    /// Rotate the page's persistent token.
    pub new_token: bool,
    /// Also serve the page on a public URL (`--tunnel[=PROVIDER]`).
    pub tunnel: Option<Provider>,
    /// `--tunnel-ttl` (`None`: no expiry).
    pub tunnel_ttl: Option<Duration>,
}

/// `tvpipe share [URL]`.
#[derive(Debug, Clone, Default)]
pub struct ShareOptions {
    pub to: Vec<String>,
    /// `--reconnect` (zero, the `Default`: off).
    pub reconnect: Duration,
    pub latency_ms: Option<u32>,
    pub size: Option<Size>,
    pub fps: Option<Ratio>,
    pub bitrate_kbps: Option<u32>,
    pub no_audio: bool,
    /// Open the share page (without URL) and the player page.
    pub open: bool,
    /// For `--to browser` receivers (`open` is the field above).
    pub player: BrowserOptions,
    /// Also serve the share page on a public URL (`--tunnel[=PROVIDER]`;
    /// not with URL).
    pub tunnel: Option<Provider>,
    /// How long the public link lets people in (`--tunnel-ttl`, default
    /// [`SHARE_TUNNEL_TTL`]; `None`: no expiry).
    pub tunnel_ttl: Option<Duration>,
    /// `--yes`: show a remote share without asking.
    pub yes: bool,
    /// With URL: tvpipe's own browser shows it.
    pub page: Option<PageOptions>,
}

/// `tvpipe screen`.
#[derive(Debug, Clone, Default)]
pub struct ScreenOptions {
    /// The streaming options (`page` is `None`; `open` is the player's).
    pub share: ShareOptions,
    pub target: ScreenTarget,
    /// `None`: the browser when one is installed, else ffmpeg.
    pub engine: Option<ScreenEngine>,
    pub browser: Option<PathBuf>,
    pub ffmpeg: Option<PathBuf>,
    /// `--encoder`: ffmpeg's video encoder (the ffmpeg engine).
    pub encoder: Encoder,
}

/// What `tvpipe screen` shares.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ScreenTarget {
    /// `--display N` (1 is the main screen, the default).
    Display(u32),
    /// `--display NAME`: a part of the screen's name in the picker.
    DisplayNamed(String),
    /// `--window TITLE`: a part of the window's title.
    Window(String),
    /// `--pick`: the user chooses in the browser's picker.
    Pick,
}

impl Default for ScreenTarget {
    fn default() -> Self {
        ScreenTarget::Display(1)
    }
}

/// How `tvpipe screen` captures.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScreenEngine {
    Browser,
    Ffmpeg,
}

/// Asks a running `share URL` to show another page in the same tab
/// (`Session::navigate`): the receivers keep their sessions, the tab
/// shares again after the navigation. The latest request wins.
#[derive(Clone, Default)]
pub struct PageControl(std::sync::Arc<std::sync::Mutex<Option<String>>>);

impl PageControl {
    /// Asks for `url` (checked by the caller).
    pub fn navigate(&self, url: String) {
        *self.0.lock().unwrap_or_else(|e| e.into_inner()) = Some(url);
    }

    /// The page asked for since the last call, if any.
    pub fn take(&self) -> Option<String> {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).take()
    }
}

impl std::fmt::Debug for PageControl {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("PageControl")
    }
}

impl PartialEq for PageControl {
    fn eq(&self, other: &PageControl) -> bool {
        std::sync::Arc::ptr_eq(&self.0, &other.0)
    }
}

/// `share URL`: the page and tvpipe's browser.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct PageOptions {
    pub url: String,
    pub profile: Option<PathBuf>,
    pub visible: bool,
    pub reload: Option<Duration>,
    pub browser: Option<PathBuf>,
    /// `--resolution`: the page keeps its CSS layout (`--size`, default
    /// the receivers' shape within 1920x1080) and is rendered at a device
    /// scale factor that fills this box, within the receivers' limits
    /// (docs/playshare-design.md §9.1). `None`: the page is exactly the
    /// stream (`--size`, else the receivers' shape) at scale 1, its
    /// layout following the receivers' limits (the SDK's default, a
    /// game's `tv.resolution: "fixed"`).
    pub resolution: Option<crate::types::Resolution>,
    /// Another page for the same tab while it runs (`Session::navigate`).
    pub control: Option<PageControl>,
}

#[derive(Debug, Clone)]
pub struct PipelineOptions {
    pub raw: bool,
    pub raw_video: Option<RawVideoSpec>,
    pub raw_audio: Option<RawAudioSpec>,
    pub ffmpeg: Option<PathBuf>,
    pub input: InputSpec,
}

#[derive(Debug, Clone)]
pub enum Command {
    Discover {
        timeout: Duration,
        json: bool,
        interfaces: Vec<std::net::Ipv4Addr>,
    },
    Pair {
        target: String,
        pin: Option<String>,
    },
    Unpair {
        target: String,
    },
    Play(PlayOptions),
    TestPattern(PlayOptions),
    Share(ShareOptions),
    Screen(ScreenOptions),
    DebugPipeline(PipelineOptions),
    /// `debug tunnel PORT`: a public link for any server on 127.0.0.1:PORT.
    Tunnel {
        port: u16,
        provider: Provider,
    },
    /// `debug qr TEXT`: a QR code on stdout.
    Qr {
        text: String,
        format: QrFormat,
    },
    /// `game play PATH`: a web game (docs/playshare-design.md).
    #[cfg(feature = "playshare")]
    Playshare(crate::playshare::Options),
    /// `game pack`, `game check`, `game new`: make games (docs/games.md).
    #[cfg(feature = "playshare")]
    GameTool(crate::playshare::tool::ToolOptions),
}

/// How `debug qr` prints the code.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QrFormat {
    /// Half blocks for a terminal.
    Terminal,
    /// An SVG document.
    Svg,
    /// One line of `0`/`1` per module row (for programs).
    Rows,
}

impl Command {
    /// The command's name in the machine interface's `hello` (`preview`
    /// is `play`; the `debug` commands keep the names they had as
    /// top-level commands: `test-pattern`, `debug-pipeline`, `tunnel`, `qr`).
    pub fn name(&self) -> &'static str {
        match self {
            Command::Discover { .. } => "discover",
            Command::Pair { .. } => "pair",
            Command::Unpair { .. } => "unpair",
            Command::Play(_) => "play",
            Command::TestPattern(_) => "test-pattern",
            Command::Share(_) => "share",
            Command::Screen(_) => "screen",
            Command::DebugPipeline(_) => "debug-pipeline",
            Command::Tunnel { .. } => "tunnel",
            Command::Qr { .. } => "qr",
            #[cfg(feature = "playshare")]
            Command::Playshare(_) => "game play",
            #[cfg(feature = "playshare")]
            Command::GameTool(o) => o.action.command(),
        }
    }
}
