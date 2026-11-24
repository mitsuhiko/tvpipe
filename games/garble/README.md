# Garble

A drawing game (our own rules, names and look) on
[`@tvpipe/party`](../../npm/party), for 3–12 players. One picture per
player goes round the table, and everyone has to turn it into something
else by drawing **on top** of it. Nothing is ever erased: a cat becomes
a submarine becomes a hedgehog, and the TV replays how.

- **Layer 1.** Your phone deals you two words; pick one and draw it.
- **Then, each step,** you get the next player's picture (every layer so
  far, all in one black ink). Write what you think it is **now**, then
  you are dealt a word ("Make it: submarine") and draw it on top. Your
  own strokes can be undone; the old ink cannot be touched (the pad
  shows it a shade lighter).
- **The last player** only guesses.
- **The machine judges**: a guess is right when it says the latest
  layer's word, a plural or inflection of it, a compound with it inside
  (`Piratenschiff` for `Pirat`), or one of its synonyms from the word
  list (`cat|kitten|kitty`). Spelling slips count (`elefant`,
  `Krokodiel`, `Kaese`), unless the slip is another word of the list
  (`house` is not a misspelt `horse`) or a rhyme (`power` for `tower`).
- **Points**: a layer read right pays its drawer and its reader
  `50 + 50·k` each (layer 1: 100, layer 5: 300); later layers are harder.
- **The reveal**: the TV rebuilds each picture layer by layer, each layer
  in its drawer's colour, with its word, its drawer and the next player's
  guess, ✓ or ✗.
- **Best move**: after the reveal, everyone votes on their phone for the
  cleverest layer of the round (not their own); the most votes (at least
  two) win 200, ties split it.

The rules, the numbers and why: [`docs/garble-design.md`](../../docs/garble-design.md).
Each picture gets 3, 5 or 7 layers (at most one less than the players);
rounds 1–4; undo of your own strokes on (or off: every stroke counts).
English and German.

It is a web app for [`tvpipe game play`](../../docs/playshare-design.md):
tvpipe serves it, the game runs in its host page (a window on the
computer), the TV page is cast to AirPlay and Chromecast receivers, and
phones join with the QR code.

| | | |
|---|---|---|
| `tvpipe.json` | the manifest | pages, 3–12 players, the TV's size; `root: dist` |
| `game/` | the rules (`rules.ts`: drawings, the word lists and the matcher, seating, decks, points), the ink's geometry (`ink.ts`: the grid and the limits, a stroke's path, a replay's cut; the pages load it too), the game (`game.ts`), bots (`bots.ts`) | TypeScript on `@tvpipe/party`, tested in Node |
| `host/` | the host page | tvpipe's standard host page (`HostPage`: the party, the TVs, the players, a preview of the TV) with Garble's settings as a spec (`host.ts`) and its look (`host.css`); `strings.ts` (the status line) |
| `screen/` | the TV page | the lobby, the ring of players passing their pages, the reveal, the gallery and the best move, the ledger, the podium; `strings.js` |
| `phone/` | the phone page | joining, the lobby and the final screen (the VIP's settings: all of the host page's, the room's language among them), picking a word, guessing, the pad on top of the old ink, reactions, the best-move vote; `strings.js`, `ink.js` (the strokes on a canvas, shared with the TV) |
| `data/` | the word lists, English and German: `word\|synonym\|…` per line | fetched by the host page |

## Running it

```sh
cargo build --release -p tvpipe-cli
(cd npm/party && npm ci && npm run build)
cd games/garble && npm install && npm run build
../../target/release/tvpipe game play .
```

Pick the TVs (or "A browser tab on this computer"), then Start.

## Checking it

```sh
npm run check && npm test          # types; the rules, the ink, the word lists, whole games with bots in Node (privacy, a TV behind, closing)
node test/live/play.ts             # a live game: tvpipe, headless Chrome, a phone, bots; screenshots in /tmp/garble-play
node test/live/play.ts --lang de --length 7 --undo off
node test/live/play.ts --lang de --long   # round 1 with the longest words (and longer) and the longest guess: none cut off or broken
node test/live/play.ts --bots 3 --shots ../../site/static/games/garble   # the games list's pictures (test/live/scenario.ts)
node test/live/scenario.ts --preview /tmp/garble-scenario                # the scripted round's layers as one PNG
```

Bots are for tests: the host page's bot buttons show only with `?bots`
in its URL or with `tvpipe game play --dev`, and the live check adds them through `garble.addBots`. They
cannot see drawings: the host page tells them what the latest layer with
ink was meant to be, and they read it right most of the time. The live
check needs Chrome and a built tvpipe (`TVPIPE_BINARY`, else
`target/release`, else `target/debug`); it also checks every phone
screen at 390 and 320 px and the TV for text running out of its box and
words not read whole, plays a second TV with its sound on, and fails on
any page's errors (over DevTools) and on the bots' errors.
