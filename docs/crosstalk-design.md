# Crosstalk (design)

Status: built, 0.1.0. The game lives in `games/crosstalk` (a web app on
`@tvpipe/party`, like `games/drawbluff`); the views between host, TV
and phones are `games/crosstalk/game/views.ts`.

A team word game for 4–12 players in two teams, in English and German.
Each team has a **spymaster** who knows which of the 25 words on the
TV belong to their team. They give one-word clues, and the team has to
find its words without touching the other team's, the neutral ones, or
the **assassin**. The idea is the one of *Codenames*. The rules here,
the name, the words and the look are our own.

What a TV and phones add is a **secret line**. The clue reaches only
the team's own phones, never the TV and never the other team. That
lets **both teams play at the same time**. The price: both teams sit in
the same room and talk. What a team says while it argues over its clue,
the other team can hear. Crosstalk is that interference.

## 1. Why it is fun

- **Nobody waits.** Both spymasters think at the same time, and both
  teams guess at the same time. The TV turns both teams' cards over
  together, step by step.
- **Talk, but they are listening.** Talking is allowed, and so is
  listening. While both teams argue, the noise covers both sides. When
  one team is done, the room goes half quiet: the team still guessing
  starts to whisper, talk in code ("our word", "the thing up there"), or
  lie in a loud whisper. Nobody has to explain this; the first loud
  "what else is in a **bakery**?" teaches it.
- **One board, two clues.** Both clues aim at the same 25 cards at the
  same time, and the board is dealt so the teams' themes run into each
  other (§5). Blue's `SKY` reaches for Red's MOON. Red hears it and
  learns something about its own cards.
- **The pad.** Each team has a notepad on its operatives' phones, the
  whole game long: what was overheard, which cards are left from an
  old clue, a theory, a plan. Talking is fast and can be overheard; the
  pad is silent and slow. The spymaster does not see it. Wrong notes
  stay ("MOON = theirs??") and the spymaster cannot tell why the team
  avoids a card.
- **The reveal.** At the end of the game the TV shows what was secret:
  every clue with its cards, and both pads side by side.

## 2. A game

```
teams ─▶ round: clues (both at once) ─▶ steps (both at once, cards flip together) ─▶ next round … ─▶ the end: the key, the clues, the pads
          ≤ 90 s                          ≤ 30 s a step, until both teams have stopped
```

- **Teams.** A newcomer goes to the smaller team; in the lobby a phone
  can switch, and the VIP can shuffle. The first player of a team is
  its spymaster until another taps "Be the spymaster". After a game the
  role passes on to the next player of the team (in join order), so a
  room playing several games gives everyone a turn. A team needs a
  spymaster and at least one operative: at the start, a team with fewer
  than two gets the last to come of the other. A spymaster who leaves
  for good is replaced by the next of the team, who sees the key from
  then on (one who is only away keeps the role).
- **The board.** 25 cards (§5): **8 red, 8 blue, 8 neutral, 1 assassin**.
  Neither team goes first, so neither gets a ninth card. The TV deals
  the board face up. Both spymasters' phones show the same key.
- **Clues.** Both spymasters at once, up to 90 s (60, 90 or 120 as a
  setting). A clue is one word and a number (1–9), checked when sent
  (§4). It goes to the phones of that team only. The TV shows each
  spymaster "thinking", then "ready", never the clue or the number. The
  phase ends when both are in. A spymaster whose time runs out gives no
  clue, and their team sits out the round.
- **Steps.** Up to 30 s each (20, 30 or 45). Every team still guessing
  locks one card (§3); the step ends when every guessing team has
  locked or passed. Then the TV turns the locked cards over **together**
  (about 2.5 s). A team **stops** for the round when it
  - turns a neutral card or the other team's card,
  - has turned its number + 1 cards (a clue for 3 allows a fourth, for a
    word left over from an earlier clue), or
  - passes (not before its first card: a team guesses at least once).
  At time up, a choice most of the team pinned counts as locked;
  without one the team's round ends (`timeout`).
- **The round ends** when both teams have stopped. A short look at the
  board (3 s: who found what this round), then the next clues.
- **What a card does.** It counts for its colour, whoever turned it: a
  team that turns the other team's card helps them, and can even give
  them their last one. The **assassin** loses the game for the team that
  turned it. Both teams locking the same card in one step turns it once;
  for each team it is right or wrong as if that team had turned it
  alone.
