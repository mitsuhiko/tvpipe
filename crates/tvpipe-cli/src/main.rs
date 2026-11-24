//! tvpipe: low-latency mirroring to AirPlay and Google Cast receivers.
//!
//! The command-line tool: argument parsing, Ctrl-C and `q`, and the
//! machine interface, on top of the library.

#[macro_use]
extern crate tvpipe;

mod cli;
mod interrupt;
mod machine;
mod tty;
mod ui;

use tvpipe::__cli::{error, events};
use tvpipe::log;

use std::process::ExitCode;

use tvpipe::__cli::opts::{Command, InputSpec, Provider, QrFormat};
use tvpipe::{Device, Storage};

fn main() -> ExitCode {
    let (global, mut command) = cli::parse_env();
    // `play` of a file or URL seeks and pauses: the keys, the machine
    // interface's commands.
    if let Command::Play(o) = &mut command {
        if matches!(o.input, InputSpec::Path(_)) {
            let control = tvpipe::__cli::PlaybackControl::new();
            o.playback = Some(control.clone());
            interrupt::set_playback(control.clone());
            machine::set_playback(control);
        }
    }
    let mode = match ui::Mode::pick(
        global.machine,
        global.verbose,
        global.debug,
        std::env::var("TVPIPE_LOG").ok().as_deref(),
    ) {
        // A tool for developers: its log is part of its report.
        ui::Mode::People if matches!(command, Command::DebugPipeline(_)) => {
            ui::Mode::Developer(log::Level::Info)
        }
        m => m,
    };
    // The CLI shares one config directory with every run (and with
    // programs that use Storage::cli()).
    let mut ctx = tvpipe::__cli::Ctx::new();
    ctx.storage = Storage::cli();
    // Ctrl-C and `q` stop sessions (not discover/pair, which end by
    // themselves; pair reads its PIN from stdin).
    let (session, reads_stdin) = match &command {
        Command::Play(o) | Command::TestPattern(o) => (true, o.input == InputSpec::Stdin),
        Command::Share(_) | Command::Screen(_) | Command::Tunnel { .. } | Command::Playshare(_) => {
            (true, false)
        }
        _ => (false, false),
    };
    // `q` on the terminal: a single key where stty can switch it to that
    // (restored when `_tty` drops at the end of main, and on panics and a
    // second Ctrl-C), else `q` + Enter. With --machine, stdin belongs to
    // the machine interface's router; with `-` it is ffmpeg's input.
    let watch = session && !reads_stdin && !global.machine && interrupt::stdin_is_terminal();
    let _tty = tty::Guard;
    let keys = watch && tty::enter();
    match mode {
        ui::Mode::Machine => {
            let level = if global.debug {
                log::Level::Trace
            } else if global.verbose {
                log::Level::Debug
            } else {
                log::Level::Info
            };
            // Only fails when installed twice, which main does not.
            let _ = log::set_logger(level, |r| machine::emit(&events::Event::Log(r.clone())));
            ctx.events = machine::events();
            machine::hello(command.name());
            machine::start_router(ctx.stop.clone());
        }
        ui::Mode::Developer(level) => {
            let start = std::time::Instant::now();
            let _ = log::set_logger(level, move |r| {
                use std::io::Write;
                let t = start.elapsed();
                let _ = writeln!(
                    std::io::stderr().lock(),
                    "{:>4}.{:03} {} {}: {}",
                    t.as_secs(),
                    t.subsec_millis(),
                    r.level.label(),
                    r.module,
                    r.message
                );
            });
            // The public links as QR codes too, after the log line naming
            // them (`--no-qr`, `TVPIPE_NO_QR`).
            if session && tvpipe::__cli::qr::wanted(global.no_qr) {
                ctx.events = events::Events::to(|e| match e {
                    events::Event::Tunnel(t) => tvpipe::__cli::qr::print(&t.url),
                    events::Event::Progress(events::Progress::GameLink { url, .. }) => {
                        tvpipe::__cli::qr::print(&url)
                    }
                    _ => {}
                });
            }
        }
        ui::Mode::People => {
            let hint = match (session, watch, keys) {
                (false, _, _) => ui::term::StopHint::None,
                (true, true, true) => ui::term::StopHint::Key,
                (true, true, false) => ui::term::StopHint::Line,
                (true, false, _) => ui::term::StopHint::CtrlC,
            };
            ctx.events = ui::install(&command, global.no_qr, hint, ctx.stop.clone());
        }
    }
    if session {
        if !interrupt::link(ctx.stop.clone()) {
            warn!("cannot catch Ctrl-C; receivers will not get a clean stop");
        } else if !global.machine {
            // A second Ctrl-C exits at once: without the status line, with
            // the terminal as it was.
            tvpipe::signals::before_forced_exit(|| {
                ui::abandon();
                tty::restore();
            });
        }
        if watch {
            interrupt::watch_stdin(ctx.stop.clone());
        }
    }
    let stop = ctx.stop.clone();
    let rv = run(command, ctx, &global);
    // A stream the machine interface refused is the command's error.
    let rv = match (rv, machine::failure()) {
        (_, Some(e)) => Err(e),
        // After a stop request (`q`, the machine interface's `stop` or
        // stdin closing) an error is its consequence, e.g. a receiver
        // that was still connecting.
        (Err(e), None) if stop.requested() && !interrupt::signalled() => {
            debug!("after the stop request: {e}");
            Ok(())
        }
        (rv, None) => rv,
    };
    let report = |err: &error::Error| {
        if global.machine {
            machine::emit(&machine::error_event(err));
        } else if !ui::error(&events::ErrorInfo::from(err)) {
            eprintln!("error: {err}");
        }
    };
    // A Ctrl-C/SIGTERM stop exits with 130 like other CLI tools, after the
    // receivers got their clean teardown.
    if interrupt::signalled() {
        match rv {
            Err(err) => report(&err),
            Ok(()) if global.machine => machine::end_if_unsent(events::EndReason::Stopped),
            Ok(()) => ui::finish(true),
        }
        return ExitCode::from(130);
    }
    match rv {
        Ok(()) if !global.machine => {
            ui::finish(stop.requested());
            ExitCode::SUCCESS
        }
        Ok(()) => {
            machine::end_if_unsent(if stop.requested() {
                events::EndReason::Stopped
            } else {
                events::EndReason::Done
            });
            ExitCode::SUCCESS
        }
        Err(err) => {
            report(&err);
            ExitCode::from(1)
        }
    }
}

