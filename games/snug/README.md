# Snug

A cooperative tiling puzzle (our own rules, name and look) on
[`@tvpipe/party`](../../npm/party), for 2–8 players, in English and
German. Everyone fills **the same shape together**, with polyomino
pieces dealt to their phones in secret: **nobody sees anyone else's
pieces until they are on the board**. The team plays against one clock.

- **A shape**: on the TV and every phone, a quilted cushion to fill
  exactly. Each phone holds its own pieces (3 each with 2–3 players, 2
  with more, plus a spare nobody needs): candies of 3 to 5 cells with
  little faces. Turn them with a tap, flip them with ⇋, drag them onto
  the shape.
- **Placing is showing**: a placed piece is seen by everyone, and only
  its owner can move it (drag it) or take it back (tap it). The others
  steer out loud.
- **Pointing**: touching the shape shows a cursor in one's colour on the
  TV and every phone; a quick tap pings.
- **The clock**: one for the team. A filled shape stops it, gives time
  back and brings the next shape. Time's up shows how the shape would
  have gone and every hand; the score is how many shapes the room
  filled.
- **Checks**: tapping Check asks whether the board can still work out;
  the TV and every phone show the answer until something moves.
- **Levels**: every filled shape makes the next a little harder; the
  level says where that starts and how much help there is. Easy: small
  pieces and many ways to fill a shape, checks as often as you like,
  pieces that fit nowhere turn grey. Normal: tetrominoes first, 3
  checks (a filled shape gives one back). Hard: pentominoes, few ways,
  a check only when a filled shape earns one, no grey, taking a piece
  back costs 3 seconds.
- **The end**: shapes filled, the best of the session, and three awards
  (snuggest fit, pointer, second thoughts).

The rules, the numbers and why: [`docs/snug-design.md`](../../docs/snug-design.md).

It is a web app for [`tvpipe game play`](../../docs/playshare-design.md):
tvpipe serves it, the game runs in its host page (a window on the
computer), the TV page is cast to AirPlay and Chromecast receivers, and
phones join with the QR code.

| | | |
|---|---|---|
| `tvpipe.json` | the manifest | pages, 2–8 players, the TV's size; `root: dist` |
| `game/` | the rules (`rules.ts`: the pieces, the difficulty ladder and the checks, the generator, the solver, the deal, placing, the clock), the game (`game.ts`), bots (`bots.ts`) | TypeScript on `@tvpipe/party`, tested in Node |
| `host/` | the host page | tvpipe's standard host page (`HostPage`) with Snug's settings (`host.ts`) and its look (`host.css`); `strings.ts` (the status line) |
| `screen/` | the TV page | the lobby, a shape (the cushion, the candies, the cursors, the team, the clock) through solved and time's up, the end; sounds (`sound.js`); `strings.js` |
| `phone/` | the phone page | joining, the lobby (the VIP's settings), a shape with the hand below (drag, turn, flip, take back, point), the end; `candy.js` (the candies and the cushion, shared with the TV), `strings.js`, `fit.js` and `i18n.js` (Krakel's) |

## Running it

```sh
cargo build --release -p tvpipe-cli
(cd npm/party && npm ci && npm run build)
cd games/snug && npm install && npm run build
../../target/release/tvpipe game play .
```

Pick the TVs (or "A browser tab on this computer"), then Start. The
first player is the VIP and starts the game from their phone once two
are in (or the host page's Start). Settings (the host page, or the VIP's
phone in the lobby): the level (easy, normal, hard) and the clock
(relaxed, normal, rushed); on the host page only, the language and
latecomers (next shape, or not during a game). A phone away for 8
seconds passes its pieces to the others; the game ends at the next
shape when fewer than two players are left in it.

## Checking it

```sh
npm run check && npm test          # types; the rules and the solver, whole games with bots in Node (secrecy included)
node test/live/play.ts             # a live game: tvpipe, headless Chrome, a phone, bots; screenshots in /tmp/snug-play
node test/live/play.ts --lang de --level hard --bots 3
node test/live/play.ts --shots ../../site/static/games/snug   # the games list's pictures
```

Bots are for tests: the host page's bot buttons show only with `?bots`
in its URL or with `tvpipe game play --dev` (`?fast` there shortens the
clock), and the live check adds them through `snug.addBots`. They know
where the solution has their pieces (the host page knows), put them
there after thinking, and now and then drop one somewhere else first
and take it back; they wander their cursors and ping. The live check
needs Chrome and a built tvpipe (`TVPIPE_BINARY`, else
`target/release`, else `target/debug`); the phone turns and flips a
piece, drags its pieces onto the shape with touches, points, takes one
back, taps Check; it checks the phone at five sizes and the TV for anything out of
its box or under the join badge, and fails on any page's or bot's error.

## Languages

English and German. The language is the room's: a setting on the host
page, which starts with the browser's language and changes only between
games; a phone may switch for itself on the join screen, in the lobby
and at the end.

## The font

Fredoka (SIL OFL 1.1), in `phone/fonts/` with its license.
