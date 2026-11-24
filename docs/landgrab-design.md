# Landgrab (design)

A world conquest game for 2–6 players in `games/landgrab`: a web app on
`@tvpipe/party`, like `games/shifty`. The idea is the old board game of
armies on a world map (Risk and its many clones); the rules here, the
name, the map and the look are our own, and they are changed for a TV
and phones: **everyone plans at the same time**, in secret, on their
phone, and then the TV plays all the orders out as a show.

## 1. Why it is fun

- **Nobody waits.** Classic turns leave five people watching one think.
  Here everybody plans at once (45–120 s), and the battle that follows is
  everyone's: their orders, the others', interleaved.
- **The TV is the war room.** The whole world is on the TV, a map of
  raised hex tiles in the players' colours; every fight flies the camera
  to the border, draws the attack's arrow, throws the dice, and floods
  the conquered territory with the winner's colour.
- **Secret plans, surprising collisions.** Two armies marching at each
  other meet halfway in a head-on clash. An attack whose territory was
  taken a moment before is called off. Reading the others is part of it.
- **Nobody is out for long.** A player wiped out rises again next round
  as a rebel on the leader's weakest territory: everyone stays in, and the
  leader has a problem.
- **A game is short.** 6–12 rounds (8 by default, about half an hour),
  or until someone holds three quarters of the world; 24 rounds for a long
  evening.

## 2. A round

```
plan (everyone at once, secret) ──▶ battle (the TV plays it out) ──▶ next round
   45–120 s, ends early when all are ready      up to ~100 s
```

- **Reinforcements.** A third of one's territories (at least 3), plus the
  bonus of every continent held whole (North America 5, South America 2,
  Europe 5, Africa 3, Asia 7, Oceania 2). A round in which a player takes
  at least one territory earns a **star** (at most 5); three stars cash in
  for 5 more armies.
- **The plan.** On the phone: place the reinforcements on one's own
  territories, then give **orders**: from one's territory to a
  neighbouring one, with a number of armies. To one's own territory it is
  a march, to anyone else's (or the wild lands') an attack. One army
  always stays behind. Placed armies may march on in the same round, and
  so may armies moved in by an earlier order of one's own (the battle
  keeps each player's order). The
  phone sends the whole plan after every change; **Ready** marks it done
  (changing it un-readies). Planning ends at the deadline or when everyone
  who is there is ready. Reinforcements nobody placed (an away phone, or
  armies left over) go to the border territories under the most pressure.
- **The battle.** First every reinforcement lands at once. Then the
  orders go one at a time, a round robin over the players (one order of
  each, in each player's own order); the first player in the round robin
  moves one on each round. An order moves or attacks with what it asked
  for, or with what is there less the one that stays; an order whose
  territory was taken meanwhile is cancelled (only its player's phone
  hears about it).
- **A fight** is fought to the end: the attacker throws up to three dice,
  the defender up to two, highest against highest, second against second,
  a tie to the defender, until one side has nobody left. A conquering
  army moves in with all who are left.
- **A head-on clash.** When A orders X→Y and B orders Y→X, and B's order
  has not gone yet, both march at once and meet halfway: both throw up to
  three dice, a tie costs both one. The side left standing marches on into
  the other's territory (a normal fight against whoever stayed home).
- **Uprisings.** At a round's start, a player with no territory (wiped out
  last round, or a latecomer dealt in) takes the leader's weakest territory
  (never their last) with 3 armies; without a leader, the weakest wild
  land.

## 3. The world

