# FLX4

A browser version of the Pioneer DJ DDJ-FLX4: two decks, the 2-channel mixer,
Beat FX, Smart CFX / Smart Fader, all eight pad modes, and a rekordbox-style
screen with scrolling waveforms. Two demo tracks are synthesized on first load
so it plays with no files. Plug in a real FLX4 and it drives the same app.

```
npm install
npm run dev        # http://localhost:5173
npm test           # analysis + audio-thread DSP tests (Node 24+)
npm run build      # static site in dist/
```

Chrome or Edge recommended (Web MIDI and output-device selection). Safari
works without MIDI.

## What's in it

| Section | Controls |
|---|---|
| Deck | PLAY/PAUSE, CDJ-style CUE, SHIFT, jog (platter scratches in vinyl mode, ring bends, SHIFT searches), TEMPO slider (±6/10/16%/WIDE), BEAT SYNC (hold: master, SHIFT: range) |
| Loop | IN (hold or SHIFT: 4-beat), OUT, RELOOP/EXIT, CUE/LOOP CALL ◀ ▶ (halve/double, else step hot cues; SHIFT: jump 4) |
| Pads | HOT CUE / KEYBOARD, PAD FX1 / PAD FX2 (rolls, echo, trans, brake, backspin…), BEAT JUMP / BEAT LOOP, SAMPLER (16 slots) / KEY SHIFT |
| Mixer | TRIM, 3-band EQ (−26/+6 dB), CFX, channel CUE, faders with meters, crossfader, MASTER LEVEL, MASTER CUE, PHONES MIX/LEVEL, MIC LEVEL |
| Beat FX | Delay, Echo, Ping Pong, Spiral, Reverb, Trans, Flanger, Phaser, Filter, Helix; beat ◀ ▶, CH 1 / 2 / MASTER, LEVEL/DEPTH, ON (hold = momentary) |
| Screen | Master Tempo, Slip, Vinyl, Quantize, auto BPM + beat grid, auto-gain, instant doubles, REC to file |

Shortcuts are under `?` (or the backquote key). Drop audio anywhere to add it,
onto a deck to load it there, or onto a sampler pad to replace that sample.

## Headphones

Browsers have one output, so pick a cue mode from **Output**:

- **Split cue**: left ear cue, right ear master, on any headphones.
- **FLX4 4-ch**: set the controller as the system output; master goes to its
  outputs 1/2 and the cue mix to its headphone jack (3/4), like rekordbox.
- **Phones on another device**: cue to a second audio interface.

## Hardware

`CONNECT FLX4` uses Web MIDI. The message map follows the controller's MIDI
layout (cross-checked against Mixxx's DDJ-FLX4 mapping): jog at 720 ticks per
revolution, 14-bit tempo, LEDs on both the normal and SHIFT layers, and the
channel level meters. The last received message is shown next to the button,
which helps if anything maps differently on your unit. Not yet verified on a
physical controller.

## Layout

- `src/audio/deck-worklet.ts`: audio-thread playback (scratch, loops, slip,
  WSOLA time-stretch for Master Tempo / Key Shift)
- `src/audio/deck.ts`: deck logic (cue, hot cues, loops, sync, pad modes, jog)
- `src/audio/engine.ts`, `cfx.ts`, `fx.ts`: mixer graph, color FX, beat FX
- `src/audio/analysis.ts`: BPM, beat grid, 3-band waveform, loudness
- `src/bus.ts`: every control as a Param or Button, shared by UI, keyboard, MIDI
- `src/midi.ts`, `src/ui/`: hardware mapping and the on-screen surface
