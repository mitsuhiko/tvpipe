# Web games for `tvpipe game play`

How to build a party game that `tvpipe game play` runs (the TV shows the
game, everyone plays on their phone's browser), check it, pack it into a
zip, and how to run one. The design behind it:
[`playshare-design.md`](playshare-design.md); the library:
[`npm/party/README.md`](../npm/party/README.md); the protocol between
phones and the game: [`party-protocol.md`](party-protocol.md); a whole
game: [`games/drawbluff`](../games/drawbluff/).

Contents: [Building](#building-a-game) (start, layout, `tvpipe.json`,
pages, the library, the dev loop, assets, checking and packing,
versions, [publishing](#publishing)) · [Running](#running-a-game)
(start, [games from the internet](#playing-from-a-url), the launcher,
TVs and AirPlay PINs, phones and links, ending, troubleshooting).

```
 this computer                                          TVs (AirPlay, Cast)
 ┌──────────────────────────────────────────────────┐        ▲
 │ window: launcher → host page (the rules)          │        │ cast
 │ headless browser: TV page ───────────────────────────────────┘
 │ tvpipe game play: serves the game, relays phones  │◀── phones (tunnel or Wi-Fi)
 └──────────────────────────────────────────────────┘
```

A game is a **web app**: static files, no server code. tvpipe serves
them, opens the **host page** in a window of its own browser (the game's
rules run there), renders the **TV page** in a headless browser and
casts it, and relays the phones' WebSockets (from the **phone page**) to
the host page. Rooms, players, reconnects and views live in the browser
library `@tvpipe/party`, which tvpipe serves itself.

---

# Building a game

## Start

```sh
tvpipe game new my-game          # a starter game: a buzzer, about 250 lines
tvpipe game play my-game         # play it
```

The starter is plain JavaScript, no build step: a host page that counts
rounds and points, a TV page with the QR code and who buzzed first, and a
phone page with a join form and a big button. Change it from there.

## Layout

The smallest game is a folder with `tvpipe.json` and three pages:

```
my-game/
  tvpipe.json
  style.css             shared files: anywhere in the folder
  host/index.html       the rules (the window on this computer)
  host/host.js
  tv/index.html         what the TV shows
  tv/tv.js
  phone/index.html      what phones show
  phone/phone.js
```

Every file below the served folder is public (phones need to load the
pages; the host page is code, not a secret). Names starting with `.` are
never served, and `/_tvpipe/` belongs to tvpipe.

**With a build step** (TypeScript, a bundler), keep the sources next to
the output and point `root` at the output; only `root` is served and
packed:

```
drawbluff/
  tvpipe.json           "root": "dist"
  package.json, src/, host/host.ts, …   (not served)
  dist/                 the build: host/, screen/, phone/, …
```

## `tvpipe.json`

```json
{
  "name": "my-game",
  "title": "My game",
  "tvpipe": "0.4",
  "root": "dist",
  "pages": {
    "host": "host/index.html",
    "tv": "tv/index.html",
    "phone": "phone/index.html",
    "launcher": null
  },
  "players": { "min": 2, "max": 12 },
  "tv": { "width": 1280, "height": 720 },
  "limits": { "message": 262144, "rate": 20, "burst": 50 }
}
```

| Field | | Meaning |
|---|---|---|
| `name` | required | 1–40 of `a-z`, `0-9`, `-`: logs, the zip's folder and file name |
| `title` | optional | the launcher's heading (default: `name`), at most 80 characters |
| `tvpipe` | recommended | the tvpipe (and so `@tvpipe/party`) the game is made for, `"0.4"`; see [Versions](#versions) |
| `root` | optional | the served folder, relative to `tvpipe.json` (default: its own folder) |
| `pages.host` | required | the host page, relative to `root` |
| `pages.tv` | required | the TV page |
| `pages.phone` | required | the phone page; `/` on the phones' link redirects to it |
| `pages.launcher` | optional | the game's own launcher instead of tvpipe's ([Pages](#the-pages)) |
| `players.min`, `players.max` | optional | shown in the launcher; `max` (default 8, at most 1000) sizes the relay's connection limit and is the library's default `maxPlayers` |
| `tv.width`, `tv.height` | optional | the TV page's viewport, its layout in CSS pixels (160–3840 × 120–2160; default: the receivers' shape) |
| `tv.resolution` | optional | `"choice"` (default): the launcher's resolution (Auto, 720p, 1080p, 4K) renders the layout sharper or softer, never differently laid out ([Resolution](#resolution)); `"fixed"`: exactly `tv.width`×`tv.height` pixels |
| `limits.message` | optional | the largest message from a phone, 1 KiB–1 MiB (default 256 KiB; larger: closed with 1009) |
| `limits.rate`, `limits.burst` | optional | messages per second per phone (1–200, default 20) and at once (default 50); more: closed with 4008 |

Paths use `/`, stay inside `root` (no `..`, no leading `/`, no hidden
names). Fields tvpipe does not know are ignored (`tvpipe game check` warns
about them: usually typos), so `description` or your own data can go
there. A wrong or missing required field stops `tvpipe game play` with a
message naming it.

## The pages

| Page | Runs | Opened with | Uses |
|---|---|---|---|
| host | the window on this computer (tvpipe's own browser, an app window) | after the launcher, at `pages.host` | `Tvpipe` and `Party` from `/_tvpipe/lib/index.js` |
| TV | a headless browser on this computer, cast to the TVs | `party.links.tv`: `pages.tv#r=CODE&k=SCREENKEY&role=screen` | `PartyClient` from `/_tvpipe/lib/client.js` |
| phone | each player's phone | `party.links.join`: `https://HOST/?r=CODE#k=JOINKEY` (the QR code) | `PartyClient` |
| watch | anywhere (a preview in the host page, a second screen) | `party.links.watch`: `pages.tv#r=…&k=WATCHKEY&role=watch` | the TV page, read-only |
| launcher | the window, before the host page | `pages.launcher`, if set | `Tvpipe` |

- The **host page** keeps the game: it connects to tvpipe's API
  (`Tvpipe.connect()`, the window's session cookie does the
  authentication), makes the party (`tvpipe.party()`: the room code,
  keys, join link and QR code, the relay), casts the TV page
  (`party.cast()`) and then runs rounds. Reloading it starts a new
  party (a new room code and QR code): the phones have to join again.
- The **TV page** only draws `view.screen` (what the host sets) and
  `view.join` (the code, link and QR code). It renders at `tv` size,
  with sound; a browser of tvpipe's own allows autoplay. Keep it to one
  screen without scrolling, and out of the join badge's corner
  (`data-tvpipe-join`, `--tvpipe-join-w`/`-h`: the join badge in
  [Using `@tvpipe/party`](#using-tvpipeparty)): nothing the players
  need may sit under it, not even with the most players the game takes.
- The **phone page** joins with a name (`client.join(name)`), or
  reconnects (`client.connect()`) when the phone played before, then
  shows `view.room` and `view.me` and sends actions. Make it work on a
  small touch screen, in portrait.
- **Words are read whole**, on the TV and on phones. A word players
  must read (a prompt, a clue, a guess, a name on a card) is never cut
  off (no ellipsis, no line clamp) and never broken in the middle
  ("Schraubenschlüs-sel": no `overflow-wrap: anywhere`, no `hyphens:
  auto`). Give it a smaller font until it fits instead (Krakel's
  `phone/fit.js` does it for elements marked `data-fit`); text may
  break between words. A typed field's font gets smaller as the text
  outgrows it. Check with the longest words the game has (in German
  too).
- A **launcher of your own** (rarely needed) may call any `Tvpipe`
  method; it ends with `tvpipe.select(names)` and a navigation to the
  host page. tvpipe's standard one lists the TVs, pairs AirPlay TVs that
  show a PIN, and offers "a browser tab on this computer".

## Using `@tvpipe/party`

tvpipe serves the library at `/_tvpipe/lib/` (`index.js` for host pages,
`client.js` for the TV and phone pages), always the version that matches
the running tvpipe. Import it from there; do not copy it into the game.

The host page:

```js
import { Tvpipe, PartyError } from "/_tvpipe/lib/index.js";

const tvpipe = await Tvpipe.connect();       // fails outside tvpipe game play
const party = await tvpipe.party();          // { maxPlayers, lateJoin, moderate, … }
if ((await tvpipe.selection()).length > 0) await party.cast();
tvpipe.on("cast", (s) => showTvState(s));    // starting, streaming, failed, stopped

party.screen.set({ phase: "lobby" });        // the TV's view.screen
party.handle("start", (data, from) => {
  if (from.role !== "player" || !from.vip) throw new PartyError("not-vip", "Only the VIP starts");
  void round();
});

async function round() {
  party.inProgress = true;
  const deadline = party.deadline(60_000);   // 60 s from when the question is on the TV
  party.withTv(() => {                       // phones switch when the TV does
    party.room.set({ phase: "answer", deadline });        // every phone's view.room
    party.screen.set({ phase: "answer", deadline });      // the TV's view.screen
  });
  const answers = await party.collect("answer", { until: deadline });
  party.withTv(() => party.screen.set({ phase: "results", answers: [...answers.values()] }));
}
endButton.onclick = () => tvpipe.quit();     // ends tvpipe: TVs stop, phones are told
```

**The standard host page** (`HostPage` in `/_tvpipe/lib/index.js`) is
the window most games want: the logo and the game's status, the join QR
code and link (Copy), the TVs (change them, try again, open the TV
view), the players (VIP, a rejoin code for away players, remove), Start
(with how many are still missing), Other game (tvpipe's games list in a
dialog: the next game takes the room, the TVs and the phones over) and
End, a muted preview of the TV,
the bots' buttons in test mode, and the game's **settings, from a
spec**: a list of fields, each a label, its choices and how to read and
change the value. The page draws them (a dropdown, a row of buttons or
a switch, the label above the control, so long German labels and
choices fit), locks them while a game runs (but `live` ones), shows a
refused change (`set` throws) as an error, speaks the room's language
(its own texts in English and German, the game's as `{ en, de }`), and
keeps the host's choices in `localStorage` for a reload. Its look comes
from the game's stylesheet: CSS variables (`--bg`, `--card`, `--line`,
`--text`, `--muted`, `--accent`, `--accent-text`, `--link`, `--ok`,
`--error`) and `.logo`.

```js
import { HostPage, languageField, lateJoinField, preferredLang } from "/_tvpipe/lib/index.js";

const page = await HostPage.connect({ name: "quiz", title: "Quiz", lang: preferredLang("quiz", ["en", "de"]) });
const party = await page.tvpipe.party();
const game = new Quiz(party);                // running, minPlayers, play(), lang, …
page.run({
  party,
  game,
  lang: () => game.lang,                     // the page speaks the room's language
  settings: [
    languageField({ langs: ["en", "de"], get: () => game.lang, set: (lang) => game.configure({ lang }) }),
    { key: "rounds", type: "buttons", label: { en: "Rounds", de: "Runden" },
      choices: [1, 2, 3].map((n) => ({ value: n, label: String(n) })),
      get: () => game.rounds, set: (rounds) => game.configure({ rounds }) },
    { key: "hard", type: "toggle", label: { en: "Hard questions", de: "Schwere Fragen" },
      hint: { en: "For quiz nerds.", de: "Für Quiz-Profis." },
      get: () => game.hard, set: (hard) => game.configure({ hard }) },
    lateJoinField(party, ["wait", "closed"]),
  ],
  status: (lang) => (game.running ? `Round ${game.round}` : "Lobby"),
  bots: (n) => addBots(n),                   // optional: the bots' buttons in test mode
});
game.on("change", () => page.update());      // the VIP changed a setting, a new phase
await page.castChosen();
```

A host page of a game's own skips it (it is a convenience, not a
requirement), or uses only the form: `new SettingsForm(fields,
lang).element` in any element. This repository's games all use it.

This repository's games follow two rules for settings. Every field of
the host page is also on the VIP's phone (the game's `settings`
action: only the VIP, the same choices, locked while a game runs
unless the field is `live`), and a change from either side reaches
the other. The language is the room's, shared by every player: each
phone speaks it like the TV (before joining: the browser's), and no
phone switches only itself; the VIP and the host page set it for
everyone.

The TV page:

```js
import { PartyClient, joinText, qrSvg } from "/_tvpipe/lib/client.js";

const client = PartyClient.fromLocation();   // room, key and role from the link
client.on("view", ({ roster, screen, join }) => {
  qrBox.innerHTML = qrSvg(join?.qr);         // the join link's QR code
  linkBox.textContent = joinText(join) ?? ""; // tvpipe.party/BCDF to type, when there is one
  draw(screen, roster);
});
await client.connect();
```

The phone page:

```js
import { PartyClient } from "/_tvpipe/lib/client.js";

const client = PartyClient.fromLocation();
client.on("view", ({ roster, room, me }) => render(room, me));
client.on("bye", (reason, message) => showEnd(message ?? reason));
if (client.canResume) await client.connect();
else form.onsubmit = () => client.join(nameInput.value).catch((e) => show(e.message));
button.onclick = () => client.act("answer", { text: input.value }).catch((e) => show(e.message));
```

**The next game.** When the host picks another game, tvpipe closes the
phones with 4014 and `PartyClient` takes each player's page to its join
link, which is the next game's phone page now
([`game-switching.md`](game-switching.md)). The phone page above needs
nothing for it: `canResume` is also true when the phone carries a name
from the last game, and `connect()` joins with it (a taken name rejects,
and the form shows). `client.carried` is `{name, data}` or `null`, for
a game that wants more; `client.carry(data)` stashes up to 4 KiB of
JSON for the next game (an avatar, a colour). A game without names
ignores both.

The rules of thumb: the host **sets views** (`party.room`, `party.screen`,
`player.state`), it never sends events to keep phones in sync; phones
**send actions** (acknowledged, resent after a reconnect, applied once);
render everything players type as text (`textContent`), never as HTML.
The full API is in [`npm/party/README.md`](../npm/party/README.md).

**The TV is behind the phones.** A phone shows a change some 20–50 ms
after the host makes it; the TV shows it after its page is drawn,
captured and encoded and the receiver's playout delay has passed, plus
the TV's own picture processing: about a quarter of a second on an Apple
TV, half a second on Cast (`party.tvDelay` has tvpipe's figure for the
TVs that show the game, 0 without one). Without help, phones show the
vote before the TV shows the drawing, give away a result the TV is about
to reveal, and countdowns on the TV run behind the phones'. The rule:
**a phone never learns a phase, a result or a score before the TV shows
it**, not even in a view it does not draw yet. Three things keep them
together:

- **`party.withTv(() => { … })`** around what the TV shows: a new phase,
  a reveal, a result. Views changed inside it (`room`, `screen`,
  `player.state`) and messages sent inside it reach phones and watchers
  when the TV picture with them is up (the TV page at once). Replies to
  a phone's own action (`done: true`, "sent") stay outside: they should
  be instant.
- **`party.deadline(ms)`** for deadlines: `ms` from when the phase is on
  the TV, so nobody loses the TV's delay off their time.
- **Countdowns use `client.now()`**, on the TV page and on phones: on a
  TV page it runs ahead by the delay (it is the time the picture being
  drawn will be on screen), so both reach zero at the same moment. A
  canvas drawn in the host page (a surface) counts with
  `party.screenNow()`.

For games where speed counts (a buzzer: who reacted first to what the
TV showed), an action's handler gets `info.sentAt` (`party.handle(type,
(data, from, info) => …)`): when the phone sent it on the host's clock,
the phone's word kept within the second before it arrived; ordering by
it is fairer than by arrival (tunnels differ by tens of ms). A phone can
time its own sounds to the TV with `client.hostNow() + client.tvDelay`.

**Players drop out, and every game must take them back.** At a party
phones lose the signal, lock, reload, or open the link in another
browser or on another phone. The library does the returning: the same
phone resumes with its token; another phone gets the player's seat back
by typing the same name (even when the room is locked or closed to
newcomers); the TV page has the join code in a corner the whole game
(the join badge, below), so scanning it and typing the same name is the
way back; the host page can show a player their
own code (`party.showRejoin(player)`). What a game must do:

- Keep going without them: deadlines on every phase that waits for
  players (`collect` with `until`), and never a turn that only an away
  player can end.
- Keep their place: an away player stays in the game (`player.connected`
  is false meanwhile), with their score and their part of the round;
  their phone gets the whole view back (`me` included) and carries on.
- End early when too few are left: at the start of each round (after
  letting latecomers in), a running game with fewer players in it than
  it needs to start (`players.min`; a `minPlayers` option, never a
  literal) ends at once, on its normal final screen. Players who left
  or were removed do not count (they are gone from `party.players`); an
  away phone does (it may come back). The round in progress is not cut
  short: its deadlines end it.
- Make room for the join badge (below).
- A "Rejoin code" button beside away players on the host page
  (`party.showRejoin(p)`; the standard host page has it).
- Test it: a whole game played through `dropOuts()` from
  `@tvpipe/party/testing` (phones dropping out and coming back, by token
  and by name, all game long) ends with everyone in it.

**The join code is always on the TV.** People join late, come back
after a reload, or pick up a second phone, and none of them should have
to ask: every TV page shows the join QR code and the short link to type
(`tvpipe.party/BCDF`, with a tunnel) in a corner, all game long. The
library draws it (the join badge: `PartyClient` on TV and watch pages,
in a shadow root of its own), titled by who may join now ("Join", "Join
next round", "Rejoin" when the game is closed to newcomers); it is
also the way back for a player whose phone went away, so nothing else
appears while someone is missing. A game:

- picks the corner and the shape: `PartyClient.fromLocation({
  rejoinBadge: { corner: "top-right", layout: "row" } })` (default
  `bottom-right`, `column`: narrow and tall; `row`: low and wide);
- sets `client.joinVisible = true` while it shows the code big itself
  (the lobby): the badge steps aside;
- keeps its picture out of the corner: while the badge shows, `<html>`
  has `data-tvpipe-join="CORNER"` and the room it takes from the
  screen's edges as `--tvpipe-join-w` and `--tvpipe-join-h` (`0px`
  otherwise), so a column ends above it with `[data-tvpipe-join$="right"]
  .answers { padding-bottom: var(--tvpipe-join-h) }`;
- may dress it: `--tvpipe-join-bg`, `-fg`, `-accent`, `-font`,
  `-border`, `-shadow`, and `--tvpipe-join-x`/`-y` for its distance
  from the edges.

`rejoinBadge: false` turns it off (a game that draws its own).

**TypeScript and bundlers.** Install the package for its types
(`npm install --save-dev @tvpipe/party`), then make the built files
import tvpipe's copy: rewrite `"@tvpipe/party"` to
`"/_tvpipe/lib/index.js"` and `"@tvpipe/party/client"` to
`"/_tvpipe/lib/client.js"` (Drawbluff's `scripts/build.ts` does it in
ten lines), mark them external in a bundler, or put an import map in
each page:

```html
<script type="importmap">
{ "imports": { "@tvpipe/party": "/_tvpipe/lib/index.js", "@tvpipe/party/client": "/_tvpipe/lib/client.js" } }
</script>
```

Browsers do not resolve bare names (`"@tvpipe/party"`) or add file
extensions (`"./rules"`), and they do not run TypeScript: ship `.js`
with `type="module"` scripts.

**Tests** run in Node without tvpipe: `memoryRelay()` from
`@tvpipe/party/testing` connects a `Party` and `PartyClient`s in memory
(Drawbluff's `test/` has examples, bots included).

**Test mode.** `tvpipe game play --dev` sets `info.dev` (the host page
reads it as `party.info.dev`): the game may offer its test tools there,
for people trying it alone. This repository's games show their bot
buttons ("Add a bot", "Add 3 bots": dummy players that join through the
phones' listener and play by themselves) in test mode, and also with
`?bots` in the host page's URL (the live checks). Players never see
them otherwise.

**tvpipe's look (optional).** The host page sits in tvpipe's window
right after the launcher; for a host page that looks like tvpipe (the
launcher, the share page, the manual), link tvpipe's stylesheet:

```html
<link rel="stylesheet" href="/_tvpipe/ui.css">
```

It brings the colours (custom properties: `--bg`, `--ink`, `--ink-2`,
`--ink-3`, `--rule`, `--panel`, `--accent`, `--bad`; light, dark with
the system or `<html data-theme="dark">`), the fonts (`--title`
Michroma, `--sans` IBM Plex Sans, `--mono` IBM Plex Mono, `--display`
Sixtyfour; the files are at `/_tvpipe/fonts/`, served by tvpipe, no
internet needed), base typography, and a few parts: `.lbl` (an
uppercase label), `.btn` and `.btn.primary`, `.state` with `.ok`, `.on`
or `.bad` (a status with a dot), `.row` with `.meta` (a label column
beside the content), `.note`, `.top` and `.foot` (the header and footer
of the launcher). The launcher's page source shows them in use. It is
for the host page and pages of your own on this computer; the TV and
phone pages are the game's, in the game's own look.

## The dev loop

```sh
tvpipe game play ./my-game                    # the window opens with the launcher
tvpipe game play ./my-game --no-tunnel        # no public link: this computer only
tvpipe game play ./my-game --window open      # the host page in your own browser (DevTools)
```

- A folder is read on every request: edit a file and reload the page.
  Reloading the host page starts a new party in the same room (it casts
  again, phones come back in by their names); a phone or TV page can be
  reloaded on its own. Several games at once: `tvpipe game play
  ./games`, and Other game in the host page to go from one to another.
- Pick **"A browser tab on this computer"** in the launcher to see the TV
  page without a TV; the host page's preview (`party.links.watch` in an
  `<iframe>`) shows it too.
- Open the join link on this computer (`http://127.0.0.1:PORT/?r=…#k=…`,
  shown by the host page) in a few tabs to be several players; a phone
  on the same Wi-Fi works with `--lan`.
- `--window open` uses your browser and its DevTools; tvpipe then ends
  30 s after the last page closed. `-v` prints more of what happens.
- `TVPIPE_PLAYSHARE_WEB=DIR` serves `/_tvpipe/` from a folder (working on
  the library itself: `npm run build` in `npm/party`).

## Assets and offline play

- Load everything with relative paths (`style.css`, `../img/a.png`) or
  paths from the root (`/img/a.png`). Mind the case: a folder on macOS or
  Windows forgives `Logo.png` for `logo.png`, a zip and Linux do not.
- Put fonts, sounds and libraries in the game. Phones on `--lan` and TVs
  may have no internet, and a party at a cabin should still work:
  `tvpipe game check` warns about every file loaded from `http(s)://`.
- `fetch()` with URLs built at run time is not checked by `tvpipe game
  check`; `--smoke` notices if they fail while the pages start.
- A bundle holds at most 10 000 files and 256 MiB unpacked; phones load
  what their page needs, so keep the phone page light (warnings above
  32 MiB per file).

## Checking and packing

```sh
tvpipe game check ./my-game              # check a folder, write nothing
tvpipe game pack ./my-game               # check, then write my-game.zip here
tvpipe game pack ./my-game -o out/my-game.zip --smoke
tvpipe game check my-game.zip            # check a zip (someone else's, or before sharing)
tvpipe game check --strict ./my-game     # warnings fail too: for CI
```

What it checks (errors stop it with exit code 1, warnings do not):

| | Errors | Warnings |
|---|---|---|
| `tvpipe.json` | missing, not JSON, a wrong or missing field (as `tvpipe game play` would refuse it), a `tvpipe` version this tvpipe cannot run | unknown fields and pages (typos), no `tvpipe` version |
| the folder | `root` missing ("build the game first"), outside the folder, or empty; symlinks that leave `root` (never served) or are broken or loop; names with backslashes or control characters, or not UTF-8; a `_tvpipe` folder; more than 10 000 files or 256 MiB | names Windows cannot unpack (`<>:"\|?*`, a trailing dot or space); `node_modules` in `root`; files over 32 MiB |
| a zip | not a zip, zip64, encryption, other methods, CRC errors; unsafe names (`..`, absolute, drive letters); a name twice; no `tvpipe.json` at the top or in its one top-level folder (with a hint for a folder too deep) | files outside `root` (never served) |
| names | two files or folders that differ only in case (one is lost on macOS and Windows) | |
| the pages | an entry page missing (and why: the case, an unbuilt `root`) | an entry page that is not `.html` |
| what pages load | a missing file, with the page and line: `<script src>`, `<link href>`, `<img src/srcset>`, media, `<iframe>`, CSS `url()` and `@import`, JS `import`/`export from`/`import("…")`, inline scripts and styles; a path above the root; a hidden file; a name that differs in case; an import without its extension; TypeScript or JSX loaded as a script; a module with `import` loaded as a classic script; a bare import (`"@tvpipe/party"`) no import map resolves; a `/_tvpipe/` path tvpipe does not serve | a file loaded from the internet; a missing `<a href>` target; `<base href>` |
| `@tvpipe/party` | | a host page that never loads `/_tvpipe/lib/index.js` (or `tvpipe.js`); a TV or phone page without the client (not the TV page when the game streams a canvas: `tvpipe.surface`, `SurfaceEncoder`); a copy of the library inside the game |

Finally the result is opened the way `tvpipe game play` opens it.

`game pack` ends with the zip's SHA-256 (`sha256 HEX`): the pin for
`#sha256=HEX` (below). `game check` also takes a game from the internet
(a URL, `gh:…` or a name, [below](#playing-from-a-url)): it downloads
it into the cache and checks it, running nothing.

The zip is **deterministic**: the same files give the same bytes
(entries sorted, every time 1980-01-01, modes `rw-r--r--`, deflate or
stored, whichever is smaller). It holds one folder named after the game
with `tvpipe.json` (without `root`) and the files of `root`, so it
unpacks into a tidy folder and `tvpipe game play` reads it as it is.
Hidden files (`.DS_Store`, `.git`) are left out, and so is the zip itself
when it is written inside the game. A zip made by hand works too
(`tvpipe game play` ignores Finder's `__MACOSX/` and hidden files beside
the game's folder), but `tvpipe game pack DIR` checks it and leaves them out.

**`--smoke`** runs the game once, without TVs or a tunnel, in a headless
Chromium-based browser (Chrome, Edge, Chromium, Brave; `--browser PATH`
or `$TVPIPE_BROWSER`): the launcher, the host page (with a stand-in TV
chosen; it must attach the relay), the TV page it casts, the phone page
at the join link, and a fake phone that joins. Uncaught exceptions and
failed requests are errors, `console.error` and failed requests to the
internet warnings. It takes about ten seconds:

```
$ tvpipe game pack my-game --smoke
My game (my-game): 12 files, 9.3 KiB; 0 errors, 0 warnings
wrote my-game.zip (6.1 KiB, 9.3 KiB unpacked)
sha256 3b1f…(64 hex digits)
smoke: tvpipe's launcher loaded
smoke: the host page attached the relay
smoke: the TV page loaded (/tv/index.html)
smoke: the phone page loaded
smoke: a phone joined room SHRM as Smoke (1 in the roster)
smoke: ok
```

A host page that only casts after a button press gets a warning (the TV
page is then opened without its link); a game whose join link is not
`party.links.join` skips the fake phone.

## Versions

`"tvpipe": "0.4"` says which tvpipe the game is made for, and so which
`@tvpipe/party` it uses: tvpipe serves its own copy at `/_tvpipe/lib/`,
and the host page talks to tvpipe's API with it. `tvpipe game play`
refuses a game made for a newer tvpipe ("update tvpipe"), and, while
tvpipe is 0.x, one made for another 0.x series ("update the game");
from 1.0 on, the same major version. Without the field nothing is
checked (`tvpipe game check` warns).

When tvpipe moves to a new series: read the library's changelog, update
the game, run its tests and `tvpipe game check --smoke`, then set the new
version. The phone protocol has its own version (`hello.v`, 1); the
library on both sides is always tvpipe's, so it matches by itself.

Version your game however you like (a `version` field in `tvpipe.json`
is ignored by tvpipe); the zip's bytes change only when its files do, so
a hash of the zip identifies a release. A release's notes can say which
series it is for (`<!-- tvpipe: 0.4 -->`, [Publishing](#publishing)), so
an older tvpipe picks the newest release that still runs on it.

## Publishing

A zip anywhere on the web can be played (`tvpipe game play
https://example.com/my-game.zip`), but a GitHub release is the easiest
home, and needs no API calls when players name the asset and tag:

1. `tvpipe game pack my-game --strict` (and `--smoke` once); note the
   `sha256` it prints.
2. Make a release and attach `my-game.zip`. With
   `gh release create v1.0.0 my-game.zip --notes "<!-- tvpipe: 0.4 -->"`
   the marker says the series (optional: without it the zip's own
   `tvpipe.json` decides after the download).
3. Players run `tvpipe game play gh:you/my-game` (the latest release's
   only zip, else `my-game.zip`), `gh:you/my-game@v1.0.0` (that
   release), or `…#sha256=HEX` (exactly these bytes, no question).
   `https://github.com/you/my-game/releases/…` links work too.

**Several streams in one repository** (several games, or a program with
its own releases beside them): tag every game's releases `NAME-vX.Y.Z`,
create them with `--latest=false` (GitHub's one "latest" belongs to the
repository's main program), and name the stream:
`gh:you/repo/NAME@NAME-v*` lists the releases (60 API calls an hour
without `GITHUB_TOKEN`), orders the tags by the version after the prefix,
skips drafts, prereleases and releases whose marker names a series this
tvpipe cannot run, and takes the newest.

**The games list** (`site/static/games.json`, served at
`https://tvpipe.party/games.json`, rendered with its pictures on
`https://tvpipe.party/games/` (and `/games/NAME/` per game) and in `tvpipe game play`'s window without a
game) maps names to sources: `{"v": 1, "games": [{"name", "title",
"summary", "players": {"min", "max"}, "languages", "source", "home",
"screenshots"}]}`. `screenshots` is a list of `{"src", "alt", "kind"}`, at
least one: `src` relative to the list's URL (`static/games/NAME/FILE`, the
file `site/static/games/NAME/FILE`: listed games keep their pictures in the
repository), `kind` `tv` (1280×720) or `phone` (390×844), `alt` what it
shows; the first `tv` one is the cover. Each is a PNG, JPEG or WebP of at
most 400 KiB. A pull request adds a game; `python3 site/build.py` checks
the file and the pictures. This repository's games take theirs with their
live check: `node test/live/play.ts --shots ../../site/static/games/NAME`
(see the script's header for the bots it needs).

**This repository's games** (Drawbluff, Jinx, Garble, Krakel, Shifty, Crosstalk, Snug, Busted, Pinch, Worldquiz, Classes) release this way through
`.github/workflows/games.yml`:

1. Bump `games/NAME/package.json`'s `version`; when tvpipe's series
   changed, also `tvpipe.json`'s `tvpipe` (CI checks it is the
   workspace's `X.Y`).
2. Check locally: `npm run check && npm test`, then `npm run zip` (the
   bundle, packed by `tvpipe game pack` from `$TVPIPE_BINARY` or the
   PATH) and `tvpipe game check drawbluff.zip --smoke` (the workflow
   does not run `--smoke`: no browser is promised on the runners).
3. Tag `NAME-vX.Y.Z` on main and push the tag. The workflow checks the
   tag against `package.json` and the series against `Cargo.toml`,
   builds `npm/party`, the game and tvpipe of the same commit, runs
   `game pack --strict` and `game check --strict`, and publishes
   `NAME.zip` and `SHA256SUMS` with notes carrying the marker, never as
   the latest release. Running it by hand (workflow_dispatch, a game
   name) is a dry run that keeps the zip as an artifact.
4. A new game also needs its entry in `site/static/games.json`
   (`gh:mitsuhiko/tvpipe/NAME@NAME-v*`) and its screenshots in
   `site/static/games/NAME/`.

tvpipe's own releases (`vX.Y.Z`, `release.yml`) mark themselves latest;
the installers pick the highest `vX.Y.Z` tag themselves.

---

# Running a game

```sh
tvpipe game play                          # pick one from the games list in the window
tvpipe game play drawbluff                # a name from the games list
tvpipe game play drawbluff.zip            # a zip
tvpipe game play ./drawbluff              # or a folder with tvpipe.json
tvpipe game play ./games                  # a folder of games: pick one in the window
tvpipe game play ./a ./b.zip              # several games on this computer
```

Without a game the window opens on the games list with its pictures (or a
field for a source from elsewhere); the game picked there is downloaded,
asked about in the window the first time, and then runs as below
([`game-catalog.md`](game-catalog.md)). Games on this computer (a folder
whose folders or zips have a `tvpipe.json`, or several paths) are listed
first, under "On this computer", the online list below.

**Another game** any time: Other game in the host page (or the
launcher) shows the list again. The TVs, the phones' link and its QR
code and short link stay; phones go to the next game by themselves,
with their names ([`game-switching.md`](game-switching.md)).

tvpipe finds the game (a path that exists wins; else it is downloaded),
checks it (errors before anything starts), opens a window with the
launcher, starts the phones' link in the background, and waits.

## Playing from a URL

| `GAME` | |
|---|---|
| `NAME` | a name from the games list (`$TVPIPE_GAMES_URL`, default `https://tvpipe.party/games.json`) |
| `https://…/game.zip` | a zip by URL (`http://` only for loopback addresses or with a pin) |
| `gh:OWNER/REPO[/ASSET][@TAG]` | a GitHub release's asset ([Publishing](#publishing)); `@PREFIX*` the newest fitting release of a stream |
| `https://github.com/OWNER/REPO[/releases/…]` | the same, as a link |
| `…#sha256=HEX` | pinned: only these bytes |

A downloaded game lands in tvpipe's cache (`~/Library/Caches/tvpipe`,
`$XDG_CACHE_HOME/tvpipe` or `~/.cache/tvpipe`, `%LOCALAPPDATA%\tvpipe\cache`;
`$TVPIPE_CACHE_DIR`), in `games/`. Before the first run of a source, and
again when its bytes change (a new release), `game play` shows where it
comes from, its name, size, sha256 and tvpipe series, and asks: a game
runs in tvpipe's window, can cast to the TVs on the network and serves
pages to phones. A matching pin or `--yes` skips the question; without
a terminal one of them is needed. The games list's entries are asked
about like any other source.

| | |
|---|---|
| `--yes`, `-y` | play without asking |
| `--refresh` | ask the server again, even for a release (`@TAG`) downloaded before |
| `--offline` | the cache only (and the cached games list) |
| `tvpipe game fetch GAME [-o FILE]` | download and check, run nothing; prints the source pinned to the tag and sha256 |
| `tvpipe game list` | the downloaded games |
| `tvpipe game check GAME` | download and check, run nothing |

A source that can move (the latest release, `@PREFIX*`, a URL) is asked
again each time (with its ETag); when the network fails, the cached copy
plays with a warning. Downloads go over HTTPS with Mozilla's roots (and
`$SSL_CERT_FILE`), at most 256 MiB; `GITHUB_TOKEN` or `GH_TOKEN` raises
GitHub's API limit and is only sent to the API. `$TVPIPE_GITHUB_URL` and
`$TVPIPE_GITHUB_API` point at another GitHub (tests, mirrors). No proxy
support yet. Remote games get no service workers on the phones'
listener. The design: [`playshare-design.md`](playshare-design.md) §18.

## The launcher: picking TVs

The window lists the TVs as they answer on the network: Apple TVs and
AirPlay TVs, Chromecasts and Google TVs. Pick one or more, then
**Start**; or **Start without a TV**, or **A browser tab on this
computer** to try the game (the TV picture plays in a tab). The game's
host page follows and casts its TV page to the chosen TVs.

- **AirPlay PIN.** An AirPlay TV that shows a code needs pairing once:
  click **Pair** (or pick it and **Start**: the launcher asks first),
  type the digits the TV shows. A TV that turns out to need it only
  when the game casts (or forgot its pairing) brings up a pairing dialog
  over the host page, then the game appears on it. tvpipe keeps the pairing
  (`tvpipe pair NAME` does the same in a terminal; `tvpipe unpair`
  forgets it).
- **A TV that is not listed**: it must be on the same network (not a
  guest Wi-Fi), awake, with AirPlay or casting allowed; see `tvpipe
  discover` and the manual's Receivers page.
- **Several TVs** show the same picture; they are not frame-locked.
- **Sync** (per TV, here and in the cast picker): the TV and the window
  flash the same numbers; move the slider (or the arrow keys) until both
  flash at the same moment with the same number. It measures how much later the TV
  shows things than a phone, and tvpipe keeps it for that TV: phones then
  wait for the TV's picture exactly as long as it takes (games that use
  `party.withTv`). Measure again after changing the TV's picture mode
  (game mode is much quicker).
- A cast that fails (the TV went to sleep) shows in the host page; the
  game decides whether to offer "try again".

## Phones

The TV shows a QR code with the **join link**. Phones open it in their
browser; nothing is installed.

| | Phones reach the game through | |
|---|---|---|
| default | a public `https://` link: OpenTunnel, Cloudflare if that fails | works on any network, mobile data too; tvpipe keeps OpenTunnel's identity so it starts in a fraction of a second |
| `--tunnel=cloudflare` / `--tunnel=opentunnel` | that provider only | |
| `--lan` (`--lan=IP`) | also `http://IP:7420` on the Wi-Fi | no internet needed; the phones must be on the same Wi-Fi; plain HTTP, the join key crosses the Wi-Fi in clear |
| `--no-tunnel` | nothing public: this computer only (with `--lan`: the Wi-Fi) | |
| `--no-short-link` | no short link at tvpipe.party (also `TVPIPE_PARTY_URL=off`) | the TV shows only the QR code |

The link carries the room code and a key in its fragment; only people
who see the QR code can join. A phone that locks or loses the network
reconnects by itself and gets everything it missed; a player on another
phone (or browser) types the same name to get their seat back, and the
TV shows the code while someone is missing. Whether latecomers can join
a running game is the game's choice; players who were in it can always
come back.

## The window and the browser

| `--window` | |
|---|---|
| `app` (default) | an app window of tvpipe's own Chromium-based browser (Chrome, Edge, Chromium, Brave) with a temporary profile; closing it ends the game |
| `open` | the system's browser; the game ends 30 s after its last page closed |
| `none` | prints the window's link (programs, tests) |

`--browser PATH` (or `$TVPIPE_BROWSER`) picks the browser for the window
and for the TV page; with only Firefox, the window opens in the system's
browser. `--port PORT` fixes the window's port on 127.0.0.1. `--dev`
is test mode (`info.dev`, see "Test mode" above).

In the app window, a page the host page opens (a link with
`target="_blank"`, `window.open`) opens in the system's browser instead,
where it can be presented in a video call; Drawbluff's "Open the TV view"
is one. Navigations of the window itself stay in it.

## Resolution

The TV page keeps its layout (`tv.width`×`tv.height` CSS pixels) at
every resolution; tvpipe renders it at a device scale factor: a 1280x720
layout is drawn at 1.5x for 1080p and 3x for 4K (`devicePixelRatio`
tells the page; a canvas should size its backing store with it). The
launcher (and the cast picker) offer Auto, 720p, 1080p and 4K; `--resolution`
sets the start. Auto is up to 1080p within what the TVs take; 4K only
when chosen (it costs the computer about nine times the rendering of
720p, and TVs may refuse it: a Chromecast that does not allow 4K gets
1080p). Changing it restarts the picture on the TVs. A game whose TV
page must be exactly its size sets `"resolution": "fixed"`.
`--fps N` (default 30), `--latency MS`, `--no-audio` and `--reconnect
SECS` (default 120) are the TV picture's, like `share`'s; a surface takes
the latency and the reconnect window, its page picks the rest.
`--bitrate KBPS` sets the TV picture's bitrate (default: 0.1 bit per
pixel and frame, 1000–20000 kbit/s), within what the TVs take (AirPlay:
25000). It is the ceiling: while a TV's network is behind, tvpipe lowers
the bitrate and raises it again once it keeps up (ARCHITECTURE.md,
"Adaptive Bitrate").

## Ending

Any of these ends everything: closing the window, the game's own end
button (`tvpipe.quit()`), Ctrl-C, or `q` in the terminal (twice while
phones play: the first asks; `q` and Enter where the terminal has no
`stty`, as on Windows). The
host page gets a second to say goodbye, phones show that the room
closed, the TVs leave mirroring (TEARDOWN/STOP), the browsers quit and
their profiles are removed, the tunnel closes. Exit code 0 (130 after
Ctrl-C).

## Troubleshooting

| Symptom | Cause, fix |
|---|---|
| `tvpipe.json: …` at start | the manifest is wrong; `tvpipe game check PATH` lists everything at once |
| `no tvpipe.json at the top of the archive` | the zip has more than one top-level entry (a stray file or folder; `__MACOSX/` and hidden names do not count) or the game is a folder too deep: pack it with `tvpipe game pack DIR` |
| `pages.host: dist/… is not in the bundle (is the game built?)` | `root` points at a build output that is missing: run the game's build |
| `the game needs tvpipe X or newer` | update tvpipe; `made for tvpipe X`: the game needs updating |
| a blank or broken page | open it with `--window open` and look at the browser's console; `tvpipe game check --smoke PATH` names missing files, exceptions and failed requests |
| the launcher finds no TVs | same network, TV awake, AirPlay or casting allowed; a firewall that blocks mDNS (UDP 5353); `tvpipe discover` |
| AirPlay asks for a PIN every time | the pairing was refused or forgotten: pair again from the launcher, or `tvpipe pair NAME` |
| phones cannot open the link | the tunnel failed (the host page says "on this computer only"): try `--tunnel=cloudflare`, or `--lan` with phones on the same Wi-Fi; on Windows allow tvpipe through the firewall for `--lan` |
| phones lost the game | the host page was reloaded or closed: a reload starts a new party, so phones scan the new QR code |
| "the room closed" on phones | the game ended (the window was closed, Ctrl-C) |
| the TV shows the picture late | a cast is a video stream (about a second behind); keep timing-critical feedback on the phones |
| more detail | `tvpipe -v game play …` prints connections and casts; `--debug` the protocols |
