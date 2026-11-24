# Jinx (design)

Status: design, not implemented. "Jinx" is a working name. The game will
live in `games/jinx` (a web app on `@tvpipe/party`, like
`games/drawbluff`). The design work behind this document is in
`games/jinx/design/`: two TV mockups (`tabletop/tv.html`,
`gameshow/tv.html`, open them in Chrome), the word list (`words/`) and the
clue matcher with its tests (`matching/`).

A team word game for 3–8 players, in English and German (§11): the room
plays as one, with one bank of chips and no personal points. It takes the
general idea of *Just One*: one player guesses a word from one-word clues,
and identical clues cancel. The rest is our own: the game decides which
clues are the same, the guesser picks whose clue to turn, a pot shrinks
with every card and goes into the room's bank on a right guess,
clue-givers can bet the room's chips on a bold clue, the guess is typed
live on the TV, the bank climbs towards the room's titles and its record,
and the evening ends with the room's result, the best clues of the night
and a web of every word and clue.

The TV is the table everybody watches. The phones hold what is secret:
the word (clue-givers), the clue being written, the guess being typed.

## 1. A round

```
hot seat ─▶ writing ─▶ jinx check ─▶ reveal ─▶ verdict ─▶ replay + best clue ─▶ bank
  4 s        ≤ 45 s       ~6–12 s      ≤ ~2 min    ~6 s       ≤ 20 s              ~5 s
```

- **Hot seat.** One player is the **guesser**, in turn. Everybody else is
  a **clue-giver** and sees the secret word on their phone. The TV never
  shows the word before the verdict, and the guesser's phone never does.
- **Writing (45 s, ends early when all clues are in).** Each clue-giver
  types one clue. With 3 players each clue-giver writes two. A clue may
  be marked **bold** (§4). Clues that break the rules against the secret
  word are rejected on the phone with the reason and the player types
  again (§5.3). Nothing about collisions between clues is shown or hinted
  while writing: the TV only shows who is done. Clues cannot change after
  the timer.
- **Jinx check.** All clues lie face down on the TV with their authors.
  Clues that are the same (§5.2) fly into each other and shatter, with the
  reason ("PLURAL", "SAME WORD × 3"). Everyone sees whose cards died, no
  one sees the words.
- **Reveal.** The surviving cards stay face down. The guesser picks on
  the phone which card to turn next ("Anna trusts… Ben"). After any card
  the guesser may guess once, or pass. While the guesser types, every
  letter appears on the TV as it is typed, deletions included. The room
  must stay silent.
- **Verdict.** The word comes out, the guess is judged (§5.4): right, the
  pot pours into the room's bank; wrong, 2 chips leave the bank (§4).
- **Replay.** All clues face up with their authors, the jinxed ones
  taped back together ("3 of you wrote LAVA"). After a right guess the
  guesser picks the **best clue** on the phone: the clue that helped most,
  a thank-you on the TV, no points.
- **The bank.** The room's chips on a meter with the room titles' marks
  and the record, what this round did ("+7"), the words found so far, and
  who guesses next.

If every clue is jinxed, the round goes straight to the verdict: the word
counts as missed, the bank stays as it is.

## 2. A game

- **Players: 3–8.** The game has as many rounds as guessers: every player
  guesses once with 6–8 players, twice with 3–5 (a setting can
  change it: once, twice). A game takes about 10–20 minutes.
- **Settings:** language, rounds, writing time, words and latecomers,
  on the host page or the VIP's phone in the lobby and at the end (the
  `settings` action, checked against the same choices, a language only
  with words: anything else is refused with `bad-settings`, anyone but
  the VIP with `not-vip`). The room view carries them (`lang`, `langs`,
  `settings`); a change from the phone redraws the host page. They change
  only between games (`running` during one), as on the host page.
