# Classes (design)

A word game for 2–10 players in `games/classes`: a web app on
`@tvpipe/party`, like `games/busted`. The idea is the old pen-and-paper
game (*Categories*, *Stadt, Land, Fluss*); the rules, the name and the
look are our own. The title is **Classes** in both languages (not
translated): a column is a *class*, and the whole game is a school day.

One round: a player stops the alphabet that runs along the frieze above
the blackboard; today's columns are chalked on the board (each a school
subject: Geography, Biology, Break, …); everyone writes one answer per
column on their phone that starts with the letter, while the TV shows
everyone's exercise book filling up with scribbles (never the words).
When the clock runs out the **school bell** rings, pens down, and the
class **grades**: column by column the TV opens the exercise books, the
room crosses out what does not count and sticks gold stars on what it
loves, anyone can look an answer up in **Wikipedia** on the TV, and the
teacher's red pen marks the points. At the end everyone gets a **report
card**.

## 1. Why it is fun

- **Everyone plays at once.** No turns, no waiting: one letter, a clock,
  all phones writing.
- **The argument is the game.** "Is a tomato a fruit?", "Xanten is a
  city?", "that's not a real IKEA product." The room decides by vote, and
  the encyclopedia on the TV settles it in public.
- **Funny columns.** Half the fun of the paper game is the house columns.
  Ours mix knowable columns (City, Animal) with silly ones (Excuse for
  missing homework, Useless superpower, A new IKEA product) and ones about
  the room (Something **Anna** would buy).
- **Stars for the best ones.** Points reward knowing (the German rules:
  20, 10, 5); gold stars reward wit, and the end shows the class's best
  answers.
- **A souvenir.** The report card: a grade per subject and the teacher's
  remarks ("Class clown", "Copies from the neighbour").

## 2. A game

- **Players: 2–10.** Fewer than 2 in the game at the start of a round:
  the game ends on its final screen (`minPlayers`, never a literal).
- **Rounds**: 3, 4 (default), 5 or 6. A letter is never played twice in a
  game; the columns change every round and never repeat in a game (except
  the classic three, below), and a room remembers the last columns it
  played (`localStorage`, per language) so a new game deals fresh ones.
- **Settings** (the host page and the VIP's phone, both, the same choices;
  only in the lobby and on the final screen; `settings` action):

| key | choices | default | meaning |
|---|---|---|---|
| `lang` | `en`, `de`, `at` | the browser's (`de-AT` → `at`) | the room's language, every phone and the TV; `at` is Austrian German (below) |
| `rounds` | 3, 4, 5, 6 | 4 | |
| `columns` | 6, 8, 10 | 8 | columns per round |
| `time` | 90, 120, 180, 300 | 120 | seconds to write |
| `mix` | `school`, `mixed`, `silly` | `mixed` | how many funny columns (§4.3) |
| `content` | `family`, `party` | `family` | party also deals the cheeky columns (Detention, `party` tags) |
| `stop` | on, off | on | the first to fill every column may raise their hand: 10 s left for all |
| `classic` | on, off | off | every round starts with City, Country, River (Stadt, Land, Fluss) |
| `letters` | `common`, `all` | `common` | `all` adds the hard letters (§3.1) |
| `late` | `open`, `wait`, `closed` | `open` | latecomers: straight away, from the next round, or not during a game (`party.lateJoin`) |

