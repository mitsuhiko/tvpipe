---
title: Quick start
summary: Find a TV, pair it once and play a file.
group: Start
---

Find a TV, pair it once and play a file.

## First steps

:::aside Network
The computer and the TV need to be on the same network.
:::

:::steps
### Find receivers
List the TVs on your network:

```sh
$ tvpipe discover
tvpipe · Looking for receivers

Found 2 receivers you can stream to:

  Living Room   AirPlay       AppleTV6,2   192.168.1.20   needs pairing
  Kitchen       Google Cast   Chromecast   192.168.1.31

Also found 2 speakers that play audio only (tvpipe streams video):
  Bathroom, Office

Stream to one: tvpipe play FILE --to "Living Room"
```

### Pair once (AirPlay only)
The first time, an Apple TV shows a PIN, and an AirPlay TV with a password asks for that password. Type it when tvpipe asks for it. Cast devices need no pairing.

```sh
$ tvpipe pair "Living Room"
```

### Play
Names are not case sensitive, and the start of a name is enough, so `liv` works too.

```sh
$ tvpipe play --to "Living Room" movie.mp4
```

### Stop
Press `q` or `Ctrl-C`. While something is on the TV, `q` asks first: press `q` again to stop, any other key to keep going. The TV leaves mirroring mode. A second `Ctrl-C` quits at once. Where the terminal takes no single keys, type `q` and press Enter, again when it asks.
:::

## Next

- [Send to two TVs](receivers.md) by repeating `--to`.
- [Share the screen or a browser tab](screen.md) instead of a file.
- [Put a web page on the TV](web-page.md).