- **Guesser order:** the join order, rotated by one each game.
- **Joining late:** from the next round, appended to the guesser order
  (the game gets one or two rounds longer). The host page or the VIP can
  close a running game to newcomers instead (the latecomers setting, the
  party's `lateJoin`: "from the
  next round" or "closed"; their phone says the game is closed to new
  players right now); a player who dropped out comes back by name either
  way. A player who leaves is
  skipped as guesser; a clue-giver who is gone when writing ends simply
  has no card.
- **Too few left:** at the start of each round (after the latecomers are
  dealt in) the game ends early, to its normal end (§6), when fewer than
  the minimum (3, `minPlayers`) are still in it; a player who left does
  not count, a phone that is only away does.
- **Closing** (`close()`, the host page's code): ends a running game and
  all its timers without an end (no final screen); the TV and the phones
  are in the lobby at once, and nothing of the old game is written after
  it. The next Start plays a fresh game.
- **End of the game:** the room's result first, then the best clues of
  the night, then the awards, then the word web (§6). The VIP's phone offers
  "Play again".

## 3. Timers

| Moment | Time | When it runs out |
|---|---|---|
| Writing | 45 s (a setting: 30 / 45 / 60 / 90) | clues not submitted are lost (no card) |
| Reveal: each decision (turn a card or guess) | 30 s | a random face-down card is turned; after the last card, a pass |
| Reveal: once the guesser starts typing | at least 15 s left | the draft is submitted as the guess, if any letters, else a pass |
| Best clue | 20 s | no best clue this round |

A guesser who is disconnected at the start of the reveal gets the same
timers: the game goes on without them.

## 4. Scoring: one team, one bank

Everybody plays for the room. There are no personal points, no ranks and
no winner: one **bank** of chips for the whole game, small whole numbers
so the pot and the bank can be towers of chips (one chip, one point).

**The pot** of a round starts at **10**. At the jinx check it loses **1
per jinxed clue**, and **2 more per bold clue** that jinxed. In the
reveal it loses **2 per turned card after the first** and wins **2 per
bold card** turned. It never goes below **2**: a right guess always pays
something.

| Verdict | The bank |
|---|---|
| right | + the pot |
| wrong | −2 (never below 0) |
| pass, or every clue jinxed | ± 0 |

**Bold** is a bet with the room's chips: "nobody else will write this,
and it is the card to turn". A bold card that survives is cheap to turn
(the turn's −2 and the bold +2 cancel); a bold card that jinxes costs the
pot 3 instead of 1. The guesser sees the flame on the face-down card.

The tension this sets up, all of it shared:

- The guesser wants to guess early (the pot shrinks with every card) and
  to be sure (a wrong guess costs the bank), so passing after the last
  card is a real choice. The room watches, silent, and wins or loses
  with them.
- The obvious clue helps most but jinxes most. Writing something only
  you would write keeps the pot whole; bold says you are sure of it.
- Who the guesser turns first is a public statement of trust; the best
  clue is the guesser's thank-you, on the TV and the phone, worth
  nothing but the moment.

**Goals.** The room titles are marks on the bank's meter, by chips a
round: **2** *Mixed signals*, **4** *In sync*, **6** *Mind readers*, **8**
*Telepaths* (a word found at once with nothing jinxed pays 10); below 2,
*Total jinx*. A game of 8 rounds needs 48 chips for *Mind readers*. The
marks move when the game gets longer (a late joiner) or shorter (a
guesser leaves). The phones say what is next: "6 more chips to *Mind
readers*".

**The record.** The host page keeps the room's best bank per game
length (rounds) in `localStorage`; the meter shows it, the end says "New
record!" when the room beat it (or set the first).

The room's count ("6 of 8 words") stays in the header as the words of
the night, found or missed.

## 5. Words and clues

### 5.1 The secret words

`data/words.txt`: about 1,000 English words, one per line:
`word<TAB>difficulty<TAB>category<TAB>also_right<TAB>banned` (the last two
optional, comma-separated). Built and curated in `games/jinx/design/words/`:

- Selected from open data on how widely known, how concrete and how
  early learned a word is (Lancaster Sensorimotor Norms, Glasgow Norms,
  CYP-LEX, Open English WordNet: all CC BY 4.0; SCOWL for US/UK spelling
  splits), then a curation pass, then a read of the whole list by hand.
  The pipeline reruns from the raw data; the raw data is not committed.
  Non-commercial datasets (word prevalence, SUBTLEX-US) feed nothing.
  The sources are credited in the game (`CREDITS.md`).
- Rules for a word: everybody at a casual party knows it instantly (kids
  from about 10, fluent non-native speakers, US and UK), several obvious
  clues and room for creative ones, one word, no plurals or inflected
  forms, no proper nouns or brands, nothing sexual, tragic or political
  (knife, sword, skull, zombie, police are in; alcohol, guns, death,
  religion, kiss are out), no US/UK split meanings or spellings (pants,
  chips, color).
- A short word stays even when ordinary words contain it by accident
  (car in carpet, lion in million): nobody writes those as clues, and a
  rejected clue is only retyped (§5.3). It is left out when a natural,
  fair clue for it would be rejected.
- `also_right`: guesses that also count (bbq for barbecue, bike for
  bicycle). `banned`: clues that are rejected as "too close" (obvious
  translations: chat for cat).
- **Dealing:** difficulty is a setting. *Easy*: easy words only.
  *Normal* (default): easy and medium, about 2:3, and one hard word in
  ten. *Hard*: medium and hard. A game never deals two related words
  (fire and firework, sea and ocean: the word notes list them). A room
  deals no word twice until it dealt them all, across games (the host
  page keeps that in `localStorage`, as Drawbluff does with prompts).

German: `data/words.de.txt`, 1,000 words in the same format and
categories (`games/jinx/design/words/de/`: 804 translated from the English
list where they make good German secrets, the rest German everyday words
like Brezel, Schultüte, Gartenzwerg). The same rules, plus: no words that
differ between Germany, Austria and Switzerland (Pfannkuchen, Sahne);
regional names for the same thing are accepted guesses (Stiege for Treppe,
Nuggi for Schnuller); `banned` holds only translations that are no fair
German clue, and a sixth column `english` says which of them are English
(with the word itself where English has it with the same meaning: planet
for Planet, not Mutter or See).

### 5.2 When two clues are the same (jinx)

This section is the English matcher; German follows the same rules with
its own forms (§11, `games/jinx/design/matching/de/SPEC.md`).

The rules are deterministic and run in the host page. Each pair of clues
is checked in this order; the first rule that applies is the reason the
TV shows. The matcher's full specification, with every table, is
`games/jinx/design/matching/SPEC.md`; the prototype is `match.ts` with
461 known-answer cases.

**Cleaning** (on every clue and guess): Unicode NFKC, lowercase, accents
off (café = cafe), punctuation off (U.S.A. = usa), spaces and hyphens do
not matter (ice cream = ice-cream = icecream), runs of 3+ letters shortened
(hmmmm = hmm), a leading a/an/the/to off when there are two words, number
words to digits (seven = 7; 007 stays 007). A clue is one word; two
words are allowed and joined (ice cream, New York), three are rejected.
At most 24 characters. No emoji: phones cannot type them and the host
removes them before the matcher sees a clue or a guess (a picture of the
word would be cheating), so a clue of only emoji is empty. The matcher
itself still treats emoji as decoration (`design/matching/SPEC.md`).

| # | Rule | TV | Same | Not the same |
|---|---|---|---|---|
| 1 | same after cleaning | SAME WORD | Cat/CAT, ice cream/icecream | |
| 1b | same number | SAME NUMBER | 7/seven, 1st/first | 7/007 |
| 2 | UK/US spelling, ph = f | OTHER SPELLING | colour/color, mum/mom | four/for |
| 3 | plural | PLURAL | glass/glasses, mouse/mice | news/new |
| 4 | verb form | VERB FORM | hope/hoping, swim/swam | hoped/hopped, saw/see |
| 5 | word family | SAME FAMILY | prince/princess, teach/teacher, sun/sunny, france/french | corner/corn, mother/moth, universe/university |
| 6 | typo (5+ letters, never between two dictionary words) | TYPO | chocolate/choclate | shirt/short, bear/beer |

- **Cheats** jinx too (with the dictionary, strictly, so that no real
  word is caught: only a word the dictionary does not know is a disguise
  of one it knows): a word with letters doubled (dog/doog, Rad/Radd: short
  words have no typos), "OTHER SPELLING"; a word written backwards,
  exactly, 4+ letters (black/kcalb, Schwarz/Zrawhcs, but not star/rats),
  "BACKWARDS"; two words that share a word (black car/black, black
  car/car black), "CONTAINS THE WORD" or "SAME WORD". A second word on a
  card must not get its first word past the jinx.
- Grouping is **transitive**: teach ~ teacher ~ teachers jinxes all three.
  Every pair in a group keeps its reason, so the TV can explain each slam.
- **Not** the same, on purpose: homophones between clues (night/knight),
  compounds and parts (fire/firetruck), prefixes (happy/unhappy),
  synonyms and translations (cat/kitten). The game does not pretend to
  know meaning.
- Typo matching uses a **dictionary** shipped with the game
  (`data/dict.txt`: SCOWL up to size 60 with names, plus the secret words;
  about 240 KB gzipped, loaded only by the host page). Two dictionary
  words are never typos of each other.

### 5.3 Clues that are too close to the word (rejected at submit)

The clue-giver knows the word, so these are checked when the clue is
sent; the phone says why and the field stays open. Nothing is struck on
the TV.

- Rules 1–6 above against the secret word: "Too close to the word: plural".
- Sounds the same: whether for weather, knight for night, kat for cat.
- Stretched or backwards (§5.2): doog for dog, kcalb for black: "That's
  the word backwards".
- Contains the word: snowmen, t-shirt, sunflower for sun, unhappy for
  happy (but not hear for ear, giant for ant, history for story).
- Part of the word: snow or man for snowman, foot for football (but not
  land for island, plane for planet).
- The word's `banned` list.
- With 3 players: the same as the player's own other clue ("You already
  wrote that").

### 5.4 Guesses

More lenient than clues, because a refused right guess is the worst
moment of a round. Right: the same word after cleaning, other spelling,
plural, verb form, sounds the same, a typo (doubled letters from 5
letters, a wrong vowel from 6), or the word's `also_right` list. Not
right: the same family (princess for prince), a part (foot for
football), another word of similar shape (bear/beer, plane/planet). An
accepted near miss shows its reason next to the word ("≈ typo").

## 6. The end of the game

Everything at the end is about the room; nobody comes first.

1. **The room:** the bank on its meter with the title marks, the room's
   title stamp (§4), "New record!" when the room beat it, and the words of
   the night as cards (missed ones struck), "6 of 8 words".
2. **The clues of the night:** every best clue the guessers picked, each
   with its word and its author's chip (skipped when there are none).
3. **Awards** (each only when someone qualifies, at least 2), for fun,
   never for blame:
   - **Mind meld:** the pair whose clues jinxed together most often.
   - **Telepath:** most clues that survived and were turned before a right
     guess.
4. **Word web:** every word of the evening as a card, the clues as tags
   around it, and red yarn between a word and every clue the room used
   for more than one word (by the clue's cleaned form). Clues used only
   once stay small next to their word, so the web is never empty.

## 7. The TV

Both mockups are worth opening; the game takes the **tabletop** as its
look and the **game show's** pacing and voice.

### 7.1 Look: a game table seen from above

- A deep teal-green felt (`#1f4744`), one flat colour. Every piece of
  information is an object on it: clue cards (tomato backs with a
  cream **J** diamond; bold cards ink-black with a gold flame sticker;
  cream faces with the word in ink), poker-chip avatars, the pot as a
  tower of gold chips with a cream number label, the room's bank (a
  label in the header during a round, a tall meter with the title marks
  between rounds and at the end), a kraft envelope with a wax seal
  holding the word, a kitchen dial timer, rubber stamps (JINX!, RIGHT!,
  NOT IT, LOCKED IN), masking-tape labels for reasons, a red label-maker
  tape for the guess, a rosette for the best clue, red yarn and
  push-pins for the word web. Wooden letter tiles for the logo.
- Palette, type and object sizes: `games/jinx/design/tabletop/README.md`
  §2–§4. Type is IBM Plex Sans (and Plex Mono for the tape, the timer
  and the room code), shipped with the game. A handwritten face for the
  clue words is an option for later; it needs the human's OK.
- **Avatars:** each player draws a face on the phone in the lobby
  (Drawbluff's canvas, one ink colour, a few seconds) and it is printed
  into the centre of a chip in the player's colour. A shuffle button
  gives a ready-made face (and bots get one). The chip carries state: a
  crown (VIP), a blindfold (the guesser during writing), a wiggling
  pencil (writing), a ✓ (done), moods (happy, shocked, sad).

### 7.2 Motion and voice, from the game show

- **The host line:** one line of copy on a strip of masking tape under
  the header that changes with each beat, in a cheeky voice that is
  never mean, never tells the guesser anything and never asks the room
  to speak ("One word each. Don't think alike.", "Same clue? Both cards
  go up in smoke.", "SO CLOSE. SO WRONG."). Big moments land in **two
  hits**: "ANNA TRUSTS…", 650 ms of nothing, "BEN".
- **The hot seat:** a short round intro: the guesser's chip in a light
  pool in the centre, "ANNA IS IN THE HOT SEAT", the blindfold drops on.
- **Phase changes** without a wipe: objects are swept off and dealt onto
  the table. The round title ("ROUND 3", "JINX CHECK") is a rubber stamp.
- **Silence under the typing:** while the guesser types, the sound bed
  stops and only a heartbeat and the label-maker clicks are heard.
- **A light pool** (a flat lighter disc on the felt) that moves to what
  matters (the hot seat, the card being turned, the best clue), in place of the
  game show's spotlights.

### 7.3 The three big moments

1. **The jinx:** the matching cards lift, accelerate into each other and
   slam (a short table shake, a dust puff, a low thud), shatter into
   paper shards that fall with gravity, a JINX! stamp lands with the
   reason on tape, chips fall off the pot (three for a bold card). Several groups play one after another, each faster. No jinx: a
   gold CLEAN! stamp.
2. **The guess and the verdict:** the SHHH! sign swings down, every
   letter is punched into the label tape as it is typed, the tape is
   snipped, a drumroll while the envelope shivers, the word rises out of
   it. Right: a RIGHT! stamp, paper confetti, the pot pours chip by chip
   into the room's bank, every chip at the table smiles. Wrong: a NOT IT
   stamp, a trombone, the pot tumbles off the table and two chips leave
   the bank.
3. **The room's result and the word web:** the bank's meter fills past
   its marks, the title stamp lands (and "New record!"), the best clues
   of the night are pinned up; then the evening as a red-yarn board,
   drawn string by string. It is the closing frame people take a photo
   of.

The card turn is the most frequent beat: quick and satisfying (about
2 s from the pick to the chips), not spectacular.

### 7.4 Built for the stream

The TV page is rendered in a headless Chrome and H.264-encoded at about
30 fps ([`playshare-design.md`](playshare-design.md) §9):

- A 1280×720 layout (it renders sharper at 1080p and 4K), one screen, no
  scrolling, everything inside a 5 % safe area (x 64–1216, y 36–684).
- tvpipe's join badge (the join code, outside the lobby; the lobby shows
  it big) sits in the bottom-left corner, inside the table's edge, and
  the picture keeps out of its room (`layout.js` `joinRoom`, from
  `data-tvpipe-join` and `--tvpipe-join-w`/`-h` on `<html>`, in stage
  px): the writers' seats keep their right end and sit closer together,
  a row of cards (the jinx check, the reveal, the replay), the verdict's
  seats and the best clues of the night move right of it, the awards
  close up, the word web's last row starts right of it with narrower
  cards.
- Nothing under 24 px (but the longest clues, §11); clue words 40–44 px,
  shrinking to 24 px, then condensed (`scaleX` ≥ 0.74) so 15 letters fit
  on a card, down to 0.6 for longer ones, two lines beyond (§11). 5–7
  surviving cards use two rows.
- Flat colours and hard edges, short shadows; no grain, noise, fine
  patterns or large gradients; few, big particles.
- Only transform and opacity are animated (plus small clip-path and
  stroke wipes), with the Web Animations API, no library, no canvas.
  Full-frame motion is limited to short table shakes (at most three per
  round). No idle loops on large areas.
- Nothing important faster than about 6 frames.
- Sound is synthesized with Web Audio (no audio files) and routed
  through `captureAudio`, every cue mixed through one master gain and a
  compressor; the recipes are in both READMEs. The host page's preview
  is muted (`#mute=1`, as Drawbluff); a watch page opened by hand gets
  its sound with the first tap (browsers start audio only in a gesture).
- The TV animates the difference between two views and holds every final
  state statically, so a TV that reconnects renders the current state
  without replaying anything.

## 8. The phones

| Phase | Clue-giver | Guesser |
|---|---|---|
| Lobby | name, draw your face (or shuffle), "Look at the TV!"; the VIP starts from 3 players and has the settings (language, rounds, writing time, words, latecomers) | |
| Hot seat | "Anna guesses. Get ready." | "You're in the hot seat. Don't look at anyone's phone." |
| Writing | the word on an index card, one field, the bold flame toggle, Send; a rejected clue shows the reason and stays editable; then "Sent: BEACON 🔥" | "Eyes on the TV: your friends are writing", who is done |
| Jinx check | your card's fate ("JINXED with Esme: plural"), not the other words | "3 clues survived · 4 were jinxed" |
| Reveal | the cards (face down or turned) and "Shh, no hints!" | the face-down cards as buttons with their authors' faces, the pot, the guess field, Pass; a picked card turns over at once with its word, and stays lifted, without Guess, Pass or another pick ("The TV turns Ben's card too…"), until the TV has flipped it |
| Verdict | the word, what the room banked ("+7 for the room · bank 23"), what your card did ("Your clue was turned", "Bold paid: +2 to the pot", "Jinxed: the pot lost 3") | ✓ or ✗, the word, the bank |
| Replay | the replay; "Anna is picking the best clue…"; "Your clue helped most!" | all clues as buttons: "Which clue helped most?" |
| Bank | the room's bank, the next title ("6 more chips to *Mind readers*"); "You're up next!" for the next guesser | the same |
| End | the room's bank, title and words, "New record!", your award; the VIP: Play again and the settings | the same |

**No phone beats the TV.** What the TV shows reaches the phones when the
TV picture with it is up (`party.withTv`: the TV's lag, `tvDelay`), and
where the TV takes its time, later still: a turned card's word after its
lift and flip (`flip`, 0.9 s after the pick; the guesser's own phone
turns it at once, but locks in nothing until then), a giver's fate near the end
of the slams (`fateBefore`), the result once the envelope is open
(`resultAfter`). Deadlines count from when the phones and the TV show
them (`party.deadline`): the next decision's 30 s from when the turned
card's word is there (the TV's dial holds full while the card turns).

## 9. Shape of the code

As drawbluff: `game/` (the rules: `rules.ts`, `match.ts`, `game.ts`, bots;
TypeScript on `@tvpipe/party`, tested in Node), `host/` (the host page:
the party, the TV, the players, settings: language, rounds, writing
time, difficulty, latecomers), `screen/` (the TV page), `phone/` (the phone page), `data/`
(`words.txt`, `dict.txt`, fetched by the host page), `CREDITS.md`.

- The host page runs all the rules and matching; phones and the TV only
  show views and send actions.
- `screen` view: the phase, the cards (authors, bold, face down or the
  word once turned or in the replay), the jinx groups with their
  reasons, the turn order, the pot, the **guess draft**, the bank. The
  word only from the verdict on.
- The guess draft: the guesser's phone sends its field's text as an
  action on every change (throttled to about 20 per second); the host
  copies it into the screen view. Only the submitted guess is judged.
- Free text the TV and the phones show goes through the party's
  `moderate` hook (party-design §6): a clue (kind `clue`) and the guess
  (`guess`) before they are checked (a replacement is checked as if
  typed; refused: `refused`, the phone asks for another), and the draft
  on its way to the TV (refused: the TV's tape stays empty). Names are
  the library's.
- Bots (for tests; the host page shows their buttons only with
  `?bots`) write clues from a
  per-word list of plausible clues, so jinxes happen, and guess the word
  after a random number of cards.

## 10. Open

- The name: check "Jinx" against existing party games before it is
  published.
- The numbers in §4 (pot 10, −2 per card, bold ±2, a wrong guess −2, the
  goals at 2/4/6/8 a round) are a first guess: play-test them with bots
  and people.
- The word family rule's not-derived list will need entries from real
  play ("same family" where players disagree).
- Languages: English and German (§11).

## 11. Languages

English and German. A room plays in one language; the matcher, the words
and the bots are that language's, and so is everything the pages say.

**The room's language.** A setting of the host page and of the VIP's
phone (for everyone), first the browser's language, then the last
choice on that computer (`localStorage`); it changes only between games
(`configure({ lang })` refuses during one).
The game sends it with the room view and the TV view (`lang`), so every
phone, the TV and the host page follow at once. A phone may switch for
itself where rebuilding its screen loses nothing (joining, the lobby,
the end); it then keeps its own language, until its VIP picks the
room's. A language whose data files the host page cannot load
(`data/words.de.txt`, `data/dict.de.txt`) cannot be picked (the room
view's `langs` has the others).

**The words.** Each language has its own list and its own dealt-words
memory per room (`localStorage`, one key per language): switching to
German and back does not deal English words again early. Bots write the
word's category in the room's language ("Tier" for `animal`) or a word
of that language, and guess in it.

**The clues.** German needs more than English's rules (`games/jinx/design/matching/de/SPEC.md`):
every noun has its own plural (Hund/Hunde, Haus/Häuser, Museum/Museen),
strong verbs change their vowel (laufen, lief, gelaufen), adjectives decline
and compare (rot, rote, röter), and an ending that is stripped by rule finds
Reis in Reise or Schal in Schale. So the German matcher (`game/match-de.ts`)
reads word forms from a lexicon built from the German Wiktionary
(`data/dict.de.txt`: 47,500 common lemmas with their forms and which word
derives from which, 343 KB gzipped, CC BY-SA 4.0, loaded only by the host
page), and its rules do what a lexicon cannot:

- **Compounds**, which German writes as one word and invents on the spot:
  an unknown word is read as a known first part (with its Fugen: Sonne-n-,
  Arbeit-s-, Kind-er-) and a known head, and inflects like its head
  (Schneemänner is Schneemann's plural because Männer is Mann's). A clue
  that contains the secret as a compound part is rejected (Sonnenblume for
  Sonne, Schnee for Schneemann); two clues that share a part do not jinx.
- **Spellings**: ä ö ü ß stay in the key; Baer, Strasse, Delphin or a
  missing umlaut on a phone (Schlussel) are another spelling, but two real
  words are never one (Bar/Bär, schon/schön). Typos are measured on a QWERTZ
  keyboard.
- **English clues**: the host page loads the English dictionary too. A clue
  that is an English word and no German one is checked only against the
  word's English translations, in their English forms, typos and disguises
  (dog, dogs, doog for Hund; planets for Planet; swam for schwimmen), never
  by the German rules: no other English word is refused or jinxed (tall for
  Tal, chops for Chips, better for Bett, wed for Hochzeit, singing for Affe
  although singe is French for it). Two English clues jinx by the English
  rules (dog/dogs). The other languages' translations match as written.
- **Reasons** are the English ones plus "word form" (declension and
  comparison: rot/rote, gut/besser); guesses also accept the female form of
  a job or animal (Lehrerin for Lehrer).

**The pages' texts.** One string table per page (`phone/strings.js`,
`screen/strings.js`, `host/strings.ts`) with numbers, plurals and lists
by `Intl`. German is written for German speakers, not translated word
for word: "du", „Anführungszeichen“, "Platz 2 von 5", the same cheeky
host on the tape ("Oh-oh. *Zwei Dumme, ein Gedanke…*", "So nah dran.
SO DANEBEN."), German stamps (RICHTIG!, DANEBEN, GEPASST, SAUBER!,
UNGÜLTIG, EINGELOGGT); JINX! stays the game's word. The reasons on the
tape: GLEICHES WORT, GLEICHE ZAHL, ANDERE SCHREIBWEISE, PLURAL, VERBFORM,
ANDERE FORM (declension, adjective endings), WORTFAMILIE, TIPPFEHLER,
KLINGT GLEICH, ENTHÄLT DAS WORT, TEIL DES WORTES, RÜCKWÄRTS. Room titles:
Telepathen, Gedankenleser, Eingespielt, Funkstörung, Totaler Jinx;
awards: Seelenverwandt, Hellseher.

**Refusals.** A refused clue carries its reason in the code
(`too-close:plural`, `own-clue:verb form`) and the matcher's message in
the room's language: a phone in the room's language shows the message, a
phone that switched says it from the code. Every other refusal is shown
by its code in the phone's language.

**Long words.** German compounds are long ("Geburtstagskuchen",
"Feuerwehrauto"; clues up to 24 characters). Every page sets `lang` on
its document for hyphenation. On the TV, card words shrink to 24 px,
then condense (§7.4, down to 60 %), and a clue too long even for that
(up to 24 letters: "STREICHHOLZSCHÄCHTELCHEN") goes on two lines of
about the same length, hyphenated where the language allows
("DONAUDAMPF-", "SCHIFFFAHRT"; a browser that cannot hyphenate: one
smaller line); so does the best clue's note and the end's word cards.
The envelope's word fits beside the verdict stamp, the word web's cards
condense further, its shared clues' tags get smaller (a band holds the
tags that fit, the links of the most words first), the host's line gets
smaller, the replay's long captions condense to their row; one-line
texts are fitted, never cut with an ellipsis (names aside). On the phone no word is ever cut off with an
ellipsis (a clue cut off is a clue lost): a card's word gets smaller
down to 60 %, then condenses to 62 %, and one too long even for that
goes on two lines of about the same length ("GEBURTS-", "TAGSKUCHEN"),
as large as both fit; the index card's word only gets smaller. What is
typed (a clue, the guess) stays readable whole too: a field's font gets
smaller when the text outgrows it, and so does a sent clue ("Sent:
DONAUDAMPFSCHIFFFAHRT", on a line of its own). A small card's two
lines are drawn over its author's chip. Running text hyphenates; titles
break between words only.
The live check (`--lang de`) plays a German room with layout checks at
390 and 320 px and on the TV page; `--long` deals the longest words and
has everyone write clues of 18–24 letters.
