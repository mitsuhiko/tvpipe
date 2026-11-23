//! `tvpipe game play`: web games served by tvpipe
//! (docs/playshare-design.md). A bundle (a folder or a zip with
//! `tvpipe.json`) is served on two listeners; the game's host page runs
//! in a window of tvpipe's own browser and talks to tvpipe over a local
//! API; phones' WebSockets are relayed to it; its TV page is rendered by a
//! headless browser and cast with the `share URL` machinery.
//!
//! - [`bundle`]: the manifest and the files (folders, zips).
//! - [`server`]: the listeners, their access rules, static files.
//! - [`hub`]: the API, the relay, discovery/pairing/cast progress.
//! - [`conn`]: one WebSocket with an outbox and limits.
//! - [`shortlink`]: short join links at tvpipe.party (docs/short-links.md).
//! - [`surface`]: canvases the pages encode, streamed without a browser.
//! - [`backend`]: discovery, pairing, casting, surfaces (fakes in tests).
//! - [`window`]: the app window.
//! - [`web`]: the library and the launcher, embedded.
//! - [`check`], [`scan`], [`smoke`], [`tool`]: `tvpipe game pack`/`check`/`new` (checks,
//!   packing, a run in a headless browser, the starter template).
//! - [`source`], [`remote`], [`cache`]: games from the internet (§18): what
//!   a source may be, fetching from GitHub and the games list, the cache.
//! - [`picker`]: the games list in the window: the first game when none
//!   was given, the next one any time (docs/game-catalog.md,
//!   docs/game-switching.md).

pub mod backend;
pub mod bundle;
pub mod cache;
pub mod check;
pub mod conn;
pub mod hub;
pub mod picker;
pub mod remote;
pub mod resolution;
pub mod scan;
pub mod server;
pub mod shortlink;
pub mod smoke;
pub mod source;
pub mod surface;
pub mod tool;
pub mod web;
pub mod window;

use std::net::{IpAddr, SocketAddr};
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

use crate::ctx::Ctx;
use crate::error::{Error, Result};
use crate::events::{Events, Progress, Step};
use crate::net::httpd;
use crate::net::tunnel::Provider;
use crate::util::stop::Stop;

pub use bundle::Bundle;
pub use hub::Hub;
pub use window::WindowMode;

/// The LAN listener's port when free (`--lan`; the next of the following
/// 20 otherwise), as the old party host had it.
pub const LAN_PORT: u16 = 7420;
/// With a window we do not own: no page connected for this long ends
/// the run.
pub const ORPHAN_AFTER: Duration = Duration::from_secs(30);
const TICK: Duration = Duration::from_millis(200);

/// Who carries the phones' link.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum TunnelChoice {
    /// OpenTunnel (its identity is reused), else Cloudflare.
    #[default]
    Auto,
    Provider(Provider),
    /// No public link (`--no-tunnel`).
    Off,
}

/// `tvpipe game play` (the CLI's options).
#[derive(Debug, Clone, Default)]
pub struct Options {
    /// The games: one game (a folder, a `.zip`, an `https://` URL, `gh:…`
    /// or a name from the games list, §18), or folders of games and
    /// several local ones; none: the window picks one from the list
    /// (docs/game-catalog.md, docs/game-switching.md).
    pub games: Vec<String>,
    /// `--refresh`, `--offline`.
    pub fetch: remote::FetchOptions,
    /// `--yes`: a game from the internet runs without the question.
    pub yes: bool,
    pub tunnel: TunnelChoice,
    /// `--lan [IP]`: `Some(None)` for the default route's address.
    pub lan: Option<Option<IpAddr>>,
    pub window: WindowMode,
    /// `--browser`: the window's and the TV's browser.
    pub browser: Option<PathBuf>,
    /// The local listener's port (0: any).
    pub port: u16,
    /// `--resolution`: the TV picture's at the start (the launcher and
    /// the cast picker change it).
    pub resolution: resolution::Resolution,
    /// `--fps`, `--bitrate`, `--latency`, `--no-audio`, `--reconnect`:
    /// the TV picture's stream (defaults: 30 fps, the bitrate from its
    /// size and frame rate, the receivers' latency, sound, 120 s).
    pub stream: backend::StreamOptions,
    /// `--no-short-link`: no short link at tvpipe.party.
    pub no_short_link: bool,
    /// `--dev`: test mode, `info.dev` (a game's host page offers its test
    /// tools: bots, dummy players that join and play).
    pub dev: bool,
}

