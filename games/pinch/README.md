# Pinch

A real-time heist for 3–8 players (our own rules, name and look) on
[`@tvpipe/party`](../../npm/party), in English and German. One player
is the **thief**, everyone else is **house security**. The thief sneaks
onto a randomly generated 1920s estate at night, steals what they can
find and runs for the getaway car; security has to catch them first.
Top down, fog of war, light and dark; a 1920s caper drawn like a 1960s
cartoon, with anachronisms on purpose.

- **The estate**: one or two houses and their grounds, new every round:
  rooms with doors, locks, curtained windows and light switches,
  gardens, lamps, cameras, three or four parking spots. Only the thief
  knows which spot is the car, and nobody knows where the loot is.
- **Seeing**: on the phone one sees only what is in sight and lit (or
  very close in the dark); inside a room only from inside, or through
  an open door. The rest is the blueprint, with what one remembers.
- **The catch**: a guard holds the thief by tapping them in the
  flashlight's beam; a second guard has to come and make the arrest
  before the hold runs out (10 s, less with more guards).
- **The TV is a tapped radio**: it shows only public things (lights,
  noise, the alarm, camera sightings, discovered thefts, GPS pings,
  holds, where the thief could be) and the guards' marks, which can be
  lies. Security has no private channel; the thief hears and reads
  everything.
- **The tape**: after every heist the TV replays it with everything
  revealed, and calls out the lies and close shaves.
- **Scores**: everyone is the thief once (or twice); the biggest haul
  wins, guards earn rewards for holds and arrests.

The rules, the numbers and why: [`docs/pinch-design.md`](../../docs/pinch-design.md);
the voice of the words: [`design/words.md`](design/words.md).

| | | |
|---|---|---|
| `tvpipe.json` | the manifest | pages, 3–8 players, the TV's size; `root: dist` |
| `game/` | `map.ts` (the generator), `sight.ts` (sight and light), `vision.ts` (sight as shapes, for drawing), `move.ts` (paths, movement), `ink.ts` (where the thief could be), `sim.ts` (the heist), `protocol.ts` (what crosses the wire), `views.ts` (the phases' views), `game.ts` (the party: rounds, scores, frames), `bots.ts`, `items.ts` and `words.ts` (the catalogue and every word, en and de) | TypeScript on `@tvpipe/party`, tested in Node; the phone runs `move.ts` and `sight.ts` too, for prediction |
| `host/` | the host page | tvpipe's `HostPage` with Pinch's settings |
| `screen/` | the TV page | lobby, intertitles, briefing, the heist's blueprint and public layer, outcome, the tape, scores, the end; `sound.js`; `?demo=…` |
| `phone/` | the phone page | joining, lobby, briefing, the heist (`heist.js`, `world.js`: the map, gestures, prediction), outcome, scores; `draw.js` (all drawing, shared with the TV), `deco.css`; `?demo=thief\|guard` |

## Running it

```sh
cargo build --release -p tvpipe-cli
(cd npm/party && npm ci && npm run build)
cd games/pinch && npm install && npm run build
../../target/release/tvpipe game play .
```

Pick the TVs (or "A browser tab on this computer"), then Start. The
first player is the VIP and starts the game from their phone once three
are in (or the host page's Start). Settings (the host page, or the VIP's
phone in the lobby and at the end): the heist's length (2:30, 3:30,
5:00), turns as thief (once, twice), the language, late joining (wait,
closed). Late joining also changes during a game: the host page, or the
VIP's phone at the tape and the scores.

## Checking it

```sh
npm run check && npm test       # types; the generator, sight, movement, ink, the heist, whole games with bots (secrecy included); ~6 s
node test/live/play.ts          # a live game through tvpipe: two phones by taps, bots, screenshots in /tmp/pinch-play
node test/live/play.ts --players 3 --lang de
node test/live/play.ts --shots ../../site/static/games/pinch   # the games list's pictures
node test/live/tv-shots.ts      # every TV phase from ?demo, with layout checks
node test/live/phone-shots.ts   # every phone phase at five sizes from ?demo, with gesture checks
node test/live/perf.ts          # frame times and hot functions of the heist, CPU slowed 4×
node scripts/map.ts 5 1 --secrets   # an estate as text
```

Bots are for tests: the host page's bot buttons show only with `?bots`
in its URL or with `tvpipe game play --dev` (`?fast` there shortens the
heist). The live checks need Chrome and a built tvpipe
(`TVPIPE_BINARY`, else `target/release`, else `target/debug`).

## Languages

English and German, written separately. The language is the room's: a
setting on the host page; a phone may switch for itself on the join
screen.

## The fonts

Limelight, Josefin Sans and Courier Prime (SIL OFL 1.1), in
`phone/fonts/` with their licenses.
