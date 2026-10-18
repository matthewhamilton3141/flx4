// The per-channel CFX knob. Plain it is a filter (left low-pass, right
// high-pass); with SMART CFX on it becomes the chosen combo effect.

export type CfxType = 'filter' | 'space' | 'dubecho' | 'sweep' | 'noise' | 'crush'

export const CFX_LIST: { type: CfxType; name: string }[] = [
  { type: 'space', name: 'SPACE' },
  { type: 'dubecho', name: 'DUB ECHO' },
  { type: 'sweep', name: 'SWEEP' },
  { type: 'noise', name: 'NOISE' },
  { type: 'crush', name: 'CRUSH' },
]

const DEAD = 0.03

export class Cfx {
  readonly input: GainNode
  readonly output: GainNode
  type: CfxType = 'filter'
  value = 0 // -1 … +1, 0 is off
  private readonly ctx: BaseAudioContext
  private readonly beatSec: () => number
  private readonly shaper: WaveShaperNode
  private readonly f1: BiquadFilterNode
  private readonly f2: BiquadFilterNode
  private readonly revSend: GainNode
  private readonly dlySend: GainNode
  private readonly dly: DelayNode
  private readonly dfb: GainNode
  private readonly nf: BiquadFilterNode
  private readonly ng: GainNode
  private bits = 0
  private readonly curves = new Map<number, Float32Array<ArrayBuffer>>()

  constructor(ctx: BaseAudioContext, ir: AudioBuffer, noise: AudioBuffer, beatSec: () => number) {
    this.ctx = ctx
    this.beatSec = beatSec
    this.input = ctx.createGain()
    this.output = ctx.createGain()
    this.shaper = ctx.createWaveShaper()
    this.f1 = ctx.createBiquadFilter()
    this.f2 = ctx.createBiquadFilter()
    this.input.connect(this.shaper).connect(this.f1).connect(this.f2).connect(this.output)

    this.revSend = ctx.createGain()
    this.revSend.gain.value = 0
    const rev = ctx.createConvolver()
    rev.buffer = ir
    this.f2.connect(this.revSend).connect(rev).connect(this.output)

    this.dlySend = ctx.createGain()
    this.dlySend.gain.value = 0
    this.dly = ctx.createDelay(4)
    const dlp = ctx.createBiquadFilter()
    dlp.frequency.value = 2800
    this.dfb = ctx.createGain()
    this.dfb.gain.value = 0.4
    this.f2.connect(this.dlySend).connect(this.dly).connect(dlp).connect(this.output)
    dlp.connect(this.dfb).connect(this.dly)

    const src = ctx.createBufferSource()
    src.buffer = noise
    src.loop = true
    this.nf = ctx.createBiquadFilter()
    this.ng = ctx.createGain()
    this.ng.gain.value = 0
    src.connect(this.nf).connect(this.ng).connect(this.output)
    src.start()
    this.apply()
  }

  set(v: number): void {
    this.value = v
    this.apply()
  }

  setType(t: CfxType): void {
    this.type = t
    this.apply()
  }

  tick(): void {
    this.dly.delayTime.setTargetAtTime(Math.min(3.9, this.beatSec() * 0.75), this.ctx.currentTime, 0.1)
  }

  private crushCurve(bits: number): Float32Array<ArrayBuffer> {
    let c = this.curves.get(bits)
    if (!c) {
      c = new Float32Array(4096)
      const steps = Math.pow(2, bits - 1)
      for (let i = 0; i < c.length; i++) {
        const x = (i / (c.length - 1)) * 2 - 1
        c[i] = Math.round(x * steps) / steps
      }
      this.curves.set(bits, c)
    }
    return c
  }

  private apply(): void {
    const now = this.ctx.currentTime
    const v = this.value
    const a = Math.abs(v)
    const t = this.type
    const nyq = this.ctx.sampleRate / 2 - 200
    const tc = 0.012
    const off = a < DEAD

    const span = t === 'space' || t === 'dubecho' ? 7.5 : t === 'crush' ? 6.5 : 9.6
    const x = off ? 0 : (a - DEAD) / (1 - DEAD)
    const type: BiquadFilterType = v < 0 ? 'lowpass' : 'highpass'
    const freq = off ? nyq : v < 0 ? Math.max(30, nyq * Math.pow(2, -x * span)) : 20 * Math.pow(2, x * span)

    if (off) {
      this.f1.type = 'lowpass'
      this.f2.type = 'lowpass'
      this.f1.frequency.setTargetAtTime(nyq, now, tc)
      this.f2.frequency.setTargetAtTime(nyq, now, tc)
    } else {
      this.f1.type = type
      this.f1.frequency.setTargetAtTime(Math.min(nyq, freq), now, tc)
      if (t === 'sweep') {
        this.f2.type = 'lowpass'
        this.f2.frequency.setTargetAtTime(nyq, now, tc)
      } else {
        this.f2.type = type
        this.f2.frequency.setTargetAtTime(Math.min(nyq, freq), now, tc)
      }
    }
    this.f1.Q.value = t === 'sweep' ? 9 : 1
    this.f2.Q.value = 0.7

    this.revSend.gain.setTargetAtTime(t === 'space' && !off ? x * 1.1 : 0, now, tc)
    this.dlySend.gain.setTargetAtTime(t === 'dubecho' && !off ? x : 0, now, tc)
    this.dfb.gain.setTargetAtTime(t === 'dubecho' && !off ? 0.45 + 0.35 * x : 0.4, now, 0.05)

    this.nf.type = type
    this.nf.frequency.setTargetAtTime(Math.min(nyq, freq), now, tc)
    this.ng.gain.setTargetAtTime(t === 'noise' && !off ? Math.pow(x, 1.5) * 0.22 : 0, now, tc)

    const bits = t === 'crush' && !off ? Math.round(16 - x * 13) : 0
    if (bits !== this.bits) {
      this.bits = bits
      this.shaper.curve = bits ? this.crushCurve(bits) : null
    }
  }
}
