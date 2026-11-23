//! Command line specs and parse functions.

use std::ffi::OsString;
use std::time::Duration;

use argument::{Cli, Cmd, Error, Opt, Parser, Pos, ValueHint};

pub use tvpipe::__cli::opts::*;

#[derive(Copy, Clone)]
enum Top {
    Verbose,
    Debug,
    Machine,
    Discover,
    Pair,
    Unpair,
    Play,
    Preview,
    Share,
    Screen,
    Game,
    DebugGroup,
}

/// `tvpipe debug …`: tools for testing.
#[derive(Copy, Clone)]
enum DebugCmd {
    Pattern,
    Pipeline,
    Tunnel,
    Qr,
}

/// `tvpipe game …`: party games (docs/games.md).
#[derive(Copy, Clone)]
enum GameCmd {
    Play,
    Fetch,
    List,
    Pack,
    Check,
    New,
}

/// The options of `game pack`, `game check`, `game new`, `game fetch` and
/// `game list` (each spec declares the ones it takes).
#[derive(Copy, Clone)]
enum GameToolArg {
    Path,
    Out,
    Smoke,
    Strict,
    Browser,
    Refresh,
    Offline,
}

#[derive(Copy, Clone)]
enum PlayshareArg {
    Path,
    Yes,
    Refresh,
    Offline,
    Tunnel,
    NoTunnel,
    NoShortLink,
    Lan,
    Window,
    Browser,
    Port,
    Resolution,
    Bitrate,
    Dev,
}

#[derive(Copy, Clone)]
enum TunnelArg {
    Tunnel,
    NoQr,
    Port,
}

#[derive(Copy, Clone)]
enum QrArg {
    Svg,
    Rows,
    Text,
}

#[derive(Copy, Clone)]
enum DiscoverArg {
    Timeout,
    Json,
    Interface,
}

#[derive(Copy, Clone)]
enum PairArg {
    Target,
    Pin,
}

#[derive(Copy, Clone)]
enum UnpairArg {
    Target,
}

#[derive(Copy, Clone)]
enum PlayArg {
    To,
    Reconnect,
    Latency,
    Size,
    Fps,
    Bitrate,
    Encoder,
    NoAudio,
    Loop,
    Realtime,
    NoRealtime,
    RawVideo,
    RawAudio,
    Ffmpeg,
    Port,
    Open,
    WaitForViewer,
    NewToken,
    Tunnel,
    TunnelTtl,
    NoQr,
    Input,
}

#[derive(Copy, Clone)]
enum ShareArg {
    To,
    Reconnect,
    Latency,
    Size,
    Fps,
    Bitrate,
    NoAudio,
    Port,
    Open,
    WaitForViewer,
    NewToken,
    Tunnel,
    TunnelTtl,
    NoQr,
    Yes,
    Profile,
    Visible,
    Reload,
    Browser,
    Resolution,
    Url,
}

#[derive(Copy, Clone)]
enum ScreenArg {
    To,
    Reconnect,
    Latency,
    Size,
    Fps,
    Bitrate,
    NoAudio,
    Display,
    Window,
    Pick,
    Engine,
    Browser,
    Ffmpeg,
    Port,
    Open,
    WaitForViewer,
    NewToken,
    Tunnel,
    TunnelTtl,
    NoQr,
}

#[derive(Copy, Clone)]
enum PipelineArg {
    Raw,
    RawVideo,
    RawAudio,
    Ffmpeg,
    Input,
}

static CLI: Cli<Top> = Cli::new("tvpipe")
    .version(env!("CARGO_PKG_VERSION"))
    .about("Low-latency mirroring of video and audio to AirPlay and Google Cast receivers.")
    .opts(&[
        Opt::new(Top::Verbose)
            .short('v')
            .long("verbose")
            .help("Print debug output"),
        Opt::new(Top::Debug)
            .long("debug")
            .help("Print protocol traces (very verbose)"),
        Opt::new(Top::Machine)
            .long("machine")
            .help("JSON events on stdout, commands on stdin (docs/machine.md)"),
    ])
    .commands(&[
        Cmd::new(Top::Discover, &DISCOVER),
        Cmd::new(Top::Pair, &PAIR),
        Cmd::new(Top::Unpair, &UNPAIR),
        Cmd::new(Top::Play, &PLAY),
        Cmd::new(Top::Preview, &PREVIEW),
        Cmd::new(Top::Share, &SHARE),
        Cmd::new(Top::Screen, &SCREEN),
        Cmd::new(Top::Game, &GAME),
        Cmd::new(Top::DebugGroup, &DEBUG),
    ]);

static DEBUG: Cli<DebugCmd> = Cli::new("debug")
    .about("Tools for testing: a test pattern, the pipeline, a tunnel, QR codes")
    .usage("COMMAND [OPTIONS]")
    .commands(&[
        Cmd::new(DebugCmd::Pattern, &PATTERN),
        Cmd::new(DebugCmd::Pipeline, &PIPELINE),
        Cmd::new(DebugCmd::Tunnel, &TUNNEL),
        Cmd::new(DebugCmd::Qr, &QR),
    ]);

static GAME: Cli<GameCmd> = Cli::new("game")
    .about("Play and make party games: TV, host window, phones")
    .usage("COMMAND [OPTIONS]")
    .commands(&[
        Cmd::new(GameCmd::Play, &GAME_PLAY),
        Cmd::new(GameCmd::Fetch, &GAME_FETCH),
        Cmd::new(GameCmd::List, &GAME_LIST),
        Cmd::new(GameCmd::Pack, &GAME_PACK),
        Cmd::new(GameCmd::Check, &GAME_CHECK),
        Cmd::new(GameCmd::New, &GAME_NEW),
    ])
    .after_help(
        "A game is a web app: a folder or a .zip with tvpipe.json, here or from the\n\
         internet (https://…, gh:OWNER/REPO or a name from the games list). docs/games.md",
    );

/// The top-level commands that moved into a group, and where to.
const MOVED: &[(&str, &str)] = &[
    ("test-pattern", "tvpipe debug pattern"),
    ("debug-pipeline", "tvpipe debug pipeline"),
    ("tunnel", "tvpipe debug tunnel PORT"),
    ("qr", "tvpipe debug qr TEXT"),
    ("playshare", "tvpipe game play GAME"),
    (
        "bundle",
        "tvpipe game pack DIR, game check PATH or game new DIR",
    ),
];

static DISCOVER: Cli<DiscoverArg> = Cli::new("discover")
    .about("List AirPlay and Cast receivers on the network")
    .opts(&[
        Opt::new(DiscoverArg::Timeout)
            .long("timeout")
            .value("SECS")
            .default_value("3")
            .help("How long to browse"),
        Opt::new(DiscoverArg::Json)
            .long("json")
            .help("Print machine-readable JSON"),
        interface(DiscoverArg::Interface),
    ]);

static PAIR: Cli<PairArg> = Cli::new("pair")
    .about("Pair with an AirPlay receiver (its PIN or AirPlay password)")
    .opts(&[Opt::new(PairArg::Pin)
        .long("pin")
        .value("PIN")
        .help("The PIN shown on the TV, or its AirPlay password; asked interactively if omitted")])
    .args(&[Pos::new(PairArg::Target, "NAME|ADDR").help("Receiver name or address")]);

static UNPAIR: Cli<UnpairArg> = Cli::new("unpair")
    .about("Forget the pairing with a receiver")
    .args(&[Pos::new(UnpairArg::Target, "NAME|ADDR").help("Receiver name or address")]);

static TUNNEL: Cli<TunnelArg> = Cli::new("tunnel")
    .about("Put a server on 127.0.0.1:PORT on a public https link")
    .usage("PORT [--tunnel=PROVIDER] [--no-qr]")
    .opts(&[
        tunnel(
            TunnelArg::Tunnel,
            "Who carries the link: cloudflare (the default) or opentunnel",
        ),
        Opt::new(TunnelArg::NoQr)
            .long("no-qr")
            .help("Do not draw the link as a QR code (also TVPIPE_NO_QR=1)"),
    ])
    .args(&[Pos::new(TunnelArg::Port, "PORT").help("The port of a server on 127.0.0.1")])
    .after_help(
        "The tunnel only carries requests: the server decides who may do what. Requests \
         arrive with the public name as Host (check it, and Origin for WebSockets). The link \
         works until tvpipe stops (Ctrl-C, q, or with --machine the stop command or stdin \
         closing). docs/tunnels.md",
    );

static GAME_PLAY: Cli<PlayshareArg> = Cli::new("play")
    .about("Play a game: the host window here, the TV page on TVs, phones join")
    .usage("[GAME] [--yes] [--refresh | --offline] [--tunnel[=PROVIDER] | --no-tunnel] [--lan[=IP]] [--window=MODE] [--dev]")
    .opts(&[
        Opt::new(PlayshareArg::Yes)
            .short('y')
            .long("yes")
            .help("Play a game from the internet without asking first"),
        Opt::new(PlayshareArg::Refresh)
            .long("refresh")
            .help("Ask the server again even for a release downloaded before"),
        Opt::new(PlayshareArg::Offline)
            .long("offline")
            .help("Only games downloaded before (and the games list from before)"),
        tunnel(
            PlayshareArg::Tunnel,
            "Who carries the phones' link: opentunnel or cloudflare (default: OpenTunnel, Cloudflare if it fails)",
        ),
        Opt::new(PlayshareArg::NoTunnel)
            .long("no-tunnel")
            .help("No public link: phones on the Wi-Fi (--lan) or this computer only"),
        Opt::new(PlayshareArg::NoShortLink)
            .long("no-short-link")
            .help("No short link and no frame page at tvpipe.party: the TV shows only the QR code, of the tunnel's own link; also TVPIPE_PARTY_URL=off"),
        Opt::new(PlayshareArg::Lan)
            .long("lan")
            .optional_value("IP")
            .help("Also serve phones on the Wi-Fi at http://IP:7420 (default: this computer's address)"),
        Opt::new(PlayshareArg::Window)
            .long("window")
            .value("MODE")
            .help("app (tvpipe's own browser window, the default), open (the system's browser) or none (print the link)"),
        Opt::new(PlayshareArg::Browser)
            .long("browser")
            .value("PATH")
            .value_hint(ValueHint::ExecutablePath)
            .help("The browser for the window and the TV page (default: $TVPIPE_BROWSER, then Chrome, Edge, Chromium, Brave, Firefox)"),
        Opt::new(PlayshareArg::Port)
            .long("port")
            .value("PORT")
            .help("The window's port on 127.0.0.1 (default: any)"),
        Opt::new(PlayshareArg::Resolution)
            .long("resolution")
            .value("RES")
            .help("The TV picture: auto, 720p, 1080p or 4k (default auto; the window can change it)"),
        Opt::new(PlayshareArg::Bitrate)
            .long("bitrate")
            .value("KBPS")
            .help("The TV picture's video bitrate in kbit/s (default: from its size and frame rate)"),
        Opt::new(PlayshareArg::Dev)
            .long("dev")
            .help("Test mode: the game's host page offers its test tools (bots: dummy players that join and play)"),
    ])
    .args(&[Pos::new(PlayshareArg::Path, "GAME")
        .optional()
        .multiple()
        .help(
            "A folder or .zip with tvpipe.json, an https:// URL of a zip, gh:OWNER/REPO[/ASSET][@TAG], \
             or a name from the games list (drawbluff); #sha256=HEX pins a download. \
             A folder of games, or several folders and zips: the window lists them first. \
             Without it the window opens on the games list",
        )])
    .after_help(
        "A game from the internet is downloaded (and kept: tvpipe game list), and the first time \
         tvpipe asks before running it. Closing the window (or Ctrl-C) ends the game: the TVs \
         stop, phones are told. docs/games.md",
    );

