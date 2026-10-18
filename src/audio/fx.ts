// Beat-synced effect unit. One instance is the BEAT FX section (assignable to
// CH1, CH2 or MASTER); each deck also owns one for its PAD FX.

export type FxType =
  | 'delay' | 'echo' | 'pingpong' | 'spiral' | 'reverb'
  | 'trans' | 'flanger' | 'phaser' | 'filter' | 'helix'

export interface FxInfo {
  type: FxType
  name: string
  beat: number // default beat value
  tail: boolean // keeps ringing after FX off (echo spill-over)
}

export const FX_LIST: FxInfo[] = [
  { type: 'delay', name: 'DELAY', beat: 3 / 4, tail: true },
  { type: 'echo', name: 'ECHO', beat: 1 / 2, tail: true },
  { type: 'pingpong', name: 'PING PONG', beat: 1 / 2, tail: true },
  { type: 'spiral', name: 'SPIRAL', beat: 1 / 2, tail: true },
  { type: 'reverb', name: 'REVERB', beat: 1, tail: true },
  { type: 'trans', name: 'TRANS', beat: 1 / 4, tail: false },
  { type: 'flanger', name: 'FLANGER', beat: 8, tail: false },
  { type: 'phaser', name: 'PHASER', beat: 8, tail: false },
  { type: 'filter', name: 'FILTER', beat: 4, tail: false },
  { type: 'helix', name: 'HELIX', beat: 1 / 2, tail: true },
]

export const BEATS = [1 / 16, 1 / 8, 1 / 4, 1 / 2, 3 / 4, 1, 2, 4, 8, 16]

export function beatLabel(b: number): string {
  if (b >= 1) return String(b)
  const map: Record<string, string> = { '0.0625': '1/16', '0.125': '1/8', '0.25': '1/4', '0.5': '1/2', '0.75': '3/4' }
  return map[String(b)] ?? b.toFixed(2)
}

export interface Clock {
  bpm(): number
  nextBeat(): number // AudioContext time of the next beat
}

interface Part {
  input: AudioNode
  output: AudioNode
  update(sec: number, now: number): void
  enable?(on: boolean, sec: number, nextBeat: number): void
  stop(): void
}

export function makeImpulse(ctx: BaseAudioContext, seconds: number, decay: number): AudioBuffer {
  const n = Math.round(seconds * ctx.sampleRate)
  const buf = ctx.createBuffer(2, n, ctx.sampleRate)
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c)
    for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, decay)
  }
  return buf
}

function softSquare(ctx: BaseAudioContext): PeriodicWave {
  const N = 24
  const real = new Float32Array(N)
  const imag = new Float32Array(N)
  for (let k = 1; k < N; k += 2) {
    const sigma = Math.sin((Math.PI * k) / N) / ((Math.PI * k) / N)
    imag[k] = (4 / (Math.PI * k)) * sigma
  }
  return ctx.createPeriodicWave(real, imag, { disableNormalization: true })
}

const ramp = (p: AudioParam, v: number, now: number, tc = 0.03): void => {
  p.setTargetAtTime(v, now, tc)
}

export class FxUnit {
  readonly input: GainNode
  readonly output: GainNode
  type: FxType = 'delay'
  beat = 3 / 4
  depth = 0.5
  on = false
  private readonly ctx: BaseAudioContext
  private readonly clock: Clock
  private readonly ir: AudioBuffer
  private readonly dry: GainNode
  private readonly send: GainNode
  private readonly wet: GainNode
  private part: Part | null = null

  constructor(ctx: BaseAudioContext, clock: Clock, ir: AudioBuffer) {
    this.ctx = ctx
    this.clock = clock
    this.ir = ir
    this.input = ctx.createGain()
    this.output = ctx.createGain()
    this.dry = ctx.createGain()
    this.send = ctx.createGain()
    this.wet = ctx.createGain()
    this.input.connect(this.dry).connect(this.output)
    this.input.connect(this.send)
    this.wet.connect(this.output)
    this.send.gain.value = 0
    this.wet.gain.value = 0
    this.setType('delay')
  }

  get info(): FxInfo {
    return FX_LIST.find((f) => f.type === this.type)!
  }