- **Austrian (`at`)** is German with Austria's school and words: the
  German columns (`data/columns.de.txt`; lines may be marked for one of
  the two, see §4.1), the German matcher and letters, de.wikipedia, the
  page texts German with Austrian overrides (Klassenvorstand, Jänner,
  "Aufstieg gefährdet" for the stamp, a school name like "Bundesrealgymnasium
  Classes", Schularbeit, …; `Intl` with `de-AT`), and grades 1–5 (§3.6).
- **Joining late** (`open`, the default): straight away. A newcomer who
  joins before the bell (letter, board, write) is in this round at once:
  a desk on the TV, the columns on the phone, the time that is left. One
  who joins after the bell (bell, grade, report) watches the grading and
  plays from the next letter. A newcomer starts with 0 points; the report
  card grades only the subjects they wrote in. `wait`: from the next
  round; `closed`: not during a game. An away player keeps
  their seat, their answers (drafts are on the host) and their score; a
  returning phone gets its whole view back.
- **Length**: with 8 columns, 120 s to write, and about 30 s of grading a
  column: about 6–7 minutes a round, 25 minutes for 4 rounds.

## 3. A round

```
letter (≤ 10 s) → board (3 s) → write (time) → bell (2.5 s)
  → grade column 1: vote (≤ 30–50 s) → marked (≈ 4–8 s)
  → … every column …
  → report (8 s) → next round, or final
```

### 3.1 The letter

- **Letters**: English `common`: A B C D E F G H I J K L M N O P R S T W
  (20, no Q U V X Y Z); German `common`: A B C D E F G H I J K L M N O P R
  S T U V W Z (23, no Q X Y). `all` adds the rest (never Ä Ö Ü). Letters
  already played this game are skipped.
- **The drawer**: one player per round, in turn (join order), skipping away
  players and bots last. Their phone shows a big **Stop!** button; the
  others' phones show "Anna stops the alphabet" and the same frieze.
- **The run**: the host sets `run: { start, step, seq }`: `seq` the letters
  still available, `step` ms per letter (110), `start` a host-clock time
  (`party.deadline`-style: from when the TV shows it). Every page lights
  `seq[floor((now − start) / step) mod seq.length]`, with `client.now()`
  (on the TV page it runs ahead by the TV's delay, so the TV and the phones
  light the same letter at the same moment). The `stop-letter` action's
  `info.sentAt` (when the drawer pressed, on the host's clock) picks the
  letter: what the drawer saw is what they get. No stop within 10 s (an
  away drawer, a bot): the host stops it itself at a random letter.
- The TV chalks the letter huge on the board; the frieze keeps the played
  letters crossed out all game.

### 3.2 The columns

Dealt after the letter, from the room's language list (§4), only columns
that work with the letter (§4.2), by the mix (§4.3). `{player}` in a
column's text is filled with the name of a player in the game (a
different one for each such column, never the same player twice in a
round where possible). The TV writes them on the board one by one (the
`board` phase, 3 s), then the clock starts.

### 3.3 Writing

- Each phone has one field per column (max 40 characters after
  `cleanText`; no emoji, as in Jinx). A phone sends its drafts as you type
  (`draft` `{ i, text }`, debounced 400 ms, and on blur); the host keeps
  the last one per column. So a phone that drops out keeps its answers,
  and a reload restores them (`player.state.answers`).
- **The TV never shows a word.** It shows every player's exercise book
  with a line per column and an abstract **scribble** on each filled line
  (`progress`: 0 empty, 1 short (< 6 letters), 2 medium (< 15), 3 long),
  so the room sees who is done and who is stuck.
- **Stop** (setting `stop`): a player whose every column is filled gets a
  ✋ **Stop!** button. Pressing it (`stop`) sets the deadline to 10 s from
  when the TV shows it, if that is sooner; the TV shows "Anna: Stop!" and
  the clock turns red. Only once per round.
- **The bell**: at the deadline (`party.deadline`) the school bell rings
  (`bell` phase, 2.5 s, "Pens down!"); drafts that arrive after the
  deadline plus 500 ms are ignored; phones lock their fields at
  `client.now() ≥ deadline`.

### 3.4 Grading

One column at a time, in the board's order. Two stages:

**`vote`.** The TV shows an exercise-book page: the column's title (its
subject's colour and name), the letter, and one line per player: the
name in the margin and the answer in that player's **handwriting**
(§6.3). The host has already:

- **Grouped the same answers** (§5.1): one *answer* per group, listing
  its writers; the TV joins them with a red bracket ("same answer"; a
  near match shows its reason: "≈ typo", "≈ spelling", "≈ plural").
- **Struck what does not count by rule** (`auto`): `empty`, `letter`
  (does not start with the letter, §5.2), and the column's own rule
  (`rule:ends`, `rule:double`, `rule:two`, `rule:long`, §4.1). These are
  crossed out in red with the reason at once and cannot be voted on.

On the phones: the same list, every answer with its writers' names. On
answers not your own (an answer is yours when you are among its writers)
and not struck by rule:

- **✗ Doubt** (a toggle, `doubt` `{ id, on }`): "does not count".
- **★ Star** (`star` `{ id }` or `{ id: null }`): one gold star per player
  per column, on an answer of someone else.
- **📖 Wikipedia** (`wiki` `{ id }`): open it on the TV (§3.5). On every
  answer, your own too, and on answers struck by rule (to show the room).

and a **Done** button (`done` `{ done }`). The TV shows who is done (a
tick at their name), never the doubts or stars before `marked`. The
stage ends when every connected player in the game is done, or at its
deadline: 25 s + 2 s per answer open to a vote, at most 50 s (`vote`
timings). An open Wikipedia article extends it (§3.5).

**`marked`.** The TV's red pen goes down the page: crossed out what the
room struck ("✗ 3 of 4"), a tick on the rest, the bracket of the same
answers, the circled points beside each line (20, 10, 5, 0), then the
gold stars fly onto their answers. 2 s + 600 ms per line. Phones show
the same result (inside `withTv`), then the next column.

**Struck by the room**: an answer is struck when **more than half** of
the other players in the game (in the game this round, connected or
not, not among its writers) doubted it. Away players and players who did
not vote count as "it counts". With 3 players: 2 others, both must doubt. With 2 players the other one decides alone: one doubt strikes (the duel is played on trust, and Wikipedia is there to settle it).

**Points** (the German rules), per writer of a valid answer:

- **20**: the only valid answer in the column (one writer, nobody else
  has a valid answer there);
- **10**: a valid answer nobody else wrote;
- **5**: a valid answer two or more wrote (a group);
- **0**: empty, struck by rule, or struck by the room.

### 3.5 Wikipedia on the TV

During `vote`, anyone taps 📖 on an answer. The host page looks it up in
the room's language Wikipedia and shows the article on the TV and on
every phone in **reader mode**: like a browser's reader view, the
article's text with its formatting (paragraphs, headings, lists, bold and
italic, links), the title, the short description and the lead picture,
without the clutter (infoboxes, tables, navigation boxes, references,
edit links, footnote marks, "See also" and the like). Players can **follow
links**, go **back**, and **search** for another article, as in a
browser; the TV follows whoever reads. One article is open at a time for
the room.

