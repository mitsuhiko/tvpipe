//! `tvpipe share URL`: the share
//! pipeline with tvpipe's own browser as the page.
//!
//! 1. Resolve and connect the receivers first. With a resolution
//!    (`--resolution`, the CLI's default `auto`): the page's CSS layout
//!    is `--size` (else the receivers' screen shape within 1920x1080) and
//!    it renders at the device scale factor that fills the resolution's
//!    box, as far as the receivers' limits allow ([`render_scale`],
//!    docs/playshare-design.md §9.1). Without one (the SDK's default):
//!    the stream's size is the receivers' screen shape at most 1920x1080
//!    (or `--size`), within their limits, and the page is that at scale
//!    1 (the share's sizing, `docs/share-protocol.md`).
//! 2. Start the browser with its viewport at exactly the layout and the
//!    scale (`browser::headless`), so the tab fills the frame (no bars),
//!    and open URL; the page shares its tab to the [`ShareServer`] in
//!    rejoin mode (navigations, reloads and crashes share again).
//! 3. Stream like `share` (encoded by the browser; PCM for AirPlay and
//!    the player, AAC for Cast) until Ctrl-C / `q`, every receiver is
//!    gone, or the browser gives up; then close the browser and delete
//!    its temporary profile.

use std::any::Any;

use super::*;
use crate::browser::headless::{self, Headless, HeadlessOptions};
use crate::browser::launch::{self, LaunchOptions};
use crate::types::Resolution;

/// The page's size without `--size`, before the receivers' shape.
const BROWSE_SIZE: Size = Size {
    width: 1920,
    height: 1080,
};
const BROWSE_FPS: Ratio = Ratio::integer(30);

/// Starts the page source for a viewport (CSS pixels) at a device scale
/// factor; the guard stops it when dropped (the tests start fake pages
/// instead of a browser).
type Launcher<'a> = &'a dyn Fn(&ShareServer, (u32, u32), f64) -> Result<Box<dyn Any>>;

/// The scales are rounded down to 1/this (a short command line, never a
/// capture larger than the plan).
const SCALE_STEPS: f64 = 10_000.0;

/// The output size a `layout` (CSS pixels) asks for at `resolution`: the
/// largest of its shape inside the resolution's box (smaller layouts
/// scale up, larger ones down). Even sides.
pub(super) fn requested_size(layout: (u32, u32), resolution: Resolution) -> Size {
    let (bw, bh) = resolution.bounds();
    let s = box_scale(layout, (bw, bh));
    let even = |v: f64| ((v.round() as u32).max(2)) & !1;
    Size {
        width: even(layout.0.max(1) as f64 * s).min(bw),
        height: even(layout.1.max(1) as f64 * s).min(bh),
    }
}

/// The scale at which `layout` fits `frame` (at its own shape), rounded
/// down to 1/[`SCALE_STEPS`].
fn box_scale(layout: (u32, u32), frame: (u32, u32)) -> f64 {
    let (lw, lh) = (layout.0.max(1) as f64, layout.1.max(1) as f64);
    let s = (frame.0.max(1) as f64 / lw).min(frame.1.max(1) as f64 / lh);
    (s * SCALE_STEPS + 1e-6).floor().max(1.0) / SCALE_STEPS
}

/// The device scale factor the page renders at: its `layout` fills the
/// planned frame (`planned`, the receivers' shape and limits), clamped to
/// what tvpipe's browser renders.
pub(super) fn render_scale(layout: (u32, u32), planned: (u32, u32)) -> f64 {
    launch::valid_scale(box_scale(layout, planned))
}

/// `share URL`.
pub(super) fn browse(opts: ShareOptions, ctx: &Ctx) -> Result<()> {
    let stop = ctx.stop.clone();
    let page = opts
        .page
        .clone()
        .ok_or_else(|| Error::usage("share: no URL"))?;
    let url = headless::page_url(&page.url)?;
    headless::check_url(&url)?;
    // Problems with the browser before any receiver is bothered.
    let bin = launch::find_browser(page.browser.as_deref())?;
    debug!("browser: using {}", bin.display());
    // Profiles (and browsers) a killed tvpipe left behind.
    launch::sweep_stale_profiles();
    let o = page;
    let events = ctx.events.clone();
    let launcher =
        move |server: &ShareServer, viewport: (u32, u32), scale: f64| -> Result<Box<dyn Any>> {
            events.progress(Progress::Begin(Step::Browser));
            let h = Headless::start(
                HeadlessOptions {
                    url: url.clone(),
                    launch: LaunchOptions {
                        bin: bin.clone(),
                        viewport,
                        scale,
                        visible: o.visible,
                        app: None,
                        screen: None,
                    },
                    profile: o.profile.clone(),
                    reload: o.reload,
                    control: o.control.clone(),
                },
                server.handle(),
                stop.clone(),
            )
            .inspect_err(|e| events.progress(Progress::Failed(Step::Browser, e.to_string())))?;
            events.progress(Progress::Done(Step::Browser, Some(h.product.clone())));
            Ok(Box::new(h))
        };
    let rejoin = Rejoin::system(opts.reconnect, ctx);
    let connect =
        |t: &Target, o: &CastOptions, m: &crate::airplay::MirrorOptions| connect_one(t, o, m, ctx);
    browse_rejoin(&opts, &connect, ctx, &launcher, Some(&rejoin))
}

