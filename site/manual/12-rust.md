---
title: From Rust
summary: Stream from your own Rust program, a game for example, with the tvpipe crate.
group: Use
spec:
  Crate: `tvpipe` (crates.io)
  Docs: [docs.rs/tvpipe](https://docs.rs/tvpipe)
  Rust: 1.85 or newer
  Example: `crates/tvpipe/examples/stream.rs`
---

The `tvpipe` crate is tvpipe itself, linked into your program. There is no binary to ship and no async runtime: sessions run on threads of their own. A game streams the frames it renders and the sound it mixes. Any program can also play files, the test pattern or a web page.

```sh
$ cargo add tvpipe
```

:::aside Debug builds
The built-in H.264 encoder is too slow without optimizations. Add `[profile.dev.package.tvpipe]` and `[profile.dev.package.ring]` with `opt-level = 3` to your `Cargo.toml`.
:::

## Frames from your program

```rust
use tvpipe::{Options, PixelFormat};

let mut s = tvpipe::stream(
    Options::new()
        .to("Living Room")
        .video(1280, 720, 60, PixelFormat::Rgba)
        .audio(48_000, 2),
)?;
loop {
    let frame: &[u8] = render();          // 1280 × 720 × 4 bytes
    s.write_video(frame, s.elapsed())?;   // never blocks; may drop
    s.write_audio(&pcm, audio_pts)?;      // interleaved i16 (or write_audio_f32)
}
// Dropping `s` stops it: every TV gets its teardown first.
```

`stream()` returns once the receivers are connected. `Stream::start()` returns at once, for a game that keeps rendering a "connecting…" screen. `to` takes the same forms as `--to` on the command line ([Receivers](receivers.md)), including `"browser"` for a browser tab, and `to_device()` takes a `Device` from `discover()`.

- **Pixel layouts.** `Rgba`, `Bgra`, `Rgb0`, `Bgr0` (softbuffer's and minifb's `u32` pixels, with `write_video_u32`), `Rgb24`, `Bgr24`, `Nv12` and `Yuv420p`. `write_video_frame` takes padded rows (a GPU readback), bottom-up rows (OpenGL) and separate planes, and packs them while it copies.
- **Real time.** Frames are copied on your thread and encoded on tvpipe's. When the encoder is busy, a frame is dropped (`Written::Dropped`), not queued, so the stream stays live. `wants_frame()` tells you before you read a frame back from the GPU.
- **Sound from a callback.** `audio_writer()` gives a writer for your audio thread (cpal and the like) that timestamps by sample count.
- **Your own H.264.** With a hardware encoder, use `Options::h264(w, h, fps)` and `write_h264()`. When a receiver needs a keyframe, `take_keyframe_request()` returns true: make the next picture an IDR.

The [crate's documentation](https://docs.rs/tvpipe) has recipes for wgpu readbacks, Bevy, macroquad and cpal.

## Play something

```rust
use tvpipe::{Input, Options};

let session = tvpipe::play(Input::path("movie.mp4"), Options::new().to("Living Room"))?;
session.wait()?;

let s = tvpipe::test_pattern(Options::new().to("Kitchen").to("browser"))?;
println!("{:?}", s.player_url());
```

`play` (files, URLs, ffmpeg inputs), `test_pattern`, `preview` and `share` return a `Session`. Files, URLs and `share` need crate features that are off by default, see below.

A file, or a URL with a length, also seeks and pauses: `seek(Duration)`, `seek_by(ms)`, `pause()` and `resume()`; `playback()` says where it is, and an `Event::Playback` follows every change.

## Events, stopping and errors

```rust
for event in s.poll_events() {
    if let tvpipe::Event::Receiver(r) = event {
        println!("{}: {}", r.name, r.state);
    }
}
let end = s.stop()?;
```

- **Events** are the same as the command line's machine interface: poll them, pass `Options::on_event` (called on a thread of the session's own), or read the snapshots `receivers()`, `stats()` and `player_url()`.
- **Stopping.** `stop()`, `finish()` (the queued tail plays first) or dropping the stream or session. `stopper()` gives a handle for another thread.
- **Errors** are `tvpipe::Error` with a readable message and a stable `code()`, such as `pairing-required`, `no-receiver` or `fairplay-required`. One receiver failing is an event. The session fails when none is left.
- **Logging** is off: the library never prints. Install a handler with `tvpipe::log::set_logger` to see tvpipe's log lines.

## Pairing

```rust
tvpipe::pair("Living Room", |req| ask_user(&req.name))?;
```

A TV with an AirPlay password shows no PIN: `req.password` is true and the answer is that password. `Pairing::start()` does the same over several frames of a game's UI: show a PIN field when its state is `NeedPin`, then call `submit_pin()`. With `Options::on_pin`, `stream()` and `play()` pair a receiver that needs it when they first use it.

Pairings live in a `Storage`. By default each program has its own directory, named by `Storage::app("com.example.mygame")`. `Storage::cli()` shares the command line tool's ([Configuration](config.md)), so `tvpipe pair` once works for both. `Storage::memory()` and `Storage::custom()` let a program keep them itself, in a save game or a keychain.

## Features and licensing

| Feature | Default | What it brings |
|---|---|---|
| `airplay`, `cast`, `player`, `h264` | on | AirPlay, Google Cast, the browser receiver, the built-in encoder |
| `fairplay` | off | FairPlay, for AirPlay receivers that need it (LGPL) |
| `files`, `ffmpeg` | off | files without ffmpeg, or files, URLs and capture with it |
| `share`, `headless`, `tunnel` | off | sharing a tab or screen, `share` of a URL, [public links](links.md) |

The crate is Apache-2.0. FairPlay is a port of LGPL code in its own crate, which only the `fairplay` feature pulls in. Apple TVs that you pair with a PIN work without it. A receiver that needs FairPlay fails with the code `fairplay-required`. If you enable `fairplay`, your program contains LGPL code linked statically, and you must let its users relink it. The crate's README has the details and a one-line check for your build.

## Other languages

Programs in other languages, and Rust programs that want FairPlay without linking it, run `tvpipe --machine` and read JSON events from it, like the [Node.js package](node.md) does. The protocol is in [docs/machine.md](https://github.com/mitsuhiko/tvpipe/blob/main/docs/machine.md).
