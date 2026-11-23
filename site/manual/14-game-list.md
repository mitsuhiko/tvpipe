---
title: The games list
summary: Games played by name: where they come from, and adding yours.
group: Use
spec:
  Command: `tvpipe game play NAME`
  The list: `games.json` on this site
  Pictures: [the games page](/games/)
---

Party games are not part of tvpipe. Each one comes out on its own, and `tvpipe game play NAME` downloads the newest release that fits your tvpipe, asks you once whether to run it, and keeps it for next time. The games, with pictures of each: [the games page](/games/). [Party games](party.md) covers playing.

## Playing one

```sh
$ tvpipe game play drawbluff
```

:::aside Offline
`--offline` plays a game downloaded before, without the network.
:::

The first time, tvpipe shows where the game comes from, its size and its checksum, and asks before it runs it: a game runs in tvpipe's window and can cast to your TVs. tvpipe asks again when a new release comes out. `--yes` skips the question.

The list comes from [games.json](https://tvpipe.party/games.json) on this site, which tvpipe reads when you play a game by name. `tvpipe game list` shows the games you have downloaded.

## Adding a game

A game on this list is a game anyone can play by name. Publish it as a release (see [Share it](making-games.md#s7)), then open a pull request that adds it to `site/static/games.json` in the [repository](https://github.com/mitsuhiko/tvpipe), with its screenshots in `site/static/games/NAME/`: at least one, the first of the TV the cover (here and in tvpipe's window). Take them while playing a real round with a few people:

| Kind | Size | |
|---|---|---|
| `tv` | 1280×720 | the TV page at a lively moment: a vote, a reveal, the results |
| `phone` | 390×844 | the phone page: what a player does, one or two |

Each a PNG, JPEG or WebP of at most 400 KiB, with an `alt` text that says what it shows. `node site/social.mjs NAME` then makes the game's link preview from its title, players, cover and first phone picture (`site/static/social/games/NAME.jpg`, the picture chat apps and social sites show for a link to its page). `python3 site/build.py` checks the entry, the pictures and the preview. Everyone can also play a game from its release without the list: `tvpipe game play gh:OWNER/REPO`.
