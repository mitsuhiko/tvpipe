# Busted (design)

A party game about each other for 3–10 players in `games/busted`: a web
app on `@tvpipe/party`, like `games/shifty`. Rounds alternate between
two kinds. In a **vote** round the TV asks "Who would most likely sleep
through a whole day?", everyone ranks a secret podium on their phone,
and the winner makes the front page with a title ("Sleepyhead of the
Year"). In an **answer** round everyone answers the same question, the
TV prints the answers anonymously, and everyone matches answers to
writers. The questions are the game's own, or the room's: players
suggest questions on their phones, the others rate them while they
wait, and the liked ones are played.

The ideas are old party games ("Most likely to …", "Who said that?");
the rules, the name and the look are our own. The look is a gossip
paper, *The Daily Busted* (*Der Busted-Bote* in German): every stage of
the game is a page of it.

## 1. Why it is fun

- **It is about the people in the room.** Nothing to know, nothing to
  draw: the questions are about the players, and the laughs come from
  who the room thinks of first.
- **Points for knowing your friends, never for being voted.** Winning a
  vote earns a title, not points: a title is a joke the room makes
  about you, and you collect them. Points go to who reads the room: whose
  podium matches the room's, who guesses the writers.
- **Writing is a choice.** Every guess on your answer is worth one point:
  to the guesser when they are right, to you when they are wrong. Write
  like yourself and be found, or write like someone else and fool them.
- **The room writes the paper too.** Anyone can send in a question at
  any time; the others rate it in the moments they wait anyway. What the
  room likes is printed, credited to its author; what it does not like
  never reaches the TV.
- **A souvenir.** The end is a newsstand of magazine covers, one per
  player: their portrait, their titles, their best-liked answer.

## 2. A game

- **Players: 3–10**, plus up to three **honorary candidates**: names
  the VIP or the host adds in the lobby (the dog, Grandma, whoever is
  missing tonight). They can be voted for and win titles, and get a
  cover; they never play. They help small rooms most.
- **Rounds** alternate, vote first: vote, answer, vote, answer …; 6, 8
  (default), 10 or 12 rounds, about 15–25 minutes for 8.
- **Press photos.** In the lobby each player draws their own face on the
  phone (black marker on a square, undo and clear). Without one the game
  draws a doodle from the name (a head, eyes, a nose, a mouth, hair or a
  cap; the same name always gets the same doodle). Every page shows
  people by their photo, framed in their ink colour.
- **Settings** (the host page, or the VIP's phone in the lobby and at the
  end): the language (the room's: every phone and the TV speak it);
  rounds; questions *family* (fine with kids and grandparents) or
  *party* (also the cheekier ones, about every other question); ballots
  *open* (the count shows who ranked whom) or *secret* (only the
  medals); time to write (45, 60 or 90 s); latecomers (from the next
  round, or closed: `party.lateJoin`). All of them only between games.
- **Joining late**: from the next round (or closed to newcomers, the
  latecomers setting). **Too few**: a round does not start with fewer
  than three players in the game; the game ends to its final page.
  **Closing**: the lobby at once, no final page.
- **Skipping**: while a question is asked, ranked or written, the VIP
  (or the host page) can skip it; another one of the same kind comes. A
  skipped suggestion does not come back.

## 3. A vote round

```
ask ─▶ rank ─▶ count ─▶ title ─▶ standings
 5 s   ≤ 30 s   ~1 s a ballot   7.5 s    7 s
```

- **Ask.** The front page spins in: the question as the headline
  ("Poll of the day", or "A reader's question from Anna"), the suspects
  below.
- **Rank.** Every phone shows every candidate (players and honorary
  ones, oneself included). Tap gold, silver, bronze; tap again to take a
  medal back; File it. The TV is the contact sheet: a FILED stamp on
  each voter's photo when their ballot is in. At the deadline a partial
  podium is filed as it is.
- **Podium size**: three places, or two with three candidates (the
  third is then implied). A podium is better than one vote: with few
  players single votes tie all the time (three players, one each), and
  every ballot moves the count.
- **Count.** Gold is worth 3, silver 2, bronze 1. The TV counts the
  ballots one by one in a shuffled order: the ballot slip (who it is
  from with open ballots, "Secret ballot" otherwise), the medals landing
  as clippings on columns over each photo, a drumroll, the winner
  circled in red.
- **Winner**: the most points, then the most golds; still tied, the
  title is shared. No ballots: "No comment".
- **Title.** A camera flash, the front page: EXCLUSIVE, the winner's
  photo taped on, the name huge, the title in red italics, a short
  article (the question, how many sources gave gold, the points).

**Points** (reading the room), per voter:

| | |
|---|---|
| each name of your podium in the room's top three (the three with the most points, and anyone with as many as the third) | +1 |
| your gold went to a winner | +1 |
| your gold was yourself, and you won | +1 (self-aware) |

## 4. An answer round

```
ask ─▶ write ─▶ the column ─▶ match ─▶ reveal ─▶ standings
 5 s   ≤ 60 s     5 s + 1.3 s a note    ≤ 35 s + 3 s a note   5.6 s a note   7 s
```

- **Write.** One answer of at most 80 characters (two with three
  players, below). The TV shows letters to the editor arriving: an
  envelope per player, sealed with their photo when they sent theirs.
- **Answers are made alike**: one line, the first letter a capital, no
  full stop at the end, shouting turned to lower case, no emoji (the
  library drops them). Typing habits would give a writer away every
  round; what is left is what they wrote.
- **The gossip column.** All answers as numbered typed notes (Courier),
  shuffled (nobody's two next to each other where it can be helped),
  without names. Time to read them out and laugh.
- **Match.** On the phone each note gets a name: tap a note, pick its
  writer (each name once, or as often as they wrote); one's own notes
  are greyed. One heart for the favourite note (not one's own). Players
  who wrote nothing guess every note. Notes left open are no guess.
- **Reveal**, note by note: the note big, the guessers' faces land on
  the photos they named, then the writer's photo is clipped onto the
  note and a stamp comes down: **BUSTED!** when most guessers were
  right, **GOT AWAY** when not, "Nobody guessed" when nobody did.

**Points**: every guess is worth one point, to the guesser when right,
to the writer when wrong. Hearts are worth nothing but the cover.

With fewer than two writers there is nothing to match: the reveal shows
the notes and their writers, without points.

## 5. Three players

Each round kind fails differently with three, so each gets its fix:

- **Vote**: the podium (two places with three candidates) instead of a
  single vote, so 1–1–1 ties are rare; honorary candidates add names to
  vote for.
- **Answer**: with one answer each, a guesser matches two notes to two
  names: a coin toss, and the second is forced. So with three players
  everyone writes **two** answers (90 s instead of 60): a guesser matches
  four notes to two names, each name twice, six ways to do it.

## 6. Questions

**The deck.** `data/questions.txt` (English) and `data/questions.de.txt`
(German, written separately, not translated: titles live on wordplay):
`kind<TAB>level<TAB>question[<TAB>title]` per line, about 350 each,
`family` and `party`. Content rules, what makes a good question and
title, and the German approach: `games/busted/design/questions.md`;
`npm run questions` checks a list. The room plays no question twice
until it played every fitting one (the host page keeps the played ones
in `localStorage`, across games).

**Suggestions.**

- **Suggest** (✎ on every phone, any time): the kind (who would most
  likely / everyone answers), the question (10–120 characters, a
  question mark added when missing), for a vote an optional title (at
  most 28 characters; without one: "Most Likely To"). At most three of a
  player's wait at a time; the same question twice is refused.
- **Rate**: every other phone gets the suggestion on the **editor's
  desk** whenever it waits (the lobby, after filing, between stages):
  the question without its author and three stamps, PRINT IT (+1), MEH
  (−1), NO WAY (removes it at once, whoever presses it; nobody learns
  who).
- **Approved** when at least half of the others rated it and it has more
  👍 than 👎; **dropped** as soon as the ratings still to come could no
  longer lift it above zero.
- **Played**: each round takes the approved suggestion of its kind with
  the best score (👍 − 👎; the older one when tied), never by the author
  of the suggestion played just before; without one, the deck's. The TV
  and the phones credit the author ("A reader's question from Anna"),
  and the end has an award for it.
- **Moderation**: the host page lists every suggestion with its author
  and ratings and can spike any. Nothing is filtered automatically.

## 7. The end

The special edition, alternating on the TV: the standings with the
headline "ANNA KNOWS THE ROOM BEST" and the awards, each only when
earned (knows the room: the most points; most titles: two or more;
master of disguise: the most wrong guesses on one's notes; readers'
favourite: the most hearts; star reporter: the most suggestions
printed), then **the newsstand**: a magazine cover per player and
honorary candidate in their colour, BUSTED! as the masthead, their
portrait, their titles as cover lines (the first on a yellow sticker),
their best-liked answer as a quote; a spotlight goes from cover to
cover. Each phone shows its own cover. The VIP's phone offers another
edition.

## 8. What phones and the TV know

- `party.room` (every phone): the people (names, colours, portraits),
  the round's question, candidates and podium size, deadlines; from the
  column on the notes **without writers**.
- `player.state` (one phone): the task, its own podium or answers, its
  own note numbers (to grey them), its score, its desk (the next
  suggestion to rate, never with its author; its own suggestions and
  where they stand) and at the end its cover.
- `party.screen` (the TV): the same, plus who has filed; the ballots
  only from the count on (with voters only with open ballots); writers
  and guesses only from the reveal on.
- Every stage reaches the phones when the TV shows it (`withTv`).
- Tests check the secrets: no writer, guess or ballot in any view
  before its stage, no voter with secret ballots, no author on the desk.

## 9. The look

A gossip paper on newsprint, the whole screen a page:

- **Type**: UnifrakturMaguntia for the masthead; Anton for headlines,
  names, stamps and numbers; Playfair Display (italic) for decks, titles
  and quotes; Courier Prime for the anonymous notes (typed tips: no
  handwriting to recognise); Libre Franklin for small print. All SIL
  OFL, bundled (`phone/fonts/README.md`).
- **Colour**: newsprint with a soft vignette and the fold, black ink,
  tabloid red for kickers, stamps and buttons, flash yellow only for
  small stickers (readers' questions, a cover's first title), the
  players' ink colours as photo frames.
- **The masthead** on every page: the ears (the round and the price,
  "one laugh"; the readers and the weather, "gossip, 100%"), the issue
  number, the motto, today's date.
- **Motion**: the front page spins in like an old film's newspaper;
  stamps slam down; envelopes drop in; a camera flash for every title
  and every busted writer; the newsstand's spotlight.
- **Sound**, synthesized: shutter and flash, rubber stamp, typewriter
  keys and bell, the press rolling, paper rustle, a ballot's tick, a
  drumroll, the clock's last seconds, a fanfare.
- **Streaming**: the TV is H.264, so no fine textures (big halftone dots
  only), red as solid blocks and big type.
- **The phone** is a reporter's notebook in the same paper and type;
  buttons are red stamps; the desk's buttons are rubber stamps.
- The join badge sits bottom right; pages keep clear of it.

## 10. Files

`game/rules.ts` (the lists and the deck, cleaning typed texts, podiums
and the tally, cards and matching, ratings), `game/face.ts` (portraits
and doodles; the pages import it), `game/game.ts` (the party),
`game/bots.ts`, `host/` (the host page with the editor's desk),
`screen/` (the TV), `phone/`, `data/`, `design/questions.md`. Tests:
`test/rules.test.ts`, `test/game.test.ts` (whole games with bots: both
kinds, three players, secrets, ballots, refusals, deadlines,
suggestions, skipping, honorary candidates, portraits, drop-outs,
settings, latecomers, too few, a TV behind, closing, German),
`test/questions.test.ts`, and the live check `test/live/play.ts`.
