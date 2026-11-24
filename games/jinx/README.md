# Jinx

A team word game for 3–8 players on
[`@tvpipe/party`](../../npm/party), in English and German: the room plays
as one, with one bank of chips and no personal points. One player guesses a
secret word from one-word clues the others write on their phones; clues
that are the same (the game decides: same word, plural, verb form, word
family, typo, …) jinx and are lost. The guesser picks whose card to turn,
the pot shrinks with every card and goes into the room's bank on a right
guess, clue-givers can bet the room's chips on a bold clue, and the guess
is typed live on the TV. The bank climbs towards the room's titles and its
record; the evening ends with the room's title, the best clues of the
night, awards and a web of every word and clue.
The design, with every rule and number: [`docs/jinx-design.md`](../../docs/jinx-design.md).

It is a web app for [`tvpipe game play`](../../docs/playshare-design.md):
tvpipe serves it, the game runs in its host page (a window on the
computer), the TV page is cast to AirPlay and Chromecast receivers, and
phones join with the QR code.

| | | |
|---|---|---|
| `tvpipe.json` | the manifest | pages, 3–8 players, the TV's size; `root: dist` |
| `game/` | the rules (`rules.ts`), the clue matchers (`match.ts` English, `match-de.ts` German, `lang.ts` picks one), the game (`game.ts`), bots (`bots.ts`), the views (`views.ts`: the contract between host, TV and phones) | TypeScript on `@tvpipe/party`, tested in Node |
| `host/` | the host page | tvpipe's standard host page (`HostPage`: the party, the TVs, the players, a muted preview of the TV) with Jinx's settings as a spec (`host.ts`: language, rounds, writing time, words, latecomers) and its look (`host.css`); `strings.ts` (the status line, Play again) |
| `screen/` | the TV page | the table seen from above; `strings.js` |
| `phone/` | the phone page | faces, clues, cards, the guess; `strings.js`, `i18n.js` (numbers, plurals, lists) |
| `data/words.txt`, `data/dict.txt`, `data/words.de.txt`, `data/dict.de.txt` | per language: the secret words (with difficulty, category, accepted guesses, banned clues), the dictionary for typos and word forms | fetched by the host page; `design/` has how they were made (German: `design/words/de/`, `design/matching/de/`); `dict.de.txt` is the German Wiktionary's, CC BY-SA 4.0 (`dict.de-LICENSE.txt`) |
| `CREDITS.md` | the word lists' and dictionaries' sources | |

## Running it

```sh
cargo build --release -p tvpipe-cli         # tvpipe
(cd npm/party && npm ci && npm run build)
cd games/jinx && npm install && npm run build
../../target/release/tvpipe game play .     # or: tvpipe game play games/jinx
npm run zip                                 # jinx.zip (tvpipe game pack)
```

