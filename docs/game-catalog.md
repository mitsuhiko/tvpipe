# The games list with pictures, and picking a game in the window

Status: built, for 0.3.0. Extends playshare-design.md §18 ("The
games list"). 0.2.0 has no remote games at all, so nothing released
depends on the list's shape.

## What changes

- **The list** (`site/static/games.json`, served at
  `https://tvpipe.party/games.json`) has all of this repository's games
  (Drawbluff, Jinx, Garble, and since then Krakel, Shifty, Landgrab,
  Crosstalk, Snug, Busted, Pinch and Worldquiz) and screenshots for each.
- **The site** has a games page, `tvpipe.party/games/`, rendered from the
  list with the screenshots, and a page per game, `tvpipe.party/games/NAME/`.
- **`tvpipe game play` without a game** opens the window on the list:
  pick a game (downloaded on the spot) or paste a source, then pick the
  TVs as before.

Names stay names: `tvpipe game play drawbluff` looks the name up in the
list, as §18 says. Its page on the site, `tvpipe.party/games/NAME/`, is
for people; tvpipe only reads the list.

## The list

```json
{
  "v": 1,
  "games": [
    {
      "name": "drawbluff",
      "title": "Drawbluff",
      "summary": "Draw your prompt, fake the others' titles, find the real one",
      "players": { "min": 3, "max": 50 },
      "languages": ["en", "de"],
      "source": "gh:mitsuhiko/tvpipe/drawbluff@drawbluff-v*",
      "home": "https://github.com/mitsuhiko/tvpipe/tree/main/games/drawbluff",
      "screenshots": [
        { "src": "static/games/drawbluff/tv-reveal.png", "alt": "The TV revealing the real title", "kind": "tv" },
        { "src": "static/games/drawbluff/phone-draw.png", "alt": "Drawing on a phone", "kind": "phone" }
      ]
    }
  ]
}
```

- `screenshots`: at least one; the first `tv` one is the cover. `src` is
  a URL relative to the list's own URL (so `static/games/NAME/…` is
  `https://tvpipe.party/static/games/NAME/…`, the file
  `site/static/games/NAME/…`); listed games keep their pictures in this
  repository, never hot-linked. `kind` is `tv` (16:9, 1280×720) or
  `phone` (portrait, 390×844). `alt` describes the picture.
- `python3 site/build.py` checks every entry: the fields, that each
  picture exists, is a PNG, JPEG or WebP, at most 400 KiB, and that the
  game has its link preview card (below).

## The site

`/games/` lists the games, a block per game: the cover, the title, the
summary, players and languages, the phone shots beside it, the command
`tvpipe game play NAME`, and a link to `home`.

`/games/NAME/` is one game's page: the same block alone, with a link back
to `/games/` above it and the previous and next game of the list below.
The titles on `/games/`, the landing page's covers and the manual's "Games
to play" list link to the games' pages; the old anchors (`/games/#NAME`)
still work.

### Link previews