const fn game_refresh(id: GameToolArg) -> Opt<GameToolArg> {
    Opt::new(id)
        .long("refresh")
        .help("Ask the server again even for a release downloaded before")
}

const fn game_offline(id: GameToolArg) -> Opt<GameToolArg> {
    Opt::new(id)
        .long("offline")
        .help("Only games downloaded before")
}

static GAME_FETCH: Cli<GameToolArg> = Cli::new("fetch")
    .about("Download a game from the internet, check it, print its pinned source")
    .usage("GAME [-o FILE] [--refresh | --offline]")
    .opts(&[
        Opt::new(GameToolArg::Out)
            .short('o')
            .long("output")
            .value("FILE")
            .value_hint(ValueHint::FilePath)
            .help("Also write the zip here"),
        game_refresh(GameToolArg::Refresh),
        game_offline(GameToolArg::Offline),
    ])
    .args(&[Pos::new(GameToolArg::Path, "GAME").help(
        "An https:// URL of a zip, gh:OWNER/REPO[/ASSET][@TAG], or a name from the games list",
    )])
    .after_help(
        "Runs nothing and asks nothing: the game is kept in the cache, for playing offline \
         later. docs/games.md",
    );

static GAME_LIST: Cli<GameToolArg> = Cli::new("list")
    .about("List the games downloaded from the internet")
    .after_help("The games to play: https://tvpipe.party/games/");

const fn game_smoke(id: GameToolArg) -> Opt<GameToolArg> {
    Opt::new(id).long("smoke").help(
        "Also run the game once without TVs: its pages in a headless browser, a fake phone joins",
    )
}

const fn game_strict(id: GameToolArg) -> Opt<GameToolArg> {
    Opt::new(id)
        .long("strict")
        .help("Warnings fail too (for CI)")
}

const fn game_browser(id: GameToolArg) -> Opt<GameToolArg> {
    Opt::new(id)
        .long("browser")
        .value("PATH")
        .value_hint(ValueHint::ExecutablePath)
        .help("The Chromium-based browser for --smoke (default: $TVPIPE_BROWSER, then Chrome, Edge, Chromium, Brave)")
}

const GAME_CHECKS: &str =
    "Checks what tvpipe needs: tvpipe.json, the pages and every file they load \
     (HTML, CSS, JS imports), names that break in a zip or on other systems, the @tvpipe/party \
     library and version, files from the internet. Exits 1 on errors. docs/games.md";

static GAME_PACK: Cli<GameToolArg> = Cli::new("pack")
    .about("Check a game's folder and pack it into a zip")
    .usage("DIR [-o FILE] [--smoke] [--strict]")
    .opts(&[
        Opt::new(GameToolArg::Out)
            .short('o')
            .long("output")
            .value("FILE")
            .value_hint(ValueHint::FilePath)
            .help("The zip to write (default: NAME.zip here, NAME from tvpipe.json)"),
        game_smoke(GameToolArg::Smoke),
        game_strict(GameToolArg::Strict),
        game_browser(GameToolArg::Browser),
    ])
    .args(&[Pos::new(GameToolArg::Path, "DIR")
        .value_hint(ValueHint::DirPath)
        .help("The game's folder (with tvpipe.json)")])
    .after_help(
        "The zip is the same for the same files (sorted, fixed times); it is checked first: \
         nothing is written when the game has errors. 'tvpipe game check --help' says what is \
         checked.",
    );

static GAME_CHECK: Cli<GameToolArg> = Cli::new("check")
    .about("Check a game (a folder, a .zip or from the internet); write nothing")
    .usage("GAME [--smoke] [--strict] [--refresh | --offline]")
    .opts(&[
        game_smoke(GameToolArg::Smoke),
        game_strict(GameToolArg::Strict),
        game_browser(GameToolArg::Browser),
        game_refresh(GameToolArg::Refresh),
        game_offline(GameToolArg::Offline),
    ])
    .args(&[Pos::new(GameToolArg::Path, "GAME")
        .value_hint(ValueHint::FilePath)
        .help(
            "The game: a folder with tvpipe.json, a .zip, an https:// URL, gh:OWNER/REPO or a name",
        )])
    .after_help(GAME_CHECKS);

static GAME_NEW: Cli<GameToolArg> = Cli::new("new")
    .about("Make a starter game in a new folder")
    .args(&[Pos::new(GameToolArg::Path, "DIR")
        .value_hint(ValueHint::DirPath)
        .help("The folder to make (new, or empty)")])
    .after_help("Then: tvpipe game play DIR, edit a file, reload the page. docs/games.md");

static QR: Cli<QrArg> = Cli::new("qr")
    .about("Print a QR code of a text or link")
    .usage("[--svg | --rows] TEXT")
    .opts(&[
        Opt::new(QrArg::Svg)
            .long("svg")
            .help("An SVG document instead of terminal art"),
        Opt::new(QrArg::Rows)
            .long("rows")
            .help("One line of 0 (light) and 1 (dark) per module row, for programs"),
    ])
    .args(&[Pos::new(QrArg::Text, "TEXT").help("What the code says (UTF-8, byte mode)")]);

const fn to<A>(id: A) -> Opt<A> {
    Opt::new(id)
        .long("to")
        .value("NAME|ADDR")
        .help("Receiver to stream to (repeat for several)")
}

const fn reconnect<A>(id: A) -> Opt<A> {
    Opt::new(id)
        .long("reconnect")
        .value("SECS")
        .default_value("120")
        .help("Reconnect a receiver that drops out for this long (by name: found again, e.g. at a new address; 0: off)")
}

/// `--reconnect SECS`.
fn reconnect_secs<A: Copy + 'static>(p: &mut Parser<A>) -> Result<Duration, Error> {
    let secs: f64 = p.value()?;
    if !(secs.is_finite() && (0.0..=86_400.0).contains(&secs)) {
        return Err(p.error("--reconnect takes seconds (0 to 86400)"));
    }
    Ok(Duration::from_secs_f64(secs))
}

// The `--to browser` player page's options, the same in every subcommand
// that streams (`play`, `debug pattern`, `preview`, `share`).

const fn player_port<A>(id: A) -> Opt<A> {
    Opt::new(id)
        .long("port")
        .value("PORT")
        .help("Browser player page port on 127.0.0.1 (--to browser; default 8765, 0: any)")
}

const fn player_open<A>(id: A) -> Opt<A> {
    Opt::new(id)
        .long("open")
        .help("Open the browser player page in the default browser (--to browser)")
}

const fn wait_for_viewer<A>(id: A) -> Opt<A> {
    Opt::new(id)
        .long("wait-for-viewer")
        .help("Start streaming once a browser tab is watching (--to browser)")
}

const fn new_token<A>(id: A) -> Opt<A> {
    Opt::new(id)
        .long("new-token")
        .help("Change the browser player page's URL token (--to browser; old URLs stop working)")
}

/// `--no-qr`: no QR codes of the public links (`util::qr`).
const fn no_qr<A>(id: A) -> Opt<A> {
    Opt::new(id)
        .long("no-qr")
        .help("With --tunnel: do not draw the public link as a QR code (also TVPIPE_NO_QR=1)")
}

/// `--tunnel[=PROVIDER]` (docs/tunnels.md).
const fn tunnel<A>(id: A, help: &'static str) -> Opt<A> {
    Opt::new(id)
        .long("tunnel")
        .optional_value("PROVIDER")
        .help(help)
}

/// The provider `--tunnel[=PROVIDER]` names (none: the default).
fn tunnel_value<A: Copy + 'static>(p: &mut Parser<A>) -> Result<Option<Provider>, Error> {
    match p.optional_value::<String>()? {
        None => Ok(Some(Provider::default())),
        Some(v) => match Provider::parse(&v) {
            Some(provider) => Ok(Some(provider)),
            None => Err(p.error("--tunnel=PROVIDER: cloudflare (the default) or opentunnel")),
        },
    }
}

const fn tunnel_ttl<A>(id: A, help: &'static str) -> Opt<A> {
    Opt::new(id).long("tunnel-ttl").value("MIN").help(help)
}

/// `--tunnel opentunnel` makes `opentunnel` the input: say how to write it.
fn tunnel_typo<A: Copy + 'static>(
    p: &Parser<A>,
    tunnel: Option<Provider>,
    arg: Option<&str>,
) -> Result<(), Error> {
    match arg.and_then(Provider::parse) {
        Some(provider) if tunnel.is_some() => Err(p.error(format!(
            "write --tunnel={} (the provider is attached with '=')",
            provider.name()
        ))),
        _ => Ok(()),
    }
}

/// `--tunnel-ttl MIN` (0: no expiry).
fn tunnel_ttl_value<A: Copy + 'static>(p: &mut Parser<A>) -> Result<Option<Duration>, Error> {
    let min: f64 = p.value()?;
    if !(min.is_finite() && (0.0..=7.0 * 24.0 * 60.0).contains(&min)) {
        return Err(p.error("--tunnel-ttl takes minutes (0 to 10080; 0: no expiry)"));
    }
    Ok((min > 0.0).then(|| Duration::from_secs_f64(min * 60.0)))
}

/// Whether `--to browser` is among the receivers.
fn has_browser_target(to: &[String]) -> bool {
    to.iter().any(|t| t.eq_ignore_ascii_case(BROWSER_TARGET))
}

const PLAYER_ONLY: &str =
    "--port, --open, --wait-for-viewer, --new-token and --tunnel are for --to browser";

const fn interface<A>(id: A) -> Opt<A> {
    Opt::new(id)
        .long("interface")
        .value("ADDR")
        .help("Also browse from this local address (repeatable)")
}

const fn ffmpeg_path<A>(id: A) -> Opt<A> {
    Opt::new(id)
        .long("ffmpeg")
        .value("PATH")
        .value_hint(ValueHint::ExecutablePath)
        .help("Path to the ffmpeg binary")
}

