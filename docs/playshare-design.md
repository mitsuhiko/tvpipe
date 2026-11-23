# playshare: web games on the TV (design)

Status: implemented (`crates/tvpipe/src/playshare/`, `npm/party`,
`games/drawbluff`); what changed while building it is in §16. Supersedes
`docs/multiscreen-design.md` (Rust party host, WebRTC fast path, Rust
TV rendering) and the Node host of `docs/party-design.md` (§2 B, §4, §7,
§9). The wire protocol between phones and the game
(`docs/party-protocol.md`) stays.

Contents: 1. decisions, 2. the pieces, 3. the bundle, 4. listeners and
URLs, 5. the local API, 6. the relay, 7. the launcher, 8. the game
library, 9. casting, 10. lifecycle, 11. tunnels, 12. security, 13.
tests, 14. what goes, 15. plan, 16. as built, 17. surfaces: canvases
beamed without a second browser, 18. remote games.

## 1. Decisions (the owner's, final)

- A game is a **web app**: static files that run in browsers. No Node,
  no Rust game logic. tvpipe serves it: `tvpipe game play ./game` or
  `tvpipe game play ./game.zip`.
- The game's **host page** runs the game logic, in a visible browser
  window on the computer (an app window of tvpipe's own Chrome). Before
  it, a **launcher** in the same window picks the TVs (tvpipe's standard
  one, or the game's own on the same API).
- The **TV page** renders in a **headless** browser tvpipe starts on the
  same computer; tvpipe casts that tab (picture and sound) to the chosen
  AirPlay/Cast receivers: the `share URL` machinery, unchanged.
- **Phones** load the phone page through a tunnel (or the LAN); their
  WebSockets end in tvpipe, which **relays** them to the host page.
  tvpipe knows connections, bytes, limits and access rules; rooms,
  players, keys, views and actions live once, in the browser library
  `@tvpipe/party`, in the host page.
- Closing the window (or Ctrl-C) ends everything: the casts (TEARDOWN),
  the headless browser, the tunnel; phones are told the room closed.

## 2. The pieces

```
 ┌──────────── this computer ───────────────────────────────────────────┐
 │  app window (tvpipe's Chrome, visible)     headless Chrome           │
 │  ┌──────────────────────────┐              ┌──────────────────┐      │
 │  │ launcher → host page     │              │ TV page (screen) │──┐   │
 │  │ game logic, @tvpipe/party│              └───────┬──────────┘  │   │
 │  └──────┬───────────────────┘                      │ /_tvpipe/ws │   │
 │         │ /_tvpipe/api (API + relay)               │             │   │
 │  ┌──────┴──────────────── tvpipe game play ────────┴───────────┐ │   │
 │  │ local listener 127.0.0.1:L   public listener 127.0.0.1:P    │ │   │
 │  │ bundle files, launcher, lib  bundle files, lib, /_tvpipe/ws │ │   │
 │  │ discovery, pairing, casting ◀── share session (capture.js) ◀┼─┘   │
 │  └──────────────────────────────────────▲────────┬─────────────┘     │
 └─────────────────────────────────────────┼────────┼───────────────────┘
                        tunnel (or LAN)    │        │ AirPlay / Cast
                                  phones ──┘        └──▶ TVs
```

| Piece | Where | Owns |
|---|---|---|
| `tvpipe game play` | `crates/tvpipe/src/playshare/` (feature `playshare`, reached by the CLI through `__cli`), `crates/tvpipe-cli` (arguments) | the bundle (folder or zip), two HTTP listeners, the local API, the relay, discovery and pairing for the launcher, the cast (a `share URL` session), the app window, the tunnel, teardown |
| `@tvpipe/party` | `npm/party/` (TypeScript, browser-first; tvpipe embeds the built JS and serves it at `/_tvpipe/lib/`) | the host (`Party`: rooms, players, keys, VIP, late join, actions exactly once, views and diffs, clock), the phone/TV client (`PartyClient`), the local API client (`Tvpipe`), test helpers |
| standard launcher | `npm/party/launcher/` (built into `crates/tvpipe/src/playshare/web/launcher/`) | device list, AirPlay PIN entry, a "browser tab" receiver for trying without a TV, start |
| the game | a folder or zip with `tvpipe.json` | host page (rules), TV page, phone page, assets; optionally its own launcher |

## 3. The bundle

A folder or a `.zip` (stored or deflate entries; hand-rolled reader with
CRC checks, `crates/tvpipe/src/util/zip.rs`, inflate in
`util/inflate.rs`, known-answer tests) with `tvpipe.json` at its root
(in a zip: at the root or inside one top-level folder, as zipping a
folder makes it):

```json
{
  "name": "drawbluff",
  "title": "Drawbluff",
  "root": "dist",
  "pages": {
    "host": "host/index.html",
    "tv": "screen/index.html",
    "phone": "phone/index.html",
    "launcher": null
  },
  "players": { "min": 3, "max": 50 },
  "tv": { "width": 1280, "height": 720 },
  "limits": { "message": 262144, "rate": 20, "burst": 50 }
}
```

| Field | | |
|---|---|---|
| `name` | required | `[a-z0-9-]{1,40}`: logs, the window's profile name |
| `title` | optional | the launcher's heading (default `name`) |
| `root` | optional | the served directory inside the bundle (default: where `tvpipe.json` is); lets a source folder point at its build output |
| `pages.host`, `pages.tv`, `pages.phone` | required | entry documents, paths relative to `root` |
| `pages.launcher` | optional | the game's own launcher (§7); default tvpipe's |
| `players.min`, `players.max` | optional | shown by the launcher, given to the host library; `max` (default 8, at most 1000) sizes the relay's connection limit |
| `tv.width`, `tv.height` | optional | the TV page's viewport, its layout size in CSS pixels (default: the receivers' shape, at most 1920x1080, as `share URL`) |
| `tv.resolution` | optional | `"choice"` (default): people choose the TV picture's resolution, tvpipe renders the layout at it (§9.1); `"fixed"`: exactly `tv.width`×`tv.height` (needs both) |
| `limits` | optional | the relay's per-connection limits (§6.3); bounded by tvpipe's maxima |

Unknown fields are ignored (forward compatibility); a missing or wrong
required field is an error naming the field. Paths are normalized: no
`..`, no absolute paths, no backslashes, no hidden (`.`) segments, and
files are read only below `root` (a folder's symlinks that leave `root`
are refused). A zip is read into memory once (at most 256 MiB unpacked,
at most 10 000 entries, every entry's CRC-32 checked; zip64, encryption
and other methods are refused with a clear error); a folder is read from
disk per request, so editing a game needs only a reload of the page.

## 4. Listeners and URLs

Two `net::httpd` servers, so the public side cannot reach the API even
by mistake:

| | Local listener `127.0.0.1:L` | Public listener `127.0.0.1:P` (+ LAN `IP:P'` with `--lan`) |
|---|---|---|
| Who | the app window, the headless TV page | phones (through the tunnel or the LAN), this computer for tests |
| `Host` | `127.0.0.1:L`, `localhost:L`, `[::1]:L` (421 otherwise) | the tunnel's name, loopback names with `P`; the LAN listener exactly `IP:P'` |
| `/` | redirect to the launcher | redirect to the phone page, the query kept plus the game's tag (`/?r=CODE` → `/phone/index.html?r=CODE&g=RUN.GEN`; browsers keep the `#k=` fragment across the redirect; `g`: docs/game-switching.md) |
| bundle files | yes | yes (everything in a bundle is public: it is a web app; secrets do not belong in it) |
| `/_tvpipe/lib/*.js` | the library | the library (the client side is what phones use) |
| `/_tvpipe/ui.css`, `/_tvpipe/fonts/*.woff2` | tvpipe's look (the launcher, error pages, host pages that want it; the fonts are the browser player's) | the same |
| `/_tvpipe/ws` | relayed WebSocket (the TV page) | relayed WebSocket (phones) |
| `/_tvpipe/start?t=TOKEN` | sets the session cookie, redirects to the launcher | — (404) |
| `/_tvpipe/launcher/` | the standard launcher | — |
| `/_tvpipe/picker/`, `/_tvpipe/api/catalog`, `/_tvpipe/api/game` | the games list and its API (token; docs/game-switching.md) | — |
| `/_tvpipe/wait/`, `/_tvpipe/game` | the same | `/` goes to the wait page while no game is picked; `/_tvpipe/game` says whether one is (`{game}`) |
| `/_tvpipe/api` | the API WebSocket (token) | — |

