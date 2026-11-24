# Garble (design)

A drawing game for 3–12 players in `games/garble`: a web app on
`@tvpipe/party`, like `games/drawbluff`. One picture per player goes
round the table, and everyone has to turn it into something else by
drawing **on top** of it. Nothing is ever erased: a cat becomes a
submarine becomes a hedgehog, and the TV replays how.

0.1 was a telephone game with secret words, a Wrecker, a hunt and a
judge; its incentives fought its fun (points for chains that survive
punished the drift that makes telephone funny, and a Wrecker could not
be told from a bad drawer). 0.2 replaces it with this.

## 1. Why it is fun

- **Making the most of what is there.** The cat's body becomes the
  hull, an ear the periscope. Every step is a small puzzle with a
  creative answer, and the cleverer it is, the better the next player
  can read it.
- **The picture fills up.** Late layers are hard: the page is full of
  someone else's ink. Bad drawings make it funnier, not worse.
- **The reveal is a story**: the TV rebuilds each picture layer by
  layer, every layer in its drawer's colour, with what it was meant to
  be and what the next player saw.
- **Nobody waits.** Every step, every player works on a different
  picture at the same time.
- **One clear goal.** You score when the next player reads your layer
  right, and so does the reader. Everybody wants clear, clever
  transformations; nobody plays against the table.

## 2. A round

```
start ─▶ layer 1 (draw) ─▶ step 2 (see, guess, draw on top) ─▶ … ─▶ last guess ─▶ reveal (per picture) ─▶ best move ─▶ scores
          60 s               20 s guess + 60 s draw                    20 s         ~5 s a layer, ✓/✗        30 s vote     11 s
```

(The host page's "fast" timers: 45, 15 + 40, 15 s, the vote 20 s.) A
step is one deadline for both its parts: whoever guesses early has
longer to draw; at the guess's deadline a phone without a guess moves on
to drawing (the guess counts as wrong). The word to draw arrives only
after the guess.

- **Seats** are shuffled each round. Picture `c` starts at seat `c`;
  step `k` of picture `c` is done by seat `(c + k) % n`, so each step
  everyone is busy and no picture visits a player twice.
- **Layer 1.** Every phone deals two words; you pick one and draw it on
  a blank page.
- **Steps 2 … L.** You get the next picture: every layer so far, all in
  the same black ink (during play the ink does not tell you which
  strokes are new). First you write what you think it is now (a word or
  two). Then the phone deals your word ("Make it a **submarine**") and
  you draw on top. Your own strokes can be undone; the old ink cannot be
  touched. While you draw, the old ink is a shade lighter than yours so
  you see what is yours.
- **The last guess.** After layer `L`, the next player only guesses.
- **Length.** `L = min(setting, n − 1)` layers (setting 3, 5 or 7;
  default 5), so every picture visits `L + 1` different players.
- **Settings** (the host page, or the VIP's phone in the lobby and on
  the final screen; none during a game): the language (one for the whole
  room, every phone follows it; only one with words), rounds 1–4
  (default 2), the length, the timers (normal or fast), latecomers (from
  the next round or not during a game), undo (default on: your own
  strokes; off: every stroke counts). The VIP's `settings` action takes
  `lang`, `rounds`, `length`, `timers`, `late` and `undo`, refuses
  anything else, and the room view carries them all (`langs`: the
  languages with words); a VIP's change tells the host page.
- Missing answers: no guess counts as wrong; no drawing leaves the page
  as it was (the next guesser still sees something). A blank layer pays
  nobody, even if its word is guessed by luck.
- Joining late: from the next round (the late-join setting: wait or
  closed). Leaving: a player who left or was removed is out; one whose
  phone is only away stays in. When a round would start with fewer than
  the minimum players (3) still in the game, the game ends there, to its
  final scores.

A guess is about the **latest** layer: "what is it now?". It is right
when it says that layer's word (§3).

## 3. Judging

The machine checks; there are no judges. A guess (a word or two, at
most 28 characters) says a word when it contains it folded (case,
accents, `ß`), with the same stem, inside a longer word for stems of
four letters and more (`Piratenschiff` says `Pirat`, `Kätzchen`
`Katze`), or as one of the word's listed synonyms (`data/words.txt`:
`cat|kitten|kitty`). Stems follow the room's language: English takes
off plurals only (`-s`, `-es`, `-ies`; not `-ss`, `-us`, `-is`), German
`-en`, `-er`, `-e`, `-s` and `-n` after `-el`/`-er` (`Gabeln`; not
`Stern`), so English `tower` keeps its `-er` and `toast` does not say
`toaster`. A word of several (`ice cream`) is said by its words in a
row or written as one (`icecream`).

**Spelling slips** count too (`judge(guess, word, lang, list)` in
`game/rules.ts`, known answers in `test/rules.test.ts`): a word of the
guess (or as many words in a row as the name has, or one more: `fire
truk`, `firetruk`, `snow mann`) is right when it is no letter off a name
of up to 4 letters, one off up to 7, two from 8 (insert, delete,
replace, two neighbours swapped; as typed or without its ending:
`elefants`, `girafe`, `pengiun`, `Krokodiel`, `Schmeterling`), **and**

- keeps the name's first letter: a rhyme is another word, not a slip
  (`power` is no `tower`, `rouse` no `mouse`);
- is not itself a word or synonym of the room's whole list, by its
  letters or its stem: `house` is a house, not a misspelt `horse`;
  `Birne` no `Biene`, `Kirche` no `Kirsche` (the picture's own words
  count as the list's, for a script's words that are not in it);
