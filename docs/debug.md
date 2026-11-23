# Debug commands

`tvpipe debug` groups the commands for testing tvpipe and the things
around it: `debug pattern`, `debug pipeline`, `debug tunnel` and
`debug qr`. How to use them, with their options and examples, is the
manual's [Debug commands](https://tvpipe.party/manual/debug-commands/)
page (source: `site/manual/21-debug-commands.md`); `tvpipe debug COMMAND
--help` lists every option. This file only points at what lies behind
them in the repository.

| Command | Code | More |
|---|---|---|
| `debug pattern` | `media/builtin.rs` (the picture, the beep and the built-in encoder); `session.rs` (a `play` session whose input is the pattern) | [`measurements.md`](measurements.md): the latencies measured with it |
| `debug pipeline` | `media/debug.rs` | `scripts/check-pipeline.sh` compares its frames with `ffprobe -show_packets` and checks SLRW input with `examples/slrw-gen.rs` |
| `debug tunnel` | `net/tunnel.rs`, `net/cftunnel/`, `net/opentunnel.rs` | [`tunnels.md`](tunnels.md): providers, tokens, what the server must check |
| `debug qr` | `util/qr.rs` (Nayuki-checked vectors) | the SDK's `qr()` runs `debug qr --rows` |

With `--machine` ([`machine.md`](machine.md)), `debug pattern` and
`debug tunnel` emit events like any session; their `hello` keeps the
names the commands had before the `debug` group (`test-pattern`,
`tunnel`), so the protocol did not change. `debug qr` refuses
`--machine`; `debug pipeline` prints text, so run it without.
