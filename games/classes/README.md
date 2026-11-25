# Classes

A school-day word game (our own take on *Categories* / *Stadt, Land,
Fluss*) on [`@tvpipe/party`](../../npm/party), for 2–10 players, in
English, German and Austrian German (the German columns with Austria's
school: Klassenvorstand, grades 1–5). The TV is the classroom; the phones are the
exercise books.

- **One letter.** A player stops the alphabet running along the frieze
  above the blackboard; today's columns are chalked on the board, each a
  school subject (Geography, Biology, Break, Register, …).
- **Everyone writes at once.** One answer per column on the phone, before
  the school bell. The TV shows everyone's exercise book filling up with
  scribbles, never the words. The first to fill every column may raise
  their hand: ten seconds left for all.
- **The class grades.** Column by column, the TV opens the exercise books:
  the same answers are bracketed together, wrong letters and broken rules
  are crossed out at once, the room doubts what does not count (more than
  half of the others strike it; in a duel of two, the other's doubt does)
  and sticks gold stars on what it loves.
  Anyone can look an answer up in **Wikipedia**: a reader on every phone
  and on the TV (the article's text with its headings, lists and links;
  follow a link, go back, search), the TV following whoever reads.
- **The red pen**: 20 for the only valid answer, 10 for one nobody else
  wrote, 5 each for a shared one.
- **The report card** at the end: a grade per subject (A–F, or 1–6 in
  German), the teacher's remarks ("Class clown", "Copies from the
  neighbour"), a stamp, and the best answers of the day on the cork board.
- **Settings** (language, rounds, columns per round, time, how silly the
  columns are, family or party content, Stop!, the classic City–Country–
  River start, common or all letters, latecomers) on the host page, or on
  the VIP's phone in the lobby and at the end.

The rules, the views and why: [`docs/classes-design.md`](../../docs/classes-design.md).

| | | |
|---|---|---|
| `tvpipe.json` | the manifest | pages, 2–10 players, the TV's size; `root: dist` |
| `game/` | the rules (`rules.ts`: letters, subjects, the column lists, dealing, the letter and rule checks, points, grades, remarks), the same answer (`match.ts`), Wikipedia lookups (`wiki.ts`) and its articles' HTML made into safe blocks (`wikitext.ts`, a hand-written tokenizer and whitelist), the game (`game.ts`), bots (`bots.ts`) | TypeScript on `@tvpipe/party`, tested in Node; `rules.js` is loadable by the pages (subjects' names and colours) |
| `host/` | the host page | tvpipe's standard host page with every setting, plus the teacher's desk: Skip column, End the round |
| `screen/` | the TV page | the classroom: lobby, the alphabet, the board, the desks, the bell, the exercise books, the red pen, Wikipedia, the grade list, the report cards; sounds |
| `phone/` | the phone page | joining, the Stop! button, the exercise book, grading, the reader, the report card |
| `fonts/` | handwriting, chalk, print | shared by the TV and the phones |
| `data/` | the columns, English and German (Austrian rooms play the German list; `only:de`/`only:at` lines for one of them), each written on its own | `npm run columns` checks them |

## Running it

```sh
cargo build --release -p tvpipe-cli
(cd npm/party && npm ci && npm run build)
cd games/classes && npm install && npm run build
../../target/release/tvpipe game play .
```

The host page looks answers up at `en.wikipedia.org` / `de.wikipedia.org`
straight from the window; without internet the TV says Wikipedia is not
reachable, and the game goes on.

## Checking it

```sh
npm run check && npm test     # types; the rules, the matcher, Wikipedia on recorded answers, the lists, whole games with bots in Node
npm run columns               # both column lists: errors, the coverage per letter and subject, every setting deals a full round
node test/live/play.ts        # a live game: tvpipe, headless Chrome, a phone, bots; screenshots and layout checks in /tmp/classes-play
node test/live/play.ts --lang de --long --bots 9 --columns 10   # the most players, the longest columns, answers and names
node test/live/play.ts --bots 1                                  # a duel: the phone and one bot
node test/live/play.ts --bots 5 --shots ../../site/static/games/classes   # the games list's pictures
node test/live/preview.ts     # every TV scene from fixtures, without tvpipe (--page phone for the phone)
../../target/release/tvpipe game check --smoke .
```

The live check needs Chrome and tvpipe (`TVPIPE_BINARY`, else
`target/release`, else `target/debug`; it builds it when there is
neither) and `npm run build` first. It looks things up in the real
Wikipedia: without a network it notes that the TV said Wikipedia is not
reachable and passes.

Bots are for tests: the host page's bot buttons show only with `?bots`
or in test mode (`tvpipe game play --dev`); `?fast` plays with short
timers. The host page puts `classes` on `globalThis` (`party`, `game`,
`addBots`, …) for checks from DevTools or a live script.
