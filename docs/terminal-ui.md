# The terminal UI

What a person sees when they run `tvpipe` in a terminal, and how it is
made. Code: `crates/tvpipe-cli/src/ui/` (`mod.rs` owns the process's one
renderer and writes stderr, `render.rs` turns events into bytes,
`term.rs` decides what the terminal can do, `tests.rs` and
`snapshots/` show every case).

## Three modes

| Mode | When | stderr |
|---|---|---|
| people | the default | a title, one line per thing that happened, links with QR codes, a status line |
| developer log | `-v` (debug), `--debug` (trace), `TVPIPE_LOG=error\|warn\|info\|debug\|trace` | timestamped log lines, as before (`TVPIPE_LOG=info` is the old default) |
| machine | `--machine` | nothing; JSON events on stdout ([`machine.md`](machine.md)) |

`debug pipeline` keeps the developer log at info by default (its log is
part of its report). stdout stays for data in every mode: discover's
list, `game play --window none`'s URL, SLRW keyframe requests.

## What people see

```
tvpipe · Sharing your screen

! The browser tab plays the shared sound again (an echo): mute it, or use --no-audio
✓ Chrome started (0.7 s)
✓ Capturing your screen · 6016×3384 with sound (1.5 s)

  Watch on this computer
  http://127.0.0.1:61868/?t=…

✓ Public link ready (5.3 s)

  Anyone with this link can watch
  https://….trycloudflare.com/?t=…&delay=300

  <QR code>

  Cloudflare quick tunnel · a new link every run

● Live · 3840×2160 · 30 fps · 12.5 Mbit/s · 1 viewer · 00:03:12    q to stop
```

- A **title** names what runs (`tvpipe · Playing movie.mkv`, `· Test
  pattern`, a game's own title).
- One line per result, with a symbol: `✓` done (with how long it took
  from half a second on), `•` a note, `!` a warning, `✗` an error, `?` a
  question. Technical details (browser versions, capture and encode
  plans, ports, keyframes) are left to `-v`.
- **Links** get a block: a label, the URL on its own line, the QR code
  for links another device opens, a footnote saying what carries it;
  blank lines around.
- On a terminal, the **status line** at the bottom is redrawn in place:
  a spinner and the step while something takes a while ("Opening a
  public link… 3 s"), then the stream's numbers (size, measured frame
  rate and bitrate, who watches, the time) or a game's (phones, the
  cast), "Stopping…" after a stop request; how to stop at the right.
  Lines are printed above it.