const fn raw_video<A>(id: A) -> Opt<A> {
    Opt::new(id)
        .long("raw-video")
        .value("WxH@FPS:PIXFMT")
        .help("Game mode: raw video in SLRW framing on stdin")
}

const fn raw_audio<A>(id: A) -> Opt<A> {
    Opt::new(id)
        .long("raw-audio")
        .value("RATE:CH:FMT")
        .help("Game mode: raw audio in SLRW framing on stdin")
}

/// `play`'s options after the given ones (`preview` has no `--to`).
macro_rules! play_opts {
    ($($first:expr),*) => {
        &[
            $($first,)*
            Opt::new(PlayArg::Latency)
                .long("latency")
                .value("MS")
                .help("Playout delay in ms, the same on every receiver (default: Cast 300, AirPlay automatic ~100-170 or 300 with sound on an LG TV, browser 100)"),
            Opt::new(PlayArg::Size)
                .long("size")
                .value("WxH")
                .help("Output video size"),
            Opt::new(PlayArg::Fps)
                .long("fps")
                .value("N")
                .help("Output frame rate"),
            Opt::new(PlayArg::Bitrate)
                .long("bitrate")
                .value("KBPS")
                .help("Video bitrate in kbit/s"),
            Opt::new(PlayArg::Encoder)
                .long("encoder")
                .value("ENCODER")
                .default_value("auto")
                .possible_values(&[
                    "auto",
                    "builtin",
                    "x264",
                    "videotoolbox",
                    "nvenc",
                    "qsv",
                    "vaapi",
                    "mf",
                ])
                .help("Video encoder"),
            Opt::new(PlayArg::NoAudio)
                .long("no-audio")
                .help("Do not send audio"),
            Opt::new(PlayArg::Loop).long("loop").help("Loop the input"),
            Opt::new(PlayArg::Realtime)
                .long("realtime")
                .help("Pace the input in real time (default for files)"),
            Opt::new(PlayArg::NoRealtime)
                .long("no-realtime")
                .help("Do not pace the input (live sources)"),
            raw_video(PlayArg::RawVideo),
            raw_audio(PlayArg::RawAudio),
            ffmpeg_path(PlayArg::Ffmpeg),
            player_port(PlayArg::Port),
            player_open(PlayArg::Open),
            wait_for_viewer(PlayArg::WaitForViewer),
            new_token(PlayArg::NewToken),
            tunnel(
                PlayArg::Tunnel,
                "Also put the browser player page on a public https URL: anyone with the link can watch (PROVIDER: cloudflare, the default, or opentunnel)",
            ),
            tunnel_ttl(
                PlayArg::TunnelTtl,
                "With --tunnel: let new viewers in for MIN minutes only (default: no limit)",
            ),
            no_qr(PlayArg::NoQr),
        ]
    };
}

static PLAY_OPTS: &[Opt<PlayArg>] = play_opts!(to(PlayArg::To), reconnect(PlayArg::Reconnect));

static PLAY: Cli<PlayArg> = Cli::new("play")
    .about("Mirror a file, URL, capture device or raw game input")
    .usage("--to NAME|ADDR [OPTIONS] (INPUT | - | -- FFMPEG_INPUT_ARGS...)")
    .opts(PLAY_OPTS)
    .args(&[Pos::new(PlayArg::Input, "INPUT")
        .optional()
        .allow_hyphen()
        .value_hint(ValueHint::FilePath)
        .help("File or URL; '-' for SLRW raw input on stdin")])
    .after_help(
        "Arguments after '--' are passed to ffmpeg as input arguments, e.g.\n  \
         tvpipe play --to TV -- -f avfoundation -i 1:0",
    );

static PATTERN: Cli<PlayArg> = Cli::new("pattern")
    .about("Stream a test pattern with a clock in it, to measure latency")
    .opts(PLAY_OPTS)
    .after_help(
        "The pattern (UTC clock in ms, frame counter, a beep and a flash every second) is \
         generated and encoded in-process; ffmpeg is not needed. Naming an ffmpeg encoder \
         (e.g. --encoder x264) streams ffmpeg's testsrc2 instead.",
    );

static PREVIEW: Cli<PlayArg> = Cli::new("preview")
    .about("Play a source in a browser tab")
    .usage("[OPTIONS] [INPUT | - | -- FFMPEG_INPUT_ARGS...]")
    .opts(play_opts!())
    .args(&[Pos::new(PlayArg::Input, "INPUT")
        .optional()
        .allow_hyphen()
        .value_hint(ValueHint::FilePath)
        .help("File or URL; '-' for SLRW raw input on stdin; none: the test pattern")])
    .after_help(
        "Serves a player page on 127.0.0.1 and prints its URL (--open opens it); the same\n\
         as 'play --to browser'. The tab also works as an OBS browser source, or shared\n\
         into a video call (docs/meet.md).",
    );

static SHARE: Cli<ShareArg> = Cli::new("share")
    .about("Mirror a browser tab, window, screen or web page")
    .usage("[URL] --to NAME|ADDR [OPTIONS]")
    .opts(&[
        to(ShareArg::To),
        reconnect(ShareArg::Reconnect),
        Opt::new(ShareArg::Latency)
            .long("latency")
            .value("MS")
            .help("Playout delay in ms, the same on every receiver"),
        Opt::new(ShareArg::Size)
            .long("size")
            .value("WxH")
            .help("Output video size (default: the capture's, at most 1920x1080); with URL the page's layout in CSS pixels (default: the receivers' screen shape within 1920x1080)"),
        Opt::new(ShareArg::Resolution)
            .long("resolution")
            .value("RES")
            .help("With URL: render the page at auto, 720p, 1080p or 4k (default auto: up to 1080p within the receivers' limits); the layout stays, a higher device scale factor fills the picture"),
        Opt::new(ShareArg::Fps)
            .long("fps")
            .value("N")
            .help("Output frame rate (default 30)"),
        Opt::new(ShareArg::Bitrate)
            .long("bitrate")
            .value("KBPS")
            .help("Video bitrate in kbit/s"),
        Opt::new(ShareArg::NoAudio)
            .long("no-audio")
            .help("Do not send sound"),
        Opt::new(ShareArg::Open)
            .long("open")
            .help("Open the share page (without URL) and the browser player page (--to browser) in the default browser"),
        player_port(ShareArg::Port),
        wait_for_viewer(ShareArg::WaitForViewer),
        new_token(ShareArg::NewToken),
        tunnel(
            ShareArg::Tunnel,
            "Also put the share page on a public https URL: someone with the link can ask to share their screen to the receivers, you confirm each (PROVIDER: cloudflare, the default, or opentunnel)",
        ),
        tunnel_ttl(
            ShareArg::TunnelTtl,
            "With --tunnel: the link lets people in for MIN minutes (default 60; 0: no limit)",
        ),
        no_qr(ShareArg::NoQr),
        Opt::new(ShareArg::Yes)
            .long("yes")
            .short('y')
            .help("With --tunnel: show a remote share without asking first"),
        Opt::new(ShareArg::Visible)
            .long("visible")
            .help("With URL: show the browser window instead of running headless (e.g. to log in)"),
        Opt::new(ShareArg::Profile)
            .long("profile")
            .value("DIR")
            .value_hint(ValueHint::DirPath)
            .help("With URL: keep the browser's profile (logins, cookies) in DIR (default: a temporary one)"),
        Opt::new(ShareArg::Reload)
            .long("reload")
            .value("MIN")
            .help("With URL: reload the page every MIN minutes"),
        Opt::new(ShareArg::Browser)
            .long("browser")
            .value("PATH")
            .value_hint(ValueHint::ExecutablePath)
            .help("With URL: the browser: a Chromium-based one or Firefox, a path or 'firefox' (default: $TVPIPE_BROWSER, then Chrome, Edge, Chromium, Brave, Firefox)"),
    ])
    .args(&[Pos::new(ShareArg::Url, "URL")
        .optional()
        .value_hint(ValueHint::Url)
        .help("A page to show instead of picking a tab: http(s)://..., file://... or a local file")])
    .after_help(
        "Without URL: open the printed http://127.0.0.1 page in a browser with WebCodecs\n\
         (Chrome, Edge, Safari 16.4+, Firefox 130+) and press Share. Closing the page or\n\
         stopping the share ends the session.\n\
         \n\
         With URL: tvpipe starts a Chromium-based browser (or Firefox) with a profile\n\
         of its own (never yours), lays the page out at --size, renders it at\n\
         --resolution, opens URL and shares that tab with its sound. It is started\n\
         again if it crashes; Ctrl-C or 'q' stops. Sites that refuse automated\n\
         browsers (e.g. Google Meet) do not work.",
    );

static SCREEN: Cli<ScreenArg> = Cli::new("screen")
    .about("Mirror a screen or a window, with the computer's sound")
    .usage("--to NAME|ADDR [--display N | --window TITLE | --pick] [OPTIONS]")
    .opts(&[
        to(ScreenArg::To),
        reconnect(ScreenArg::Reconnect),
        Opt::new(ScreenArg::Latency)
            .long("latency")
            .value("MS")
            .help("Playout delay in ms, the same on every receiver"),
        Opt::new(ScreenArg::Size)
            .long("size")
            .value("WxH")
            .help("Output video size (default: the screen's, within the receivers' limits)"),
        Opt::new(ScreenArg::Fps)
            .long("fps")
            .value("N")
            .help("Output frame rate (default 30)"),
        Opt::new(ScreenArg::Bitrate)
            .long("bitrate")
            .value("KBPS")
            .help("Video bitrate in kbit/s"),
        Opt::new(ScreenArg::NoAudio)
            .long("no-audio")
            .help("Do not send sound"),
        Opt::new(ScreenArg::Display)
            .long("display")
            .value("N|NAME")
            .help("The screen: 1 (the main one, the default), 2, ...; or a part of its name in the browser's picker"),
        Opt::new(ScreenArg::Window)
            .long("window")
            .value("TITLE")
            .help("Share the window whose title contains TITLE (case matters)"),
        Opt::new(ScreenArg::Pick)
            .long("pick")
            .help("Choose the screen or window in the browser's picker"),
        Opt::new(ScreenArg::Engine)
            .long("engine")
            .value("browser|ffmpeg")
            .help("Capture with a Chromium-based browser (default when one is installed) or with ffmpeg"),
        Opt::new(ScreenArg::Browser)
            .long("browser")
            .value("PATH")
            .value_hint(ValueHint::ExecutablePath)
            .help("The Chromium-based browser (default: $TVPIPE_BROWSER, then Chrome, Edge, Chromium, Brave)"),
        ffmpeg_path(ScreenArg::Ffmpeg),
        player_port(ScreenArg::Port),
        player_open(ScreenArg::Open),
        wait_for_viewer(ScreenArg::WaitForViewer),
        new_token(ScreenArg::NewToken),
        tunnel(
            ScreenArg::Tunnel,
            "Also put the browser player page on a public https URL: anyone with the link can watch (PROVIDER: cloudflare, the default, or opentunnel)",
        ),
        tunnel_ttl(
            ScreenArg::TunnelTtl,
            "With --tunnel: let new viewers in for MIN minutes only (default: no limit)",
        ),
        no_qr(ScreenArg::NoQr),
    ])
    .after_help(
        "tvpipe starts a Chromium-based browser of its own (a separate profile, a small\n\
         window it minimizes) whose page captures the screen or window with the computer's\n\
         sound and encodes it. The browser needs the system's permission to record the\n\
         screen (macOS: Privacy & Security > Screen & System Audio Recording). Stop with\n\
         Ctrl-C, 'q' or the browser's \"Stop sharing\". --engine ffmpeg captures with\n\
         ffmpeg instead: no sound on macOS and Windows, no --window on macOS.",
    );