Every page has a description, Open Graph tags and X's
`summary_large_image` card (`build.py`'s `social_head`), so a link to it
shows a picture in chat apps and on social sites. The pictures are cards
in `site/static/social/`, 1200×630 JPEGs of at most 300 KiB (WhatsApp
skips bigger ones), made by `node site/social.mjs [NAME …]` in headless
Chrome with the site's fonts and logo: `site.jpg` (the landing page),
`manual.jpg`, `games.jpg`, `join.jpg` (the join links: `/p`, `/r/` and
the Worker's `/join`) and `games/NAME.jpg` per game (its title, players,
cover and first phone picture; also on its launcher,
`/games/NAME/launcher/`). Re-run it for a new game or when a game's
title, players or pictures change; `build.py` refuses a listed game
without its card. The image URL carries a hash of the card
(`?v=…`), so previewers that cache by URL fetch a changed one.

## Picking in the window

`tvpipe game play` without `GAME` starts the server without a game and
opens the window on the launcher's first step:

1. tvpipe fetches the list (with its ETag, into the cache as before) and
   each picture (into the cache too, `games/pics/SHA`); the window gets
   them from the local API: `GET /_tvpipe/api/catalog` (the entries,
   pictures rewritten to `/_tvpipe/catalog/N`, and which games are
   downloaded already) and `GET /_tvpipe/catalog/N`. The window never
   talks to the internet. Offline or failing: the cached copy, else an
   empty list with the error; the source field still works.
2. The window shows a card per game (cover, title, summary, players,
   languages) and a field "Or a game from elsewhere" (an `https://` URL
   or `gh:OWNER/REPO`; local paths are the command line's).
3. Picking one: `POST /_tvpipe/api/game {"source": …}`. tvpipe fetches it
   in the background; the window polls `GET /_tvpipe/api/game` for
   `{state: "fetching" | "ask" | "ready" | "failed", …}`. A game not
   trusted before (§18) shows the question in the window: the name, where
   it comes from, the release, size, sha256 and tvpipe series, with
   Play and Back. `POST /_tvpipe/api/game {"trust": true}` remembers the
   answer, as the terminal does.
4. The bundle is loaded into the running server and the launcher moves on
   to the TVs and Start, as today.

The hub holds the game in a slot; the game's pages are not there and
the host API answers `no-game` until it is filled. Since
[`game-switching.md`](game-switching.md) the slot can be filled again
any time: the host page's "Other game" opens the list in a dialog, and
games on this computer (a folder of games, several paths) are listed
before the online ones. With `GAME` given, the list is skipped at the
start and the terminal asks as before; `--yes` also skips the question
in the window.

## Screenshots

Taken with each game's live check (`test/live/play.ts`), which plays a
round in headless Chrome with bots and shoots the TV and the phone per
phase; `--shots DIR` writes the chosen phases at the list's sizes (PNG,
WebP when the PNG is over the limit), with people's names for the bots.
Re-run when a game's look changes; each `play.ts` names the command.

## Releasing

A new tvpipe series (0.3.0, 0.4.0) goes like this:

1. Bump the version: `Cargo.toml` (the workspace, the internal dependency
   versions), `Cargo.lock`, `npm/party` and `npm/tvpipe` (`package.json`,
   lockfiles, and the `@tvpipe/party` entry in every game's lockfile),
   `npm run build` in `npm/party`.
2. The games and docs to the new series: `"tvpipe": "X.Y"` in every
   `games/*/tvpipe.json` (`games.yml` refuses a mismatch), the examples in
   the docs. A game that was already released at its `package.json`
   version gets a patch bump: its zip changes with the manifest.
3. The checks of AGENTS.md, `tvpipe game check --smoke` for each game,
   `release.yml` and `games.yml` (each game) by hand as dry runs.
4. Tag `vX.Y.0`, push: the GitHub release, npm, crates.io.

**The games**, on the same commit, after `vX.Y.0`: tag every game
`NAME-vA.B.C` (its `package.json` version) and push; `games.yml`
publishes each, and `tvpipe game play NAME` finds it. tvpipe of the old
series keeps finding the games' older releases by their notes' marker.

0.4.0 (2026-11-22) released all ten games for the 0.4 series: drawbluff
0.4.0, garble 0.3.0, jinx 0.3.1, krakel 0.2.0, pinch 0.1.2, and busted,
crosstalk, landgrab, shifty and snug 0.1.0 (their first releases).

A patch release in a series (0.4.1) bumps step 1's versions only (the
games keep `"tvpipe": "X.Y"`) and releases only the games that changed
since their last tag; the game library is served by tvpipe, not packed
into a game, so a change to `npm/party` alone does not change a zip.
0.4.1 released landgrab 0.2.0 (the phone plans on the map), pinch 0.1.3,
snug 0.1.1 (the difficulty ladder) and worldquiz 0.1.0 (its first
release).
