---
title: Playing in the browser
summary: The games of the list on a laptop or an iPad, without tvpipe.
group: Use
spec:
  Start: [tvpipe.party/games](/games/)
  Needs: a browser; the internet
  Games: [the games page](/games/)
  Another screen: `tvpipe.party/tv`
---

The [games](/games/) also run in a browser, with nothing to install: open [tvpipe.party/games](/games/) on a laptop or an iPad, press **Play now** under a game, say where it should show, and press Start. The browser runs the game; the phones join as they do with tvpipe, by the QR code or the code on the screen, and talk to it directly.

:::buttons
[Play in the browser](/games/)
:::

## Where the game shows

:::aside One question
The launcher asks "Where should the game show?" and selects the best answer for the device it runs on.
:::

| Answer | Offered | What happens |
|---|---|---|
| This screen, This iPad | always; the best on an iPad or a phone | the game fills the screen. The room's controls (players, settings, another game, the end) are behind ⋯ in the corner; they go back to the game by themselves after 20 seconds |
| The TV on the cable | Chrome and Edge, when a second screen is connected | the game opens full screen on the other screen; the laptop keeps the controls |
| A second window | other browsers on a computer | a window with the game's picture: drag it onto the TV or projector and click **Full screen** |
| Apple TV, by mirroring | iPad, iPhone, Mac | instructions: Control Center, Screen Mirroring, the Apple TV; then the game fills this screen and the TV shows it |
| Another screen | always | any browser shows the game: a smart TV's, a second laptop's (below) |
| Apple TV or Chromecast — with the tvpipe app | always | instead of Start, the two commands for a computer on the TV's Wi-Fi: the install and `tvpipe game play NAME` (below) |

Starting and the rounds stay on the first player's phone, as with tvpipe. Sound plays from the device that runs the game. While a game is open the screen stays on, where the browser allows it.

## Another screen

Any browser can show a game too: open `tvpipe.party/tv` on it, type the code the game shows under its QR code, and say yes on the device that runs the game. The screen follows the room from game to game and is not asked about again.

## Apple TV and Chromecast

:::caution
Chrome's "Cast tab" puts the TV about a second behind the phones: fine for drawing and word games, less for quick ones.
:::

A page cannot cast to a TV by itself. Three ways around it:

- **Mirroring** an iPad, iPhone or Mac to an Apple TV (Control Center, Screen Mirroring). The launcher shows the steps.
- **Chrome's "Cast tab"**: pick *A second window*, then in that window the browser's menu, *Cast…*, *Sources*, *Cast tab*, and the Chromecast (under "More" in the launcher).
- **The tvpipe app** casts to Apple TV and Chromecast itself, about a quarter of a second behind: [install it](install.md) and play with `tvpipe game play NAME` ([Party games](party.md)); it finds the TVs on its Wi-Fi and starts its own room, so the phones scan its QR code. Pick *Apple TV or Chromecast — with the tvpipe app* in the launcher on tvpipe.party for the two commands, with copy buttons.

## As an app

On an iPad or iPhone, Safari's Share, then **Add to Home Screen**, makes tvpipe.party an app that opens full screen on the games list. Chrome and Edge offer to install it from the address bar.

## What stays with tvpipe

Games from a folder or a zip, games from elsewhere (`gh:…`, `https://…`), development games (`tvpipe game play --dev`) and casting straight to TVs need the app. A reload of the page keeps the room and its code; the phones come back by name. Closing the tab ends the game.

## Privacy

tvpipe.party serves the pages and introduces the phones to the device that runs the game; the game itself goes from phone to browser directly, or through Cloudflare's relay when a network does not allow that. tvpipe.party keeps the room's code and its join link while the room is open, as it does for [short links](party.md).
