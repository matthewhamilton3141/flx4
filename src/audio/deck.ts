// Main-thread half of a deck: everything the left or right side of the
// controller does. Audio happens in deck-worklet.ts; this mirrors its state.

import type { WaveData } from './analysis.ts'
import type { DeckCmd, DeckReport } from './deck-worklet.ts'
import type { Channel, Sampler } from './engine.ts'
import { FxUnit, type Clock, type FxType } from './fx.ts'

export interface Cues {
  cue: number // -1: default (first beat)
  hot: (number | null)[]
}

export interface Track {
  id: number
  key: string
  name: string
  artist: string
  buffer: AudioBuffer | null
  duration: number
  bpm: number
  firstBeat: number
  gain: number
  wave: WaveData | null
  status: 'decoding' | 'analyzing' | 'ready' | 'error'
  cues: Cues
}

export type PadMode = 'hotcue' | 'keyboard' | 'padfx1' | 'padfx2' | 'beatjump' | 'beatloop' | 'sampler' | 'keyshift'
export type ModeButton = 'hotcue' | 'padfx1' | 'beatjump' | 'sampler'

export const ALT_MODE: Record<ModeButton, PadMode> = {
  hotcue: 'keyboard',
  padfx1: 'padfx2',
  beatjump: 'beatloop',
  sampler: 'keyshift',
}

export const TEMPO_RANGES = [0.06, 0.1, 0.16, 1]
export const BEAT_JUMPS = [-1, 1, -2, 2, -4, 4, -8, 8]
export const BEAT_LOOPS = [1 / 4, 1 / 2, 1, 2, 4, 8, 16, 32]
// rekordbox layout: top row 0 +1 +2 +3, bottom −3 −2 −1 0. With SHIFT the
// pads step relative: +1…+4 / −1…−4.
export const KEY_SHIFTS = [0, 1, 2, 3, -3, -2, -1, 0]
export const KEY_STEPS = [1, 2, 3, 4, -1, -2, -3, -4]
export const KEYBOARD = [4, 5, 6, 7, 0, 1, 2, 3]

export interface PadFx {
  label: string
  kind: 'roll' | 'fx' | 'brake' | 'spin'
  beats: number
  fx?: FxType
  depth?: number
}

export const PAD_FX: Record<'padfx1' | 'padfx2', PadFx[]> = {
  padfx1: [
    { label: 'ROLL 1/16', kind: 'roll', beats: 1 / 16 },
    { label: 'ROLL 1/8', kind: 'roll', beats: 1 / 8 },
    { label: 'ROLL 1/4', kind: 'roll', beats: 1 / 4 },
    { label: 'ROLL 1/2', kind: 'roll', beats: 1 / 2 },
    { label: 'ECHO 1/2', kind: 'fx', beats: 1 / 2, fx: 'echo', depth: 0.6 },
    { label: 'ECHO 1', kind: 'fx', beats: 1, fx: 'echo', depth: 0.6 },
    { label: 'TRANS 1/4', kind: 'fx', beats: 1 / 4, fx: 'trans', depth: 1 },
    { label: 'BRAKE', kind: 'brake', beats: 0 },
  ],
  padfx2: [
    { label: 'ROLL 1', kind: 'roll', beats: 1 },
    { label: 'REVERB', kind: 'fx', beats: 1, fx: 'reverb', depth: 0.7 },
    { label: 'SPIRAL 1/2', kind: 'fx', beats: 1 / 2, fx: 'spiral', depth: 0.7 },
    { label: 'HELIX 1/2', kind: 'fx', beats: 1 / 2, fx: 'helix', depth: 0.9 },
    { label: 'FLANGER 4', kind: 'fx', beats: 4, fx: 'flanger', depth: 0.6 },
    { label: 'PHASER 4', kind: 'fx', beats: 4, fx: 'phaser', depth: 0.7 },
    { label: 'FILTER 2', kind: 'fx', beats: 2, fx: 'filter', depth: 0.9 },
    { label: 'BACKSPIN', kind: 'spin', beats: 0 },
  ],
}

export interface DeckEnv {
  other(d: Deck): Deck
  master(): Deck
  setMaster(d: Deck): void
  quantize(): boolean
  sampler: Sampler
  saveCues(t: Track): void
  onPlayState(d: Deck): void
}

