---
title: Party games
summary: Games on the TV that everyone plays with their phone.
group: Use
spec:
  Command: `tvpipe game play [GAME…]`
  Package: `@tvpipe/party` (npm, for writing games)
  A game: a folder or a zip with `tvpipe.json`, here or from the internet
  Games: [the games page](/games/)
---

`tvpipe game play` runs games like the ones from Jackbox: the TV shows the game and a QR code, and everyone joins by scanning it with their phone. Nobody installs anything: a game is a small web app, and tvpipe serves it, puts its main screen on the TV and connects the phones.

```sh
$ tvpipe game play                     # pick one from the list in the window
$ tvpipe game play drawbluff           # a game from the list, downloaded
$ tvpipe game play my-game             # a folder with tvpipe.json
$ tvpipe game play my-game.zip         # or a zip of one
$ tvpipe game play my-games            # a folder of games: pick one in the window
```

The games of the list also run without tvpipe, in a browser on a laptop or an iPad: [Playing in the browser](in-the-browser.md).

Without a game, the window opens on the [list of games](/games/), with pictures of each. Click one: tvpipe downloads it, asks in the window before it runs a game the first time, and moves on to picking the TVs. A field below the list takes a game from elsewhere (`https://…` or `gh:OWNER/REPO`).

A folder of games (folders with `tvpipe.json`, or zips), or several paths, come first in the list, under "On this computer"; the online list follows.

## Games from the internet

:::aside Kept
Downloaded games stay in tvpipe's cache folder (`TVPIPE_CACHE_DIR` moves it). `tvpipe game list` shows them.
:::

Games are not part of tvpipe: each one comes out on its own. A name from the [games list](/games/) downloads the newest release of that game made for your tvpipe:

```sh
$ tvpipe game play drawbluff
Drawbluff ("drawbluff") from gh:mitsuhiko/tvpipe/drawbluff@drawbluff-v* ("drawbluff" in the games list), release drawbluff-v0.3.0
  128.2 KiB, 24 files (254.5 KiB unpacked), made for tvpipe 0.3
  sha256 67a1867955902de214916aa67a287580fda732d46008d98b7e36d763094b0dd3
  It runs in tvpipe's window, can cast to the TVs on this network and serves pages to phones.
  Play it? [y/N]
```

A game runs in tvpipe's window and can do what tvpipe can: cast to your TVs and serve pages to phones. So tvpipe asks before it runs a game from the internet the first time, and again when a new release of it comes out. A game from the list is asked about like any other. `--yes` (`-y`) answers yes; without a terminal tvpipe needs `--yes` or a pin.

Other sources work the same way:

| Source | |
|---|---|
| `NAME` | a game from the [list](/games/) |
| `https://…/game.zip` | a zip on a website |
| `gh:OWNER/REPO` | the zip of a GitHub repository's latest release; `gh:OWNER/REPO@TAG` a given release. Links to the repository or release on github.com work too |
| `…#sha256=HEX` | only this zip (a pin): tvpipe checks it and does not ask |

| Option | |
|---|---|
| `--yes`, `-y` | Play it without asking |
| `--refresh` | Look for a new release even of a game played before |
| `--offline` | Only games downloaded before: no network |