- **Finding the article** (in `game/wiki.ts`, with an injectable `fetch`
  so it is tested on recorded fixtures): first the answer as an exact
  title, redirects followed (`action=query&titles=…&redirects=1&prop=pageprops|description|pageimages`),
  then a full-text search (`list=search`, 5 results) when there is no such
  page. A **disambiguation page** (pageprops `disambiguation`) is shown
  like any article: its list of links is what the reader follows. The
  search's other results are offered (`results`: titles and the snippet
  as plain text).
- **The text**: the article's HTML from the REST API
  (`https://{lang}.wikipedia.org/api/rest_v1/page/html/{title}`, Parsoid
  HTML), turned by `game/wikitext.ts` into a small, safe structure (below)
  by a **hand-written HTML tokenizer and a whitelist** (no DOMParser, so
  it runs and is tested in Node; never HTML in a view). Kept: paragraphs,
  section headings (h2, h3), list items (with depth and ordered numbers),
  block quotes, definition lists as paragraphs, bold, italic, and links
  to other articles (Parsoid's `rel="mw:WikiLink"`, `./Title`, only the
  main namespace: no File:, Category:, Help:, Datei:, Kategorie:,
  Spezial:, …; red links are plain text). Dropped: tables, infoboxes,
  navboxes, figures (the lead picture comes from `pageimages`), math (its
  alt text kept), references and footnote marks, hatnotes, edit links,
  coordinates, and the sections See also, References, Notes, Further
  reading, External links (German: Siehe auch, Literatur, Weblinks,
  Einzelnachweise, Anmerkungen). Entities decoded (named HTML5 ones that
  matter and numeric), whitespace collapsed. At most 400 blocks and 20,000
  characters of text: cut at a block, with "…" and a link to the full
  article on Wikipedia (the phone opens it in a new tab).
- **Following**: a link on a phone (`wiki-go` `{ title }`), the search
  field (`wiki-go` `{ q }`: exact title first, then search, as above),
  another result (`wiki` `{ id, pick }`) and Back (`wiki-back`) change the
  room's article; whoever did it **drives**. The host keeps the history
  (up to 20) and a cache of the last 20 articles (Back never fetches).
- **The TV follows the driver**: the driver's phone tells the host which
  block is at the top of its screen (`wiki-at` `{ block }`, at most 4 a
  second, only from the driver, never counted as a lookup), and the TV
  shows the article from that block on, in two columns, the picture
  beside the first; links on the TV look like links (it is Wikipedia) but
  are only text. The TV's header names the driver ("Anna reads
  „Kobold“") and the trail (Kobold › Pumuckl). Other phones scroll freely.
- **Time**: opening, following, searching or switching extends the
  vote's deadline to at least 20 s from when the TV shows it, at most 90
  s added per column in all. The article closes with the stage, or by
  `wiki-close` (anyone): the driver's ✕ or "Back to grading" sends it (the
  article closes on every phone and the TV); on another phone they only
  put it aside for that phone, which has "Close for everyone" for the
  rest.
- **Limits and failure**: a player may open, follow, search or switch
  once every 2 s and 15 times a column (Back and `wiki-at` are free); a
  title or query at most 200 characters. While loading, the TV and the
  phones show "Looking it up…" over the last article; no network or
  nothing found: "Wikipedia found nothing for …" or "Wikipedia is not
  reachable", and Back still works. Everything from the network is
  checked (types, lengths), text only through the whitelist, pictures
  only from `https://upload.wikimedia.org/` or
  `https://thumb.wikimedia.org/`. Every page that shows it credits it:
  "Wikipedia · CC BY-SA" with the title. Lookups are only advice: they
  never strike or accept anything.

### 3.6 The report and the end

- **`report`** after each round: the blackboard's grade list in chalk:
  everyone's points this round added to their total, the order, who got
  the most 20s. 8 s.
- **`final`** after the last round: the report cards, one per player
  (from the last place to the first, then all on the desk), each with
  a grade per subject the player wrote in, the teacher's remarks, and a
  stamp. Then the **best answers of the day** pinned on the cork board
  (the answers with the most stars, at most 6, at least 1 star each).
  Then the final screen with the settings for another game (VIP).
- **Grades** per subject: the player's points in that subject's columns
  divided by 10 × the number of those columns (`share`, may be above 1).
  English A–F: ≥ 1.0 → A, ≥ 0.8 → B, ≥ 0.6 → C, ≥ 0.4 → D, ≥ 0.2 → E,
  else F. German (`de`): 1–6 (sehr gut, gut, befriedigend, ausreichend,
  mangelhaft, ungenügend) on the same thresholds. Austrian (`at`): 1–5
  (Sehr gut, Gut, Befriedigend, Genügend, Nicht genügend: ≥ 1.0 → 1,
  ≥ 0.75 → 2, ≥ 0.5 → 3, ≥ 0.25 → 4, else 5). A subject
  with no columns in the game is not on the card.