static PIPELINE: Cli<PipelineArg> = Cli::new("pipeline")
    .about("Run ffmpeg and the demuxer and print every frame")
    .usage("[OPTIONS] [INPUT | - | -- FFMPEG_INPUT_ARGS...]")
    .opts(&[
        Opt::new(PipelineArg::Raw)
            .long("raw")
            .help("Copy the input's streams without encoding: the frames as they are in the file"),
        raw_video(PipelineArg::RawVideo),
        raw_audio(PipelineArg::RawAudio),
        ffmpeg_path(PipelineArg::Ffmpeg),
    ])
    .args(&[Pos::new(PipelineArg::Input, "INPUT")
        .optional()
        .allow_hyphen()
        .value_hint(ValueHint::FilePath)
        .help("File or URL; '-' for SLRW raw input on stdin; none: ffmpeg's test source")])
    .after_help(
        "Prints the ffmpeg command line, then one line per track and per frame (pts in the \
         track's clock and in ms, keyframe, size, arrival time) and a summary per track. Without \
         --raw the input is encoded the way 'play' would for an AirPlay and a Cast receiver.",
    );

#[derive(Debug, Clone, Default)]
pub struct Global {
    pub verbose: bool,
    pub debug: bool,
    /// `--machine`: the machine interface (`crate::machine`).
    pub machine: bool,
    /// `--no-qr` (a subcommand's option): no QR codes of public links.
    pub no_qr: bool,
}

/// Parses `std::env::args`; prints help/errors and exits on failure.
pub fn parse_env() -> (Global, Command) {
    CLI.run(parse_top)
}

#[cfg(test)]
fn parse_from(args: &[&str]) -> Result<(Global, Command), Error> {
    parse_top(CLI.parser_from_args(args.iter().copied()))
}

fn parse_top(mut p: Parser<Top>) -> Result<(Global, Command), Error> {
    let mut g = Global::default();
    loop {
        let old = p.peek_raw_arg().and_then(|a| a.to_str());
        if let Some((old, new)) = MOVED.iter().find(|(name, _)| Some(*name) == old) {
            return Err(p.error(format!("'{old}' moved: use {new}")));
        }
        let Some(arg) = p.param()? else { break };
        match arg {
            Top::Verbose => g.verbose = true,
            Top::Debug => g.debug = true,
            Top::Machine => g.machine = true,
            Top::Discover => return Ok((g, parse_discover(p.subcommand(&DISCOVER))?)),
            Top::Pair => return Ok((g, parse_pair(p.subcommand(&PAIR))?)),
            Top::Unpair => return Ok((g, parse_unpair(p.subcommand(&UNPAIR))?)),
            Top::Play => {
                let o = parse_play(p.subcommand(&PLAY), Mode::Play, &mut g)?;
                return Ok((g, Command::Play(o)));
            }
            Top::Preview => {
                let o = parse_play(p.subcommand(&PREVIEW), Mode::Preview, &mut g)?;
                return Ok((g, Command::Play(o)));
            }
            Top::Share => {
                let cmd = parse_share(p.subcommand(&SHARE), &mut g)?;
                return Ok((g, cmd));
            }
            Top::Screen => {
                let cmd = parse_screen(p.subcommand(&SCREEN), &mut g)?;
                return Ok((g, cmd));
            }
            Top::Game => return Ok((g, parse_game(p.subcommand(&GAME))?)),
            Top::DebugGroup => {
                let cmd = parse_debug(p.subcommand(&DEBUG), &mut g)?;
                return Ok((g, cmd));
            }
        }
    }
    Err(p.help())
}

fn parse_debug(mut p: Parser<DebugCmd>, g: &mut Global) -> Result<Command, Error> {
    match p.param()? {
        Some(DebugCmd::Pattern) => {
            let o = parse_play(p.subcommand(&PATTERN), Mode::TestPattern, g)?;
            Ok(Command::TestPattern(o))
        }
        Some(DebugCmd::Pipeline) => parse_pipeline(p.subcommand(&PIPELINE)),
        Some(DebugCmd::Tunnel) => parse_tunnel(p.subcommand(&TUNNEL), g),
        Some(DebugCmd::Qr) => parse_qr(p.subcommand(&QR)),
        None => Err(p.help()),
    }
}

fn parse_game(mut p: Parser<GameCmd>) -> Result<Command, Error> {
    use tvpipe::__cli::playshare::ToolAction;
    match p.param()? {
        Some(GameCmd::Play) => parse_playshare(p.subcommand(&GAME_PLAY)),
        Some(GameCmd::Fetch) => parse_game_tool(p.subcommand(&GAME_FETCH), ToolAction::Fetch),
        Some(GameCmd::List) => parse_game_tool(p.subcommand(&GAME_LIST), ToolAction::List),
        Some(GameCmd::Pack) => parse_game_tool(p.subcommand(&GAME_PACK), ToolAction::Pack),
        Some(GameCmd::Check) => parse_game_tool(p.subcommand(&GAME_CHECK), ToolAction::Check),
        Some(GameCmd::New) => parse_game_tool(p.subcommand(&GAME_NEW), ToolAction::New),
        None => Err(p.help()),
    }
}

fn parse_discover(mut p: Parser<DiscoverArg>) -> Result<Command, Error> {
    let mut timeout = 3.0f64;
    let mut json = false;
    let mut interfaces = Vec::new();
    while let Some(arg) = p.param()? {
        match arg {
            DiscoverArg::Timeout => timeout = p.value()?,
            DiscoverArg::Json => json = true,
            DiscoverArg::Interface => interfaces.push(p.value()?),
        }
    }
    if !(timeout.is_finite() && timeout > 0.0 && timeout <= 3600.0) {
        return Err(p.error("--timeout must be between 0 and 3600 seconds"));
    }
    Ok(Command::Discover {
        timeout: Duration::from_secs_f64(timeout),
        json,
        interfaces,
    })
}

fn parse_pair(mut p: Parser<PairArg>) -> Result<Command, Error> {
    let mut target = String::new();
    let mut pin = None;
    while let Some(arg) = p.param()? {
        match arg {
            PairArg::Target => target = p.value()?,
            PairArg::Pin => pin = Some(p.value()?),
        }
    }
    Ok(Command::Pair { target, pin })
}

fn parse_unpair(mut p: Parser<UnpairArg>) -> Result<Command, Error> {
    let mut target = String::new();
    while let Some(arg) = p.param()? {
        match arg {
            UnpairArg::Target => target = p.value()?,
        }
    }
    Ok(Command::Unpair { target })
}

fn parse_tunnel(mut p: Parser<TunnelArg>, g: &mut Global) -> Result<Command, Error> {
    let mut port = None;
    let mut provider = Provider::default();
    while let Some(arg) = p.param()? {
        match arg {
            TunnelArg::Tunnel => provider = tunnel_value(&mut p)?.unwrap_or_default(),
            TunnelArg::NoQr => g.no_qr = true,
            TunnelArg::Port => {
                let v: String = p.value()?;
                port = match v.parse::<u16>() {
                    Ok(n) if n > 0 => Some(n),
                    _ => return Err(p.error(format!("PORT: a port number, not {v:?}"))),
                };
            }
        }
    }
    let Some(port) = port else {
        return Err(p.error("debug tunnel needs the PORT of a server on 127.0.0.1"));
    };
    Ok(Command::Tunnel { port, provider })
}

fn parse_playshare(mut p: Parser<PlayshareArg>) -> Result<Command, Error> {
    use tvpipe::__cli::playshare::{Options, Resolution, TunnelChoice, WindowMode};
    let mut o = Options::default();
    let mut games = Vec::new();
    let (mut tunnel, mut no_tunnel) = (None, false);
    while let Some(arg) = p.param()? {
        match arg {
            PlayshareArg::Path => games.push(p.value::<String>()?),
            PlayshareArg::Yes => o.yes = true,
            PlayshareArg::Refresh => o.fetch.refresh = true,
            PlayshareArg::Offline => o.fetch.offline = true,
            PlayshareArg::Tunnel => {
                tunnel = Some(match p.optional_value::<String>()? {
                    None => TunnelChoice::Auto,
                    Some(v) if v == "auto" => TunnelChoice::Auto,
                    Some(v) => match Provider::parse(&v) {
                        Some(pr) => TunnelChoice::Provider(pr),
                        None => {
                            return Err(p.error("--tunnel=PROVIDER: opentunnel, cloudflare or auto"))
                        }
                    },
                })
            }
            PlayshareArg::NoTunnel => no_tunnel = true,
            PlayshareArg::NoShortLink => o.no_short_link = true,
            PlayshareArg::Dev => o.dev = true,
            PlayshareArg::Lan => {
                o.lan = Some(match p.optional_value::<String>()? {
                    None => None,
                    Some(v) => match v.parse() {
                        Ok(ip) => Some(ip),
                        Err(_) => return Err(p.error(format!("--lan=IP: an address, not {v:?}"))),
                    },
                })
            }
            PlayshareArg::Window => {
                let v: String = p.value()?;
                o.window = match WindowMode::parse(&v) {
                    Some(m) => m,
                    None => return Err(p.error("--window: app, open or none")),
                };
            }
            PlayshareArg::Browser => o.browser = Some(p.value::<String>()?.into()),
            PlayshareArg::Port => o.port = p.value()?,
            PlayshareArg::Resolution => {
                let v: String = p.value()?;
                o.resolution = match Resolution::parse(&v) {
                    Some(r) => r,
                    None => return Err(p.error("--resolution: auto, 720p, 1080p or 4k")),
                };
            }
            PlayshareArg::Bitrate => o.bitrate_kbps = Some(p.value()?),
        }
    }
    if no_tunnel && tunnel.is_some() {
        return Err(p.error("--tunnel and --no-tunnel together"));
    }
    o.tunnel = if no_tunnel {
        TunnelChoice::Off
    } else {
        tunnel.unwrap_or_default()
    };
    if o.fetch.refresh && o.fetch.offline {
        return Err(p.error("--refresh and --offline together"));
    }
    // No GAME: the window opens on the games list (docs/game-catalog.md);
    // several: local ones (docs/game-switching.md).
    o.games = games;
    Ok(Command::Playshare(o))
}