/// Runs one command: discovery and pairing through the library's
/// functions, everything else as a library session.
fn run(command: Command, ctx: tvpipe::__cli::Ctx, global: &cli::Global) -> error::Result<()> {
    match command {
        Command::Discover {
            timeout,
            json,
            interfaces,
        } => {
            let step = |p: fn(events::Step) -> events::Progress| {
                ctx.events
                    .emit(events::Event::Progress(p(events::Step::Discover)))
            };
            if !json {
                step(events::Progress::Begin);
            }
            let found = tvpipe::__cli::discover(timeout, &interfaces, &ctx.storage);
            if !json {
                step(|s| events::Progress::Done(s, None));
            }
            let devices = found?;
            if global.machine {
                machine::emit(&tvpipe::__cli::devices_event(devices));
                return Ok(());
            }
            print(&if json {
                tvpipe::__cli::devices_json(&devices)
            } else {
                table(&devices)
            })
        }
        Command::Pair { target, pin } => {
            let p = tvpipe::__cli::pair(&target, pin.as_deref(), &ctx, &mut prompt_pin)?;
            if !global.machine && !ui::active() {
                print(&format!(
                    "Paired with {} ({})\n",
                    p.name,
                    p.model.as_deref().unwrap_or("unknown model")
                ))?;
            }
            Ok(())
        }
        Command::Unpair { target } => {
            let options = tvpipe::Options::new().storage(ctx.storage.clone());
            let removed = tvpipe::unpair(&target, &options)?;
            for u in removed {
                if global.machine {
                    machine::emit(&events::Event::Unpaired(u));
                } else if ui::active() {
                    ui::event(&events::Event::Unpaired(u));
                } else {
                    print(&format!("Forgot pairing with {} ({})\n", u.name, u.id))?;
                }
            }
            Ok(())
        }
        Command::Tunnel { port, provider } => tunnel(port, provider, &ctx),
        Command::Playshare(_) if global.machine => Err(error::Error::usage(
            "game play is for people: run it without --machine",
        )),
        Command::Playshare(o) => tvpipe::__cli::playshare::run(&o, &ctx, &ask_in_terminal),
        Command::GameTool(o) if global.machine => Err(error::Error::usage(format!(
            "{} prints a report: run it without --machine",
            o.action.command()
        ))),
        Command::GameTool(o) => tvpipe::__cli::playshare::game_tool(&o, ctx.stop.clone()),
        Command::Qr { .. } if global.machine => Err(error::Error::usage(
            "debug qr writes the code to stdout: run it without --machine",
        )),
        Command::Qr { text, format } => {
            let max = match format {
                QrFormat::Terminal => tvpipe::__cli::qr::TERMINAL_MAX_VERSION,
                _ => tvpipe::__cli::qr::MAX_VERSION,
            };
            let Some(qr) = tvpipe::__cli::qr::encode(text.as_bytes(), max) else {
                return Err(error::Error::usage(format!(
                    "debug qr: {} bytes do not fit a QR code{}",
                    text.len(),
                    if format == QrFormat::Terminal {
                        " for the terminal (try --svg)"
                    } else {
                        ""
                    }
                )));
            };
            print(&match format {
                QrFormat::Terminal => tvpipe::__cli::qr::render_terminal(&text).unwrap_or_default(),
                QrFormat::Svg => qr.to_svg(4),
                QrFormat::Rows => qr.rows().join("\n") + "\n",
            })
        }
        mut command => {
            // `share URL`: the machine interface's `navigate` shows other
            // pages in its tab.
            if let Command::Share(o) = &mut command {
                if let Some(page) = o.page.as_mut().filter(|_| global.machine) {
                    let control = tvpipe::__cli::opts::PageControl::default();
                    page.control = Some(control.clone());
                    machine::set_page(control);
                }
            }
            let io = tvpipe::__cli::GameIo {
                // With --machine, the stdin router hands SLRW over and
                // keyframe requests become events.
                stdin: machine::stdin_reader(),
                stdout: if global.machine {
                    Box::new(machine::KeyframeEvents::new(ctx.events.clone()))
                } else {
                    Box::new(std::io::stdout())
                },
                approve: Box::new(approve_in_terminal),
            };
            tvpipe::__cli::spawn(command, ctx, io, None)?
                .wait()
                .map(|_| ())
        }
    }
}

