<p align="center">
  <img src="docs/logo/tvpipe.svg" alt="tvpipe logo" width="260">
</p>

# tvpipe

`tvpipe` is a command line tool for low-latency mirroring of video and audio
to **AirPlay** and **Google Cast** receivers (Apple TV, smart TVs,
Chromecast / Google TV) and browser tabs. It uses the real-time mirroring
protocols of both ecosystems, not URL playback, so the picture on the TV is a
fraction of a second behind the source.

**Website and manual: <https://tvpipe.party/>**

```sh
tvpipe discover                                        # find receivers
tvpipe pair "Living Room"                              # Apple TV only, once
tvpipe play --to "Living Room" movie.mp4               # a file or URL
tvpipe play --to "Living Room" --to Kitchen movie.mp4  # two TVs, one encode
tvpipe screen --to Kitchen                             # the screen, with sound
tvpipe screen --to Kitchen --window Keynote            # one window
tvpipe share --to Kitchen --open                       # a browser tab or the screen
tvpipe share https://status.example.com --to Kitchen   # a web page
tvpipe game play drawbluff                             # a party game: TV, phones, a window here
```

## Installing

```sh
curl -fsSL https://tvpipe.party/install.sh | sh     # macOS, Linux
```

```powershell
irm https://tvpipe.party/install.ps1 | iex           # Windows
```

Playing files, URLs and capture devices needs `ffmpeg` (and `ffprobe`); see
[Installation](https://tvpipe.party/manual/install/) for
ffmpeg, the release archives and building from source.

From Node.js, `npm install @tvpipe/sdk` installs an SDK and the binary for your
platform ([`npm/tvpipe`](npm/tvpipe/README.md)):

```js
import { play } from "@tvpipe/sdk";
await play("movie.mp4", { to: "Living Room" });
```

From Rust, `cargo add tvpipe` links tvpipe into your program (no binary,
no async runtime); a game streams its own frames and sound
([`crates/tvpipe`](crates/tvpipe/README.md),
[From Rust](https://tvpipe.party/manual/rust/)):

```rust
let mut s = tvpipe::stream(Options::new().to("Living Room").video(1280, 720, 60, PixelFormat::Rgba))?;
s.write_video(&frame, s.elapsed())?;
```

## Features

- Plays files and URLs, and mirrors cameras, capture cards, the screen, a
  window or a browser tab, with sound; suitable files are sent without
  re-encoding.
- Puts a web page on the TV, rendered in a headless browser of its own.
- Sends to several receivers at once, on one timeline, and to browser tabs
  (previews, OBS, video calls), also on a public link (`--tunnel`).
- Takes raw or H.264 frames and sound from a game on stdin.
- Runs party games: the TV shows the game, everyone plays on their phone
  ([the games](https://tvpipe.party/games/)).
- One self-contained binary for macOS, Linux and Windows, with its own mDNS,
  protocol stacks and H.264/AAC encoders.

## Documentation

- [The manual](https://tvpipe.party/manual/): installing, receivers,
  playing, sharing, public links, party games, every command and option,
  diagnostics.
- [The games](https://tvpipe.party/games/), and
  [making one](https://tvpipe.party/manual/making-games/)
  ([`docs/games.md`](docs/games.md) has the details).
- [`ARCHITECTURE.md`](ARCHITECTURE.md): how and why tvpipe works;
  [`docs/`](docs/): protocols, formats, designs, measurements, releasing.

## Development

```sh
cargo build --release        # → target/release/tvpipe (Rust 1.85+, a C compiler)
cargo fmt --all && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace
```

| Path | |
|---|---|
| [`crates/tvpipe`](crates/tvpipe/) | the library (Apache-2.0) |
| [`crates/tvpipe-cli`](crates/tvpipe-cli/) | the `tvpipe` command |
| [`crates/tvpipe-fairplay`](crates/tvpipe-fairplay/) | the FairPlay port (LGPL), behind the library's `fairplay` feature |
| [`npm/tvpipe`](npm/tvpipe/) | the Node SDK, `@tvpipe/sdk` |
| [`npm/party`](npm/party/) | `@tvpipe/party`, the browser library for games |
| [`games/`](games/) | the party games, each released on its own |
| [`site/`](site/) | the website and the manual |

[`AGENTS.md`](AGENTS.md) lists the checks to run before committing;
releasing is in [`docs/game-catalog.md`](docs/game-catalog.md#releasing).

## License

`tvpipe`'s source is Apache-2.0 ([`LICENSE`](LICENSE)), except the
FairPlay crate [`crates/tvpipe-fairplay/`](crates/tvpipe-fairplay/), a port
of [doubletake](https://github.com/omarroth/doubletake) under
LGPL-3.0-or-later, which is only built with the `fairplay` feature. The
distributed binary includes it, so it is under LGPL-3.0-or-later terms.

The root certificates in `crates/tvpipe/src/net/roots/` (for the `--tunnel` service's
HTTPS) are Mozilla's list from the CCADB, under CDLA-Permissive-2.0 (see
[`LICENSES/CDLA-Permissive-2.0-ccadb.txt`](LICENSES/CDLA-Permissive-2.0-ccadb.txt)).

Some H.264 encoder tables (`crates/tvpipe/src/media/h264enc/tables.rs`) are transcribed
from [openh264](https://github.com/cisco/openh264) (BSD-2-Clause), and the
fonts in `crates/tvpipe/src/browser/fonts/` (also used by the website) are under the SIL
Open Font License 1.1. The license texts are in [`LICENSES/`](LICENSES).
