# Crosstalk

A team word game for 4–12 players on [`@tvpipe/party`](../../npm/party),
in English and German. Two teams, a spymaster each, 25 words on the TV.
Both spymasters type a clue at once, and it reaches only their own
team's phones. Then both teams guess at the same time: each locks one
card a step, and the TV turns both cards together. Talking is allowed,
and so is listening: what your team says while it argues over its clue,
the other team can hear. Each team has a notepad on its phones that
nobody else sees until the end, when the TV shows the key, every clue
and both pads. The idea is the one of *Codenames*; the rules, the name,
the words and the look are our own. The design, with every rule:
[`docs/crosstalk-design.md`](../../docs/crosstalk-design.md).

It is a web app for [`tvpipe game play`](../../docs/playshare-design.md):
tvpipe serves it, the game runs in its host page (a window on the
computer), the TV page is cast to AirPlay and Chromecast receivers, and
phones join with the QR code.

| | | |
|---|---|---|
| `tvpipe.json` | the manifest | pages, 4–12 players, the TV's size; `root: dist` |
| `game/` | the rules (`rules.ts`: the board and its deal, clues against the board, a step's cards, who wins, the pins' majority, the pad), the game (`game.ts`), the views (`views.ts`: the contract between host, TV and phones), bots (`bots.ts`), the clue matchers (`match.ts` English, `match-de.ts` German: Jinx's, copied as they are; `lang.ts` picks one) | TypeScript on `@tvpipe/party`, tested in Node |
| `host/` | the host page | tvpipe's standard host page (`HostPage`: the party, the TVs, the players with their team, a muted preview of the TV) with Crosstalk's settings (`host.ts`: language, time for the clues and for each card, the board, the words, latecomers) and its look (`host.css`); `strings.ts` |
| `screen/` | the TV page | the switchboard: the board, the teams, the flips, the reveal; `strings.js` |
| `phone/` | the phone page | the lobby and teams, the key and the clue (spymasters), pins, lock and the pad (operatives), the reveal; `strings.js`, `i18n.js`, `fit.js` |
| `data/` | per language: the words (Jinx's lists: difficulty, category, accepted forms, banned clues) and the dictionaries for word forms and typos | fetched by the host page; `dict.de.txt` is the German Wiktionary's, CC BY-SA 4.0 (`dict.de-LICENSE.txt`) |
| `CREDITS.md` | the word lists', dictionaries' and fonts' sources | |

## Running it

```sh
cargo build --release -p tvpipe-cli         # tvpipe
(cd npm/party && npm ci && npm run build)
cd games/crosstalk && npm install && npm run build
../../target/release/tvpipe game play .     # or: tvpipe game play games/crosstalk
npm run zip                                 # crosstalk.zip (tvpipe game pack)
```

Pick the TVs in tvpipe's launcher, then Start: the window becomes the
host page. Scan the QR code on the TV. Phones pick a team (newcomers go
to the smaller one) and one of each team volunteers as spymaster (the
first of a team is until someone else taps). The VIP starts once four
are in; a team with fewer than two players gets one from the other at
the start. After a game the spymaster role passes to the next player of
each team.

Settings (the host page, and the VIP's phone in the lobby and at the
end): language, time for the clues (60/90/120 s), time for each card
(20/30/45 s), the board (tangled: six categories with both teams in
each, so themes run into each other; or mixed), words (easy, normal,
hard), latecomers (from the next round, or closed). The room deals no
word twice until it dealt them all (kept per language in the host page's
`localStorage`), and never two related words on one board. Every phone
reads the room's language (before joining: the browser's); there is no
language of its own per phone.

## Tests

`npm test`: the matchers' known-answer tables (`test/match*.test.ts`,
Jinx's), the rules (`test/rules.test.ts`: the deal, tangled boards in
both languages, clues against the board, a card's result, the majority,
who wins, teams and spymasters, the pad's lines), and games with bots on
`@tvpipe/party`'s relay in memory (`test/game.test.ts`): a whole game
that leaks no clue, key or pad to the TV or the other team; clues
refused and accepted; both teams' cards turning together; one card for
both teams; time up with and without a majority; passing; the
assassin; the last cards in one step; the pad (who sees it, one editor
a line, released when the editor goes away, full); the lobby's teams;
the VIP's settings (only the VIP, only the host page's choices, not
during a game, every phone sees them); too few; a spymaster who
leaves; closing a game; phones dropping out all game long; a late
joiner; a German game.

## Checking it

```sh
npm run check && npm test             # types; the matchers, the rules, whole games with bots in Node
npm run build                         # dist/, which the live check plays
node test/live/play.ts                # a live game: tvpipe, headless Chrome, a phone, bots; screenshots in /tmp/crosstalk-play
```