- **Remarks** (codes in the view, texts per language on the pages), each
  given to the one player with the most (ties: all of them; at most two
  remarks a card, the first that apply, in this order): `top` (rank 1:
  "Top of the class"; in German without a gendered noun, since the game
  does not know it: "Spitze der Klasse"), `clown` (most stars received),
  `twenty` (most 20s: "Thinks for themselves"), `copy` (most shared
  answers: "Copies from the neighbour" / "Schreibt gern ab"), `facts` (most
  answers struck by the room: "Very creative with the facts"), `empty`
  (most empty answers: "Forgot the homework"), `star` (gave the most stars
  others also starred: "Good taste"), `fine` (anyone without a remark:
  "A pleasure to have in class"). Only for more than none, and a remark
  every player would get says nothing and goes to nobody (a duel with the
  same points: no "Top of the class" for both), except `copy` (answers
  shared by everyone were copied by everyone).
- **The stamp**: everyone is promoted ("Promoted" / "Versetzt"), except
  the last place with at least 3 players, who gets "Held back?" / "Versetzung
  gefährdet" (a joke, written as one).

## 4. The columns

Each language has its own list, written for that language's players, not
translated: `data/columns.txt` (English) and `data/columns.de.txt`
(German). `scripts/check-columns.ts` (`npm run columns`) checks both.

### 4.1 The format

```
# comments start with #
== geo
City | classic:1 | A: Amsterdam, Athens; B: Berlin, Boston; C: Cairo; …
Island | | A: Aruba; B: Bali, Borneo; …
== break
Excuse for missing homework | funny any | B: The baby ate it; D: Dog ate it; …
== register
Something {player} would buy | funny any |
== lang
Starts and ends with the letter | rule:ends | A: Area, Asia; D: Dad; …
```

