# Architecture

This document explains how `tvpipe` works and why it works that way. How to
use it is in the [manual](https://tvpipe.party/manual/) (sources in `site/manual/`). More
detail lives in `docs/`:

- [`slrw.md`](docs/slrw.md): the game input format.
- [`machine.md`](docs/machine.md): `--machine`, the interface for
  programs (the Node SDK).
- [`terminal-ui.md`](docs/terminal-ui.md): what people see in the
  terminal by default (`-v` for the developer log) and how it is fed.
- [`share-protocol.md`](docs/share-protocol.md) and
  [`player-protocol.md`](docs/player-protocol.md): the browser pages.
- [`measurements.md`](docs/measurements.md): latency and experiments.
- [`debug.md`](docs/debug.md): the `tvpipe debug` commands (test pattern,
  pipeline dump, tunnel, QR) and the code and scripts behind them.
- [`cross-platform.md`](docs/cross-platform.md): what was checked on which
  OS.
- [`meet.md`](docs/meet.md): presenting into video calls.
- [`playshare-design.md`](docs/playshare-design.md): party games as web
  apps (`tvpipe game play`, the browser library `@tvpipe/party`, the demo
  game `games/drawbluff`); [`party-protocol.md`](docs/party-protocol.md):
  what phones and the host page say; [`party-design.md`](docs/party-design.md):
  the first design (a Node host), for its reasoning and measurements;
  [`games.md`](docs/games.md): building, checking, packing and running
  a game (`tvpipe game`); [`game-switching.md`](docs/game-switching.md):
  one run, several games (the room stays, phones follow);
  [`browser-party-design.md`](docs/browser-party-design.md): party
  games without tvpipe, on tvpipe.party in the browser (designed).
- [`screen.md`](docs/screen.md): sharing a screen or a window with
  sound (`tvpipe screen`): Chrome's capture per OS, the ffmpeg fallback,
  native APIs assessed.
- [`airplay-mirroring.md`](docs/airplay-mirroring.md): the clean-room
  AirPlay mirroring spec.

## Scope

tvpipe is a Rust library (`crates/tvpipe`, the `tvpipe` crate) with the
`tvpipe` command on top of it (`crates/tvpipe-cli`). Programs link the
library to stream their own frames, or run the command with
[`--machine`](docs/machine.md) (the Node SDK does). The library has no
process-wide state besides an optional log handler: each session has its
own stop token, events and storage for pairings
([`docs/rust-sdk-design.md`](docs/rust-sdk-design.md)).

`tvpipe` is a **sender** only. It pushes video and audio to receivers over
their **real-time mirroring** protocols: AirPlay screen mirroring, and Cast
Streaming (the Chromecast mirroring app, RTP/RTCP over UDP). It does not use
URL playback, because that path cannot reach low latency.

One more receiver lives on the same machine: `--to browser` serves a
player page on 127.0.0.1 that decodes the stream with WebCodecs and plays
it in a browser tab, on the same timeline as the TVs (see
[Browser Player](#browser-player); for users:
[Playing to a browser](https://tvpipe.party/manual/browser/)).

What the receivers take:

| | Video | Audio |
|---|---|---|
| AirPlay mirroring | H.264 (HEVC partly specified) | ALAC (incl. *verbatim*, i.e. PCM in an ALAC frame); AAC-ELD/AAC-LC per the format mask |
| Cast Streaming | H.264, VP8, VP9, HEVC, AV1 | AAC, Opus (no PCM) |
| Browser player | H.264 | PCM |

All of them want one timestamp per frame, sent in presentation order, so
in practice **no B-frames**. tvpipe sends H.264 everywhere.

## One Code Path for Every OS

`tvpipe` uses only `std::net`, `std::process` and `std::fs`. It uses no OS
media frameworks, no discovery services and no interface APIs.

- **Capture** is delegated to ffmpeg.
- **Discovery** uses our own mDNS client.
- **Encoding** is done by ffmpeg or by our own encoders.

As a result, the binary behaves the same on macOS, Linux and Windows and should enable a consistent experience across all of them.

Formats and protocols are written by hand and tested against oracles. Only
the hard cryptography comes from `ring`, and TLS from `rustls`. Any other
dependency needs the human's approval first.

## Session Lifecycle

A session runs in five steps:

1. **Probe the input.** MP4/MOV/MKV files are probed with our own demuxers,
   anything else with `ffprobe`.
2. **Connect every receiver before any input starts.** AirPlay runs as far
   as the audio SETUP, and Cast through OFFER/ANSWER. At that point every
   receiver's capabilities are final.
3. **Choose the input** (see [Inputs](#inputs)). If an encode is needed,
   plan it from the minimum size, frame rate and bitrate across all
   receivers, with one audio plan per family.
4. **Start the sinks, then pull the input.** Live sources wait until every
   sink is ready, so the first frames are not stale.
5. **Stream, then tear down.** Teardown happens on EOF (after one playout
   delay), on Ctrl-C, or when every receiver has left. Every sink sends
   TEARDOWN or STOP.

A device that advertises both protocols goes over Cast unless the user
writes `airplay:`.

## Inputs

**Passthrough.** A file is sent unchanged, without ffmpeg, when it meets all
of these:

- H.264,
- no B-frames,
- a keyframe at least every 4 s,
- a size, frame rate and pixel rate the receivers accept (a Cast
  receiver's `maxPixelsPerSecond`; an encoded stream keeps its frame rate
  and gets smaller instead), and
- compatible audio.

B-frames are refused because Cast's in-flight window breaks on frames that
go back in time. The openscreen receiver only tolerates frames stamped with
decode time because it maps pictures FIFO. Long GOPs are refused because a
single drop costs a whole GOP. `-v` logs why a file did not pass.

**ffmpeg** handles everything else. It runs as a subprocess that writes
**live Matroska** to a pipe, which we demux ourselves.

- Matroska carries every codec we need and stores H.264 as AVCC.
- Flags: `-bf 0`, a fixed GOP, and low-latency flags for each encoder.
- The GOP is 1 s, or 0.5 s when an AirPlay receiver is present.
- A subprocess cannot produce keyframes on demand, so the short GOP bounds
  how long recovery takes.
- `-readrate_initial_burst 0.001` stops ffmpeg's start-up burst from
  overrunning Cast's window.
- Arguments after `--` go straight to ffmpeg, which is how capture works
  without platform code in `tvpipe`. The commands for each OS are in
  [Playing media](https://tvpipe.party/manual/play/).

**Built-in encoders.** The test pattern always uses them (unless an ffmpeg
encoder is named: then ffmpeg's `testsrc2` is streamed instead). Raw game
frames use them with `--encoder builtin` or when ffmpeg is missing. Files,
URLs and capture always need ffmpeg when they are not passed through.

- The H.264 encoder is Constrained Baseline:
  - CAVLC entropy coding,
  - I and P pictures,
  - rate-distortion mode decisions,
  - deblocking and VBV rate control,
  - one slice per thread.
- Its purpose is **keyframes on demand** with one picture of latency, which
  no subprocess can offer.
- The AAC-LC encoder lets PCM reach Cast receivers without ffmpeg.
- Both were written from the ITU/ISO specs. Copyleft encoders (x264,
  ffmpeg, FAAC, fdk-aac) were deliberately not read. ffmpeg is used only as
  a black-box decoder in tests.

**Game input (SLRW)** is the format a game writes to `tvpipe`'s stdin: the
magic `"SLRW"`, then records of `u8 kind | u64le pts_us | u32le len |
payload`. The full format is in [`docs/slrw.md`](docs/slrw.md), the
user's view in [Game input](https://tvpipe.party/manual/games/).

- **Raw frames** go to the built-in encoder, or to ffmpeg through two
  localhost TCP listeners. That works the same on every OS, with no fd
  passing and no named pipes.
- **Encoded H.264** is for engines with their own hardware encoder. When a
  receiver needs an IDR, `tvpipe` writes `keyframe\n` to its own stdout,
  which the game already owns. No port is needed. Requests are coalesced
  and rate-limited.

**Browser capture** (`tvpipe share`) serves a page that captures with
`getDisplayMedia`, encodes with WebCodecs and sends the same records as
encoded SLRW over a localhost WebSocket, so it takes the same path
(passthrough video, PCM or built-in AAC). Protocol:
[`docs/share-protocol.md`](docs/share-protocol.md); for users:
[Sharing the screen](https://tvpipe.party/manual/screen/). Receivers stretch what
they get to fill their screen, so sinks report their screen shape
(`Capabilities::display_aspect`: Cast from the ANSWER's `display`, else
16:9, AirPlay from the SETUP canvas; `None` for the browser player, which
fits any shape) and the page centers the capture in a frame of that shape,
or keeps the capture's shape when only browser players watch.

**Headless browser** (`tvpipe share URL`) starts a Chromium-based browser
of its own (a separate profile, headless unless `--visible`) and drives it
over the DevTools protocol, or Firefox over WebDriver BiDi. Its viewport is
the stream size, so the tab fills the frame. After every navigation the
capture script is evaluated in the page as a user gesture, and the page
shares its own tab (Chrome: `--auto-accept-this-tab-capture`; Firefox:
getUserMedia's `browser` and `audioCapture` sources, enabled by the
profile's preferences). The page may reach 127.0.0.1 because tvpipe
bypasses its CSP (Firefox: drops the header from intercepted responses)
and grants Local Network Access. A navigation, reload or crash replaces
the document; the share server's rejoin mode lets the next one continue
the stream, and since the page clock is wall-clock time the timeline only has a gap. A keeper thread
re-shares, reloads crashed pages, restarts a dead browser, and quits it
and deletes the temporary profile at the end. Nothing is disguised: sites
that refuse automated browsers do not work. For users:
[A web page on the TV](https://tvpipe.party/manual/web-page/).

**Screen capture** (`tvpipe screen`) uses the same machinery for the
desktop: tvpipe's own browser (a small normal window, since desktop
capture does not work headless) opens a capture page of the share
server, and `getDisplayMedia` is answered by Chrome's `--auto-select-*`
switches (the main screen, `Screen N`, or a window whose title contains
a string) with the system sound ticked; a window gets its app's sound
where the OS allows (macOS 14.2+, Windows 11). Once it shares, the window
is minimized and the stream is `share`'s. Without such a browser (or
with `--engine ffmpeg`) ffmpeg captures, with per-OS input arguments
built as strings (sound only on Linux). Why, and what works on which OS:
[`docs/screen.md`](docs/screen.md).

The WebSocket, HTTP bits, base64 and the DevTools client are hand-rolled;
the pages are static files embedded in the binary.

## Party Games (playshare)

`tvpipe game play GAME` (`crates/tvpipe/src/playshare/`, the `playshare`
feature) runs a game that is a web app: a folder or a zip (our own zip
reader and inflate, `util::zip`, `util::inflate`) with `tvpipe.json`
naming its host, TV and phone pages. Design and protocols:
[`docs/playshare-design.md`](docs/playshare-design.md).

- **Two listeners** on 127.0.0.1: the local one (the window's launcher and
  host page, the TV page, the API) and the public one (phones; a tunnel
  connects to it, `--lan` adds one on the LAN address). The public side
  has no API at all. Both check `Host` (421) and WebSocket `Origin` (403);
  the API also a per-run token (an `HttpOnly` cookie set by the window's
  first URL, or `?t=`).
- **The window** is an app window (`--app`) of tvpipe's own
  Chromium-based browser with a temporary profile, watched over DevTools:
  when its last page closes, playshare ends. Without such a browser, the
  system's browser opens the URL and the end comes 30 s after the last
  page went away.
- **The local API** is one WebSocket: JSON calls and events (discovery
  with `Discovery`, AirPlay pairing with `Pairing`, a QR code, the
  launcher's choice of TVs, casting) and the relay.
- **Casting** is `share URL` on the bundle's TV page: tvpipe's headless
  browser renders it and the session streams the tab to the receivers,
  with the reconnect window and the browser's crash restart. Only pages of
  the local origin can be cast.
- **The relay** hands every client WebSocket (`/_tvpipe/ws`) to the host
  page: `open`/`close`/`busy`/`drain` as JSON, data as binary frames
  (`op | conn | payload`) on the API socket. tvpipe enforces only generic
  limits (message size, rate, connections, upgrades per address, a 1 MiB
  backlog per client, pings); rooms, keys, names, views and actions are
  the browser library's (`npm/party`, built into
  `playshare/web/` and served at `/_tvpipe/lib/`). When the host page goes
  away clients are closed with 1012 (they reconnect); at the end with
  4011, after a second for the host's goodbyes; the cast is stopped
  (TEARDOWN/STOP), the browsers quit, the tunnel closes.
- **A run is a session, the game sits in a slot** (`Hub::put`;
  [`docs/game-switching.md`](docs/game-switching.md)): the listeners,
  tunnel, short link, TV choice and the room (code and join key) last the
  run; the games list (`playshare/picker.rs`, served by the local
  listener) fills the slot first when no game was given, and again from
  the host page's "Other game". The next game closes the relay's clients
  with 4014 (phones go to their join link, now the next game's) and the
  pages follow a `game` event; its TV page goes into the running cast's
  tab (`Session::navigate`: the receivers keep their sessions). A folder of games (or several paths) is
  listed first, the online list below.
- **Tunnels**: OpenTunnel first (its identity is made once and reused, so
  frequent runs create nothing), Cloudflare if it fails; `--no-tunnel`.
- **Short links** (`playshare/shortlink.rs`): the host page asks for
  `tvpipe.party/CODE` for the tunnel's join link (`shortlink` on the API);
  tvpipe registers it with the service (`apps/tvpipe-party`, over
  `net::fetch`), refreshes it every 6 h and deletes it at the end;
  `--no-short-link`, `TVPIPE_PARTY_URL`. The QR code and the short
  link lead to the frame page `tvpipe.party/p#…` (a static page that
  frames the tunnel's phone page; `info.phone.frame`, and
  `frame-ancestors` on the phones' listeners). Design:
  [`docs/short-links.md`](docs/short-links.md).
- **`tvpipe game pack`, `check`, `new`** (`playshare/check.rs`, `scan.rs`, `smoke.rs`,
  `tool.rs`; [`docs/games.md`](docs/games.md)) checks a game the way
  playshare loads it, plus what its pages load: tolerant scanners for
  HTML, CSS and JS module imports (`scan`) followed from the entry pages,
  not parsers, so they never fail and report only literal URLs. It packs
  a folder into a deterministic zip (`util::zip_write`, our own deflate
  in `util::deflate`: hash-chain LZ77, the cheapest of stored, fixed and
  dynamic blocks) and reads it back before writing. `--smoke` runs the
  game with a stand-in receiver backend and a headless browser over
  DevTools, and joins with a fake phone over the relay. `game new` writes
  the starter game embedded from `playshare/template/`.
- **Games from the internet** (`playshare/source.rs`, `remote.rs`,
  `cache.rs`; `net/fetch.rs` on `net/tls.rs`, the rustls dialer the
  tunnels share): a game named by URL, `gh:OWNER/REPO[/ASSET][@TAG]` or a
  name from the games list (`games.json` on the website) is downloaded
  with a blocking HTTPS client (redirects, size caps, streamed to a file
  with its SHA-256), kept in the cache directory (`storage::cache_dir`,
  `games/`), and run only after the person said yes to that source and
  hash (or `--yes`, or a `#sha256=` pin). GitHub release streams in one
  repository (`drawbluff-v*`) are told apart by tag prefix and a
  `<!-- tvpipe: X.Y -->` marker in the notes. Phones' listeners refuse
  service-worker scripts. Design: `docs/playshare-design.md` §18.
- **Surfaces** (`playshare/surface.rs`): a page encodes a canvas with
  WebCodecs and sends SLRW records over `/_tvpipe/surface`; tvpipe feeds
  them to a `Stream` (the program's-own-H.264 path) per surface, with
  keyframe requests back. No second browser; one surface per TV. Measured
  against the tab path and recommended for canvas games:
  [`docs/playshare-design.md`](docs/playshare-design.md) §17.

## Timing and Latency

- **A media clock** maps presentation timestamps to wall-clock instants,
  anchored on the first frame. It re-anchors when frames are more than
  100 ms late (a stalled source) or 1 s early (a jump). One clock serves
  the whole session (see [Several Receivers](#several-receivers)).
- **AirPlay PTP** runs without a PTP stack. The receiver's
  `X-Apple-RequestReceivedTimestamp` response header is on its PTP
  timeline. Every `/feedback` response (every 2 s) re-anchors our mapping.
  Legacy receivers get an NTP responder instead.
- **Cast** derives RTP timestamps from the media clock. Sender Reports map
  RTP time to NTP time for A/V sync.
- **Defaults** are in the budget table below. Cast uses 300 ms rather
  than openscreen's 200 ms because Wi-Fi feedback gaps overflowed the
  in-flight window at 200 ms. AirPlay alone uses its automatic "wireless"
  profile because the spec's 85 ms audio lead glitched on the Apple TV.

Measured glass to glass: ~250 ms on an Apple TV 4K over Wi-Fi. Details
and other measurements: [`docs/measurements.md`](docs/measurements.md);
the test pattern and how to measure: [Latency](https://tvpipe.party/manual/latency/).

## Several Receivers

**One timeline.** The fanout owns the session's `MediaClock` and schedules
every frame on it as it leaves the input, before any per-sink queueing.
Each sink gets a read-only view (`Sink::set_clock`, before `start()`) and
pins the frame's scheduled instant right before pushing it, so every
receiver presents a frame at the same instant even when one sink thread
ran late. A sink that falls behind does not move everyone's timeline; its
frames just have less headroom. AirPlay maps the instant to PTP/NTP, Cast
to RTP plus Sender Reports, the browser sends it as is. Receivers are
still not frame-locked: each has its own decode pipeline and clock
mapping error.

**One budget.** The delay from the shared capture instant to presentation
is the same everywhere:

| Session | Cast target delay | AirPlay leads (video / audio) | Browser |
|---|---|---|---|
| `--latency L` | L | L / L | L |
| Cast present, no `--latency` | 300 ms | 300 / 300 ms | 300 ms |
| An LG TV with sound, no `--latency` | 300 ms | 300 / 300 ms | 300 ms |
| AirPlay only, no `--latency` | — | automatic, 100 / 170 ms | 100 ms |
| Browser only, no `--latency` | — | — | 100 ms |

`L` is clamped to 5–2000 ms, which both protocols accept. Mixed with Cast,
AirPlay takes the shared budget instead of its automatic profile, which
would show every frame 200 ms before the Cast TV (MediaDataControl only
runs with the automatic leads). An LG TV's sound needs 300 ms and
`latencyMin` set to the lead (spec §2.7); its advertisement says LG, so
the whole session takes 300 ms. An LG given by address is known only
after `/info`: it takes 300 ms, the others keep theirs.

**Partial failures.** A `--to` that cannot be resolved or connected is
logged and left out; the session goes on with the others and fails only
when none is left. Targets resolve and connect in parallel. A receiver
ending the session, or a sink failing mid-stream for another reason than
a lost connection, removes that sink; the session ends when every
receiver is gone.

**Reconnecting** (`--reconnect SECS`, default 120 s, `crates/tvpipe/src/session/rejoin.rs`).
A sink whose connection is lost (an `Io`, `Closed` or `Timeout` error
from `push`) keeps its place in the fanout: its frames are dropped while
a worker thread connects again with backoff (1 s, doubling to 30 s)
until the window ends. A receiver given by name is resolved again with
the same protocol (`cast:NAME`, `airplay:NAME`), since a TV that changed
its address is only found by mDNS; an address is retried as it is. The
new connection runs the whole setup again (Cast: TLS, LAUNCH, an OFFER
from the session's options with only the running audio codec; AirPlay:
pair-verify with the stored credentials, FairPlay, SETUP), must take the
running stream (codec, size, frame rate, audio family; else it stays
dropped, logged), gets the session clock and the running stream's
`VideoInfo`/`AudioInfo`, and starts at a keyframe the wrapper asks the
fanout (and so the input) for. The other sinks never notice. How a loss
is told from the receiver ending the session:

| | Ended (not reconnected) | Lost (reconnected) |
|---|---|---|
| Cast | `CLOSE` from the app, a status without the mirroring app | control channel closed without `CLOSE`, heartbeat timeout, no RTCP for 5 s while RTP goes out, UDP unreachable |
| AirPlay | the receiver closes the video data connection (EOF or a reset over unread frames) | control connection broken, write timeouts, no answer to `/feedback` for 7 s, other data-connection errors |

A receiver that vanished cannot close a connection, so a close is taken
as the receiver's decision; whether an Apple TV that changes its address
closes its connections first is untested on hardware.

## Browser Player

`--to browser` (and `tvpipe preview`) is a sink like the others. It
serves a page on 127.0.0.1 behind a token and a loopback `Host` check, and sends each tab the decoder configuration, then one SLRW record
per WebSocket message: H.264 access units and PCM, each stamped with the
frame's instant on the session clock. The page learns tvpipe's clock by
ping/pong, decodes with `VideoDecoder`, and presents video and audio
(Web Audio) one playout delay after that instant, like the TVs. Each tab
has its own queue and writer thread, so a slow tab only drops its own
frames. The URL (port and token) stays the same across runs, so an open
tab or an OBS source picks up the next session. Protocol:
[`docs/player-protocol.md`](docs/player-protocol.md); for users:
[Playing to a browser](https://tvpipe.party/manual/browser/). Presenting the tab
into video calls, and why tvpipe does not join Meet by itself:
[`docs/meet.md`](docs/meet.md).

## Fanout

Each sink gets a bounded queue and its own thread, so a slow receiver never
stalls the others. The rules:

- New sinks start by waiting for a keyframe.
- When a queue overflows, the frame is dropped. If it was video, the sink
  waits for the next keyframe again.
- When a sink needs a keyframe (after a PLI, loss, or a full writer), it
  drops non-key video until the next IDR and forwards the request to the
  input.
- A failed sink is removed and the others continue; one that lost its
  receiver is first reconnected (see [Several Receivers](#several-receivers)).

## Adaptive Bitrate

An input that can change its bitrate while it runs follows the network:
the browser pages (`share`, `screen`, a game's TV picture; WebCodecs
takes a new bitrate on a configured encoder) and the built-in encoder.
ffmpeg cannot (a subprocess), and passthrough and a game's own H.264 have
nothing to change. The plan's bitrate (`--bitrate` or the default) is the
start and the ceiling.

- **Signal.** Each sink reports a backlog (`Sink::backlog`): how long its
  oldest video that is not through yet has waited, against the delay at
  which frames come late or are dropped, and a count of frames dropped
  because the network was behind. AirPlay: the writer's queue and a write
  that does not return (TCP: the kernel's send buffer hides up to its size
  more), against the video lead. Cast: the media sent and not
  acknowledged, against the in-flight window. The fanout adds its own
  queue; a sink that tells nothing gets 500 ms.
- **Controller** (`media/abr.rs`). Like CoDel, the least backlog over
  500 ms is the standing queue, so a keyframe or a burst of feedback does
  not count. A drop or a standing backlog past the limit cuts the bitrate
  to 60 %, one past 30 % of the limit to 80 % (then waits 1 s); 3 s below
  10 % raise it by 6 % a second (2 % within 10 % of where the last cut
  came), up to the plan. The floor is an eighth of the plan, at least
  500 kbit/s. The slowest receiver decides: there is one encode.
- Cuts are logged at info (`bitrate: 1414 kbit/s (Apple TV is 210 ms
  behind)`), raises at debug.

## Discovery

`tvpipe` uses **legacy-unicast mDNS** (RFC 6762 §6.7): queries go to
`224.0.0.251:5353` from an ephemeral port, and responders reply by unicast.
We never bind 5353, never clash with mDNSResponder, Avahi or Windows, and
need no OS service.

To find the local address without interface APIs, we connect a UDP socket
(which sends nothing) and read back the address the OS picked. AirPlay, RAOP and Cast records of the
same TV are merged into one device. Using `discover` and `--to`:
[Receivers](https://tvpipe.party/manual/receivers/).

## AirPlay

The sender is built from a clean-room spec, plus pyatv (MIT) for pairing.

- **Pairing:**
  - HAP PIN pair-setup uses SRP-6a (3072-bit group, SHA-512).
  - Transient pair-setup uses PIN 3939 for open receivers.
  - Pair-verify uses X25519 and Ed25519.
  - Afterwards the control channel is ChaCha20-Poly1305 framed. It
    implements `Read + Write`, so the RTSP code runs on it unchanged.
  - Credentials live in a small text file (`credentials.txt`, see
    [Configuration](https://tvpipe.party/manual/config/)).
- **FairPlay** is an **LGPL port of doubletake** in its own crate
  (`tvpipe-fairplay`, the `fairplay` feature), isolated behind a tiny API
  so it can be replaced later.
- **Session setup** runs everything up to the audio SETUP while connecting,
  so the canvas is known before encoding starts. The video SETUP happens at
  stream start. The Apple TV tolerates the gap between them.
- **Video** goes over TCP: 128-byte headers, a codec packet, encrypted
  frames, and heartbeats.
  - A writer thread owns the socket, so `push` never blocks.
  - HAP sessions encrypt with ChaCha20-Poly1305.
  - Legacy sessions use AES-CTR from the FairPlay key.
- **Audio** is *verbatim ALAC*: PCM wrapped in ALAC frames, 44.1 kHz, 352
  samples per frame, sent as encrypted RTP. Sync packets and retransmits
  are handled. No audio encoder is needed.
- **Receiver quirks** are handled in one place: PTP falling back to NTP
  (retried once on a fresh connection), audio format, latency leads, and
  initial volume.
- **Legacy receivers** (third-party TVs): unpaired candidates (no HAP
  pairing bit, or feature bit 26/51) try raw pair-setup first and fall
  back to HAP; transient pair-setup tries `X-Apple-HKP` 3 or 4 depending
  on the receiver and retries the other once. The legacy media profile
  (plaintext control, AES-CTR video, AES-CBC audio, NTP) is implemented
  but only loop-tested.

## Cast

The sender is ported from Chromium's **openscreen** (BSD-3), with
attribution.

- **Control.**
  - TLS on port 8009 through rustls. The verifier accepts self-signed device
    certificates but still checks the handshake signature. Device auth is
    skipped.
  - Messages are protobuf-framed `CastMessage`s with a heartbeat. We
    advertise protocol versions 0 and 3, as real Google TVs require.
- **Session.**
  - LAUNCH the mirroring app `0F5096E8`, then OFFER/ANSWER.
  - The receiver only answers an OFFER, so the OFFER is built from user
    options **before** the encode is planned. The offer only caps size and
    bitrate, so a smaller final plan is fine.
- **Media.**
  - Each frame is converted to Annex B, encrypted whole with AES-128-CTR,
    and packetized as Cast RTP.
  - Opus uses 10 ms frames. AAC is sent ADTS-framed, as Chromium does.
- **Feedback** mirrors openscreen's sender:
  - ACK/NACK handling,
  - an in-flight limit derived from RTT,
  - kickstarts,
  - PLI handling.

  The feedback logic does no I/O and takes time as an argument, so it can
  be tested deterministically.
- **Not done:** device authentication (`tp.deviceauth`; Chromecasts do not
  require it from senders). The Android TV payload-type hack (127/96) is
  off by default (`CastOptions::android_rtp_hack`); if some TV needs it,
  it should become a flag or a per-model quirk.

## Platform-Specific Code

Everything is platform-neutral except these, each with no crate and every
`unsafe` block carrying a SAFETY comment:

- **Ctrl-C** (`crates/tvpipe/src/signals.rs`, the opt-in `signals` feature;
  the CLI enables it). Ctrl-C must send TEARDOWN or STOP,
  or the TV stays in mirroring mode. std cannot install a signal handler,
  and ffmpeg (in our process group) dies from the same signal, so the
  fallback "tear down on ffmpeg's EOF" does not work either. It uses the C
  runtime std already links:
  - Unix: `signal(SIGINT/SIGTERM)` with a handler that only does an atomic
    swap. One code path for every Unix.
  - Windows: `SetConsoleCtrlHandler`.

  A second Ctrl-C exits immediately (after a `before_forced_exit(f)`
  cleanup, if a program registered one; then a third does). The library
  never installs it by itself: a program calls
  `tvpipe::signals::stop_on_signal(stopper)` (or `on_signal(f)`). In the
  CLI (`crates/tvpipe-cli/src/interrupt.rs`), `q` also stops, using std
  only (only when stdin is a terminal, not SLRW; while something is
  watched the first `q` asks). On a stop the session does not drain:
  every sink's `stop()` runs and ffmpeg is killed and reaped.
  Ctrl-C/SIGTERM exits with 130, `q` with 0.
- **`q` without Enter** (`crates/tvpipe-cli/src/tty.rs`): the CLI runs
  `stty -icanon -echo min 1 time 0` on its terminal and `stty` with what
  `stty -g` printed when it ends (also on errors, panics, a second Ctrl-C,
  and around prompts that read a line). A command, not an OS API: where
  there is none, or it changes nothing (Windows consoles), `q` needs
  Enter.
- **Windows timer resolution** (`crates/tvpipe/src/util/timer.rs`). Windows ends timed
  waits on the 15.6 ms system tick, which made Cast pacing bursty.
  `timeBeginPeriod(1)` (winmm, once per process, no `timeEndPeriod`: since
  Windows 10 2004 it ends with the process) is called from `main`,
  `session::play_with` and the fake receivers. Measurements:
  [`docs/measurements.md`](docs/measurements.md#windows-timer-resolution).
- **Paths:** `cfg(target_os)` for the config and cache directories
  (`crates/tvpipe/src/storage.rs`; the cache holds games fetched from the
  internet) and for the
  well-known browser install paths (Chromium-based and Firefox) and the
  browsers' own profile directories, which `tvpipe share URL --profile` refuses
  (`crates/tvpipe/src/browser/platform.rs`).
- **Starting `tvpipe screen`'s browser on macOS** (`crates/tvpipe/src/browser/platform.rs`,
  `own_app_command`): through `open -n -g -a APP --args ...` instead of
  as a child. macOS gives screen and system-audio recording to the
  "responsible" app; as tvpipe's child the browser counts as the
  terminal, whose missing "System Audio Recording" permission made the
  sound silent. A command, not an OS API; quitting it goes over DevTools
  (then `kill` by pid).

Other Windows differences (UDP `ConnectionReset`, `shutdown` not waking a
blocked `recv`, socket timeouts per handle, PowerShell pipes) are handled in portable code; see
[`docs/cross-platform.md`](docs/cross-platform.md).

## Licensing and Clean Room

- **Licenses.** `tvpipe` is Apache-2.0, except the FairPlay crate
  (LGPL-3.0-or-later), which only the opt-in `fairplay` feature pulls in.
  The released binary includes it and is distributed under LGPL terms.
- **FairPlay** is a port of doubletake's SAP implementation in its own
  crate, `crates/tvpipe-fairplay/` (LGPL-3.0-or-later SPDX headers and
  attribution in every file; `src/aes.rs` there is a copy of our Apache-2.0
  AES), bytes in, bytes out (`FpSession`: `m1`, `m3`, `check_m4`,
  `wrap_key`) so a clean-room version can replace it. The `/fp-setup`
  requests (`airplay/session.rs`) and the stream-key derivation
  (`airplay/keys.rs`) are written from the spec. Nothing outside that
  crate may copy from it.
- **Without FairPlay** (the feature off), a receiver offering it with the
  HAP profile gets the §5.3 placeholders (what the Apple TV accepts); the
  legacy profile, or a receiver refusing the session after FairPlay was
  skipped, fails with `fairplay-required`.
- **Tainted sources** are read only by a dirty-room spec writer and by the
  FairPlay porter; whoever writes code outside `crates/tvpipe-fairplay`
  works from the spec, [`docs/airplay-mirroring.md`](docs/airplay-mirroring.md),
  and its vectors:

  | Class | Sources | Who may read them |
  |---|---|---|
  | Permissive: read and port with attribution | openscreen (BSD-3), pyatv (MIT), pychromecast (MIT), node-castv2 (MIT), rust_cast (MIT), RFCs and public specs | everyone |
  | Tainted: dirty room only | doubletake (LGPL-3.0+), UxPlay and RPiPlay (GPL-3.0), playfair (GPL), airfry (MIT, but a port of doubletake), RottingApple (MIT, but bundles GPL playfair and a doubletake-derived helper), shairport-sync (check its license first) | spec writers and the FairPlay porter |
  | Black box | running doubletake, its test receiver, UxPlay or an oracle harness as external processes | everyone (behaviour, not source) |
- **Encoders** were written from ITU-T H.264 and ISO/IEC 14496-3; some
  tables come from openh264 (BSD-2) with attribution.
- **AirPlay mirroring** was implemented from a reviewed prose spec plus test
  vectors.
- **Permissive references** (openscreen, pyatv, pychromecast, RFCs, ITU/ISO
  specs) are ported with attribution.
- **Provenance.** Protocol commits carry a `Sources:` line.

## Testing

- **Known-answer tests** cover every hand-written format and algorithm.
  The vectors come from FIPS/NIST, RFCs, Python, `plutil`, `protoc`,
  `ffprobe`, and captures from real devices (with device identifiers
  scrubbed).
- **Fuzz smoke tests** check that decoders never panic.
- **Oracle tests** require ffmpeg to decode the H.264 encoder's output
  bit-exactly to the encoder's own reconstruction. They are skipped without
  ffmpeg.
- **Fake receivers** run in process for Cast (with injected loss), AirPlay
  mirroring and pairing. Full `play` sessions run against them.
- **`tvpipe debug pipeline INPUT`** runs ffmpeg and the demuxer and prints
  every frame, without a receiver.
- **Opt-in tests** against openscreen's `cast_receiver` and the Apple TV run
  with `--ignored` and `TVPIPE_*` variables.
- **CI** runs fmt, clippy and the tests on Linux, macOS and Windows. What
  was checked by hand on which OS: [`docs/cross-platform.md`](docs/cross-platform.md).
- **Isolation.** Unit tests use scratch config and cache directories
  (`target/test-tmp/`) and never browse the real network, unless
  `TVPIPE_ATV` (hardware tests) or `TVPIPE_LIVE_MDNS` is set.

## Code Conventions

- **Core types** in `crates/tvpipe/src/types.rs` (`EncodedFrame`, `VideoInfo`,
  `AudioInfo`, `Capabilities`, `Encoder`, the plans, `Sink`, …) are
  shared by every module. Changing anything public there goes through the
  owner; adding helper methods is fine.
- **Errors:** one crate-wide `Error { kind, msg, source }` with
  `ErrorKind` and `Result<T>` (`crates/tvpipe/src/error.rs`). Modules may use private
  error enums but convert at their public boundary. Malformed input is
  `ErrorKind::Malformed` with the format name as prefix (`"dns: ..."`).
  Data from the network or from ffmpeg never panics.
- **Parsing** goes through `util::bytes::Reader` (bounds-checked, never
  panics); `Writer` for output.
- **Timestamps:** video pts in 90 kHz ticks, audio pts in sample ticks.
- **Video payloads** are AVCC (4-byte length prefixes) everywhere inside
  tvpipe; Cast converts to Annex B at the edge.
- **Test vectors** are `key = value` blocks (blank-line separated, `#`
  comments, indented continuation lines) under `crates/tvpipe/tests/vectors/<module>/`
  (`util::vectors`); binary fixtures under `crates/tvpipe/tests/fixtures/<module>/`.
- **Logging** uses the `error!`/`warn!`/`info!`/`debug!`/`trace!` macros
  from `crates/tvpipe/src/log.rs`; `play` writes nothing but SLRW keyframe requests to
  stdout. By default people see only `warn!` lines (as `!` lines,
  [`docs/terminal-ui.md`](docs/terminal-ui.md)): write them short and
  say what to do; what people should see besides goes out as an event,
  not as an `info!` line.
- **Naming:** the project was called streamlib before it became tvpipe.
  An existing `…/streamlib` config directory is moved over once on first
  use; the SLRW magic and some fixtures keep the old name on purpose.

## Known Gaps

- **Untested hardware:** Samsung AirPlay, LG models other than the
  OLED65C5 of `docs/airplay-mirroring.md` §10, and the legacy AirPlay
  pairing and media profile (including the no-FairPlay variant, which
  sends random `shk`/`shiv` and audio in the clear).
- **Cast:** testing on real hardware is in progress.
- **Not implemented:** HEVC, AAC-ELD (so AAC files are re-encoded for
  AirPlay), HTTP Digest for password-protected AirPlay receivers,
  adaptive bitrate for ffmpeg, a game's own H.264 and surfaces
  (`tvpipe.surface()`), and IPv6 discovery.
- **B-frames** on real receivers are still untested.
- **Further ffmpeg-free paths** were considered and not taken: OS encoders
  (VideoToolbox, Media Foundation, VAAPI) break the platform-neutral rule;
  an `openh264`/libopus crate needs a dependency; Cast "remoting" mode
  would pass most files through on Cast at higher latency and with a
  second, larger protocol.
