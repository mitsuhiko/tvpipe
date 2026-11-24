# Seeking and pausing

`tvpipe play` of a file, or of a URL with a length, seeks and pauses
while it plays (GitHub issue #9). For people the keys do it, for
programs `Session::seek`/`pause`/`resume` and the machine interface's
`seek`, `pause` and `resume` commands; all three ask the same
`PlaybackControl` (`crates/tvpipe/src/playback.rs`), and the input does
it (`crates/tvpipe/src/media/input.rs`). Live inputs (capture after
`--`, stdin, the test pattern, a URL without a length) refuse.

## The keys

| Key | |
|---|---|
| ← / → | 10 s back / forward |
| ↓ / ↑ | a minute back / forward (mpv's and VLC's directions) |
| Space | pause / resume |

They need single keys (`crate::tty`: stty on Unix, the console mode on
Windows); in line mode there are none. They never touch the stop question
(`q` asks, a seek keeps it). Escape sequences are decoded by
`ui::confirm::Keys` (ECMA-48 CSI and SS3, modifiers ignored). The status
line shows the position and the length (`00:12:30 / 01:45:00`), `●
Paused` while paused, and a note names the keys once the file plays.

## One timeline for the receivers

The receivers never see time jump or go back. Each input keeps an output
timeline (`Timeline` in `media/input.rs`): every segment of the input
(the part after a seek, a restarted ffmpeg, a loop) gets an offset that
puts its start right after the last frame out, or where the output is
now when that is later (a pause lasted, ffmpeg took a while to start).
The offset is applied in each track's own ticks, the same for a whole
segment, so sample-exact audio (AirPlay's PCM framing) stays exact; a
track that would still go back is bunched up instead. The session's clock
and the sinks then see a continuous stream: a seek is a cut in the
pictures, a pause a stretch of repeated pictures without sound, which
the AirPlay sink handles like any gap in the audio (§8.2 of the spec).

Requests are coalesced: the latest pause state wins, and relative seeks
add up from the target of a seek the input has not taken yet, so holding
→ moves on smoothly. Forward seeks stop 3 s before the end (a seek never
ends the session by itself); with `--loop` they wrap around.

`Event::Playback` (`playback` on the wire: `position_ms`, `duration_ms`,
`paused`) goes out once streaming starts and after every applied seek,
pause and resume.

## Receivers need pictures while paused

A receiver that gets no frames gives up (Cast) or freezes in ways we do
not control, so a pause keeps sending pictures, about five a second.

**ffmpeg** (anything that is re-encoded). A running ffmpeg can neither
seek nor pause: not reading its output makes `-re` catch up in a burst
afterwards. So both start ffmpeg again (`FfmpegInput::apply`): a seek
with `-ss POS` before `-i` (exact: ffmpeg decodes from the keyframe
before and starts at the position), a pause with the picture at the
position frozen (`split[f][r];[f][r]freezeframes=first=1:…:replace=0`)
and the sound muted (`volume=0`), paced like the input and looped
(`-stream_loop -1`) so it never ends; resuming starts at the position
again. The new ffmpeg must make the stream the receivers were set up for
(the same size, rate and audio, an SPS that decodes the same), else the
session fails. Seeks that follow within 60 ms of each other (a key held
down) restart ffmpeg once. An ffmpeg without `freezeframes` (before 4.3)
pauses without pictures.

**Passthrough** (the file's own H.264). Seeks land on an IDR keyframe
near the target, in the direction of the seek, since nothing before a
keyframe decodes; audio starts at the keyframe (`FileSource::seek`). MP4
walks its sample tables in memory and reads only candidate keyframes
(`stss` entries that are not IDRs are skipped); fragmented MP4 reads the
`moof` boxes, never `mdat`. Matroska indexes its Clusters once (position
and Timestamp, skipping each by its size) and reads from the Cluster
before the first that starts after the target; Cues are not used, and an
unknown-size Cluster ends the index (seeks beyond it read on from there).

A pause cannot encode a new picture with the file's parameter sets, so it
sends **skip frames** (`media/h264skip.rs`, written from ITU-T H.264):
one slice of only P_Skip macroblocks, which copies the last reference
picture exactly.

- They are non-reference pictures (`nal_ref_idc` 0) with frame_num
  PrevRefFrameNum + 1: the DPB, PrevRefFrameNum and the POC state stay as
  they were, so the file's next frame decodes as if nothing came between.
  The module follows every access unit sent (parameter sets, slice
  headers, MMCO 5 and 6, long-term pictures) to know that state.
- All skip frames of a pause share one POC (there is one integer at most
  between two neighbouring POCs): the last picture's + 1 when the stream
  steps by 2 or more (x264), else the last picture's own (VideoToolbox
  steps by 1), so a tie is only with the copied picture or other copies.
  POC type 2 cannot express two non-reference pictures in a row; it means
  output in decoding order, and decoders take it.
- CABAC slices use cabac_init_idc 2 at SliceQPY 51, which makes skip the
  likely value: a 1080p skip frame is under 64 bytes.
- A skip frame copies the last *reference* picture, so a pause on a
  non-reference picture (VideoToolbox files alternate them) takes effect
  one frame later.
- Refused: field and MBAFF coding, separate colour planes, FMO, data
  partitioning, SVC/MVC. There the last keyframe is sent again instead;
  it shows an older picture and drops the references of the frames after
  it, so resuming then seeks back to that keyframe and plays from there.

A seek while paused shows the keyframe it landed on, then repeats it.

## Tests

- `playback.rs`: coalescing, clamping, wrapping, the pause toggle.
- `media/input.rs`: `passthrough_seeks_and_pauses` (x264 Baseline and
  High: pause mid-GOP, resume, seek forward, seek back while paused; what
  went out is decoded by ffmpeg and compared picture by picture with the
  file's own pictures), `ffmpeg_input_seeks_and_pauses` (position, pause,
  resume, seek back; the output timeline only goes forward).
- `media/h264skip/tests.rs`: skip frames spliced into x264, VideoToolbox
  and built-in streams of every POC type and entropy coder, decoded by
  ffmpeg frame-exact; slice headers against hand-computed bits; the CABAC
  encoder against a decoder written from §9.3.3.2.
- `media/passthrough.rs`, `mp4.rs`, `mkv.rs`: seek targets against a
  reference rule, the frames after a seek against a full playthrough, a
  one-hour MP4 seeking without reading media data.
- The CLI: the key decoder (`ui/confirm.rs`), the status line
  (`ui/snapshots/playback.*`), the machine commands
  (`machine/tests.rs`); the Node SDK's `PlaySession` (`test/stub.test.ts`).
- Not checked on hardware yet: how long Cast and AirPlay receivers take
  the repeated pictures, and pausing with sound on an LG TV.
