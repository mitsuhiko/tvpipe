---
title: Commands and options
summary: Every command, and the options they share.
group: Reference
spec:
  Commands: `play`, `preview`; `share`, `screen`
---

Every command lists all of its options with `--help`.

## Commands

| Command | Does |
|---|---|
| `discover` | Lists the receivers on the network. See [Receivers](receivers.md). |
| `pair`, `unpair` | Pairs with an AirPlay receiver (an Apple TV's PIN or a TV's AirPlay password), or forgets the pairing. |
| `play` | Plays a file or URL, or mirrors a camera or the screen. See [Playing media](play.md). |
| `screen` | Mirrors a screen or a window, with the computer's sound. See [Sharing the screen](screen.md). |
| `share` | Shares a browser tab or a web page. See [Sharing the screen](screen.md#s3) and [A web page on the TV](web-page.md). |
| `preview` | Plays in a browser tab. See [Playing to a browser](browser.md). |
| `game play` | Plays a party game: a web app on the TV, phones join with a QR code. See [Party games](party.md). |
| `game fetch`, `game list` | Downloads a game from the internet without playing it, or lists the downloaded ones. See [Games from the internet](party.md#s1). |
| `game new`, `game check`, `game pack` | Starts a party game, checks it, or packs it into a zip. See [Making party games](making-games.md). |
| `debug` | `pattern`, `pipeline`, `tunnel`, `qr`. See [Debug commands](debug-commands.md). |

## Streaming

:::aside Everywhere
`-v` More output.

`--debug` Protocol traces.
:::

| Option | Effect |
|---|---|
| `--to NAME|ADDR` | Where to send. Repeat for several receivers. |
| `--size WxH` | The largest picture size. |
| `--fps N` | Frames per second. |
| `--bitrate KBPS` | Video bitrate. |
| `--encoder NAME` | The video encoder, below. |
| `--no-audio` | Picture only. |
| `--loop` | Start over at the end. |
| `--realtime`, `--no-realtime` | Read the input at playback speed, or not. Files are read at playback speed. |
| `--reconnect SECS` | How long to reconnect a receiver that dropped out. Default 120, `0` is off. |
| `--latency MS` | How long receivers wait before they show a frame. See [Latency](latency.md). |
| `--raw-video`, `--raw-audio` | Frames and sound on standard input. See [Game input](games.md). |
| `--ffmpeg PATH` | The ffmpeg to use. |

## Browser player

These need `--to browser`.

| Option | Effect |
|---|---|
| `--open` | Open the player page. |
| `--port PORT` | The port of the player page. Default 8765. |
| `--wait-for-viewer` | Wait for a tab before starting. |
| `--new-token` | A new address for the player page. Old ones stop working. |
| `--tunnel[=PROVIDER]` | Also on a public link: `cloudflare`, the default, or `opentunnel`. See [Public links](links.md). |
| `--tunnel-ttl MIN` | New viewers can join over the link for MIN minutes. |
| `--no-qr` | No QR code of the public link in the terminal. |

## Share page

These need `share` without a URL.

| Option | Effect |
|---|---|
| `--tunnel[=PROVIDER]` | The share page on a public link. See [Public links](links.md). |
| `--tunnel-ttl MIN` | The link lets people in for MIN minutes. Default 60, `0` is no limit. |
| `-y`, `--yes` | Show a share from elsewhere without asking first. |
| `--no-qr` | No QR code of the public link in the terminal. |

## Encoders

:::aside Hardware
The hardware encoders need an ffmpeg built with them.
:::

| Value | Encoder |
|---|---|
| `auto` | Picks one. The default. |
| `builtin` | tvpipe’s own encoder. |
| `x264` | Software, on every platform. |
| `videotoolbox` | macOS hardware. |
| `nvenc` | NVIDIA hardware. |
| `qsv` | Intel Quick Sync. |
| `vaapi` | Linux VA-API. |
| `mf` | Windows Media Foundation. |
