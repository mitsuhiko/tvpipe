# Machine interface (`--machine`)

For programs that drive tvpipe: the Node SDK (`@tvpipe/sdk`, source in `npm/tvpipe`), and anything
else that can spawn a process and read lines. Protocol version **1**.
Code: `crates/tvpipe-cli/src/machine.rs`; the events are the Rust
library's `tvpipe::Event`, one `to_json()` line each
(`crates/tvpipe/src/events.rs`), emitted at their sources (`session.rs`,
`session/rejoin.rs`, `media/fanout.rs`, `browser/player.rs`,
`airplay/pair.rs`). Tests: `crates/tvpipe-cli/src/machine/tests.rs`,
`crates/tvpipe-cli/tests/machine.rs` (the real binary). Golden vectors,
which the Node SDK's tests read: `crates/tvpipe/tests/vectors/machine/`
(every event type, and recorded sessions).

```sh
tvpipe --machine debug pattern --to browser --port 0
```

`--machine` is a global flag (before the command). It changes only the
stdio contract; the commands and their options stay the same:

- **stdout**: events, one JSON object per line, nothing else.
- **stdin**: SLRW records ([`slrw.md`](slrw.md)) with one more kind,
  `command`. Writers start with the magic `SLRW` for every command.
- **stderr**: only what happens before the flag is read (argument
  errors from the parser, exit status 2) and panics. Logs are `log`
  events.

## Events

Every event has a `type`; names are snake_case. Readers ignore types and
fields they do not know: new ones do not change the protocol version.
The library's `Event::Progress` (steps and `game play`'s news for the
terminal UI, [`terminal-ui.md`](terminal-ui.md)) and `Stats::video_bytes`
are not part of the protocol: `--machine` does not write them.

The first event is `hello`. A command ends with `end` (exit status 0) or
`error` (exit status 1); `end` may be followed by `log` events and, when
the session failed after the stream ran (every receiver failed, the input
broke), by an `error`.

