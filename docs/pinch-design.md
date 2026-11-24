# Pinch (design)

A real-time heist game for 3–8 players in `games/pinch`: a web app on
`@tvpipe/party`, like `games/snug`. One player is the **thief**, everyone
else is **house security**. The thief sneaks onto a randomly generated
1920s estate at night, steals what they can find and runs for the
getaway car; security has to catch them first. Top down, fog of war,
light and dark, in the spirit of Monaco; the rules, the name and the look
are our own.

The look and the humour: a **1920s caper drawn like a 1960s cartoon**
(flat, bold outlines, Art Deco gold and black), with deadpan captions and
**anachronisms on purpose** (a GPS tag on a Fabergé egg, a VHS replay, a
Roomba in the ballroom). Everyone takes a turn as the thief; the biggest
haul wins. Pinch: to steal, and to arrest.

## 1. Why it is fun

- **One against everyone, in real time.** The thief is known; the secret
  is *where* they are. Security outnumbers the thief, the thief has the
  dark, the doors and the whole lot to hide in.
- **The TV is a tapped radio.** Security has no private channel. They
  coordinate out loud and with marks on the TV, and the thief hears and
  reads all of it. Marks can be lies; the thief knows that too.
- **Light is the gun.** Being lit is being seen, and a guard catches the
  thief by holding them in the flashlight's beam. A guard who lights the
  way is seen from afar. Everyone chooses between seeing and being seen.
- **Greed.** The valuable things are deep inside, behind locks, alarms
  and tracker tags. Every extra item is a risk; a small haul that gets
  away beats a big one that is pinched.
- **The tape.** After every heist the TV replays it with everything
  revealed: the thief's path, every guard's, the near misses, the lies.

## 2. A game

```
lobby ──▶ round 1: briefing ─▶ heist ─▶ outcome ─▶ the tape ─▶ scores ──▶ round 2 … ──▶ the end
               (20 s)          (3:30)    (5 s)     (~40 s)     (8 s)
```

- **Rounds**: every player is the thief once (setting: once or twice),
  in an order shuffled at the start. Players who joined late get their
  turn at the end; players who left lose theirs.