- `== SUBJECT` starts a section; the subjects are fixed (§4.4).
- A column line: `TEXT | TAGS | EXAMPLES`, the last two may be empty.
  - `TEXT`: what the board and the phones show, at most 40 characters,
    written as a heading ("City", "Excuse for missing homework");
    `{player}` for a player's name and `{player's}` for its possessive
    (English "Anna's", "James'"; German "Annas", "Klaus’", the rules in
    `game/rules.ts`, tested). At most one placeholder.
  - `TAGS`, space-separated:
    - `party`: only with `content: party` (everything in `detention` is
      party without the tag);
    - `funny`: counts as funny for the mix;
    - `only:de`, `only:at` (German list only): dealt only in German or
      only in Austrian rooms (a column about Germany's or Austria's own
      things);
    - `any`: works with every letter (a silly column where anything
      that starts with the letter can be made to fit); no examples needed;
    - `classic:1`, `classic:2`, `classic:3`: City, Country, River for the
      `classic` setting (in `geo`; exactly one each per language);
    - `rule:ends` (the answer also ends with the letter, ignoring
      punctuation), `rule:double` (a doubled letter somewhere: Apple,
      Kaffee), `rule:two` (at least two words, each starting with the
      letter: "Fierce Fish"), `rule:long` (at least 9 letters in
      English, 12 in German, counting letters only): checked by the host
      (§3.4); at most one rule a column.
  - `EXAMPLES`: `L: answer, answer; L: …`, real, correct answers that
    start with the letter (and obey the rule), one or more per letter the
    column works with. A column without `any` is dealt only for letters it
    has an example for. Bots answer from them.
- Every answer in the examples must be right and checkable: a reader who
  doubts one should find it in Wikipedia or a dictionary. Better fewer
  letters than a wrong example.

### 4.2 Letters and columns

A column without `any` must have examples for at least 12 of the language's
common letters, or it is dropped by the checker. With the rule tags the
examples must pass the rule. The checker also reports, per common letter,
how many columns of each subject work with it: every common letter needs
enough columns for a round of 10 in every mix and content setting.

### 4.3 The mix

For a round of N columns (6, 8, 10), after the classic three if on:

| mix | funny columns (`funny`, `break`, `trip`, `register`, `detention`) | rule columns |
|---|---|---|
| `school` | 1 | at most 1 |
| `mixed` | N / 4, rounded (2 for 8) | at most 1 |
| `silly` | N / 2 | at most 1 |

The rest are knowable columns (any other subject, no `funny`). At most two
columns of one subject a round, at most one `register` column, `party`
and `detention` only with party content. Columns are never repeated in a
game (the classic three aside); the ones the room played recently are
dealt last. If the letter leaves too few columns, the mix gives way
(more of whatever works) rather than a short round.

### 4.4 The subjects

Fixed ids, each with its name per language and an exercise-book cover
colour (the TV and the phones use it as the column's tab). The German
names are the school's own.

| id | English | German | colour |
|---|---|---|---|
| `geo` | Geography | Erdkunde | blue |
| `bio` | Biology | Biologie | green |
| `home` | Home economics | Hauswirtschaft | orange |
| `music` | Music | Musik | violet |
| `media` | Art & media | Kunst & Medien | pink |
| `sport` | PE | Sport | red |
| `social` | Social studies | Sozialkunde | brown |
| `lang` | English | Deutsch | yellow |
| `break` | Break | Pause | light blue |
| `trip` | School trip | Klassenfahrt | teal |
| `register` | Register | Klassenbuch | grey |
| `detention` | Detention | Nachsitzen | black |

What goes where (both languages; the lists in each language are their
own, these are only the kinds):

- **geo**: City, Country, River, Capital, Island, Mountain, Lake, Sight,
  Holiday destination, …
- **bio**: Animal, Plant, Body part, Bird, Sea creature, Creepy crawly,
  Dog breed, Flower, Tree, …
- **home**: Food, Drink, Fruit or vegetable, Dish, Spice, Sweets, Cheese,
  Pizza topping, Something in the fridge, …
- **music**: Band or singer, Instrument, Song, Dance, …
- **media**: Film, TV show, Fictional character, Villain, Cartoon
  character, Fairy-tale character, Video game, Book, …
- **sport**: Sport, Athlete, Football club, Sports gear, …
- **social**: Job, First name, Famous person, Brand, Car make, Shop,
  Hobby, Something in an office, …
- **lang**: Adjective, Verb, the rule columns, Word from another language,
  Abbreviation, Compliment, …
- **break** (funny): Excuse for missing homework, Bad name for a pet,
  Useless superpower, A new IKEA product, Name for a boat, Unhelpful life
  advice, A new ice-cream flavour, Title of your autobiography, Something
  you would never google, Something grandma always says, …
- **trip** (funny): Something in your suitcase, Souvenir, Something you'd
  smuggle onto the coach, …
- **register** (funny, about the room): Something {player} would buy,
  {player's} secret talent, What {player} says too often, …
- **detention** (party): Swear word, Hangover cure, Reason to break up,
  Something not to say at a funeral, …

Both lists: at least 150 columns, at least a third of them funny, each
subject at least 6 columns (register and detention at least 8 each).

## 5. Checking answers

### 5.1 The same answer

`game/match.ts`, deterministic, with known-answer tests in both languages.
Two answers in a column are the same when, in this order (the first rule
that applies is the reason the TV shows):

1. **same** after cleaning: Unicode NFKC, lowercase, accents off (é = e)
   but German umlauts and ß spelled out (ä = ae, ö = oe, ü = ue, ß = ss: Köln
   = Koeln), punctuation off, spaces and hyphens off (New York =
   new-york), a leading article off when more words follow (English the,
   a, an; German der, die, das, den, dem, des, ein, eine, einen), digits
   and number words alike (Seven Up = 7 Up);
2. **spelling**: the same without umlauts as plain vowels (Koln = Köln),
   or the same after doubled letters are made single (Mississipi);
3. **plural** (English only): one is the other plus s or es, both at
   least 4 letters;
4. **typo**: Damerau–Levenshtein distance 1 between two keys of at least
   6 letters (Amsterdan).

Grouping is transitive. Nothing about meaning (Munich ≠ München, NYC ≠
New York): the room can see it on the TV.

### 5.2 The letter

An answer starts with the letter when the first letter of its cleaned
text (after a leading article when more words follow, ignoring leading
quotes and punctuation) is the letter, with Ä Ö Ü counted as A O U and
accents off (Éclair for E). A generic geographic prefix before more words
may be skipped too, so either word counts (English mount, mt, lake,
river, cape, isle of; German Fluss, See, Berg, Insel): "Mount Fuji" is
fine for F and for M. The same goes for a leading number ("1. FC Köln",
"1899 Hoffenheim") and a club's prefix (English FC, AFC; German FC, SC,
SV, TSV, TSG, VfB, VfL): "FC Basel" is fine for F and B. A German room
also takes off a leading English "the" (The Beatles for B), as bands and
games keep it. `rule:two`: every word (at least two; spaces and hyphens
separate words, a leading article is not a word) starts with it.
`rule:ends`: the last letter, with Ä Ö Ü counted as A O U as at the
start. Digits never count as a letter. Rule columns are never funny
ones. The 40 characters of a column's text count `{player}` as written;
examples are at most 40 characters too.

With `classic` on, City, Country and River are on the board every round,
whatever the letter (as on the paper sheet), even where they have no
example for it (German Land with W): whoever finds one gets their 20.

## 6. The look: a school day

### 6.1 The idea

The TV is the classroom, the phone is your exercise book. Familiar to
anyone who went to school, German or English: the green **blackboard**
with chalk, the **alphabet frieze** above it, the round **wall clock**
with its red second hand, the **school bell**, the **exercise books** on
the desks with their subject-coloured covers, the teacher's **red pen**,
**gold star stickers**, the **report card**, the **cork board**.

### 6.2 The TV (1280×720)

- **Lobby**: the blackboard with *Classes* in chalk, the class list
  (everyone who joined, chalked in as they join), the join code big (the
  join badge steps aside: `joinVisible`), today's settings in small
  chalk.
- **Letter**: the frieze along the top of the board, the light running
  through the letters, the drawer's name ("Anna stops the alphabet");
  played letters crossed out. On the stop: the letter chalked huge on the
  board with a chalk sound.
- **Board**: the columns chalked on the board one by one, each with its
  subject's coloured tab, the `{player}` names in.
- **Write**: the letter big on the board's left, the wall clock on the
  right (red for the last 10 s and after a Stop), and along the bottom the
  **desks**: every player's exercise book (their name on its label, a
  line per column with a scribble when filled, `progress`), a raised ✋
  after a Stop. Scribbles are seeded by player and column (the same each
  time the page draws), wobbly ink lines of three lengths, never letters.
- **Bell**: the bell swings and rings, "Pens down!" in chalk.
- **Grade, vote**: an open exercise book (a double page of squared paper)
  over the board: the column's title on its coloured tab and the letter;
  a line per player, name in the margin, the answer in their
  handwriting; same answers joined by a red bracket; answers struck by
  rule crossed out with the reason in the margin; who is done ticked by
  their name; the stage's clock.
- **Grade, marked**: the red pen animates: crossings out, ticks,
  brackets, circled points, a margin note now and then ("Really?",
  "Siehe Duden", "Nice try"); gold stars fly on.
- **Wikipedia**: an encyclopedia page (a heavy book's page, serif text,
  two columns, the picture with a caption) slides over the exercise book,
  with the answer it was opened for and who opened it; "Wikipedia · CC
  BY-SA".
- **Report**: the grade list chalked on the board, points added up.
- **Final**: the report cards one by one (name, the subjects with grades,
  remarks in the teacher's hand, the stamp), then all on the desk; then
  the cork board with the best answers on index cards with their stars.

The join badge (bottom-right, column) is kept clear in every phase.
Words are read whole: column titles and answers get smaller to fit, never
cut ("Ausrede für fehlende Hausaufgaben", "Donaudampfschifffahrt").

### 6.3 Fonts (`fonts/`, shared by the TV and the phones)

The Latin subsets as Google Fonts serves them (they cover German),
unmodified; licences beside them, `fonts/README.md` lists them.

- **Handwriting**, one per player (the `hand` in the room view, 0–9, by
  join order): Patrick Hand, Kalam, Gochi Hand, Indie Flower, Architects
  Daughter, Shadows Into Light Two, Coming Soon, Gloria Hallelujah,
  Handlee, Caveat. Answers on the TV are large (handwriting is readable
  only large).
- **The teacher's red pen**: Caveat Brush (and Caveat for margin notes).
- **Chalk**: Cabin Sketch for titles; chalk text otherwise in Patrick
  Hand, white with a little transparency. No noisy chalk texture.
- **Print** (labels, buttons, the phone's interface, the encyclopedia's
  heading): Andika (a typeface made for reading and learning).
- The encyclopedia's body text: a system serif (Georgia, "Times New
  Roman", serif).

### 6.4 Built for the stream

Fine textures shimmer and smear when H.264 encodes the TV: squared paper
lines are faint, 1–2 px and on whole pixels; the blackboard is a flat
green with a soft gradient, no grain; no thin hatching. The paper is
off-white (#f7f3e8 or so), never pure white (it glows on TVs). Large
flat colour areas, high contrast text.

### 6.5 Sound (the TV only, WebAudio, made in code)

The school bell (a ringing electric bell, 2 s), chalk taps when the
letter and the columns are written, a clock tick in the last 10 s, pen
scratches for the red marks, a "pling" for a star. No sound files.

### 6.6 The phone

Your exercise book: a cover-coloured header with a label (your name, the
letter stamped in the corner), squared paper below.

- **Lobby / final**: your name, the class list, the VIP's settings
  (every host-page setting, §2), Start (VIP).
- **Letter**: the frieze; the drawer gets a big **Stop!** button.
- **Write**: a field per column on a ruled line, the column's title above
  it with its subject's tab, the letter in each field's margin as a hint;
  the clock; the ✋ Stop! button (setting `stop`) when every field is
  filled; fields lock at the bell.
- **Grade**: the column's answers, one card each with the writers' names
  (yours marked "you"), ✗ doubt, ★ star, 📖 Wikipedia, and Done; after
  `marked`: the points and who struck what.
- **Wikipedia**: the reader view (title, description, picture, the intro,
  the other results to switch to, close), scrollable.
- **Report / final**: your points, your rank; at the end your report card.

Words are read whole (`phone/fit.js` as in Krakel), at 390 and 320 px.
Text the players typed is always set with `textContent`.

## 7. Views and actions

The host is the only authority; phones and the TV only get views. Nothing
a phone gets reveals something before the TV shows it (`party.withTv`),
and no phone or TV ever gets another player's text before grading.

### 7.1 `party.room` (every phone)

```ts
{
  phase: "lobby" | "letter" | "board" | "write" | "bell" | "grade" | "report" | "final",
  lang: "en" | "de", langs: ("en" | "de")[],
  settings: { rounds, columns, time, mix, content, stop: boolean, classic: boolean, letters, late },
  minPlayers: number,
  people: { [id]: { name: string, hand: number } },   // everyone who played this game, also away ones
  round: number, rounds: number,
  used: string[],                    // letters played this game, in order
  drawer?: id, run?: { start: number, step: number, seq: string[] },   // letter
  letter?: string,                   // from the stop on
  columns?: { subject: string, text: string, rule?: "rule:ends" | "rule:double" | "rule:two" | "rule:long" }[],  // from board on ({player} filled); rule as the tag, like Answer.auto
  deadline?: number,                 // write: the bell; grade/vote: the stage's end
  stopBy?: id,                       // write, after a Stop
  col?: number, stage?: "vote" | "marked",
  answers?: Answer[],                // grade: the column's answers
  done?: id[],                       // grade/vote: who pressed Done
  marks?: Mark[],                    // grade/marked
  wiki?: Wiki | null,                // grade/vote
  scores?: { id, round: number, total: number, rank: number, twenties: number }[],  // report, final; by rank; twenties: 20s this round
  cards?: Card[], best?: Best[],     // final
}
Answer = { id: string, who: id[], texts: string[], same?: "same" | "spelling" | "plural" | "typo",
           auto?: "empty" | "letter" | "rule:ends" | "rule:double" | "rule:two" | "rule:long" }
