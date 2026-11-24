# Shifty

A social deduction word game (our own rules, names and look) on
[`@tvpipe/party`](../../npm/party), for 3–10 players, in English and
German. Everyone but one knows the secret word on a board of sixteen;
the **phony** sees only the board. One by one, everyone types a one-word
clue that shows they know the word without giving it away, while the TV
shows how they type. Then the room accuses someone, and the phony gets
one last chance: name the word.

- **The board**: sixteen words of one category on the TV (zoo animals:
  giraffe, zebra, lion …), one of them the secret. Every phone has a card
  to turn with a tap: the word, or "You are the phony".
- **Clues, one at a time**, in a shuffled order (the phony never
  first), one or two each (auto: two with up to five players). A clue is
  one word and may not say a word of the board (`lions`, `elefant`,
  `Babykatze` and `sea` for `sea horse` are refused, the same for
  everyone). Typed: the TV shows the letters as blank tiles (never the
  letters) and a lie detector's needle that kicks with every key and
  every deletion and runs flat while someone hesitates; the trace stays
  under their name. Or out loud (a setting): say it, tap Done.
- **Accusing**: everyone picks a suspect on their phone, in secret; the
  TV shows who has accused, then fires red lasers from each accuser to
  the accused. The most accused, alone, gets a neon sign: PHONY or
  INNOCENT.
- **The last chance**: the phony picks the word from the board on their
  phone; the TV reveals it and runs a thread of light from every clue to it.
- **Points**: +1 for accusing the phony; +1 for every innocent when the
  phony is caught and misses the word; the phony +2 for getting away and
  +2 for naming the word.
- **The end**: the podium and the awards: smoothest liar, sharpest eye,
  shakiest hand (the most deletions).

The rules, the numbers and why: [`docs/shifty-design.md`](../../docs/shifty-design.md).

It is a web app for [`tvpipe game play`](../../docs/playshare-design.md):
tvpipe serves it, the game runs in its host page (a window on the
computer), the TV page is cast to AirPlay and Chromecast receivers, and
phones join with the QR code.

| | | |
|---|---|---|
| `tvpipe.json` | the manifest | pages, 3–10 players, the TV's size; `root: dist` |
| `game/` | the rules (`rules.ts`: the word lists, the clue check with Krakel's matcher, the board, the phony and the order, the typing log, the accusations and the points), the game (`game.ts`), bots (`bots.ts`) | TypeScript on `@tvpipe/party`, tested in Node |
| `host/` | the host page | tvpipe's standard host page (`HostPage`) with Shifty's settings as a spec (`host.ts`) and its look (`host.css`); `strings.ts` (the status line) |
| `screen/` | the TV page | the lobby, a round as one scene (the line-up, the strips, the clue cards, the board) through the deal, the clues, the accusations, the verdict, the last chance and the reveal; the scores; the final screen; sounds; `strings.js` |
| `phone/` | the phone page | joining, the lobby (the VIP's settings), the card, the clue, accusing, the last chance, results; `strings.js`, `fit.js` and `i18n.js` (Krakel's) |
| `data/` | the word lists, English and German: Krakel's, `== Category`, then `word\|other name\|…` per line | fetched by the host page; `node scripts/words.ts` checks them |

## Running it

```sh
cargo build --release -p tvpipe-cli
(cd npm/party && npm ci && npm run build)
cd games/shifty && npm install && npm run build
../../target/release/tvpipe game play .
```

Pick the TVs (or "A browser tab on this computer"), then Start. The
first player is the VIP and starts the game from their phone once three
are in (or the host page's Start). Settings (the host page, or the VIP's
phone in the lobby and at the end, not during a game): the language,
rounds (3–6), clues typed or out loud, clues each (auto, 1, 2), time
for a clue (15, 25 or 40 s), time to talk (45–120 s), the typing shown
on the TV or not, latecomers (next round, or not during a game). A game ends
early, at the next round, when fewer than three players are left in it;
a phony who leaves for good ends the round without points.

## Checking it

```sh
npm run check && npm test          # types; the rules, the word lists, whole games with bots in Node (privacy included)
npm run words                      # the word lists: categories, counts, what is wrong
node test/live/play.ts             # a live game: tvpipe, headless Chrome, a phone, bots; screenshots in /tmp/shifty-play
node test/live/play.ts --lang de --bots 9 --mode spoken
node test/live/play.ts --long [--lang de]   # the longest board and clues: none cut off
node test/live/play.ts --bots 3 --shots ../../site/static/games/shifty   # the games list's pictures
```

Bots are for tests: the host page's bot buttons show only with `?bots`
in its URL or with `tvpipe game play --dev` (`?fast` there shortens
every timer), and the live check adds them through `shifty.addBots`.
They type vague clues letter by letter (sometimes a false start,
deleted), accuse at random or, now and then, the phony (the host page
knows), and as the phony pick a word. The live check needs Chrome and
a built tvpipe (`TVPIPE_BINARY`, else `target/release`, else
`target/debug`); it checks every phone screen at 390 and 320 px and the
TV for anything running out of its box or under the join badge, reloads
the phone and joins it again by name, drops a bot's phone and brings it
back, and fails on any page's error and on any bot's error.

## Languages

English and German. The language is the room's, the same on every
phone and the TV: a setting on the host page (which starts with the
browser's language) and on the VIP's phone, changed only between games;
before joining, a phone speaks the browser's language. Each language has its own words (`data/words.txt`,
`data/words.de.txt`, Krakel's lists) and its own rules for articles and
endings in the clue check (`game/rules.ts`).

## The fonts

Monoton, Bebas Neue and Share Tech Mono (all SIL OFL 1.1), in
`phone/fonts/` with their licenses.
