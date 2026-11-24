# Shifty (design)

A social deduction word game for 3–10 players in `games/shifty`: a web
app on `@tvpipe/party`, like `games/drawbluff`. Everyone but one gets
the same secret word from a board of sixteen; the **phony** sees only
the board. One by one, everyone types a one-word clue that proves they
know the word without giving it away. Then the room accuses someone, and
the phony gets one last chance: name the word.

The idea is an old parlour game, played today as "Imposter", "The
Chameleon", "Spyfall" or "Undercover". The rules here, the name, the
words and the look are our own. What a TV and phones add over passing
one phone around is the evidence: the clues stay pinned on the TV, and
how everyone typed them is there too.

## 1. Why it is fun

- **Bluffing with one word.** The innocents have to be vague enough not
  to hand the word to the phony, and clear enough to show they know it.
  The phony has to sound as if they know it.
- **The board is fair to the phony.** Sixteen words of one category are
  on the TV (zoo animals: lion, zebra, flamingo …), so the phony knows
  what the word could be and can give a clue that fits several. A good
  phony hides in plain sight, and a good innocent watches who is vague.
- **Typing has tells too.** Talking gives away the "uhh", the pause, the
  shaky voice. Typing gives away the same, if the room can see it: the
  TV shows each player's typing live as blank tiles (letters appear and
  vanish, nobody can read them) and as the needle of a lie detector
  that scribbles with every key, kicks with every deletion and runs flat
  while they hesitate. "Ben wrote nine letters, wiped them all, then
  wrote four." The needle's trace stays as evidence.
- **The accusation is secret.** Everyone accuses on their phone at once;
  the TV reveals the votes together as red lasers, so nobody follows
  the room.
- **The phony's last chance.** Caught or not, the phony picks the word
  from the board on their phone while the TV's scanner sweeps the board.
  A phony who listened well wins even when caught.
- **The replay.** After the word is out, threads run from every clue to
  it. Clues that were right pull tight; the phony's dangles.

## 2. A round

```
deal ─▶ clues (one turn each, in turn) ─▶ accuse ─▶ verdict ─▶ last chance ─▶ reveal ─▶ scores
 7 s     ≤ 25 s a turn (1 or 2 each)       ≤ 60 s    ~6–10 s     ≤ 20 s         ~8 s       7 s
```

- **The deal.** The room's category deck deals a category (none twice
  until all were dealt, game after game) and sixteen of its words for
  the board; one of them is the secret. One player is the phony, picked
  at random every round (no rotation: a rotation would let the room
  count). The TV deals the board card by card. Every phone shows a card
  face down; a tap turns it (and back), so a neighbour's glance is no
  leak: the word, or "You are the phony", with the board below it.
- **Clues, one turn at a time.** The order is shuffled each round; the
  phony never goes first (the first clue is given blind, which would be
  unfair to the phony). With 2–5 players everyone gives two clues (in
  two passes), from 6 one; the room can choose 1 or 2. A turn:
  - The TV turns its spotlight on the player; the others dim. The
    player's phone has a field and Send; everyone else's phone says who
    is typing and shows their own word (or "phony") and the board.
  - While they type, the TV shows blank tiles for the letters (as many as
    are typed, never the letters) and their needle moves (§4).
  - A clue is one word (no spaces; hyphens and apostrophes are fine), at
    most 24 letters, and may not say a word of the board (§3). A refused
    clue comes back to the phone with the reason, and the TV's needle
    kicks red. The same rule for everyone, so a refusal tells the phony
    nothing (a rule that refused only the secret word would let the
    phony probe for it).
  - Send pins the clue under the player on the TV, with a typewriter's
    bell. Time up (25 s; 15 or 40 as a setting) pins "…": silence is
    suspicious too.
  - A player who is away when their turn comes is skipped ("away").
- **Out loud** (a setting, for a loud table): no typing. The spotlight
  says "Say it!", the player says one word to the room and taps Done;
  the phone has a field to pin the word on the TV too (optional; a clue
  that names the board is refused the same way). No tiles, no needle.
- **Accuse.** All clues on the TV, the board below, the clock (60 s;
  45, 90 or 120 as a setting): the room talks. Every phone lists the
  others; one tap picks, Accuse makes it final. The TV shows who has
  accused, never whom. It ends when everyone has, or at the deadline;
  no accusation is no vote.
- **The verdict.** Red lasers fire from each accuser's name plate to the
  accused, one by one. Whoever has the most, alone, steps forward and
  a neon sign buzzes on: PHONY (caught) or INNOCENT. A tie at the top, or
  no accusation at all, catches nobody ("No one is sure"). If the phony
  was not caught, the spotlight swings to them: "The phony was Mia".