fn parse_game_tool(
    mut p: Parser<GameToolArg>,
    action: tvpipe::__cli::playshare::ToolAction,
) -> Result<Command, Error> {
    let mut o = tvpipe::__cli::playshare::ToolOptions {
        action,
        ..Default::default()
    };
    let mut path = None;
    while let Some(arg) = p.param()? {
        match arg {
            GameToolArg::Path => path = Some(p.value::<String>()?),
            GameToolArg::Out => o.out = Some(p.value::<String>()?.into()),
            GameToolArg::Smoke => o.smoke = true,
            GameToolArg::Strict => o.strict = true,
            GameToolArg::Browser => o.browser = Some(p.value::<String>()?.into()),
            GameToolArg::Refresh => o.fetch.refresh = true,
            GameToolArg::Offline => o.fetch.offline = true,
        }
    }
    if o.fetch.refresh && o.fetch.offline {
        return Err(p.error("--refresh and --offline together"));
    }
    use tvpipe::__cli::playshare::ToolAction;
    let path = match (path, action) {
        (Some(p), _) => p,
        (None, ToolAction::List) => String::new(),
        (None, _) => {
            return Err(p.error(format!(
                "{} needs the {}",
                action.command(),
                match action {
                    ToolAction::Check =>
                        "GAME: a folder, a .zip, an https:// URL, gh:OWNER/REPO or a name",
                    ToolAction::Fetch => "GAME: an https:// URL, gh:OWNER/REPO or a name",
                    _ => "DIR of the game",
                }
            )))
        }
    };
    o.path = path.into();
    Ok(Command::GameTool(o))
}

fn parse_qr(mut p: Parser<QrArg>) -> Result<Command, Error> {
    let mut format = QrFormat::Terminal;
    let mut text = None;
    while let Some(arg) = p.param()? {
        match arg {
            QrArg::Svg => format = QrFormat::Svg,
            QrArg::Rows => format = QrFormat::Rows,
            QrArg::Text => text = Some(p.value::<String>()?),
        }
    }
    let Some(text) = text else {
        return Err(p.error("debug qr needs the TEXT to encode"));
    };
    Ok(Command::Qr { text, format })
}

/// Collects everything after a literal `--` as ffmpeg input args.
fn take_after_double_dash<A: Copy + 'static>(p: &mut Parser<A>) -> Option<Vec<OsString>> {
    if p.peek_raw_arg().is_some_and(|a| a == "--") {
        p.raw_arg();
        let mut rest = Vec::new();
        while let Some(a) = p.raw_arg() {
            rest.push(a);
        }
        Some(rest)
    } else {
        None
    }
}

fn input_from(raw: OsString) -> InputSpec {
    if raw == "-" {
        InputSpec::Stdin
    } else {
        InputSpec::Path(raw)
    }
}

/// Which command `parse_play` parses.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Mode {
    Play,
    TestPattern,
    /// `play --to browser`; no INPUT: the test pattern.
    Preview,
}

fn parse_play(mut p: Parser<PlayArg>, mode: Mode, g: &mut Global) -> Result<PlayOptions, Error> {
    let test_pattern = mode == Mode::TestPattern;
    let mut o = PlayOptions {
        threads: 0,
        to: Vec::new(),
        reconnect: DEFAULT_RECONNECT,
        browser: BrowserOptions::default(),
        latency_ms: None,
        size: None,
        fps: None,
        bitrate_kbps: None,
        encoder: Encoder::Auto,
        no_audio: false,
        looped: false,
        realtime: None,
        raw_video: None,
        raw_audio: None,
        ffmpeg: None,
        input: InputSpec::TestPattern,
    };
    let mut input = None;
    loop {
        if !test_pattern {
            if let Some(args) = take_after_double_dash(&mut p) {
                if input.is_some() {
                    return Err(p.error("cannot combine INPUT with '-- FFMPEG_INPUT_ARGS'"));
                }
                if args.is_empty() {
                    return Err(p.error("expected ffmpeg input arguments after '--'"));
                }
                input = Some(InputSpec::FfmpegArgs(args));
                break;
            }
        }
        let Some(arg) = p.param()? else { break };
        match arg {
            PlayArg::To => o.to.push(p.value()?),
            PlayArg::Reconnect => o.reconnect = reconnect_secs(&mut p)?,
            PlayArg::Latency => o.latency_ms = Some(p.value()?),
            PlayArg::Size => o.size = Some(p.value()?),
            PlayArg::Fps => o.fps = Some(p.value()?),
            PlayArg::Bitrate => o.bitrate_kbps = Some(p.value()?),
            PlayArg::Encoder => o.encoder = parse_encoder(&p.value::<String>()?),
            PlayArg::NoAudio => o.no_audio = true,
            PlayArg::Loop => o.looped = true,
            PlayArg::Realtime => o.realtime = Some(true),
            PlayArg::NoRealtime => o.realtime = Some(false),
            PlayArg::RawVideo => o.raw_video = Some(p.value()?),
            PlayArg::RawAudio => o.raw_audio = Some(p.value()?),
            PlayArg::Ffmpeg => o.ffmpeg = Some(p.raw_value()?.into()),
            PlayArg::Port => o.browser.port = Some(p.value()?),
            PlayArg::Open => o.browser.open = true,
            PlayArg::WaitForViewer => o.browser.wait_for_viewer = true,
            PlayArg::NewToken => o.browser.new_token = true,
            PlayArg::Tunnel => o.browser.tunnel = tunnel_value(&mut p)?,
            PlayArg::TunnelTtl => o.browser.tunnel_ttl = tunnel_ttl_value(&mut p)?,
            PlayArg::NoQr => g.no_qr = true,
            PlayArg::Input => input = Some(input_from(p.raw_value()?)),
        }
    }
    if mode == Mode::Preview {
        o.to = vec![BROWSER_TARGET.to_owned()];
    }
    if o.browser.tunnel_ttl.is_some() && o.browser.tunnel.is_none() {
        return Err(p.error("--tunnel-ttl is for --tunnel"));
    }
    if let Some(InputSpec::Path(i)) = &input {
        tunnel_typo(&p, o.browser.tunnel, i.to_str())?;
    }
    if o.to.is_empty() {
        return Err(p.error("at least one --to NAME|ADDR is required"));
    }
    if !has_browser_target(&o.to) && o.browser != BrowserOptions::default() {
        return Err(p.error(PLAYER_ONLY));
    }
    match mode {
        Mode::Play => {
            o.input = input.ok_or_else(|| p.error("missing INPUT (or '-- FFMPEG_INPUT_ARGS')"))?;
        }
        Mode::Preview => o.input = input.unwrap_or(InputSpec::TestPattern),
        Mode::TestPattern => {}
    }
    let raw = o.raw_video.is_some() || o.raw_audio.is_some();
    if raw && o.input != InputSpec::Stdin {
        return Err(p.error("--raw-video/--raw-audio require '-' as INPUT"));
    }
    if o.input == InputSpec::Stdin && !raw {
        return Err(p.error("'-' as INPUT requires --raw-video and/or --raw-audio"));
    }
    Ok(o)
}

fn parse_share(mut p: Parser<ShareArg>, g: &mut Global) -> Result<Command, Error> {
    let mut o = ShareOptions {
        reconnect: DEFAULT_RECONNECT,
        ..ShareOptions::default()
    };
    let mut page = PageOptions::default();
    let mut url = None;
    let mut ttl = None;
    while let Some(arg) = p.param()? {
        match arg {
            ShareArg::To => o.to.push(p.value()?),
            ShareArg::Reconnect => o.reconnect = reconnect_secs(&mut p)?,
            ShareArg::Latency => o.latency_ms = Some(p.value()?),
            ShareArg::Size => o.size = Some(p.value()?),
            ShareArg::Fps => o.fps = Some(p.value()?),
            ShareArg::Bitrate => o.bitrate_kbps = Some(p.value()?),
            ShareArg::NoAudio => o.no_audio = true,
            ShareArg::Open => o.open = true,
            ShareArg::Port => o.player.port = Some(p.value()?),
            ShareArg::WaitForViewer => o.player.wait_for_viewer = true,
            ShareArg::NewToken => o.player.new_token = true,
            ShareArg::Tunnel => o.tunnel = tunnel_value(&mut p)?,
            ShareArg::TunnelTtl => ttl = Some(tunnel_ttl_value(&mut p)?),
            ShareArg::NoQr => g.no_qr = true,
            ShareArg::Yes => o.yes = true,
            ShareArg::Profile => page.profile = Some(p.value()?),
            ShareArg::Visible => page.visible = true,
            ShareArg::Reload => {
                let min: f64 = p.value()?;
                if !(min.is_finite() && min > 0.0 && min <= 7.0 * 24.0 * 60.0) {
                    return Err(p.error("--reload takes minutes (> 0)"));
                }
                page.reload = Some(Duration::from_secs_f64(min * 60.0));
            }
            ShareArg::Browser => page.browser = Some(p.value()?),
            ShareArg::Resolution => {
                let v: String = p.value()?;
                match tvpipe::Resolution::parse(&v) {
                    Some(r) => page.resolution = Some(r),
                    None => return Err(p.error("--resolution: auto, 720p, 1080p or 4k")),
                }
            }
            ShareArg::Url => url = Some(p.value::<String>()?),
        }
    }
    if o.to.is_empty() {
        return Err(p.error("at least one --to NAME|ADDR is required"));
    }
    let browser = has_browser_target(&o.to);
    if !browser && o.player != BrowserOptions::default() {
        return Err(p.error(PLAYER_ONLY));
    }
    tunnel_typo(&p, o.tunnel, url.as_deref())?;
    if (ttl.is_some() || o.yes) && o.tunnel.is_none() {
        return Err(p.error("--tunnel-ttl and --yes are for --tunnel"));
    }
    o.tunnel_ttl = ttl.unwrap_or(Some(SHARE_TUNNEL_TTL));
    match url {
        Some(_) if o.tunnel.is_some() => {
            return Err(p.error(
                "--tunnel serves the share page (without URL) to others; with URL tvpipe's own browser shares",
            ));
        }
        Some(url) => {
            if o.open && !browser {
                return Err(p.error(
                    "--open opens the share page (without URL) or the --to browser player page",
                ));
            }
            page.url = url;
            // The CLI always renders a layout at a resolution (--size is
            // the layout); the SDK's default keeps the page the stream.
            page.resolution = Some(page.resolution.unwrap_or_default());
            o.page = Some(page);
        }
        None if page != PageOptions::default() => {
            return Err(p.error(
                "--visible, --profile, --reload, --browser and --resolution are for 'share URL' (tvpipe's own browser)",
            ));
        }
        None => {}
    }
    Ok(Command::Share(o))
}