Static files: GET/HEAD, a fixed MIME table, `Content-Length`,
`nosniff`, `Cache-Control: no-cache` with an ETag, `Referrer-Policy:
no-referrer`; HTML gets no CSP from tvpipe (the game's pages are the
game's: a game sets its own with `<meta http-equiv>`), except
`frame-ancestors` on the public and LAN listeners: every answer there
carries `Content-Security-Policy: frame-ancestors 'self'
https://tvpipe.party` (the frame page's origin, docs/short-links.md;
only `'self'` when short links are off), so no other site can frame
the phones' pages. `/_tvpipe/` is
reserved: a bundle's own `_tvpipe/` directory is never served.

## 5. The local API

**Auth.** tvpipe makes a 128-bit token per run. The window opens
`http://127.0.0.1:L/_tvpipe/start?t=TOKEN`, which answers with an
`HttpOnly; SameSite=Strict; Path=/` cookie `tvpipe=TOKEN` and a redirect
to the launcher, so the launcher and the host page (same origin,
navigations, reloads) carry it without handling it. Programs without a
cookie jar (tests, a host in Node) pass `?t=TOKEN` on the WebSocket URL.
The API WebSocket needs the token and, from browsers, `Origin`
`http://127.0.0.1:L` (403: cross-site WebSocket hijacking); compared in
constant time.

**Transport.** One WebSocket, `/_tvpipe/api`. Text messages are JSON:

- calls: `{"t":"call","n":7,"method":"cast.start","params":{…}}` →
  `{"t":"reply","n":7,"ok":true,"value":…}` or
  `{"t":"reply","n":7,"ok":false,"error":{"code":"…","message":"…"}}`;
- events from tvpipe: `{"t":"event","type":"devices","data":…}`;
- relay control (§6), on a socket that attached the relay.

Binary messages are relay data (§6). Unknown `t`, methods and fields:
ignored, or `unknown-method`.

| Method | Params → value | |
|---|---|---|
| `info` | → `{name, title, players, pages, tv, phone: {url, mode, lan, frame}, tunnel, version, launcher, resolutions, dev, room: {code, key}, game}` | `no-game` before a game is picked; `room`: the run's room code and join key, the same for every game (docs/game-switching.md); `game`: the run's games counted; `phone.url`: the base phones use (`https://HOST/`, `http://IP:P'/` or `http://127.0.0.1:P/`), `mode` `tunnel`/`lan`/`local`; `phone.frame`: the frame page phones open the tunnel's join link in (`https://tvpipe.party/p`, docs/short-links.md; absent with `--no-short-link`/`TVPIPE_PARTY_URL=off`); `dev`: test mode (`--dev`), the game's test tools (docs/games.md) |
| `devices.watch` | `{on: bool}` → the current list | discovery runs while any socket watches; `devices` events with the whole list when it changes |
| `select` / `selection` | `{devices: [name], resolution?}` → `{devices, resolution}` | the launcher's (or the cast picker's) choice, kept by tvpipe for the host page (a navigation away); `resolution` `auto`, `720p`, `1080p`, `2160p` (§9.1; absent: unchanged, default `auto`; `null` in the answer when `tv.resolution` is fixed) |
| `pair.start` | `{device}` → `{}` | AirPlay PIN pairing; `pair` events `{device, state: connecting\|pin\|done\|failed, error?}` |
| `pair.pin` | `{device, pin}` | the PIN the TV shows |
| `pair.cancel` | `{device}` | |
| `cast.start` | `{page, to?, resolution?}` → `{}` | `page`: a path on the local origin with its fragment (the TV page and its screen key); `to`: device names (default: the selection), `"browser"` for a tab on this computer; `resolution` (default: the selection's; ignored when fixed). Replaces a running cast (the TVs restart the picture), except for the same TVs and picture while it runs: then the page goes into the running tab and the receivers keep their sessions (docs/game-switching.md). `cast` events `{state: starting\|streaming\|failed\|stopped, receivers: [{name, protocol?, state, delayMs?, error?, code?}], player?, resolution?, error?}` (`delayMs`: the receiver's playout delay once connected, which the library's `tvDelay` follows: docs/party-design.md §8.1) |
| `cast.stop` | | the TVs get TEARDOWN; the headless browser quits |
| `tvsync.set` | `{device, displayMs}` → `{device, displayMs?}` | a TV's display lag as matched in the launcher's Sync (0–2000 ms; `null` forgets it), kept in the storage (`tv-lag`); devices and statuses carry it as `displayMs` (docs/party-design.md §8.1) |
| `qr` | `{text}` → `{size, rows}` | tvpipe's QR encoder (`util::qr`): `rows` of `"0"`/`"1"` |
| `relay.attach` | `{}` → `{public, local}` | this socket becomes the relay host (§6); a newer attach replaces it; `no-game` before a game is picked |
| `shortlink` | `{url, code}` → `{url, code}` | a short link (`https://tvpipe.party/BCDF`) for the tunnel's join link `url` (only `https://TUNNEL-HOST/…`: else `bad-url`), `code` the room code to propose; `unavailable` without a tunnel, with `--no-short-link`/`TVPIPE_PARTY_URL=off` or when the service fails. One registration per run (the same url: no request), refreshed every 6 h, deleted at the end: [`short-links.md`](short-links.md) |
| `quit` | | ends playshare (§10) |

Events also include `tunnel` (`{state: up|reconnecting, url}`),
`closing` (tvpipe is ending: the host has 1 s to say goodbye) and `game`
(`{name, title, url}`: another game is in the slot, the pages go to
`url`; docs/game-switching.md).

## 6. The relay

### 6.1 Connections

A client WebSocket to `/_tvpipe/ws` (any query; tvpipe passes it on) is
accepted when a host is attached (else `503`), the `Host`/`Origin`
rules pass (§4; `Origin` must be the listener's own origin: `https://`
the tunnel's name, `http://IP:P'`, or the loopback origins), and the
connection limit is not reached. It gets a number (`u32`, never reused
in a run). tvpipe tells the host, on the API socket:

```json
{"t":"open","conn":12,"via":"public","addr":"203.0.113.9","query":"r=BCDF","agent":"Mozilla/5.0 …"}
```

`via`: `public` (tunnel or loopback on the public listener), `lan`,
`local` (the local listener: the TV page, or the host window's own
previews). `addr`: Cloudflare's `cf-connecting-ip`, OpenTunnel's peer,
or the socket's address.

### 6.2 Frames on the API socket

Data both ways is **binary**: `u8 op | u32be conn | payload`.

| op | tvpipe → host | host → tvpipe |
|---|---|---|
| 1 | the client sent a text message (UTF-8 payload) | send a text message to the client |
| 2 | the client sent a binary message | send a binary message |

Control is **text** JSON:

| `t` | Direction | Fields |
|---|---|---|
| `open` | → host | above |
| `close` | → host | `conn`, `code`, `reason`: the client's socket ended (its close frame's, or 1006) |
| `busy` / `drain` | → host | `conn`: more than 64 KiB wait to be written to this client / back under it |
| `close` | host → | `conn`, `code` (1000, 3000–4999), `reason` (≤ 120 bytes): tvpipe sends what is queued, then the close frame |

Order is kept: everything about one connection arrives in the order it
happened, and data the host sends before a `close` is written first.

### 6.3 Limits (generic, in tvpipe)

| | Default | Manifest | On breach |
|---|---|---|---|
| Message size from a client | 256 KiB | `limits.message` (≤ 1 MiB) | close 1009 |
| Messages per client | 20/s, 50 at once (token bucket) | `limits.rate`, `limits.burst` (≤ 200/s) | close 4008 |
| Connections | 2 × `players.max` + 16, at least 64 | via `players.max` | `503` at the upgrade |
| Upgrades per address | 60 a minute | — | `429` |
| Queued to one client | 1 MiB | — | close 4013 (the client reconnects) |
| Liveness | ping every 15 s | — | closed after 45 s of silence |
| First message | within 10 s of the upgrade | — | close 4002 |

The host library keeps the protocol's own rules on top (the `hello`
within 5 s, failed-`hello` throttling per address, 16 KiB for messages
other than `act`, …): tvpipe's limits are the outer bound that holds
even when a host page is slow or buggy.

### 6.4 Host changes and ending

- The host socket closing (a reload, a navigation, a crash) closes every
  client with **1012** (service restart): clients reconnect, and get
  `503` until a host attaches again. The room code and join key are the
  run's (`info.room`), so a host that loses its state on a reload has
  the same room: a phone's old token means nothing to it, and the phone
  comes back in by its name, as a new player.
- Another game in the slot (docs/game-switching.md) closes every client
  with **4014** "next game": phones go to their join link, which is the
  next game's phone page. A relay connection whose `?g=` (the
  `tvpipe-game` cookie of its page) is not the current game's is closed
  with 4014 at once.
- A second `relay.attach` replaces the first (the old socket gets
  `{"t":"event","type":"detached"}` and is closed).
- At the end (§10) tvpipe sends `closing`, waits up to 1 s (the library
  sends every client `bye room-closed`), then closes every client with
  **4011** "closed": the code the client already treats as final, so
  phones show "the room closed" even when the window is gone.

## 7. The launcher

The window first shows **tvpipe's standard launcher**
(`/_tvpipe/launcher/`) unless `pages.launcher` names the game's own:

- the game's title and player counts (`info`),
- receivers as they are found (`devices.watch`), each with its kind
  (AirPlay, Cast, both), "pair" for AirPlay receivers that show a PIN and
  are not paired (`pair.start`, a PIN field, `pair.pin`), and
  **"A browser tab on this computer"** (`browser`) for trying without a TV,
- the picture's resolution (Auto, 720p, 1080p, 4K; §9.1) unless the game's
  `tv.resolution` is fixed,
- **Sync** per TV: moving this page's flashes until they come with the
  TV's (the page `/_tvpipe/tvsync/`, cast to it meanwhile) measures how far it is
  behind a phone, kept per TV (`tvsync.set`; docs/party-design.md §8.1),
- multi-select, then **Start**: the chosen AirPlay TVs that need pairing
  are paired first, one after another (the PIN dialog; a cancel or a
  failure stays in the launcher), then `select`, then
  `location.assign(pages.host)`.

The contract for a game's own launcher (any page of the bundle, with
`@tvpipe/party`'s `Tvpipe` client): it may call any API method; it ends
with `select({devices})` and a navigation to the host page. The host
page casts (`party.cast()`, §8), because only the host knows the TV
page's screen key. A launcher may also skip TVs (an empty selection:
the TV page is opened in a tab or on an HDMI screen by hand, the host
shows its link).

### 7.1 The cast picker: other TVs while the game runs

`tvpipe.showCastPicker()` (or `party.changeCast()`, which also casts)
opens the launcher again, with `?mode=change`, in a modal `<dialog>`
with an `<iframe>` over the host page: the game's own launcher if
`pages.launcher` names one, else tvpipe's. The host page stays (a
navigation would end the relay and send the phones back); the picker
has its own API socket (same origin, the session cookie).

In change mode the launcher shows the chosen TVs ticked and the chosen
resolution, pairing works as before, and its buttons are **Apply** and
**Cancel** (also Escape). Apply saves the choice (`select`, which may
leave no TV) and posts `{type: "tvpipe:cast-picker", selection}` to the
parent (`PICKER_MESSAGE`, same origin only); Cancel posts `selection:
null`. The page then casts again: `cast.start` replaces the running
cast, so every TV restarts its picture (a gap of a second or two; adding
a TV without the others restarting is a later step); the same TVs and
resolution only load the TV page again in the running tab. No TVs: the page
stops the cast. A game's own launcher implements the same contract when
it sees `?mode=change`.

## 8. The game library (`@tvpipe/party`)

TypeScript (erasable syntax only), compiled with `tsc` to ES modules;
the npm package ships `dist/` with types; `npm run build` also writes
the browser copy tvpipe embeds (`crates/tvpipe/src/playshare/web/`,
checked in, checked by CI to be up to date). Browser APIs only
(`WebSocket`, `crypto.getRandomValues`, `TextEncoder`, `Intl`,
`queueMicrotask`), so the same code runs in Node for tests.

### 8.1 Host side

```ts
import { Tvpipe, PartyError } from "/_tvpipe/lib/index.js";

const tvpipe = await Tvpipe.connect();                 // the API socket (cookie)
const party = await tvpipe.party({ maxPlayers: 50 });   // attaches the relay; links and QR
await party.cast();                                     // the TV page on the selected TVs
party.screen.set({ phase: "lobby" });
party.handle("start", (data, from) => { … });
const answers = await party.collect("answer", { until: party.now() + 60_000 });
```

`Party` keeps the Node host's API (`room`, `screen`, `player.state`
StateBoxes; `handle`, `collect`, `send`, `broadcast`, `players`, `vip`,
`lock`/`unlock`, `kick`, `makeVip`, `close`, `inProgress`, `lateJoin`, `activate`,
`moderate`, `now`, `stats`, `screenView()`, events `join`, `reconnect`,
`away`, `leave`, `vip`, `active`, `screen`, `screen-view`, `input`) with
the transport replaced: it takes connections from a `Relay` (tvpipe's,
or `memoryRelay()` in tests) instead of a Node server. `party.links`:
`join` (public, in the QR code: with a tunnel the frame page's link,
`https://tvpipe.party/p#c=…&r=…&k=…`, docs/short-links.md), `tv` (the local TV page with the screen
key), `watch` (a read-only screen, local: the host page may show it in
an `<iframe>` as a preview). `party.cast(to?)`, `party.stopCast()`;
`party.joinInfo` gets the QR rows from tvpipe's `qr` and, with a tunnel,
the short link from `shortlink` for the tunnel's own join link
(`joinInfo.short`, docs/short-links.md; `joinText()` is what pages
show).

### 8.2 Client side

`PartyClient` (`/_tvpipe/lib/client.js`) is the existing browser client
ported to TypeScript without the WebRTC upgrade: `fromLocation()`,
`join(name)`, `connect()`, `act()`, `input()`, `on("view" | "msg" |
"status" | "bye" | "welcome")`, `now()`, `leave()`, `qrSvg()`,
`drawQr()`, `memoryStorage()`. Its default socket is
`/_tvpipe/ws` on the page's origin. Close codes it treats as final
without a `bye` (tvpipe's own closes): 4008, 4011, 1009. The protocol
(`docs/party-protocol.md`) is unchanged except: §9 (WebRTC) is gone,
the transport section names the relay, and the hosts table has one host.
In a page another site frames (the frame page, docs/short-links.md) it
tells the frame page the page's title and `theme-color`
(`announceToFrame`).

### 8.2a Web mode

The same library runs without tvpipe on tvpipe.party
([browser-party-design.md](browser-party-design.md)): its copy's
`mode.js` says `WEB = true`, `Tvpipe` then talks to `WebHub` in the page
instead of the API socket (`TvpipeTransport`: tvpipe's socket or the
hub), `relay()` is a `WebRtcRelay` (WebRTC data channels and a local
`BroadcastChannel`, the limits of §6.3 at 64 KiB), and `PartyClient`
connects with a `DataChannelSocket`. QR codes are made in the page
(`qr.ts`, the same symbols as `util::qr`).

### 8.3 `Tvpipe` (the API client)

`Tvpipe.connect({url?, token?})`, `info()`, `devices(on)` + the
`devices` event, `select(devices, {resolution?})`, `selection()` (the
TVs), `chosen()` (TVs and resolution), `pair(device)` (an object
with `state`, `submit(pin)`, `cancel()`), `cast({page, to, resolution})`,
`stopCast()`, `showCastPicker()` (§7.1), `showPairing(device)` (a PIN
dialog over the page: `pair.start`, the `pair` events, `pair.pin`;
`true` once paired), `qr(text)`, `quit()`, `relay()`
(attaches; returns the `Relay`), events `devices`, `pair`, `cast`,
`tunnel`, `closing`. `HostedParty.changeCast()`: the picker, then
`cast()` (or `stopCast()` without TVs).

Pairing on demand: a TV the launcher could not know needs pairing (its
flags say no PIN, or it forgot a pairing tvpipe kept) fails the cast
with the receiver's `code: "pairing-required"`. `HostedParty` pairs it
(`showPairing`, or the `pair` option of `tvpipe.party()`; `false`: off)
and casts the same page again: once per TV and `cast()` call, and only
its own casts (the cast whose `starting` event, which names the TVs,
came while its `cast.start` call ran; not the launcher's sync page).
Surfaces (§17) are the game's to restart: `needsPairing(status)` names
the TVs of a `surface` status that need pairing.

## 9. Casting

`cast.start` runs `tvpipe::share(Some(url), options)` with the
receivers: the session's own headless browser (Chrome, else Firefox;
`share URL`'s discovery), viewport from `tv` or the receivers' shape,
`capture.js` after every navigation, the crash restart and profile
sweep, the TVs' reconnect window. The URL must be on the local origin
(no other page can be cast through the API). The TV page reaches the
host through `/_tvpipe/ws` like any client (`via: local`). A cast that
fails (every receiver gone) is reported (`cast` event `failed`); the
host decides whether to retry (the library offers `party.cast()` again,
Drawbluff shows the error and a button). `browser` casts to the player
page (`--to browser`): the event's `player` is its URL.

### 9.1 Resolution

The TV page has a **layout** and the cast a **resolution**, and they are
independent: the layout is the page's viewport in CSS pixels (`tv`, else
the receivers' screen shape within 1920x1080), the resolution is how many
pixels the TVs get (Auto, 720p, 1080p, 4K: the boxes 1920x1080 (Auto's
most), 1280x720, 1920x1080, 3840x2160). tvpipe's browser renders the
layout at the **device scale factor** `s` that fits it into the box, so
the page looks the same at every resolution, only sharper: a 1280x720
layout is drawn at 1.5x for 1080p and 3x for 4K (`devicePixelRatio` is
`s`; pages that draw canvases should size their backing store with it).
Smaller boxes scale down (a 1920x1080 layout at 720p is `s` = 0.667).

1. The offer is the box (Cast: its first `resolutions` entry, with
   1920x1080 and 1280x720 below it); AirPlay plans up to the canvas, or
   with an explicit 1080p or 4K up to its decoder maximum
   (`widthPixelsMax`, docs/airplay-mirroring.md §2.6).
2. The receivers answer; the frame is the receivers' shape around the
   layout at `s`, shrunk to their limits (size, frame rate, bitrate, a
   Cast ANSWER's `maxPixelsPerSecond`; an ANSWER without constraints
   under an offer above 1080p counts as openscreen's defaults, 1080p30 at
   10 Mbit/s).
3. The effective scale is the layout's fit into that frame (rounded down
   to 1/10000) and the browser starts with it: Chrome's
   `--force-device-scale-factor=s` and a headless screen of exactly the
   layout × `s` device pixels (`--screen-info`). A larger screen would let
   Chrome raise the captured tab's scale by itself once the capture runs
   (up to 2x, the page's `devicePixelRatio` changing under it); a smaller
   one clamps the capture. `Emulation.setDeviceMetricsOverride` and
   `--screen-info`'s `devicePixelRatio` are not used: the capture does not
   follow the first, the second takes integers only.
4. The page's H.264 level follows the frame (`capture.js`: 4.0/4.2 for
   1080p at 30/60 fps, 5.1/5.2 for 4K).

**Auto** is up to 1080p within the receivers' limits: 4K costs the
computer about nine times the rendering of 720p and only happens when
chosen. A different resolution is a new cast (the TVs restart the
picture). `tv.resolution: "fixed"` keeps the old behaviour: the page is
exactly `tv` at scale 1 and the stream that size (shrunk, with the
layout, when a receiver cannot take it). `share URL --resolution` and
`--size` (the layout) are the same machinery outside games; the SDK's
`Options::resolution`.

Firefox renders at scale 1 (tvpipe warns): whether its tab capture
follows a BiDi device pixel ratio is not verified.

**Verified** (Chrome 157, macOS, M5 Max, 2026-11): a 1280x720 layout at
`s` = 1.5 and 3 captures exactly 1920x1080 and 3840x2160 (also 1.35 for
1280x800, 0.667 down); the hardware H.264 encoder keeps up at 4K30 and
4K60 (about 17 ms per frame, no drops, Chrome at about a third of a core
with a canvas animation redrawn every frame); the opt-in test
`chrome_browser_4k_to_cast` sends 3840x2160 at level 5.1 to the fake
Cast receiver. **Not verified on hardware:** whether an Apple TV shows a
4K (or 1080p above its 1280x720 canvas) H.264 stream at full resolution
(Apple's own senders seem to send 4K as HEVC); what a real Google TV or
Chromecast ANSWERs to a 4K offer (openscreen's defaults are 1080p30);
software encoding (no hardware encoder) at 4K; AirPlay at 4K with
its 25 Mbit/s ceiling (docs/airplay-mirroring.md §2.6).

## 10. Lifecycle

1. `tvpipe game play PATH [--lan [IP]] [--tunnel[=PROVIDER] | --no-tunnel] [--window app|open|none] [--browser PATH] [--port L]`:
   load and check the bundle (errors before anything starts), bind the
   listeners, start the tunnel (§11) in the background, open the
   window.
2. The window: tvpipe's Chromium-based browser (the discovery of
   `share URL`) with a temporary profile (swept like `share URL`'s),
   `--app=URL` (no tabs, no toolbar), 1100x760, over DevTools. Without
   one: `--window open` uses the system's opener (`platform::open_url`),
   `none` prints the URL (tests, a browser of one's choice).
3. The launcher, then the host page (§7, §8).
4. **End** on any of: the app window closed (no page target left, or
   the browser exited), `quit`, Ctrl-C/SIGTERM, `q` (asked again
   while phones play); with
   `open`/`none`, no API socket for 30 s after one was seen. Then:
   `closing` to the host (1 s), clients closed 4011, the cast stopped
   (TEARDOWN/STOP to every TV), the headless and the window browsers
   quit (profiles removed), the tunnel dropped, exit 0 (130 on a signal).
5. The tunnel reconnects by itself (same host); a tunnel that cannot
   start leaves phones on the LAN link if `--lan`, else on this
   computer only, with a warning in the launcher (`info.phone.mode`).

## 11. Tunnels

playshare starts often, so its default must not burn Cloudflare quick
tunnels (about 29 per address in 90 minutes, each a new hostname):

- **Default `--tunnel=auto`: OpenTunnel first.** Its identity is made
  once and kept in the config directory (`opentunnel/`); later runs
  attach in ~0.3 s with no creation at all (only a new random route).
  If OpenTunnel fails, Cloudflare. `--tunnel=cloudflare` asks for a
  quick tunnel explicitly.
- **Reusing quick-tunnel credentials** works: a quick tunnel outlives
  its connector (measured 2026-11-19: the same credentials registered
  again after 120 s and the same hostname served at once,
  `cftunnel::tests::live_quick_tunnel_reuse`). So when playshare uses
  Cloudflare it keeps the last quick tunnel's credentials in the config
  directory (`cloudflare-quick-tunnel.json`, 0600: the tunnel secret)
  and tries them first (`cftunnel::Tunnel::start_reusing`: register and
  resolve within 10 s, else a new quick tunnel, whose credentials replace
  them). A run on reused credentials is up in under a second instead of
  6–7 s. How long Cloudflare keeps an idle quick tunnel is not known; a
  deleted one costs 10 s before the new one. The same hostname across
  runs is harmless: every run has a new room code and join key, so an old
  QR code leads nowhere.
- `--lan [IP]`: phones on the same Wi-Fi over `http://IP:PORT` (no
  internet needed; the key crosses the Wi-Fi in clear: party-protocol
  security notes); `--no-tunnel`: this computer only.

## 12. Security

- The **API** is local only (a listener of its own on 127.0.0.1), needs
  the per-run token (cookie or `?t=`), and from browsers the local
  origin. The token never reaches the public listener, the TV's page or
  any log at the default level.
- **DNS rebinding**: `Host` checked on both listeners (421). **CSWSH**:
  `Origin` checked on every WebSocket (403). **Framing**: only the
  frame page's origin may frame the phones' pages (`frame-ancestors`,
  §4).
- **Relay**: tvpipe forwards bytes and enforces limits (§6.3); it never
  parses what clients send. Keys, names and actions are checked by the
  host library as before (party-design §6): 128-bit keys in URL
  fragments, constant-time comparison, name cleaning, the `moderate`
  hook, text rendered as text.
- **Casting** only pages of the local origin.
- **Bundle**: paths normalized, nothing outside `root`, zip bombs bounded
  (size, entries, ratio checked as it inflates), CRCs checked.
- **The window's browser** has its own temporary profile: no cookies or
  extensions of the user's browser, nothing of the game kept. Pages the
  window's pages open (targets with an opener: `target="_blank"`,
  `window.open`) go to the system's browser (`platform::open_url`, http
  and https only) and are closed in tvpipe's; targets without an opener
  (what macOS routes to tvpipe's browser, docs/cross-platform.md) stay,
  so nothing loops back.
- **What is public**: every file of the bundle (phones need them; the
  host page is code, not a secret) and the relay socket. A stranger with
  the tunnel's hostname can load pages but not join without the join key.

## 13. Tests

- Rust (`cargo test`): manifest parsing and errors; zip reading
  (stored, deflate fixtures from Python's `zipfile`, a top-level folder,
  traversal names, CRC mismatch, a bomb); inflate known answers (fixed,
  dynamic, stored blocks; zlib's test vectors); the listeners' Host,
  Origin, token and cookie rules; static serving; the relay with fake
  clients and a fake host over real sockets (open, data both ways,
  close codes, busy/drain, limits, host replaced, 1012, 4011 at the end);
  the API with a fake cast/discovery backend; the CLI's arguments.
  Opt-in (`TVPIPE_TEST_CHROME=1`): a real headless cast of a bundle's TV
  page to the fake Cast receiver, frames counted.
- `npm/party` (`node --test`): the host with `memoryRelay()` and the
  client (joins, resumes, replays, diffs, collect, late join: the old
  Node tests moved over), the API client against a fake, the session
  vectors replayed by the browser host; and, when a tvpipe binary is
  built, an end-to-end test: Node as the host page (`?t=`), fake phones
  over the public listener.
- drawbluff: the rule vectors and game tests unchanged in substance,
  run with `memoryRelay()` and fake phones; a live script
  (`test/live/play.ts`): `tvpipe game play --window none`, the
  launcher and the host page in headless Chrome over DevTools, the
  `browser` receiver, bots as phones, screenshots of the launcher,
  lobby and a round; the same from the zip.

## 14. What goes

- `crates/tvpipe-party` (host, WebRTC fast path, examples): the relay
  needs only tvpipe's `httpd`/`websocket`, now used inside the crate;
  `tvpipe::__web` goes with it.
- `crates/tvpipe-canvas` and the Rust Drawbluff (`games/drawbluff/src`,
  `tests`, `Cargo.toml`): no Rust game logic or TV rendering.
- The Node host of `@tvpipe/party` (`server.ts`, `ws.ts`, `create.ts`,
  `toTv`, the video screen) and Drawbluff's `main.ts`,
  `screen-video.ts` (`@napi-rs/canvas`).
- `docs/multiscreen-design.md` (replaced by this document); the parts of
  `docs/party-design.md` about the Node host are marked historical.
- Kept: `@tvpipe/sdk`, the `tvpipe` library and CLI (`tunnel PORT`, `qr`; now
  `debug tunnel`, `debug qr`) stay, the party protocol and the phone/TV pages.

## 15. Plan

1. This document.
2. Rust: bundle + zip + inflate, the listeners, the API, the relay,
   casting through `share`, the window, the CLI; tests.
3. `@tvpipe/party` in the browser: host, client, API client, test
   relay, the standard launcher; the build into the crate.
4. Drawbluff as a bundle (host page with `game/*.ts`, TV and phone pages
   as they are), tests, the live check, a zip.
5. Deletions, README, ARCHITECTURE, AGENTS, the manual's text, CI.

## 16. As built

- **Rust** (`crates/tvpipe/src/playshare/`, feature `playshare`, the CLI
  through `__cli::playshare`): `bundle` (manifest, folder, zip), `server`
  (the listeners), `hub` (API, relay, progress), `conn` (a WebSocket with
  an outbox: `busy`/`drain`, the backlog limit, pings), `backend`
  (discovery, pairing, cast: fakes in tests), `window`, `web` (the
  embedded library and launcher; `TVPIPE_PLAYSHARE_WEB=DIR` serves them
  from a directory). The API calls a game's code makes are as in §5.
- **The window**: Chromium-based browsers get the app window. Firefox has
  no app windows: with only Firefox installed, `--window app` opens the
  system's browser (`open`), and the end follows the pages' sockets.
  `--window headless` exists for tests.
- **The library** is TypeScript compiled by `tsc` (erasable syntax, ES
  modules with `.js` imports); `npm run build` writes `dist/` and copies
  the browser files into the crate (`scripts/web.ts`; `--check` in
  `npm run check`). The session vectors moved to `npm/party/test/vectors/`.
- **Drawbluff**: `tvpipe.json` at the game's folder with `root: dist`;
  `npm run build` compiles `game/` and `host/` and rewrites the library
  imports to `/_tvpipe/lib/`; `npm run zip` writes `drawbluff.zip`
  (first `scripts/zip.ts`, deflate through Node's zlib; now `tvpipe game
  pack`, §18). The host page shows
  the room, the TVs (with "try again"), the players (remove; bots,
  for tests, only with `?bots` or `--dev`), the
  rounds, timers and late joining, and a muted preview of the TV (the
  watch link in an `<iframe>`).
- **Checked** (2026-11-19, macOS 26, Chrome 157): `node
  test/live/play.ts` (and `--zip`, and `--tunnel=opentunnel`): the
  launcher and the host page in headless Chrome, a phone in headless
  Chrome (joining through the phones' listener, drawing with touch,
  lying, voting), bots, the TV through tvpipe's own headless Chrome and
  the `browser` receiver, a whole game, the End button: tvpipe exits 0,
  every phone says the room closed. The opt-in Rust test with a real
  Chrome casts the TV page to the fake Cast receiver and notices the
  window closing.
- **Not yet**: a real TV (Apple TV, Chromecast) and a real phone; LAN
  mode with a phone; a game's own launcher (only the contract and the
  standard one); the host page keeping its state across a reload
  (`sessionStorage`), so a reload sends phones back to their name entry.

## 17. Surfaces: canvases beamed without a second browser

The TV page of §9 needs a second, headless browser that renders the page
and captures its tab. A **surface** skips it: the game draws its TV
picture into a canvas (2D, WebGL, an `OffscreenCanvas` in a worker), the
library encodes it with WebCodecs in the page, and tvpipe streams the
H.264 and PCM on the path a program's own H.264 takes
([`Stream`](../crates/tvpipe/src/api/stream.rs), `docs/slrw.md`) to
AirPlay, Cast or the `browser` player. Each surface is its own session,
so two canvases can go to two TVs: one game, different pictures per
screen.

### 17.1 How it works

```
page (window or worker)                      tvpipe
 canvas ─ new VideoFrame(canvas) ─ VideoEncoder ─┐
 Web Audio node ─ AudioWorklet ─ s16 PCM ────────┤ SLRW records over
                                                 │ ws /_tvpipe/surface?id=N
            {"t":"keyframe"} / status / stats ◀──┤ (token, local origin)
                                                 ▼
                         surface.rs: onto the Stream's clock ─ Stream (H.264 in)
                                                 ─▶ AirPlay / Cast / browser
```

- **API** (§5): `surface.open {width, height, fps, to?, audio?, bitrate?}`
  starts a `Stream` (`Options::h264(w, h, fps)`, PCM 48 kHz stereo with
  `audio`) to `to` (default: the launcher's choice) and answers `{id, path}`;
  `surface.close {id}`; `surface` events with each surface's state and
  receivers (as `cast`). At most 8 at once; all stop at the end (§10).
- **Socket** `/_tvpipe/surface?id=N` (local listener, the API token: the
  window's cookie also reaches workers): binary messages are SLRW
  records (`u8 kind | u64le pts_us | u32le len | payload`: 4 config,
  3 H.264 with flags, 2 PCM), `pts_us` the page's wall clock
  (`performance.timeOrigin + now()`); text `{"t":"log",codec,agent}`.
  tvpipe answers `{"t":"keyframe"}` (a receiver wants an IDR),
  `{"t":"status",…}` and once a second `{"t":"stats",fps,kbps,lagMs,lagMaxMs,dropped}`
  (`lagMs`: from the page's frame to tvpipe).
- **Clock**: tvpipe puts the first record at "now on the stream's clock,
  less its age" and keeps the others at their distance from it, so the
  page's frames are stamped as an in-process game stamps its own.
  PCM waits for the first queued frame (before it the stream is not
  open, and queued sound would be stale).
- **The library** (`npm/party/src/surface.ts`): `tvpipe.surface({canvas,
  fps, to, audio: {context, node}})` opens a surface and returns a
  `SurfaceEncoder`; the game calls `frame()` after drawing (paced down to
  the surface's rate at an even cadence, the capture script's pacer:
  `docs/share-protocol.md`, "Binary messages"), or `clock: "timer"`. `tvpipe.openSurface()` plus
  `new SurfaceEncoder(info, offscreenCanvas)` runs the encoder in a
  worker. H.264 Constrained Baseline at the smallest level that fits
  (then Main, High), `latencyMode: "realtime"`, hardware preferred, an
  IDR every 2 s and on request. Backpressure: a frame is skipped while
  the encoder holds more than 2 or the socket more than 4 MiB.
  `captureAudio(context, node)` taps a Web Audio node with an
  AudioWorklet (10 ms of s16 PCM per record, timed by its sample count).
- **Warm-up** (as `capture.js`, `docs/share-protocol.md`): a hardware
  encoder's first pictures come out most of a second after their frames
  (VideoToolbox in Chrome: ~0.9 s). A first keyframe that old anchored
  tvpipe's media clock that late, and since the clock keeps early frames'
  instants (up to 1 s, for ffmpeg's bursts) every later frame kept the
  delay: ~1 s of latency for the whole session until the encoder side
  dropped chunks until a keyframe at most 150 ms old.

### 17.2 Measured

A WebGL demo game written for the measurement (400 instanced
triangles on an animated shader field, a beep a second; every picture
carries the wall clock in ms as a row of blocks) and a script driving it. tvpipe game play
release build, the `browser` receiver, the player page in a second
headless Chrome reading the blocks back from its canvas: latency is
glass to glass on one machine including the player's 100 ms playout
delay; CPU from `ps` (user + system, 15 s; 100 % = one core). macOS
26.6 on Apple silicon, Chrome 157, Firefox 160, Safari 26.6,
2026-11-19.

| Run (1280x720@30 unless said) | Latency p50 / p95 | Frames at the player | CPU: tvpipe (+ its browser) | CPU: the window |
|---|---|---|---|---|
| tab capture (`share URL` of the same picture as a page) | 109–192 / 111–195 ms (4 runs) | 25–27/s | 24–32 % | 11–13 % |
| surface, drawn and encoded per `requestAnimationFrame` | 119–123 / 123–126 ms | 26–27/s | 1 % | 25–27 % |
| surface, a timer | 110–123 / 112–126 ms | 26/s | 1 % | 22–24 % |
| surface, an `OffscreenCanvas` in a worker | 120–130 / 124–133 ms | 25–26/s | 1 % | 16–19 % |
| surface 1920x1080@60 | 133–137 / 135–138 ms | 49–60/s | 1 % | 19–21 % |
| two surfaces to two receivers | 121 and 127 / 123 and 128 ms | 27 and 30/s | 1 % | 21–31 % |
| Firefox 160 (headless window, its own H.264 encoder) | 169–236 ms | 18/s (tvpipe: 12–23/s) | 0 % | 82 % (software WebGL) |
| Safari 26.6 (a window in the background) | 258 / 263 ms | 15.5/s (tvpipe: 15–19/s) | 1 % | 36 % |

From page to tvpipe a frame takes 6–11 ms (`lagMs`; Firefox 23 ms),
encoding 6–10 ms (VideoToolbox, `avc1.42E01F`/`42E02A` "hw" in all
three browsers). Every surface run had no frames dropped or skipped.

**A hidden window** (a real Chrome window, minimized; the page reports
`visibilityState: hidden`):

| Clock | With playshare's switches (`--disable-background-timer-throttling`, `--disable-renderer-backgrounding`, `--disable-backgrounding-occluded-windows`: our app window) | Without them (a user's browser, `--window open`) |
|---|---|---|
| `requestAnimationFrame` | 0 frames/s (stops) | 0 frames/s |
| a timer on the page | 20–26/s | 1/s |
| a worker (`OffscreenCanvas`, a timer there) | 26–28/s | 27–29/s |

### 17.3 HTML-in-Canvas: DOM TV pages as surfaces

Chrome 157 (stable since 2026-11-03, after an origin trial) draws HTML
into a canvas: `<canvas layoutsubtree content="drawable">` with
`drawable` children, `ctx.drawElementImage(element, …)` in the canvas's
`paint` event, `canvas.requestPaint()` for the next one. A same-origin
`<iframe drawable>` is drawn with its document (checked: the inner page's
pixels in the canvas). So a game's existing DOM TV page can become a
surface without changes: the host page puts the TV page in such an
iframe, draws it every frame and encodes the canvas. Drawbluff's host
page once did this (a "TV picture: drawn here" setting, since removed);
a whole game ran that way, every phase as with the tab. Limits:
Chromium only; painting stops while the window is hidden, like
`requestAnimationFrame` (the TV freezes, the game goes on); the TV page's
own sound stays in the window unless the game routes it into
`captureAudio`.

### 17.4 Result and recommendation

It holds up, and it is the better path for anything drawn in a canvas:

- **Cheaper**: no second browser. CPU for the same picture: the window
  ~20–27 % and tvpipe ~1 % against ~11 % and ~30 % (tvpipe's headless
  Chrome rendering, capturing and encoding): about half overall, and one
  process tree less to start, crash-restart and sweep.
- **As fast or faster**: 110–137 ms glass to glass against 109–192 ms
  (tab capture adds a frame of capture and a compositor round trip and
  varied more between runs). Keyframes come on request at once and the
  frame pacing is the game's own (the frame it drew is the frame sent).
- **Any WebCodecs browser** runs the encoder: Chrome, Firefox and Safari
  all streamed with hardware H.264. The window no longer needs Chrome's
  tab-capture switches or a Local Network Access grant, so `--window
  open` (the system's browser) is a first-class host.
- **Multi-screen for real**: one surface per TV, each its own session,
  different pictures; measured two at once at full rate.
- **The catch is visibility**: a surface drawn in `requestAnimationFrame`
  stops when the window is minimized or hidden. A worker with an
  `OffscreenCanvas` and a timer is unaffected in every case measured; a
  page timer is fine only in our own app window (its switches), and
  throttled to 1/s in an ordinary browser. The tab path (§9) does not
  care what the window does.

Recommendation, as implemented:

1. **Canvas games use surfaces** (`tvpipe.surface()`), drawn and encoded
   in a worker (`OffscreenCanvas`) so a hidden window does not matter;
   on the main thread only when the game accepts that (our app window
   with a timer works, `requestAnimationFrame` does not).
2. **DOM TV pages keep the tab path** (`party.cast()`) by default: it
   needs nothing from the window. HTML-in-Canvas is the opt-in for
   Chrome 157+ where one browser matters more than a minimized window
   (Drawbluff offers both).
3. **Multi-screen games** open a surface per screen (or mix: a surface
   for one TV, the tab path for another).
4. Sound: Web Audio routed through `captureAudio`; a DOM page's own
   `<audio>` is not captured on the surface path.

Not done yet: surfaces in the standard launcher's vocabulary (a game
asks for them in its host page); per-surface receiver choice in the
launcher (the API takes `to`, the launcher only has one selection);
real TVs (only the `browser` receiver was measured; AirPlay and Cast take
the same H.264 as from a native game); Safari and Firefox were checked
only with a window in the background (Safari) or headless (Firefox),
not hidden; HTML-in-Canvas in a worker (`captureElementImage`).

## 18. Remote games

`tvpipe game play` also takes a game from the internet. Games are not
shipped with tvpipe: each has its own releases, and tvpipe fetches,
caches and checks them.

**Sources** (`playshare/source.rs`), in this order:

| Form | Meaning |
|---|---|
| a path that exists | a folder or a `.zip`, as before (a local path always wins) |
| `https://…[#sha256=HEX]` | a zip by URL; `http://` only for loopback or with a pin |
| `gh:OWNER/REPO[/ASSET][@TAG][#sha256=HEX]` | a GitHub release asset. `ASSET` gets `.zip` when it has no extension; without it, the release's only `.zip` (else `REPO.zip`). No `@`: the latest release. `@TAG`: that release. `@PREFIX*`: the newest release whose tag starts with `PREFIX` and that fits this tvpipe (below) |
| `https://github.com/O/R[/releases[/latest\|/tag/T\|/download/T/F\|/latest/download/F]]` | rewritten to `gh:` |
| `NAME` (`[a-z0-9-]`, not a path) | an entry of the games list |

No bare `owner/repo`: it reads like a relative path, and a typo would
fetch code from the internet.

**GitHub.** `gh:` with an asset and a tag (or the latest) needs no API:
`github.com/O/R/releases/{download/TAG|latest/download}/ASSET`, which
redirects to a signed `release-assets.githubusercontent.com` URL (valid
minutes, so never cached). Without an asset, and for `@PREFIX*`, one API
call (`/repos/O/R/releases/latest`, `/releases/tags/T` or
`/releases?per_page=100`): 60 an hour without a token; `GITHUB_TOKEN` or
`GH_TOKEN` is sent to `api.github.com` only, never across a redirect. The
API's `digest` (`sha256:…`) is checked after the download.

**Which release fits.** One repository can hold several release streams
(tvpipe's own `vX.Y.Z`, `drawbluff-vX.Y.Z`); GitHub's single "latest"
pointer belongs to tvpipe (game releases are made with `--latest=false`).
`@drawbluff-v*` lists the releases (drafts and prereleases left out),
orders the tags by the version after the prefix, and takes the newest
whose release notes carry `<!-- tvpipe: X.Y -->` with a series this tvpipe
runs (`check::version_compatible`); releases without the marker count as
fitting, and the zip's own `tvpipe.json` decides after the download. The
games workflow writes the marker; other publishers may.

**The games list.** `https://tvpipe.party/games.json`
(`site/static/games.json`; `$TVPIPE_GAMES_URL` overrides it): `{"v": 1,
"games": [{name, title, summary, players: {min, max}, languages, source,
home}]}`, each `source` a remote form above (drawbluff:
`gh:mitsuhiko/tvpipe/drawbluff@drawbluff-v*`). Fetched with its ETag when a
name is played, kept in the cache; offline the cached copy; never compiled
into tvpipe. The website's games pages (`/games/`) are rendered from it.

**Fetching** (`net/fetch.rs`, on `net/tls.rs`, the TLS dialer the tunnels
share): blocking HTTP/1.1 GET, rustls with Mozilla's roots plus
`$SSL_CERT_FILE`; redirects (301/302/303/307/308, at most 5, never from
https to http); the body streamed to a file with SHA-256, at most 256 MiB;
10 s to connect, 30 s of silence; Ctrl-C between reads;
`Progress::Download` for the status line. No proxies yet.

**Cache** (`playshare/cache.rs`) in the platform's cache directory
(`~/Library/Caches/tvpipe`, `$XDG_CACHE_HOME/tvpipe` or
`~/.cache/tvpipe`, `%LOCALAPPDATA%\tvpipe\cache`; `$TVPIPE_CACHE_DIR`):
`games/blobs/SHA256.zip` and `games/index.json` (per source: the resolved
URL, tag, ETag, sha256, size, name, title, series, when fetched and used,
the sha256 the person approved), `games/list.json`, and the list's
screenshots in `games/pics/` (by the URL's hash, with their ETags). A pinned source with
its blob never touches the network; `@TAG` uses the cached copy until
`--refresh`; moving sources (latest, `@PREFIX*`, URLs) ask again
(`If-None-Match`), and fall back to the cached copy with a warning when
the network fails. `--offline` uses only the cache. Blobs no source
refers to are deleted.

**Trust: ask once per source and hash.** A remote game runs its host page
in tvpipe's window with the local API (it can cast to TVs on the network,
pair, open links in the system's browser, quit), reaches what any web page
from `127.0.0.1` reaches, and serves pages to phones. Before the first run
of a source, and again when its sha256 changes, `game play` shows the
source, name, title, size, sha256 and the `tvpipe` series and asks. A
matching `#sha256=` pin or `--yes` skip the question; without a terminal
(and neither) it is an error that names both. No source is trusted more
than another, the games list's included. `game fetch` and `game check` run
nothing and never ask.

**Picking in the window** (`playshare/picker.rs`, `npm/party/src/picker/`;
docs/game-catalog.md, docs/game-switching.md). `game play` without a game
starts the session with an empty slot and opens the window on the
picker (the local listener's `/_tvpipe/picker/`, the token and cookie as
every page there): the games on this computer the command line named,
then the games list's entries with their
screenshots, which tvpipe fetches and serves (`GET /_tvpipe/api/catalog`,
`/_tvpipe/catalog/N`: `https://` pictures only, PNG, JPEG or WebP, at most
2 MiB, cached), and a field for a source (`https://`, `gh:`, a name; never
a path). `POST /_tvpipe/api/game` with `{"source"}` fetches in the
background (`GET` polls: `fetching` with the bytes so far, `ask`,
`starting`, `ready`, `failed`), `{"trust": true}` answers the question
above in the window (remembered as in the terminal; `--yes` and pins skip
it), `{"local": ID}` picks a game of this computer's list, `{"back":
true}` returns to the list. The chosen bundle goes into the hub's slot
(the first game, or the next one: docs/game-switching.md), and `ready`
carries the page to open (the game's launcher, or its host page when TVs
are chosen).

**Service workers** are refused on the phones' listeners (a request with
`Service-Worker: script` gets 403, for every game): the phones' origin
can be the same across runs (a reused Cloudflare hostname, `--lan`'s
port), and a worker would outlive the game that registered it.

**Commands.** `game play SOURCE [--yes] [--refresh|--offline]`; `game
fetch SOURCE [-o FILE]` (download, check, print the pinned source);
`game check SOURCE`; `game list` (the cached games); `game pack` prints
the zip's sha256.

**Publishing** (`.github/workflows/games.yml`): a tag `GAME-vX.Y.Z`
builds `npm/party` and `games/GAME`, checks that the tag is the game's
`package.json` version and that `tvpipe.json`'s `tvpipe` is the
workspace's series, packs with a tvpipe built from the same commit
(`game pack --strict`, `game check --strict`), writes `SHA256SUMS` and
the notes (with the marker), and runs `gh release create --latest=false`.
`game check --smoke` is not run there (no headless Chrome is promised on
the runners; run it before tagging). CI packs and checks Drawbluff the
same way on every push, and checks every game's series. tvpipe's own
release marks itself `--latest`; the installers pick the newest
`vX.Y.Z` tag from `/releases?per_page=100` themselves (falling back to
the latest pointer only when it is a `vX.Y.Z` tag), tested with fixtures
by `scripts/test-installers.sh`. `site/build.py` validates `games.json`
and renders it (`:::games`).

**Overrides** for tests and mirrors: `$TVPIPE_GITHUB_URL` (github.com),
`$TVPIPE_GITHUB_API` (api.github.com), `$TVPIPE_GAMES_URL` (the list),
`$TVPIPE_CACHE_DIR`. The fetch tests run a TLS server with the
opentunnel test CA in-process (`net/fetch/tests.rs`,
`playshare/remote/tests.rs`: a fake GitHub web, API, CDN and list); a
live check of the real list runs with `TVPIPE_TEST_NET=1`.

**Follow-ups** (not built): a CSP for remote games (`connect-src 'self'`,
a `network` allowlist in `tvpipe.json`); remote games casting only to
the launcher's selection; a remote game's own launcher only after the
question says so; downloads denied and `open_url` rate-limited in the
window; `HTTPS_PROXY`; community entries in the games list (pinned,
checked by a scheduled workflow); `game list --available`; signatures.
