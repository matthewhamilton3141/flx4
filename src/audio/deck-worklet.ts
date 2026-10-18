// Audio-thread half of a deck. One processor per deck: variable-rate playback
// (negative rates when scratching), sample-accurate loops, slip, and a WSOLA
// time-stretcher that keeps pitch fixed for Master Tempo and Key Shift.

declare const sampleRate: number
declare const currentTime: number
declare function registerProcessor(name: string, ctor: unknown): void
declare class AudioWorkletProcessor {
  readonly port: MessagePort
}

export type DeckCmd =
  | { t: 'load'; L: Float32Array; R: Float32Array; pos: number; seq: number }
  | { t: 'unload'; seq: number }
  | { t: 'play'; on: boolean; seq: number }
  | { t: 'rate'; v: number }
  // at: jump when the playhead crosses this sample. t0/follow: pos was valid
  // at context time t0 for a source moving at rate `follow`; catch up on arrival.
  | { t: 'seek'; pos: number; seq: number; at?: number; t0?: number; follow?: number }
  | { t: 'scratch'; on: boolean }
  | { t: 'jog'; d: number }
  | { t: 'bend'; d: number }
  | { t: 'loop'; on: boolean; start: number; end: number }
  | { t: 'slip'; on: boolean }
  | { t: 'pitch'; keylock: boolean; semis: number }
  | { t: 'ramp'; on: boolean; from: number; to: number; ms: number }

export type DeckReport =
  | { t: 'pos'; pos: number; rate: number; playing: boolean; seq: number; time: number }
  | { t: 'ended'; seq: number }

const XFADE = 96
const REPORT_EVERY = 512
const MAX_SCRATCH = 12

function hermite(a: number, b: number, c: number, d: number, f: number): number {
  const c1 = 0.5 * (c - a)
  const c2 = a - 2.5 * b + 2 * c - 0.5 * d
  const c3 = 0.5 * (d - a) + 1.5 * (b - c)
  return ((c3 * f + c2) * f + c1) * f + b
}

export class DeckProcessor extends AudioWorkletProcessor {
  L: Float32Array = new Float32Array(0)
  R: Float32Array = new Float32Array(0)
  len = 0
  pos = 0
  playing = false
  baseRate = 1
  rate = 0
  bend = 0
  bendTarget = 0
  scratching = false
  autoScratch = 0
  scratchTarget = 0
  loopOn = false
  loopStart = 0
  loopEnd = 0
  slipOn = false
  slipPos = 0
  keylock = false
  semis = 0
  pitch = 1
  rampOn = false
  rampFrom = 0
  rampTo = 0
  rampN = 0
  rampLen = 1
  xfN = 0
  xfPos = 0
  pendAt = -1
  pendPos = 0
  gSrc = new Float64Array(2)
  gT = new Float64Array(2)
  wasStretch = false
  seq = 0
  sinceReport = 0
  sL = 0
  sR = 0
  readonly G: number
  readonly search: number
  readonly win: Float32Array
  readonly tau: number

  constructor() {
    super()
    this.G = sampleRate > 60000 ? 4096 : 2048
    this.search = this.G >> 2
    this.win = new Float32Array(this.G)
    for (let i = 0; i < this.G; i++) {
      const s = Math.sin((Math.PI * i) / this.G)
      this.win[i] = s * s
    }
    this.tau = 0.008 * sampleRate
    this.port.onmessage = (e: MessageEvent<DeckCmd>) => this.cmd(e.data)
  }

