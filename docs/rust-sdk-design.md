# Rust SDK design (`tvpipe` on crates.io)

Status: implemented (plan steps 1–4 and 6; step 5, the hardware matrix,
is open). Decisions marked **Decided** are listed in §10. Not built yet
from §5.3: `convert_on_caller()` (frames are copied on the caller and
converted on the encoder thread, decision 8's default).
Goal: a Rust game (or any Rust program) adds one
dependency and streams its own frames and sound to an Apple TV, a
Chromecast or a browser tab:

```rust
use tvpipe::{Options, PixelFormat::Rgba};

let mut s = tvpipe::stream(
    Options::new().to("Living Room").video(1280, 720, 60, Rgba).audio(48000, 2),
)?;
loop {
    let frame: &[u8] = render();              // 1280 * 720 * 4 bytes
    s.write_video(frame, s.elapsed())?;       // never blocks; may drop
    s.write_audio(&pcm_i16, audio_pts)?;
}
// drop(s): the TVs get their TEARDOWN/STOP
```

**Decided:** the Rust SDK is the tvpipe code itself, linked into
the program (an in-process library). It does not spawn or ship the
`tvpipe` binary. The Node SDK (`docs/sdk-design.md` on the npm branch)
keeps spawning the binary over the machine interface (`docs/machine.md`).
Both present the same session and event model, and the machine protocol
becomes the JSON form of the library's event types, so the two cannot
drift.

Contents: 1. crate layout, 2. licensing and FairPlay, 3. features and
dependencies, 4. what changes inside tvpipe, 5. the API, 6. recipes,
7. the shared model with the Node SDK, 8. stability, 9. plan,
10. decisions.

## 1. Crate layout

**Decided:** three packages under `crates/`, one virtual workspace at the
root, one version for all:

| Package (crates.io) | Path | Kind | License | Dependencies |
|---|---|---|---|---|
| `tvpipe` | `crates/tvpipe/` | library: discovery, pairing, AirPlay, Cast, browser player/share, encoders, sessions, the public API | Apache-2.0 | `ring`; `rustls` (optional) |
| `tvpipe-fairplay` | `crates/tvpipe-fairplay/` | library: the FairPlay SAP port (today `src/airplay/fairplay/`) | LGPL-3.0-or-later | `ring` |
| `tvpipe-cli` | `crates/tvpipe-cli/` | binary `tvpipe`: argument parsing, Ctrl-C, `q`, `--machine` (events out, stdin router in) | Apache-2.0 (the built binary: LGPL terms, as today) | `tvpipe` (all features + `fairplay`), `argument` |

**Decided:** these names. All three were free on crates.io on 2026-11-18;
they are not reserved ahead of the first release.

**Why the library keeps the name `tvpipe`.** `tvpipe::stream(...)` is
what a user writes, the npm SDK is `tvpipe` too, and the binary is
distributed through GitHub releases and the installers, not `cargo
install`. `cargo install tvpipe-cli` still gives `tvpipe` (`[[bin]] name
= "tvpipe"`).

**The move.** The root `Cargo.toml` becomes a virtual workspace
(`members = ["crates/*"]`, `workspace.package` with the version, edition,
MSRV; `Cargo.lock` stays at the root).

- `src/` → `crates/tvpipe/src/`, with `tests/vectors/`, `tests/fixtures/`
  and `examples/` → `crates/tvpipe/` (they are read through
  `CARGO_MANIFEST_DIR`, so the tests keep working; big fixtures are
  `exclude`d from the published package).
- `cli.rs`, `main.rs`, `util/interrupt.rs`, the stdin-router half of
  `machine.rs`, and the tests that need the real binary
  (`tests/machine.rs`, `CARGO_BIN_EXE_tvpipe`) → `crates/tvpipe-cli/`.
- `src/airplay/fairplay/` → `crates/tvpipe-fairplay/src/`.
- One `git mv` commit per step, so `git log --follow` and blame survive;
  a separate commit updates the paths in ARCHITECTURE.md, `docs/`, the
  manual and AGENTS.md (old commits' `Sources:` lines stay as history).
- Each crate directory carries the license texts it needs (cargo packages
  only the crate directory): `LICENSE` (Apache-2.0) and the openh264/OFL
  notices in `crates/tvpipe`, the LGPL text in `crates/tvpipe-fairplay`.
  The root `LICENSE`/`LICENSES/` stay for the repository and the release
  archives.
- `cargo build --release` at the root still yields `target/release/tvpipe`
  (a virtual workspace builds every member); `release.yml` names it
  explicitly with `-p tvpipe-cli`.

**Why not one package with lib + bin.** Considered and rejected:

- The binary needs `argument` and FairPlay. In one package `argument`
  becomes a dependency of every game (or an optional `cli` feature with
  `required-features`, which makes `cargo install` need `--features`),
  and the package's `license` field has to say LGPL even for games that
  never enable FairPlay, which license checkers flag.
- Separate packages let the CLI depend on the library exactly as a game
  does, which is what keeps the public API honest (§4.2).

**Why not split further** (`tvpipe-h264enc`, `tvpipe-mdns`, …): every
split is another public semver surface. Features (§3) give games the
compile-time savings; parallel codegen inside one crate already uses the
cores. A standalone encoder crate can come later if someone asks for it.

**Compile time** (measured, clean `cargo build`, Apple M5 Max, today's
single crate): the tvpipe crate 9.5 s release / 7.4 s debug, `rustls`
3.6 s / 2.0 s, `ring` about 3 s (its build script compiles C), total
17 s wall release. A game pays this once. The features in §3 cut the
crate's share; dropping `cast` and `tunnel` drops `rustls`.

**Debug builds**: the built-in H.264 encoder at `opt-level = 0` is far
too slow for real time. The README tells games to add

```toml
[profile.dev.package.tvpipe]
opt-level = 3
[profile.dev.package.ring]
opt-level = 3
```

(the same as many games already do for image or audio crates). An
unoptimized build shows in `Stats` (encode time per frame) and as a
`warn` log line for programs that installed a logger (§5.9).

## 2. Licensing and FairPlay

### The problem

`src/airplay/fairplay/` is a port of doubletake, LGPL-3.0-or-later.
Rust links statically. A game that links it is a "Combined Work" (LGPLv3
§4), and the game must, besides the license texts and notices, let the
user relink it with a modified FairPlay: either ship the game's object
code / source so it can be relinked (§4(d)(0)), or use a shared-library
mechanism (§4(d)(1)). For a closed-source game neither is practical. The
library must therefore never pull FairPlay in by accident.

### What FairPlay is needed for

From `docs/airplay-mirroring.md` §2.2 and §5:

- **HAP profile** (Apple TVs, every receiver paired with `tvpipe pair`):
  FairPlay contributes only the `shk`/`shiv` placeholders; video and audio
  are ChaCha20-Poly1305 keyed from the pairing. **[HW] The dev Apple TV
  played picture and sound with FairPlay skipped entirely.** Today's
  policy still runs FairPlay whenever feature bit 14 is set, because
  other receivers and tvOS versions are untested.
- **Legacy profile** (third-party TVs with AirPlay, unpaired): FairPlay
  provides the AES keys. "Legacy without FairPlay" exists in code but is
  untested on any receiver.
- **Cast and the browser player** never need FairPlay.

### Design

1. **FairPlay becomes its own crate**, `tvpipe-fairplay`
   (LGPL-3.0-or-later), and an optional dependency of `tvpipe` behind the
   feature `fairplay`. The license is then per package, so `cargo deny`,
   `cargo about` and `cargo license` see LGPL exactly when the feature is
   on, and `tvpipe` itself is plain Apache-2.0.
2. **The crate is bytes in, bytes out**: `FpSession::{new, m1, m3,
   check_m4, wrap_key}` (the existing boundary, `ARCHITECTURE.md`
   "Licensing"). Its uses of tvpipe internals go: `RtspClient`/`fp_setup`
   (the two `POST /fp-setup` requests) move to `tvpipe`, rewritten from
   the clean-room spec (§2.2), not moved, since the current file is LGPL;
   the stream-key derivation (`SHA-512(K_fp ‖ S)[0..16]`, spec §2.2) is
   rewritten in `tvpipe` the same way; SHA/HMAC/random come from `ring`
   directly; the AES block function it uses comes either as a copy of
   `crypto/aes.rs` (Apache-2.0 code may be included in an LGPL crate) or
   through a one-method trait `tvpipe` implements. Copy is simpler; the
   AES file is stable and tested.
3. **Decided: the library's default features are LGPL-free.** `fairplay`
   is opt-in.
   The CLI enables it; the released binary stays under LGPL terms as
   today.
4. **Without `fairplay`** AirPlay runs the HAP profile with the §5.3
   placeholders (what the dev Apple TV accepted). A receiver that needs
   FairPlay (the legacy profile, or one that refuses the session) fails
   with the stable code `fairplay-required` (a `receiver` event `failed`,
   or the session error), whose message names the feature and the
   license consequence. Policy change in `airplay/session.rs`: with the
   feature on, behaviour is unchanged (FairPlay when bit 14 is set).
   Before calling this supported, the hardware matrix (Apple TV HD, 4K
   generations, recent tvOS versions, a Mac as AirPlay receiver, one LG
   or Samsung TV) must be run both ways.
5. **Documentation**: a "Licensing" section at the top of the crate docs
   and README, with a table:

   | Features | What you ship | Obligations |
   |---|---|---|
   | default (no `fairplay`) | Apache-2.0 code only | Apache-2.0 notice; the third-party notices in `LICENSES/` (openh264 tables BSD-2-Clause, OFL fonts with `player`/`share`, CDLA roots with `tunnel`) |
   | `fairplay` | LGPL-3.0-or-later code linked statically | the above, plus LGPLv3: license texts, notice, and relinkability (your object files or source) |

   plus a one-line check a game can put in its own CI, since Cargo
   unifies features across the graph and any dependency can turn
   `fairplay` on: `cargo tree -e normal --prefix none --format "{p} {l}"
   | grep LGPL` must print nothing (the same check as ours, §3). Not
   legal advice; the owner may want counsel to read the table once.

### Ways to have FairPlay without linking it (later, if hardware says so)

- **A clean-room FairPlay** (the original plan) removes the LGPL
  code altogether. The best outcome, the most work.
- **A helper process**: `tvpipe-fairplay` also builds a tiny executable
  that answers `m1`/`m3`/`check_m4`/`wrap_key` over stdin/stdout; the
  library spawns it only for a receiver that needs FairPlay. The game
  stays Apache-only and ships one small LGPL executable. Contradicts "no
  binary" only for those receivers.
- **A C ABI shared library** (`tvpipe-capi`, for Unity, Unreal, Godot):
  linking FairPlay into a replaceable `.dll`/`.so`/`.dylib` meets
  §4(d)(1). A natural fit if a C ABI is ever built, not a reason to
  build one.
- **The CLI as a subprocess** (**Decided: kept as a documented
  recipe**): Rust programs that want FairPlay and crash isolation can
  spawn `tvpipe --machine` like the Node SDK, using `tvpipe::slrw` and
  `tvpipe::Event::from_json` from the library (with
  `default-features = false`, a few hundred lines of code). A recipe in
  the crate docs, not a second SDK.

## 3. Features and dependencies

**Decided:** the defaults below (`airplay`, `cast`, `player`, `h264`).

| Feature | Default | Brings | Needs |
|---|---|---|---|
| `airplay` | yes | mDNS AirPlay records, pairing (SRP, Ed25519, X25519), mirroring, ALAC audio | `ring` |
| `fairplay` | no | the LGPL FairPlay crate (§2) | `airplay`, `tvpipe-fairplay` |
| `cast` | yes | Cast control (TLS), Cast Streaming, the AAC encoder | `rustls`, `aac` |
| `player` | yes | the `browser` receiver: HTTP server, WebSocket, player page and fonts | — |
| `share` | no | `share`: the capture page; with `headless`, a browser of its own over CDP | `player` |
| `headless` | no | `share URL` (Chromium over DevTools) | `share` |
| `tunnel` | no | public tunnels for the pages (on its branch: embedded Mozilla roots) | `rustls`, `player` |
| `files` | no | passthrough of MP4/MOV/MKV without ffmpeg | — |
| `ffmpeg` | no | files, URLs and capture through an ffmpeg subprocess, ffprobe | `files` |
| `h264` | yes | the built-in H.264 encoder (raw frames, the test pattern) | — |
| `aac` | (with `cast`) | the built-in AAC-LC encoder | — |

Discovery, the media clock, the fanout, SLRW and the session core are
always in. A game streaming raw frames to TVs takes the defaults (LGPL-free;
`ring` + `rustls`); one that only wants AirPlay with its own hardware
encoder takes `default-features = false, features = ["airplay"]` (no
`rustls`, no encoders).

- **Dependency policy** stays: the library depends on `ring` and
  optionally `rustls` (ring backend, no default features), nothing else;
  `argument` only in `tvpipe-cli`. Dev-dependencies the same (examples use
  std only, §6).
- **`ffmpeg` and `headless` spawn processes** in the game; on Windows a GUI
  game spawning a console program flashes a console window. The library
  sets `CREATE_NO_WINDOW` through std's `CommandExt::creation_flags`, a
  `cfg(windows)` line that joins the platform list in ARCHITECTURE.md.
- **CI** builds and tests each feature on its own and the default set
  (a loop over `cargo test -p tvpipe --no-default-features --features X`,
  no new tool).
- **License check (decided: the simplest thing, no `cargo deny`)**: a CI
  step, a few lines of shell:

  ```sh
  # The library's own license field is LGPL-free …
  grep -qx 'license = "Apache-2.0"' crates/tvpipe/Cargo.toml
  # … and so is its default dependency tree,
  ! cargo tree -p tvpipe -e normal --prefix none --format '{p} {l}' | grep LGPL
  # while `fairplay` really pulls the LGPL crate in (the check can fail).
  cargo tree -p tvpipe -e normal --features fairplay --prefix none --format '{p} {l}' | grep -q LGPL
  ```

  `cargo tree`'s `{l}` prints each package's license field (checked: it
  lists `ring v0.17.14 Apache-2.0 AND ISC` and so on today), so this
  needs nothing beyond cargo. `cargo deny` would add advisories and
  duplicate-version checks we do not need with three dependencies.
- **Size**: features remove whole modules (the player's embedded pages
  and fonts, the CDP client, the demuxers), so code that is off is not
  compiled, not just not linked.

## 4. What changes inside tvpipe

The pipeline already has the right shape for this: sessions run in
threads, inputs are a `PacketSource` (the game's SLRW or the test
pattern), the session's tests run several sessions in one process
against fake receivers. What makes it a CLI today is process-wide state.

### 4.1 Process-wide state → per session

| Today | Library |
|---|---|
| `StopFn = fn() -> bool` (33 uses), wired to `interrupt::requested` | a `Stop` token (`Arc` of an atomic flag plus a condvar for waits) per session; `play_with`'s injected stop is already the seam |
| `util/interrupt.rs` (SIGINT/SIGTERM, console handler, `q`) | CLI only; the library never installs signal handlers or reads stdin |
| `machine::emit`, `machine::receiver`, … (statics) | an `Events` handle (cloneable sender) passed down through the session (connect, rejoin, fanout stats, player, share, pairing); the CLI's `--machine` turns it into JSON lines |
| `log.rs`: a static level and stderr | off by default, a global handler the program may install (§5.9); the CLI installs stderr or `log` events |
| stdin SLRW (`GameIo`), `keyframe\n` on stdout | `Stream`'s writers feed a `PacketSource` over a channel; keyframe requests are a flag the game reads (§5.4). The CLI's stdin router becomes an SLRW reader calling the same `Stream` methods |
| `credentials::config_dir()` from env vars, one `credentials.txt` | a `Storage` per program, by default in its own directory; the CLI's, a directory, memory or the program's own storage on request (§5.8) |
| `timer::raise_resolution()` (Windows, `timeBeginPeriod(1)`) | stays, called when a session starts; documented, since it is process-wide (games usually do it anyway) |
| `std::process::exit`, printing tables | CLI only |

### 4.2 The CLI on top of the library

`tvpipe-cli` uses the public API for every command: `discover`, `pair`,
`play`, `debug pattern`, `preview`, `share`, game input on stdin (an SLRW
reader that calls `Stream::write_*`), and `--machine` (serializing
`Event`s). Debug commands (`debug pipeline`) and test fixtures that need
internals go through a `#[doc(hidden)] pub mod __cli` that is outside the
semver promise. The CLI is the first, always-tested user of the API: if
the CLI can do something, a game can.

### 4.3 Robustness in someone else's process

- The "never panic on network or ffmpeg data" rule now protects games;
  many games build with `panic = "abort"`, where a panic in a tvpipe
  thread kills the game. The fuzz smoke tests get extended to the input
  paths the API exposes (frame sizes, strides, PCM lengths, H.264 the
  game sends).
- If the game crashes, there is no TEARDOWN; the OS closes the TCP
  connections (AirPlay control and data, Cast's TLS channel), which the
  receivers should notice as the end of the session. To verify on
  hardware; a frozen (not crashed) game is the remaining case, covered
  by the receivers' own timeouts.
- Threads are named (`tvpipe-…`) for the game's profilers; no thread
  outlives `Session::stop`/`Drop`.

## 5. The API

Blocking, `std::thread` inside, no async runtime. Everything `Send`;
session handles are not `Clone` (one owner), but hand out cloneable
writers for other threads.

### 5.1 Module surface

| Function | CLI equivalent | Returns |
|---|---|---|
| `discover(timeout)` / `Discovery::start()` | `discover` | `Vec<Device>` / a handle with `devices()` that updates (a game's TV menu) |
| `pair(target, on_pin)` / `Pairing::start(target)` | `pair` | `Paired` / a handle: `state()`, `submit_pin(&str)` |
| `unpair(target)` | `unpair` | `()` |
| `stream(options)` / `Stream::start(options)` | `play … -` (SLRW) | `Stream` once connected / at once (state `Connecting`) |
| `play(input, options)` | `play` (`files`/`ffmpeg`) | `Session`; a file or a URL with a length seeks and pauses (`seek`, `seek_by`, `pause`, `resume`, `playback()`; docs/playback.md) |
| `test_pattern(options)` | `debug pattern` (`h264`) | `Session` |
| `preview(input, options)` | `preview` (`player`) | `Session` with `player_url()` |
| `share(url, options)` | `share` (`share`/`headless`) | `Session` with `share_url()`; with a URL, `navigate(url)` shows another page in the same tab (the receivers keep their sessions) |

`Input` for `play`: `Input::path(..)`, `Input::url(..)`,
`Input::ffmpeg(args)`.

### 5.2 Options

One builder for every command (`Options` in the owner's example); fields
a command does not use are ignored, `stream` requires `video` or `h264`.

```rust
Options::new()
    .to("Living Room")                 // repeatable; "airplay:X", "cast:X", an address, "browser"
    .to_device(&device)                // a Device from discover()
    .video(1280, 720, 60, PixelFormat::Rgba)   // raw frames, built-in encoder
    .h264(1920, 1080, 60)              // or: the program's own H.264
    .audio(48_000, 2)                  // interleaved PCM (s16; f32 accepted)
    .size(1280, 720)                   // output size cap (default: the input's)
    .bitrate_kbps(4000)
    .latency(Duration::from_millis(150))
    .reconnect(Duration::from_secs(120))
    .encoder_threads(4)
    .player(PlayerOptions::new().port(0).open(false))   // the browser receiver
    .storage(Storage::app("com.example.mygame"))   // pairings, §5.8
    .on_pin(|req| ask_user(req))       // pair on demand when a TV needs it
    .on_event(|e| …)                   // optional, see 5.5
```

`Options`, `Device`, `PlayerOptions` are `#[non_exhaustive]` builders,
so options can be added without a breaking release. Defaults match the
Node SDK where it chose differently from the CLI: player port `0` (any
free port), no browser opened; the encoder for `stream` is the built-in
one (the only one in process; keyframes on demand, no ffmpeg start-up
drop).

### 5.3 Raw frames

```rust
impl Stream {
    /// One frame in the stream's size and format, rows packed.
    fn write_video(&mut self, frame: &[u8], pts: Duration) -> Result<Written>;
    /// Rows `stride` bytes apart (wgpu's 256-byte aligned rows, a
    /// sub-rectangle of a larger buffer); `bottom_up` for glReadPixels.
    fn write_video_frame(&mut self, frame: Frame<'_>, pts: Duration) -> Result<Written>;
    /// Whether a frame written now would be encoded (skip the readback if not).
    fn wants_frame(&self) -> bool;
    /// Time since the stream started, for live sources.
    fn elapsed(&self) -> Duration;
    fn write_audio(&mut self, pcm: &[i16], pts: Duration) -> Result<()>;
    fn write_audio_f32(&mut self, pcm: &[f32], pts: Duration) -> Result<()>;
    /// A writer for the audio thread (Send + Clone), see 6.4.
    fn audio_writer(&self) -> AudioWriter;
}

pub enum Written { Queued, Dropped }   // #[must_use]
pub struct Frame<'a> { pub data: &'a [u8], pub stride: usize, pub bottom_up: bool }
// For NV12/YUV420P: Frame::planes(&[(&[u8], stride); N])
```

- **Copies (decided: conversion on the encoder thread by default).**
  `write_video` copies the borrowed pixels into a pooled buffer (no
  allocation per frame; strides and `bottom_up` are resolved in that
  copy, so wgpu and GL readbacks are never repacked by the game) and
  queues it; the encoder thread converts to YUV 4:2:0 and encodes. The
  game thread pays one memcpy (about 0.3 ms for 720p RGBA, to measure
  per OS). `Options::convert_on_caller()` converts the borrowed pixels
  straight into the encoder's planes on the caller's thread instead:
  no RGBA copy and less memory traffic, but the conversion's time (a few
  ms at 1080p, to measure) lands in the game's frame. NV12/YUV420P with
  any strides are copied as planes, without conversion, either way.
  `Stream::frame_buffer()` lends a pooled buffer to fill directly (a
  readback that writes into it skips even the memcpy) and
  `submit(buffer, pts)` queues it.
- **Backpressure.** Live, not lossless: the encoder holds at most 2 raw
  frames (today's `VIDEO_QUEUE`); a frame that finds the queue full is
  dropped and `Written::Dropped` returned, counted in `stats()`. Frames
  before the receivers are connected are dropped the same way (the
  binary drops stale frames today). `wants_frame()` lets a game skip the
  GPU readback for frames that would be dropped. Faster-than-`fps`
  writers are thinned to the stream rate (the builtin path's rate drop).
- **Timestamps**: `Duration` since any origin the program likes (the first
  record is media time 0); must increase per track. `elapsed()` is the
  stream's clock for programs without one.
- **Keyframes** go straight to the built-in encoder: a receiver joining,
  a PLI, a queue overflow make the next encoded frame an IDR, with no back
  channel, rate limit or extra frame of latency.

### 5.4 Encoded H.264

```rust
let mut s = tvpipe::stream(Options::new().to("TV").h264(1920, 1080, 60))?;
s.write_h264_config(&avcc, ConfigFormat::Avcc)?;            // optional
loop {
    let force_idr = s.take_keyframe_request();              // atomic swap
    let au = hw_encoder.encode(&frame, force_idr);
    s.write_h264(&au.data, H264 { keyframe: au.idr, annex_b: true, pts })?;
}
```

`write_h264` never blocks: when the queue is full it drops the access
unit, drops every following non-IDR one (they would not decode) and
raises a keyframe request itself. Rules as in `docs/slrw.md`: no
B-frames, increasing pts, SPS/PPS in band or by `write_h264_config`.

### 5.5 Events and state

The same events as the machine interface (`docs/machine.md`), typed:

```rust
#[non_exhaustive]
pub enum Event {
    Receiver(ReceiverEvent),      // name, protocol, state: Connected | Failed | Lost | Reconnected | GaveUp | Ended | Stopped, error
    Player { name: String, url: String },
    Viewer { name: String, tab: u32, state: ViewerState },
    SharePage { url: String },
    Connected { receivers: Vec<String> },
    Started(Started),             // route, video, audio, latency
    Keyframe,
    Stats(Stats),                 // 1 Hz
    PinRequired(PinRequest),
    Paired(Paired),
    End(EndInfo),
    Error(ErrorInfo),
}
// Log lines are not events; see 5.9 (the CLI turns them into `log` events).
```

Three ways to consume them, all optional:

- **Poll** (game loops): `s.poll_events()` drains a bounded queue (oldest
  dropped past 256; at 1 Hz stats a game that never polls loses nothing
  that matters).
- **Callback**: `Options::on_event(F: FnMut(&Event) + Send + 'static)`,
  called on one dispatcher thread per session, so a slow callback never
  stalls media threads.
- **State**: `s.receivers()`, `s.stats()`, `s.started()`,
  `s.player_url()`, `s.state()` (`Connecting`, `Streaming`, `Ended`) are
  snapshots, no events needed.

### 5.6 Lifecycle and errors

- `stream()`/`play()` block until connected (resolve + connect, seconds);
  `Stream::start()` returns at once for games that keep rendering a
  "connecting…" screen.
- `s.stop() -> Result<EndInfo>`: stop now; every sink's TEARDOWN/STOP.
- `s.finish() -> Result<EndInfo>`: the tail plays out (the `end` record's
  meaning), then teardown.
- `s.wait() -> Result<EndInfo>`: until the session ends by itself
  (every receiver gone, the file ended).
- **`Drop` = `stop()`**, blocking until teardown is done (bounded by the
  sinks' own timeouts, about 2 s). It must block: a game that drops the
  stream and returns from `main` would otherwise kill the teardown thread
  and leave the TV in mirroring mode.
- `Error` with `kind()` (the CLI's `ErrorKind`) and `code()` (the stable
  codes of `docs/machine.md`: `pairing-required`, `no-receiver`,
  `fairplay-required`, …) and `device()`. One receiver failing is an
  event, not an error; the session fails when none is left.

### 5.7 Pairing

```rust
// Blocking, for tools:
tvpipe::pair("Living Room", |req: &PinRequest| prompt(&req.name))?;
// A game UI over several frames:
let mut p = tvpipe::Pairing::start("Living Room", &options)?;
match p.state() {
    PairingState::NeedPin { name } => if let Some(pin) = ui.pin_entered() { p.submit_pin(&pin)? },
    PairingState::Done(paired) => …,
    PairingState::Failed(e) => …,
    _ => {}
}
```

With `Options::on_pin`, `stream`/`play` pair a receiver that reports
`pairing-required` and connect it again, like the Node SDK.

### 5.8 Storage: pairings and the player token

**Decided:** a program keeps its pairings in its own place by default;
sharing the CLI's is an option, and the program may store them itself.

What is stored: the AirPlay controller identity (an Ed25519 seed and a
UUID, made once) and one block per paired receiver, today's
`credentials.txt` text format (versioned by its keys, unknown keys
ignored); and, for a fixed player port, the player page's token. Both
are secrets (the seed lets anyone act as this program towards the TVs).

```rust
pub struct Storage { /* Arc inside: Clone, shared by every session */ }

impl Storage {
    /// Default: the program's own directory. `id` names it, e.g. "com.example.mygame".
    fn app(id: &str) -> Storage;
    /// The CLI's directory (`TVPIPE_CONFIG_DIR` honoured): pair once with
    /// `tvpipe pair`, use it everywhere, and the other way round.
    fn cli() -> Storage;
    fn dir(path: impl Into<PathBuf>) -> Storage;
    /// Nothing on disk. `export()` gives the text to persist,
    /// `memory_from(text)` restores it.
    fn memory() -> Storage;
    fn memory_from(text: &str) -> Result<Storage>;
    fn export(&self) -> String;
    /// The program's own storage (a keychain, a save game, a cloud profile).
    fn custom(backend: impl StorageBackend) -> Storage;
    /// Called after every change (pair, unpair, a new identity), e.g. to
    /// persist `export()` from `memory()`.
    fn on_change(self, f: impl Fn(&Storage) + Send + Sync + 'static) -> Storage;
}

pub trait StorageBackend: Send + Sync + 'static {
    /// The item's text, or None if it was never saved.
    fn load(&self, item: &str) -> io::Result<Option<String>>;
    fn save(&self, item: &str, text: &str) -> io::Result<()>;
}
// Items: "credentials" and "player-token". Closures work too:
// Storage::custom(storage_fn(|item| load(item), |item, text| save(item, text)))
```

- **Default** (`Options` without `storage`): `Storage::app` with the
  executable's file stem as the id. Directories (`cfg(target_os)` for
  paths only, as allowed): `~/Library/Application Support/<id>/tvpipe/`,
  `$XDG_CONFIG_HOME/<id>/tvpipe/` (or `~/.config/…`),
  `%APPDATA%\<id>\tvpipe\`. The docs tell programs to pass a real id.
- The library ignores `TVPIPE_CONFIG_DIR` except in `Storage::cli()`; the
  CLI uses `Storage::cli()`.
- Files are written as today: a temporary file and a rename, mode 0600 on
  unix. Directory stores re-read before each change, so the CLI and a
  program sharing `cli()` do not lose each other's pairings.
- `discover()` marks devices `paired` from the store in `Options`.

### 5.9 Logging

**Decided:** off by default, global, zero cost when unset.

```rust
tvpipe::log::set_logger(Level::Info, |r: &tvpipe::log::Record| {
    eprintln!("{} {}: {}", r.level, r.module, r.message)
});
tvpipe::log::set_level(Level::Debug);    // later changes
```

- One static atomic holds the maximum level, `Off` until a logger is
  set. The `warn!`/`debug!`/… macros compare against it first, so with
  no logger a log line is one relaxed load and a branch; the message is
  never formatted (`format_args!` is only evaluated past the check).
- The handler is a `&'static dyn Fn(&Record) + Send + Sync` behind a
  `OnceLock` (set once, like the `log` crate; a second `set_logger` is
  an error). It is called on whatever tvpipe thread logs, so it must be
  quick; it never runs on the game's thread unless the game calls into
  tvpipe.
- The library never writes to stdout or stderr.
- The CLI installs its own: stderr lines as today, or `log` events with
  `--machine` (`Record::to_json()`, covered by the vectors in §7).

## 6. Recipes (in the crate docs, not dependencies)

Examples in the repository use std only (dependency policy): `examples/
stream.rs` draws a moving test card in software and a 440 Hz tone to
`--to browser`. Engine recipes are prose and code blocks in the docs,
compiled in a separate repository (or not at all) since `wgpu`, `bevy`
and friends cannot be dev-dependencies here.

### 6.1 CPU framebuffers (pixels, softbuffer, minifb, tiny-skia)

- `pixels`: the frame is RGBA8 → `PixelFormat::Rgba`, `write_video(pixels.frame(), …)`.
- `softbuffer`/`minifb`: `u32` `0x00RRGGBB`, whose little-endian bytes
  are B, G, R, 0 → `PixelFormat::Bgr0`. The library takes `&[u32]` too
  (`write_video_u32`), so games need neither `unsafe` nor `bytemuck`.

### 6.2 wgpu (and anything built on it)

1. Render to (or copy the surface to) a texture with `COPY_SRC`; render
   at the stream size, or downscale in a pass (cheaper than encoding a
   4K frame).
2. `copy_texture_to_buffer` into one of 2–3 `MAP_READ` staging buffers
   (`bytes_per_row` padded to 256).
3. Map the buffer from two frames ago (`map_async`, poll), and pass the
   mapped slice as `Frame { data, stride: padded_bytes_per_row, bottom_up:
   false }` with `Bgra` or `Rgba` matching the texture format: no
   repacking.
4. Check `s.wants_frame()` before scheduling the copy.
5. Optional: an RGB→NV12 compute pass writes a 1.5-byte-per-pixel buffer
   (2.7× less readback, no CPU conversion) → `PixelFormat::Nv12` with two
   planes.

### 6.3 Bevy and macroquad

- **Bevy**: a camera rendering to an `Image` with `COPY_SRC`, a render-world
  node copying it to a staging buffer and sending the mapped bytes over a
  channel to the main world (the shape of Bevy's `headless_renderer`
  example), then 6.2 step 3. The screenshot API is too slow per frame.
- **macroquad / miniquad (GL)**: render to a `RenderTarget`, read it with
  `get_texture_data()` (or `get_screen_data()`); GL rows are bottom-up →
  `bottom_up: true`.

### 6.4 Audio from a cpal-style callback

```rust
let audio = s.audio_writer();                 // Send + Clone
device.build_output_stream(&cfg, move |out: &mut [f32], _| {
    game_mixer.fill(out);
    audio.write_f32(out);                     // never blocks or allocates
}, …)?;
```

`AudioWriter` copies into a preallocated ring (std only: a `Mutex` taken
with `try_lock`, dropped and counted on contention, which is rare with
one writer), timestamps by sample count from its first write on the
stream clock (the input resyncs past 50 ms of drift, as for SLRW), and
the session thread drains it. Use the device's sample rate in
`.audio(rate, channels)`. The TV plays about 0.1–0.3 s later than the
local speakers; games usually mute one.

### 6.5 A hardware encoder

§5.4 with NVENC, VideoToolbox, Media Foundation or VA-API through the
game's own bindings: no B-frames, low-latency preset, force IDR on
`take_keyframe_request()`, a long or infinite GOP is fine because
keyframes come on request.

### 6.6 Platform notes for shipping

- **macOS**: the game makes the network connections, so macOS 15's Local
  Network prompt names the game; its `Info.plist` needs
  `NSLocalNetworkUsageDescription` (to verify whether the multicast mDNS
  query also needs `NSBonjourServices`).
- **Windows**: the browser player listens on 127.0.0.1 only (no firewall
  prompt); whether receiving Cast's RTCP on a connected UDP socket
  triggers the firewall prompt for an unsigned game is to check.
- **Linux, Steam Deck**: nothing special; Flatpak needs network access.
- **iOS/Android**: `ring` builds there, but nothing is tested; mDNS is
  legacy unicast (no multicast receive, so possibly no Android
  `MulticastLock`); out of scope until someone asks.

## 7. One model for the Rust and Node SDKs

The Node SDK keeps the machine interface; the Rust SDK is the library.
The single source of truth is the library's types:

- **Events**: `tvpipe::Event` has `to_json()` and `from_json()` (always
  compiled, they are small and on `codec::json`). The CLI's `--machine`
  writes `event.to_json()` per line, nothing hand-built, so the protocol is
  by construction the serialization of what Rust programs receive. Wire
  names stay as in `docs/machine.md` (`gave-up`, `share-page`,
  snake_case fields); enum `as_str()` gives the wire name.
- **Commands** (`stop`, `pin`) are the CLI's stdin router calling
  `Stream::stop`/`Pairing::submit_pin`.
- **SLRW**: `tvpipe::slrw` (public: writer and reader, the format of
  `docs/slrw.md`), used by the CLI's stdin, the share page and the player;
  `examples/slrw-gen.rs` drops its `#[path]` include and uses it.
- **Golden vectors** for the Node SDK, generated from Rust, under
  `crates/tvpipe/tests/vectors/`:
  - `machine/events.txt` (the project's `key = value` vector
    format): one block per event variant, per log record shape and per
    interesting case (`name`, `json`). A Rust test builds each from a function with an exhaustive
    `match` over `Event`, so a new variant does not compile until it has
    a vector, and compares with the file (`TVPIPE_BLESS=1` rewrites it).
  - `machine/sessions/*.txt`: event sequences recorded from
    `tvpipe-cli`'s machine tests (ports and tokens scrubbed), with the
    expected outcome (`connected`, `error pairing-required`, `end eof`).
  - `slrw/records.txt`: writer calls and their bytes.
  - The Node tests (`npm/tvpipe/test/`, run from the repository, reading
    `../../crates/tvpipe/tests/vectors/`) parse
    every event vector, check that the set of `type`s equals the TS
    union's (a TS constant list), replay the session transcripts through
    a stub binary, and compare their SLRW encoder's bytes.
- **No code generation** for now: the protocol is about fifteen events,
  hand-written TS types read better, and the vectors catch drift in both
  directions. A JSON Schema generated from the Rust types is a later
  option for third-party languages.
- **Names line up**: Rust `ReceiverState::GaveUp` ↔ TS `"gave-up"`,
  `EndInfo`, `Started`, error codes identical; the Node SDK's API table
  (`discover`, `pair`, `play`, `testPattern`, `preview`, `share`,
  `stream`) and the Rust one (§5.1) are the same list.

## 8. Stability

- **Public**: §5's functions and types, `Event` and its payloads,
  `Error`/`ErrorKind`/codes, `PixelFormat`, `Frame`, `slrw`, the
  features. Every public struct and enum is `#[non_exhaustive]`; options
  are builders; event payload fields are public but structs cannot be
  built outside the crate (only read), so fields can be added.
- **Internal**: everything else stays `pub(crate)`: `Sink`,
  `EncodedFrame`, plans, protocols, codecs, encoders, the fanout. They
  keep changing freely with the CLI. `types.rs`'s "frozen" rule turns
  into "the public API is frozen per release"; internals go back to
  being internal.
- **Versions in lockstep**: `tvpipe`, `tvpipe-fairplay`, `tvpipe-cli` and
  the npm packages share `workspace.package.version`. While 0.x, a
  breaking change to the public API bumps the minor (0.1 → 0.2); CLI-only
  changes and new features are patches.
- **Catching breaks (decided: the simplest thing).** The public API lives
  in a few files (`crates/tvpipe/src/api/`, re-exported from `lib.rs`;
  everything else `pub(crate)`), so a break is a diff there and shows in
  review. `cargo-semver-checks` is **not worth it at 0.x yet**: it
  compares against the last version on crates.io, so it does nothing
  before the first publish; with `#[non_exhaustive]` everywhere and a
  small surface, the breaks it would catch are the ones review already
  sees; and every 0.x minor may break anyway. Revisit when the crate has
  outside users who pin `0.y` (a break slipping into a patch release
  hurts them), or at 1.0. It would then be one CI step with the
  prebuilt tool, no dependency.
- **Machine protocol** keeps its own integer (`hello.protocol` = 1);
  additive event changes do not bump it (same rule as `#[non_exhaustive]`).
- **MSRV** stays 1.85 for all crates.
- **Release**: `release.yml` gains a `crates` job after the GitHub
  release: `cargo publish -p tvpipe-fairplay`, `-p tvpipe`, `-p
  tvpipe-cli` (a `CARGO_REGISTRY_TOKEN` secret, later trusted
  publishing), skipping versions already published so a rerun completes;
  the dry run does `cargo publish --dry-run`.

## 9. Plan

The machine interface lands first (npm branch), because its event names
become the Rust enum names. Then, each step green on its own:

1. **De-globalize, no API yet**: `Stop` tokens instead of `StopFn`, an
   `Events` handle instead of `machine::emit`, logging off unless a
   handler is set (§5.9), the SLRW stdin input as a channel-fed
   `PacketSource`, a storage handle instead of `config_dir()` (§5.8).
   Behaviour and tests unchanged; the session tests stop needing a
   process.
2. **FairPlay crate**: `crates/tvpipe-fairplay` with the bytes-only API;
   `fp_setup` and the stream-key derivation rewritten from the spec in
   `tvpipe`; the `fairplay` feature; the no-FairPlay HAP path with
   `fairplay-required`; fake-receiver tests both ways.
3. **Workspace and features**: the moves of §1 (`crates/tvpipe`,
   `crates/tvpipe-cli`, `crates/tvpipe-fairplay`; `git mv` commits, then
   one commit for the paths in the docs), feature gates (§3), the CI
   feature loop and license check, release build of `-p tvpipe-cli`.
   AGENTS.md's "single binary crate" rule and its commit check (`cargo
   clippy --workspace --all-targets`, `cargo test --workspace`) are
   rewritten.
4. **Public API** (§5) and the CLI rebuilt on it (§4.2); `Event::to_json`
   drives `--machine`; vectors for the Node SDK (§7).
5. **Hardware**: AirPlay without FairPlay on the matrix (§2), a game
   crash vs. teardown, the Windows firewall and macOS Local Network
   prompts, conversion cost per frame at 720p/1080p on each OS.
6. **Docs and publish**: crate docs with the licensing table and recipes,
   a manual page (“Rust”), `examples/stream.rs`, the crates job in
   `release.yml`.

Later, on demand: clean-room FairPlay; a C ABI (`tvpipe-capi`) for
engines in other languages; a standalone encoder crate.

## 10. Decisions

Decided with the owner (2026-11-18):

| # | Question | Decision |
|---|---|---|
| 0 | Subprocess or library | In-process library; the Rust SDK ships no binary. The Node SDK keeps the binary. |
| 1 | Names | `tvpipe` (library), `tvpipe-cli` (binary `tvpipe`), `tvpipe-fairplay`. Not reserved ahead of the first release. |
| 2 | Layout | Everything under `crates/`: `crates/tvpipe`, `crates/tvpipe-fairplay`, `crates/tvpipe-cli`; a virtual workspace at the root (§1). |
| 3 | FairPlay | Off by default; the library's default features are LGPL-free (§2). |
| 4 | Pairings | Each program its own directory by default; `Storage::cli()` to share the CLI's; `memory()`/`export()` and `custom()` for programs that store them themselves (§5.8). |
| 5 | Feature defaults | `airplay`, `cast`, `player`, `h264` on; `fairplay`, `share`, `headless`, `tunnel`, `files`, `ffmpeg` off (§3). |
| 6 | CI tools | The simplest checks: the manifest's license field and `cargo tree` for licenses, no `cargo deny`; no `cargo-semver-checks` at 0.x (§3, §8). |
| 7 | Logging | A global handler, off and zero cost by default; the CLI installs its own (§5.9). |
| 8 | Pixel conversion | On the encoder thread by default (a memcpy on the game thread); `convert_on_caller()` as an option (§5.3). |
| 9 | Subprocess recipe | Kept, documented in the crate docs (§2). |

Still open, to settle while implementing (no owner input needed unless
they turn out otherwise):

- Whether AirPlay without FairPlay holds beyond the dev Apple TV (§2,
  plan step 5); if not, which of the "without linking" ways to take.
- The macOS Local Network and Windows firewall prompts for a game (§6.6).
- The memcpy and conversion costs per OS that back decision 8.