fn parse_screen(mut p: Parser<ScreenArg>, g: &mut Global) -> Result<Command, Error> {
    let mut o = ScreenOptions {
        share: ShareOptions {
            reconnect: DEFAULT_RECONNECT,
            ..ShareOptions::default()
        },
        ..ScreenOptions::default()
    };
    let mut targets = 0;
    while let Some(arg) = p.param()? {
        let s = &mut o.share;
        match arg {
            ScreenArg::To => s.to.push(p.value()?),
            ScreenArg::Reconnect => s.reconnect = reconnect_secs(&mut p)?,
            ScreenArg::Latency => s.latency_ms = Some(p.value()?),
            ScreenArg::Size => s.size = Some(p.value()?),
            ScreenArg::Fps => s.fps = Some(p.value()?),
            ScreenArg::Bitrate => s.bitrate_kbps = Some(p.value()?),
            ScreenArg::NoAudio => s.no_audio = true,
            ScreenArg::Open => s.open = true,
            ScreenArg::Port => s.player.port = Some(p.value()?),
            ScreenArg::WaitForViewer => s.player.wait_for_viewer = true,
            ScreenArg::NewToken => s.player.new_token = true,
            ScreenArg::Tunnel => s.player.tunnel = tunnel_value(&mut p)?,
            ScreenArg::TunnelTtl => s.player.tunnel_ttl = tunnel_ttl_value(&mut p)?,
            ScreenArg::NoQr => g.no_qr = true,
            ScreenArg::Display => {
                targets += 1;
                let v: String = p.value()?;
                o.target = match v.trim().parse::<u32>() {
                    Ok(0) => return Err(p.error("--display counts from 1 (the main screen)")),
                    Ok(n) => ScreenTarget::Display(n),
                    Err(_) if v.trim().is_empty() => {
                        return Err(p.error("--display takes a number or a name"))
                    }
                    Err(_) => ScreenTarget::DisplayNamed(v),
                };
            }
            ScreenArg::Window => {
                targets += 1;
                let v: String = p.value()?;
                if v.trim().is_empty() {
                    return Err(p.error("--window takes (a part of) the window's title"));
                }
                o.target = ScreenTarget::Window(v);
            }
            ScreenArg::Pick => {
                targets += 1;
                o.target = ScreenTarget::Pick;
            }
            ScreenArg::Engine => {
                let v: String = p.value()?;
                o.engine = Some(match v.to_ascii_lowercase().as_str() {
                    "browser" | "chrome" => ScreenEngine::Browser,
                    "ffmpeg" => ScreenEngine::Ffmpeg,
                    _ => return Err(p.error("--engine is browser or ffmpeg")),
                });
            }
            ScreenArg::Browser => o.browser = Some(p.value()?),
            ScreenArg::Ffmpeg => o.ffmpeg = Some(p.value()?),
        }
    }
    if o.share.to.is_empty() {
        return Err(p.error("at least one --to NAME|ADDR is required"));
    }
    if targets > 1 {
        return Err(p.error("give one of --display, --window and --pick"));
    }
    if o.share.player.tunnel_ttl.is_some() && o.share.player.tunnel.is_none() {
        return Err(p.error("--tunnel-ttl is for --tunnel"));
    }
    let browser_opts = BrowserOptions {
        open: o.share.open,
        ..o.share.player.clone()
    };
    if !has_browser_target(&o.share.to) && browser_opts != BrowserOptions::default() {
        return Err(p.error(PLAYER_ONLY));
    }
    match o.engine {
        Some(ScreenEngine::Ffmpeg) if o.browser.is_some() => {
            return Err(p.error("--browser is for --engine browser"));
        }
        Some(ScreenEngine::Ffmpeg) if o.target == ScreenTarget::Pick => {
            return Err(p.error("--pick needs the browser (--engine browser)"));
        }
        Some(ScreenEngine::Browser) if o.ffmpeg.is_some() => {
            return Err(p.error("--ffmpeg is for --engine ffmpeg"));
        }
        _ => {}
    }
    Ok(Command::Screen(o))
}

fn parse_pipeline(mut p: Parser<PipelineArg>) -> Result<Command, Error> {
    let mut o = PipelineOptions {
        raw: false,
        raw_video: None,
        raw_audio: None,
        ffmpeg: None,
        input: InputSpec::TestPattern,
    };
    let mut input = None;
    loop {
        if let Some(args) = take_after_double_dash(&mut p) {
            if input.is_some() || args.is_empty() {
                return Err(p.error("expected either INPUT or '-- FFMPEG_INPUT_ARGS...'"));
            }
            input = Some(InputSpec::FfmpegArgs(args));
            break;
        }
        let Some(arg) = p.param()? else { break };
        match arg {
            PipelineArg::Raw => o.raw = true,
            PipelineArg::RawVideo => o.raw_video = Some(p.value()?),
            PipelineArg::RawAudio => o.raw_audio = Some(p.value()?),
            PipelineArg::Ffmpeg => o.ffmpeg = Some(p.raw_value()?.into()),
            PipelineArg::Input => input = Some(input_from(p.raw_value()?)),
        }
    }
    // No input means: test pattern.
    o.input = input.unwrap_or(InputSpec::TestPattern);
    Ok(Command::DebugPipeline(o))
}