- **The last chance.** The phony picks the word on their phone from the
  board (20 s). The TV shows the board big with a scanner sweeping it;
  the pick lands, the secret word lights up.
- **The reveal.** The word lit up, threads of light from every clue to it, the
  points of the round on the name plates.
- **Scores**, then the next round. After the last, the final screen:
  the podium and the awards (§6).
- **Three players** work: two innocents and the phony, two clues each.
  The phony is caught only when both innocents accuse them (the phony's
  own accusation makes a 1–1–1 tie otherwise), so a careful phony has a
  fair chance, and the last chance decides many rounds. From four the
  accusation is more of a debate.
- **Settings** (the host page, or the VIP's phone in the lobby and at
  the end; none during a game): the language (the room's: every phone
  and the TV speak it; only a language with words), rounds 3–6
  (default 4), clues typed or out loud, clues each auto/1/2, time for a
  clue 15/25/40 s, time to talk 45/60/90/120 s, the typing shown on the
  TV or not (the tiles and the needle), and whether latecomers wait for
  the next round or cannot join during a game (`party.lateJoin`). The
  VIP's `settings` action takes the host page's keys (`lang`, `rounds`,
  `mode`, `clues`, `clueTime`, `talkTime`, `typing`, `late`) with the
  same choices; the room view carries them (and `langs`, the languages
  with words), and a change from the phone shows on the host page.
- **A game** of four rounds with six players takes about 15 minutes:
  6 × ≤ 25 s of clues, ≤ 60 s to talk and ~45 s of verdict, last chance
  and reveal a round.
- **Leaving and joining.** A phone that drops out keeps its seat (the
  library) and its turn is skipped when it comes while it is away. A
  phony who leaves for good ends the round at once: the word is shown,
  nobody scores. Latecomers play from the next round. When a round is
  to start with fewer players in the game than a game needs (3;
  removed players do not count, an away phone does), the game ends to
  its final screen.
- **Closing a game** (`close()`): the lobby at once, no final screen,
  nothing of the closed game writes after it.

## 3. Clues that say the word

`checkClue(text, board, lang)` in `game/rules.ts`, known answers in
`test/rules.test.ts`. A clue is refused when

1. it is empty, has a space, or is longer than 24 characters;
2. it says a board word or one of its other names: the matcher of Krakel
   (`judge`: the same letters written as one or apart, the same stem,
   the word inside a longer one from four letters, spelling slips that
   keep the first letter, German `ae`/`oe`/`ue` for umlauts), which
   refuses `lions`, `Babylöwe`, `elefant` and `Loewe` on a board with
   the lion, the elephant and der Löwe;
3. it is a part of a board word of several (`sea` for `sea horse`,
   `fire` for `fire truck`), by its letters or its stem.

The moderation hook (`party.moderate`, kind `clue`) runs before it.

## 4. The needle and the tiles

