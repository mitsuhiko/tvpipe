# Worldquiz (design)

Status: built (`games/worldquiz`). Decisions taken are in §10.

A geography card game for 2–10 players in `games/worldquiz`, in English
and German: a web app on `@tvpipe/party`, like `games/landgrab`. Every
country of the world is a card: its name, its capital, its flag, where
it is, and five numbers (population, area, neighbours, highest point,
GDP per person), each with its world rank.
Each round a player either **competes** with the cards (the highest
number wins, as in Top Trumps) or calls a **challenge** that the whole
room answers against the clock (a capital, a country by its flag, a
country on the map). Each win moves a player's plane one stop on a trip
around the world; whoever gets furthest in 15, 30 or 45 rounds wins.

The look is a cartoon world on real geography: real borders and real
data, drawn in thick ink with flat bright colours, a map or a planet that
the camera flies over, cards like postcards, chunky toy buttons.

## 1. Why it is fun

- **You learn the world while you play.** Every card shows everything
  about its country, on the map and on the planet, and every challenge
  ends with the answer.
- **Two kinds of rounds.** Comparing cards is luck plus a bit of
  judgement (which number is strong?); challenges are knowledge and
  speed. The captain picks which, knowing only their own card.
- **Everyone plays every challenge.** Nobody waits for another player's
  turn; the captain only decides what comes next.
- **The map pin is for everyone.** Not knowing a capital still leaves
  "somewhere in West Africa", which scores when nobody is closer.

## 2. A game

- **Players: 2–10.** **Rounds: 15, 30 or 45** (§2.4).
- **Language**: English or German, the room's: every phone speaks it
  like the TV (before joining, the browser's); no phone switches only
  itself (§3.4).
- **Difficulty**: easy, normal (default), hard (§6).
- **Countries asked**: the 80 or 150 (default) best known, or all
  (§6); separate from the difficulty. Hands are always the whole deck.
- **Kinds of challenge**: which are in the mix, all by default (§4.11).
- **Map**: flat (Mercator) or globe; each phone switches for itself
  (not a setting), the host page or the VIP sets the TV's.
- **Disputed states** (off by default): adds Kosovo, Palestine, Taiwan
  and Western Sahara to the deck (§3.1).
- **Latecomers**: from the next round (default) or closed during a game
  (§2.4).
- **The deck** is every country (§3.1), shuffled. Drawn cards go to the
  discard pile; the deck is reshuffled from it only when it runs out, so
  every country comes up before any comes back. Cards in hand and
  challenge countries come from the same deck.

Every setting is on the host page and on the VIP's phone (the lobby and
the final screen) with the same choices: the game's `settings` action
(`lang`, `mode`, `rounds`, `difficulty`, `countries`, `kinds`,
`disputed`, `map`, `lateJoin`) takes only the VIP's, refuses a change
with an unknown key or value as a whole, and, like the host page, any
change while a game runs (no setting is live). Both sides go through
`configure`: the phones see the room view's settings, and the host page
redraws on the game's `settings` event.

### 2.1 A round

```
draw ─▶ captain chooses ─▶ compete:   reveal ─▶ steps ─▶ Next
         no limit          challenge: hands shown ─▶ Next ─▶ question ─▶ answers ─▶ reveal ─▶ steps ─▶ Next
                                                              60 s (normal)
```

