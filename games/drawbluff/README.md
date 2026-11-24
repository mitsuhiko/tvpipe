# Drawbluff

A Drawful-style party game (our own name, prompts and look) on
[`@tvpipe/party`](../../npm/party): 3–50 players in one mode, everyone
draws a secret prompt on their phone, others invent fake titles for each
drawing, everyone votes for the real one. Points for finding the truth
(1000), for the artist per player who found it (1000), and for every
player fooled by your lie (500); a round's points count as many times
as its number (round 2 double, round 3 triple, …). A game has 1 to 5
rounds (2 by default), as the host page or the VIP's phone sets it in
the lobby or on the final screen.

Up to 8 players it is the classic game: every drawing on the TV, every
other player lies. From 9 the round has six spotlight drawings (the rest
in a gallery on the TV, a page of eight at a time), at most seven liars
per drawing, rotating so everybody lies about as often, and from 13 the
next drawing's liars write while the TV shows the current vote. Every
phone gets at most six options, sampled so each lie is shown about
equally often, and the artist's and the liars' points are per exposure
(× min(1, 7 / voters who saw it)), so a big room does not inflate them
and the spotlight draw does not decide the game. Players can join
mid-game, as the VIP (or the host page) sets it in the lobby: from the
next round (`wait`, the default), from the next drawing (`open`, "join
anytime" on the TV) or not at all (`closed`); every phone shows its role and
its rank ("#12 of 50"). When a round would start with fewer than three
players left in the game (an away phone counts, one who left does not),
the game ends there, to its final screen. The design and the numbers:
[`docs/drawbluff-scale.md`](../../docs/drawbluff-scale.md).

It speaks English and German: the room's language is a setting on the
host page and the VIP's phone (the default: the host browser's
language), and every phone (unless it switched for itself), the TV and
the host page follow it, with prompts written for each
language (1993 in 17 structures in English, 2091 in 18 in German) in the
forms players type their lies in (about a third with a leading article,
short labels, sentences, telegraphic), so neither the truth nor the
game's decoys look like the file's. A room
deals no prompt twice until it dealt them all, game after game, and a
round of up to 8 players gets 8 kinds of prompt.

Every player picks a colour in the lobby (one of ten, each player their
own while one is free; a newcomer gets one of the least used) and draws
with pens made from it in OKLCH: its dark and light shade, or in colour
mode black and red, yellow, green and blue leaning towards it (`palette`
in `game/rules.ts`; a drawing carries its artist's pens). The host page
and the VIP's phone set the rules before a game (every setting of the
host page is on the VIP's phone too, in the lobby and on the final
screen, and a change there shows on the host page): the language, the
rounds, the timers (fast, normal or slow), latecomers, undo on the pad (off by
default: every stroke counts), colour mode, and adult prompts
(`data/prompts.adult.txt`, `data/prompts.adult.de.txt`: 18+, cheeky, not
explicit), and animated drawings (like Drawful Animate: every player
draws two frames that flip back and forth, 400 ms each, on the TV and
the phones; 135 s to draw instead of 90). The phone's pad takes the
whole screen, square, as big as the width allows (sideways: the height);
when animating it has a line of frames over the pens (a tab per frame
with its thumbnail, the other frame faintly under the one you draw,
copy the other frame into an empty one, play), clear and undo work on
the frame you draw, and Done asks once when a frame is empty. An
animation is a drawing with `frames` (the frames after the first,
`strokes`); the limits of a drawing (300 strokes, 12,000 points) are
for both frames together.

