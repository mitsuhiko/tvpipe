# Cross-platform status

What has been checked on which OS, and how to repeat it from a Mac.
Last updated 2026-11-18 (first runs on Windows).

## User-facing notes

- ffmpeg 6 or newer (tested with 6.1, 7.1 and 8.1). It is optional; see
  [Inputs](../ARCHITECTURE.md#inputs) for when it is used and
  [Installation](https://tvpipe.party/manual/install/) for installing it.
- Windows: AirPlay receivers send timing requests to UDP ports tvpipe
  opens, so Windows Firewall may ask to allow tvpipe the first time; allow
  it on private networks.
- Windows: pipe SLRW game input from `cmd.exe`, a program that spawns
  tvpipe, or PowerShell 7.4+. Windows PowerShell 5.1 re-encodes binary
  pipes between programs (also in [Game input](https://tvpipe.party/manual/games/)).
- `scripts/cross-check.sh` runs clippy for the Windows targets and builds
  a Windows `.exe` from macOS or Linux with zig as the C toolchain.

## Matrix

| Target | fmt | clippy -D warnings | tests | binary run |
|---|---|---|---|---|
| macOS aarch64 | yes | yes | yes (ffmpeg 8.1) | yes (discover, check-pipeline) |
| Linux aarch64 (Docker, Debian 13) | yes | yes (clippy 1.100) | yes: ffmpeg 7.1, ffmpeg 8.1, no ffmpeg | `discover` against avahi on a Docker bridge; `scripts/check-pipeline.sh` |
| Linux aarch64 (Docker, Ubuntu 24.04) | — | yes | yes (ffmpeg 6.1, the CI runner's) | — |
| Linux x86_64 (Docker, emulated) | yes | yes | yes, except `rawin::ffmpeg_end_to_end` under emulation (emulated ffmpeg starts slowly: 24 of ≥25 frames) | — |
| Windows 11 ARM64, aarch64 msvc (Parallels VM, native) | — | yes (clippy 1.100) | yes, all 427 (ffmpeg 8.1 winarm64) | yes, see "Windows 11 ARM64" below |
| Windows 11 ARM64, x86_64 msvc (emulated) | — | yes (cross) | yes, all 427 (native ARM64 ffmpeg) | `discover`, `debug pipeline` |
| Windows x86_64 gnu | — | yes (cross) | built, not run | `tvpipe.exe` links (UCRT, system DLLs only), not run |
| MSRV 1.85 | — | `cargo check --all-targets` | — | — |

No real x86_64 Windows machine yet; x86_64 ran under the ARM64 VM's
emulation only.

## Windows 11 ARM64 (verified 2026-11-18)

Parallels VM "Windows 11", build 26200, 4 vCPUs, network mode *shared*
(NAT, 10.211.55.3; the Mac is 10.211.55.2 on `bridge100`).

| Item | Result |
|---|---|
| `cargo build`, `clippy --all-targets -D warnings`, `cargo test` | pass (427; ~15 s) |
| `tvpipe --help`, `--version` | ok |
| `tvpipe discover` | finds the LAN's AirPlay and Cast receivers through the NAT (Parallels forwards mDNS); TCP to a Cast TV on the LAN connects |
| `debug pipeline FILE` / `-- -f lavfi ...` | ok (H.264 + PCM + Opus) |
| `debug pattern --to cast:10.211.55.2:8011` (openscreen `cast_receiver` on the Mac's `bridge100`) | streams; receiver plays the frames; wallclock overlay renders (ffmpeg prints a harmless Fontconfig warning) |
| Ctrl-C (`CTRL_C_EVENT`) | handler runs, STOP sent, exit 130, ~0.3 s |
| Ctrl-Break | same, exit 130 |
| `q` + Enter on the console (no `stty`: line mode) | clean stop, exit 0 |
| SLRW raw RGBA via a `cmd` pipe and via `< file` | ok (binary-safe) |
| SLRW encoded with `slrw-gen --exec` (keyframe back channel on stdout) | ok, keyframe request reaches the game |
| SLRW through a Windows PowerShell 5.1 pipe | **corrupted** (PowerShell 5.1 re-encodes native pipes as text: `slrw: unknown record kind 10`); use `cmd`, PowerShell 7.4+, a file, or spawn tvpipe from the game |
| Credentials | `%APPDATA%\tvpipe\credentials.txt` created on first use |

Found and fixed on Windows:

- `shutdown(Both)` from another thread does not wake a blocked `recv`
  (it does on Linux/macOS): AirPlay `stop` waited the 30 s `/feedback`
  timeout on a hung receiver; the event/MediaDataControl readers (no read
  timeout) could hang `close` forever. Fixed with
  `util::thread::join_until` (deadline joins).
- Socket timeouts belong to the handle: `try_clone` copies them, and a
  read timeout set through one handle later does not apply to reads on
  the other. A test page set its WebSocket read timeout through the
  sender's handle and blocked forever (CI's Windows job hung in
  `late_joiners_wait_for_a_keyframe_without_freezing_others`). Timeouts
  are set before `websocket::pair` clones, or on the receiver's stream
  (`Receiver::with_stream`).
- The CDP client joined its reader after a shutdown: a hung browser would
  have hung tvpipe's exit (and the stale-profile sweep). Joined with a
  deadline now.
- Timed waits end on the 15.6 ms system tick (in the VM a 1 ms condvar
  or socket timeout took ~25 ms, up to ~75 ms): Cast pacing went bursty
  and two session tests flaked. Fixed with `util::timer` (see
  `ARCHITECTURE.md`, "Platform-Specific Code", and
  [`measurements.md`](measurements.md#windows-timer-resolution)).

Open:

- One `STATUS_ACCESS_VIOLATION` of the test binary (`--nocapture`, fault
  at address 0x150, module unknown) in ~30 full runs; not reproduced in
  the next 26. If it recurs, enable WER LocalDumps and get a dump.
- The suite has load-sensitive timing tests: a VM hiccup (a push 440 ms
  late) failed `source_stall_keeps_audio_mapping` and
  `encoded_slrw_to_cast_without_ffmpeg` once in 20 runs.
- Parallels pauses the VM when idle ("Pause idle: on"); `prlctl exec`
  then fails or hangs until `prlctl resume`.

Software in the VM: Visual Studio 2022 Community with MSVC 14.44
(ARM64 and x64 libraries) and rustup were already there; added LLVM
23.1.6 (`LLVM-23.1.6-woa64.msi`, `C:\Program Files\LLVM`: ring needs
clang for aarch64-pc-windows-msvc), ffmpeg 8.1 (BtbN
`ffmpeg-n8.1-latest-winarm64-gpl-8.1.zip`, unpacked to `C:\tvp\ffmpeg`),
and updated stable Rust 1.99.1 -> 1.100.0.

## `tvpipe screen` (verified 2026-11-19)

Details and sources in [`screen.md`](screen.md).

| | Browser engine | `--engine ffmpeg` |
|---|---|---|
| macOS 26.6, Chrome 157 | screen 29.8 fps + system sound; `--window` + its app's sound; the browser started with `open` (else the sound is silent) | avfoundation, no sound |
| Windows 11 ARM64 VM, Edge 157 | screen + system sound; `--window` + its app's sound; Ctrl-C through `console-event.ps1` quits Edge | ddagrab (works in the VM), no sound |
| Linux, Docker (Xvfb, openbox, PulseAudio null sink, Chromium 156) | screen and `--window` with the system sound (PulseAudio monitor); Chromium needed `--no-sandbox` in the container (a `--browser` wrapper) | x11grab + `@DEFAULT_MONITOR@`, also `--window` |
| Linux Wayland | untested (the portal dialog picks) | refused |

In the VM: build into a directory of its own (`TVPIPE_VM=C:\tvp-screen`)
when another worktree uses `C:\tvp`; `console-event.ps1 -Exe ... -Log ...`
runs it.

## Repeating it

Windows (from macOS or Linux, needs zig and the rustup targets):

```sh
scripts/cross-check.sh            # clippy for both msvc targets, gnu .exe
```

Windows in the Parallels VM (shared folder `Y:` = the Mac's home):

```sh
vm='Y:\Development\streamlib-windows\scripts\windows'
prlctl exec "Windows 11" --current-user cmd /c "$vm\vm.cmd cargo test"
prlctl exec "Windows 11" --current-user cmd /c \
  "$vm\vm.cmd cargo test --target x86_64-pc-windows-msvc"
```

`vm.cmd` mirrors the worktree to `C:\tvp\src` and builds into
`C:\tvp\target` (the shared folder is slow). `prlctl exec` runs without
a console; `scripts/windows/console-event.ps1` starts tvpipe in a console
of its own and sends it Ctrl-C, Ctrl-Break or `q` + Enter. A local Cast
receiver for the VM: `cast_receiver -x -r 8011 ... bridge100` on the Mac
(see `scripts/receivers/cast-receiver.sh`), then
`tvpipe debug pattern --to cast:10.211.55.2:8011` in the VM.

Linux in Docker (a `rust` image plus `apt-get install ffmpeg`):

```sh
docker run --rm -v "$PWD":/src:ro -e CARGO_TARGET_DIR=/target -w /work IMAGE \
  sh -c 'cp -r /src/. /work && cargo fmt --check &&
         cargo clippy --all-targets -- -D warnings && cargo test'
```

Use `--platform linux/amd64` for x86_64 (emulated, slow). The Docker
Desktop VM's network is NATed, so `tvpipe discover` with `--network host`
finds nothing on the LAN. To check mDNS on Linux, run `avahi-daemon` with a
static `_googlecast._tcp` service in one container and `tvpipe discover`
in another on the same user-defined bridge network.

## Platform differences handled in the code

- Ctrl-C: `crates/tvpipe/src/signals.rs` (the `signals` feature; the CLI's
  `q` is `crates/tvpipe-cli/src/interrupt.rs`).
- Single keys (`q`, the playback arrows): `crates/tvpipe-cli/src/tty/`
  runs `stty -icanon -echo` on Unix (restored at the end) and sets the
  console mode on Windows consoles (`tty/windows.rs`: line input and echo
  off, virtual terminal input on; also ANSI output and the width). Not
  yet checked on a Windows machine: the table above is from before, when
  Windows consoles stayed in line mode (`q` + Enter).
- Timer resolution: `crates/tvpipe/src/util/timer.rs`, Windows only.
- Config directory: `crates/tvpipe/src/storage.rs` (`%APPDATA%\tvpipe`).
- `ffmpeg.exe`/`ffprobe.exe`: `std::env::consts::EXE_SUFFIX` in
  `media::ffmpeg::find_in_path`.
- Windows UDP reads fail with `ConnectionReset` after an ICMP port
  unreachable; every UDP receive loop treats that as transient.
- `ConnectionReset`/`ConnectionAborted` (Windows closes) map to
  `ErrorKind::Closed` like EOF.
- Line ends: `.gitattributes` checks out LF everywhere; credentials files
  and vector files parse with CRLF too.
- Binary stdio: Rust does no newline translation; on Windows a console
  stdout rejects non-UTF-8 writes, but the SLRW back channel is only text
  (`keyframe\n`) and SLRW input is always a pipe. Windows PowerShell 5.1
  pipes are text and corrupt SLRW (see above).
- A blocked socket read is not woken by `shutdown` from another thread
  on Windows: threads that may block on a silent peer are joined with a
  deadline (`util::thread::join_until`).
- Socket timeouts are per handle on Windows (copied by `try_clone`): set
  them before cloning, or on the handle that reads.
- Windows serializes synchronous I/O on a file object: while a thread
  blocks in `ReadFile` on a pipe, other calls on that handle wait for it,
  including `is_terminal` (it asks the pipe for its name to spot MSYS
  terminals). With `--machine` the stdin router reads stdin from the
  start, so nothing else may touch stdin then; `interrupt::watch_stdin`
  checked `is_terminal` first and hung the session at start on Windows
  runners until the parent wrote again.
- A refused loopback `connect` takes about 2 s on Windows (it retries
  the SYN), not a few microseconds: tests that count retries in a short
  window fail the connects themselves.

## macOS: tvpipe's browser and the user's browser

A known limitation, documented for users in the manual's
[A web page on the TV](../site/manual/07-web-page.md) chapter (Limitations).
Investigated 2026-11-19 with Chrome 157 on macOS 26.

- Every process started from a browser's app bundle checks in with
  LaunchServices as that app: headless ones as `BackgroundOnly`, windowed
  ones as `Foreground` (`lsappinfo list`), whatever `--user-data-dir`.
- LaunchServices sends app opens (Dock, Spotlight, `open -a`/`-b`) and
  URLs from other apps to the oldest running instance of the app. It
  matches instances by the main executable's file, not the bundle path.
  A headless instance is activated too (it becomes `Foreground` and gets
  focus, and the URL lands in an invisible tab). Starting tvpipe's browser
  with `open -n` does not change this.
- So the user's browser is affected only while tvpipe's instance is older:
  the user's was not running when tvpipe started, or was quit since.

Rejected workarounds (do not retry without new information):

- Blocking the check-in: Chrome aborts without LaunchServices, also
  headless (`sandbox-exec` denying `com.apple.coreservices.launchservicesd`,
  exit 134). `sandbox-exec` also breaks Chrome's own helper sandbox.
  argv[0], `CFProcessPath`, symlinked or hardlinked bundles do not help or
  do not start.
- chrome-headless-shell: it checks in without a bundle id (harmless), but
  cannot capture its tab (no `--auto-accept-this-tab-capture`, no tab
  audio even with the fake-media switches), and ignores `--app`.
- An APFS clone of the user's browser (`cp -c -R`): separate for
  LaunchServices with Google's signature intact, but the clone registers
  itself with GoogleUpdater as the Chrome install (`ecp`) and writes
  `LastRunAppBundlePath`, also headless. `--disable-updater-scheduler`
  stops the former (undocumented); the latter needs writing back. The
  clone also shows up as a second https handler. Too brittle.
- A wrapper bundle with its own bundle id: only a clone with an edited
  Info.plist, re-signed ad hoc, runs (losing Google's entitlements,
  hardened runtime and library validation; a new TCC identity for
  `tvpipe screen` on every Chrome update).
- Chrome for Testing (`com.google.chrome.for.testing`) avoids the problem
  and passes all browser tests (visible windows need `--disable-infobars`),
  but few users have it installed; downloading it was not wanted.
- The user's running Chrome cannot be driven: it has no DevTools port
  (Chrome 136+ ignores `--remote-debugging-port` on the default profile),
  and tvpipe's switches only apply at startup.

## Unverified on Windows

- Multicast egress: mDNS queries go out from a socket bound to the
  default-route address (`net::iface`). Linux and macOS pick the
  interface from the bound source address; Windows may use its default
  multicast interface instead (only matters with several interfaces or
  extra `--interface` addresses). std has no `IP_MULTICAST_IF`.
- Firewall: unicast mDNS replies to a multicast query are allowed by the
  default Windows Firewall rules (3 s window); inbound AirPlay timing
  requests may need the user to allow tvpipe once.
- AirPlay against a real receiver from Windows (only the fake in the
  tests), and the firewall prompt for inbound timing requests.
- A real Cast TV from Windows (reachable from the VM, not streamed to).
- Native x86_64 Windows hardware.
