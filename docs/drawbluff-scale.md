# Drawbluff at scale (design)

Status: implemented. Since `tvpipe game play` the game runs in its host
page in the browser (`game/` unchanged), the TV is the web screen only;
the Rust host and the video screens mentioned below are gone, their
measurements stay as recorded ([`playshare-design.md`](playshare-design.md)).

Drawbluff for 3 to 50 players in one mode, on one TV. Today's game
(`games/drawbluff`, `docs/party-design.md` §10) is the small end of it:
with 3–6 players nothing changes but a few extra lines on the screens.
The goal for 50: everybody's phone always has something to do, the TV
stays readable from the sofa, everybody watches the same moment, a round
lasts about as long as with 8, and the scores stay fair although not
everybody gets the same turns.

## 1. The shape of a round

Everyone draws their own prompt at the same time, as today. Then the
round puts **K spotlight drawings** on the stage, one after the other,
and every spotlight goes through the classic moments on the TV:

```
draw ─▶ [gallery] ─▶ spotlight 1 ─▶ spotlight 2 ─▶ … ─▶ spotlight K ─▶ scores
          (N > K)    lie ▸ vote ▸ reveal
```

- **K = min(N, 6)** spotlights per round. With up to 6 players every
  drawing gets the stage (today's game); with more, the rest of the
  round's drawings are shown in a short **gallery** right after drawing
  (§4), and the choice of spotlights rotates so that over the game
  everybody's drawing gets the stage before anyone's gets it twice
  (§5).
- Per spotlight a **rotating subset of players are its liars**
  (L = min(N−1, 7); everybody but the artist up to 8 players, as today).
  Every phone says what its player does for this drawing (§3).
- Everybody but the artist (and, when pipelined, the next drawing's
  liars) **votes**. Each phone shows the truth and up to 5 lies, a fair
  sample when there are more (§6); the TV shows all of them (at most 8
  lines, as today's 8-player game).
- **Pipelining** (from 13 players): the next spotlight's liars get their
  drawing on the phone when the current vote starts and write while the
  others vote and watch the reveal; they sit that one vote out. When the
  reveal ends their lies are in, so the next vote follows at once (§2).

There is one state machine for every N. What N changes is only *when*
a spotlight's liars get their drawing: at the start of its lie moment
(small N), during the gallery (the first spotlight, when there is one),
or during the previous vote (pipelined). The TV always shows the same
lie screen ("Bob drew this · the liars are writing"), but only while
lies are still missing: for 30–45 s with few players, for a few seconds
(often none) when the liars had a head start. Nothing on the TV or the
phones announces a mode; a late joiner who tips the room from 12 to 13
players only makes the next round a bit brisker.

## 2. When liars write: the plan per N

| | liars L | pipelined | voters per spotlight |
|---|---|---|---|
| N ≤ 8 | N−1 (everybody but the artist) | no | N−1 (liars vote too, never for their own lie) |
| 9–12 | 7 | no | N−1 |
| 13–14 | 6 | yes | N−L (= 7–8) |
| ≥ 15 | 7 | yes | N−7 (8 at 15, 13 at 20, 43 at 50) |

Pipelined, the next spotlight's liars are taken from those who are free
or least needed during the current vote:

- **the current artist always** (they do not vote on their own drawing,
  so they are free during it),
- never the current liars (they watch their lies fool people: the best
  moment of their turn),
- never the next artist,
- the rest by rotation (fewest lies so far this game, ties at random).

That needs N−1 (the next artist) − L (the current liars) ≥ L, so N ≥
2L+1: L=6 from 13, L=7 from 15. Below 13 the voters of a spotlight would
be too few if the next liars sat out (4 at N=10), so liars write in the
spotlight's own lie moment, as today; at 9–12 the 1–4 players who are
not liars that time see "you're not lying on this one · you vote next".

The gallery (N > 6) covers the first spotlight's lies in every mode:
its liars get the drawing when the gallery starts.

## 3. Who does what (the phone always says it)

| Task (`me.task`) | Phone shows | When |
|---|---|---|
| `draw` | the prompt, the pad | draw phase, everybody in the round |
| `wait` | "You're in! You join at the next round." | a late joiner, until the next round |
| `lie` | "You're a liar for Bob's drawing (1 of 7)" + the drawing + the input; pipelined also "It's next on the TV: you sit this vote out" | from when the liars get the drawing until they answer |
| `artist` | "That's your drawing! Watch the others try to name it." | lie and vote of their spotlight (unless they are the next liars) |
| `vote` | the drawing, the truth and ≤ 5 lies (in the TV's order) | vote |
| `watch` | the note of the moment (gallery: "your drawing is in it"; lie: "not lying on this one"; reveal: "look at the TV", then, once the TV showed the truth and its points, your result "+1000, you found it" / "fooled by Anna") + own score and **rank "#12 of 50"** | everything else |
| `scores`, `final` | score, rank of N | between rounds, the end |

Every state carries `score`, `rank` and `of`, so the phone always shows
"#12 of 50". A drawing's points count from the moment its result goes
to the phones, so no phone (score, rank or result) tells before the TV
does.

## 4. What the TV shows (legible for 50)

The TV is the shared moment; it never shows anything that is not the
same for everyone. Name lists become counts and bars when they would
not fit at sofa distance:

- **Lobby**: the QR code and the players; up to 8 as cards (today),
  more as a grid of name chips that shrinks to fit 50 (5 columns).
- **Draw**: the timer and who is done: chips up to 12, else "37 of 50
  done", a progress bar and the names of the last ≤ 6 still drawing.
- **Gallery** (N > 6): this round's other drawings, 8 per page (4×2)
  with prompt and artist, 5 s a page; a strip "Meanwhile 7 liars are
  writing for the first drawing".
- **Lie**: the drawing, "Bob drew this", the liars' chips (≤ 7) ticking
  off.
- **Vote**: the drawing and all options (≤ 8 lines, like today with 8
  players); who voted as chips up to 12, else "31 of 43 voted" and a bar.
- **Reveal**: as today, lies one by one (only those that fooled
  someone, fewest first), the truth last. Each line says who wrote it
  and "fooled Ada, Cy" up to 4 names, else **"fooled 14 of 31"** (31 =
  voters whose phone showed it); the truth "found by 20 of 43".
- **Scores**: the top lines (all up to 8 players; top 5 with more, "your
  rank is on your phone"), and the round's **highlights**: the best liar
  ("Anna fooled 23"), the sharpest eye ("Bob found 5 of 6"); at every N.
- **Final**: the winner, the top lines.

Views are a pure function of the game state, as today: the web screen
(`web/screen/`), the Node video screen (`screen-video.ts`) and the Rust
screen (`src/screen.rs`) draw the same `screen` view.

## 5. Spotlights: rotation and fairness

After drawing, the round picks K of the submitted drawings: drawings of
players still connected, the fewest spotlights so far first, then
non-empty ones, ties at random (shuffle, then a stable sort; both hosts
do it with the shared seeded generator). Over two rounds that gives
12 spotlights: everybody up to 12 players has the stage at least once;
beyond, everybody is in a gallery or on the stage every round, and
nobody gets the stage twice before everybody had it once (with three
rounds: 18 players).

Liars rotate the same way: fewest lies so far this game, ties at random
(the current artist first when pipelined, §2). At N=50 over two rounds
there are 12 × 7 = 84 liar seats: everybody lies once or twice.

## 6. Bounded choice and fair samples

The options are built as today: the truth, the liars' lies (equal lies
by `titleKey` merged into one option with several authors), decoys
(the prompt's own, see "Prompts") up to 4 options, shuffled once. The TV lists all of
them (≤ 1 + 7).

A phone shows the truth and at most **5 lies** (6 buttons and the
drawing fit a phone without scrolling), never its own lie, in the TV's
order (so "the third one" means the same thing in the room). When a
voter has more than 5 lies to choose from, the phone gets a sample that
balances exposure: voters are dealt in random order, each gets the 5
lies that were dealt least so far (ties at random). Every lie is shown
to the same number of voters ±1 (at N=50: each of 7 lies to ~30 of 43).
Up to 7 players nobody is ever sampled (today's game); from 8 on
voters are (at 8: 5 of the 6 other lies).

### Titles look alike

Nothing about how a title looks may give the truth away (the prompt
list is written carefully, lies are typed fast on a phone). The host
keeps what was typed and shows every title, the truth included, in one
display form (`displayTitle` / `display_title`, rule vectors `title …
display`): curly and other quotes and apostrophes become `'` and `"`
(German „…“ too), commas go but in numbers (a German relative clause
takes one: „Der Bär, der tanzt“ → `der bär der tanzt`), spacing
collapses, everything is lowercase, trailing `.` `!` `?` `…` and
surrounding quotes go (`"A Cat!"` → `a cat`); emoji are already gone
(`cleanTitle`). `titleKey` works on that form, so `a cat` = `A Cat.`;
per language (`titleKey(text, lang)`): English drops a leading
a/an/the, German der/die/das/ein/eine/…, and folds `ä ö ü` to `ae oe
ue` (`baer` = `Bär`), `ß` is `ss` everywhere. The prompts
(`data/prompts.txt`, `data/prompts.de.txt`) are already in it:
lowercase letters (with `ä ö ü ß` in German), spaces and apostrophes,
NFC, at most 40 characters (`test/prompts.test.ts` checks it). The phone's lie input takes at most 40 characters too (`LIE_SOFT`,
the longest prompt; the host still accepts up to 48), with
`autocapitalize="none"` and autocorrect left on.

The display form makes the case and punctuation alike, not the words.
The prompts and their decoys were all one polished shape (in English
85 % of the prompts and 88 % of the decoys began with "a", "an" or
"the", in German 78 % and 81 % with "ein", "der", …:
"a vampire at the dentist", "the moment the wifi drops"), and players
typing on a phone mostly do not write like that ("vampire at dentist",
"wifi died"): the file's titles stood out from the players' lies, and
the truth was among them. So both are written in the forms of lies:
about a third with a leading article, the rest without, in plural, as
a short label ("sweaty snowman", "schwitzender schneemann"), a
sentence ("the snowman is melting", "der schneemann schmilzt"),
"when …"/"wenn …", "my …"/"mein …", telegraphic ("cat doing taxes",
"katze macht steuer"), short and long; an idiom stays the idiom. The
prompts are in the forms of their decoys. The lints
(`test/prompts.test.ts`, `forms` and `oddForms` in
`scripts/prompt-stats.ts`), for all four files: a leading article on
15–45 % of the prompts and of the decoys, at least 15 % of at most
three words, no first word on more than 20 %; prompts and decoys
within 5 points of each other in the share with an article and the
share of short ones, within half a word in length; and no prompt is the
only one of its line with (or without) a leading article.

| | prompts (en) | decoys (en) | prompts (de) | decoys (de) |
|---|---|---|---|---|
| a leading article | 85 % → 31 % | 88 % → 33 % | 78 % → 33 % | 81 % → 35 % |
| the commonest first word | "a" 56 % → 17 % | "a" 67 % → "the" 18 % | "ein" 41 % → 9 % | "ein" 44 % → 10 % |
| at most three words | 13 % → 31 % | 9 % → 26 % | 26 % → 48 % | 19 % → 49 % |
| words on average | 5.0 → 4.2 | 5.3 → 4.2 | 4.2 → 3.6 | 4.3 → 3.6 |

(Now: the tripled files, below.) The forms were rewritten by model
agents per structure (the prompt's idea and drawing kept, the decoys
still lies for the same drawing), reviewed by another pass, then
linted; the adult files the same (English 31 % and 32 % with an
article now, German 31 % and 35 %).

### Prompts

The first prompts were all one shape ("a nervous cactus": an adjective
and a thing, or a thing in a place): quick to draw, quick to guess, and
the lies all sounded alike. Then `data/prompts.txt` had 407 prompts in
ten structures, then 665 in 17, and German has its own (698 in 18,
`data/prompts.de.txt`, below), so a round mixes kinds of drawing and
kinds of lie. With up to 5 rounds a game the lists were tripled: 1993
in English, 2091 in German, and 873 and 885 adult ones (291 and 295
before), the new ones written per structure by model agents beside
the old ones (new subjects; none a near duplicate of any prompt, none
like a prompt or decoy of the file or, for the adult ones, of the
family list), in the forms of players' lies, then reviewed by another
pass (grammar, drawable, decoys that are not the prompt reworded) and
linted:

| Tag | Structure | Example | Prompts (en) | (de) |
|---|---|---|---|---|
| `odd` | odd combinations | lonely lighthouse at a party | 138 | 141 |
| `idiom` | idioms taken literally | raining cats and dogs | 150 | 182 |
| `wort` | German compounds taken literally | glückspilz | – | 137 |
| `feeling` | abstract ideas and feelings | fear of mondays | 126 | 117 |
| `moment` | the moment when … | the moment the ice cream falls | 114 | 114 |
| `secret` | the secret lives of things | what my fridge does at night | 129 | 102 |
| `invented` | invented jobs, sports, holidays | a puddle inspector | 120 | 111 |
| `contra` | misleading or contradictory pairs | shy fireworks show | 126 | 126 |
| `view` | an unusual point of view | the world seen by an ant | 126 | 105 |
| `drama` | tiny dramas | last cookie standoff | 129 | 113 |
| `title` | famous-sounding invented titles | the phantom of the bakery | 129 | 117 |
| `animal` | animals with human problems | cat filing its taxes | 114 | 114 |
| `food` | food with a life of its own | soup that fights back | 103 | 108 |
| `place` | places that should not exist | a school for baby dragons | 99 | 102 |
| `gadget` | inventions nobody needs | hat that waters your plants | 99 | 102 |
| `power` | useless superpowers | sneezing glitter | 99 | 96 |
| `then` | history mixed up | caveman with a selfie stick | 96 | 99 |
| `scene` | everyday scenes gone wrong | grandpa's first video call | 96 | 105 |

All are written for Drawbluff, drawable, family friendly and in the
display form.

- **Format**: `[tag]` lines start a structure, then one prompt per
  line (`parsePrompts`; blank lines and `#` comments skipped; prompts
  before any tag have the tag "").
- **Length**: 40 characters at most (was 32): "the moment …" and the
  points of view need it (the longest: "the moment the referee blows the
  whistle"). The lie input follows (`LIE_SOFT` 40), so a long truth is
  no tell. Checked at 40 in every layout: the phone's prompt and input
  wrap; the TV's options, the reveal's lines and the gallery's captions
  shrink the font to fit (down to 70 %) before they would shorten with
  …; the 50-player reveal puts the title on its own line and the tag in
  front of who fell for it. German words are long ("regenbogenreparaturdienst", the longest "pfützenspringmeisterschaft", 26; the lint
  allows no longer word): the pages set `lang` and `hyphens: auto`, so
  they break with a hyphen where German allows.
- **Mixing** (`deck`, rule vectors `prompts`, `spread`, `deck`, one of
  them on the real file, and `decoys`): a deck is the prompts shuffled
  with the game's seeded rng, then spread: each next prompt is the first
  one left whose structure is not among the last seven (`SPREAD` 8, was
  3: no structure twice among eight in a row), else not among the last
  six, …, else the first one left. Players get consecutive prompts, so a
  round of up to 8 players draws 8 kinds of prompt; the spotlights are
  spread the same way after the rotation picked them.
- **No repeats in a room** (`PromptDeck`): the deck is the room's, not
  the game's: the host keeps one per language from game to game and
  deals no prompt twice until it dealt them all. When fewer than a
  round's prompts and a reserve (`DECK_RESERVE` 16) are left, a new
  deck of the other prompts goes under the rest.
- **Decoys** (too few lies for a drawing) are written for each prompt:
  three after it in the file (`prompt | decoy | decoy | decoy`), other
  titles for the drawing a player would make of it (a thing swapped for
  one that looks alike when doodled, the picture told as another
  story), at least two in the prompt's structure, so the truth is not
  the only option that sounds like a prompt. Unused prompts were the
  decoys before: unrelated to the drawing, so the picture ruled them
  out, and polished like the truth, so they singled it out among the
  players' lies. The lints (`test/prompts.test.ts`): every prompt has
  three, each in the prompts' form, none the prompt, another prompt of
  the file or another prompt's decoy. A file without decoys falls back
  to unused prompts, its own structure first (`decoyOrder`), and a
  prompt shown so is taken out of the pass (it would be a tell later).
  The decoys were written and edited by model agents per structure
  (a writer, then an editor checking each against the rules), then
  linted.

### Variety: before and after

(Measured when the structures came; the forms changed later, see
"Titles look alike", and the lists were tripled, see above: 1993
prompts in English with 2809 distinct content words, 2091 in German
with 3059, still no near duplicates, and no repeat in a room's 5 games
of 8 players and 5 rounds, nor in 3 of 50 players and 2 rounds.)

`node scripts/prompts.ts [--lang de] [--file F] [--players N] [--rounds
N] [--games N] [--spread N] [--near]` measures a prompts file; the
lints in `test/prompts.test.ts` hold for both languages (display form,
NFC, ≤ 40 characters, no word over 26, no two alike by `titleKey`, no
near duplicates, at least 1900 prompts (800 adult ones), at least 15
structures of 30 or more, none over a tenth, no repeat in 5 games of 8
players and 5 rounds).

| | before (en) | after (en) | German |
|---|---|---|---|
| prompts / structures | 407 / 10 | 665 / 17 | 698 / 18 |
| smallest structure | 36 | 32 | 32 |
| distinct words (of all) | 839 (1937) | 1315 (3351) | 1338 (2906) |
| distinct content words (no articles, prepositions) | 808 | 1282 | 1280 |
| content words used once | 625 | 921 | 1087 |
| most used words | moment 38, view 19, day 13, secret 9 | moment 38, day 13, view 12, lost 10 | moment 9, macht 8, hund 7, katze 7 |
| near duplicates (two content words in common) | 19 | 0 | 0 |

The near duplicates were pairs like "a ghost at a job interview" / "a
dinosaur at a job interview", "the moment the soap slips" / "the
moment the penguin slips", "the national day of naps" / "the national
leftovers day"; one of each was rewritten, and seven "…'s view of …"
points of view got other shapes.

A session in one room, 100 simulated sessions each: prompts dealt again
(that were dealt earlier in the session), and rounds as mixed as they
can be (no structure twice with up to 17 players). Before: a fresh deck
per game, spread over 3; after: the room's deck, spread over 8.

| session | before (407, fresh deck) | after, en (665, room's deck) | after, de (698) |
|---|---|---|---|
| 5 games × 4 players × 2 rounds | 1.4 repeats (3.5 %), 75 % of sessions; 68 % mixed rounds | 0 repeats; 100 % mixed | 0; 100 % |
| 5 games × 8 players × 2 rounds | 6.0 repeats (7.5 %), every session; 2 % mixed | 0; 100 % | 0; 100 % |
| 10 games × 8 players × 3 rounds | 54.8 repeats (22.8 %) | 0; 100 % | 0; 100 % |
| 5 games × 20 players × 2 rounds | 35.1 (17.6 %) | 0 | 0 |
| 3 games × 50 players × 2 rounds | 67.8 (22.6 %) | 0 | 0 |

(The new files alone, still with a fresh deck per game, would repeat
3.6 prompts in the 5 × 8 × 2 session; the room's deck makes it 0 until
a room dealt all 665: about 41 games of 8 players and 2 rounds.)

### Languages

A room has one language, English or German (`LANGS`): a setting on
the host page (Language; the default is the host browser's language,
German for `de…`, and its last choice) and on the VIP's phone (the
`settings` action's `lang`, one of the languages with prompts,
`room.langs`; else `bad-settings`), changeable in the lobby and on
the podium, not during a game (`configure({ lang })`, `bad-lang`
without prompts; `running`). The game sends it in every view, `room.lang` to the
phones and `screen.lang` to the TV, so every screen follows it; the
prompts, the decoys and the bots' lies are in it, and titles compare
the German way (`titleKey(…, "de")`). Each page has its strings
(`phone/strings.js`, `screen/strings.js`, `host/strings.ts`; numbers,
plurals and lists with `Intl`: "1.000 Punkte", "Ada, Bo und Cy"). Every
phone speaks the room's language, like the TV (a phone cannot switch
for itself: the whole table reads one language); before it joined it
speaks the browser's language. German is written for German speakers, not
translated: "du", „…“ quotes, "Platz 3 von 8", "Bester Bluff",
"Adlerauge", and prompts of its own (idioms like "tomaten auf den
augen", compounds taken literally like "ein glückspilz", "ein ritter
beim tüv", "die bahn hat wieder verspätung").

The live check plays it: `node test/live/play.ts --lang de` sets
the host page to German, joins a German phone (`de-DE`), has it (the
VIP) switch the room to English and back from its rules, and checks every
shot for layout problems (the phone at 390 and 320 px wide, the TV page
at 1280×720: text out of its box, boxes off the screen) and for English
left on the screen. Run against a real `tvpipe game play
games/drawbluff`: 4 players (`--bots 3`), 9 (`--bots 8`, the gallery and
6 options) and 50 (`--bots 49`), one round each, no bot errors, no
layout problems, nothing English; screenshots in `/tmp/drawbluff-de`
and `/tmp/drawbluff-de-50`. Fixed on the way: the phone's header rank
("Platz 1 von 4") was cut at 320 px (now "1. von 4"), and the drawing
tools' "löschen" broke into "lö-schen".

## 7. Scoring: per exposure

Points as today (round r counts r times), scaled so that a big room
does not inflate them:

- **found the truth**: 1000 to the voter.
- **artist**: 1000 per voter who found it, × min(1, 7 / V) (V = voters
  who voted).
- **fooled**: 500 per voter fooled, × min(1, 7 / S) to each author (S =
  voters whose phone showed that lie and who voted: its exposure).
- **same idea**: 100 to each author of a merged lie (two liars thought
  the same thing).

7 is the most voters today's game has, so up to 8 players every number
is today's. Rounded half up in integers (`(2·n·p·7 + S) div 2S`), the
same in both hosts. Examples at N=50: a lie shown to 30 voters that
fools 14 earns 500·14·7/30 = 1633 (not 7000); an artist found by 20 of
43 earns 3256 (not 20 000). One correct vote is still worth 1000, so a
good guesser (≈10 votes a game) keeps up with somebody whose drawing got
the stage, and the luck of the spotlight draw does not decide the game.

Highlights (per round, from raw counts): best liar = most voters fooled
in the round; sharpest eye = most truths found (ties: by name).

## 8. Numbers per N (default timings: draw 90 s, lie 50 s, vote 25 s, reveal 2.6 s a line + 4.5 s, gallery 5 s a page, scores 9 s)

| | N=3 | N=8 | N=20 | N=50 |
|---|---|---|---|---|
| spotlights K / round | 3 (all) | 6 | 6 | 6 |
| gallery drawings / pages | – | 2 / 1 | 14 / 2 | 44 / 6 |
| liars L / pipelined | 2 / no | 7 / no | 7 / yes | 7 / yes |
| voters per spotlight | 2 | 7 | 13 | 43 |
| options on TV / phone | 3 / 2 (all but your own) | 8 / 6 | 8 / 6 | 8 / 6 |
| TV lie moment | ~30 s each | first: gallery 5 s + ~25 s; then ~30 s | ~0–5 s (first: after gallery, ~35 s) | ~0–5 s (first: gallery 30 s + ~10 s) |
| per spotlight on TV | lie 30 + vote 12 + reveal 12 | 30 + 20 + 20 | ~2 + 25 + 25 | ~2 + 25 + 25 |
| round | ≈ 4 min | ≈ 9 min | ≈ 7.5 min | ≈ 7.5 min |
| idle phones | none but the artist | the artist | none (artist writes the next lie) | none |
| stage per player per game (2 rounds) | 2 | 1.5 | 0.6 + 1.4 gallery | 0.24 + 1.76 gallery |
| lies per player per game | 4 | 10.5 | 4.2 | 1.7 |
| votes per player per game | 4 | 10.5 | 7.8 | 10.3 |

(Small rooms end phases early when everybody answered; big rooms
usually wait for the deadline, hence the round lengths.)

## 9. Joining, leaving, the VIP

### Joining mid-game

The platform keeps the setting and a waiting flag (docs/party-protocol.md
§5.1: `lateJoin`, `inProgress`, `waiting` in the roster, `activate`);
the game decides who plays when. The game says `inProgress` from its
start to its podium, and activates every waiting player at the podium.

| `lateJoin` | A new name during a game | Dealt in |
|---|---|---|
| `wait` (default) | joins, waits ("you join the game at the next round") | at the next round's drawing |
| `open` | joins, waits ("you vote from the next drawing on") | at the next spotlight: its lies or its vote, whichever starts first |
| `closed` | refused: `bye in-progress` (4030), "A game is running and it's closed to newcomers" on the phone | — (resumes still work) |

- The default is the game's option (`lateJoin` in `GameOptions`, CLI
  `--late-join=wait|open|closed` in both hosts). The VIP changes it in
  the lobby and on the podium (`late-join` `{mode}`, three buttons on
  the VIP's phone: Next round / Anytime / Closed; refused while a game
  runs; a change tells the host page, whose Latecomers field offers the
  same three); every phone sees the line under it (`room.lateJoin`). The TV
  shows it under the lobby's QR code (from `join.lateJoin`: "Join
  anytime, even during the game" in green, "Latecomers join at the next
  round", "Joining closes when the game starts"); during a game
  tvpipe's join badge in the bottom right corner says "Join now" or
  "Join next round" over the QR code, and "Rejoin" with `closed`.
- `open` in detail: a newcomer is dealt in at the next spotlight
  boundary, when the game picks the next liars (`startLies`) or starts
  a vote, so they vote from the next drawing on and, when the liars are
  picked then (pipelined from 13 players, or the next drawing's liars
  in small games), may be a liar. Their lie count starts at the fewest
  so far, so they join the liars' rotation without jumping it. They
  never join a vote that runs (its voters are fixed when it starts),
  never draw in that round (no drawing, so no artist points), and
  their drawing comes first in the next round's spotlight rotation
  (key −4: ahead of everybody else who was not spotlighted yet). In the
  last round, once the last vote started (its reveal, the scores), a
  newcomer is not dealt in: they wait for the next game ("this game is
  about to end"); same in `wait` mode during the last round.
- The TV shows the round's newcomers discreetly, bottom left in every
  phase but the lobby: "+ Anna · + Bob · + 2 more" (`screen.joined`,
  the last three names, `screen.joinedMore`; cleared at each round's
  drawing). All three screens (web, Node video, Rust video) draw it.
- The lobby's maximum is the game's (`maxPlayers` 50).
- A player who leaves during a round is dropped from the pools; their
  spotlight is skipped (as today); lies already in stay.
- Too few: when a round would start (after the newcomers are dealt in)
  with fewer than `minPlayers` (3) in the game, the game ends there,
  to its final screen. Players who left or were removed do not count; a
  phone that is only away does (it may come back).
- The host closing the game (`close()`) is not finishing it: the lobby
  at once (TV, room, phones; no final screen), waiting players in, and
  nothing of that game (its timers, its deadlines) writes after; the
  next Start plays a fresh game. Closed bots (the host page's) never
  answer again either.
- VIP and kick: as today (the VIP starts, kicks only in the lobby, the
  next connected player becomes VIP).

## 10. The platform at 50 (`tvpipe-party`, `@tvpipe/party`)

No protocol change. The hosts send the same messages, cheaper:

- **Section-wise diffs**: a view is `{roster, room, me}` (players) or
  `{roster, screen, join}`; a flush diffs only the sections that changed
  and computes the shared sections' diff once for all clients that had
  the same version (the room's drawing is not re-diffed 50 times when one
  player's `me` changes). The bytes on the wire are unchanged (the
  session vectors still pass).
- **Sockets**: the default socket limit follows `maxPlayers` (players +
  screens + reconnect headroom) instead of a flat 64.
- **50-phone tests** in both hosts measure CPU per flush and bytes per
  state change (§11).

The sampling and rotation helpers stay in the game's rules: they need
the game's seeded generator and its rule vectors, and nothing else uses
them yet.

## 11. Measurements

50-phone tests (`npm/party/test/scale.test.ts`, `crates/tvpipe-party/tests/scale.rs`,
`PARTY_SCALE_REPORT=1`; 50 players and a screen over real WebSockets on
loopback, a ~10 KB drawing; macOS, M-series, Rust in release), host time
per flush before → after the section-wise flush (bytes unchanged):

| change | messages | bytes | Node | Rust |
|---|---|---|---|---|
| a phase with a drawing (room, screen, every `me`) | 51 | 498 KB | 4.0 → 0.84 ms | 2.9 → 0.45 ms |
| an answer (one `me`, the screen's `done`) | 2 | 257 B | 3.3 → 0.10 ms | 0.91 → 0.06 ms |
| a player leaves (the roster) | 50 | 136–139 KB | 4.3 → 0.40 ms | → 0.26 ms |

So a whole vote at 50 (43 answers) costs the host ~5 ms instead of
~150 ms (Node). What is left is bandwidth: a phase with a drawing sends
the drawing to every phone (~10 KB each, 60 KB at the limit), and the
roster is an array (protocol v1 replaces arrays whole), so every join,
drop or return sends the whole roster (~2.7 KB at 50) to everybody: up
to ~7 MB over a lobby filling up to 50. Both fit a tunnel; keyed rosters
would need a protocol change (not done).

Whole games with 50 fake phones over real WebSockets (`test/game.test.ts`,
`tests/game.rs`): every vote checked for phones without a task, more
than 6 options, options out of the TV's order, missing liars.

Live check (`node test/live/play.ts --bots 49 [--video] [--host rust]
[--rounds 2]`): 50 players, one phone in headless Chrome (it joins
first, is the VIP, draws with touch events, lies and votes when its
task asks) and 49 Node bots, the TV through tvpipe's browser player,
on loopback; all four variants (Node and Rust host, web and video
screen). A round took 166 s on the Node host (the script's timings:
draw 20 s, lie 15 s, vote 12 s) and 143 s on the Rust one (`--fast`),
two rounds 274 s: draw, a gallery of 44 drawings on 6 pages while the
first 7 liars write, then 6 spotlights (43 voters, at most 6 options per
phone, the next 7 liars writing during each vote), scores, final. No
bot errors; the web screen's page never showed `null`/`undefined`/`NaN`
and nothing below the bottom (the script checks both at every
screenshot). Found and fixed on the way:

- the web screen showed "null" under the progress bar (draw, vote) once
  the list was too long for name chips (`replaceChildren(null)`);
- the video screens (both hosts) overlapped the lines of a reveal with 7
  or 8 answers (rows of a fixed layout squeezed): from 7 answers a
  compact row (title and tag on one line, who below), drawn from
  `screens-50.json`'s new `reveal-50-full` (7 lies and the truth);
- the web screen's reveal with 6 or more answers ran off the bottom, the
  truth out of sight: the same compact row (`.reveal.many`);
- the first drawing's liars, who write during the gallery, were told "you
  sit this vote out"; now "It's the first on the TV after the gallery".

The phone lied 0–1 times a round (42 lie slots a round for 50 players), voted
in every spotlight it did not lie about and always showed its role and
rank.

Live check of joining mid-game and the new prompts (`node
test/live/play.ts --host rust --bots 12 --rounds 2 --late-join open
--late 2`; `--late-join MODE` has the phone, the VIP, tap that setting
in the lobby and shoot it, `--late N` joins N more bots, Anna and Ben,
during the first spotlight): the Rust host with the web screen, 13
players, then 15. The lobby's three buttons on the VIP's phone, the TV
under the QR code switching to "Join anytime, even during the game";
Anna and Ben joined during the first vote, got "wait"/`drawing`, voted
and lied from the next drawing on, "+ Anna · + Ben" bottom left of the
TV for the rest of round 1 (gone in round 2); in round 2 Anna's drawing
was the first spotlight (the priority for newcomers). The rounds mixed
the structures ("the cherry on top", "under the weather", "the moment
the penguin slips", "a bull in a china shop", "inside a piggy bank",
"the fear of mondays", "a snail at a marathon" in one gallery). No bot
errors, no `null`/`undefined`/`NaN`, nothing below the bottom, after
two fixes: the web screen's vote with 6 to 8 options and two or three
rows of chips ran off the bottom (`.options.many`: tighter), and the
gallery's last caption ran under the corner QR code (thumbnails 27vh,
captions on two lines at most for 40 characters). With `--late-join
closed` the late bot was refused (`in-progress`) and the corner QR code
stayed hidden.