Mark   = { id: string, doubts: number, of: number, struck: boolean, points: number, stars: number }
Wiki   = { id: string (answer it was opened for), by: id (the driver: who navigated last, Back too),
           query: string (what is being or was last asked: the answer, a link's title, a search),
           loading?: true (a step is on its way; the last article's fields stay meanwhile),
           error?: "none" | "offline" (the current step found nothing; no article fields then),
           title?: string, description?: string, image?: string, url?: string,
           blocks?: Block[], cut?: true (the text was cut), disambiguation?: true,
           trail: string[] (the history's titles (or queries of what was not found), oldest first, ≤ 20),
           back: boolean (wiki-back works), results: { title: string, snippet: string }[] (the search's,
           empty when the exact title was found or after a link), pick: number (the article's index
           in results, -1 when it is not one of them) }
Block  = { t: "p" | "h2" | "h3" | "li" | "quote", c: Inline[], d?: 1 | 2 | 3 (list depth), n?: number (ordered) }
Inline = string | { s: string, b?: true, i?: true, a?: string (an article title to follow) }
Card   = { id, rank: number, total: number, grades: { subject: string, grade: string }[],
           remarks: string[], stamp: "promoted" | "held" }
Best   = { id: string (player), text: string, column: string, subject: string, stars: number }
```

Every empty answer is its own `Answer` (`auto: "empty"`, `texts: [""]`).
`texts` holds each writer's own spelling, in `who`'s order. Answers are in
seat order (by their first writer); ids are unique in the game
(`ROUND-COL-N`), so a stale action never hits the next column. Only
answers struck alike are grouped (a typo that breaks the rule stays
apart). `same` only on groups of two or more. `done` stays in `marked`.
`deadline` is gone in `marked`. `wiki.blocks` are rendered with DOM
calls and `textContent` (an `a` becomes a link the phone follows with
`wiki-go`; never `innerHTML`).

**View size** (decided with `@tvpipe/party`'s transport in mind): a
client gets its whole view once (joining, reconnecting), then diffs: an
object is diffed key by key, and an array or a string that changed is
sent whole. So the article's `blocks` (up to 20,000 characters) travel
once per article, not with every change around them; while a step is
loading the last article's fields stay as they are (only `loading` and
`query` change); and the driver's position, which changes several times
a second, is only in the TV's view (`at`, §7.3), never in `party.room`:
phones scroll themselves and get nothing when the driver scrolls.
`trail` and `results` are small. A Back serves the article from the
host's history: the phones get the old blocks again (one message), the
network is not asked. The views of a new phase are new: fields of the last phase
are gone (`run` after the letter, `answers`/`marks` after grading).

### 7.2 `player.state` (one phone)

```ts
{
  task: "lobby" | "wait" | "draw" | "watch" | "write" | "grade" | "report" | "final",
  answers?: string[],        // write, grade: this player's own answers (the drafts)
  filled?: boolean,          // write: every column filled (the Stop button)
  canStop?: boolean,         // write: stop is on and nobody stopped yet
  doubts?: string[],         // grade/vote: answer ids this player doubted
  star?: string | null,      // grade/vote
  done?: boolean,            // grade/vote
  lookups?: number,          // grade/vote: lookups left this column
  earned?: number,           // grade/marked: this column; report: this round
  total?: number, rank?: number,
}
```

`wait`: joined during a game, playing from the next round. `watch`: in the
room but not in this round (late, or the round has no seat). `draw`: the
drawer in `letter` only; the round's other players have `write` from
`letter` on (`answers` from `board` on). `total` and `rank` whenever the
player is in the game.

### 7.3 `party.screen` (the TV)

The room view's fields (the TV draws the same phases), plus:

- `players: id[]`: the players of this round in seat order (the desks);
- `progress: { [id]: number[] }` in `write` (0–3 per column, §3.3);
- `bellAt?: number` in `bell` (the host time the bell rings on the TV), for the sound;
- the TV's own `wiki` is the room's plus `at: number`: the block at the
  top of the driver's screen (0 after every step; a redirect to a section
  starts at its heading); the TV lays out what fits from there.

### 7.4 Actions (phone → host)

| action | data | who, when | refusals (`PartyError` codes) |
|---|---|---|---|
| `settings` | `{ key: value, … }` | VIP, lobby/final | `not-vip`, `running`, `bad-settings` (unknown key or value: nothing changes) |
| `start` | `{}` | VIP, lobby/final, ≥ 2 players | `not-vip`, `running`, `too-few` |
| `stop-letter` | `{}` | the drawer, letter | `not-drawer`, `too-late` |
| `draft` | `{ i, text }` | a player in the round, write until deadline + 500 ms | `not-playing`, `too-late`, `bad-draft` |
| `stop` | `{}` | write, `stop` on, all filled, nobody stopped | `not-filled`, `stopped`, `off` |
| `doubt` | `{ id, on }` | grade/vote, not own, not auto | `own`, `auto`, `bad-answer`, `too-late` |
| `star` | `{ id \| null }` | grade/vote, not own, not empty | `own`, `bad-answer`, `too-late` |
| `done` | `{ done }` | grade/vote | `too-late` |
| `wiki` | `{ id, pick? }` | grade/vote, any player | `bad-answer`, `slow-down`, `too-many`, `too-late` |
| `wiki-go` | `{ title }` or `{ q }` | grade/vote, any player, an article open | `slow-down`, `too-many`, `bad-title`, `no-article`, `too-late` |
| `wiki-back` | `{}` | grade/vote, any player | `no-back`, `too-late` |
| `wiki-at` | `{ block }` | grade/vote, the driver | `not-driver` (ignored quietly by phones), `too-late` |
| `wiki-close` | `{}` | grade/vote, any player | |

Also: `not-player` for actions from a screen; `not-playing` for `doubt`,
`star` and `done` from a player not in the round; `too-late` for `stop`
outside `write` and for `draft` before `write`; `bad-answer` for `wiki`
on an empty answer or a `pick` that is not one of the open article's
results (`pick` needs the open entry to be the same answer's). `wiki-go`:
`title` (a link: that article, redirects followed) or `q` (the search
field: exact title, then search), each 1–200 characters after trimming,
else `bad-title`; with nothing open `no-article`. `wiki`, `wiki-go` and
`pick` count as lookups (`lookups` in `player.state`: 15 a column, one
every 2 s: `slow-down`, `too-many`); `wiki-back` and `wiki-at` do not.
`wiki-at` `{ block }` from anyone but the driver: `not-driver` (phones
send it only while `wiki.by` is them, at most 4 a second); out-of-range
blocks are clamped. All wiki actions answer `null`; the result comes in
the view. `stop-letter` answers `null` (the letter comes with the TV), a
`draft` answers `{ text }` (as cleaned). `star` is allowed on answers
struck by rule (not on empty ones); `done` and `doubt` toggle (`done:
false`, `on: false`). Switching to another result (`pick`) counts as a
lookup.

The host page has the same settings (`HostPage` with a spec, as every
game here), a "Skip column" and an "End the round" button for the host,
and the bots in test mode. "Skip column" (grading): the column does not
count (no points, not on the report cards), the next comes. "End the
round": the report at once; what was graded counts, the rest (the column
being voted on too) does not.

## 8. Shape of the code

```
games/classes/
  tvpipe.json, package.json, tsconfig*.json, README.md
  game/rules.ts      letters, the column list's parser, dealing, the letter and rule checks, scoring, grades, remarks
  game/match.ts      the same answer (§5.1)
  game/wiki.ts       Wikipedia lookups, history, cache (injectable fetch)
  game/wikitext.ts   Parsoid HTML → blocks (hand-written tokenizer, whitelist)
  game/game.ts       the game on a Party: phases, views, actions, timings (DEFAULT, FAST)
  game/bots.ts       bots for tests and test mode
  host/              the host page (HostPage, the settings spec, skip/end buttons, bots)
  screen/            the TV page (plain JS, checked with tsc's checkJs), strings, sound
  phone/             the phone page (plain JS), strings, fit.js
  fonts/             §6.3
  data/columns.txt, data/columns.de.txt
  scripts/build.ts, scripts/pack.ts, scripts/check-columns.ts
  test/*.test.ts     rules, matcher, wiki (fixtures), whole games with bots, dropOuts
  test/live/play.ts  the live check: tvpipe, headless Chrome, a phone, bots, screenshots, layout checks
```

The pages share `phone/i18n.js`-style helpers as Busted does (the TV page
may import from `../phone/`).
