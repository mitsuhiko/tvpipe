---
title: Latency
summary: The test pattern, measuring the delay, statistics.
group: Development
spec:
  Command: `debug pattern`
  Option: `--latency MS`
---

For development: how far the TV runs behind the source, and how to measure it.

## The test pattern

`tvpipe debug pattern --to TV` streams it. Its options are on [Debug commands](debug-commands.md).

![The test pattern: colour bars, a UTC clock, frame number and media time](shots/test-pattern.png "Colour bars, the UTC time at which the frame was made, the frame number and the media time. A square flashes and a beep sounds once a second."){.crt}

## Measuring

:::aside Measured
About 250 to 270 ms on an Apple TV 4K over Wi-Fi.
:::

1. Stream the test pattern to the TV.
2. Put a clock with milliseconds next to it, for example on the computer’s screen.
3. Photograph both. The difference between the clocks is the delay.

Phones stamp photos late. Photograph a millisecond clock on its own first and subtract that offset.

## Playout delay

`--latency` sets how long receivers wait before they show a frame, from 5 to 2000 ms. It is the same on every receiver of a session.

| Receivers | Default |
|---|---|
| AirPlay | video 100 ms, audio 170 ms |
| Cast | 300 ms |
| AirPlay and Cast | 300 ms |
| An LG TV, with sound | 300 ms, on every receiver of the session |
| Browser only | 100 ms |

Lower values drop frames on busy Wi-Fi.

## Player statistics

Press `S` on the player page for its statistics.

![The player with its statistics](shots/player-stats.png "The stream, the delay against its target, dropped frames, the decoder queue, audio sync and the time of the frame on screen.")