| `type` | When | Fields |
|---|---|---|
| `hello` | first | `protocol` (1), `version`, `command` (`play` also for `preview`; `share`, `screen`, `discover`, `pair`, `unpair`; the `debug` commands keep their old names: `test-pattern` for `debug pattern`, `tunnel` for `debug tunnel`, `debug-pipeline`) |
| `log` | each log line at the active level (`-v`: debug, `--debug`: trace) | `level` (`error`, `warn`, `info`, `debug`, `trace`), `module`, `message` |
| `receiver` | a receiver changes state | `name`, `protocol` (`cast`, `airplay`, `browser`; on `connected`/`failed` while connecting), `state`, `error` and `code` (with `failed`, `lost`, `gave-up`), `delay_ms` (with `connected`: the playout delay it shows video with, ms after the frame's instant; the TV's own lag comes on top) |
| `player` | a `--to browser` page listens | `name`, `url` |
| `viewer` | a tab connects to or leaves the page | `name`, `tab` (number), `state` (`connected`, `disconnected`), `public` (it came over the tunnel); optional: `address` (over the tunnel, the visitor's address when the tunnel knows it), `country` (over a Cloudflare tunnel, two letters from `cf-ipcountry`), `browser` (from the user agent: "Safari 18 on iPhone") |
| `share-page` | `share` without URL listens | `url` (open it, press Share) |
| `tunnel` | `--tunnel` or `debug tunnel PORT`: the public link works | `page` (`player`, `share`, `port`), `name` (the player's), `provider` (`cloudflare`, `opentunnel`), `url` (with its token) |
| `capture` | `share`, `share URL` or `screen`: the browser started sharing | `surface` (`monitor`, `window`, `browser`), `label`, `width`, `height` (the capture's), `audio` (it has sound) |
| `connected` | the receivers are connected; the input opens next (SLRW is read from here on) | `receivers` (names) |
| `started` | the input is open and the receivers started | `route` (`passthrough`, `ffmpeg`, `builtin`, `encoded`, `browser`), `video` (`codec`, `width`, `height`, `fps`), `audio` (list of `codec`, `sample_rate`, `channels`), `latency_ms` |
| `keyframe` | a receiver needs an IDR (encoded SLRW with keyframe requests on, see below) | |
| `stats` | every second while frames flow | `elapsed_ms`, `video_frames`, `audio_frames`, `receivers` (`name`, `pushed`, `dropped`, `dropped_full`, `dropped_waiting`) |
| `playback` | `play` of a file or a URL with a length: once streaming started (it can seek and pause), then after each seek, pause and resume ([`playback.md`](playback.md)) | `position_ms` (a seek's: where it landed), `duration_ms` (if known), `paused` |
| `devices` | `discover` (instead of the table or `--json`) | `devices`: the `discover --json` objects |
| `pin-required` | `pair` needs the PIN the TV shows, or its AirPlay password | `name`, `address`, `password` (true: it shows no PIN and the answer is its password, taken as given but for a line ending; a PIN is trimmed) |
| `paired` | `pair` succeeded and the pairing verified | `name`, `model`, `file` (the credentials file) |
| `unpaired` | `unpair` forgot a pairing | `name`, `id` |
| `end` | the command is over | `reason` (`eof`, `stopped`, `receivers-gone`, `error`; `done` for commands without a stream); with a stream also `receivers` (`name`, `end`: `stopped`/`ended`/`failed`, `error`, the stats fields) |
| `error` | the command failed | `kind`, `code` (optional), `message`, `device` (optional) |

`share --tunnel` asks on the terminal before a remote share reaches the
receivers; in machine mode there is no terminal, so remote shares are
refused unless `--yes` is given.

Receiver states: `connected`, `failed` (could not resolve, connect or
start, or failed mid-stream), `lost` (connection lost, reconnecting with
`--reconnect`), `reconnected`, `gave-up` (reconnecting failed), `ended`
(the receiver's user ended the session), `stopped` (tvpipe stopped it).
With several receivers one that fails does not end the session.

`kind` is one of `io`, `malformed`, `protocol`, `crypto`, `auth`,
`unsupported`, `timeout`, `not-found`, `closed`, `process`, `usage`,
`unimplemented`. `code` is stable and set where the case is known:

| `code` | |
|---|---|
| `pairing-required` | an AirPlay receiver needs `pair` first; `device` is the name to pass to `pair` |
| `home-only` | an AirPlay receiver whose advertisement says its Apple Home takes only the home's members (`acl=1`; `home_only` in `discover`): from `pair` and from a session without a stored pairing, before connecting, and from a session whose stored pairing got 403; the message names the Home app's setting; `device` is its name |
| `forbidden` | an AirPlay receiver answered the session 403 after pairing (the message names the Home setting, the one known cause), or a Mac whose AirPlay Receiver allows only its current user (`act=2`), from `pair` and from a session without a stored pairing (the message names that setting); `device` is its name. In a build without FairPlay, from a receiver that offers it, the code is `fairplay-required` |
| `password-unsupported` | an AirPlay receiver answered the session 401 after pairing: it wants its password as HTTP Digest, which tvpipe does not send; the message says to turn Require Password off; `device` is its name |
| `no-receiver` | no receiver of that name was found; `device` is the name |
| `input-not-found` | the input file does not exist |
| `ffmpeg-missing` | the input needs ffmpeg and there is none |
| `pin-missing` | `pair` asked for a PIN and stdin ended |
| `bad-input` | stdin is not valid SLRW |
| `fairplay-required` | an AirPlay receiver needs FairPlay and this build has none (programs using the Rust library without its `fairplay` feature; the released binary always has it) |

A `receiver` event with `failed` carries the same `code` (e.g. one of
several receivers needs pairing).

## Commands

In machine mode stdin always carries SLRW: the magic, then records. Kind
**6 `command`** is added: `pts_us` is ignored, the payload is one UTF-8
JSON object of at most 64 KiB.

| Command | |
|---|---|
| `{"type":"stop"}` | stop now, without playing out what is queued; receivers get their TEARDOWN/STOP; exit status 0 |
| `{"type":"pin","pin":"1234"}` | the answer to `pin-required` (the PIN or the password) |
| `{"type":"navigate","url":"https://…"}` | `share URL`: show this page in the same tab (an `http(s)://` or `file://` URL, or a host name, as the `URL` argument); the receivers keep their sessions and the page shares again (`log` lines say so). Refused (another command, a scheme tvpipe does not open, Google Meet): a `warn` log line |
| `{"type":"seek","position_ms":N}`, `{"type":"seek","by_ms":N}` | `play` of a file or a URL with a length: jump to `N` ms, or by `N` ms (negative: back); files sent unchanged land on a keyframe near it, forward jumps stop 3 s before the end. A `playback` event says where it landed. Refused (live input, not streaming yet): a `warn` log line |
| `{"type":"pause"}`, `{"type":"resume"}` | the same inputs: pause (the receivers keep the picture, without sound) and play on; a `playback` event follows |

Unknown commands are logged and ignored. Outside machine mode kind 6 is an
error like any unknown kind.

A thread reads stdin from the start, so commands work in every phase
(discovery, connecting, `--wait-for-viewer`, streaming):

- **SLRW input** (`play -`): media records go to the input once it opens
  (after `connected`), through a short queue: a writer that outpaces the
  encoder sees a full pipe. Records that arrive earlier are dropped (live
  frames would be stale), except the last `h264-config` and the last
  `control`, which reach the input first; if that `control` turned
  keyframe requests on, a `keyframe` event follows at once (the keyframe
  the writer sent before was dropped).
- **EOF** (the parent closed the pipe, exited or crashed): with an open
  SLRW input, the end of the stream (what is queued plays out, then
  teardown, `reason` `eof`); otherwise a stop request. tvpipe never
  outlives its parent, and the receivers still get a clean stop. An `end`
  record before the input opened is a stop request too.
- Without SLRW input, media records are ignored.
- Bad framing (no magic, an unknown kind, an oversized or truncated record)
  stops the session with an `error` (`code` `bad-input`).

Commands share the pipe with media, so a `stop` waits behind at most the
queue while the input consumes; a program should still kill tvpipe if it
does not exit within a few seconds.

## Keyframe requests

The `keyframe\n` lines that encoded SLRW input writes to stdout
([`slrw.md`](slrw.md#keyframe-back-channel)) become `keyframe` events. As
without `--machine`, the writer turns them on with a `control` record.

## Why stdin

It is the one channel every OS has between a parent and its child: no
port, no token, no fd passing, and its EOF tells tvpipe that the parent is
gone. Signals are no option on Windows (a child without its own console
cannot be sent Ctrl-C or Ctrl-Break by a library).