/// A started playshare session: the hub, its listeners and the tunnel.
pub(crate) struct Running {
    pub hub: Arc<Hub>,
    servers: Servers,
    tunnel: TunnelThread,
}

impl Running {
    /// Binds the listeners with `bundle` in the slot and starts the
    /// tunnel (in the background).
    pub(crate) fn start(
        bundle: Bundle,
        backend: Box<dyn backend::Backend>,
        opts: &Options,
        stop: Stop,
    ) -> Result<Running> {
        Running::start_with(
            Some(bundle),
            backend,
            opts,
            stop,
            Events::none(),
            picker::Config::default(),
        )
    }

    /// The session, with progress events for a front end; `bundle`: the
    /// first game, else the window picks one from `picker`'s list.
    pub(crate) fn start_with(
        bundle: Option<Bundle>,
        backend: Box<dyn backend::Backend>,
        opts: &Options,
        stop: Stop,
        events: Events,
        picker: picker::Config,
    ) -> Result<Running> {
        let token = crate::util::hex::encode(&crate::crypto::ring::random_array::<16>()?);
        let hub = Hub::session(token, backend, stop.clone(), picker);
        hub.set_resolution(opts.resolution);
        hub.dev.store(opts.dev, Ordering::Relaxed);
        let _ = hub.events.set(events);
        let _ = hub.shortlinks.set(shortlink::ShortLinks::from_env(
            opts.no_short_link,
            stop.clone(),
        ));
        let servers = Servers::start(&hub, opts.port, opts.lan)?;
        let tunnel = start_tunnel(&hub, opts.tunnel);
        if let Some(b) = bundle {
            hub.put(b);
        }
        Ok(Running {
            hub,
            servers,
            tunnel,
        })
    }

    /// The window's first URL (it sets the session cookie).
    pub(crate) fn start_url(&self) -> String {
        format!(
            "http://127.0.0.1:{}/_tvpipe/start?t={}",
            self.hub.ports.get().map(|p| p.local).unwrap_or(0),
            self.hub.token
        )
    }

    /// The end (§10).
    pub(crate) fn end(self) {
        self.hub.shutdown();
        // While the tunnel still carries the link's target.
        if let Some(l) = self.hub.shortlinks.get() {
            l.release();
        }
        drop(self.tunnel);
        drop(self.servers);
    }
}

/// Asks the person a yes/no question (the text ends in `[y/N]`; the
/// function polls whether to give up): `Some(answer)`, or `None` when there
/// is nobody to ask.
pub type Ask<'a> = &'a dyn Fn(&str, &dyn Fn() -> bool) -> Option<bool>;

/// What the command line's games mean (docs/game-switching.md).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Games {
    /// None: the window picks from the online list.
    Pick,
    /// One game, played at once (and in the list if it is local).
    One(String),
    /// Games on this computer (bundles and folders of them): the window
    /// picks.
    Local(Vec<PathBuf>),
}