  cmd(m: DeckCmd): void {
    switch (m.t) {
      case 'load':
        this.L = m.L
        this.R = m.R
        this.len = m.L.length
        this.pos = m.pos
        this.playing = false
        this.rate = 0
        this.loopOn = false
        this.slipOn = false
        this.scratching = false
        this.xfN = 0
        this.pendAt = -1
        this.seq = m.seq
        break
      case 'unload':
        this.len = 0
        this.playing = false
        this.seq = m.seq
        break
      case 'play':
        this.playing = m.on
        this.seq = m.seq
        break
      case 'rate':
        this.baseRate = m.v
        break
      case 'seek':
        if (m.at !== undefined && m.at >= 0) {
          this.pendAt = m.at
          this.pendPos = m.pos
        } else {
          this.pendAt = -1
          // + 1/0.02 samples: the start ramp below lags a following play by that much.
          const late = m.t0 !== undefined && m.follow ? (Math.max(0, currentTime - m.t0) * sampleRate + 50) * m.follow : 0
          this.jump(m.pos + late)
        }
        this.seq = m.seq
        break
      case 'scratch':
        this.scratching = m.on
        this.autoScratch = 0
        if (m.on) this.scratchTarget = this.pos
        break
      case 'jog':
        if (!this.scratching) {
          if (this.autoScratch === 0) this.scratchTarget = this.pos
          this.autoScratch = (0.1 * sampleRate) | 0
        }
        this.scratchTarget += m.d
        break
      case 'bend':
        this.bendTarget = Math.max(-0.9, Math.min(0.9, this.bendTarget + m.d))
        break
      case 'loop':
        this.loopOn = m.on && m.end > m.start
        this.loopStart = m.start
        this.loopEnd = m.end
        if (this.loopOn && this.pos >= this.loopEnd && this.pos - this.loopStart < 64 * sampleRate * 8) {
          const span = this.loopEnd - this.loopStart
          this.jump(this.loopStart + ((this.pos - this.loopStart) % span))
        }
        break
      case 'slip':
        if (m.on) {
          if (!this.slipOn) this.slipPos = this.pos
          this.slipOn = true
        } else if (this.slipOn) {
          this.slipOn = false
          this.jump(this.slipPos)
        }
        break
      case 'pitch':
        this.keylock = m.keylock
        this.semis = m.semis
        this.pitch = Math.pow(2, m.semis / 12)
        break
      case 'ramp':
        this.rampOn = m.on
        if (m.on) {
          this.rampFrom = Number.isNaN(m.from) ? this.rate : m.from
          this.rampTo = m.to
          this.rampN = 0
          this.rampLen = Math.max(1, (m.ms * sampleRate) / 1000)
          if (!Number.isNaN(m.from)) this.rate = m.from
        }
        break
    }
  }

  // Discontinuous move: crossfade from where we were so it never clicks.
  jump(to: number): void {
    this.xfPos = this.pos
    this.xfN = XFADE
    this.pos = to
    this.gSrc[0] = to
    this.gT[0] = this.G / 2
    this.gSrc[1] = to
    this.gT[1] = 0
  }

  wrap(x: number): number {
    if (this.loopOn && x >= this.loopEnd) {
      const span = this.loopEnd - this.loopStart
      while (x >= this.loopEnd) x -= span
    }
    return x
  }

  read(x: number): void {
    const i = Math.floor(x)
    if (i < 1 || i >= this.len - 2) {
      if (i < 0 || i >= this.len) {
        this.sL = 0
        this.sR = 0
      } else {
        this.sL = this.L[i]
        this.sR = this.R[i]
      }
      return
    }
    const f = x - i
    const L = this.L
    const R = this.R
    this.sL = hermite(L[i - 1], L[i], L[i + 1], L[i + 2], f)
    this.sR = hermite(R[i - 1], R[i], R[i + 1], R[i + 2], f)
  }

  // WSOLA: re-start grain g near the transport position, at the offset whose
  // waveform best continues what the other (currently loudest) grain is playing.
  reanchor(g: number, adv: number): void {
    const ref = this.wrap(this.gSrc[1 - g])
    const ideal = this.pos
    const L = this.L
    const R = this.R
    const len = this.len
    const score = (c: number): number => {
      let xy = 0
      let yy = 1e-9
      for (let j = 0; j < 256; j += 4) {
        const a = Math.round(ref + j * adv)
        const b = Math.round(c + j * adv)
        if (a < 0 || b < 0 || a >= len || b >= len) continue
        const x = L[a] + R[a]
        const y = L[b] + R[b]
        xy += x * y
        yy += y * y
      }
      return xy / Math.sqrt(yy)
    }
    let best = ideal
    let bestScore = -Infinity
    for (let off = -this.search; off <= this.search; off += 4) {
      const s = score(ideal + off)
      if (s > bestScore) {
        bestScore = s
        best = ideal + off
      }
    }
    const coarse = best
    for (let off = -3; off <= 3; off++) {
      if (off === 0) continue
      const s = score(coarse + off)
      if (s > bestScore) {
        bestScore = s
        best = coarse + off
      }
    }
    this.gSrc[g] = best
    this.gT[g] = 0
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0]
    const oL = out[0]
    const oR = out[1] ?? out[0]
    const n = oL.length
    if (!this.len) {
      oL.fill(0)
      oR.fill(0)
      this.report(n)
      return true
    }
    const G = this.G
    const win = this.win
    this.bendTarget *= Math.exp(-n / (0.12 * sampleRate))

