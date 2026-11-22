---
title: Receivers
summary: Finding TVs, pairing and choosing where to send.
group: Use
spec:
  Commands: `discover`; `pair`, `unpair`
  Option: `--to`
---

A receiver is where tvpipe sends to: an Apple TV or AirPlay TV, a Chromecast or Google TV, or a browser tab on your computer.

## Finding receivers

:::aside Options
`--timeout SECS` How long to look. Default 3.

`--json` Every receiver with its addresses and what each protocol announces, for scripts.

`--interface ADDR` Also look on the network of this local address, for computers on several networks.
:::

```sh
$ tvpipe discover
tvpipe · Looking for receivers

Found 2 receivers you can stream to:

  Living Room   AirPlay       AppleTV6,2   192.168.1.20   paired
  Kitchen       Google Cast   Chromecast   192.168.1.31

Also found 2 speakers that play audio only (tvpipe streams video):
  Bathroom, Office

Stream to one: tvpipe play FILE --to "Living Room"
```

Speakers that only play sound are listed apart, because tvpipe streams video. You do not need to run `discover` before streaming. `--to` with a name finds the receiver by itself.

## Choosing with `--to`

:::aside Both protocols
TVs that speak AirPlay and Cast get Cast, unless you write `airplay:` before the name.
:::

| Form | Meaning |
|---|---|
| `"Living Room"`, `liv` | A name. Not case sensitive, and the start is enough. |
| `192.168.1.20` | A Cast receiver at this address. |
| `192.168.1.20:7000` | An AirPlay receiver at this address. |
| `airplay:NAME`, `cast:NAME` | A name, with the protocol to use. |
| `browser` | A browser tab on this computer. See [Playing to a browser](browser.md). |

## Several receivers

Repeat `--to` to send to several receivers at once. They all get the same stream.

```sh
$ tvpipe play --to "Living Room" --to Kitchen movie.mp4
```

## When a TV drops out

:::aside Option
`--reconnect SECS` How long to keep trying. Default 120, `0` turns it off.
:::

If a TV drops out while streaming, for example because it left the Wi-Fi or got a new address, tvpipe connects it again and the other receivers keep playing. A receiver given by name is looked up again, one given as an address is tried at that address. It comes back with the next full picture.

A TV where someone stopped mirroring on purpose stays off.

## Pairing

:::caution
The pairing is a private key in `credentials.txt` in the [config directory](config.md). Do not share that file.
:::

An Apple TV asks for a PIN the first time. `tvpipe pair` makes the TV show it and asks you to type it. `--pin` passes it directly.

An AirPlay TV with a password shows no PIN: `discover` lists it as "needs pairing (password)", and `tvpipe pair` asks for its AirPlay password, the one set in the Home app under Speakers & TV, or in the TV's AirPlay settings. It is not shown as you type.

```sh
$ tvpipe pair "Living Room"
$ tvpipe unpair "Living Room"
```

`unpair` forgets the pairing on this computer. Cast receivers need no pairing.

## TVs in an Apple Home

A TV in an Apple Home follows the Home's **Allow Speaker & TV Access**. With "Only People Sharing This Home" only the Home's members may stream to it: `discover` lists it as "home members only" and tvpipe stops with `home-only`. In the Home app, open Home Settings > Speakers & TV and choose "Anyone On the Same Network" (or "Everyone").