const frac = (x: number): number => x - Math.floor(x)

// 16 sampler slots: left pads play 1–4 and 9–12, right pads 5–8 and 13–16.
export function samplerSlot(deck: 1 | 2, pad: number): number {
  return (pad < 4 ? pad : pad + 4) + (deck === 2 ? 4 : 0)
}

export class Deck {
  readonly n: 1 | 2
  readonly node: AudioWorkletNode
  readonly fx: FxUnit
  readonly ch: Channel
  readonly clock: Clock
  track: Track | null = null
  playing = false
  tempo = 0
  rangeIdx = 1
  keylock = false
  semis = 0
  vinyl = true
  slip = false
  sync = false
  rate = 1
  smartRate: number | null = null
  holdRate: number | null = null // keeps tempo when a synced deck becomes master
  selHot = -1
  loop = { on: false, in: -1, out: -1 }
  padMode: PadMode = 'hotcue'
  padsDown: boolean[] = new Array(8).fill(false)
  touching = false
  cuePreview = false
  hotPreview = -1
  private readonly ctx: AudioContext
  private readonly env: DeckEnv
  private readonly sr: number
  private wPos = 0
  private wTime = 0
  private wRate = 0
  private seq = 0
  private syncMul = 1
  private tempoAtSync = 0
  private playDuringPreview = false
  private loopInTimer = 0
  private loopInLong = false
  private pendingIn = -1
  private syncTimer = 0
  private syncLong = false
  private fxPad = -1
  private rolls = 0
  private rollSaved: { on: boolean; in: number; out: number } | null = null
  private slipRefs = 0
  private slipScratch = false
  private slipHot = false

