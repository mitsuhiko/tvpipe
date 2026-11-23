# Worldquiz

A geography card game (our own rules, names and look) on
[`@tvpipe/party`](../../npm/party), for 2–10 players, in English and
German. Every country of the world is a card: its flag, its name, its
capital, where it is, and five numbers (population, area, neighbours,
highest point, GDP per person).

- **Everyone draws a card at once**, and sees only their own: the card
  on the phone with the country on a little map or globe.
- **The captain** (in turn) either **competes** with one of the five
  numbers (every card turns over, the TV flies from country to country,
  the highest number moves its holder's plane one stop) or calls a
  **challenge**: the hands are shown and discarded (strong cards called
  out, so everyone knows what is gone), then a random new country with a
  random kind of challenge for everyone, against the clock: type its
  **capital**, name the country from its **flag** (spelling forgiven,
  but only toward one country), or **pin it** on the map (the closest
  wins; pins that are nearly as close tie). Nobody right: another
  challenge, up to three.
- **Ranks are secret** until a card is shown: a hand has its numbers,
  not how they rank; compared and discarded cards show "#3", and a gold
  badge in the top ten.
- **The deck** has every country once; drawn cards go to the discard
  pile until the deck is empty.
- **The end**: the furthest plane after 15, 30 or 45 rounds (rounded up
  so everyone is captain as often) wins; a tie is settled with pins.

The rules, the data and why: [`docs/worldquiz-design.md`](../../docs/worldquiz-design.md).

It is a web app for [`tvpipe game play`](../../docs/playshare-design.md):
tvpipe serves it, the game runs in its host page (a window on the
computer), the TV page is cast to AirPlay and Chromecast receivers, and
phones join with the QR code.

| | | |
|---|---|---|
| `tvpipe.json` | the manifest | pages, 2–10 players, the TV's size; `root: dist` |
| `game/` | the rules (`rules.ts`: the deck and its pile, ranks, comparing, pins), reading answers (`answer.ts`), distances on the globe (`geo.ts`), the data's types (`data.ts`), the game (`game.ts`), bots (`bots.ts`) | TypeScript on `@tvpipe/party`, tested in Node |
| `host/` | the host page | tvpipe's standard host page (`HostPage`) with Worldquiz's settings |
| `screen/` | the TV page | the map (`map.js`: a cartoon world on a canvas, flat Mercator or globe, shared with the phones), the stages, the planes' trip, sounds; `strings.js` |
| `phone/` | the phone page | joining, the lobby (the VIP's settings), one's card, the captain's choice, answers (a field, or the map to pin on), results; the shared look (`toy.css`, `cards.js`) |
| `data/` | the cards (`countries.json`), the land (`shapes.json`), the flags | written by `node scripts/data.ts` from Wikidata, the World Bank, Natural Earth and Wikipedia with the decisions in `data/decisions.txt`; see `CREDITS.md` |

## Running it

```sh
cargo build --release -p tvpipe-cli
(cd npm/party && npm ci && npm run build)
cd games/worldquiz && npm install && npm run build
../../target/release/tvpipe game play .
```

Pick the TVs (or "A browser tab on this computer"), then Start. The
first player is the VIP and starts the game from their phone once two
are in (or the host page's Start). Settings (the host page, or the VIP's
phone in the lobby): rounds (15, 30, 45), difficulty (easy, normal,
hard: 25, 15 or 10 s to answer, how well known the challenges'
countries are, how close a pin must be, borders on the phone's map or
only coasts), the TV's map (flat or globe; every phone picks its own),
and the disputed states (Kosovo, Palestine, Taiwan and Western Sahara as
cards; off, their land is nobody's and they are nobody's neighbours);
on the host page only, the language and latecomers.

## Checking it

```sh
npm run check && npm test          # types; the rules, answers, distances, the data, whole games with bots in Node
node scripts/data.ts --check       # the data is what the sources and decisions make (needs .cache/, from a run)
node test/live/play.ts             # a live game: tvpipe, headless Chrome, a phone, bots; screenshots in /tmp/worldquiz-play
node test/live/play.ts --lang de --map globe --bots 6
node test/live/play.ts --bots 3 --shots ../../site/static/games/worldquiz   # the games list's pictures
```

Bots are for tests: the host page's bot buttons show only with `?bots`
in its URL or with `tvpipe game play --dev` (`?fast` there shortens
every timer), and the live check adds them through `worldquiz.addBots`.
As captain they compete with their best number or challenge; they
answer right some of the time (the host page knows the answer), with a
typo now and then, and drop pins near the country or anywhere.

## Languages

English and German. The language is the room's: a setting on the host
page, which starts with the browser's language and changes only between
games. Cards show only the room's language; typed answers are read in
both.

## The fonts

Grandstander (the logo, headings, numbers, buttons) and Sue Ellen
Francisco (hand-written notes), both SIL OFL 1.1, in `phone/fonts/`
with their licenses.