- **Winning.** The first team with all 8 cards turned wins, at the end
  of that step's flip. Both in the same step (it happens: both teams
  near the end with a clue for two): the team with fewer wrong cards
  this game (neutral and the other team's) wins; else it is a draw. The
  assassin turned in the same step as the other team's last card: the
  other team wins. Both teams on the assassin in one step: a draw. A
  team with fewer than two players at the start of a round (people
  left) ends the game without a winner.
- **The end** (§7): the key, then the clues, then the pads, then a new
  game with the next spymasters.
- **Settings** (the host page, or the VIP's phone in the lobby and at
  the end; the same choices on both, none during a game): the language
  (one with words), time for the clues (60, 90, 120 s), time for each
  card (20, 30, 45 s), the board (tangled or mixed), the words (easy,
  normal, hard), and latecomers (from the next round, or closed: the
  party's `lateJoin`). The room view carries them all (`lang`, `langs`,
  `clueTime`, `stepTime`, `deal`, `difficulty`, `late`); a change on the
  VIP's phone shows on the host page. The language is the room's: every
  phone and the TV follow it (a phone before joining: the browser's).
- **Length.** A round is about 2½–3 minutes (90 s of clues, 3–4 steps
  of about 25 s, the flips). A game is 3–5 rounds: about 10–15 minutes.

### The room's rules

The TV says them at the start of a game, and they are not enforced
(the game cannot hear the room):

- Spymasters say nothing and show nothing: no faces, no pointing.
- Operatives may say anything. The other team may listen.

## 3. Guessing on the phones

- **Pins.** Each operative has one pin and puts it on a card with a
  tap; their team sees it with their initial ("J", "L"), the other team
  and the TV do not. The spymaster sees the pins (and cannot react).
- **Lock.** When more than half of the team's operatives who are there
  (connected) pin one card, a **Lock** button appears for them; one tap
  locks it for the step. With one operative that is pin, then Lock: two
  taps, so a slip does not turn a card.
- **Pass** is a pin too (a button below the board), with the same
  majority and Lock.
- **Early pins.** Once the team's clue is in, its operatives can pin
  while the other spymaster still thinks; Lock waits for the step.
- **Above the board:** the clue and the number, the cards turned for it
  so far ("SAILOR 3: ANCHOR, PIRATE, 1 more + 1"), the step's clock.
  The clue history of the game is one tap away (each clue with the
  cards turned for it).
- Operatives who are away do not count for the majority; a team with
  nobody there passes.

## 4. Clues

`checkClue(text, board, lang)` in `game/rules.ts`, known answers in
`test/rules.test.ts`. A clue is checked against every card still face
down, with Jinx's matcher for clues that are too close to the secret
(jinx-design §5.3, `games/jinx/game/match.ts` and `match-de.ts`,
copied as Shifty copied Krakel's): the same word, other spelling,
plural, verb form, the same family, a typo, sounds the same, contains
the word, a part of the word, the word's `banned` list. The phone says
why and which card ("Too close to NIGHT: contains the word") and the
field stays open. Cards already turned no longer count, as at the table.

- One word; two are joined (ice cream), three are refused. At most 24
  characters.
- The number is 1–9 (no 0 or "unlimited" yet: §10).
- The moderation hook (`party.moderate`, kind `clue`) runs before it.

Nothing judges meaning: a clue in another language or a rhyme is the
spymaster's own risk, as at the table.

## 5. The board

`data/words.txt`, `data/words.de.txt`: Jinx's lists (about 1,000
words each, with a difficulty and one of 18 categories), taken over as
they are. Codenames-style words want two meanings (BANK, PIANO, STAR);
Jinx's words are concrete and well known, which suits a party, and the
categories let the deal tangle the teams.

`dealBoard(words, rng)`:

- **Tangled** (the default): 25 words from 6 categories, 3 to 6 from
  each, the colours shuffled so that every category with 4 or more words
  has at least two colours, and the assassin shares a category with a
  red and a blue card. A category clue ("animal 4") is then a risk, and
  the teams' themes run into each other: sea animals next to the shark,
  the moon among Blue's sky.
- **Mixed** (a setting): 25 words from all categories at random.
- **Never together:** two words where one is a clue too close to the
  other (the matcher: `ball` and `football`, `cat` and `cats`, a banned
  translation). A clue could not tell them apart.
- **Difficulty** as in Jinx (easy, normal, hard): each word's chance by
  its difficulty. A room deals the words it had last, after all others,
  until a new pass (the host page keeps them in `localStorage`).

Whether tangled is fun or only hard, and how many categories, has to be
played.

## 6. The pad

Each team has one notepad, for its operatives only, open the whole game
in every phase.

- **Lines, not one text.** The pad is a list of lines (at most 24, at
  most 80 characters each). Anyone of the team adds, edits or deletes a
  line; a line someone is editing shows "Lea is writing…" to the others
  and cannot be edited by them until they are done (or their phone goes
  away).
  So no two phones edit the same text, and the host can apply every
  change in the order it arrives without merging. Unsent typing is kept
  on the phone (`localStorage`).
- **Tied to the board without tags.** Words of the board in a line are
  highlighted (folded as the matcher folds). While writing, a tap on a
  card inserts its word. Outside the pad, a card shows a small mark
  when lines mention it, and a long press shows those lines.
- **Nothing reads it.** No rule looks at the pad, and nothing scores.
  Its value is the board being shared and the room being audible.
- **Who sees it:** the team's operatives. Not their spymaster, not the
  other team, not the TV, not the watch link, until the end of the game
  (§7).
- The host checks every change (length, line count, the editor's lock)
  and runs `party.moderate` (kind `note`) on the text.

## 7. The end

The TV, after the last flip:

1. **The key.** Every face-down card turns at once, in its colour.
2. **The clues, round by round.** Each clue appears over its team's
   column with threads to the cards turned for it; a wrong card hangs on
   a loose thread; a card the team never found but the clue meant is
   not known (the spymaster never said), so it is not shown.
3. **The pads.** Both pads side by side, line by line as they ended,
   with the board words in their real colours: "MOON = theirs??" in
   red, on Red's own pad.
4. **The result**, and Play again with the next spymasters (the VIP's
   phone or the host page).

The phones show the same, scrollable.

## 8. The phones

- **Operative:** the clue on top, the board (5 × 5, the turned cards in
  their colours, the pins), Lock and Pass, the pad below it (it grows
  over the board while one writes). In the clue phase: the board, the
  pad, "Mia is thinking".
- **Spymaster:** the key (the same board with every colour; the
  assassin marked), the clue field and the number; while the team
  guesses, the pins and the clock. No pad.
- **Listening is not a screen.** A team that stopped has nothing new on
  its phones: the board, the pad and "Blue is still guessing". The
  advantage of being done is the time to listen and to write.

## 9. Views and privacy

The host is the only authority; phones and the TV get views.

- **The key** is in the spymasters' `player.state` only, until the end.
- **A clue and its number** are in that team's players' state only,
  until the end. The TV knows only whether each spymaster is ready.
- **Pins and passes** are in the team's state only. The TV knows only
  whether a team has locked ("Red ✓") and, after the flip, the card.
- **The pad** is in the team's operatives' state only, until the end.
- **Locked cards** reach the TV only at the flip, both together, through
  `party.withTv`, so that no team sees the other's card a moment early.
- `party.room` and `party.screen` are the same view and hold only what
  everyone may see: the board's words, the turned cards, the teams, who
  is spymaster, the phase and the clocks.

## 10. Not done (yet)

- **Clues for 0 and "unlimited"** (the table's: "none of these", "all
  the ones left").
- **A duet mode** for 2–3 players (one team against the board).
- **Seeing the other team's clue at the end of each round** instead of
  the game's end. It would make the secret line shorter and give the
  room a moment per round; the end reveal is the first try.
- **A soft assassin** for children (it ends the round, not the game).
- **Pictures** instead of words.
- **Sound on the phones.**

## 11. Decisions on the way

Recorded so they are not proposed again without a reason:

- **Talking is allowed and overhearing is part of the game**, rather
  than silent teams (phones only) or teams in separate corners. It fits
  a living room, and both teams' arguing hides both while they guess.
- **Steps in lockstep, not a race.** A race rewards speed over thought,
  and every early flip would give the other team information.
- **No rewards for listening.** A mock game (an intercept of the other
  team's clue word, a hidden "shadow" marker on the card they would
  take, a free card for a hit) showed that a risk-free free card makes
  passing early a strategy ("one card, pass, listen" beats a bold
  clue), that spymasters would read the other team's clue off the key,
  and that an exact-word intercept misses close guesses (SPACE for
  SKY). The pad replaces all of it. Being done gives a team time to
  listen and to write, and nothing else.
- **No rotating spymaster within a game, no endless board, no drawings.**
