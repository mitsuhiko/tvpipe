---
title: Making party games
summary: Build a game for tvpipe, check it, pack it into a zip, run it and share it.
group: Use
spec:
  Commands: `game new`, `game check`; `game pack`, `game play`; `game fetch`
  Library: `@tvpipe/party` (served by tvpipe at `/_tvpipe/lib/`)
  Browser: Chrome, Edge, Chromium or Brave for the window and `--smoke`
  Example: `games/drawbluff`
---

A party game for tvpipe is a small web app: a **host page** with the rules, a **TV page** and a **phone page**, plus a `tvpipe.json` that names them. tvpipe serves it, opens the host page in a window on your computer, casts the TV page to your TVs, and puts the phone page on a link the TV shows as a QR code. Nobody installs anything.

:::aside No server code
The game runs in browsers. tvpipe relays the phones to the host page, and the `@tvpipe/party` library there keeps the room, the players and what every screen shows.
:::

## Start a game

```sh
$ tvpipe game new my-game
$ tvpipe game play my-game
```

The starter is a buzzer in plain JavaScript: the host counts rounds and points, the TV shows the QR code and who buzzed first, phones get a big button. Edit a file, reload the page, and the change is there.

## tvpipe.json

```json
{
  "name": "my-game",
  "title": "My game",
  "tvpipe": "0.4",
  "pages": { "host": "host/index.html", "tv": "tv/index.html", "phone": "phone/index.html" },
  "players": { "min": 2, "max": 12 },
  "tv": { "width": 1280, "height": 720 }
}
```

| Field | Meaning |
|---|---|
| `name` | a short name, `a-z`, `0-9` and `-` |
| `title` | what the launcher shows |
| `tvpipe` | the tvpipe version the game is made for |
| `root` | the folder that is served, for games with a build step (`"dist"`) |
| `pages` | the host, TV and phone pages, and `launcher` for a start page of your own |
| `players` | how many can play, with `max` at most 1000 |
| `tv` | the TV page's size |
| `limits` | how much a phone may send (`message`, `rate`, `burst`) |

## The three pages

:::aside Views, not messages
The host sets what each screen shows. A phone that was away gets the latest state when it comes back. Actions from phones are applied once, even after a dropped connection.
:::

The host page makes the party and runs the game:

```js
import { Tvpipe, PartyError } from "/_tvpipe/lib/index.js";

const tvpipe = await Tvpipe.connect();
const party = await tvpipe.party();
await party.cast();                                // the TV page on the TVs picked in the launcher

party.screen.set({ phase: "lobby" });              // what the TV shows
party.handle("answer", (data, player) => {         // what a phone does
  party.room.set({ last: `${player.name}: ${data.text}` });
});
```

The TV and phone pages use the client:

```js
import { PartyClient, qrSvg } from "/_tvpipe/lib/client.js";

const client = PartyClient.fromLocation();
client.on("view", (view) => render(view));         // TV: screen, join (the QR code); phone: room, me
if (client.canResume) await client.connect();
else await client.join(nameInput.value);           // phones only
await client.act("answer", { text: "a nervous cactus" });
```

The host never sends events to phones. It sets what each one shows: `party.room` for every player, `player.state` for one player, and `party.screen` for the TV. The TV page's view also has the join link and its QR code (`qrSvg(view.join.qr)` draws it).

For a stick or a tilt, `client.input(data)` on the phone sends continuous input: never answered, the latest wins. The host gets it as the `input` event.

Joining mid-game is the game's choice. While `party.inProgress` is set, `party.lateJoin` decides what happens to a new name: `"closed"` refuses it (players who were already in still come back), while `"wait"` (the default) and `"open"` let it in as a waiting player (`player.waiting`). The game deals them in with `party.activate(player)` when it wants. The TV page sees the setting in `join.lateJoin`, so it can say "join anytime" under the QR code.

A game may bring its own start page instead of tvpipe's (`"launcher"` in `pages`), with the same `Tvpipe` calls: the TVs, pairing, then on to the host page.

### The library

Import the library from `/_tvpipe/lib/`: tvpipe serves the copy that fits it. With TypeScript or a bundler, install `@tvpipe/party` for its types and point `"@tvpipe/party"` at `/_tvpipe/lib/index.js` in the build or with an import map. For tests, `memoryRelay()` connects a host and fake phones in one process.

```sh
$ npm install --save-dev @tvpipe/party
```

Put fonts, sounds and libraries into the game, so it works without internet.

