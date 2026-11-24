# Krakel (design)

A drawing game for 3–10 players in `games/krakel`: a web app on
`@tvpipe/party`, like `games/drawbluff`. Everyone draws a word of the
same category, with time to do it well. Then the TV redraws each
picture stroke by stroke, always in the same time, and the others type
what it is: the sooner someone names it, the more for them and for the
artist. ("Krakel": German for a scrawl.)

It was asked for by children who wanted more time to draw than
Drawbluff gives, and to be ranked on how good their drawing is. A vote
for "the best" does not do that (it is a vote for friends, and against
whoever leads), so the ranking comes from the room's own reading: a good
drawing is one that is named early.

## 1. Why it is fun

- **Time to draw, and nobody waits.** Everyone draws at once, for one to
  three minutes, with colours, four widths, an eraser and undo.
- **Near misses.** A round's words come from one category (zoo animals:
  fox, wolf, jackal …), a different word for each player. A rough
  sketch is not enough: what tells a wolf from a fox has to be there.
  (Or, as a setting, mixed words: everyone draws from another category,
  and a round is a bit of everything.)
- **The replay is a race.** The TV redraws the picture under a pencil,
  in the order it was drawn, squeezed or stretched to the guess time.
  The room watches a grey shape grow legs ("hippo!", "rhino!") until
  the ear gives it away.
- **Guessing is typed, and a wrong guess costs.** Guess at the grey
  shape and the phone locks for a few seconds; wait for the ear and
  someone else is first.
- **The order is a skill.** What gives a picture away should be drawn
  first; details drawn last only show at the end. The phone and the TV
  say so while everyone draws.
- **The ranking is the room's reading.** Every drawing earns its artist
  half of what its guessers earned; the round ends with the drawings in
  that order, gold, silver, bronze. One heart from everyone picks the
  room's favourite on top of that.

## 2. A round

```
start ─▶ draw (everyone at once) ─▶ per drawing: count-in ─▶ replay + guesses ─▶ the word ─▶ gallery: hearts ─▶ ranking ─▶ scores
          120 s                                   4 s          45 s (or all have it)  6.5 s      25 s            12 s        9 s
```

- **The deal.** The room's category deck deals a category (none twice
  until all were dealt, game after game), and from it different words
  for every player: three to pick from while the category has three
  for everyone, else two, else one (ours have 23 to 28 words: three
  each up to seven players, two each for eight to ten). The category is
  on the TV and on every phone; a word only on its artist's phone.
- **Mixed words** (a setting, off by default): no category for the
  round. Every player is dealt three words from three different
  categories (the phone shows each word's category), from one deck of
  all the words (none twice until all were dealt), and none whose name
  would be right for another word of the round (`ball` and `balloon`
  are in different categories; one category never has both). The TV
  says "A bit of everything" while everyone draws; on stage every
  drawing comes with its own category, on the TV and the phones, so the
  guessers know as much as in a round of one category.
- **Drawing.** The pad: thirteen pens (black, grey, eleven colours) and
  an eraser (it paints paper), four widths, undo, clear (asks once).
  Until the first stroke the word can be swapped for another one. The
  page is kept on the phone while it is drawn (`localStorage`), so a
  reload or another app loses nothing. "Done" asks once while more
  than 15 s are left (it cannot be taken back); when time is up the
  phone hands in what there is. The TV shows who is drawing how much
  (a scribble per player that grows with their ink) and who is done,
  never what. When everyone has handed in, the round goes on.
- **On stage**, in a shuffled order, each drawing with ink (a blank page
  is skipped and earns nothing):
  - *The count-in* (4 s): whose it is, 3, 2, 1.
  - *The replay* fills the guess time (30, 45, 60 or 90 s): the drawing
    is whole after 85 % of it and stands for the rest. Time is spent by
    ink: each stroke takes the pen's way to it (45 grid units), then
    its length (a dot: 14), so a drawing of any size takes the same
    time and nothing waits for a pause the artist made. The phones show
    the same replay at the same moment (both draw `progressAt(now)` on
    the host's clock; the TV's is ahead by its own delay).
  - *Guesses* are typed on the phone and judged by the game (§3). Right:
    points by time, the phone shows them and keeps watching. Wrong: the
    phone is locked for the room's lockout (0, 2, 4 or 8 s; default 4),
    and the TV shows the guess, struck out, beside its player; a near
    miss ("so close!") is not shown: it would give the word away. The
    artist does not guess and sees who has it.
  - The replay ends when the time is up, or 0.9 s after everyone who is
    there has it.
  - *The word* (6.5 s): stamped across the sheet, the blanks filled in,
    who had it and when, what the drawing pays.
- **The gallery.** Every drawing of the round with its word and artist.
  Everyone gives one heart (not to their own; 25 s, or until all gave
  theirs; whoever has fewer than two other drawings to choose from
  gives none). Then the tiles move into the round's ranking and the
  medals land from the last place to the first.
- **Scores**, then the next round; after the last, the podium, the
  *Krakel of the game* (the drawing that earned its artist the most,
  redrawn once more) and the *sharpest eye* (the most points for
  guessing).
- **Settings** (the host page, or the VIP's phone in the lobby and on
  the final screen; all of them, the same choices, none during a game):
  the language (one with words; every phone and the TV speak the room's,
  the words and the guesses are in it), rounds 1–4 (default 2), time to
  draw 1, 1½, 2 or 3 minutes (default 2), time to guess 30, 45, 60 or
  90 s (default 45), the words (one category a round, or mixed), letters
  shown or hidden (§3), the lockout, and whether latecomers join at the
  next round or not during a game (the party's `lateJoin`, `wait` or
  `closed`). The VIP's `settings` action takes any of them (`lang`,
  `late`, `rounds`, `drawTime`, `guessTime`, `mixed`, `hints`,
  `lockout`), refuses anything else, and a change reaches the host page
  (`settings`).