/// `share URL` with the connector, stop request and page source given.
pub(super) fn browse_with(
    opts: &ShareOptions,
    connect: Connector<'_>,
    ctx: &Ctx,
    launch: Launcher<'_>,
) -> Result<()> {
    browse_rejoin(opts, connect, ctx, launch, None)
}

/// `browse_with` with the reconnect hooks.
fn browse_rejoin(
    opts: &ShareOptions,
    connect: Connector<'_>,
    ctx: &Ctx,
    launch: Launcher<'_>,
    rejoin: Option<&Rejoin>,
) -> Result<()> {
    crate::util::timer::raise_resolution();
    let stop = &ctx.stop;
    let mut server = ShareServer::bind(0)?;
    server.set_rejoin(true);
    let fail = |server: &mut ShareServer, e: Error| {
        server.set_end_reason(&e.to_string());
        e
    };
    let mut targets =
        resolve_all(&opts.to, rejoin, &ctx.events).map_err(|e| fail(&mut server, e))?;
    let names: Vec<String> = targets.iter().map(|t| target_name(t).to_owned()).collect();
    let pcm =
        RawAudioSpec::session_pcm(targets.iter().any(|t| matches!(t, Target::AirPlay { .. })));
    let audio = !opts.no_audio;
    let fps = opts.fps.unwrap_or(BROWSE_FPS);
    server.configure(&PageConfig {
        fps: fps.as_f64(),
        audio,
        sample_rate: pcm.sample_rate,
        channels: pcm.channels,
        receivers: names,
    });
    // A resolution: the page's layout (--size, else decided by the
    // receivers' shape below) at a scale.
    let resolution = opts.page.as_ref().and_then(|p| p.resolution);
    // The offer: --size/--fps/--bitrate or 1920x1080@30 (with a
    // resolution: its box; the frame has the receivers' shape, the page
    // fits inside); the ANSWERs and AirPlay's canvas narrow it.
    let offered = match resolution {
        Some(r) => {
            let (width, height) = r.bounds();
            Size { width, height }
        }
        None => opts.size.unwrap_or(BROWSE_SIZE),
    };
    let offer = ShareOffer::new(&ShareOptions {
        size: Some(offered),
        fps: Some(fps),
        ..opts.clone()
    });
    let budget = shared_budget(opts.latency_ms, &targets, audio);
    let d = Desired {
        size: offer.size,
        fps,
        bitrate_kbps: offer.bitrate_kbps,
        latency_ms: budget.session_ms,
    };
    let mut cast_opts = share_cast_options(&d, &offer, audio, &pcm);
    cast_opts.latency_ms = budget.cast_ms;
    configure_browsers(
        &mut targets,
        &player_options(opts),
        budget.browser_ms,
        audio,
        &ctx.storage,
    );
    let mirror = crate::airplay::MirrorOptions {
        latency_ms: budget.airplay_ms,
        audio,
        // An explicit 1080p or 4K may go past an Apple TV's nominal
        // screen, up to its decoder (docs/airplay-mirroring.md §2.6).
        decoder_max: resolution.is_some_and(Resolution::explicit),
        ..Default::default()
    };
    let sinks = connect_all(&targets, connect, &cast_opts, &mirror, rejoin, &ctx.events)
        .map_err(|e| fail(&mut server, e))?;
    if stop.requested() {
        stop_all(sinks);
        return Ok(());
    }
    let caps: Vec<&Capabilities> = sinks.iter().map(|s| s.capabilities()).collect();
    let named: Vec<(&str, &Capabilities)> =
        sinks.iter().map(|s| (s.name(), s.capabilities())).collect();
    let limits = receiver_limits(&caps);
    // Only browser players: the page keeps BROWSE_SIZE's (or --size's)
    // shape.
    let (screen, max) = screen_shape(&caps);
    let aspect = screen.unwrap_or_else(|| {
        let s = opts.size.unwrap_or(BROWSE_SIZE);
        crate::types::aspect_of(s.width, s.height).unwrap_or(layout::DEFAULT_ASPECT)
    });
    // With a resolution: the layout is fixed (the receivers' shape
    // within 1920x1080 unless --size), the frame holds it at the
    // resolution, shrunk to the receivers' limits.
    let page_layout = resolution.map(|r| {
        let l = opts.size.map_or_else(
            || {
                let b = (BROWSE_SIZE.width, BROWSE_SIZE.height);
                layout::output_size(b, aspect, b)
            },
            |s| (s.width, s.height),
        );
        (l, r)
    });
    let d = Desired {
        size: match (page_layout, opts.size) {
            (Some((l, r)), _) => {
                let want = requested_size(l, r);
                let (width, height) = layout::output_size((want.width, want.height), aspect, max);
                Size { width, height }
            }
            (None, Some(s)) => s,
            (None, None) => {
                let (width, height) =
                    layout::output_size((BROWSE_SIZE.width, BROWSE_SIZE.height), aspect, max);
                Size { width, height }
            }
        },
        ..d
    };
    let planned = share_plan(&d, &caps, opts.bitrate_kbps.is_some());
    let (families, warnings) = if audio {
        input::encoded_audio_families(Some(&pcm), &named)
    } else {
        (Vec::new(), Vec::new())
    };
    drop((caps, named));
    let plan = match planned {
        Ok(p) => p,
        Err(e) => {
            stop_all(sinks);
            return Err(fail(&mut server, e));
        }
    };
    for w in warnings {
        warn!("{w}");
    }
    let planned_size = (plan.video.width, plan.video.height);
    let (viewport, scale) = match page_layout {
        Some((l, _)) => (l, render_scale(l, planned_size)),
        None => (planned_size, 1.0),
    };
    match page_layout {
        Some((_, r)) => {
            let (pw, ph) = launch::device_pixels(viewport, scale);
            info!(
                "browser: receivers allow {limits}, {}; the page is {}x{} CSS at {scale}x \
                 ({pw}x{ph}, resolution {}) in a {}x{} picture",
                screen_label(screen),
                viewport.0,
                viewport.1,
                r.as_str(),
                planned_size.0,
                planned_size.1
            );
        }
        None => info!(
            "browser: receivers allow {limits}, {}; the page is {}x{}",
            screen_label(screen),
            viewport.0,
            viewport.1
        ),
    }
    let t0 = Instant::now();
    let source = match launch(&server, viewport, scale) {
        Ok(s) => s,
        Err(e) => {
            stop_all(sinks);
            return Err(fail(&mut server, e));
        }
    };
    let Some(cap) = server.wait_capture(stop) else {
        stop_all(sinks);
        drop(source);
        return match server.failure() {
            Some(e) => Err(e),
            None => Ok(()),
        };
    };
    capture_event(&cap, &ctx.events);
    debug!(
        "browser: the page shares {} ms after the start",
        t0.elapsed().as_millis()
    );
    let page_audio = (!families.is_empty() && cap.audio).then_some((pcm.sample_rate, pcm.channels));
    if !families.is_empty() && !cap.audio {
        warn!("browser: the tab's capture has no sound");
    }
    let content = layout::place(
        (cap.width, cap.height),
        (plan.video.width, plan.video.height),
    );
    // Usually smaller at first: Chrome's "sharing this tab" bar takes
    // room until the browser keeper resizes the window, and the page then
    // fills the frame again.
    let expected = launch::device_pixels(viewport, scale);
    if (cap.width, cap.height) != expected {
        debug!(
            "browser: the tab is {}x{}, not {}x{}; it fills {}x{} at +{}+{}",
            cap.width,
            cap.height,
            expected.0,
            expected.1,
            content.width,
            content.height,
            content.x,
            content.y
        );
    }
    info!(
        "plan: {}x{}@{} {} kbit/s, keyframe every {} frames, {}, latency {} ms (encoded by the browser)",
        plan.video.width,
        plan.video.height,
        plan.video.fps,
        plan.video.bitrate_kbps,
        plan.video.gop,
        match page_audio {
            Some((rate, ch)) => format!("PCM {rate} Hz {ch} ch"),
            None => "no audio".into(),
        },
        plan.latency_ms
    );
    let share_plan = SharePlan {
        width: plan.video.width,
        height: plan.video.height,
        fps: plan.video.fps.as_f64(),
        bitrate_bps: plan.video.bitrate_kbps as u64 * 1000,
        key_interval: plan.video.gop,
        audio: page_audio,
        content,
    };
    let opened = server.start(
        &share_plan,
        ShareInputOptions {
            fps: plan.video.fps,
            audio: page_audio.map(|_| pcm.clone()),
            audio_families: if page_audio.is_some() {
                families
            } else {
                Vec::new()
            },
        },
        stop.clone(),
    );
    let input = match opened {
        Ok(i) => i,
        Err(e) => {
            stop_all(sinks);
            drop(source);
            if stop.requested() {
                info!("stopped");
                return Ok(());
            }
            return Err(e);
        }
    };
    let r = stream(
        Box::new(input),
        events::Route::Browser,
        plan.latency_ms,
        sinks,
        None,
        ctx,
    );
    drop(source);
    match r {
        Ok(EndReason::Interrupted) => {
            info!("stopped");
            Ok(())
        }
        Ok(_) => Ok(()),
        Err(e) => Err(e),
    }
}
