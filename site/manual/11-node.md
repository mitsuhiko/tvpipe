---
title: From Node.js
summary: Stream from your own program with the @tvpipe/sdk npm package.
group: Use
spec:
  Package: `@tvpipe/sdk` (npm)
  Node: 22 or newer
  Example: `npm/tvpipe/examples/canvas-tone.ts`
---

The `@tvpipe/sdk` npm package controls tvpipe from Node. It plays files, URLs, the test pattern and web pages, and streams frames and sound that your program makes: a canvas, raw pixels, or H.264 from WebCodecs.

```sh
$ npm install @tvpipe/sdk
```

:::aside The binary
npm installs it for your platform as `@tvpipe/<os>-<cpu>`. Set `TVPIPE_BINARY` to use another one. `npx -p @tvpipe/sdk tvpipe` runs the command line tool.
:::

## Play something

```js
import { play, testPattern, share } from "@tvpipe/sdk";

const session = await play("movie.mp4", { to: "Living Room" });
await session.done;

await testPattern({ to: ["Kitchen", "browser"] });
await share("https://status.example.com", { to: "Kitchen", reload: 30 });
```

`to` takes the same forms as `--to` on the command line ([Receivers](receivers.md)), a `Device` from `discover()`, or a list of them. If you leave `to` out, tvpipe uses the only receiver on the network that can show video. If there are several, the error lists them.

## Frames from your program

:::aside No ffmpeg
Frames from code use tvpipe's own H.264 encoder, which also makes keyframes on demand.
:::

```js
import { stream } from "@tvpipe/sdk";

const s = await stream({
  to: "Living Room",
  video: { width: 1280, height: 720, fps: 30, format: "rgba" },
  audio: { sampleRate: 48000, channels: 2 },
});
s.drawLoop(canvas, (ctx, timeMs) => draw(ctx, timeMs)); // or s.writeVideo(rgba)
s.writeAudio(samples);                                   // Float32Array or Int16Array
```

When tvpipe falls behind, video frames are dropped, not queued, so the stream stays real time. For H.264 you encode yourself, create the stream with `codec: "h264"` and pass each WebCodecs chunk to `s.writeChunk(chunk, metadata)`. When a receiver needs a keyframe, the session emits a `keyframe` event.

## Sessions and errors

```js
session.on("receiver", (r) => console.log(r.name, r.state));
await session.stop();
```

- **Stopping.** `stop()`, an `AbortSignal` or `await using` stops the session. Every receiver gets the same clean teardown as with Ctrl-C.
- **Seeking and pausing.** `play()` of a file, or of a URL with a length, returns a `PlaySession`: `seek(ms)`, `seekBy(ms)`, `pause()` and `resume()`. `session.playback` and the `playback` event say where it is.
- **When your program dies.** If it exits or crashes, tvpipe notices and stops by itself.
- **Errors.** Every error is a `TvpipeError` with a readable message and a stable `code`, such as `pairing-required` or `ffmpeg-missing`.

## Public links

```js
const p = await preview("movie.mp4", { player: { tunnel: true } });
console.log(p.publicUrl); // anyone with it can watch

const s = await share({ to: "TV", tunnel: "opentunnel", yes: true });
console.log(s.publicUrl); // someone elsewhere opens it and shares to the TV
```

`tunnel: true` uses Cloudflare, `"opentunnel"` OpenTunnel, as `--tunnel` does. `session.publicUrl` is the link. A session has no terminal to ask in, so remote shares need `yes: true`. See [Public links](links.md).

## Pairing

```js
import { pair } from "@tvpipe/sdk";

await pair("Living Room", {
  onPin: ({ name, password }) => askUser(password ? `AirPlay password of ${name}?` : `PIN on ${name}?`),
});
```

Pass `onPin` to `play()` and the other functions, and a receiver that needs pairing is paired when it is first used. Pairings live in tvpipe's config directory ([Configuration](config.md)), the same one the command line tool uses. The `configDir` option points elsewhere.

## Other languages

The package uses `tvpipe --machine`: JSON events on standard output, commands on standard input. Any language can drive tvpipe the same way. The protocol is in [docs/machine.md](https://github.com/mitsuhiko/tvpipe/blob/main/docs/machine.md).