fn parse_encoder(s: &str) -> Encoder {
    match s {
        "builtin" => Encoder::Builtin,
        "x264" => Encoder::X264,
        "videotoolbox" => Encoder::VideoToolbox,
        "nvenc" => Encoder::Nvenc,
        "qsv" => Encoder::Qsv,
        "vaapi" => Encoder::Vaapi,
        "mf" => Encoder::MediaFoundation,
        _ => Encoder::Auto,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn play_with_ffmpeg_args() {
        let (_, cmd) = parse_from(&[
            "-v",
            "play",
            "--to",
            "Living Room",
            "--to",
            "10.0.0.5",
            "--fps",
            "30",
            "--",
            "-f",
            "avfoundation",
            "-i",
            "1:0",
        ])
        .unwrap();
        let Command::Play(o) = cmd else { panic!() };
        assert_eq!(o.to, ["Living Room", "10.0.0.5"]);
        assert_eq!(o.fps, Some(Ratio::integer(30)));
        assert_eq!(
            o.input,
            InputSpec::FfmpegArgs(
                ["-f", "avfoundation", "-i", "1:0"]
                    .map(OsString::from)
                    .to_vec()
            )
        );
    }

    #[test]
    fn play_raw_stdin() {
        let (_, cmd) = parse_from(&[
            "play",
            "--to",
            "tv",
            "--raw-video",
            "1920x1080@60:rgba",
            "--raw-audio",
            "48000:2:s16le",
            "-",
        ])
        .unwrap();
        let Command::Play(o) = cmd else { panic!() };
        assert_eq!(o.input, InputSpec::Stdin);
        assert_eq!(
            o.raw_video.unwrap().size,
            Size {
                width: 1920,
                height: 1080
            }
        );
        assert_eq!(o.raw_audio.unwrap().channels, 2);
    }

    #[test]
    fn builtin_encoder() {
        let (_, cmd) =
            parse_from(&["debug", "pattern", "--to", "tv", "--encoder", "builtin"]).unwrap();
        let Command::TestPattern(o) = cmd else {
            panic!()
        };
        assert_eq!(o.encoder, Encoder::Builtin);
        assert_eq!(o.input, InputSpec::TestPattern);
    }

    #[test]
    fn tunnel_and_qr() {
        let Ok((g, Command::Tunnel { port, provider })) = parse_from(&["debug", "tunnel", "8080"])
        else {
            panic!()
        };
        assert_eq!(
            (port, provider, g.no_qr),
            (8080, Provider::Cloudflare, false)
        );
        let Ok((g, Command::Tunnel { port, provider })) =
            parse_from(&["debug", "tunnel", "--tunnel=opentunnel", "--no-qr", "9"])
        else {
            panic!()
        };
        assert_eq!((port, provider, g.no_qr), (9, Provider::OpenTunnel, true));
        for bad in [
            &["debug", "tunnel"][..],
            &["debug", "tunnel", "0"],
            &["debug", "tunnel", "70000"],
            &["debug", "tunnel", "--tunnel=nope", "1"],
        ] {
            assert!(parse_from(bad).is_err(), "{bad:?}");
        }
        let Ok((_, Command::Qr { text, format })) = parse_from(&["debug", "qr", "--svg", "hi"])
        else {
            panic!()
        };
        assert_eq!((text.as_str(), format), ("hi", QrFormat::Svg));
        let Ok((_, Command::Qr { format, .. })) = parse_from(&["debug", "qr", "hi"]) else {
            panic!()
        };
        assert_eq!(format, QrFormat::Terminal);
        assert!(parse_from(&["debug", "qr"]).is_err());
    }

    #[test]
    fn game_tool_options() {
        use tvpipe::__cli::playshare::ToolAction;
        let Ok((_, Command::GameTool(o))) =
            parse_from(&["game", "pack", "games/x", "-o", "x.zip", "--smoke"])
        else {
            panic!("game pack");
        };
        assert_eq!(o.action, ToolAction::Pack);
        assert_eq!(o.path.to_str(), Some("games/x"));
        assert_eq!(o.out.as_deref().and_then(|p| p.to_str()), Some("x.zip"));
        assert!(o.smoke && !o.strict);
        let Ok((_, Command::GameTool(o))) = parse_from(&["game", "check", "--strict", "g.zip"])
        else {
            panic!("game check");
        };
        assert_eq!(o.action, ToolAction::Check);
        assert!(o.strict && !o.smoke);
        let Ok((_, Command::GameTool(o))) = parse_from(&["game", "new", "quiz"]) else {
            panic!("game new");
        };
        assert_eq!((o.action, o.path.to_str()), (ToolAction::New, Some("quiz")));
        let Ok((_, Command::GameTool(o))) =
            parse_from(&["game", "fetch", "drawbluff", "-o", "d.zip", "--refresh"])
        else {
            panic!("game fetch");
        };
        assert_eq!(
            (o.action, o.path.to_str()),
            (ToolAction::Fetch, Some("drawbluff"))
        );
        assert!(o.fetch.refresh && o.out.is_some());
        let Ok((_, Command::GameTool(o))) = parse_from(&["game", "list"]) else {
            panic!("game list");
        };
        assert_eq!(o.action, ToolAction::List);
        let Ok((_, Command::GameTool(o))) =
            parse_from(&["game", "check", "--offline", "https://example.com/g.zip"])
        else {
            panic!("game check remote");
        };
        assert!(o.fetch.offline);
        for bad in [
            &["game", "fetch"][..],
            &["game", "fetch", "--smoke", "x"],
            &["game", "list", "x"],
            &["game", "pack", "--offline", "x"],
            &["game", "pack"][..],
            &["game", "check"],
            &["game", "new"],
            &["game", "new", "--smoke", "x"],
            &["game", "check", "-o", "y.zip", "x"],
            &["game", "bundle", "x"],
        ] {
            assert!(parse_from(bad).is_err(), "{bad:?}");
        }
    }

    /// The old top-level names say where the command went.
    #[test]
    fn moved_commands() {
        for (old, new) in [
            ("test-pattern", "tvpipe debug pattern"),
            ("debug-pipeline", "tvpipe debug pipeline"),
            ("tunnel", "tvpipe debug tunnel"),
            ("qr", "tvpipe debug qr"),
            ("playshare", "tvpipe game play"),
            ("bundle", "tvpipe game pack"),
        ] {
            let e = parse_from(&["-v", old, "x"]).unwrap_err().to_string();
            assert!(e.contains("moved") && e.contains(new), "{old}: {e}");
        }
        let Ok((_, Command::DebugPipeline(_))) = parse_from(&["debug", "pipeline"]) else {
            panic!("debug pipeline");
        };
        // The groups alone print their help.
        for group in ["debug", "game"] {
            let e = parse_from(&[group]).unwrap_err();
            assert_eq!(e.kind(), argument::ErrorKind::Help, "{group}");
        }
    }

    #[test]
    fn playshare_options() {
        use tvpipe::__cli::playshare::{Resolution, TunnelChoice, WindowMode};
        let Ok((_, Command::Playshare(o))) = parse_from(&["game", "play", "games/x"]) else {
            panic!()
        };
        assert_eq!(o.games, ["games/x"]);
        assert!(!o.yes && !o.fetch.refresh && !o.fetch.offline);
        assert_eq!(o.tunnel, TunnelChoice::Auto);
        assert_eq!(o.window, WindowMode::App);
        assert_eq!(o.lan, None);
        assert_eq!(o.resolution, Resolution::Auto);
        assert!(!o.dev);
        // No game: the window's picker.
        let Ok((_, Command::Playshare(o))) = parse_from(&["game", "play"]) else {
            panic!()
        };
        assert!(o.games.is_empty());
        let Ok((_, Command::Playshare(o))) = parse_from(&["game", "play", "a", "b.zip"]) else {
            panic!()
        };
        assert_eq!(o.games, ["a", "b.zip"]);
        let Ok((_, Command::Playshare(o))) = parse_from(&[
            "game",
            "play",
            "--tunnel=cloudflare",
            "--lan=192.168.1.5",
            "--window",
            "none",
            "--port",
            "8000",
            "--resolution",
            "4k",
            "--bitrate",
            "20000",
            "--dev",
            "x.zip",
        ]) else {
            panic!()
        };
        assert_eq!(o.resolution, Resolution::P2160);
        assert_eq!(o.bitrate_kbps, Some(20000));
        assert!(o.dev);
        assert_eq!(o.tunnel, TunnelChoice::Provider(Provider::Cloudflare));
        assert_eq!(o.lan, Some(Some("192.168.1.5".parse().unwrap())));
        assert_eq!((o.window, o.port), (WindowMode::None, 8000));
        let Ok((_, Command::Playshare(o))) =
            parse_from(&["game", "play", "--no-tunnel", "--lan", "x"])
        else {
            panic!()
        };
        assert_eq!((o.tunnel, o.lan), (TunnelChoice::Off, Some(None)));
        let Ok((_, Command::Playshare(o))) = parse_from(&[
            "game",
            "play",
            "-y",
            "--offline",
            "gh:mitsuhiko/tvpipe/drawbluff@drawbluff-v*",
        ]) else {
            panic!()
        };
        assert_eq!(o.games, ["gh:mitsuhiko/tvpipe/drawbluff@drawbluff-v*"]);
        assert!(o.yes && o.fetch.offline);
        for bad in [
            &["game", "play", "--refresh", "--offline", "x"][..],
            &["game", "play", "--tunnel", "--no-tunnel", "x"],
            &["game", "play", "--tunnel=nope", "x"],
            &["game", "play", "--window", "tab", "x"],
            &["game", "play", "--lan=nope", "x"],
            &["game", "play", "--resolution", "8k", "x"],
            &["game", "play", "--bitrate", "fast", "x"],
        ] {
            assert!(parse_from(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn share_options() {
        let (_, cmd) = parse_from(&[
            "share",
            "--to",
            "Office TV",
            "--to",
            "cafe TV",
            "--fps",
            "60",
            "--size",
            "1280x720",
            "--open",
            "--no-audio",
        ])
        .unwrap();
        let Command::Share(o) = cmd else { panic!() };
        assert_eq!(o.to, ["Office TV", "cafe TV"]);
        assert_eq!(o.fps, Some(Ratio::integer(60)));
        // Without URL, --open opens the share page.
        assert_eq!((o.open, o.no_audio, o.page), (true, true, None));
        assert_eq!(o.player, BrowserOptions::default());
        assert_eq!(o.size.map(|s| (s.width, s.height)), Some((1280, 720)));
        assert!(parse_from(&["share"]).is_err());
        assert!(parse_from(&["share", "https://x"]).is_err());
        // With URL: --size is the layout, rendered at --resolution (auto
        // when not given).
        let (_, cmd) =
            parse_from(&["share", "https://x", "--to", "TV", "--size", "1280x720"]).unwrap();
        let Command::Share(o) = cmd else { panic!() };
        assert_eq!(o.page.unwrap().resolution, Some(tvpipe::Resolution::Auto));
        let (_, cmd) =
            parse_from(&["share", "https://x", "--to", "TV", "--resolution", "4k"]).unwrap();
        let Command::Share(o) = cmd else { panic!() };
        assert_eq!(o.page.unwrap().resolution, Some(tvpipe::Resolution::P2160));
        assert!(parse_from(&["share", "https://x", "--to", "TV", "--resolution", "8k"]).is_err());
        assert!(parse_from(&["share", "--to", "TV", "--resolution", "1080p"]).is_err());
        // --tunnel exposes the share page; not with URL.
        let (_, cmd) = parse_from(&["share", "--to", "TV", "--tunnel"]).unwrap();
        let Command::Share(o) = cmd else { panic!() };
        assert_eq!(o.tunnel, Some(Provider::Cloudflare));
        assert!(o.player.tunnel.is_none() && !o.yes);
        let (_, cmd) = parse_from(&["share", "--to", "TV", "--tunnel=opentunnel"]).unwrap();
        let Command::Share(o) = cmd else { panic!() };
        assert_eq!(o.tunnel, Some(Provider::OpenTunnel));
        assert!(parse_from(&["share", "--to", "TV", "--tunnel=ngrok"]).is_err());
        assert_eq!(o.tunnel_ttl, Some(SHARE_TUNNEL_TTL));
        assert!(parse_from(&["share", "https://x", "--to", "TV", "--tunnel"]).is_err());
        let share = |args: &[&str]| match parse_from(args).unwrap().1 {
            Command::Share(o) => o,
            _ => panic!(),
        };
        let o = share(&["share", "--to", "TV", "--tunnel", "--tunnel-ttl", "5", "-y"]);
        assert_eq!(
            (o.tunnel_ttl, o.yes),
            (Some(Duration::from_secs(300)), true)
        );
        let o = share(&["share", "--to", "TV", "--tunnel", "--tunnel-ttl", "0"]);
        assert_eq!(o.tunnel_ttl, None);
        assert!(parse_from(&["share", "--to", "TV", "--yes"]).is_err());
        assert!(parse_from(&["share", "--to", "TV", "--tunnel-ttl", "5"]).is_err());
        assert!(parse_from(&["share", "--to", "TV", "--tunnel", "--tunnel-ttl", "-1"]).is_err());
    }

    #[test]
    fn screen_options() {
        let screen = |args: &[&str]| {
            let mut a = vec!["screen", "--to", "TV"];
            a.extend_from_slice(args);
            match parse_from(&a).map(|(_, c)| c) {
                Ok(Command::Screen(o)) => Ok(o),
                Ok(_) => panic!("not screen"),
                Err(e) => Err(e.to_string()),
            }
        };
        let o = screen(&[]).unwrap();
        assert_eq!(o.target, ScreenTarget::Display(1));
        assert_eq!(o.engine, None);
        assert_eq!(o.share.to, ["TV"]);
        assert_eq!(o.share.reconnect, DEFAULT_RECONNECT);
        assert!(o.share.page.is_none());
        assert_eq!(
            screen(&["--display", "2"]).unwrap().target,
            ScreenTarget::Display(2)
        );
        assert_eq!(
            screen(&["--display", "Bildschirm 2"]).unwrap().target,
            ScreenTarget::DisplayNamed("Bildschirm 2".into())
        );
        assert!(screen(&["--display", "0"]).unwrap_err().contains("from 1"));
        assert_eq!(
            screen(&["--window", "Keynote"]).unwrap().target,
            ScreenTarget::Window("Keynote".into())
        );
        assert!(screen(&["--window", " "]).is_err());
        assert_eq!(screen(&["--pick"]).unwrap().target, ScreenTarget::Pick);
        assert!(screen(&["--pick", "--window", "x"])
            .unwrap_err()
            .contains("one of"));
        let o = screen(&[
            "--engine",
            "ffmpeg",
            "--ffmpeg",
            "/opt/ffmpeg",
            "--fps",
            "60",
            "--size",
            "1280x720",
            "--no-audio",
            "--latency",
            "200",
            "--bitrate",
            "4000",
        ])
        .unwrap();
        assert_eq!(o.engine, Some(ScreenEngine::Ffmpeg));
        assert_eq!(o.ffmpeg, Some(PathBuf::from("/opt/ffmpeg")));
        assert!(o.share.no_audio);
        assert_eq!(o.share.fps, Some(Ratio::integer(60)));
        assert_eq!(o.share.latency_ms, Some(200));
        assert_eq!(o.share.bitrate_kbps, Some(4000));
        assert_eq!(
            screen(&["--engine", "browser", "--browser", "/x/chrome"])
                .unwrap()
                .browser,
            Some(PathBuf::from("/x/chrome"))
        );
        assert!(screen(&["--engine", "vlc"]).is_err());
        assert!(screen(&["--engine", "ffmpeg", "--pick"]).is_err());
        assert!(screen(&["--engine", "ffmpeg", "--browser", "x"]).is_err());
        assert!(screen(&["--engine", "browser", "--ffmpeg", "x"]).is_err());
        // The player's options only with --to browser.
        assert!(screen(&["--open"]).unwrap_err().contains("--to browser"));
        let o = parse_from(&["screen", "--to", "browser", "--open", "--port", "0"]).unwrap();
        let Command::Screen(o) = o.1 else { panic!() };
        assert!(o.share.open);
        assert_eq!(o.share.player.port, Some(0));
        assert!(parse_from(&["screen"]).is_err());
    }

    #[test]
    fn share_url_options() {
        let (_, cmd) = parse_from(&[
            "share",
            "https://example.com/dash",
            "--to",
            "TV",
            "--to",
            "browser",
            "--size",
            "1280x720",
            "--reload",
            "0.5",
            "--visible",
            "--profile",
            "/tmp/p",
            "--browser",
            "/opt/chrome",
            "--open",
            "--port",
            "8123",
            "--wait-for-viewer",
            "--new-token",
        ])
        .unwrap();
        let Command::Share(o) = cmd else { panic!() };
        assert_eq!(o.to, ["TV", "browser"]);
        assert_eq!(o.size.map(|s| (s.width, s.height)), Some((1280, 720)));
        assert!(o.open && !o.no_audio);
        assert_eq!(
            o.player,
            BrowserOptions {
                port: Some(8123),
                open: false,
                wait_for_viewer: true,
                new_token: true,
                tunnel: None,
                tunnel_ttl: None,
            }
        );
        assert_eq!(
            o.page,
            Some(PageOptions {
                url: "https://example.com/dash".into(),
                profile: Some("/tmp/p".into()),
                visible: true,
                reload: Some(Duration::from_secs(30)),
                browser: Some("/opt/chrome".into()),
                resolution: Some(tvpipe::Resolution::Auto),
                control: None,
            })
        );
        let (_, cmd) = parse_from(&["share", "--to", "TV", "file:///tmp/x.html"]).unwrap();
        let Command::Share(o) = cmd else { panic!() };
        let page = o.page.unwrap();
        assert_eq!(page.url, "file:///tmp/x.html");
        assert_eq!(
            (page.reload, page.visible, page.profile),
            (None, false, None)
        );
        let err = |args: &[&str]| parse_from(args).unwrap_err().to_string();
        assert!(err(&["share", "https://x", "--to", "TV", "--reload", "0"]).contains("--reload"));
        assert!(parse_from(&["share", "https://x", "--to", "TV", "--reload", "-1"]).is_err());
        // URL-only options without a URL.
        for opt in [
            &["--visible"][..],
            &["--profile", "/tmp/p"],
            &["--reload", "5"],
            &["--browser", "/opt/chrome"],
        ] {
            let mut args = vec!["share", "--to", "TV"];
            args.extend_from_slice(opt);
            assert!(
                err(&args).contains("'share URL'"),
                "{opt:?}: {}",
                err(&args)
            );
        }
        // With a URL there is no share page: --open is the player's.
        assert!(err(&["share", "https://x", "--to", "TV", "--open"]).contains("--open"));
        assert!(parse_from(&["share", "https://x", "--to", "browser", "--open"]).is_ok());
    }

    /// The player options mean the same in every subcommand and need
    /// `--to browser` everywhere.
    #[test]
    fn player_options_everywhere() {
        let player = |args: &[&str]| -> BrowserOptions {
            match parse_from(args).unwrap().1 {
                Command::Play(o) | Command::TestPattern(o) => o.browser,
                Command::Share(o) => BrowserOptions {
                    open: o.open,
                    ..o.player
                },
                other => panic!("{other:?}"),
            }
        };
        let want = BrowserOptions {
            port: Some(9000),
            open: true,
            wait_for_viewer: true,
            new_token: true,
            tunnel: None,
            tunnel_ttl: None,
        };
        let opts = [
            "--port",
            "9000",
            "--open",
            "--wait-for-viewer",
            "--new-token",
        ];
        for cmd in [
            &["play", "--to", "browser", "x.mp4"][..],
            &["debug", "pattern", "--to", "browser"],
            &["preview"],
            &["share", "--to", "browser"],
            &["share", "https://example.com", "--to", "browser"],
        ] {
            let mut args = cmd.to_vec();
            args.extend_from_slice(&opts);
            assert_eq!(player(&args), want, "{cmd:?}");
        }
        for cmd in [
            &["play", "--to", "tv", "x.mp4"][..],
            &["debug", "pattern", "--to", "tv"],
            &["share", "--to", "tv"],
            &["share", "https://example.com", "--to", "tv"],
        ] {
            for opt in [
                &["--port", "9000"][..],
                &["--wait-for-viewer"],
                &["--new-token"],
            ] {
                let mut args = cmd.to_vec();
                args.extend_from_slice(opt);
                let e = parse_from(&args).unwrap_err().to_string();
                assert!(e.contains("--to browser"), "{args:?}: {e}");
            }
        }
        // `browser` is no subcommand any more.
        assert!(parse_from(&["browser", "https://x", "--to", "tv"]).is_err());
    }

    #[test]
    fn reconnect_option() {
        let get = |args: &[&str]| match parse_from(args).unwrap().1 {
            Command::Play(o) | Command::TestPattern(o) => o.reconnect,
            Command::Share(o) => o.reconnect,
            other => panic!("{other:?}"),
        };
        assert_eq!(get(&["play", "--to", "tv", "x.mp4"]), DEFAULT_RECONNECT);
        assert_eq!(get(&["share", "--to", "tv"]), DEFAULT_RECONNECT);
        let secs = Duration::from_secs;
        assert_eq!(
            get(&["debug", "pattern", "--to", "tv", "--reconnect", "0"]),
            secs(0)
        );
        assert_eq!(get(&["share", "--to", "tv", "--reconnect", "30"]), secs(30));
        assert_eq!(
            get(&["play", "--to", "tv", "--reconnect", "1.5", "x.mp4"]),
            Duration::from_millis(1500)
        );
        for bad in ["-1", "x", "inf", "100000"] {
            assert!(parse_from(&["play", "--to", "tv", "--reconnect", bad, "x.mp4"]).is_err());
        }
        // `preview` streams to the browser only.
        assert!(parse_from(&["preview", "--reconnect", "5"]).is_err());
    }

    #[test]
    fn play_requires_to() {
        assert!(parse_from(&["play", "movie.mkv"]).is_err());
        assert!(parse_from(&["play", "--to", "tv", "-"]).is_err());
    }

    #[test]
    fn browser_receiver_and_preview() {
        let play = |args: &[&str]| match parse_from(args) {
            Ok((_, Command::Play(o) | Command::TestPattern(o))) => o,
            other => panic!("{other:?}"),
        };
        // `preview` without INPUT: the test pattern, in the browser only.
        let o = play(&["preview"]);
        assert_eq!(o.to, ["browser"]);
        assert_eq!(o.input, InputSpec::TestPattern);
        assert_eq!(o.browser, BrowserOptions::default());
        let o = play(&[
            "preview",
            "--open",
            "--port",
            "8123",
            "--latency",
            "500",
            "a.mp4",
        ]);
        assert_eq!(o.input, InputSpec::Path("a.mp4".into()));
        assert_eq!(o.latency_ms, Some(500));
        assert_eq!(
            o.browser,
            BrowserOptions {
                port: Some(8123),
                open: true,
                ..BrowserOptions::default()
            }
        );
        let o = play(&["preview", "--", "-f", "avfoundation", "-i", "1"]);
        assert!(matches!(o.input, InputSpec::FfmpegArgs(_)));
        assert!(parse_from(&["preview", "--to", "tv"]).is_err());
        // Next to TVs.
        let o = play(&[
            "play",
            "--to",
            "tv",
            "--to",
            "Browser",
            "--wait-for-viewer",
            "x.mkv",
        ]);
        assert_eq!(o.to, ["tv", "Browser"]);
        assert!(o.browser.wait_for_viewer);
        let o = play(&["debug", "pattern", "--to", "browser"]);
        assert_eq!(o.input, InputSpec::TestPattern);
        // The page's options need a page.
        assert!(parse_from(&["play", "--to", "tv", "--open", "x.mkv"]).is_err());
        assert!(parse_from(&["debug", "pattern", "--to", "tv", "--port", "1"]).is_err());
        assert!(play(&["preview", "--new-token"]).browser.new_token);
        assert_eq!(
            play(&["preview", "--tunnel"]).browser.tunnel,
            Some(Provider::Cloudflare)
        );
        assert_eq!(
            play(&["preview", "--tunnel=cloudflare"]).browser.tunnel,
            Some(Provider::Cloudflare)
        );
        assert_eq!(
            play(&["preview", "--tunnel=OpenTunnel"]).browser.tunnel,
            Some(Provider::OpenTunnel)
        );
        // The value is attached: a separate word is the input.
        assert_eq!(
            play(&["preview", "--tunnel", "x.mkv"]).input,
            InputSpec::Path("x.mkv".into())
        );
        assert!(parse_from(&["preview", "--tunnel", "opentunnel"]).is_err());
        assert!(parse_from(&["share", "--to", "TV", "--tunnel", "opentunnel"]).is_err());
        assert_eq!(play(&["preview", "--tunnel"]).browser.tunnel_ttl, None);
        assert_eq!(
            play(&["preview", "--tunnel", "--tunnel-ttl", "1.5"])
                .browser
                .tunnel_ttl,
            Some(Duration::from_secs(90))
        );
        assert!(parse_from(&["preview", "--tunnel-ttl", "5"]).is_err());
        assert!(parse_from(&["debug", "pattern", "--to", "tv", "--tunnel"]).is_err());
    }

    #[test]
    fn machine_flag() {
        let (g, cmd) = parse_from(&["--machine", "-v", "preview"]).unwrap();
        assert!(g.machine && g.verbose);
        assert_eq!(cmd.name(), "play");
        let (g, _) = parse_from(&["discover"]).unwrap();
        assert!(!g.machine);
    }

    #[test]
    fn no_qr_flag() {
        for args in [
            &["preview", "--no-qr"][..],
            &["play", "--to", "browser", "--tunnel", "--no-qr", "x.mp4"],
            &["debug", "pattern", "--to", "tv", "--no-qr"],
            &["share", "--to", "tv", "--tunnel", "--no-qr"],
            &["screen", "--to", "tv", "--no-qr"],
        ] {
            let (g, _) = parse_from(args).unwrap();
            assert!(g.no_qr, "{args:?}");
        }
        let (g, _) = parse_from(&["share", "--to", "tv", "--tunnel"]).unwrap();
        assert!(!g.no_qr);
    }

    #[test]
    fn discover_defaults() {
        let (_, cmd) = parse_from(&["discover"]).unwrap();
        let Command::Discover { timeout, json, .. } = cmd else {
            panic!()
        };
        assert_eq!(timeout, Duration::from_secs(3));
        assert!(!json);
    }

    #[test]
    fn specs() {
        assert!("1920x1080@30000/1001:yuv420p"
            .parse::<RawVideoSpec>()
            .is_ok());
        assert!("1920x1081@30:rgba".parse::<RawVideoSpec>().is_err());
        assert!("48000:2".parse::<RawAudioSpec>().is_err());
    }
}