**Next.** What shows cards or an answer (a compete, the hands before a
challenge, a challenge's answer) stays until every player has pressed
Next on the phone, not for a fixed time: the point of the game is
learning where countries are and how big, and people read at their own
pace. Next counts once the TV's animation has played; the TV shows who
is still reading (their dots, top right), the phone whom it waits for.
Once someone has pressed Next, the others get a 15 s countdown (the TV's
clock and the phones), then the game goes on by itself; nobody pressing,
the countdown starts 75 s after the stage opened. A phone that drops out
is not waited for.

1. **Draw.** Everyone draws a card at the same time, the captain and
   everyone else, and everyone sees their own card at once. The phone
   shows it whole: the flag, the name and capital(s) in the game's
   language, the five numbers with their ranks (§3.5), and the country
   on a small map/globe.
   Players only ever see their own card: the TV shows the backs of
   everyone's cards and who is captain.
2. **The captain** (in turn, one player a round) chooses on the phone:
   - **Compete** with one of the five numbers, or
   - **Challenge**.
   There is no time limit: the room waits (talking it over is part of
   the game). A captain who leaves the game makes it a challenge.
3. **Compete.** Only now does every card turn over, the captain's too:
   the TV shows them all, sorted by the number, and flies the map from
   country to country. The highest number wins one step; equal highest
   all step.
4. **Challenge.** First the hands go to the discard pile, shown on the
   TV on their way (§2.2). Then a random new country comes from the
   deck with a random kind of challenge (§4).
   Everyone answers; right answers step one. If nobody is right the TV
   shows the answer and another random country with another random kind
   comes; after three without a winner the round ends with no steps.
5. Every card of the round goes to the discard pile.

### 2.2 Knowing what is gone

Which strong cards have left the deck matters: with the United States
gone, a high population is worth less. So every card that goes to the
discard pile is seen, in compete rounds and before a challenge alike:

- **The reveal before a challenge** shows each hand face up over its
  holder with all five numbers, and calls out the strong ones: a card
  with any number in the top 10 gets a gold badge per such number
  ("#3 population", "#1 area"), with a sound. Nothing is compared and
  nobody steps. It stays until Next (§2.1).
- **A compete** shows every card whole too, the compared number
  outlined, not only that number.
- **The pile on the TV** shows, while the captain chooses, five rows
  (one per number) of the strong cards that are gone: their flags with
  their rank ("#1" population: China), and how many cards the deck
  still has. It resets when the deck is reshuffled.
- **On the phone** the same table is a tab next to one's card, so the
  captain can check it before choosing.
- **Ranks stay secret until a card is shown.** A hand comes without its
  ranks: one's card says 83.5 million, not that it is #19; how strong
  that is, is for the player to judge. Ranks (and the gold badges) are
  on cards that were compared or discarded, and in the pile's table,
  which only lists cards that are gone.

### 2.3 The board

Each player is a little plane on a dotted route around the world, one
stop per step, so the leader is visibly ahead. The route is decoration;
the stops are not countries (nothing to learn wrong).

### 2.4 Rounds and the end

15/30/45 rounds; the game rounds up to a multiple of the players so that
everyone is captain equally often (6 players, 15 rounds: 18). The
furthest plane wins; a tie is broken by one location challenge among the
tied players (closest wins, a further one on another tie).

Late joiners (unless the latecomers setting is closed) start at the
last place's stop from the next round; a player who leaves keeps their
plane until the end; fewer than two players ends the game.

### 2.5 Questions only

A setting (`mode`: `cards`, the default, or `quiz`): no cards, no
captain, no compete. Every round is a challenge for everyone (another
one when nobody was right, up to three, as after a called challenge),
then the answer until Next. The rounds are the setting, not rounded up
(nobody needs to be captain as often).

### 2.6 Head start

A handicap in steps: the VIP gives any player a head start of 0 to 10
steps on the phone (the settings box, a − and + per player); the plane
starts that many stops ahead and everything else is as usual. It is
per player, not a setting: the game's `head` action (`{ id, steps }`,
the VIP's only, before and between games) and `setHead` on the host
side; the room's and the TV's `heads` carry those above 0, and the
lobby shows them as "+2" beside the name on the TV and the phones. It
stays while the party lasts (also for a player who drops out and comes
back), so a second game starts with the same; a latecomer joins at the
last place's steps or the head start, whichever is more.

## 3. The data

All data is fetched by a script once, curated by hand where the sources
disagree, and **checked in** (`data/countries.txt`, `data/world.txt`,
`data/flags/`). The game never fetches anything at play time.
`node scripts/data.ts` refetches and rewrites; `--check` fails when the
checked-in files differ from what it would write (as landgrab's
`world.ts`). Sources and licences go to `CREDITS.md`.

| What | Source | Licence | Notes |
|---|---|---|---|
| names, capitals (en, de), aliases | Wikidata | CC0 | labels are often formal ("People's Republic of China"): short names are curated |
| flags | Wikimedia Commons SVG (Wikidata P41) | 193 public domain, Oman OGL-om (attribution) | 2.7 MB as SVG; 169 are under 20 KB, the big ones (coats of arms: Ecuador, El Salvador, Oman, Spain …) rasterised; a `viewBox` added where a file has none (some browsers draw such an SVG unscaled and cut: a TV showed only Austria's top stripe, all red) |
| shapes | Natural Earth admin 0, 1:50m | public domain | every UN member is in it; already split at the antimeridian |
| neighbours | computed from Natural Earth 1:10m, checked against Wikipedia's *List of countries and territories by number of land borders* | facts | §3.2 |
| highest point | Wikipedia's *List of elevation extremes by country*, checked against Wikidata P610/P2044 | facts | §3.3 |
| population | World Bank SP.POP.TOTL, latest year; Taiwan from its statistics office if in the deck | CC BY 4.0 | summed over the country's parts (§3.5) |
| area | World Bank AG.SRF.TOTL.K2 (total: land and inland water), checked against Wikipedia | CC BY 4.0 | km²; summed over the parts (§3.5) |
| GDP per person | World Bank NY.GDP.PCAP.CD, latest year with a value; IMF WEO where missing (Taiwan if in the deck); North Korea a UN estimate | CC BY 4.0 | current US$, nominal; the card shows the year |

**Why not OpenStreetMap.** OSM's boundaries are huge (country
relations in full detail), need simplifying that keeps shared borders
shared, and come under the ODbL (share-alike, attribution for derived
databases). Natural Earth is made for small-scale maps, is in the public
domain, and has its shared borders built in (neighbouring polygons
share their vertices, which is also how §3.2 finds land borders). OSM
map tiles are out too: they need the internet at play time and look like
a road map, not a cartoon.

**Wikidata alone is not enough** (checked on the 194 UN members):
GDP per person (P2132) is missing for most and mixes nominal and PPP
(Hungary: 37,128 = PPP; nominal is about 26,000); capitals are missing
(Nigeria, Norway in the query with German labels) or several (Bolivia,
South Africa, Sri Lanka, Eswatini, Yemen's two); the United States and
Argentina have no highest point, ten countries two elevations for it;
"shares border with" (P47) includes sea borders.

### 3.1 The deck

The 193 UN member states, plus the Vatican (an observer, and Italy's
neighbour; "the smallest country" is classic trivia).

The **disputed states** option adds Kosovo, Palestine, Taiwan and
Western Sahara (the Sahrawi Republic's claim, drawn as Natural Earth's
Western Sahara). Off, they are simply not in the game: their land is
nobody's (drawn plain, no country's), and they are nobody's neighbour;
no country is given their land. So a country's neighbours in
`data/countries.json` include them, and the game counts only those in
its deck: Serbia 7 off, 8 with Kosovo; Israel 4 (Egypt, Jordan,
Lebanon, Syria), 5 with Palestine; Morocco 2 (Algeria, Spain), 3 with
Western Sahara. The numbers on the cards (population, area) are the
World Bank's either way (Serbia's without Kosovo). Tests pin both.