The look is an art show on late-night TV: a stage with a spotlight and
a sunburst, sketchbook pages while people draw, drawings hung in
picture frames with a brass plate that turns over to the real title in
the reveal, titles on gallery placards, rubber stamps, brush strokes
sweeping between phases and a rosette for the winner. The phone is the
player's sketchbook: paper cards taped on in their colour, sticker
buttons, a painter's palette to pick a colour from, coloured pencils
for pens, and a red dot on the title you vote for. Sounds are
synthesized with Web Audio (`phone/sfx.js`, no files): the TV plays
the show (a whoosh with every stinger, the clock's last ten seconds,
stamps, a drum roll and a fanfare for the truth, the sad trombone for
the game's own lie, applause for the winner; muted in the host page's
preview), the phones a quiet tap, a bell and a buzz when it is your
turn, coins for points; the speaker button in the phone's header turns
them off (kept on that phone). A title (the prompt to draw, a lie, the
truth) is never cut off or broken in a word: where it is too long for
its place (a label in the gallery, the frame's plate, a line of the
reveal, the phone's options) its font gets smaller (`phone/fit.js`, as
Krakel's), and so does a long lie in the phone's field.

It is a web app for [`tvpipe game play`](../../docs/playshare-design.md):
tvpipe serves it, the game runs in its host page (a window on the
computer), the TV page is cast to AirPlay and Chromecast receivers, and
phones join with the QR code.

| | | |
|---|---|---|
| `tvpipe.json` | the manifest | pages, 3–50 players, the TV's size; `root: dist` |
| `game/` | the rules (`rules.ts`), the game (`game.ts`), bots (`bots.ts`) | TypeScript on `@tvpipe/party`, tested in Node |
| `host/` | the host page | tvpipe's standard host page (`HostPage`: the party, the TV, the players, a preview of the TV) with Drawbluff's settings as a spec (`host.ts`) and its look (`host.css`); `strings.ts` (the status line) |
| `screen/` | the TV page | the screen view (`{ roster, screen, join }`); `strings.js` |
| `phone/` | the phone page | drawing, lies, votes; `strings.js`, `i18n.js` (languages, `Intl`), `sfx.js` (the sounds, the TV's too), `fit.js` (titles that fit, the TV's too) |
| `data/prompts.txt`, `data/prompts.de.txt` | the prompts, English and German | fetched by the host page |
| `data/prompts.adult.txt`, `data/prompts.adult.de.txt` | the adult prompts (18+), English and German | dealt instead when the room turned adult on |
| `scripts/prompts.ts` | numbers about a prompts file | structures, words, near duplicates, repeats per session |

## Running it

```sh
cargo build --release -p tvpipe-cli         # tvpipe (or a release build of it)
(cd npm/party && npm ci && npm run build)
cd games/drawbluff && npm install && npm run build
../../target/release/tvpipe game play .     # or: tvpipe game play games/drawbluff
../../target/release/tvpipe game play . --dev   # test mode: bot buttons on the host page
npm run zip                                 # drawbluff.zip (tvpipe game pack): tvpipe game play drawbluff.zip
```

tvpipe opens a window with its launcher: pick the TVs (or "A browser tab
on this computer"), then Start. The window becomes the host page: the
room code and QR code, the TVs, the players, rounds and timers, and who
may join during a game (from the next round, anytime, or not at all).
Scan the QR code on the TV; the first player is the VIP and starts the
game from their phone once three are in (or the host page's Start). The
TV picture comes from tvpipe's own browser showing the TV page. Closing
the window ends it all. To try it alone, `--dev` (test mode)
puts "Add a bot" and "Add 3 bots" on the host page: dummy players that
join and play by themselves; join with your phone (or the join link in
a browser tab), add two bots, start. `tvpipe game play --help`: tunnels (`--tunnel=opentunnel`,
`--no-tunnel`), the LAN (`--lan`), `--window`.

## Checking it

```sh
npm run check && npm test          # types; the rules, the prompts, whole games with bots in Node
npm run build && node test/live/play.ts   # a live game: tvpipe, headless Chrome, a phone, bots; screenshots in /tmp/drawbluff-play
node test/live/play.ts --lang de --rounds 2 --animate
node test/live/play.ts --long      # the longest titles there are (shots in /tmp/drawbluff-play-long)
node test/live/play.ts --shots ../../site/static/games/drawbluff   # the games list's pictures (test/live/scenario.ts)
```

`npm test`: the rules and scoring (the rule vectors in
`test/vectors/rules.txt`, written by `node test/vectors.ts --bless`),
the prompt files' lints in both languages (display form, length,
duplicates, structures) and the room's deck (no repeats),
whole games with 3, 8 and 50 bots on `@tvpipe/party`'s relay in memory
(a player who drops mid-game and comes back, one who leaves, too few
players to start and too few left for the next round (the game ends
there), the host closing a game and starting the next, late joiners in
every mode, the VIP removing a player, three
games in one room without a repeated prompt, a whole game in German,
a game of animated drawings).

`node test/live/play.ts [--zip] [--bots N] [--rounds N] [--lang en|de]
[--animate] [--long] [--out DIR] [--shots DIR] [--tunnel=PROVIDER]`
runs the real thing: `tvpipe game play` on the bundle (or the zip), a
headless Chrome as the window (the launcher, the host page), as a phone
(it joins, draws with touch events, lies and votes), as the TV page (the
watch link at 1280×720) and as the TV (the `browser` receiver's player
page: the TV page went through tvpipe's own headless Chrome and the
stream), each in a window of its own, and bots through the phones'
listener (the host page's bot buttons are for tests: they show only
with `?bots` in its URL or with `tvpipe game play --dev`). It takes
screenshots of the launcher, the host window, the TV and the phone
(also at 320 px wide) per phase and checks each: no text out of its box
or off the screen, no title cut off with an ellipsis or broken in a
word, and with `--lang de` (a German room and phone, shots in
`/tmp/drawbluff-de`) no English left. It drops a bot out and brings
it back by name, and has the phone forget everything, reload and join
again. Any page's script error (exceptions, `console.error`, failed
loads, over DevTools) and the bots' errors fail it too. `--animate` turns animated drawings on from the
VIP's phone and draws a second frame (copied from the first, the mouth
changed). `--long` deals the room's longest prompts (and those with the
longest words), the bots lie with the file's longest decoys and the
phone types a lie of 40 characters, with 7 bots (a gallery, full
reveals). `--shots DIR` writes the games list's pictures
(docs/game-catalog.md): the round of `test/live/scenario.ts` with
people's names, `tv-vote`, `phone-draw` and `phone-vote`. It needs
Chrome and a built tvpipe (`TVPIPE_BINARY`, else `target/release`, else
`target/debug`).