- stem to stem gets only the slips the shorter stem allows (`Kuh` is no
  slip of `Kuchen`).

German guesses count with `ae`, `oe`, `ue` for umlauts too (`Kaese`,
`Schildkroete`, `Kuehe`), besides as typed (`Feuer`). There is no
"close": a guess is right or wrong, and the reveal shows it as typed.

The deal keeps words a slip apart out of one picture (`horse` and
`house`, `Mütze` and `Münze`): drawn on top of each other, the guess
could not tell them apart.

The word lists are concrete, drawable nouns, each with the synonyms and
irregular plurals people actually write (misspellings and regular
plurals are the matcher's job), and no word or synonym says another
entry's (`test/rules.test.ts` checks every pair). That costs a
few: German has no `Fledermaus` (a `Maus`), no `Spiegel` (an `Igel`),
no `Haifisch` (a `Fisch`), English no `pineapple` next to `apple`.

## 4. Points

| | |
|---|---|
| Layer `k` read right by the next player | `50 + 50·k` to its drawer and to the reader (layer 1: 100, layer 5: 300) |
| Best move (most votes, at least two; ties split it, in tens) | 200 to its drawer |

Later layers pay more because they are harder: more ink to work
around. Several rounds make a game (default 2); words are dealt from a
deck the room keeps from game to game (no repeats until all were
dealt), never twice in one picture.

## 5. The reveal

Each picture in turn, on the TV: a blank page; layer 1 draws itself
stroke by stroke in its drawer's colour, its tag says the word and the
drawer; the next player's guess card flies in with ✓ or ✗; then the
next layer draws on top in its drawer's colour, and so on. At the end
the whole picture stands with a legend (each colour, its word, its
drawer), then shrinks into the gallery. Phones can react meanwhile
(four bubbles that float up the TV). Guesses are judged as typed, but
shown (on the TV, in the gallery) as `party.moderate` lets them: a
refused one says "(hidden)" with its ✓ or ✗.

**Best move.** After the last picture, the gallery: every layer of the
round with ink is a candidate (on the phone: the picture up to that
layer, the earlier layers faded and its new strokes in its drawer's
colour, with "cat → submarine" and the drawer); each phone taps the
cleverest one (not their own). The TV shows the finished pictures and
who voted, then the winner: the layer drawing itself over the faded
picture, its word, its drawer, its votes. One vote alone wins nothing
(a taste, not a verdict): in a small room everyone may pick something
else.

## 6. The look

Paper and ink on a dark cutting mat, as 0.1: off-white paper with tape,
words typed (Special Elite) on manila tags, guesses handwritten
(Caveat) on index cards, headings in Anton. During play the ink is
black; in the reveal each layer is in its drawer's colour (the player
colours, dark enough to read on paper). Short synthesized sounds on the
TV only, all through one master gain and a compressor (nothing clips
when cues overlap); a watch page opened by hand gets its sound with the
first tap.

Words players read (the word to draw and the two to pick from, the
vote's "cat → submarine", the reveal's layer words and guess cards, the
gallery's chains, the best move) are never cut off with an ellipsis and
never broken in the middle ("Außerirdi-scher"): they carry `data-fit`
and get smaller until they fit (`phone/fit.js`, Krakel's, for the phone
and the TV); a typed guess gets smaller in its field instead of
scrolling out of sight. Under `prefers-reduced-motion` nothing blinks or
loops (the phone's last seconds, the passed page flying off, the TV's
bobbing logo and wiggling pages). Counts, plurals and lists of names
follow the language (`Intl`: "waiting for Ada, Bo and Cy").

The phone is made for thumbs: the pad as large as the screen allows,
the word to draw above it, the tools under the thumb; the guess screen
keyboard-aware, the picture as large as fits above the field. A layer
takes at most 400 strokes and 16,000 points (one message); a full pad
says so ("Out of ink", with "undo something" when undo is on) instead
of ignoring the finger.

The ink's geometry (the grid, the pens, the limits, a stroke's smoothed
path, a replay's cut by length) is one module, `game/ink.ts`, which the
rules check drawings with and the pages draw with (`phone/ink.js`), with
known answers in `test/ink.test.ts`. A replay keeps the strokes that
are whole on a sheet of their own, so a frame draws only the stroke
being drawn.

## 7. Views and privacy

The host is the only authority (docs/party-design.md §5). A layer's
word reaches only its drawer until the reveal; a guess only its writer;
the picture of a step only the player at that step. `test/game.test.ts`
watches every view of a whole game for leaks.

The TV is behind the phones (docs/games.md): everything the TV shows,
a step, a picture of the reveal and its layers, the vote, the best
move, the scores, the podium, is set in `party.withTv`, so a phone
never says "you won" before the TV shows who; deadlines are
`party.deadline` (counted from when the step is on the TV), and both
count down with `client.now()`. Replies to a phone's own action (its
guess sent, its drawing in) stay instant. Tested with a TV 250 ms
behind.

`close()` (the host page's) ends a running game and its timers, bots'
included, with no final screen: the lobby comes back at once on the TV
and the phones, latecomers are in, and nothing of the closed game
writes to the party afterwards; `play()` starts a new one.

## 8. Not done (yet)

- More than 12 players (the reveal would need spotlights).
- An ink limit per layer, and rounds where the picture is only shown
  for a few seconds.
- Bots cannot see drawings: the host page gives them what the latest
  layer with ink was meant to be, so games with bots read right most of
  the time.
- The live check's screenshots play a scripted first round
  (`game.script`: the seats and the words; `test/live/scenario.ts` has
  every layer and guess).