/// `debug tunnel PORT`: a public link for 127.0.0.1:PORT until a stop request
/// (Ctrl-C, `q`, the machine interface's `stop` or stdin closing).
fn tunnel(port: u16, provider: Provider, ctx: &tvpipe::__cli::Ctx) -> error::Result<()> {
    use std::net::{Ipv4Addr, SocketAddr, TcpStream};
    let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    if TcpStream::connect_timeout(&addr, std::time::Duration::from_millis(500)).is_err() {
        warn!("tunnel: nothing answers on 127.0.0.1:{port} yet; visitors get errors until it does");
    }
    let stop = ctx.stop.clone();
    ctx.events
        .emit(events::Event::Progress(events::Progress::Begin(
            events::Step::Tunnel,
        )));
    let t = tvpipe::__cli::start_tunnel(port, provider, &|| stop.requested())?;
    let url = format!("https://{}/", t.host());
    info!(
        "tunnel: {url} leads to http://127.0.0.1:{port} ({}; the link is new every run)",
        t.name()
    );
    ctx.events
        .emit(tvpipe::__cli::port_tunnel_event(provider, url));
    while !ctx.stop.wait(std::time::Duration::from_secs(3600)) {}
    info!("tunnel: closed");
    drop(t);
    Ok(())
}

/// Writes to stdout; a closed pipe (`| head`) is not an error.
fn print(text: &str) -> error::Result<()> {
    use std::io::Write;
    let mut out = std::io::stdout().lock();
    match out.write_all(text.as_bytes()).and_then(|()| out.flush()) {
        Err(e) if e.kind() == std::io::ErrorKind::BrokenPipe => Ok(()),
        r => r.map_err(|e| error::Error::io("write the output", e)),
    }
}