impl Games {
    /// Sorts the command line's games out: one game (local or not), or
    /// local ones only.
    pub fn parse(games: &[String]) -> Result<Games> {
        let games: Vec<&str> = games
            .iter()
            .map(|g| g.trim())
            .filter(|g| !g.is_empty())
            .collect();
        match games.as_slice() {
            [] => Ok(Games::Pick),
            [one] => {
                let p = std::path::Path::new(one);
                if p.exists() && !picker::is_bundle(p) {
                    Ok(Games::Local(vec![p.to_owned()]))
                } else {
                    Ok(Games::One((*one).to_owned()))
                }
            }
            many => {
                let mut paths = Vec::new();
                for g in many {
                    let p = std::path::Path::new(g);
                    if !p.exists() {
                        return Err(Error::usage(format!(
                            "{g}: no such file or folder (several games are folders or zips on \
                             this computer; a game from the internet comes alone)"
                        )));
                    }
                    paths.push(p.to_owned());
                }
                Ok(Games::Local(paths))
            }
        }
    }
}

/// The game of `source`: a local one as it is; one from the internet
/// fetched (or from the cache), and run only after the question (§18)
/// unless pinned, approved before or `--yes`.
pub fn open_game(source: &str, opts: &Options, ctx: &Ctx, ask: Ask<'_>) -> Result<Bundle> {
    let src = source::Source::parse(source)?;
    if let source::Source::Local(p) = &src {
        return Bundle::open(p);
    }
    let fetcher =
        remote::Fetcher::from_env(opts.fetch, ctx.events.clone(), Some(ctx.stop.clone()))?;
    let f = fetcher.fetch(&src)?;
    if f.pinned || f.trusted || opts.yes {
        return Ok(f.bundle);
    }
    let stop = ctx.stop.clone();
    match ask(&f.question(), &|| stop.requested()) {
        Some(true) => {
            fetcher.trust(&f)?;
            Ok(f.bundle)
        }
        Some(false) => Err(Error::usage(format!(
            "not playing {}: you said no",
            f.bundle.manifest.name
        ))),
        None if stop.requested() => Err(Error::closed("stopped")),
        None => Err(Error::usage(format!(
            "{} is a game from the internet, and there is no terminal to ask whether to run it: \
             pass --yes, or pin it: tvpipe game play '{}'",
            f.shown, f.pin_hint
        ))),
    }
}

/// Runs playshare until the window closes, the page quits or `ctx`'s
/// stop is requested. Prints the window's URL with `--window none`. One
/// game given: it is fetched and, from the internet the first time, asked
/// about with `ask`, and played at once; otherwise the window opens on
/// the games list. Either way the window can switch to another game of
/// the list any time (docs/game-switching.md).
pub fn run(opts: &Options, ctx: &Ctx, ask: Ask<'_>) -> Result<()> {
    let (first, local) = match Games::parse(&opts.games)? {
        Games::Pick => (None, Vec::new()),
        Games::One(g) => {
            let bundle = open_game(&g, opts, ctx, ask)?;
            let p = std::path::Path::new(&g);
            let local = if p.exists() {
                vec![p.to_owned()]
            } else {
                Vec::new()
            };
            (Some(bundle), local)
        }
        Games::Local(paths) => {
            if picker::scan(&paths).is_empty() {
                let shown: Vec<String> = paths.iter().map(|p| p.display().to_string()).collect();
                return Err(Error::usage(format!(
                    "{}: no {} here, and no games (folders with one, zips) in it",
                    shown.join(", "),
                    bundle::MANIFEST
                )));
            }
            info!("playshare: pick a game in the window");
            (None, paths)
        }
    };
    let (fetch, stop) = (opts.fetch, ctx.stop.clone());
    let make: picker::MakeFetcher =
        Arc::new(move |events| remote::Fetcher::from_env(fetch, events, Some(stop.clone())));
    let picker = picker::Config {
        make: Some(make),
        yes: opts.yes,
        local,
    };
    let backend = backend::Real {
        storage: ctx.storage.clone(),
        browser: opts.browser.clone(),
        stream: opts.stream.clone(),
    };
    let running = Running::start_with(
        first,
        Box::new(backend),
        opts,
        ctx.stop.clone(),
        ctx.events.clone(),
        picker,
    )?;
    let url = running.start_url();
    let window = match open_window(opts, &url, &ctx.events) {
        Ok(w) => w,
        Err(e) => {
            running.end();
            return Err(e);
        }
    };
    serve(running, window, &ctx.stop, &ctx.events);
    Ok(())
}

