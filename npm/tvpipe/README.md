# @tvpipe/sdk: tvpipe for Node

Stream video and audio from Node to **Apple TV / AirPlay**, **Chromecast /
Google Cast** and **browser tabs**, with low latency: files, URLs, web
pages, a test pattern, or frames your program draws (a canvas, raw RGBA,
H.264 from WebCodecs) with sound.

```sh
npm install @tvpipe/sdk
```

It drives the [tvpipe](https://github.com/mitsuhiko/tvpipe) binary,
which npm installs for your platform: macOS, Linux and Windows on x64 and
ARM64. You don't need to set anything up. Node 22 or newer. No runtime
dependencies.

```js
import { play } from "@tvpipe/sdk";

const session = await play("movie.mp4");   // the only TV on the network
await session.done;                         // until the end of the movie
```

## Receivers

```js
import { discover } from "@tvpipe/sdk";

for (const d of await discover({ timeout: 3000 })) {
  console.log(d.name, d.protocols, d.model, d.paired);
}
```

`to` accepts:

- a name (`"Living Room"`, or a unique prefix of one, any case);
- `"airplay:NAME"` or `"cast:NAME"` to pick the protocol of a TV that
  speaks both;
- an address (`"192.168.1.20"` is Cast, `"192.168.1.20:7000"` is
  AirPlay);
- `"browser"`, a player page on this computer (`session.playerUrl`);
- a `Device` from `discover()`;
- a list of any of these, to play on all of them at once, in sync.

Without `to`, tvpipe uses the only receiver with video on the network.
If there are several, the error lists them.

## Files, URLs, the test pattern, web pages

```js
import { play, testPattern, preview, share } from "@tvpipe/sdk";

await play("movie.mkv", { to: "Living Room", loop: true });
await play("https://example.com/live.m3u8", { to: ["Kitchen", "Office"] });
await play({ ffmpeg: ["-f", "avfoundation", "-i", "1:0"] }, { to: "TV" }); // capture

await testPattern({ to: "TV" });                 // clock, frame counter, beep
const p = await preview("movie.mp4");            // a browser tab
console.log(p.playerUrl);

await share("https://status.example.com", { to: "TV", reload: 30 }); // headless Chromium
```

The test pattern, frames from code, and MP4/MKV files with H.264 that
tvpipe can send unchanged need no ffmpeg. Other files, URLs and capture
devices need [ffmpeg](https://ffmpeg.org) in `PATH` (or `ffmpeg:
"/path"`). If ffmpeg is missing, the error has the code `ffmpeg-missing`.
`share(url)` needs Chrome, Edge, Chromium or Brave. Its session can show
another page in the same tab: the TVs keep their sessions and the picture
pauses for a moment (about 0.2 s) instead of starting over:

```js
const s = await share("https://status.example.com", { to: "TV" });
s.navigate("https://status.example.com/next"); // a log warning if tvpipe refuses it
```

## Frames from code

```js
import { stream } from "@tvpipe/sdk";

const s = await stream({
  to: "Living Room",
  video: { width: 1280, height: 720, fps: 30, format: "rgba" },
  audio: { sampleRate: 48000, channels: 2 },
});

s.writeVideo(rgbaBytes);        // timestamps default to "now"
s.writeAudio(float32Samples);   // interleaved; Int16Array works too
// ...
await s.end();                  // play out what was written, then stop
```

- **Canvases**: `s.writeCanvas(canvas)` sends one picture.
  `s.drawLoop(canvas, (ctx, timeMs) => draw(ctx, timeMs))` draws and sends
  at the frame rate. Any canvas with `getContext("2d").getImageData`
  works: [canvas](https://www.npmjs.com/package/canvas),
  [skia-canvas](https://www.npmjs.com/package/skia-canvas),
  [@napi-rs/canvas](https://www.npmjs.com/package/@napi-rs/canvas),
  OffscreenCanvas.
- **Backpressure**: when tvpipe falls behind, `writeVideo` drops the frame
  and returns `false` (`s.dropped.video` counts them). A live source stays
  real time and memory stays bounded. To send every frame, `await
  s.drain()` instead. Audio is never dropped.
- **Encoder**: the built-in H.264 encoder by default. It needs no ffmpeg
  and gives keyframes on demand. `encoder: "auto"` (or `x264`,
  `videotoolbox`, `nvenc`, …) uses ffmpeg instead.
- **H.264 you encode yourself**: create the stream with `video: { width,
  height, fps, codec: "h264" }`, then pass WebCodecs output to
  `s.writeChunk(chunk, metadata)`, or access units to `s.writeH264(au, {
  keyframe })`. Answer the `keyframe` event with an IDR frame:

  ```js
  s.on("keyframe", () => (forceKey = true));
  encoder.encode(frame, { keyFrame: forceKey });
  ```

An example with a moving picture and a tone:
[`examples/canvas-tone.ts`](https://github.com/mitsuhiko/tvpipe/blob/main/npm/tvpipe/examples/canvas-tone.ts).

## Sessions

`play`, `testPattern`, `preview` and `share` resolve once streaming has
started. `stream` resolves once the receivers are connected. All of them
return a `Session`:

```js
session.on("receiver", (r) => console.log(r.name, r.state)); // connected, lost, reconnected, ended, …
session.on("stats", (s) => console.log(s.videoFrames));       // every second
session.on("log", (l) => console.log(l.level, l.message));
session.receivers;   // Map: name → { protocol, state, error }
session.info;        // video size, frame rate, audio, latency
await session.stop(); // the TV leaves mirroring
await session.done;   // resolves when the session ends, rejects if it fails
```

`await using session = await play(...)` stops it at the end of the scope.
`signal: abortController.signal` stops it on abort. If a TV drops out
(Wi-Fi, a new address), it is reconnected for up to `reconnect` seconds
(120 by default) while the others keep playing.

If your program exits or crashes, tvpipe notices that its stdin closed.
It stops the TVs cleanly and exits.

## Public links

```js
const p = await preview("movie.mp4", { player: { tunnel: true } });
console.log(p.publicUrl); // https://….trycloudflare.com/?t=…: anyone with it can watch

const s = await share({ to: "TV", tunnel: "opentunnel", yes: true });
console.log(s.publicUrl); // someone elsewhere opens it and shares their screen to the TV
```

`tunnel: true` uses a Cloudflare quick tunnel, `"opentunnel"` OpenTunnel
(TLS ends in tvpipe). The link is new every session; `tunnelTtl` limits
how long it lets people in (minutes). The command line asks on the
terminal before a remote share reaches the TV; a session has no terminal,
so pass `yes: true` or remote shares are refused. The `tunnel` event and
`viewer` events (`public: true`) tell you what happens. Details:
[docs/tunnels.md](https://github.com/mitsuhiko/tvpipe/blob/main/docs/tunnels.md).

### Any server, and QR codes

```js
import { tunnel, qr } from "@tvpipe/sdk";

const t = await tunnel({ port: 8080 });          // or provider: "opentunnel"
console.log(t.url);                              // https://….trycloudflare.com/ → http://127.0.0.1:8080
const code = await qr(t.url);                    // code.size, code.rows, code.dark(x, y), code.svg()
await t.stop();
```

`tunnel()` puts any server on 127.0.0.1 on a public link (`tvpipe debug
tunnel PORT`). The server decides who may do what: requests arrive with `t.host`
as `Host`, WebSockets with `Origin: https://${t.host}`. `qr()` returns the
QR code of a text as data, for a page or a frame of your own.
Party games are web apps for `tvpipe game play` ([`@tvpipe/party`](../party/README.md)).

## Apple TV pairing

Some AirPlay receivers show a PIN the first time:

```js
import { pair } from "@tvpipe/sdk";

await pair("Living Room", {
  // `password`: the TV shows no PIN and wants its password instead.
  onPin: async ({ name, password }) => await ask(password ? `Password of ${name}?` : `PIN shown on ${name}?`),
});
// or let a session pair when it needs to:
await play("movie.mp4", { to: "Living Room", onPin: ({ name }) => ask(name) });
```

Pairings are stored in tvpipe's config directory (`credentials.txt`), the
same one the `tvpipe` command line tool uses:

| | |
|---|---|
| macOS | `~/Library/Application Support/tvpipe` |
| Linux | `$XDG_CONFIG_HOME/tvpipe` (`~/.config/tvpipe`) |
| Windows | `%APPDATA%\tvpipe` |

Pass `configDir` to keep them somewhere else, e.g. in your app's data
directory. The file holds a private key.

## Errors

Every failure is a `TvpipeError` with a readable `message` and a stable
`code`:

| `code` | |
|---|---|
| `no-receivers`, `ambiguous-receiver` | `to` was omitted and there is no single TV (`details.devices` lists them) |
| `no-receiver` | no receiver with that name was found |
| `pairing-required` | an Apple TV needs `pair()` (or `onPin`); `device` names it |
| `home-only` | an AirPlay receiver in an Apple Home takes only the home's members (`device.homeOnly`); the message says what to change in the Home app |
| `forbidden` | an AirPlay receiver refused pairing, or verified the pairing and refused the session (403); the message says what that may mean |
| `password-unsupported` | an AirPlay receiver wants its password as HTTP Digest after pairing (401), which tvpipe does not send; the message says to turn Require Password off |
| `input-not-found`, `ffmpeg-missing` | the input |
| `binary-missing`, `unsupported-platform` | the binary is not installed (see below) |
| `aborted`, `usage`, `invalid-argument`, `exited`, … | |

`error.log` holds tvpipe's last log lines.

## Options

All options are optional.

| Option | |
|---|---|
| `to` | receivers (above) |
| `latency` | playout delay in ms, the same on every receiver (default: Cast 300, AirPlay automatic or 600 with sound on a non-Apple TV, browser 100) |
| `size`, `fps`, `bitrate` | output limits (`"1280x720"`, frames per second, kbit/s) |
| `audio: false` | video only |
| `reconnect` | seconds to reconnect a lost receiver (0: off) |
| `player` | the browser page: `{ port, open, waitForViewer, newToken, tunnel, tunnelTtl }`; the port defaults to any free one |
| `tunnel`, `tunnelTtl`, `yes` | `share()` without URL: the share page on a public link (above) |
| `onPin` | pair receivers that need it |
| `signal`, `stopTimeout` | stop on abort; how long `stop()` waits before killing tvpipe |
| `logs` | mirror tvpipe's log to stderr (`true` or a level) or a function |
| `verbose` | debug logs (`"trace"`: protocol traces) |
| `configDir`, `env`, `binary` | where pairings live, the environment, a tvpipe binary to use |

## The binary

npm installs the binary as an optional dependency for your platform:
`@tvpipe/darwin-arm64`, `@tvpipe/darwin-x64`, `@tvpipe/linux-x64`,
`@tvpipe/linux-arm64`, `@tvpipe/win32-x64` or `@tvpipe/win32-arm64`. The
Linux binaries are static, so they also work on Alpine. If you install
with `--omit=optional`, or copy a lockfile made on another platform, the
binary is missing and you get a `binary-missing` error. To use a binary
you built or installed yourself, set `TVPIPE_BINARY=/path/to/tvpipe` (or
pass the `binary` option). The package also installs the command line tool:
`npx tvpipe ...` in a project that depends on it, or `npx -p @tvpipe/sdk
tvpipe ...` anywhere.

## License

Apache-2.0. The binary packages are Apache-2.0 AND LGPL-3.0-or-later,
because the binary includes an LGPL module (see the
[repository](https://github.com/mitsuhiko/tvpipe)).