## Canvases on the TV

:::aside Audio
`audio: { context, node }` sends a Web Audio node's sound along with the picture.
:::

A game that draws its TV picture into a canvas, 2D or WebGL, can send it straight to the TVs. The page encodes it and tvpipe streams it, without a second browser in between. That takes about half the computer's effort, works in Chrome, Firefox and Safari, and gives every TV its own picture: one surface per screen.

```js
const tv = await tvpipe.surface({ canvas, fps: 30, to: ["Living Room"] });
function draw() { render(ctx); tv.frame(); requestAnimationFrame(draw); }
```

A game that streams a canvas this way does not need a party client on its TV page.

Drawing stops while the window is minimized, unless the canvas lives in a worker. With an `OffscreenCanvas` drawn on a timer there (`clock: "timer"`), the library's `SurfaceEncoder` runs in the worker too.

A TV page made of HTML can be drawn into a canvas in Chrome 157 and later (HTML-in-Canvas) and streamed the same way. [docs/playshare-design.md](https://github.com/mitsuhiko/tvpipe/blob/main/docs/playshare-design.md) explains surfaces in section 17.

## Check and pack

```sh
$ tvpipe game check my-game          # what would break, with file and line
$ tvpipe game pack my-game           # my-game.zip
$ tvpipe game pack my-game --smoke   # and run it once in a headless browser
```

:::aside Same files, same zip
The zip is the same byte for byte when the files are: entries are sorted and carry no timestamps of yours.
:::

| Option | |
|---|---|
| `-o FILE` | `game pack`: the zip to write. Default: `NAME.zip` here, `NAME` from `tvpipe.json`. |
| `--smoke` | Also run the game once without TVs, with a fake phone. |
| `--strict` | Warnings fail too, for CI. |
| `--browser PATH` | The Chromium based browser for `--smoke`. |

`tvpipe game check` checks `tvpipe.json`, then follows every page through its HTML, CSS and JavaScript imports. It reports missing files, names that differ only in case (they work on a Mac and break in the zip), TypeScript that was never built, imports a browser cannot resolve, files that come from the internet, and names that break on other systems. `--smoke` starts the game without TVs, opens the launcher, the host page, the TV page and the phone page in a headless browser, lets a fake phone join, and reports errors from any of them. `--strict` makes warnings fail too, for CI. `game pack` runs the same checks before it packs.

`game pack` ends with the zip's SHA-256 (`sha256 …`), for pinning it (see below). A zip made by hand, with the Finder's Compress for example, works too, but `tvpipe game pack` checks the game and leaves out what does not belong.

## Play

```sh
$ tvpipe game play my-game.zip
```

The window shows the TVs, and the game starts on the ones you pick. [Party games](party.md) covers the window, how phones get in, and how a game ends.

| Problem | Try |
|---|---|
| The game does not start | `tvpipe game check` on it lists what is wrong |
| No TVs in the list | Same network, TV awake, AirPlay or casting turned on. `tvpipe discover` shows what the network has. |
| Phones cannot open the link | `--tunnel=cloudflare`, or `--lan` with the phones on the same Wi-Fi |
| The game needs a newer tvpipe | Update tvpipe. The game's `tvpipe.json` says which version it is made for. |

## Share it

:::aside Pinned
`#sha256=HEX` after a source plays only that zip, and skips the question. `tvpipe game fetch SOURCE` prints a source pinned that way.
:::

Put the zip where people can download it. tvpipe plays it from there, asks once before running a game from the internet, and keeps it for next time:

```sh
$ tvpipe game play https://example.com/my-game.zip
$ tvpipe game play gh:you/my-game             # the latest GitHub release's zip
$ tvpipe game play gh:you/my-game@v1.2.0      # that release
```

A GitHub release is the easiest place: attach `my-game.zip` (the release's only zip, or one named like the repository) to a release. Links to the repository or the release on github.com work too.

Several games in one repository, or a repository with releases of its own, give every game its own tags, `my-game-v1.2.0`, and players name the stream: `gh:you/games/my-game@my-game-v*` takes the newest of them that fits their tvpipe. A line `<!-- tvpipe: 0.4 -->` in the release notes says which tvpipe version the release is for, so a player with an older tvpipe gets the newest release that still runs on it.

To have a game played by name, add it to the [list of games](party.md#s5).

The whole guide, with the manifest's limits and every check, is [docs/games.md](https://github.com/mitsuhiko/tvpipe/blob/main/docs/games.md).