  private get sec(): number {
    const bpm = this.clock.bpm() || 120
    return (60 / bpm) * this.beat
  }

  setType(t: FxType, keepBeat = false): void {
    if (this.part && t === this.type) return
    if (this.part) {
      this.send.disconnect()
      this.part.output.disconnect()
      this.part.stop()
    }
    this.type = t
    if (!keepBeat) this.beat = this.info.beat
    this.part = this.build(t)
    this.send.connect(this.part.input)
    this.part.output.connect(this.wet)
    this.part.update(this.sec, this.ctx.currentTime)
    this.mix()
    if (this.on) this.part.enable?.(true, this.sec, this.clock.nextBeat())
  }

  setBeat(b: number): void {
    this.beat = b
    this.part?.update(this.sec, this.ctx.currentTime)
  }

  setDepth(d: number): void {
    this.depth = d
    this.mix()
  }

  setOn(on: boolean): void {
    if (on === this.on) return
    this.on = on
    this.part?.update(this.sec, this.ctx.currentTime)
    this.part?.enable?.(on, this.sec, this.clock.nextBeat())
    this.mix()
  }

  // Called a few times a second so delay times follow tempo changes.
  tick(): void {
    this.part?.update(this.sec, this.ctx.currentTime)
  }

  private mix(): void {
    const now = this.ctx.currentTime
    const d = this.depth
    if (this.info.tail) {
      ramp(this.dry.gain, 1, now)
      ramp(this.wet.gain, this.type === 'reverb' ? d * 1.4 : d * 1.1, now)
      ramp(this.send.gain, this.on ? 1 : 0, now, 0.01)
    } else {
      ramp(this.dry.gain, this.on ? 1 - d : 1, now, 0.01)
      ramp(this.wet.gain, this.on ? d : 0, now, 0.01)
      ramp(this.send.gain, 1, now)
    }
  }