- **Briefing** (20 s): the TV shows the estate's blueprint, its name and
  the catalogue (§6). The thief's phone shows which parking spot is the
  real getaway car (§3) and one tip ("the Maharaja's Ruby is in the east
  wing"). Guards' phones show where they start (the security office).
- **Heist** (3:30 by default, setting: 2:30, 3:30, 5:00): real time
  (§4). It ends when:
  - the thief gets into the getaway car: **got away**, the haul counts;
  - the thief is arrested (§5): **pinched**, the haul is lost;
  - the clock runs out with the thief still on the lot: **pinched**
    (the police arrive).
- **Outcome**: a full-screen card on the TV and every phone (PINCHED!,
  GOT AWAY), the haul only on the scores.
- **The tape** (§8): the replay. The VIP or the host page can skip it.
- **Scores**: the haul of the round and the totals. Then the next round.
- **The end**: the podium (richest first), the round-by-round hauls and
  awards (§9).

Scores are dollars: a thief gets the value of what they got away with;
a guard gets $1,000 for a hold that ends in an arrest and $2,000 for an
arrest (the reward). Ties: the bigger single haul first.

## 3. The estate

A random map per round, from a seed (the generator, §11): a **lot**
with one building (3–4 players) or two (5–8), and an outside area.

- **Tiles**: a grid of square tiles, about a metre each. Sizes by
  players: 3: ~56×36, 4: ~62×40, 5–6: ~74×46, 7–8: ~86×54.
- **Outside**: a street along one edge, a wall or fence around the lot
  with 2–4 gates, gardens, a car park, alleys; cover (hedges, trees,
  parked cars, sheds, a fountain) that blocks movement and sight; lamps
  that light pools on the ground (radius 4), with dark between them.
- **Parking spots** (3–4, marked **P** on the blueprint, on the street,
  in the car park, in an alley): one is the getaway car, chosen at
  random. Only the thief knows which. A thief who walks into it gets away;
  the TV then shows the car.
- **Buildings**: rectangles split recursively into rooms and corridors.
  Every room has a name and a kind (foyer, ballroom, library, study,
  gallery, kitchen, billiard room, conservatory, bedroom, vault,
  security office, garage, …) that decides its floor and furniture.
  - **Doors** open and close (anyone, walking through opens a closed
    door with a 0.3 s pause). Closed doors block sight. **Locked** doors
    (the vault, some studies): guards open them at once (they have the
    keys), the thief picks the lock in 3 s.
  - **Windows** are curtained (block sight) and can be climbed by anyone
    in 1.2 s.
  - **Light switches**: every room is lit or dark (about half lit at
    the start); anyone in the room near a door switches it.
- **Loot**: 8–14 items placed in the rooms (§6), more valuable deeper
  inside, away from doors to the outside.
- **Cameras** (2–4): fixed, in corridors and outside, with a cone of
  50° and 8 tiles, drawn on the blueprint.
- **A workbench** in a garage or shed: strips tracker tags (§6).
- **The thief starts** at the getaway car; **guards start** in the
  security office.

The **blueprint** is public: walls, doors (not whether they are open),
windows, room names, switches, lamps, cameras, parking spots and the
workbench, on the TV and on every phone, all the time. Loot is never on
the blueprint.

## 4. Moving, seeing, light

**Everyone moves the same**: 3.5 tiles/s, no sprint, a body of radius
0.3 tiles that slides along walls. Players do not block each other.

**Controls** (the phone, §10): tap the floor to walk there (a path is
found around walls and through doors); the contextual action button
(Take, Pick lock, Climb, Switch, Smash lamp, Tamper); guards: the
flashlight (on/off, and dragging aims it), tapping the thief holds them
(§5), long press marks (§7).

**Sight**: from the centre of one's tile, symmetric shadowcasting
through the grid; walls, closed doors, curtained windows and tall cover
block it. A tile is **seen** when it is in sight **and** either lit or
within one's own radius in the dark: guards 1.5 tiles, the thief 2.5
("cat eyes"). A player, an item, an open door or an empty pedestal is
seen when its tile is. Inside a room this means one sees the room when
it is lit; from outside, a room is invisible except through an open
door, along the line of sight.

**Light**, per tile: lit rooms, lamp pools, and guards' **flashlights**
(a cone of 60°, 7 tiles, from the guard, which lights the guard's own
tile too). Switching a flashlight on takes 0.5 s. The cone faces the way
the guard walks; standing still, the guard drags to aim it.

Light gives one away: a lit tile in sight is seen from any distance, so
a guard with the flashlight on is seen by anyone who can see the guard's
tile or the cone. The thief has no flashlight and stays hidden in the dark
unless someone comes within their own radius.

**Memory**: a phone keeps what it has seen (an item's place, a door's
state, an empty pedestal) greyed out with its age; it never shows
anything it has not seen.

**Sound and noise**: some actions make **noise**, a public fact (§7):
smashing a display case, smashing a lamp, a firecracker, the police
alarm. Picking a lock, climbing a window and taking loose items are
quiet.

## 5. The hold and the arrest

Security catches the thief in two steps; one guard alone cannot finish
it.

1. **Hold** (the shot): a guard with the flashlight on taps the thief
   (or the Hold button, which shows while the thief is in the cone) when
   the thief is in the guard's cone, within 5 tiles and in sight. The
   host checks the conditions against the positions of a recent window
   (the phone's lag must not eat a fair shot): 2 × the action's age
   (from its `sentAt`) + 150 ms, at least 250 ms and at most 500 ms
   (§15). A miss costs 2 s before
   the next try.
2. **Held**: the thief is frozen for the hold time: **10 s** with 2
   guards, 0.8 s less per extra guard (6 s with 7). The holder is frozen
   too and keeps the beam on the thief (it aims itself). The hold breaks
   early when the sight between them breaks (a door closes between them)
   or the holder switches the light off. The thief can **wriggle** (tap
   fast): each tap takes 0.15 s off, at most 3 s.
3. **Arrest**: a **second** guard who comes within 1.5 tiles of a held
   thief arrests them. The heist ends: pinched.
4. **Free**: when the hold ends without an arrest, the thief cannot be
   held for 5 s.

A hold is a public fact: the TV shows "HELD" at the place with the time
running out, and every phone shows it, so the whole room shouts and runs.
A police whistle on the TV.

## 6. Loot, the catalogue, the alarm, the tags

- **Items**: from a list of about 60 per language, each with a name, a
  value ($200–$25,000), a size (small: one slot, large: two) and how it
  is kept:
  - **loose** (on a table, a shelf): take in 0.6 s, quiet;
  - **display case**: 2 s, noise (glass);
  - **safe** (in the vault or a study): 5 s, quiet;
  - **pedestal** (the most valuable item, at most one): 1 s, quiet, but
    it trips the **police alarm**.
- **The catalogue**: the night's items, their values and sizes, on the
  TV and every phone, never where they are. An item shows **missing**
  (with its room) once a guard has seen its empty place: discovered
  thefts are public facts.
- **The thief carries 4 slots.** Items cannot be dropped back; a full
  thief has to go.
- **The police alarm**: the clock jumps to 60 s if more was left, the
  bell rings on the TV, the room the alarm came from is a fact.
- **Tracker tags** (anachronism: "GPS, patent pending"): the two or
  three most valuable items carry one. While the thief carries a tagged
  item, the TV pings the thief's position every 20 s, give or take
  3 tiles. The workbench strips all tags in 3 s.
- **The thief's tools**: 2 firecrackers (thrown up to 8 tiles, noise
  there after a 1 s fuse); tampering with a camera (2 s next to it: its
  feed is static from then on, a fact); smashing a lamp (1 s, noise, the
  lamp stays dark).
- **The tip**: at the briefing the thief learns the wing (a building's
  half, or "the garden") of one of the three most valuable items.

## 7. The TV and what is public

The TV is what everyone in the room sees, the thief too. During a heist
it shows only **public** things, in two styles kept clearly apart:

- **Facts** (printed, like a security system's teletype): the room
  lights and lamps, camera sightings, tampered cameras, noise, the
  alarm, discovered thefts, tag pings, holds, an arrest, the car at the
  end.
- **Claims** (marker scribbles in a guard's colour, with the name):
  marks placed by guards. They can be lies.

Guards' positions are **never** shown on the TV or on another phone by
the game itself. A guard is only where someone can see them, or where
they choose to put a mark.

**Marks** (guards; long press on the phone's map, at most 3 each, a
fourth replaces the oldest, each fades after 90 s):

- **Clear** (snaps to a room or an outside area): "checked", with its age.
- **Seen** (a place and an arrow): "the thief was here, going that way".
- **Post** (a door, gate or spot): "this is covered".
- **Look** (a place): "come here".

**Camera sightings**: a working camera sees the thief when the thief is
in its cone and on a lit tile. While it does, the TV shows the thief's
figure there (and the camera's frame flashes); the ink (below) restarts
from that place. Cameras never report guards.

**The ink** ("where could the thief be"): a wash over the blueprint,
computed only from public facts, so it leaks nothing:

- At the start it covers the parking spots and spreads from there.
- It spreads over walkable tiles at the thief's speed (doors and
  windows included: the thief can open and climb them).
- A camera sighting, a hold or the end of a hold restarts it at that
  tile; a tag ping restarts it as a disc of 3 tiles.
- A **Clear** mark erases it in that room or area at that moment; it
  flows back in from the neighbours at the thief's speed.

It is drawn on the TV and, as an overlay that can be hidden, on every
phone.

**Layout** (1280×720, readable from a sofa):

```
┌──────────────────────────────────────────────────────────────┐
│ PINCH · Anna is the thief · The Van Doren Estate   2:41  ⚠1:00│
├──────────┬───────────────────────────────────────────────────┤
│ CATALOGUE│                                                   │
│ ◻ Ruby   │  the blueprint: rooms lit or dark, cameras,       │
│ ◼ Egg ✗  │  lamps, P spots, the ink, marks, noise ripples,   │
│  library │  sightings, HELD 0:06 …                           │
│ ◻ Gin    │                                                   │
├──────────┴───────────────────────────────────────────────────┤
│ 2:20 ALARM: the vault · 2:31 CAMERA 3: a striped sweater      │
└──────────────────────────────────────────────────────────────┘
```

The ticker keeps the last few lines: facts in teletype, claims in the
guard's colour ("Ben: the library is clear. Ben seems sure."). The
captions are where the humour lives (§12). The join badge stays in its
corner, clear of the map.

## 8. The tape

After the outcome the TV plays the heist back, "THE TAPE": a VHS look
(tracking lines, "PLAY ▶ ×6", a timecode) on a 1920s world. Everything is
revealed in full colour: the thief's path as a line, every guard's
path, the flashlights, the loot taken. About 40 s: the heist at ×6,
slowing to ×1 around the moments that matter (holds, sightings, the
alarm, the arrest or the car, a guard passing within 3 tiles of the
thief unseen). Captions call them out:

- "Ben's post at the north gate. Ben was never at the north gate."
- "Clara, 2 tiles from the thief, looking the other way."
- "The firecracker sent three guards to the kitchen."

The host records every player's position, facing and flashlight at
10 Hz and every event; the TV gets the recording at the outcome.

## 9. Scores and awards

After every round: the round's haul and reward, and the totals. At the
end: the podium (richest first), every round's haul, and three awards,
picked from the stats of the game: *Sticky Fingers* (the biggest haul),
*Long Arm of the Law* (the most arrests and holds), *Close Shave* (the
nearest the thief came to a guard unseen), *Tall Tales* (the most marks
that the tape shows were lies), *Lights Out* (the most lights switched
off).

## 10. The phone

Portrait, the whole screen a map centred on the player's figure, about
14 tiles across (pinch to zoom, 10–24). What one sees in full colour,
drawn as shapes in the manner of Monaco (`game/vision.ts`): the clear
space round the figure cut by walls at their middle line, doorways and
cover, and within it one's own circle in the dark and every light (lit
rooms, lamps' pools, flashlight cones), each cut by walls from its own
source; the night is a dark wash with the lights cut out. Blockers are
crosses through their centres as in sight.ts's shadowcasting, so the
shapes show what the host's tiles let one see, give or take a little at
shadows' edges. The rest is the blueprint, with what one remembers
greyed (the union of the shapes one saw, fading with time). The public layer
(ink, marks, facts) over it, toggled with a button.

- **Top bar**: the clock, one's role, the haul (thief: the items in the
  4 slots, tags marked) or the marks left (guard).
- **Bottom**: the action button (what one can do here), and for guards
  the flashlight button (a hold shows as a big HOLD when the thief is in
  the cone); for the thief the firecrackers.
- **Gestures**: tap to walk; tap the thief to hold; drag from one's
  figure to aim the flashlight; long press for the marks menu (a radial
  menu: Clear, Seen with a drag for the arrow, Post, Look); a firecracker
  is armed with its button, then thrown with a tap.
- **Buzzes**: the thief's phone beats like a heart when a seen guard is
  within 4 tiles; held, everyone's phone buzzes; the arrest, the car.
- **Outside the heist**: the lobby (the VIP's settings), the briefing
  (thief: the car and the tip; guards: the plan), the outcome, scores
  and the end.

The phone moves its own figure at once (it runs the same pathfinding
and movement code as the host, in the same 50 ms steps, drawn between
the last two steps so it moves every animation frame) and corrects
towards the host's position; others are drawn between the host's last
two frames (carried on at their pace for up to 100 ms when a frame is
late). The fog follows the figure without a visible lag.

**Frame rate.** Per animation frame nothing is computed per pixel: the
static layers are cached chunks, sight and light are Canvas paths and
clips, the night a half-resolution wash, the ink's mask is made again
only when the ink changes; the HUD touches the DOM only when something
changed (a write every frame relays out the page). A phone that stays
under ~45 fps steps its map's resolution down (2 → 1 device px per CSS
px). `test/live/perf.ts` measures frame times and the hottest functions
with the CPU slowed like a phone's.

## 11. Views, timing and the generator

**The host is the only authority.** It runs the heist at 20 Hz in the
host page (tvpipe's app window keeps timers running in the background)
and decides for every phone what it may know.

- **Phases** (`party.room`, `player.state`, `party.screen`): lobby,
  briefing, heist, outcome, tape, scores, final; phase changes with the
  TV (`party.withTv`). The map (the blueprint) goes into the room view
  once per round.
- **Frames**: during a heist the host sends every phone its own frame
  at 10 Hz (`party.send`): its position, what it sees (the seen tiles,
  the players, items, doors and lights on them), the public layer's
  changes. Nothing outside a player's sight reaches their phone. The TV
  gets the public layer at 10 Hz.
- **Input**: walking is an action (`go` with the target tile); aiming is
  continuous input (at most every 100 ms); everything else is an action
  answered at once (refused with why).
- **Phones that leave**: a guard away stands still. A thief away for 10 s
  ends the heist with no score ("the thief has left the building"), and
  the next round starts. Fewer than 3 players end the game.
- **Latecomers** wait for the next round as guards and get a thief turn
  at the end.

**The generator** (`game/map.ts`), seeded, a try at a time so the host
page keeps going:

1. Lot size by players; the street along one long edge, the wall with
   gates; one or two building footprints set back from the street.
2. Buildings: recursive splits into rooms (3–9 m), a corridor spine in
   larger ones, doors between neighbours (a spanning tree plus extra
   doors for loops), 2–3 doors and 3–6 windows to the outside; room
   kinds by size and depth; the vault deepest with a locked door; the
   security office near the front.
3. Outside: gardens, hedges, trees, cars and sheds in the gaps, never
   closing a path; lamps; parking spots on the street, in the car park
   and in an alley, far apart; cameras on corridors and approaches.
4. Loot by depth (steps from the nearest door to the outside): cheap
   near, valuable deep; the pedestal item in the deepest room.
5. Checks, else another try: everything walkable is connected, every
   parking spot is reachable from every room, no loot within 6 steps of
   an outside door, at least two routes (disjoint doors) from the vault
   to the outside, cover between the building and every parking spot.

## 12. The look, the sound, the words

**Style**: flat illustration with bold dark outlines, as in a 1960s
spy cartoon, set in the 1920s: Art Deco gold, black, cream, emerald
and oxblood, sunbursts and stepped frames. Phase changes are **silent
film intertitles** (a black card in a gold Deco frame: "MEANWHILE, AT
THE VAN DOREN ESTATE…").

- **The unseen** is an architect's blueprint: Prussian blue paper,
  white lines, room names lettered in capitals, the ink as a red pencil
  hatch, claims as wax crayon.
- **The seen** is warm and in full colour: parquet, checkered marble,
  carpets, furniture by room kind (a billiard table, bookshelves, a grand
  piano, a bathtub), lamp pools in amber, flashlight cones in pale
  yellow; the dark is a deep blue-black.
- **Characters**, from above: guards in bowler hats in their colour, a
  flashlight in hand; the thief in a black flat cap with a striped
  jersey and a sack that grows with the haul.
- **Fonts** (SIL OFL, bundled): a Deco display face for titles (e.g.
  Limelight), a geometric sans for text (e.g. Josefin Sans), a
  typewriter face for the teletype facts.
- **Sound** (TV, synthesized): a police whistle (hold), a bell (alarm),
  breaking glass, a firecracker, a camera shutter (sighting), a record
  scratch (arrest), a car horn that is anachronistically a modern car
  alarm chirp (got away), a ticking clock in the last 10 s, the tape's
  VHS whirr.

**Words** in English and German, written separately (the German is not
a translation): deadpan, dry, a little smug. Estate names ("The Van
Doren Estate", "Château Moneybags"), the catalogue (a Fabergé egg, the
Maharaja's Ruby, stock certificates "pre-crash", a crate of
Prohibition gin, a Walkman "for when they invent tapes", Tutankhamun's
left sandal, a lava lamp), the tips, the ticker's facts, the tape's
captions, the outcome cards, the awards. Anachronisms are welcome; no
lines lifted from films or shows.

## 13. Settings

The host page and the VIP's phone: **heist length** (2:30, 3:30, 5:00),
**rounds** (everyone once, everyone twice), the language (English,
German), late joining (wait, closed). All of them in the lobby and at
the end; late joining also during a game (the host page's live field;
on the VIP's phone at the tape and the scores, beside Skip). The
others are refused while a game runs (`running`).

The language is the room's, the same on every phone and the TV; a
phone has no language of its own (before joining it uses the
browser's).

## 14. Code

| | |
|---|---|
| `game/map.ts` | tiles, rooms, doors, windows, cover, lamps, cameras, spots, loot places; the generator (§11) |
| `game/sight.ts` | shadowcasting, light, what a player sees |
| `game/vision.ts` | sight as shapes for drawing: blockers' outlines, visibility polygons (the view, lamps, cones) |
| `game/move.ts` | pathfinding (A* on the grid), movement with sliding |
| `game/ink.ts` | the ink from public facts |
| `game/sim.ts` | the heist: state, inputs, a 50 ms step, events; pure, no party |
| `game/items.ts`, `game/words.ts` | the catalogue and the words (en, de) |
| `game/game.ts` | the party: phases, rounds, scores, views and frames, the tape's recording |
| `game/bots.ts` | bots for tests (a thief that goes for loot and runs, guards that patrol and chase) |
| `host/` | the host page (`HostPage` with Pinch's settings) |
| `screen/` | the TV page: canvas rendering of the blueprint and the public layer, the tape, intertitles, sound |
| `phone/` | the phone page: canvas map, controls, prediction |
| `phone/draw.js` | drawing shared by the TV and the phone (tiles, furniture, characters, light, blueprint) |

The phone imports the compiled `game/move.ts` and `game/sight.ts`
(`dist/game/`) for prediction.

## 15. Checking it

`npm test`:

- the generator at every player count and many seeds (§11's checks),
  with fixtures for a few seeds;
- sight against hand-drawn fixtures (walls, doors, corners, light,
  radius), symmetry; light from rooms, lamps and cones;
- pathfinding and movement (sliding, doors, no tunnelling through
  corners);
- the ink (spreading, restarts, Clear);
- the simulation: holds (in the cone, out of it, out of range, behind a
  door, the lag window, the cooldown), the hold time by guards, breaking
  a hold, wriggling, the arrest, immunity, loot and slots, the alarm,
  tags and the workbench, firecrackers, cameras and tampering, the car,
  time's up;
- whole games with bots in memory: **secrecy** (no frame of a guard
  holds the thief, an item or a door outside that guard's sight; the TV
  never holds a guard's position or an unseen item; the car's spot
  reaches only the thief), rounds and rotation, scores, drop-outs
  (`dropOuts`), the thief leaving, latecomers, too few players,
  settings, German;
- `test/live/play.ts`: through tvpipe in headless Chrome, a phone that
  walks by taps, a guard that holds, bots for the rest; screenshots of
  the TV (briefing, heist, held, the tape, scores, the end) and the
  phone (thief and guard, five sizes) with layout checks; `--shots DIR`
  for the games list.

**First of all, a lag check**: before the look exists, two phones
through the tunnel walking and holding (`test/live/lag.ts`): the time
from a tap to the figure moving on the host, how far the phone's
prediction is off, and how often a fair hold (by the phone's picture)
is refused. The numbers decide the 250 ms window and the speeds.

Measured (two phones and a bot in headless Chrome on one Mac, a thief
walking across the cone's edge, the guard tapping when his phone shows
her in the cone: on entry and in the last moment before she leaves;
35 s each, about ten holds tried, the hold cut to 1.5 s so tries come
often):

| | local | local, +150 ms each way | tunnel |
|---|---|---|---|
| tap → the go at the host | 1 ms | 156 ms | 22 ms (p95 61) |
| tap → the phone's frames show the move | 67 ms (p95 102) | 350 ms (p95 407) | 102 ms (p95 168) |
| prediction vs the host, walking (mean/p95/max tiles) | 0.23/0.38/0.78 | 0.29/0.44/0.56 | 0.14/0.32/0.48 |
| holds the host took (entry, exit) | 6/6, 4/4 | 1/1, 0/8 | 6/6, 3/3 |
| window a hold needed (p95/max) | 36/36 ms | 388/388 ms | 69/69 ms |

On these networks 250 ms is plenty; at 150 ms each way every exit shot
is refused (notInLight): the guard's picture of the others is a frame
and the interpolation (about 150 ms) behind the frames, and the frames
and the tap each cost the one-way time. So the window counts the
phone's lag: from the action's `sentAt` (the party's `ActionInfo`),
2 × (received − sentAt) + 150 ms, at least 250 ms and at most 500 ms.
This is what runs: game.ts passes each action's age to the sim, which
checks a hold over `holdWindow(age)` (protocol.ts) and keeps 700 ms of
positions.
The speeds stay (3.5 tiles/s): the prediction is off by less than half
a tile at p95 even with the delay, and the figure moves at the tap.
