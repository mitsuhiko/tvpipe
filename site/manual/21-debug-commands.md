---
title: Debug commands
summary: The test pattern, checking an input, a public link for any port, QR codes.
group: Development
spec:
  Commands: `debug pattern`, `debug pipeline`; `debug tunnel`, `debug qr`
---

For development and testing: `tvpipe debug` groups the commands that are not about playing something. `tvpipe debug COMMAND --help` lists every option.

## debug pattern

:::aside Built in
The pattern needs no ffmpeg.
:::

`tvpipe debug pattern` streams a test pattern: colour bars, the UTC time in milliseconds, a frame counter, and a flash and a beep every second. tvpipe draws and encodes it itself. [Latency](latency.md) shows how to measure the delay with it.

```sh
# tvpipe debug pattern --to NAME|ADDR [OPTIONS]
$ tvpipe debug pattern --to TV
$ tvpipe debug pattern --to TV --to Kitchen --latency 300
$ tvpipe debug pattern --to browser --open
```

| Option | |
|---|---|
| `--to NAME|ADDR` | Where to stream. Repeat it for several receivers. `browser` is the [player page](browser.md). |
| `--size WxH`, `--fps N`, `--bitrate KBPS` | The picture. |
| `--latency MS` | How long receivers wait before they show a frame. |
| `--encoder NAME` | `auto` by default, which is tvpipe's own encoder. An ffmpeg encoder (`x264`, `videotoolbox`, …) streams ffmpeg's `testsrc2` instead. |
| `--no-audio` | No beep. |

The other streaming options and the player options work as with `play`. See [Commands and options](options.md).

## debug pipeline

`tvpipe debug pipeline` reads an input the way `play` does, without a receiver, and prints what arrives. First comes the ffmpeg command line, then one line per track and per frame (time stamp, keyframe, size, arrival time), and then a summary per track. Without an input it reads ffmpeg's test source.

```sh
# tvpipe debug pipeline [OPTIONS] [INPUT | - | -- FFMPEG_INPUT_ARGS...]
$ tvpipe debug pipeline movie.mp4
$ tvpipe debug pipeline --raw movie.mp4
$ tvpipe debug pipeline -- -f avfoundation -i 1:0
```

| Option | |
|---|---|
| `--raw` | No encoding: the frames as they are in the file. |
| `--raw-video`, `--raw-audio` | Frames and sound on standard input (`-`). See [Game input](games.md). |
| `--ffmpeg PATH` | The ffmpeg to use. |

## debug tunnel

`tvpipe debug tunnel PORT` puts a server of your own on `127.0.0.1:PORT` on a public https link, for example a web app on port 8080. The link is new every run. It works until you stop tvpipe with Ctrl-C or `q`.

```sh
# tvpipe debug tunnel PORT [--tunnel=PROVIDER] [--no-qr]
$ tvpipe debug tunnel 8080
$ tvpipe debug tunnel 8080 --tunnel=opentunnel
```

| Option | |
|---|---|
| `--tunnel=cloudflare` | A Cloudflare quick tunnel, the default. |
| `--tunnel=opentunnel` | OpenTunnel: TLS ends on this computer. |
| `--no-qr` | No QR code of the link in the terminal. |

Your server answers everything that comes in, so it decides who may do what. Requests carry the public name as `Host`, and WebSockets carry it as `Origin`. The providers are explained in [Public links](links.md).

## debug qr

`tvpipe debug qr TEXT` prints a QR code of a text or a link.

```sh
# tvpipe debug qr [--svg | --rows] TEXT
$ tvpipe debug qr https://example.com
$ tvpipe debug qr --svg https://example.com > link.svg
```

| Option | |
|---|---|
| `--svg` | An SVG document instead of the terminal drawing. |
| `--rows` | One line of `0` and `1` per row, for programs. |
