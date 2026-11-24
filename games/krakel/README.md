# Krakel

A drawing game (our own rules, names and look) on
[`@tvpipe/party`](../../npm/party), for 3–10 players, in English and
German. Everyone draws a word of the same category, with time to do it
well; then the TV redraws each picture stroke by stroke and the others
type what it is. The sooner a picture is named, the more for the guesser
and for the artist: the round's drawings are ranked by how well the room
read them. ("Krakel": German for a scrawl.)

- **The category** is for the room ("Zoo animals"), the word is yours:
  a different one for every player, three to pick from (two with eight
  players and more). The words of a category are close on purpose (fox,
  wolf, jackal): draw what makes yours different.
- **Or mixed words** (a setting): no category for the round; everyone
  picks one of three words from three different categories, and every
  drawing comes with its own category when it is on stage.
- **Draw** for 1 to 3 minutes: thirteen pens, an eraser, four widths,
  undo. The page is kept on the phone while you draw (a reload loses
  nothing). The TV shows how much everyone drew, never what.
- **On stage**, one drawing at a time: the TV redraws it under a pencil
  in the order it was drawn, always in the same time (30–90 s), and the
  phones show the same replay. Everyone else types what it is.
  - Right: 1000 points at the start, falling to 200 at the end; +200
    for the first.
  - Wrong: the phone is locked for a few seconds (0, 2, 4 or 8), and
    the TV shows the guess, struck out.
  - The machine judges: other names from the word list (`hippo`,
    `hippopotamus`), plurals, compounds with the word inside
    (`Babykatze`), and spelling slips (`elefant`, `elefants`,
    `Krokodiel`; German `Kaese`, `Baer` for `Käse`, `Bär`) count, unless
    the slip is another word of the list (`Birne` for `Biene`) or starts
    with another letter (a rhyme: `house` is no `mouse`).
  - Easy (the default): a blank per letter of the word. Hard: only the
    category.
- **The artist** earns half of what the guessers earned by time. So:
  start with what gives it away.
- **The gallery**: one heart from everyone for their favourite (500 for
  the most hearts, at least two), then the round's drawings ranked,
  with medals.
- **The end**: the podium, the *Krakel of the game* and the *sharpest
  eye*.

The rules, the numbers and why: [`docs/krakel-design.md`](../../docs/krakel-design.md).

It is a web app for [`tvpipe game play`](../../docs/playshare-design.md):
tvpipe serves it, the game runs in its host page (a window on the
computer), the TV page is cast to AirPlay and Chromecast receivers, and
phones join with the QR code.

| | | |
|---|---|---|
| `tvpipe.json` | the manifest | pages, 3–10 players, the TV's size; `root: dist` |
| `game/` | the rules (`rules.ts`: drawings, the word lists and the matcher, the deal, points), the ink's geometry (`ink.ts`: a stroke's path, the cut of a drawing at a point of its replay; the pages load it too), the game (`game.ts`), bots (`bots.ts`) | TypeScript on `@tvpipe/party`, tested in Node |
| `host/` | the host page | tvpipe's standard host page (`HostPage`: the party, the TVs, the players, a preview of the TV) with Krakel's settings as a spec (`host.ts`) and its look (`host.css`); `strings.ts` (the status line) |
| `screen/` | the TV page | the lobby, everyone drawing, the replay under the pencil with the guesses, the word, the gallery with hearts and ranking, the scores, the podium; sounds; `strings.js` |
| `phone/` | the phone page | joining, the lobby (the VIP's settings), picking a word, the pad, the replay with the guess below it, the heart; `strings.js`, `ink.js` (the canvas, shared with the TV) |
| `data/` | the word lists, English and German: `== Category`, then `word\|other name\|…` per line | fetched by the host page; `node scripts/words.ts` checks them |

## Running it

```sh
cargo build --release -p tvpipe-cli
(cd npm/party && npm ci && npm run build)
cd games/krakel && npm install && npm run build
../../target/release/tvpipe game play .
```

Pick the TVs (or "A browser tab on this computer"), then Start. The
first player is the VIP and starts the game from their phone once three
are in (or the host page's Start). Settings (the host page, or the
VIP's phone in the lobby and after a game, the same ones): the
language, rounds (1–4), time to draw (1, 1½, 2 or 3 minutes), time to
guess (30, 45, 60 or 90 s), the words (one category a round, or mixed),
letters shown or hidden, the wait after a wrong guess, and latecomers
(next round, or not during a game). A game ends early, after the round, when fewer
than three players are left in it.

## Checking it

```sh
npm run check && npm test          # types; the rules, the ink, the word lists, whole games with bots in Node (privacy included)
npm run words                      # the word lists: categories, counts, what is wrong
node test/live/play.ts             # a live game: tvpipe, headless Chrome, a phone, bots; screenshots in /tmp/krakel-play
node test/live/play.ts --lang de --bots 9 --hints off --mixed on
node test/live/play.ts --long [--lang de]   # the first round with the longest words: none cut off or broken
node test/live/play.ts --bots 3 --shots ../../site/static/games/krakel   # the games list's pictures (test/live/scenario.ts)
node test/live/scenario.ts --preview /tmp/krakel-scenario                # the scripted round's drawings, whole and half replayed
```

Bots are for tests: the host page's bot buttons show only with `?bots`
in its URL or with `tvpipe game play --dev` (`?fast` there shortens
every timer), and the live check adds them through `krakel.addBots`.
They cannot see drawings: the host page tells them the word of the
drawing on stage, and they type it somewhere along its replay,
sometimes after a wrong guess. The live check needs Chrome and a built
tvpipe (`TVPIPE_BINARY`, else `target/release`, else `target/debug`);
it also checks every phone screen at 390 and 320 px and the TV for
anything running out of its box, reloads the phone in the middle of a
drawing, drops phones out and brings them back, and fails on any
page's error (uncaught, console.error or a failed load, over DevTools;
a TV with its sound on included) and on any bot's error.

## Languages

English and German. The language is the room's: a setting on the host
page (which starts with the browser's language, then the last choice on
that computer) and on the VIP's phone, changed only between games. It
goes with the room and TV views (`lang`), so every phone, the TV and
the host page speak it (a phone before joining: the browser's). Each language has its own words (`data/words.txt`,
`data/words.de.txt`: 22 categories, about 570 words each) and its own
rules for articles and endings in the matcher (`game/rules.ts`). The
pages' string tables (`phone/strings.js`, `screen/strings.js`) write
numbers, plurals and lists of names the way the language does
(`phone/i18n.js`, Intl: "1 of 3 has it", "Ada, Bo und Cy haben es!").

## The font

Shantell Sans (SIL OFL 1.1), in `phone/fonts/` with its license.