/// Opens the window on `url` (prints it with `--window none`).
fn open_window(opts: &Options, url: &str, events: &Events) -> Result<window::Window> {
    if opts.window != WindowMode::None {
        events.progress(Progress::Begin(Step::Window));
    }
    let (window, mode) = match window::Window::open(opts.window, url, opts.browser.as_ref()) {
        Ok(w) => w,
        Err(e) => {
            events.progress(Progress::Failed(Step::Window, e.to_string()));
            return Err(e);
        }
    };
    if opts.window != WindowMode::None {
        events.progress(Progress::Done(Step::Window, None));
    }
    if mode == WindowMode::None {
        println!("{url}");
    }
    Ok(window)
}

/// Runs the game until the window closes, the page quits or a stop.
fn serve(running: Running, mut window: window::Window, stop: &Stop, events: &Events) {
    let hub = running.hub.clone();
    let mut phones = 0;
    let why = loop {
        if stop.wait(TICK) {
            break "stopped";
        }
        hub.tick();
        let n = hub.client_count();
        if n != phones {
            phones = n;
            events.progress(Progress::Phones(n));
        }
        if window.owned() {
            window.pass_out_new_pages();
            if window.closed() {
                break "the window was closed";
            }
        } else if hub.apis_gone_for().is_some_and(|d| d > ORPHAN_AFTER) {
            break "no page has been connected for 30 s";
        }
    };
    info!("playshare: ending ({why})");
    // The pages first (goodbyes to phones), then the window.
    running.end();
    window.close();
}

/// The listeners.
struct Servers {
    list: Vec<httpd::Server>,
}

impl Servers {
    fn start(hub: &Arc<Hub>, port: u16, lan: Option<Option<IpAddr>>) -> Result<Servers> {
        // For the largest game: the relay's own limit is the game's.
        let config = httpd::Config {
            max_connections: hub::relay_limit(bundle::MAX_PLAYERS) + 64,
            max_body: 64 * 1024,
            lan: false,
        };
        let local = httpd::Server::bind_with(
            SocketAddr::from(([127, 0, 0, 1], port)),
            server::handler(hub.clone(), server::Listener::Local),
            config,
        )?;
        let public = httpd::Server::bind_with(
            SocketAddr::from(([127, 0, 0, 1], 0)),
            server::handler(hub.clone(), server::Listener::Public),
            config,
        )?;
        let mut list = vec![];
        let mut lan_addr = None;
        if let Some(ip) = lan {
            let ip = match ip {
                Some(ip) => ip,
                None => IpAddr::V4(crate::net::iface::default_ipv4()?),
            };
            let cfg = httpd::Config {
                lan: true,
                ..config
            };
            let mut bound = None;
            let mut last = None;
            for port in (LAN_PORT..LAN_PORT + 20).chain([0]) {
                match httpd::Server::bind_with(
                    SocketAddr::new(ip, port),
                    server::handler(hub.clone(), server::Listener::Lan),
                    cfg,
                ) {
                    Ok(s) => {
                        bound = Some(s);
                        break;
                    }
                    Err(e) => last = Some(e),
                }
            }
            let s = match bound {
                Some(s) => s,
                None => {
                    return Err(last.unwrap_or_else(|| Error::closed("no LAN port")));
                }
            };
            lan_addr = Some(s.local_addr());
            list.push(s);
        }
        let _ = hub.ports.set(hub::Ports {
            local: local.local_addr().port(),
            public: public.local_addr().port(),
            lan: lan_addr,
        });
        list.push(local);
        list.push(public);
        Ok(Servers { list })
    }
}