- **A game** of two rounds with six players takes about 15 minutes:
  2 min drawing and 6 × (4 + ≤ 45 + 6.5) s on stage a round.
- **Leaving and joining.** A phone that drops out keeps its seat (the
  library); its drawing goes on stage without it, and nobody waits for
  its guess. Whoever was removed for good takes their drawing with them.
  Latecomers play from the next round. When a round is to start (the
  latecomers let in) with fewer players in the game than a game needs
  to start (`minPlayers`, 3; removed and gone players do not count, a
  phone that is only away does), the game ends there, to its podium.
- **Closing a game** (`close()`, for a host page): the lobby at once,
  without a podium (closing is not finishing), everyone waiting dealt
  in, and nothing of that game (its timers, its replays, its changes
  synced with the TV) writes after it; the VIP can start a new one.

## 3. Judging a guess

`judge(guess, word, lang, all)` in `game/rules.ts`, known answers in
`test/rules.test.ts`. A guess is folded (lowercase, `ß` → `ss`, umlauts
and accents off, anything but letters and digits a space) and loses its
leading article (`a`, `the`; `ein`, `der` …). It is **right** when it

1. is the word or one of its other names from the list
   (`hippo|hippopotamus`), written as one or apart (`firetruck`);
2. has the same stem (one plural or inflection ending off: `foxes`,
   `Füchse`, `Katzen`);
3. has the word inside it, for a guess of one word and a stem of four
   letters and more (`Babykatze`, `Segelschiff` for `Schiff`); or
4. is a spelling slip away: no letter off for words up to 4 letters,
   one up to 7, two from 8 (insert, delete, replace, or two neighbours
   swapped: `elefant`, `Krokodiel`, `girafe`), as typed or without its
   ending (`elefants`, `girafes`), stem to stem only as many as the
   shorter stem allows (`Kuh` is no slip of `Kuchen`), **and**
   - keeps the word's first letter: a rhyme is another word, not a slip
     (`house` is no `mouse`, `power` no `tower`);
   - is not another word of the language's whole list, by its letters
     or its stem (`Birne` is not a misspelt `Biene`, `Kirche` no
     `Kirsche`; a `swordfis` is still a swordfish, though it has a
     `sword` inside).

German guesses count with `ae`, `oe`, `ue` for umlauts too (`Kaese`,
`Loewe`, `Baer`, `Kuehe`), besides as typed (`Feuer`).

One slip more than allowed (the first letter kept) is **close**: the
phone says so (and is locked like after any wrong guess). A guess of several words is never
taken apart ("fox wolf dog" is wrong), so the lockout cannot be beaten
by typing every animal at once.

**Letters** (easy, the default): the TV and the phones show the word's
shape, a blank per letter (`fire truck` → `____ _____`). Hidden (hard):
only the category.

## 4. Points

| | |
|---|---|
| A right guess | 1000 at the start of the replay, falling evenly to 200 at its end (in tens), by the host's clock when the guess arrives |
| The first right guess of a drawing | +200 |
| The artist | half of what the drawing's guessers earned by time (without the +200) |
| The favourite | 500 to the drawing with the most hearts, at least two (ties split it) |

- The time is the host's when the guess arrives, not the phone's word:
  over a replay of half a minute a phone's few ms on the way cost a
  point or two, and no phone's clock has to be believed.
- The artist's half makes a round's drawing worth about a third of what
  a player can earn in it, whatever the number of players (each player
  guesses `n − 1` drawings and has `n − 1` guessers). An earlier draft
  paid the *average* of the guessers; with eight players that is a
  tenth of the round and drawing well would hardly matter.
- **The ranking of a round's drawings** is by the artist's points, then
  by how many named it, then by the first right guess; equal drawings
  share a place.