  constructor(n: 1 | 2, ctx: AudioContext, ch: Channel, ir: AudioBuffer, env: DeckEnv) {
    this.n = n
    this.ctx = ctx
    this.ch = ch
    this.env = env
    this.sr = ctx.sampleRate
    this.node = new AudioWorkletNode(ctx, 'flx4-deck', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    })
    this.node.port.onmessage = (e: MessageEvent<DeckReport>) => this.onReport(e.data)
    this.clock = { bpm: () => this.bpm, nextBeat: () => this.nextBeatTime() }
    this.fx = new FxUnit(ctx, this.clock, ir)
    this.node.connect(this.fx.input)
    this.fx.output.connect(ch.input)
  }

  // ── state mirror ────────────────────────────────────────────────────────

  private onReport(m: DeckReport): void {
    if (m.seq < this.seq) return
    if (m.t === 'ended') {
      this.playing = false
      this.env.onPlayState(this)
      return
    }
    this.wPos = m.pos / this.sr
    this.wTime = m.time
    this.wRate = m.rate
    if (m.playing !== this.playing) {
      this.playing = m.playing
      this.env.onPlayState(this)
    }
  }

  get pos(): number {
    const dt = Math.max(-0.05, Math.min(0.1, this.ctx.currentTime - this.wTime))
    return this.wPos + dt * this.wRate
  }

  get duration(): number {
    return this.track?.duration ?? 0
  }

  get bpm(): number {
    return this.track?.bpm ? this.track.bpm * this.rate : 0
  }

  get beatLen(): number {
    return this.track?.bpm ? 60 / this.track.bpm : 0
  }

  get hot(): (number | null)[] {
    return this.track?.cues.hot ?? []
  }

  get cuePoint(): number {
    const t = this.track
    if (!t) return 0
    if (t.cues.cue >= 0) return t.cues.cue
    return t.bpm && t.firstBeat >= 0 ? t.firstBeat : 0
  }

  beatAt(t: number): number {
    return this.beatLen ? (t - this.track!.firstBeat) / this.beatLen : 0
  }

  timeOfBeat(b: number): number {
    return this.track!.firstBeat + b * this.beatLen
  }

  private quant(): boolean {
    return this.env.quantize() && this.beatLen > 0
  }

  private snap(t: number): number {
    return this.quant() ? this.timeOfBeat(Math.round(this.beatAt(t))) : t
  }

  private floorGrid(t: number, grid: number): number {
    return this.timeOfBeat(Math.floor(this.beatAt(t) / grid + 1e-4) * grid)
  }

  nextBeatTime(): number {
    const now = this.ctx.currentTime
    if (!this.beatLen || !this.playing || this.rate <= 0) return now
    const b = this.beatAt(this.pos)
    return now + ((Math.ceil(b) - b) * this.beatLen) / this.rate
  }

  private post(c: DeckCmd): void {
    this.node.port.postMessage(c)
  }

  private mark(pos: number): void {
    this.wPos = pos
    this.wTime = this.ctx.currentTime
  }

  // ── transport ───────────────────────────────────────────────────────────

  load(t: Track, from?: Deck): void {
    if (!t.buffer) return
    this.releasePads()
    this.cuePreview = false
    this.hotPreview = -1
    this.track = t
    this.seq++
    const b = t.buffer
    const pos = from ? from.pos : this.cuePoint
    this.post({
      t: 'load',
      L: b.getChannelData(0),
      R: b.getChannelData(b.numberOfChannels > 1 ? 1 : 0),
      pos: pos * this.sr,
      seq: this.seq,
    })
    this.playing = false
    this.wRate = 0
    this.mark(pos)
    // Copying the samples above blocks for a few ms while the source deck keeps
    // moving; re-seek with a fresh position so doubles stay sample-tight.
    if (from) {
      this.seq++
      this.post({ t: 'seek', pos: from.pos * this.sr, seq: this.seq, t0: this.ctx.currentTime, follow: from.playing ? from.rate : 0 })
    }
    this.loop = { on: false, in: -1, out: -1 }
    this.selHot = -1
    this.semis = 0
    this.slipRefs = 0
    if (from) {
      this.tempo = from.tempo
      this.rangeIdx = from.rangeIdx
      this.keylock = from.keylock
      this.semis = from.semis
      this.loop = { ...from.loop }
      if (this.loop.on) this.postLoop()
    }
    this.ch.setAutoGain(t.gain)
    this.pushPitch()
    this.applyRate()
    if (from?.playing) this.setPlaying(true)
    this.env.onPlayState(this)
  }

  // Analysis finished after the track was loaded.
  trackUpdated(): void {
    const t = this.track
    if (!t) return
    this.ch.setAutoGain(t.gain)
    if (!this.playing && this.pos < 0.05 && t.cues.cue < 0) this.seek(this.cuePoint)
    this.applyRate()
  }

  seek(t: number, at?: number): void {
    if (!this.track) return
    t = Math.max(0, Math.min(this.duration, t))
    this.seq++
    if (at !== undefined) {
      this.post({ t: 'seek', pos: t * this.sr, at: at * this.sr, seq: this.seq })
    } else {
      this.post({ t: 'seek', pos: t * this.sr, seq: this.seq })
      this.mark(t)
    }
  }

  // Jump to a cue; with quantize on while playing, wait for the next beat.
  private jumpTo(t: number): void {
    if (this.playing && this.quant()) {
      const nb = this.timeOfBeat(Math.ceil(this.beatAt(this.pos) + 0.02))
      this.seek(t, nb)
    } else this.seek(t)
  }

  setPlaying(on: boolean): void {
    if (!this.track || on === this.playing) return
    if (on && this.pos >= this.duration - 0.02) return
    this.mark(this.pos)
    this.seq++
    this.post({ t: 'play', on, seq: this.seq })
    this.playing = on
    this.env.onPlayState(this)
  }

  playBtn(down: boolean, shift: boolean): void {
    if (!down || !this.track) return
    if (shift) {
      this.seek(this.cuePoint)
      this.setPlaying(true)
      return
    }
    if (this.cuePreview || this.hotPreview >= 0) {
      this.playDuringPreview = true
      return
    }
    if (!this.playing && this.sync) this.alignPhase()
    this.setPlaying(!this.playing)
  }

  // CDJ cue: playing → back to cue and pause. Paused off the cue → set a new
  // cue here. Paused on the cue → play while held, return on release.
  cueBtn(down: boolean, shift: boolean): void {
    const t = this.track
    if (!t) return
    if (down) {
      if (shift) {
        this.seek(0)
        return
      }
      if (this.playing && !this.cuePreview) {
        this.setPlaying(false)
        this.seek(this.cuePoint)
        return
      }
      if (Math.abs(this.pos - this.cuePoint) > 0.01) {
        t.cues.cue = this.snap(this.pos)
        this.env.saveCues(t)
        this.seek(t.cues.cue)
        return
      }
      this.cuePreview = true
      this.playDuringPreview = false
      this.setPlaying(true)
    } else if (this.cuePreview) {
      this.cuePreview = false
      if (!this.playDuringPreview) {
        this.setPlaying(false)
        this.seek(this.cuePoint)
      }
    }
  }

  // ── tempo & sync ────────────────────────────────────────────────────────

  setTempo(v: number, byUser: boolean): void {
    this.tempo = v
    if (byUser) {
      this.holdRate = null
      if (this.sync && Math.abs(v - this.tempoAtSync) > 0.04) this.sync = false
    }
    this.applyRate()
  }

  cycleRange(): void {
    this.rangeIdx = (this.rangeIdx + 1) % TEMPO_RANGES.length
    this.applyRate()
  }

  get sliderRate(): number {
    return 1 + this.tempo * TEMPO_RANGES[this.rangeIdx]
  }

  applyRate(): void {
    let r = this.sliderRate
    const m = this.env.master()
    if (this.smartRate !== null) {
      r = this.smartRate
    } else if (this.sync && m === this && this.holdRate !== null) {
      r = this.holdRate
    } else if (this.sync && m !== this && m.track?.bpm && this.track?.bpm) {
      const ratio = m.bpm / this.track.bpm
      let best = 1
      let err = Infinity
      for (const k of [0.5, 1, 2]) {
        const e = Math.abs(Math.log2(ratio * k))
        if (e < err) {
          err = e
          best = k
        }
      }
      this.syncMul = best
      r = ratio * best
    }
    r = Math.max(0, r)
    if (this.playing) {
      this.mark(this.pos)
      this.wRate = r
    }
    this.rate = r
    this.post({ t: 'rate', v: r })
    if (m === this) {
      const o = this.env.other(this)
      if (o.sync) o.applyRate()
    }
  }

  alignPhase(): void {
    const m = this.env.master()
    if (m === this || !m.track?.bpm || !this.track?.bpm || !m.playing) return
    const want = frac(m.beatAt(m.pos) * this.syncMul)
    let d = want - frac(this.beatAt(this.pos))
    d -= Math.round(d)
    if (Math.abs(d) > 0.002) this.seek(this.pos + d * this.beatLen)
  }

  syncBtn(down: boolean, shift: boolean): void {
    if (shift) {
      if (down) this.cycleRange()
      return
    }
    if (down) {
      this.syncLong = false
      this.syncTimer = window.setTimeout(() => {
        this.syncLong = true
        this.env.setMaster(this)
      }, 1000)
    } else {
      clearTimeout(this.syncTimer)
      if (!this.syncLong) this.toggleSync()
    }
  }

  toggleSync(): void {
    if (!this.track?.bpm) return
    this.sync = !this.sync
    if (this.sync) {
      const o = this.env.other(this)
      if (this.env.master() === this && o.track?.bpm) this.env.setMaster(o)
      this.tempoAtSync = this.tempo
      this.applyRate()
      this.alignPhase()
    } else {
      this.holdRate = null
      this.applyRate()
    }
  }

  toggleKeylock(): void {
    this.keylock = !this.keylock
    this.pushPitch()
  }

  setSemis(v: number): void {
    this.semis = Math.max(-12, Math.min(12, v))
    this.pushPitch()
  }

  private pushPitch(): void {
    this.post({ t: 'pitch', keylock: this.keylock, semis: this.semis })
  }

  // ── loops ───────────────────────────────────────────────────────────────

  private postLoop(): void {
    const l = this.loop
    this.post({ t: 'loop', on: l.on, start: l.in * this.sr, end: l.out * this.sr })
  }

  loopInBtn(down: boolean, shift: boolean): void {
    if (!this.track) return
    if (down) {
      if (shift) {
        this.beatLoop(4, false)
        return
      }
      this.pendingIn = this.snap(this.pos)
      this.loopInLong = false
      this.loopInTimer = window.setTimeout(() => {
        this.loopInLong = true
        this.beatLoop(4, false)
      }, 600)
    } else {
      clearTimeout(this.loopInTimer)
      if (this.loopInLong || this.pendingIn < 0) return
      this.loop = { on: false, in: this.pendingIn, out: -1 }
      this.pendingIn = -1
      this.postLoop()
    }
  }

  loopOutBtn(down: boolean): void {
    if (!down || !this.track || this.loop.in < 0) return
    let out = this.snap(this.pos)
    if (out <= this.loop.in + 0.005) {
      if (!this.beatLen || this.pos < this.loop.in) return
      out = this.loop.in + this.beatLen
    }
    this.loop.out = out
    this.loop.on = true
    this.postLoop()
  }

  reloopBtn(down: boolean, shift: boolean): void {
    if (!down || !this.track) return
    if (shift) {
      this.loop = { on: false, in: -1, out: -1 }
      this.postLoop()
      return
    }
    if (this.loop.on) {
      this.loop.on = false
      this.postLoop()
    } else if (this.loop.in >= 0 && this.loop.out > this.loop.in) {
      this.loop.on = true
      this.jumpTo(this.loop.in)
      this.postLoop()
    }
  }

  // CUE/LOOP CALL ◀ ▶: halve/double an active loop, otherwise step through
  // hot cues. With SHIFT: beat jump 4.
  callBtn(dir: -1 | 1, down: boolean, shift: boolean): void {
    if (!down || !this.track) return
    if (shift) {
      this.beatJump(4 * dir)
      return
    }
    const l = this.loop
    if (l.on) {
      const len = l.out - l.in
      const next = dir < 0 ? len / 2 : len * 2
      if (next < 0.005 || l.in + next > this.duration) return
      l.out = l.in + next
      this.postLoop()
      return
    }
    const p = this.pos
    const pts = [...this.hot.filter((h): h is number => h !== null), this.cuePoint].sort((a, b) => a - b)
    const target = dir < 0 ? [...pts].reverse().find((h) => h < p - 0.3) : pts.find((h) => h > p + 0.05)
    if (target !== undefined) this.seek(target)
  }

  beatLoop(beats: number, toggle = true): void {
    if (!this.track) return
    const len = beats * (this.beatLen || 0.5)
    const l = this.loop
    if (toggle && l.on && Math.abs(l.out - l.in - len) < 1e-3) {
      l.on = false
      this.postLoop()
      return
    }
    const start = this.quant() ? this.floorGrid(this.pos, Math.min(beats, 1)) : this.pos
    this.loop = { on: true, in: start, out: start + len }
    this.postLoop()
  }

  beatJump(beats: number): void {
    if (!this.track) return
    const d = beats * (this.beatLen || 0.5)
    this.seek(this.pos + d)
    if (this.loop.on) {
      this.loop.in += d
      this.loop.out += d
      this.postLoop()
    }
  }

  private slipHold(on: boolean): void {
    if (on) {
      if (this.slipRefs++ === 0) this.post({ t: 'slip', on: true })
    } else if (this.slipRefs > 0 && --this.slipRefs === 0) {
      this.post({ t: 'slip', on: false })
    }
  }

  private roll(beats: number, down: boolean): void {
    if (!this.track) return
    if (down) {
      if (this.rolls++ === 0) {
        this.rollSaved = { ...this.loop }
        this.slipHold(true)
      }
      const len = beats * (this.beatLen || 0.5)
      const start = this.beatLen ? this.floorGrid(this.pos, Math.min(beats, 1)) : this.pos
      this.loop = { on: true, in: start, out: start + len }
      this.postLoop()
    } else if (this.rolls > 0 && --this.rolls === 0) {
      this.loop = { ...(this.rollSaved ?? { in: -1, out: -1 }), on: false }
      this.postLoop()
      this.slipHold(false)
    }
  }

  private brake(down: boolean, spin: boolean): void {
    if (down) {
      this.slipHold(true)
      this.post({ t: 'ramp', on: true, from: spin ? -4 : NaN, to: 0, ms: spin ? 1400 : 900 })
    } else {
      this.post({ t: 'ramp', on: false, from: 0, to: 0, ms: 0 })
      this.slipHold(false)
    }
  }

  // ── pads ────────────────────────────────────────────────────────────────

  modeBtn(m: ModeButton, down: boolean, shift: boolean): void {
    if (!down) return
    const next = shift ? ALT_MODE[m] : m
    if (next !== this.padMode) this.releasePads()
    this.padMode = next
  }

  releasePads(): void {
    for (let i = 0; i < 8; i++) if (this.padsDown[i]) this.pad(i, false, false)
  }

  pad(i: number, down: boolean, shift: boolean): void {
    if (down === this.padsDown[i]) return
    this.padsDown[i] = down
    switch (this.padMode) {
      case 'hotcue':
        return this.hotCue(i, down, shift)
      case 'keyboard': {
        if (!down || !this.track) return
        if (shift) return this.setSemis(0)
        this.setSemis(KEYBOARD[i])
        const h = this.selHot >= 0 ? this.hot[this.selHot] : null
        this.seek(h ?? this.cuePoint)
        this.setPlaying(true)
        return
      }
      case 'padfx1':
      case 'padfx2':
        return this.padFx(this.padMode, i, down)
      case 'beatjump':
        if (down) this.beatJump(BEAT_JUMPS[i] * (shift ? 4 : 1))
        return
      case 'beatloop':
        if (down) this.beatLoop(BEAT_LOOPS[i])
        return
      case 'sampler': {
        if (!down) return
        const slot = samplerSlot(this.n, i)
        if (shift) this.env.sampler.stop(slot)
        else this.env.sampler.trigger(slot)
        return
      }
      case 'keyshift':
        if (!down) return
        return this.setSemis(shift ? this.semis + KEY_STEPS[i] : KEY_SHIFTS[i])
    }
  }

  private hotCue(i: number, down: boolean, shift: boolean): void {
    const t = this.track
    if (!t) return
    const cues = t.cues.hot
    if (down) {
      if (shift) {
        cues[i] = null
        this.env.saveCues(t)
        return
      }
      if (cues[i] === null || cues[i] === undefined) {
        cues[i] = this.snap(this.pos)
        this.selHot = i
        this.env.saveCues(t)
        return
      }
      this.selHot = i
      const target = cues[i]!
      if (this.playing && !this.cuePreview && this.hotPreview < 0) {
        if (this.slip) {
          this.slipHold(true)
          this.slipHot = true
        }
        this.jumpTo(target)
        return
      }
      this.seek(target)
      if (!this.playing) {
        this.hotPreview = i
        this.playDuringPreview = false
        this.setPlaying(true)
      }
    } else {
      if (this.slipHot) {
        this.slipHot = false
        this.slipHold(false)
      }
      if (this.hotPreview === i) {
        this.hotPreview = -1
        if (!this.playDuringPreview) {
          this.setPlaying(false)
          this.seek(cues[i] ?? this.pos)
        }
      }
    }
  }

  private padFx(bank: 'padfx1' | 'padfx2', i: number, down: boolean): void {
    const p = PAD_FX[bank][i]
    if (p.kind === 'roll') return this.roll(p.beats, down)
    if (p.kind === 'brake' || p.kind === 'spin') return this.brake(down, p.kind === 'spin')
    const key = (bank === 'padfx2' ? 8 : 0) + i
    if (down) {
      this.fxPad = key
      this.fx.setType(p.fx!)
      this.fx.setBeat(p.beats)
      this.fx.setDepth(p.depth ?? 0.6)
      this.fx.setOn(true)
    } else if (this.fxPad === key) {
      this.fx.setOn(false)
      this.fxPad = -1
    }
  }

  // ── jog ─────────────────────────────────────────────────────────────────

  jogTouch(on: boolean): void {
    if (on === this.touching) return
    this.touching = on
    if (!this.vinyl || !this.track) return
    if (on && this.slip && this.playing) {
      this.slipHold(true)
      this.slipScratch = true
    }
    this.post({ t: 'scratch', on })
    if (!on && this.slipScratch) {
      this.slipScratch = false
      this.slipHold(false)
    }
  }

  // revs: wheel rotation in revolutions; top: platter surface vs. outer ring.
  jogTurn(revs: number, top: boolean, shift: boolean): void {
    if (!this.track) return
    if (shift) {
      this.seek(this.pos + revs * 16)
      return
    }
    if (top && this.vinyl && this.touching) this.post({ t: 'jog', d: revs * 1.8 * this.sr })
    else if (this.playing) this.post({ t: 'bend', d: revs * 1.2 })
    else this.post({ t: 'jog', d: revs * 1.8 * this.sr })
  }
}