The phone sends what typing it sees as continuous input (`{ turn, n,
k, d }`: the clue's key, the letters in the field, keys typed, keys
deleted; at most every 100 ms, the library's rate) while it is the
player's turn. The host keeps a log per turn, `[ms since the turn
began, n, k, d]` when something changed (at most 400 entries), and puts
it on the TV (`screen.turn.keys`). Never the letters.

The TV draws from the log alone, so the trace is the same on every
screen and after a reload:

- the oscilloscope's trace (in the player's colour) runs from left to
  right while the turn runs;
- each new key is a short spike up, a deletion a deep spike down (both
  bigger when several came in one sample), the pen's rest is a faint
  tremor; nothing typed for a while is a flat line, and the last five
  seconds of the clock shake it more;
- a refused clue is a red kick;
- once the turn is over the strip stops, squeezed to the turn's length,
  and stays under the player's name plate as their record.

The tiles under the spotlit player are the field's length (`n`): they
pop in and out with the keys, and a deletion makes the suspect flinch. The TV plays a typewriter's clack for
each key and a softer one for a deletion. With "show the typing" off the
TV shows only that the player is typing (no tiles, a still needle).

## 5. Points

| | |
|---|---|
| An innocent who accused the phony | +1 |
| Every innocent, when the phony is caught and misses the word | +1 |
| The phony, not caught | +2 |
| The phony, naming the word | +2 |

So a phony who escapes and names the word earns 4, the most a round
pays; an innocent at most 2 (a sharp accusation and the phony beaten).
Small numbers on purpose: everyone reads "+2" from the sofa, and a game
of four rounds stays close.

## 6. The final screen

The podium, then three awards when someone earned them:

- **Smoothest liar**: the most points earned as the phony.
- **Sharpest eye**: the most accusations that hit the phony.
- **Shakiest hand**: the most deletions over the game (the needle's
  record).

## 7. The look and the sound

Neon noir: a black interrogation room lit by neon signs. Hot red, cyan
and amber tubes on near-black glass, haze drifting through the light,
suspects as fedora silhouettes with shifty eyes, a searchlight, an
oscilloscope, red lasers. Monoton (neon tubes) for the logo; Bebas
Neue for titles, names, the board's words, clues and the verdict's
sign; Share Tech Mono for readouts (labels, the ticker, timecodes,
small print); the system's sans for running text. Drawbluff is purple,
Garble a cutting mat with paper, Jinx felt, Krakel a sunny desk: Shifty
is the neon one, the only game without paper.

- **The lobby**: a ticker crawls along the top ("Suspects · Scan to
  join · One of you is lying"), the logo buzzes on (its F flickers now
  and then, cyan eyes peer over it), the join code sits in a camera's
  viewfinder with a running REC timecode. Each suspect who joins gets a
  mugshot: a camera's flash and shutter, their silhouette in front of
  the height lines.
- **The line-up** fills the top of the TV: every player as a fedora
  silhouette outlined in their colour, the eyes under the brim glancing
  about on their own beat, a name plate with a bar of their colour,
  the oscilloscope, then their clue cards (glass, edged in their
  colour; a new one flickers on like a neon tube). One searchlight
  sweeps to whoever is on; red when it finds the phony.
- **The board** fills the bottom: sixteen backlit glass tiles in four
  rows, framed as "Evidence". They power on in a diagonal wave and a
  scan line sweeps over them once. At the last chance a red scanner
  line runs up and down while tiles light at random; at the reveal the
  others dim and the secret word lights amber with turning rays.
- **The verdict**: a laser per accusation, the accused flinching and
  their count bumping; then the sign buzzes on (PHONY in red, INNOCENT
  in cyan), the room flashes its colour and shakes once.
- **Scores**: rows slide in, bars fill as neon tubes. **The end**:
  searchlights cross behind a podium of glass blocks, the awards
  flicker on.
- **Scenes** switch like a monitor: the old one collapses to a line, the
  new one opens from one.
- **Motion and the video**: the TV page is captured to video, so glows
  are static shadows (and a wide faint stroke under a sharp one in the
  silhouettes and traces, no filters on what moves), and animations move
  transform, opacity and clip-path.
- **Sound** (the TV, synthesized): a typewriter's clack per key and its
  bell for a clue, a low hum while the needle runs, a camera's shutter
  for each suspect who joins, tiles powering on, a laser's zap per
  accusation, a neon sign's crackle and a thud for the verdict, a drum
  roll before it, a short noir sting for the phony, the scanner's blips.
  One master gain and a compressor, as in the other games; the host
  page's preview is muted.
- **The phone**: the same room: dark glass, neon edges; the card to turn
  (a red-striped back with the eyes, the word in amber neon, "You are
  the phony" in red), the field big and in reach of the thumb; it buzzes
  when it is your turn.
- **Words are read whole** (docs/games.md): board words, clues and names
  get a smaller font (`fit.js`) instead of an ellipsis or a break.
- **Reduced motion** stops the haze, the ticker, the glancing eyes, the
  needle's tremor, the scanner, the searchlights, the flicker and the
  shake.

## 8. Views and privacy

The host is the only authority; phones and the TV get views
(`game/game.ts` lists them).

- **The secret word** is in the innocents' `player.state` only, until
  the reveal; never in `party.room`, the TV's screen view or the phony's
  state.
- **Who is the phony** is in the phony's own state only, until the
  verdict.
- **Typing** reaches the TV as counts (letters in the field, keys,
  deletions), never as text; a clue goes to the TV when it is sent
  (through `party.moderate`).
- **Accusations** reach the TV as who accused (during the vote), whom
  only with the verdict.

## 9. Words

`data/words.txt` and `data/words.de.txt`: Krakel's lists (22 categories
each, 23–28 words, `word|other name`), taken over as they are. They suit
Shifty: the words of a category are close (fox, wolf, jackal), so a clue
has to be precise, and no word or other name of a category says another
(`ball` and `football` are never in one category), which §3 needs. A
board is sixteen words of one category.

## 10. Not done (yet)

- **Two phonies** for big rooms (who do not know each other).
- **Categories to choose** on the host page, and categories of our own
  beyond Krakel's (jobs, countries, films).
- **A clue's timing** in the replay: the needle shows it, but no award
  names the quickest clue.
- **Sound on the phones.**