`data/world.txt` (format in `game/world.ts`): a grid of pointy-topped
hexes, about 16:9 so the map fills the TV edge to edge, made by
`scripts/world.ts` from coarse coastlines in longitude and latitude
(projected like Miller's cylindrical projection, Chukotka with Asia).
Forty territories in six continents; neighbours are territories whose
hexes touch, plus sea routes (`link`, dashed on the map; Alaska and
Kamchatka across the map's edge). The oceans the HUD uses stay free:
the North-East Pacific (the players), the South Pacific (tvpipe's join
badge), the South Atlantic and Indian Ocean (the fight card).

## 4. The deal and the end

- Each player gets the same number of random territories (55 % of the
  world shared out, 4–10 each), 2 armies each, never a whole continent;
  the rest are **wild lands** with 1–3 armies that never attack.
- The game ends after the last round, when someone holds 75 % of the
  territories, or when fewer than two players are left at a round's
  start. The table: territories, then armies. Awards: the most
  territories taken, the most enemy armies beaten, the biggest fight won,
  the most uprisings.

## 5. Views and timing

The host is the only authority (`game/game.ts` has the views in its
header comment). Plans reach only the host; the TV and the other phones
learn who is ready. The battle is computed at once (`resolve` in
`game/rules.ts`, a pure function of the board, the plans and the dice);
each event carries the territories it touches before (`was`) and after
(`set`). The host then sends one event at a time (`party.withTv`) and
waits its length on the TV: `game/timeline.ts` splits each event into
marks (the intro, each throw, the outro, a fanfare) that the host and the
TV page both compute, the first two throws of a fight slow and the rest
fast-forwarded, and the whole battle scaled down when it would run past
about 100 s. The phones' feed (what happened to their armies) and
their small map update with the TV, never before it.

## 6. The TV

The world is two SVG layers (`screen/map.js`): a static board drawn once
(raised hex tiles with a lit top edge and a dark side, wild parchment
lower than held land, grooves between territories and deeper ones
between continents, old-map water lines along the coasts, the
continents' names and bonuses in the seas, every territory's name by
its token) and a light layer of what moves (army tokens, arrows, floods,
sparks); splitting them keeps the capture at 30 fps. The phones talk
about territories by name, so the TV, where everyone looks, names them
all: light capitals with a dark rim, placed by `game/names.ts` (next to
the token, on the territory's own land as far as it goes, clear of the
tokens, of each other, of the continents' labels and, where it can, of
the HUD; one line or two, a smaller size where it is crowded). In a
battle they zoom with the camera and dim with the rest. The HUD stays in the seas: the standings in the
North-East Pacific, the round and clock top right, the fight card at the
bottom, tvpipe's join badge bottom left. As on the phone (§7), colour
means a holder: the HUD is parchment on ink, arrows and the fight
card's sides are in their players' colours.

- **Plan:** a banner opens the round; every player has a "thinking"
  marker that turns into a tick (their territories flash) when they are
  ready; contested borders pulse; uprisings fly the camera to the rebel.
- **Battle:** the camera flies to the border and the rest dims; an arrow
  grows and a token with the army count marches along it; the dice
  tumble on the fight card and land in pairs, each throw with sparks and
  the counts falling (the map shakes only when a throw costs two armies
  and when a clash starts; otherwise it holds still: no drift in the
  lobby, no camera move when it is already there); a conquest stamps "Conquered!" and the
  colour floods the territory from the front, a failed attack breaks off.
  Clashes meet in the middle. Continents and wipe-outs get a headline and
  a fanfare. The standings change when an event ends, never before.
- **Final:** the winner's territories glow, a podium, the awards.
- **Sound** (`screen/sound.js`): synthesized drums, marching, dice,
  hits, a clash, brass and a gong, through one compressor.

## 7. The phone

**Settings** (the host page, or the VIP's phone in the lobby and at the
end; none during a game): the language (the room's: every phone and the
TV speak it; before joining, a phone speaks the browser's), rounds (6,
8, 10, 12 or 24), time to plan (45, 60, 90 or 120 s) and latecomers
(they join at the next round as rebels, or not until the game is over).

Colour on the phone means a holder and nothing else: the six players'
colours and the wild lands' parchment. The interface is parchment on ink
(no brass, no red or green for actions); what an action is shows in its
shape and icon. One's own orders are white on the map (an attack solid,
a move dashed), placements white "+N" pills; a threat is a ⚠; the
odds bar is parchment with words. Numbers read before →
after ("3 → 5").

The plan is **the map**: it fills the screen between the header and the
dock, a bar under it says what the last tap did and what comes next,
and there are no lists. The whole world shows first; a tap on it flies
close to that territory and its neighbours (their names on the land),
a "World" button flies back out. The header has the round, the clock
and the two steps, each with what it still wants:

1. **Place** (the armies left, ✓ once none are): a tap on one's own
   territory selects it; the bar has − and + (and "+ all"), a tap on
   it again places one more, and a warning when a player next door
   would probably take it. Stars cash in from the bar. Armies left at
   the end the host places.
2. **Move & attack**: a tap where armies set out from (its neighbours
   stand out, the rest dims), a tap on a neighbour: the bar turns into
   the amount (the route "Persia 5 ⚔ Steppe 1", the odds from
   `game/odds.ts`, a slider, quick amounts: half, safe: the fewest with
   80 %, all), the map draws the order as it would be; confirming adds
   it and clears the selection for the next one. A foe tapped first
   asks for one's territory next to it. A territory's orders show in
   the bar as chips (a tap changes one, ✕ takes it back). Orders chain
   (§2): armies moved in by an earlier order may march on.

During the battle the phone shows what is on the TV (the sides, the
dice in each side's colour, the result, timed to the TV with
`room.step.ms`; the close-up with the fight's two territories named and
the arrow in the mover's colour, as on the TV), its own feed, and the
standings, and buzzes with its own results as the TV shows them.

## 8. Checking it

`npm test` (rules with a tiny world, the real world's shape and its
generator, the odds, where the names go, whole games with bots,
drop-outs, latecomers, too few players), and in `test/live/`: `play.ts` plays a game in headless
Chrome through tvpipe with screenshots of the TV and of the phone at six
sizes and layout checks (`--shots DIR` for the games list); `record.ts`
records a game's TV views from bots in memory and `stage.ts` replays
them on the real TV page without tvpipe (screenshots, frame rate,
sound). `scripts/sandbox.sh DIR` builds a private copy to check while
the folder is being edited.