/// `discover`'s list: the receivers tvpipe streams to (one per line),
/// then the speakers it does not (audio only), by name.
fn table(devices: &[Device]) -> String {
    let video = |d: &Device| {
        d.airplay.as_ref().is_some_and(|a| a.mirroring)
            || d.cast.as_ref().is_some_and(|c| c.video && !c.group)
    };
    let (tvs, speakers): (Vec<&Device>, Vec<&Device>) = devices.iter().partition(|d| video(d));
    let mut out = String::new();
    if tvs.is_empty() {
        out.push_str("No receivers that show video answered on this network.\n");
    } else {
        out.push_str(&format!(
            "Found {} {} you can stream to:\n\n",
            tvs.len(),
            if tvs.len() == 1 {
                "receiver"
            } else {
                "receivers"
            }
        ));
        let rows: Vec<[String; 5]> = tvs
            .iter()
            .map(|d| {
                let cast = d.cast.as_ref().filter(|c| c.video);
                let airplay = d.airplay.as_ref().filter(|a| a.mirroring);
                let kind = match (cast, airplay) {
                    (Some(_), Some(_)) => "Google Cast, AirPlay",
                    (Some(_), None) => "Google Cast",
                    _ => "AirPlay",
                };
                let note = match airplay {
                    Some(a) if home_only(a) && cast.is_none() => "home members only",
                    Some(a) if a.paired == Some(true) => "paired",
                    Some(a) if a.password_pin && cast.is_none() => "needs pairing (password)",
                    Some(a) if a.pin && cast.is_none() => "needs pairing",
                    _ => "",
                };
                [
                    d.name.clone(),
                    kind.to_owned(),
                    d.model.clone().unwrap_or_default(),
                    d.addresses
                        .first()
                        .map(|a| a.to_string())
                        .unwrap_or_default(),
                    note.to_owned(),
                ]
            })
            .collect();
        let mut widths = [0usize; 5];
        for row in &rows {
            for (w, cell) in widths.iter_mut().zip(row) {
                *w = (*w).max(cell.chars().count());
            }
        }
        for row in &rows {
            let mut line = String::from("  ");
            for (i, cell) in row.iter().enumerate() {
                line.push_str(cell);
                if i + 1 < row.len() {
                    let pad = widths[i] - cell.chars().count() + 3;
                    line.extend(std::iter::repeat_n(' ', pad));
                }
            }
            out.push_str(line.trim_end());
            out.push('\n');
        }
    }
    // TVs whose Apple Home takes only its members, and what to change.
    let closed = |d: &Device| d.cast.is_none() && d.airplay.as_ref().is_some_and(home_only);
    let names: Vec<String> = tvs
        .iter()
        .filter(|d| closed(d))
        .map(|d| ui::render::quote(&d.name))
        .collect();
    if !names.is_empty() {
        let (takes, homes, one) = match names.len() {
            1 => ("takes", "its Apple Home", "it"),
            _ => ("take", "their Apple Homes", "one"),
        };
        out.push_str(&format!(
            "\n{} only {takes} AirPlay from members of {homes}. To stream to {one}:\n  {}, \
             then pair: tvpipe pair NAME\n",
            names.join(", "),
            ui::render::home_access(),
        ));
    }
    if !speakers.is_empty() {
        let names: Vec<&str> = speakers.iter().map(|d| d.name.as_str()).collect();
        out.push_str(&format!(
            "\nAlso found {} {} that play audio only (tvpipe streams video):\n  {}\n",
            speakers.len(),
            if speakers.len() == 1 {
                "speaker"
            } else {
                "speakers"
            },
            names.join(", ")
        ));
    }
    match tvs.iter().find(|d| !closed(d)) {
        Some(d) => out.push_str(&format!(
            "\nStream to one: tvpipe play FILE --to {}\n",
            ui::render::quote(&d.name)
        )),
        // Only TVs for their homes' members: what to do is said above.
        None if !tvs.is_empty() => {}
        None => {
            out.push_str("\nCheck that the TV is on and on the same network as this computer.\n")
        }
    }
    out
}

/// Its Apple Home takes only its members and there is no pairing to try.
fn home_only(a: &tvpipe::AirPlayService) -> bool {
    a.home_only && a.paired != Some(true)
}

/// Reads the PIN from stdin after prompting on stderr; with `--machine`,
/// the router's `pin` command answers the `pin-required` event.
fn prompt_pin(req: &events::PinRequest) -> error::Result<String> {
    use std::io::{BufRead, Write};
    if let Some(router) = machine::router() {
        return router.wait_pin();
    }
    // Lines with echo while asking; a password without.
    let _cooked = tty::Cooked::new();
    ui::prompt(&if req.password {
        format!(
            "Enter the AirPlay password of {} (it is not shown as you type):",
            req.name
        )
    } else {
        format!("Enter the PIN shown on {}:", req.name)
    });
    let _ = std::io::stderr().flush();
    let mut line = String::new();
    let (read, hidden) = {
        let no_echo = req.password.then(tty::NoEcho::new);
        let read = std::io::stdin().lock().read_line(&mut line);
        (read, no_echo.is_some_and(|n| n.hidden))
    };
    // Without echo the Enter did not move to a new line either.
    ui::answered(line.is_empty() || hidden);
    read.map_err(|e| error::Error::io("read PIN", e))?;
    // A password as typed but for the line ending (pairing trims a PIN).
    let entered = line.trim_end_matches(['\r', '\n']);
    if entered.trim().is_empty() {
        return Err(error::Error::usage(if req.password {
            "no password entered"
        } else {
            "no PIN entered"
        }));
    }
    Ok(entered.to_owned())
}