Pick the TVs in tvpipe's launcher, then Start: the window becomes the host
page. Scan the QR code on the TV; the first player is the VIP and starts from their phone once three
are in (or the host page's Start), and offers "Play again" at the end.

Settings (the host page, and all of them on the VIP's phone in the lobby
and at the end; only between games): language (for everyone), rounds (auto: every player guesses twice with 3–5 players, once
with 6–8; or once, or twice), writing time (30/45/60/90 s), words (easy,
normal: mostly easy and medium with one hard word in ten, hard: medium
and hard), latecomers (from the next round, or closed: nobody new joins
during a game; a player who dropped out still comes back by name). The room deals no word twice until it dealt them all (kept per
language in the host page's `localStorage`) and never two related words
in one game. The host page also keeps the room's record: its best bank
for a game of that many rounds.

## Languages

English and German. The language is the room's: a setting on the host
page, which starts with the browser's language (then the last choice on
that computer) and changes only between games. It goes with the room and
TV views (`lang`), so every phone, the TV and the host page speak it.
The VIP can change it from the phone too; no phone has a language of
its own (before joining, it speaks the browser's). Each language has its own words (`data/words.de.txt`), dictionary
and clue matcher (`game/lang.ts`): what jinxes in German is German
grammar, read from a lexicon of the German Wiktionary (Hunde/Hund,
lief/laufen, größer/groß, Schneemänner/Schneemann, Bäcker/backen; see
`design/matching/de/SPEC.md`), and the reasons on the tape are German ("PLURAL", "ANDERE
FORM", "WORTFAMILIE"). The pages' texts are in `strings.js`/`strings.ts`,
written for each language rather than translated (German: "du", the
same cheeky host, German stamps: RICHTIG!, DANEBEN, EINGELOGGT; JINX! stays
the game's word). A language whose data files are missing cannot be
picked. Long German compounds fit, never cut with an ellipsis: card words
shrink, then condense, then go on two hyphenated lines (the longest
clues on the TV, the phone's small cards); the secret word on the
phone's index card condenses further; running text hyphenates (`lang`
on every page). `node test/live/play.ts --long` checks it.

## Tests

`npm test`: the matchers' known-answer tables (`test/match*.test.ts`), the
German word list against the German matcher (`test/words-de.test.ts`), the
rules (`test/rules.test.ts`: the pot, the bank, dealing, guesser order, titles and goals,
awards, the web), and whole games with bots on `@tvpipe/party`'s relay
in memory (`test/game.test.ts`): 3 and 4 players, play again, clue
refusals and replacing, the moderate hook on clues, drafts and guesses, all clues jinxed, wrong guesses and passes (the bank never below 0), the bank, best clues and the record, the VIP's settings from the phone (every one, the language and the latecomers too; refusals), timers
for a silent or disconnected guesser, a late joiner, a room closed to latecomers, a player who leaves,
a guesser who leaves, too few left (the game ends), closing a game mid-round,
a closed bot, the secrecy of the word on the TV and the guesser's
phone; a German game with bots, the language switched between games
(each language with its own dealt words) and a German refusal.

## Checking it

```sh
npm run check && npm test             # types; the matchers, the rules, whole games with bots in Node
npm run build                         # dist/, which the live check plays
node test/live/play.ts                # a live game: tvpipe, headless Chrome, a phone, 3 bots; screenshots in /tmp/jinx-live
node test/live/play.ts --bots 7       # a full table: 8 players, the seats beside the join badge
node test/live/play.ts --lang de      # a German room (/tmp/jinx-live-de)
node test/live/play.ts --long         # the longest words and clues (also with --lang de: compounds)
node test/live/play.ts --bots 7 --shots ../../site/static/games/jinx   # the games list's pictures (test/live/scenario.ts)
```

`node test/live/play.ts [--bots N] [--rounds auto|1|2] [--lang en|de] [--long] [--out DIR] [--shots DIR]`
(not part of `npm test`): a whole game on the real `tvpipe game play`
with headless Chrome as the host window, the TV and a phone (each in a
window of its own, so all of them animate), bots for the others;
screenshots of every phase, layout checks (the phone at 390 and 320 px,
the TV page: no text out of its box or off the screen, nothing under
the join badge), checks that no phone shows a jinx, the word or a turned
card's word before the TV does, and every tab's errors and the bots'
refused actions fail the run. Bots write the word's category or another
word from the word list, so they jinx now and then, and they peek at
the word to guess. They are for tests: the host page's bot buttons show
only with `?bots` in its URL or with `tvpipe game play --dev`. `--lang
de` plays a German room: the phone's browser in German, German clues
and guesses, the same layout checks. `--long` deals the language's
longest words and has the bots and the phone write clues of 18–24
letters, to see that none is cut off or broken. `--shots DIR` writes
the games list's pictures (`tv-reveal`, `phone-lobby`, `phone-guess`;
docs/game-catalog.md) from a fixed round and ends there. The live check
needs Chrome and a built tvpipe (`TVPIPE_BINARY`, else `target/release`,
else `target/debug`).