- **`q`** stops (see [Keys](#keys)); while something is watched or
  played, the first `q` turns the status line into a question:
  `? Stop streaming? Press q again to stop, any other key to keep going`
  (`Stop playing?` for a file, `End the game? … to end it, … to keep
  playing` for `game play`).
- At the end one line: `Stopped. Streamed 00:03:12 to Living Room TV.`,
  `✓ Done. Played 00:42:10 to Living Room TV.`; a failure is `✗ what:
  why` and, below, what to try (by the error's stable `code`:
  `no-receiver` → `tvpipe discover`, `pairing-required` → `tvpipe pair
  NAME`, `home-only` → the Home app's Allow Speaker & TV Access, …; usage errors → `tvpipe CMD --help`). Exit codes do not change.

`discover` prints its list on stdout: the receivers tvpipe streams to
(name, Google Cast/AirPlay, model, address, paired, needs pairing or
needs pairing (password) or, without a pairing, home members only), then,
for TVs whose Apple Home takes only its members, the Home app's setting
to change,
then the speakers it does not stream to, by name, and how to use one.
`--json` is unchanged.

## Where it comes from

The UI never parses log lines. It is fed by:

- **Events** (`tvpipe::Event`), the same the machine interface writes,
  plus [`Event::Progress`](../crates/tvpipe/src/events.rs) for people's
  front ends, which `--machine` does not write: steps that take a while
  (`Begin`/`Done`/`Failed` of `Find`, `Connect`, `Browser`, `Window`,
  `Tunnel`, `Capture`, `Viewer`, `Discover`) and `game play`'s news
  (its title and links, phones, the cast). `Stats::video_bytes` (not on
  the wire either) gives the bitrate.
- **Warnings** from the log (`warn!`), shown as `!` lines: the leading
  component tag (`browser: `) is dropped and the first word capitalised
  when it is a plain word. So a `warn!` text is for people: short, saying
  what to do. `error!` lines are not shown (each is followed by a
  receiver event or the command's error); `info!` and below are for `-v`.

Receiver failures while connecting are held until it is clear whether
the session goes on (others still connecting or connected: shown at
once), so a single failing receiver is not reported twice.

## Terminals

From the environment, and on Windows the console mode
(`crates/tvpipe-cli/src/tty/windows.rs`, the CLI's one file with OS
calls, AGENTS.md):

- **Status line and QR codes**: stderr is a terminal and understands ANSI:
  `TERM` set and not `dumb`, a Windows terminal that says so otherwise
  (`WT_SESSION`, `ConEmuANSI=ON`, `ANSICON`), or a Windows console that
  took virtual terminal processing (switched on at start). The line is drawn with
  autowrap off (`ESC[?7l`) and cut to the width, so it never wraps, and
  only redrawn when it changes (a ticker looks 10 times a second). In
  line mode (below), a line typed on the terminal (`q`, Enter) moves the
  cursor down; the next draw goes up first, so no copy of the status line
  stays behind.
- **Colours**: as above, unless `NO_COLOR` is set or `CLICOLOR=0`;
  `CLICOLOR_FORCE` or `FORCE_COLOR` (not `0`) force them. One accent
  (cyan) for the title, `✓`, `●` and URLs; dim for secondary text;
  yellow `!`, red `✗`.
- **Width**: `COLUMNS`, else the Windows console's window, else `tput
  cols`, else 80. Narrow terminals get
  wrapped lines and a shorter status line (the hint goes first, then
  the numbers from the right; the clock stays).
- **Not a terminal** (pipes, CI, log files): the same lines without
  colours, QR codes or status line; one `• Streaming 1280×720 at 30 fps`
  line when the stream starts.
- **Windows consoles** that refuse virtual terminal processing (before
  Windows 10 1511) get the plain lines.

## Keys

Sessions (play, share, screen, `debug pattern`, `debug tunnel`, `game
play`) read `q` from the terminal, when stdin is one and is not the input
(`-`), never with `--machine` (`crates/tvpipe-cli/src/interrupt.rs`);
`play` of a file or a URL with a length also the playback keys:

| Key | |
|---|---|
| ← / → | 10 s back / forward |
| ↓ / ↑ | a minute back / forward |
| Space | pause / resume |

A note (`• Space pauses, ←/→ jump 10 s, ↑/↓ a minute`) names them once
the file plays; the status line then shows the position and the length
instead of the time streamed (`00:12:30 / 01:45:00`), and `● Paused`
while paused. How seeking and pausing work: [`playback.md`](playback.md).

- **Single keys**: on Unix `crates/tvpipe-cli/src/tty/` runs `stty
  -icanon -echo min 1 time 0` (std::process, stdin inherited; no OS
  calls); on a Windows console it sets the console mode instead (line
  input and echo off, virtual terminal input on; Ctrl-C still a signal),
  and an MSYS terminal, whose stdin is a pipe, gets stty. So `q` needs no
  Enter, typed keys are not echoed, and arrows come as escape sequences
  (`ESC [ C`, also with modifiers or as `ESC O C`; `ui::confirm::Keys`
  decodes them). The state before (what `stty -g` printed, or the console
  mode) comes back when tvpipe ends (normally, on an error, after `q`
  or Ctrl-C), on a panic (a hook), before a second Ctrl-C ends the
  process (`tvpipe::signals::before_forced_exit`, which also clears the
  status line), and while a prompt reads a line (`share --tunnel`'s
  `[y/N]`, pair's PIN). The hint says `q to stop`.
- **Line mode**: where neither works (no `stty`, or one that changes
  nothing), `q` + Enter, as before; the hint says `q + Enter to stop`.
  No playback keys.
- **The question**: while something would notice (a receiver connected,
  a browser viewer, phones in a game), the first `q` asks on the status
  line; `q` again stops, any other key (any other line in line mode)
  keeps going, and after 5 s the status line comes back by itself. The
  playback keys do their own thing and leave the question as it is.
  Otherwise `q` stops at once. Without a status line (stderr not a
  terminal, `-v`) `q` stops at once. Ctrl-C never asks; a second Ctrl-C
  exits at once.
- Code: `ui/confirm.rs` (the state machine), `Renderer::key`.

## Tests

`cargo test -p tvpipe-cli ui::` replays scripted event sequences
(`screen --to browser --tunnel`, a file to a TV, two receivers of which
one fails and one reconnects, errors, pairing, a game, a tunnel,
discovery) through the renderer: live terminal output through a small
terminal emulator (what stays on the screen), with colours (escapes made
visible), without a terminal, at 40 columns; every width from 0 to 199
for panics and status lines wider than the terminal; the question after
`q` (`confirm.*`: the timeout, another key, Ctrl-C, line mode, a game,
50 columns); a file that seeks and pauses (`playback.*`).
`UPDATE_SNAPSHOTS=1` rewrites `crates/tvpipe-cli/src/ui/snapshots/`.