    for (let i = 0; i < n; i++) {
      const scr = this.scratching || this.autoScratch > 0
      let target: number
      let k: number
      if (scr) {
        target = (this.scratchTarget - this.pos) / this.tau
        if (target > MAX_SCRATCH) target = MAX_SCRATCH
        else if (target < -MAX_SCRATCH) target = -MAX_SCRATCH
        k = 0.006
        if (this.autoScratch > 0) this.autoScratch--
      } else if (this.rampOn) {
        const a = Math.min(1, this.rampN++ / this.rampLen)
        target = this.rampFrom + (this.rampTo - this.rampFrom) * a
        k = 0.05
      } else {
        this.bend += (this.bendTarget - this.bend) * 0.002
        target = this.playing ? this.baseRate + this.bend : 0
        k = 0.02
      }
      this.rate += (target - this.rate) * k

      const stretch = (this.keylock || this.semis !== 0) && !scr && !this.rampOn && this.rate > 0.05
      if (stretch && !this.wasStretch) {
        this.gSrc[0] = this.pos
        this.gT[0] = G / 2
        this.gSrc[1] = this.pos
        this.gT[1] = 0
      }
      this.wasStretch = stretch

      let l: number
      let r: number
      if (stretch) {
        const adv = this.keylock ? this.pitch : this.rate * this.pitch
        l = 0
        r = 0
        for (let g = 0; g < 2; g++) {
          if (this.gT[g] >= G) this.reanchor(g, adv)
          const w = win[this.gT[g] | 0]
          this.read(this.wrap(this.gSrc[g]))
          l += w * this.sL
          r += w * this.sR
          this.gSrc[g] += adv
          this.gT[g] += 1
        }
      } else {
        this.read(this.pos)
        l = this.sL
        r = this.sR
      }

      if (this.xfN > 0) {
        this.read(this.xfPos)
        const w = this.xfN / XFADE
        l = l * (1 - w) + this.sL * w
        r = r * (1 - w) + this.sR * w
        this.xfPos += this.rate
        this.xfN--
      }
      oL[i] = l
      oR[i] = r

      const prev = this.pos
      this.pos += this.rate
      if (this.slipOn && this.playing) this.slipPos += this.baseRate
      if (this.pendAt >= 0 && this.rate > 0 && prev < this.pendAt && this.pos >= this.pendAt) {
        const over = this.pos - this.pendAt
        this.pendAt = -1
        this.jump(this.pendPos + over)
      }
      if (this.loopOn && this.rate > 0 && prev < this.loopEnd && this.pos >= this.loopEnd) {
        this.xfPos = this.pos
        this.xfN = XFADE
        this.pos -= this.loopEnd - this.loopStart
      }
      if (this.playing && !scr && !this.loopOn && this.rate > 0 && this.pos >= this.len) {
        this.playing = false
        this.port.postMessage({ t: 'ended', seq: this.seq } satisfies DeckReport)
      }
    }
    this.report(n)
    return true
  }

  report(n: number): void {
    this.sinceReport += n
    if (this.sinceReport < REPORT_EVERY) return
    this.sinceReport = 0
    this.port.postMessage({
      t: 'pos',
      pos: this.pos,
      rate: this.rate,
      playing: this.playing,
      seq: this.seq,
      time: currentTime + n / sampleRate,
    } satisfies DeckReport)
  }
}

registerProcessor('flx4-deck', DeckProcessor)
