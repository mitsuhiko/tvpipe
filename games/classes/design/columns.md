# Classes: notes on writing columns

For whoever writes or extends a column list. `data/columns.txt` is the
English list; `npm run columns` checks it (format, rules, letters, every
mix). The format and the dealing rules are in docs/classes-design.md §4.
Write from scratch for your language: a translated column loses the
things everyone at that table knows, and the jokes lose their puns.

## Knowable columns

The paper game's columns: City, Animal, Band or singer. The room argues
about the answers and Wikipedia settles it on the TV, so:

- **A category anyone at the table can play.** Most players should get
  something for most letters: City, Fruit, Job, Film. Narrow ones
  (Composer, Cheese, Lake) are fine now and then; they make the 20
  points (the only valid answer) possible.
- **Clear edges.** "Sea creature" or "Fictional character" is clear
  enough to vote on; "Something blue" is not (it is anything, and the
  vote turns into taste). If the edge is a joke, the column is funny.
- **One answer is a name or a word, not a sentence.** It must fit in 40
  characters and be searchable.
- **Both sides of the Atlantic.** No US states, no UK counties, no
  national TV only one country knows as the main idea. Examples may mix
  (Neighbours and Cheers, Launderette and Pharmacy); spellings of both
  count (the matcher does not know meaning, the room does).
- **Examples are evidence.** 2–4 per letter, each findable in Wikipedia
  or a dictionary under the name given. Bots answer from them, and a
  column is only dealt for letters it has examples for. A wrong example
  is worse than a missing letter: we left out letters rather than guess
  (no Lake for F, no Tree for I, no Car make for E or W).
- **Mind the letter rule.** The game strips a leading English article
  (the, a, an) when more words follow: "The Office" is an O, "A seagull
  took it" an S, and "Mount Logan" an M, so a mountain is written as
  its name (Logan, Fuji, Whitney) and a lake too (Placid, not Lake
  Placid). Digits never count: "1984" is no answer for N.

## Rule columns

`rule:ends`, `rule:double`, `rule:two`, `rule:long`: the host strikes
answers that break the rule, so the examples must pass it exactly (the
checker tests them). They are word games, hardest on rare letters, and
at most one is dealt a round. The two `rule:two` columns are of
different kinds: one creative (Adjective and animal: Fierce Fish), one
knowable (Famous double initials: Marilyn Monroe, Donald Duck).

## Funny columns

Half the evening is the house columns. Everything in break, trip,
register and detention is funny, and every knowable subject has one or
two funny columns too (Name for a new country, A cross between two
animals, A new Olympic sport, Polite way to say go away).

- **A prompt, not a question with an answer.** "Useless superpower",
  "Bad name for a boat": any letter starts something that fits (`any`),
  and the answers are the jokes. The room stars the best ones.
- **A handle that pushes towards a joke.** "Bad name for a pet" works
  better than "Pet name": the "bad" is the invitation. A setting helps:
  the classroom (Excuse for skipping PE, Thing a teacher confiscated),
  the school trip (Reason the coach stopped, Name of the cheapest hotel).
- **No knowledge needed, no single obvious answer.** "Something in your
  suitcase" has a hundred answers per letter.
- **Examples for every common letter.** Bots without examples write
  nothing, so each funny column has one example a letter, written to be
  funny itself (a bot that writes "Sock drawer" as a new ice-cream
  flavour is a better guest than one that writes "Strawberry").

## Register and detention

- **Register** columns are about a player in the room ({player},
  {player's}). Kind-ish fun only: things they would buy, their secret
  talent, their superhero name, why they are late. Never their looks,
  body, money, relationships or anything they would have to defend. The
  answer is a compliment or a harmless tease, and the named player
  should laugh first.
- **Detention** is party content (friends, adults): hangovers, dates,
  break-ups, office parties, lies. Cheeky, never sexual, never cruel
  about a person in the room (no detention column uses {player}). "Made-
  up swear word" instead of real ones: the invented ones are funnier and
  bots stay polite.

## Coverage

`npm run columns` prints, per common letter, how many columns of each
subject work with it, and fails when some letter cannot deal a full
round of 10 in some mix and content. Hard letters (Q U V X Y Z, only
with `letters: all`) got examples where real answers exist; the funny
`any` columns cover them anyway.