- Nobody plays against the table: the artist wants to be read, the
  guessers want to read. The only way to hurt a leader is not to name
  their drawing, which costs the same points.

## 5. Words

`data/words.txt`, `data/words.de.txt`: 22 categories each, 573 and 576
words, written for each language on its own (not translated word by
word).

```
== Zoo animals
lion
hippo|hippopotamus
polar bear|ice bear
```

- A category has at least 20 words (two to pick from for each of ten
  players; ours have 23 to 28) and holds things that look alike when
  doodled and can still be told apart by a detail.
- A word is concrete, drawable by a nine-year-old in two minutes, and
  spellable by one. Other names are true alternatives for the same
  thing (synonyms, regional names: `Karotte|Möhre|Mohrrübe`, short and
  long forms), never a broader word; misspellings and regular plurals
  are the matcher's job.
- A word is in one category. In a category no word or other name says
  another entry as written, so no category has both `Schiff` and
  `Segelschiff`, `ball` and `football`. `node scripts/words.ts` and
  `test/words.test.ts` check it, and that every name is right for its
  own entry and for no other of its category.

## 6. The look and the sound

A sunny desk: yellow with dots, paper cards with a fat black outline
and a hard shadow, one bouncy hand-lettered font for everything
(Shantell Sans, variable; the logo's letters bounce on its bounce axis).
Drawbluff is purple, Garble a dark cutting mat, Jinx green felt: Krakel
is the bright one.

- **The pencil draws.** On the TV a pencil follows the replay's point;
  it lifts on the way from one stroke to the next. (`cut()` in
  `game/ink.ts` gives the point and whether the pen is down.)
- **The pencil runs out.** Every clock on the TV is a pencil that gets
  shorter, with the seconds beside it; red and ticking at the end.
- **Guesses** pop up as struck-out speech bubbles in the guesser's row;
  a right one turns the row green and moves it up, in the order they
  came.
- **The ranking**: the gallery's tiles glide into their order, medals
  are stamped from the last to the first, confetti for the first.
- **Sound** (the TV page, synthesized, nothing to load): a toy
  xylophone (joins, right guesses climbing a pentatonic scale, medals,
  the fanfare), a wood block for the last five seconds, a boing for a
  wrong guess, and the pencil's scratch on paper while the replay's pen
  is down, brighter the faster it moves. Every sound goes through one
  master gain and a compressor (nothing clips when they overlap). The
  host page's preview is muted; a watch page opened by hand in a
  browser gets its sound with the first tap.
- **The phone**: the same paper and pens; the word above the pad, the
  pens below it, in reach of a thumb. It buzzes for right and wrong.
- **Words are read whole.** A word a player has to read (the word to
  draw, the word a drawing was, the blanks, the gallery) is never cut
  off with an ellipsis and never broken in the middle
  ("Schraubenschlüs-sel"): elements marked `data-fit` get a smaller
  font until they fit (`phone/fit.js`, on the phone and the TV; two-word
  names may break between the words). A typed guess stays readable too:
  the field's font gets smaller when the text outgrows it.
- **The keyboard.** On Android the page is resized to what the keyboard
  leaves, which is wider than tall: that is not a phone on its side
  (the sideways layout asks for 560 px of width), and with little
  height left everything but the picture gets smaller.
- **Reduced motion** (the system's setting) stops everything that
  loops or blinks, on the TV and the phone: the logo's bounce, the red
  seconds, the wiggles and the beating heart.

## 7. Views and privacy

The host is the only authority; phones and the TV get views
(`game/game.ts` lists them).

- A word reaches only its artist's phone until its reveal. The TV, the
  watch link and the guessers get the drawing, the artist's name, the
  replay's start and end, and (easy mode) the word's shape.
- A wrong guess goes to the TV as a transient message (`guess`: `{ id,
  text }`, through `party.moderate`); a near miss as `{ id, close: true
  }` without its text.
- While everyone draws the TV gets how much ink each player has put
  down (the phones' continuous input), never the strokes.
- Drawings are checked when they arrive (`validateDrawing`: at most 900
  strokes and 20 000 points, whole numbers on the grid, a pen of the
  palette), guesses cleaned to 28 characters.

## 8. Not done (yet)

- **More than ten players.** Every drawing needs its own time on the
  TV; a big room would need Drawbluff's spotlights (some drawings on
  stage, the rest in the gallery) or replays on the phones in groups.
- **A handicap for the leader** (fewer colours, a fat brush, a mirrored
  pad): Mario Kart's rubber band for mixed ages. The lockout and the
  typed guess already slow the fastest a little; whether that is enough
  has to be played.
- **Fill.** A bucket is not a stroke; the brush does it for now.
- **Words by age**, and more categories (jobs, school, the beach).
- **Choosing categories**: the room has no say in which one comes (a
  vote between three, or categories switched off on the host page).
- **Sound on the phones.**