### 3.2 Neighbours (the careful part)

The rule: **countries in the deck whose land touches the country's land,
where the country is everything constitutionally part of it** (overseas
departments and collectivities, constituent countries of a kingdom,
exclaves) **but not its dependencies** (British Overseas Territories,
Crown Dependencies, Australia's external territories). This is the
reading Wikipedia's elevation list uses for highest points too, so both
numbers describe the same land.

What it gives where people disagree (each with the reason on the card's
back, §7):

| Country | Count | Because |
|---|---|---|
| France | 11 | the 8 in Europe, Brazil and Suriname (French Guiana), the Netherlands (Saint Martin) |
| Brazil | 10 | 9 in South America and France (French Guiana) |
| Netherlands | 3 | Belgium, Germany, France (Sint Maarten) |
| Denmark | 2 | Germany, Canada (Greenland, Hans Island since 2022) |
| Canada | 2 | the United States, Denmark |
| Spain | 4 | Portugal, France, Andorra, Morocco (Ceuta, Melilla); Gibraltar is a dependency |
| United Kingdom | 1 | Ireland; Gibraltar and Akrotiri & Dhekelia are dependencies |
| Cyprus | 0 | the UK bases are a dependency |
| Russia | 14 | Poland and Lithuania via Kaliningrad, North Korea included |
| China | 14 | Hong Kong and Macau are China |
| Italy | 6 | San Marino and the Vatican count |

The generator compares its adjacency (Natural Earth 1:10m, every
admin-0 unit mapped to its sovereign, dependencies dropped) with
Wikipedia's list; every difference must be settled in
`data/decisions.txt` with a line of reasoning, or the check fails.
Natural Earth draws some disputed areas as their own units (Kashmir,
Bir Tawil, Somaliland, Northern Cyprus, the Brazilian Island); each needs
a decision there. Known-answer tests pin the table above.

### 3.3 Highest point

Wikipedia's list, same rule: Mount Scenery (887 m, Saba) for the
Netherlands, Gunnbjørn Fjeld (3,694 m, Greenland) for Denmark, Ben Nevis
for the UK, Kosciuszko for Australia. Shared summits count for both
(Everest: Nepal and China; Mont Blanc: France and Italy, 4,806 m, as
Wikipedia's list gives them). Metres, rounded.

### 3.5 Population, area and ranks

The same rule decides what is summed. The World Bank counts territories
separately, so a country is the sum of its parts: Denmark is Denmark,
Greenland and the Faroe Islands (2.2 million km², not 43,000); the
Netherlands adds Aruba, Curaçao and Sint Maarten; France adds Saint
Martin, Saint Barthélemy, Saint Pierre and Miquelon, Wallis and Futuna,
French Polynesia and New Caledonia; China adds Hong Kong and Macau. The
United States does not add Puerto Rico or Guam (dependencies), the UK
not Gibraltar. GDP per person for such a country is the parts' GDP over
their population. The parts are listed in `data/decisions.txt`.

A trap found while checking: the World Bank gives Greenland's area as
410,449 km² (ice-free land only); the total, 2,166,086 km², comes from
Wikipedia. Every area is checked against Wikipedia's list and a
difference over 2 % needs a decision.

Each number has its **rank** among the cards in the deck (#1 highest;
ties share a rank), recomputed when the disputed-states option changes
the deck. A shown card says "#16" next to "$60,496"; a hand does not
(§2.2). Population is shown rounded
(83.5 million / 83,5 Mio.), area to the km².

### 3.4 Names and answers

Each country has, per language, a display name, a capital (or several:
§4.1), and accepted aliases from Wikidata plus our own ("USA",
"Amerika", "Holland", "Kiew/Kyiv/Kiev", "Elfenbeinküste/Côte d'Ivoire/
Ivory Coast", "Tschechien/Tschechische Republik/Czechia/Czech
Republic"). The game's language is the room's, set by the host page or
the VIP. **Cards show only the game's language**: a German game
says Deutschland, Berlin, Zugspitze and nothing in English, and the
reverse. Answers in either language are still accepted (knowing "Italy"
in a German game is knowing it).

## 4. Challenges

Time: 90 s easy, 60 s normal, 30 s hard. What a phone has typed or
pinned counts at the deadline without being sent; Done locks it in
early, and the challenge ends when everyone has (the phone says so once
there is an answer, so nobody thinks they must press).

### 4.1 Capital

The TV and the phones show the country's name, flag and place on the
map; type the capital. Where it is not clear-cut, the card lists them
all and each is right: the constitutional capital and the seat of
government, or a capital in dispute. Bolivia: Sucre, La Paz; South
Africa: Pretoria, Cape Town, Bloemfontein; the Netherlands: Amsterdam,
The Hague; Switzerland (no capital in law): Bern, the federal city;
Côte d'Ivoire: Yamoussoukro, Abidjan; Benin: Porto-Novo, Cotonou;
Tanzania: Dodoma, Dar es Salaam; Malaysia: Kuala Lumpur, Putrajaya; Sri
Lanka: Sri Jayawardenepura Kotte, Colombo; Eswatini: Mbabane, Lobamba;
Israel: Jerusalem, Tel Aviv. The list is curated in
`data/decisions.txt`, each with its reason; the first name is the one
the card shows big.

### 4.2 Flag

Only the flag; type the country.

### 4.3 Where?

The country's name only; tap it on the phone's map (flat or globe,
pinch to zoom, the pin can be moved until locked in). Scored by the
great-circle distance from the pin to the nearest point of the country,
so flat and globe are equally fair; **inside the country is 0**
(a hit), and so is anything within 25 km (fingers are bigger than
Liechtenstein). A pin further than 1,500 km (easy 3,000, hard 800)
never wins: "nobody knows" exists here too. Borders are drawn on easy
and normal, only coastlines on hard; names never.

**Closest wins, with tolerance.** A tap is not precise to the
kilometre, so near-equal pins tie: everyone within **25 km or 10 %**
(whichever is more) of the best distance wins a step. Best 0 (a hit):
everyone within 25 km. Best 300 km: up to 330 km. Best 1,200 km: up to
1,320 km. The margin is relative to the best, not to each other, so it
cannot chain (300, 330, 363 do not all tie). The TV shows the
distances rounded the same way the tie is judged ("≈ 310 km", with the
winners' band as a ring around the country), so a tie looks like one.
The 10 % is a starting point to check in play tests.

**The reveal shows where it is first.** The camera flies to the country
alone (in the hot colour, staying in place: no lifting or bobbing, so
its shape and size read true; a little flag with its name planted on
it), then
pulls back until every pin is in view, and a line grows from each pin
to the point of the country it was measured to, with the distance on
it. The whole card is beside the map, everyone's distance in a list on
the other side. The phone shows one's own pin and its line the same way.

### 4.4 Spell fixing

Matching (`game/answer.ts`, pure, with known-answer tests):

1. Normalise: lower case, accents off (ä→a and ä→ae both tried, ß→ss),
   punctuation and "the/die/der/republic of/republik" dropped,
   "st."→"saint/sankt".
2. Compare with every name and alias of **every** country (or capital),
   by Damerau–Levenshtein distance: 0 for up to 3 letters, 1 up to 6,
   2 above ("Cina" is China, "Irn" Iran). A name without its filler
   words that is another country's own name keeps its fillers:
   "Republic of China" (Taiwan) is not "China".
3. Right only when the closest name is the wanted one and no other
   country's name is as close. An exact name of another country is
   wrong, however close.

Pairs the tests pin: Niger/Nigeria, Iran/Iraq, Austria/Australia,
Slovenia/Slovakia, Gambia/Zambia, Guinea/Guyana/Guinea-Bissau,
Mali/Malta, Dominica/Dominican Republic, Sudan/South Sudan,
Congo (ambiguous: wrong for both unless §10 says otherwise),
Korea (ambiguous). The reveal shows how an answer was read ("Nigera →
Nigeria ✓"), and what a wrong one named, so it teaches something: the
flag of the country it was read as ("Chile" beside Chile's flag, Chad's
look-alike beside Romania's), and for a capital also whose it is
("Mali → Malé (Maldives)"). Only when the answer was read as one
country.

### 4.5 Pick the flag

The country's name; pick its flag among 6 (9 on hard), a 3×2 (3×3)
grid of flags on the TV (lettered A–F/I) and big tappable flags on the
phone. A tap picks (it can change until the deadline; what is picked
counts, Done ends early). Everyone who picked right steps. The wrong
flags: easy, random countries far away (over 3,000 km); normal, the
nearest countries by centre; hard, the flags of most similar colours
(the colours read from the flag files' fills by area, hand-rolled, with
known-answer tests), never two identical-looking ones the data says are
the same (Chad/Romania are both shown: that is the fun). The phone gets
only the flag files, shuffled. The reveal: the right flag ticked, each
player's dot on the flag they picked, then the card and map as usual.

### 4.6 Name the shape

The country alone on the sea, in the hot colour: no other land, no
names, no graticule (its neighbours or the lines of latitude would give
it away); type the country. The reveal shows it on the map as usual. The question sends the
country's outline (its rings) and the view, not its id; the TV and the
phone draw the outline over the map. Judged as the flag challenge
(§4.4). Countries smaller than about 20 km across are never asked.

**Name the country** (`spot`) is its easier form: the same outline in
the hot colour, pulsing (a light wash coming and going, its shape and
size stay true; a small one's ring breathes), but in its place on the map among the land around it
(borders as the difficulty says, no names, a ring around a small one);
any country with land can be asked. The question is the same as the
shape's (outline and view, no id).

### 4.7 Which is bigger?

Four countries (name and flag) and one of the numbers (population,
area, highest point, GDP per person); pick the one with the most. The
four are distinct in it, the largest at least 10 % above the second.
Easy: the four spread widely (each at least twice the next); normal:
random; hard: close (the largest within 50 % of the smallest). The
reveal shows all four numbers in order. Everyone who picked the largest
steps.

### 4.8 Guess the number

A country (name and flag) and one number (population, area, highest
point); everyone sets a guess on a logarithmic slider (population 1k–2
billion, area 1–20 million km², height 10–9,000 m) with the value
shown as it would be on a card. Four other countries on the slider
for scale, a line under the track each with flag, name and number:
the smallest and the largest of the deck on the slider, and between
them one of the three best known near a third and two thirds of the
way (log); never the country asked nor one with its very number. The closest by ratio wins (|log
guess/answer|), with everyone within 10 % of the best ratio; a guess
off by more than the level's factor never wins (easy ×3, normal ×2,
hard ×1.5). The reveal: a number line (log) with every guess as a dot
in the player's colour and the answer (for the highest point with the
mountain's name under it: "5,137 m, Mount Ararat"), then the card.

### 4.9 Name a neighbour

A country with land neighbours (§3.2; with the disputed states as set);
type any one of them. Every right neighbour counts (judged as §4.4,
against every country; the answer must be one of the neighbours). The
reveal: the country and all its neighbours highlighted on the map, the
neighbours listed with the dots of those who named each (one's own
outlined on the phone), each player's answer read back.

### 4.10 Odd one out

A country X with at least three neighbours, and four countries (name
and flag): three border X, one does not; pick the one that does not.
The odd one is always from the same part of the world (one from far
away would give itself away): easy, 800 to 2,500 km away (clearly not
touching); normal, within 1,500 km; hard, the nearest country that is
not a neighbour. The reveal: X and
the four on the map, the odd one marked.

### 4.11 Which kinds

A setting (`kinds`, the host page and the VIP's phone): which kinds are in
the mix, all by default, at least one. A challenge picks a kind at
random among those some country of the pool can be asked in (odd one
out needs three neighbours, name a neighbour one, a shape 20 km, name
the country some land), then
a country that fits; when none of the kinds can be made, a pin. The
tie-break is always the pin (§2.4).

## 5. Who sees what

The host page is the only authority (as in every game here). A phone
gets its own card; the TV gets the backs until a reveal. Challenge
answers reach only the host until the reveal; the TV shows who has
locked in. The flag challenge sends the phones only the flag (the
country's code is not in the message: flags are addressed by an index
shuffled per game, so the file name gives nothing away).

## 6. Difficulty

| | easy | normal | hard |
|---|---|---|---|
| answer time | 90 s | 60 s | 30 s |
| location: max distance | 3,000 km | 1,500 km | 800 km |
| location: borders shown | yes | yes | coastlines only |
| pick the flag: flags | 6, the others far away | 6, the nearest | 9, the most alike colours |
| which is bigger: the four | each twice the next | any | within ×1.5 |
| guess the number: never wins beyond | ×3 | ×2 | ×1.5 |
| odd one out: the odd one | 800–2,500 km away | within 1,500 km | the nearest non-neighbour |

**Countries asked** is its own setting (`countries`): the 80 best
known, the 150 best known (default), or all, whatever the difficulty.
The options shown with a question (wrong flags, the four, the odd one)
come from the same countries. "Best known" is ranked by Wikipedia page
views (both languages, the median month of a year, so that one big
event does not count), fetched with the rest and checked in. Hands in
compete rounds always come from the whole deck: learning a little
country is the point.

## 7. Looks

`screen/map.js` draws the map for the TV and the phones.

- **The map is the stage.** Canvas 2D, our own projections: Mercator
  (84°N to 60°S, Antarctica left out: it is not a country) and an
  orthographic globe with clipping at the horizon (visible stretches of a
  border joined along the rim in the ring's own direction). No WebGL,
  no map library, no tiles. The flat map repeats left and right, so the
  Pacific is never cut; countries are coloured so that neighbours differ
  (countries whose points lie within a few km touch).
- **Cartoon on real shapes**: countries in five pastel colours (a
  greedy colouring so neighbours differ), a thick ink coast drawn under
  the fills so only its outer half shows, thin ink borders, a dark sea
  shadow under the land, dashed graticule and little waves in a bright
  sea. The drawn country pops up: hot orange, lifted with a shadow,
  bobbing, a cartoon pin; countries too small to see get a pulsing ring.
  The globe sits in a starry sky with an atmosphere glow and soft
  shading.
- **The camera flies** between countries (zooming out mid-flight); the
  globe turns and zooms.
- **Cards** are postcards: cream, rounded, a lip under them, the flag as
  a tilted sticker, the name and capital in the game's language only,
  the five numbers as rows with icons and their rank (a gold badge in
  the top 10). The back of a card (TV, on reveal) lists the neighbours
  by name with small flags. Whenever the TV shows a card it shows it
  whole: the compared number is outlined, the others stay; small cards
  are sized to fit how many there are.
- **Buttons** are chunky toys: a bright fill, a darker lip under it
  (6 px), a soft shadow, uppercase heavy type with wide letter spacing,
  a white icon; pressed, they sink into the lip. Palette: blue, green,
  red, orange, yellow, teal, pink, purple, slate, amber, white (blue
  text). Players' colours come from the same palette. Square icon
  buttons for the map toggle and zoom.
- **Type**: Grandstander (bold and childlike, SIL OFL, bundled) for
  everything: the logo, headings, numbers and buttons, and the little
  notes lighter and smaller (a thin hand font read badly on phones and
  TVs).
- **Phone**: one's card fills the screen (the map on top, the card
  below); in a challenge the question on top and a big field or the map;
  the captain's choice as big buttons.
- **Sound**: synthesized (a stamp, a plane's whoosh, a ding, a buzzer).

Size: shapes at most 400 KB (delta-coded integers), flags the Commons
SVGs as they are (about 2.7 MB, loaded one at a time), fonts ~90 KB.

## 8. Code

As the other games: `game/` (deck, rules, answer matching, distance,
pure and tested), `host/`, `screen/` (TV), `phone/`, `scripts/data.ts`
(the fetch and checks), `scripts/build.ts`, `test/` (rules, data
invariants: every country has every field, the neighbour relation is
symmetric, the table in §3.2, answer pairs in §4.4, distance against
known pairs of cities), `test/live/play.ts` (a game in headless Chrome
with screenshots). `game/flagcolours.ts` draws a flag's SVG on a grid
(our own small rasteriser: shapes, paths with curves and arcs,
transforms, `use`, strokes, clip paths, gradients as the mean of their
stops) for its colours' shares; `scripts/colours.ts` writes them to
`data/colours.json`, compared by ΔE (CIE Lab) weighted by share.

## 9. Not now

Capital → country, continents as a filter, team play.

## 10. Decisions

Taken with the owner:

1. Disputed states are a rule option, off by default (§3.1).
2. Dependencies do not count (§3.2).
3. Location: closest wins, near-equal pins tie (§4.3).
4. Everyone draws at the same time and only ever sees their own card
   (§2.1). Compete turns every card over, the captain's included. A
   challenge discards the hands, shown face up on the TV first so
   everyone knows which countries (and which strong cards) are gone
   (§2.2), and draws a random new country with a random kind of
   challenge; the captain does not pick the kind.
5. Where a capital is not clear-cut, all are on the card and all are
   right (§4.1).
6. Rounds go up to a multiple of the players (§2.4).
7. Five facts: population and area join neighbours, highest point and
   GDP per person (§3.5).
8. Cards show only the game's language (§3.4).
9. Ranks are secret until a card is shown (§2.2).
10. Off, the disputed states' land is nobody's (§3.1).