  private build(t: FxType): Part {
    const ctx = this.ctx
    const lfo = (): { osc: OscillatorNode; amt: GainNode } => {
      const osc = ctx.createOscillator()
      const amt = ctx.createGain()
      osc.connect(amt)
      osc.start()
      return { osc, amt }
    }
    switch (t) {
      case 'delay':
      case 'echo':
      case 'spiral': {
        const input = ctx.createGain()
        const d = ctx.createDelay(20)
        const lp = ctx.createBiquadFilter()
        const fb = ctx.createGain()
        const out = ctx.createGain()
        lp.frequency.value = t === 'delay' ? 16000 : t === 'echo' ? 5000 : 3500
        input.connect(d).connect(lp).connect(out)
        let tailEnd: AudioNode = lp
        if (t === 'spiral') {
          const ap1 = ctx.createBiquadFilter()
          const ap2 = ctx.createBiquadFilter()
          ap1.type = ap2.type = 'allpass'
          ap1.frequency.value = 700
          ap2.frequency.value = 2100
          lp.connect(ap1).connect(ap2)
          tailEnd = ap2
        }
        tailEnd.connect(fb).connect(d)
        const fbAmt = t === 'delay' ? 0.3 : t === 'echo' ? 0.6 : 0.84
        fb.gain.value = fbAmt
        return {
          input,
          output: out,
          update: (sec, now) => ramp(d.delayTime, Math.min(19.9, sec), now, 0.05),
          stop: () => input.disconnect(),
        }
      }
      case 'pingpong': {
        const input = ctx.createGain()
        input.channelCount = 1
        input.channelCountMode = 'explicit'
        const dl = ctx.createDelay(20)
        const dr = ctx.createDelay(20)
        const fb = ctx.createGain()
        const merge = ctx.createChannelMerger(2)
        fb.gain.value = 0.55
        input.connect(dl)
        dl.connect(dr)
        dr.connect(fb).connect(dl)
        dl.connect(merge, 0, 0)
        dr.connect(merge, 0, 1)
        return {
          input,
          output: merge,
          update: (sec, now) => {
            ramp(dl.delayTime, Math.min(19.9, sec), now, 0.05)
            ramp(dr.delayTime, Math.min(19.9, sec), now, 0.05)
          },
          stop: () => input.disconnect(),
        }
      }
      case 'reverb': {
        const input = ctx.createGain()
        const hp = ctx.createBiquadFilter()
        hp.type = 'highpass'
        hp.frequency.value = 220
        const conv = ctx.createConvolver()
        conv.buffer = this.ir
        input.connect(hp).connect(conv)
        return { input, output: conv, update: () => {}, stop: () => input.disconnect() }
      }
      case 'helix': {
        const input = ctx.createGain()
        const gate = ctx.createGain()
        const d = ctx.createDelay(20)
        const fb = ctx.createGain()
        gate.gain.value = 0
        input.connect(gate).connect(d)
        d.connect(fb).connect(d)
        fb.gain.value = 0.5
        return {
          input,
          output: d,
          update: (sec, now) => {
            if (!this.on) ramp(d.delayTime, Math.min(19.9, sec), now, 0.05)
          },
          enable: (on, sec) => {
            const now = ctx.currentTime
            gate.gain.cancelScheduledValues(now)
            fb.gain.cancelScheduledValues(now)
            if (on) {
              // Capture exactly one cycle, then let it circulate.
              d.delayTime.setValueAtTime(Math.min(19.9, sec), now)
              gate.gain.setValueAtTime(1, now)
              gate.gain.setValueAtTime(0, now + sec)
              fb.gain.setValueAtTime(0.98, now)
            } else {
              gate.gain.setValueAtTime(0, now)
              fb.gain.setTargetAtTime(0.4, now, 0.05)
            }
          },
          stop: () => input.disconnect(),
        }
      }
      case 'trans': {
        const input = ctx.createGain()
        const gate = ctx.createGain()
        gate.gain.value = 0.5
        input.connect(gate)
        const wave = softSquare(ctx)
        let osc: OscillatorNode | null = null
        const amt = ctx.createGain()
        amt.gain.value = 0.5
        amt.connect(gate.gain)
        const restart = (sec: number, at: number): void => {
          osc?.stop()
          osc?.disconnect()
          osc = ctx.createOscillator()
          osc.setPeriodicWave(wave)
          osc.frequency.value = 1 / sec
          osc.connect(amt)
          osc.start(Math.max(ctx.currentTime, at))
        }
        restart(this.sec, ctx.currentTime)
        return {
          input,
          output: gate,
          update: (sec, now) => osc && ramp(osc.frequency, 1 / sec, now, 0.02),
          enable: (on, sec, next) => on && restart(sec, next),
          stop: () => {
            osc?.stop()
            input.disconnect()
          },
        }
      }
      case 'flanger': {
        const input = ctx.createGain()
        const d = ctx.createDelay(0.05)
        const fb = ctx.createGain()
        d.delayTime.value = 0.004
        fb.gain.value = 0.65
        input.connect(d)
        d.connect(fb).connect(d)
        const { osc, amt } = lfo()
        amt.gain.value = 0.0035
        amt.connect(d.delayTime)
        return {
          input,
          output: d,
          update: (sec, now) => ramp(osc.frequency, 1 / sec, now, 0.05),
          stop: () => {
            osc.stop()
            input.disconnect()
          },
        }
      }
      case 'phaser':
      case 'filter': {
        const input = ctx.createGain()
        const { osc, amt } = lfo()
        let last: AudioNode = input
        const stages = t === 'phaser' ? 4 : 1
        for (let i = 0; i < stages; i++) {
          const f = ctx.createBiquadFilter()
          f.type = t === 'phaser' ? 'allpass' : 'lowpass'
          f.frequency.value = t === 'phaser' ? 900 : 1200
          f.Q.value = t === 'phaser' ? 0.6 : 7
          amt.connect(f.detune)
          last.connect(f)
          last = f
        }
        amt.gain.value = t === 'phaser' ? 2400 : 3000
        return {
          input,
          output: last,
          update: (sec, now) => ramp(osc.frequency, 1 / sec, now, 0.05),
          enable: (on, sec, next) => {
            if (!on) return
            // Re-phase the sweep so it starts on the beat.
            osc.frequency.cancelScheduledValues(ctx.currentTime)
            osc.frequency.setValueAtTime(1 / sec, Math.max(ctx.currentTime, next))
          },
          stop: () => {
            osc.stop()
            input.disconnect()
          },
        }
      }
    }
  }
}