/// Asks a yes/no question on the terminal (`y` + Enter); `None` without
/// one (or when `cancel` says so first).
fn ask_in_terminal(question: &str, cancel: &dyn Fn() -> bool) -> Option<bool> {
    interrupt::ask(question, cancel).map(|a| matches!(a.trim(), "y" | "Y" | "yes" | "Yes" | "YES"))
}

/// Asks on the terminal (`y` + Enter) whether a share from over the
/// tunnel may reach the receivers. Without a terminal nothing remote is
/// shown unless `--yes` was given.
fn approve_in_terminal(what: &str, cancel: &dyn Fn() -> bool) -> bool {
    // The developer log has a line for it already.
    let question = if ui::active() {
        format!("{}. Show it on the receivers? [y/N]", what)
    } else {
        "share: show it on the receivers? [y/N]".to_owned()
    };
    match interrupt::ask(&question, cancel) {
        Some(a) => matches!(a.trim(), "y" | "Y" | "yes" | "Yes" | "YES"),
        None => {
            if !cancel() {
                warn!("share: no terminal to ask on; pass --yes to show remote shares unasked");
            }
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tv(name: &str, flags: &str) -> Device {
        Device::from_json(&format!(
            r#"{{"name":"{name}","addresses":["192.0.2.10"],"model":"55UA84006LB","airplay":{{"instance":"{name}","host":"tv.local","port":7000,"address":"192.0.2.10:7000","mirroring":true,{flags}}}}}"#
        ))
        .unwrap()
    }

    /// `discover` says which TVs pair with their password.
    #[test]
    fn discover_notes_password_pairing() {
        let password = tv(
            "Den TV",
            r#""password":true,"password_pin":true,"pin":false,"paired":false"#,
        );
        let pin = tv("Living Room", r#""pin":true,"paired":false"#);
        let paired = tv("Kitchen", r#""password_pin":true,"paired":true"#);
        let text = table(&[password, pin, paired]);
        assert!(
            text.contains("192.0.2.10   needs pairing (password)\n"),
            "{text}"
        );
        assert!(text.contains("192.0.2.10   needs pairing\n"), "{text}");
        assert!(text.contains("192.0.2.10   paired\n"), "{text}");
        // A password without HAP pairing (HTTP Digest) is not one to pair.
        let digest = tv(
            "Old TV",
            r#""password":true,"password_pin":false,"pin":false,"paired":false"#,
        );
        assert!(!table(&[digest]).contains("needs pairing"));
    }

    /// `discover` notes TVs whose Apple Home takes only its members, says
    /// what to change, and suggests another TV to stream to.
    #[test]
    fn discover_notes_home_only() {
        let home = tv("LG TV", r#""pin":true,"home_only":true,"paired":false"#);
        let open = tv("Den TV", r#""pin":true,"home_only":false,"paired":false"#);
        let text = table(&[home.clone(), open]);
        assert!(text.contains("192.0.2.10   home members only\n"), "{text}");
        assert!(
            text.contains("\"LG TV\" only takes AirPlay from members of its Apple Home. To stream to it:\n  In the Home app, "),
            "{text}"
        );
        assert!(text.contains("then pair: tvpipe pair NAME"), "{text}");
        assert!(text.contains("--to \"Den TV\""), "{text}");
        let alone = table(std::slice::from_ref(&home));
        assert!(
            !alone.contains("Stream to one") && !alone.contains("Check that"),
            "{alone}"
        );
        let two = table(&[home, tv("Den TV", r#""home_only":true"#)]);
        assert!(two.contains("\"LG TV\", \"Den TV\" only take AirPlay from members of their Apple Homes. To stream to one:"), "{two}");
        // A pairing from before the setting changed is tried.
        let paired = table(&[tv("LG TV", r#""home_only":true,"paired":true"#)]);
        assert!(
            paired.contains("192.0.2.10   paired\n") && !paired.contains("Apple Home"),
            "{paired}"
        );
        assert!(paired.contains("--to \"LG TV\""), "{paired}");
    }
}
