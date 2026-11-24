# Busted

A party game about each other (our own rules, names and look) on
[`@tvpipe/party`](../../npm/party), for 3–10 players, in English and
German. The TV is a gossip paper, *The Daily Busted*; the phones are
the reporters' notebooks.

- **Who would most likely …?** Everyone secretly ranks gold, silver and
  bronze on their phone. The TV counts the ballots one by one, and the
  winner makes the front page with the question's title ("Sleepyhead of
  the Year"). Points for reading the room, never for being voted.
- **Everyone answers.** One question, an answer each, printed
  anonymously in the gossip column. Match every note to its writer: a
  right guess is a point for you, a wrong one a point for the writer.
  The TV busts the writers one by one.
- Rounds alternate. With three players the podium has two places and
  everyone writes two answers.
- **Readers' questions**: anyone suggests questions on their phone; the
  others rate them (print it, meh, no way) while they wait; the liked
  ones are played and credited, the rest never reach the TV.
- **Press photos** drawn on the phone, **honorary candidates** (the dog,
  Grandma) to vote for, and at the end a newsstand of magazine covers:
  everyone's titles and best-liked answer.
- **Settings** (language, rounds, family or party questions, open or
  secret ballots, time to write, latecomers) on the host page, or on the
  VIP's phone in the lobby and at the end.

The rules, the numbers and why: [`docs/busted-design.md`](../../docs/busted-design.md).

| | | |
|---|---|---|
| `tvpipe.json` | the manifest | pages, 3–10 players, the TV's size; `root: dist` |
| `game/` | the rules (`rules.ts`), press photos and doodles (`face.ts`, loaded by the pages too), the game (`game.ts`), bots (`bots.ts`) | TypeScript on `@tvpipe/party`, tested in Node |
| `host/` | the host page | tvpipe's standard host page with Busted's settings, plus the editor's desk: skip a question, honorary candidates, spike a suggestion |
| `screen/` | the TV page | the paper: lobby, front pages, the count, the title, letters to the editor, the gossip column, the reveal, standings, the special edition; sounds |
| `phone/` | the phone page | joining, the press photo, the podium, the answer, matching, results, the cover; the editor's desk and suggestions; fonts |
| `data/` | the questions, English and German, each written on its own | `npm run questions` checks them |
| `design/questions.md` | how the questions were written | |

## Running it

```sh
cargo build --release -p tvpipe-cli
(cd npm/party && npm ci && npm run build)
cd games/busted && npm install && npm run build
../../target/release/tvpipe game play .
```

## Checking it

```sh
npm run check && npm test     # types; the rules, the lists, whole games with bots in Node
npm run questions             # the English list (node scripts/check-questions.mjs data/questions.de.txt: the German one)
node test/live/play.ts        # a live game: tvpipe, headless Chrome, a phone, bots; screenshots in /tmp/busted-play
node test/live/play.ts --lang de --bots 2
node test/live/play.ts --bots 3 --shots ../../site/static/games/busted   # the games list's pictures
```

Bots are for tests: the host page's bot buttons show only with `?bots`
or in test mode (`tvpipe game play --dev`).
