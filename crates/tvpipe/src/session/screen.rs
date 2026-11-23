//! `tvpipe screen`: a screen or a window, with the computer's sound.
//!
//! - **browser** (the default when a Chromium-based browser is
//!   installed): the share pipeline (`share_rejoin`) with tvpipe's own
//!   browser as the page (`browser::screen`): it captures with
//!   getDisplayMedia, the picker answered by a switch, and encodes with
//!   WebCodecs; the capture's size plans the stream like `share`.
//! - **ffmpeg**: `play` with ffmpeg input arguments for this OS
//!   (`media::screencap`).

use std::any::Any;

use super::*;
use crate::browser::launch;
use crate::browser::screen::{ScreenBrowser, ScreenOptions as BrowserScreen};
#[cfg(feature = "ffmpeg")]
use crate::media::screencap;
use crate::opts::{ScreenEngine, ScreenOptions, ScreenTarget};

/// The ffmpeg engine's output size without `--size` (the screen is fitted
/// inside, keeping its shape).
const FFMPEG_SIZE: Size = Size {
    width: 1920,
    height: 1080,
};

pub(super) fn screen(opts: ScreenOptions, ctx: &Ctx) -> Result<()> {
    let stop = ctx.stop.clone();
    let to_player = opts
        .share
        .to
        .iter()
        .any(|t| t.eq_ignore_ascii_case(crate::opts::BROWSER_TARGET));
    if to_player && !opts.share.no_audio {
        // The player tab on this computer plays the captured sound, which
        // the capture picks up again.
        warn!("screen: the browser tab plays the shared sound again (an echo): mute it, or use --no-audio");
    }
    let bin = match opts.engine {
        Some(ScreenEngine::Ffmpeg) => None,
        Some(ScreenEngine::Browser) => Some(chromium(opts.browser.as_deref())?),
        None => match chromium(opts.browser.as_deref()) {
            Ok(b) => Some(b),
            Err(e) if opts.target == ScreenTarget::Pick || opts.browser.is_some() => return Err(e),
            Err(e) => {
                warn!("{e}; capturing with ffmpeg instead (see 'tvpipe screen --help')");
                None
            }
        },
    };
    let Some(bin) = bin else {
        return screen_ffmpeg(opts, ctx);
    };
    debug!("browser: using {}", bin.display());
    launch::sweep_stale_profiles();
    let target = opts.target.clone();
    let events = ctx.events.clone();
    let launcher = move |server: &ShareServer| -> Result<Box<dyn Any>> {
        events.progress(Progress::Begin(Step::Browser));
        let b = ScreenBrowser::start(
            BrowserScreen {
                bin: bin.clone(),
                target: target.clone(),
            },
            server,
            stop.clone(),
        )
        .inspect_err(|e| events.progress(Progress::Failed(Step::Browser, e.to_string())))?;
        events.progress(Progress::Done(Step::Browser, Some(b.product.clone())));
        Ok(Box::new(b))
    };
    let rejoin = Rejoin::system(opts.share.reconnect, ctx);
    let connect =
        |t: &Target, o: &CastOptions, m: &crate::airplay::MirrorOptions| connect_one(t, o, m, ctx);
    share_rejoin(
        opts.share,
        &connect,
        ctx,
        &launcher,
        Some(&rejoin),
        ShareKind::Screen,
        // The page is tvpipe's own: nothing comes over a tunnel.
        &|_, _| false,
    )
}

/// The Chromium-based browser to capture with: Firefox cannot be told
/// which screen or window to share (its picker has no switches).
fn chromium(explicit: Option<&std::path::Path>) -> Result<std::path::PathBuf> {
    let bin = launch::find_browser(explicit)?;
    if launch::Engine::of(&bin) == launch::Engine::Firefox {
        return Err(Error::unsupported(format!(
            "{}: tvpipe screen needs a Chromium-based browser (Chrome, Edge, Chromium or \
             Brave); Firefox cannot be told which screen or window to share",
            bin.display()
        )));
    }
    Ok(bin)
}

/// `screen` with the connector, the stop request and the source given
/// (the tests feed a fake page).
#[cfg(test)]
pub(super) fn screen_with(
    opts: ShareOptions,
    connect: Connector<'_>,
    ctx: &Ctx,
    source: ShareSource<'_>,
) -> Result<()> {
    share_rejoin(
        opts,
        connect,
        ctx,
        source,
        None,
        ShareKind::Screen,
        &|_, _| false,
    )
}

/// Without ffmpeg there is only the browser engine.
#[cfg(not(feature = "ffmpeg"))]
fn screen_ffmpeg(_opts: ScreenOptions, _ctx: &Ctx) -> Result<()> {
    Err(Error::feature("ffmpeg", "screen capture without a browser"))
}

/// The ffmpeg engine: `play` with this OS's capture arguments.
#[cfg(feature = "ffmpeg")]
fn screen_ffmpeg(opts: ScreenOptions, ctx: &Ctx) -> Result<()> {
    let fps = opts.share.fps.unwrap_or(SHARE_FPS);
    let var = |k: &str| std::env::var(k).ok();
    let run = |prog: &str, args: &[&str]| -> Option<String> {
        let out = StdCommand::new(prog)
            .args(args)
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output()
            .ok()?;
        out.status
            .success()
            .then(|| String::from_utf8_lossy(&out.stdout).into_owned())
    };
    let env = screencap::Env {
        os: std::env::consts::OS,
        var: &var,
        run: &run,
    };
    let fps_int = fps.as_f64().round().clamp(1.0, 120.0) as u32;
    let input = screencap::ffmpeg_input(&env, &opts.target, fps_int, !opts.share.no_audio)?;
    for n in &input.notes {
        warn!("screen: {n}");
    }
    info!("screen: ffmpeg {}", input.args.join(" "));
    let s = opts.share;
    play(
        PlayOptions {
            to: s.to,
            reconnect: s.reconnect,
            browser: BrowserOptions {
                open: s.open,
                ..s.player
            },
            latency_ms: s.latency_ms,
            size: Some(s.size.unwrap_or(FFMPEG_SIZE)),
            fps: Some(fps),
            bitrate_kbps: s.bitrate_kbps,
            encoder: opts.encoder,
            no_audio: s.no_audio || !input.audio,
            looped: false,
            realtime: Some(false),
            raw_video: None,
            raw_audio: None,
            ffmpeg: opts.ffmpeg,
            input: InputSpec::FfmpegArgs(input.args.into_iter().map(OsString::from).collect()),
            threads: 0,
        },
        ctx,
    )
}
