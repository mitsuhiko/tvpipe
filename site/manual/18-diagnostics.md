---
title: Diagnostics
summary: What to do when something does not work.
group: Reference
spec:
  Flags: `-v`, `--debug`
  Variable: `TVPIPE_LOG`
---

What to try when a TV does not show up or the picture does not appear.

## What tvpipe prints

:::aside Marks
✓ done

• a note

! a warning

✗ an error
:::

tvpipe prints what happens for people: a title, a line per step, links with their QR codes, and on a terminal a status line at the bottom. An error says what to try next.

`q` stops, and while a TV, a browser or phones are watching it asks first: press `q` again to stop, any other key to keep going. `Ctrl-C` never asks, and a second `Ctrl-C` quits at once. Where the terminal takes no single keys (the status line then says `q + Enter to stop`), `q` needs Enter.

```sh
$ tvpipe play --to "Nowhere TV" movie.mp4
tvpipe · Playing movie.mp4

✗ No receiver named "Nowhere TV" answered on this network
  See which receivers are on this network: tvpipe discover
```

## More detail

`-v` prints the debug log and `--debug` adds every protocol message, which is a lot. `TVPIPE_LOG=info`, or `error`, `warn`, `debug` and `trace`, prints the log at that level.

```sh
$ tvpipe -v play --to TV movie.mp4
```

## Colours and QR codes

Colours follow `NO_COLOR` and `CLICOLOR=0`, and `CLICOLOR_FORCE` or `FORCE_COLOR` force them. With `TERM=dumb`, in a pipe or in a log file, tvpipe prints plain lines without a status line. `--no-qr` or `TVPIPE_NO_QR=1` hides the QR codes.

## Common problems

| Problem | What to do |
|---|---|
| No receivers found | Make sure the computer and the TV are on the same network. Try `--interface`, or give `--to` the address. |
| Windows asks to allow tvpipe | Allow it. Apple TVs need to reach tvpipe on your computer. |
| No sound in a browser tab | Click the page once. |
| A TV fails with `home-only` or `forbidden` | Its Apple Home (or the Mac) lets only some people stream. See [TVs in an Apple Home](receivers.md#s6). |
| Crackling or missing sound on an AirPlay TV that is not an Apple TV | Try a longer delay, such as `--latency 600`. See [Latency](latency.md). |
| An Apple TV fails with `fairplay-required` | This tvpipe was built without FairPlay. Use a release, or build it with the default features. |
| tvpipe does not stop | Press `Ctrl-C` a second time. |
| A site does not show with `share URL` | It refuses controlled browsers. See [limitations](web-page.md#s4). |
| macOS: your browser does not open, or links go nowhere, while tvpipe runs | tvpipe's own browser takes them. Start your browser before tvpipe. See [limitations](web-page.md#s4). |