The names come from [games.json](https://tvpipe.party/games.json) on this site, which tvpipe reads when you play a game by name (`TVPIPE_GAMES_URL` names another list). `tvpipe game fetch SOURCE` downloads a game without running it, checks it and prints the source pinned to its SHA-256 (`-o FILE` also writes the zip). The next `game play` of that pin needs no network. When the network fails, tvpipe plays the copy it has and says so.

## Playing

1. tvpipe opens a window. It lists the TVs on your network as they answer: Apple TVs and AirPlay TVs, Chromecasts and Google TVs. An Apple TV you have not paired with shows a **Pair** button: the TV shows a code, you type it in the window. A TV with an AirPlay password asks for that password instead. "A browser tab on this computer" lets you try a game without a TV.
2. Pick one or more TVs and press **Start**. The window becomes the game's own page, and the TV shows the game with its QR code.
3. Everyone scans the QR code and plays on their phone. Phones that lose the connection (a locked screen, a tunnel hiccup) come back on their own.
4. **Other game** in the window picks the next game from the list. The TVs, the QR code and the link stay, and the phones go to the next game by themselves, with their names.
5. Close the window (or press Ctrl-C in the terminal) to end it: the TVs leave the game, the phones say the room closed.

![The start window: a game, its TVs to pick, and the Start buttons](shots/game-launcher.png "The start window of `tvpipe game play`, with Drawbluff.")

:::aside How phones get in
By default through a public link: OpenTunnel, which tvpipe sets up once and reuses, with Cloudflare when OpenTunnel fails. `--lan` serves phones on the same Wi-Fi instead.
:::

| Option | |
|---|---|
| `--tunnel=opentunnel`, `--tunnel=cloudflare` | Who carries the phones' link (default: OpenTunnel, then Cloudflare) |
| `--no-tunnel` | No public link: phones on the Wi-Fi (`--lan`) or this computer only |
| `--lan`, `--lan=IP` | Also serve phones on the Wi-Fi, at `http://IP:7420` |
| `--window=open` | The game's window in your usual browser instead of tvpipe's own. Links the game's window opens in a new tab, like the TV view, open in your usual browser either way |
| `--window=none` | No window: tvpipe prints its link |
| `--browser PATH` | The browser for the window and for rendering the TV |
| `--resolution RES` | The TV picture at the start: `auto` (up to 1080p, the default), `720p`, `1080p` or `4k`; the window can change it. The game looks the same, only sharper |
| `--bitrate KBPS` | The TV picture's video bitrate, like `--bitrate 20000`. The default comes from the size and frame rate (about 6000 at 1080p30). Higher is sharper in motion but needs a good network; AirPlay takes up to 25000. When the network cannot keep up, tvpipe lowers it for a while and goes back up once it can |
| `--dev` | Test mode: the game may offer test tools in its window. Drawbluff, Garble, Jinx, Krakel, Shifty, Landgrab and Crosstalk get "Add a bot" buttons there: dummy players that join and play by themselves, to try a game alone |

The QR code holds the link with the room's code and a key, so only people who can see the TV can join. On the Wi-Fi (`--lan`) the page is plain HTTP and the key crosses the network unencrypted: use the public link on networks with strangers. With Cloudflare, Cloudflare can read the game's traffic. With OpenTunnel, nobody else can.

With a public link the TV also shows a short one to type, like `tvpipe.party/BCDF`. It and the QR code open the game inside a page of tvpipe.party, so phones show tvpipe.party instead of the tunnel's changing name (in the address bar, the history and parental controls). `--no-short-link`, or `TVPIPE_PARTY_URL=off`, turns both off: then the QR code is the tunnel's own link.

## How it works

:::aside The split
tvpipe serves the game, casts its TV page and passes the phones' messages on. The game, in its own page, keeps the players and the rules.
:::

- The game's **host page** runs in the window: it holds the rules, the players and what everyone sees.
- Its **TV page** runs in a browser tvpipe starts in the background. tvpipe streams that tab, picture and sound, to the TVs, as with [A web page on the TV](web-page.md).
- Instead of a TV page, a game can also draw into a canvas and send that to the TVs, one picture per TV. See [Canvases on the TV](making-games.md#s4).
- Its **phone page** loads over the public link. Every phone's connection ends in tvpipe, which hands it to the host page.

## Making a game

A game is a small web app: a host page with the rules, a TV page, a phone page and a `tvpipe.json` that names them. [Making party games](making-games.md) covers writing one, checking it and packing it into a zip.

## Adding a game to the list

A game on the [games list](/games/) is a game anyone can play by name. Publish it as a release (see [Share it](making-games.md#s7)), then open a pull request that adds it to `site/static/games.json` in the [repository](https://github.com/mitsuhiko/tvpipe), with its screenshots in `site/static/games/NAME/`: at least one, the first of the TV the cover (on the games page and in tvpipe's window). Take them while playing a real round with a few people:

| Kind | Size | |
|---|---|---|
| `tv` | 1280×720 | the TV page at a lively moment: a vote, a reveal, the results |
| `phone` | 390×844 | the phone page: what a player does, one or two |

Each a PNG, JPEG or WebP of at most 400 KiB, with an `alt` text that says what it shows. `node site/social.mjs NAME` then makes the game's link preview from its title, players, cover and first phone picture (`site/static/social/games/NAME.jpg`, the picture chat apps and social sites show for a link to its page). `python3 site/build.py` checks the entry, the pictures and the preview. Everyone can also play a game from its release without the list: `tvpipe game play gh:OWNER/REPO`.

## Safety

- tvpipe only answers for the game's public link and for this computer, and limits how much and how fast every phone may send.
- The game's own controls (tvpipe's window and its API) are not on the public link at all.
- Names are cleaned up and must be unique. A `moderate` function can refuse words you do not want on the TV.
- The VIP and the game can remove players. The game's window also lists the players with buttons to remove one or make another the VIP, during a game too.

## The demo game

Drawbluff is a drawing and bluffing game for 3 to 50 players:

```sh
$ tvpipe game play drawbluff
```

Its source is `games/drawbluff` in the repository. To change it, build it and play the folder:

```sh
$ cd games/drawbluff && npm install && npm run build
$ tvpipe game play .
```

Its window shows the room code and the QR code, the TVs, the players, the number of rounds, the timers and whether latecomers join at the next round, at the next drawing, or not at all, and a preview of the TV.

Drawbluff speaks English and German. Pick the language on the host page, which starts with your browser's, and every phone and the TV follow. A phone can switch for itself in the lobby.

Each language has its own prompts, written for it rather than translated: 665 in English, 698 in German. They range from odd pairs, idioms taken literally and useless superpowers to history gone wrong, and in German also compounds taken literally („ein glückspilz“). A room never deals the same prompt twice until it has used them all.

The design is in [docs/playshare-design.md](https://github.com/mitsuhiko/tvpipe/blob/main/docs/playshare-design.md), the protocol between phones and the game in [docs/party-protocol.md](https://github.com/mitsuhiko/tvpipe/blob/main/docs/party-protocol.md).
