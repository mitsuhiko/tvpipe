# Agent instructions

`ARCHITECTURE.md` explains how tvpipe works; `docs/` has the details.

## Rules

- No async runtime anywhere: `std::thread` and blocking I/O.
- Dependencies: `crates/tvpipe` and `crates/tvpipe-fairplay` use only `ring`
  and `rustls` (ring backend, no default features); `argument` only in
  `crates/tvpipe-cli`. `npm/party` has no runtime dependencies. Games
  (`games/*`) may take their own. Ask the human before adding any other
  crate or npm package.
- Hand-roll formats and simple algorithms, each with known-answer tests or
  fixtures.
- Never panic on data from the network or from ffmpeg: return errors.
- Platform-neutral code only, no OS media or discovery APIs. `cfg` for
  config and cache paths, `signals.rs`, `util/timer.rs` and the CLI's
  `tty/windows.rs` only (ARCHITECTURE.md, "Platform-Specific Code").
- Clean room: nothing outside `crates/tvpipe-fairplay` (LGPL) may copy from
  it; do not read the tainted sources (doubletake, UxPlay, playfair, …)
  unless you are the FairPlay porter or a spec writer (ARCHITECTURE.md,
  "Licensing and Clean Room").
- Games run in browsers: no Rust game logic, Node only for tests and build
  scripts.

## Before committing

`cargo fmt --all && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace`;
with JavaScript changes also `npm run build && npm run check && npm test`
in `npm/party` (the build's copy in `crates/tvpipe/src/playshare/web/` is
checked in), and `npm run check && npm test` in every game the change
affects (a change to `npm/party` affects all of `games/*`) and in
`apps/tvpipe-party` when it changed.