impl Drop for Servers {
    fn drop(&mut self) {
        for s in &mut self.list {
            s.shutdown();
        }
    }
}

/// A running tunnel, dropped at the end.
struct TunnelThread {
    slot: Arc<std::sync::Mutex<Option<Box<dyn crate::net::tunnel::Tunnel>>>>,
}

impl Drop for TunnelThread {
    fn drop(&mut self) {
        let t = self.slot.lock().unwrap_or_else(|e| e.into_inner()).take();
        drop(t);
    }
}

/// Starts the tunnel in the background (§11): the API reports it when it
/// is up.
fn start_tunnel(hub: &Arc<Hub>, choice: TunnelChoice) -> TunnelThread {
    let slot: Arc<std::sync::Mutex<Option<Box<dyn crate::net::tunnel::Tunnel>>>> = Arc::default();
    let order: Vec<Provider> = match choice {
        TunnelChoice::Off => return TunnelThread { slot },
        TunnelChoice::Auto => vec![Provider::OpenTunnel, Provider::Cloudflare],
        TunnelChoice::Provider(p) => vec![p],
    };
    let port = hub.ports.get().map(|p| p.public).unwrap_or(0);
    {
        let mut t = hub.tunnel.write().unwrap_or_else(|e| e.into_inner());
        t.state = "starting";
    }
    hub.progress(Progress::Begin(Step::Tunnel));
    let (hub, s) = (hub.clone(), slot.clone());
    let _ = std::thread::Builder::new()
        .name("playshare-tunnel".into())
        .spawn(move || {
            let stop = hub.stop.clone();
            let mut last_err = None;
            for p in order {
                if stop.requested() {
                    return;
                }
                let started = match p {
                    // The last quick tunnel again, if Cloudflare kept it.
                    Provider::Cloudflare => crate::storage::cli_dir()
                        .map(|d| d.join("cloudflare-quick-tunnel.json"))
                        .and_then(|f| {
                            crate::net::cftunnel::Tunnel::start_reusing(port, &f, &|| {
                                stop.requested()
                            })
                        })
                        .map(|t| Box::new(t) as Box<dyn crate::net::tunnel::Tunnel>),
                    _ => crate::net::tunnel::start(port, p, &|| stop.requested()),
                };
                match started {
                    Ok(t) => {
                        info!(
                            "playshare: phones join at https://{}/ ({})",
                            t.host(),
                            t.name()
                        );
                        {
                            let mut info = hub.tunnel.write().unwrap_or_else(|e| e.into_inner());
                            info.state = "up";
                            info.provider = Some(p.name().to_owned());
                            info.host = Some(t.host().to_owned());
                            info.error = None;
                        }
                        hub.progress(Progress::GameLink {
                            url: format!("https://{}/", t.host()),
                            provider: p.name().to_owned(),
                            short: hub.shortlinks.get().is_some_and(|l| l.enabled()),
                        });
                        *hub.peers.write().unwrap_or_else(|e| e.into_inner()) = t.peer_lookup();
                        *s.lock().unwrap_or_else(|e| e.into_inner()) = Some(t);
                        if stop.requested() {
                            s.lock().unwrap_or_else(|e| e.into_inner()).take();
                            return;
                        }
                        hub.tunnel_changed();
                        return;
                    }
                    Err(e) => {
                        warn!("playshare: {} tunnel: {e}", p.name());
                        last_err = Some(e.to_string());
                    }
                }
            }
            hub.progress(Progress::Failed(
                Step::Tunnel,
                last_err.clone().unwrap_or_else(|| "no tunnel".into()),
            ));
            {
                let mut info = hub.tunnel.write().unwrap_or_else(|e| e.into_inner());
                info.state = "failed";
                info.error = last_err;
            }
            hub.tunnel_changed();
        });
    TunnelThread { slot }
}

#[cfg(test)]
mod tests;
