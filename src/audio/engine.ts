// The mixer half of the controller as a Web Audio graph.
//
//  deck ─ padFX ─ TRIM ─ EQ ─ smartEQ ─ CFX ─┬─ FADER ─ [beatFX slot] ─ XFADER ─┐
//                                           └─ CUE ───────────────────────────┼─ cue bus
//  sampler, mic ──────────────────────────────────────────────────────────────┤
//                                     master bus ─ [beatFX slot] ─ MASTER ─ limiter ─ out

import { Cfx } from './cfx.ts'
import { FxUnit, makeImpulse } from './fx.ts'
import { renderSample, SAMPLE_NAMES } from './synth.ts'

export class Slot {
  readonly input: GainNode
  readonly output: GainNode
  unit: FxUnit | null = null

  constructor(ctx: BaseAudioContext) {
    this.input = ctx.createGain()
    this.output = ctx.createGain()
    this.input.connect(this.output)
  }

  assign(u: FxUnit | null): void {
    if (u === this.unit) return
    this.input.disconnect()
    if (this.unit) this.unit.output.disconnect()
    this.unit = u
    if (u) {
      this.input.connect(u.input)
      u.output.connect(this.output)
    } else {
      this.input.connect(this.output)
    }
  }
}

const dbToGain = (db: number): number => Math.pow(10, db / 20)

export function eqDb(v: number): number {
  // Knob 0…1, centre 0 dB, -26 dB to +6 dB like the hardware.
  return v < 0.5 ? -26 * (1 - v / 0.5) : 6 * ((v - 0.5) / 0.5)
}

export class Channel {
  readonly input: GainNode
  readonly trim: GainNode
  readonly low: BiquadFilterNode
  readonly mid: BiquadFilterNode
  readonly high: BiquadFilterNode
  readonly smartEq: BiquadFilterNode
  readonly cfx: Cfx
  readonly meter: AnalyserNode
  readonly fader: GainNode
  readonly slot: Slot
  readonly xf: GainNode
  readonly cue: GainNode
  autoGain = 1
  private trimVal = 0.5
  private readonly ctx: BaseAudioContext

  constructor(ctx: BaseAudioContext, ir: AudioBuffer, noise: AudioBuffer, beatSec: () => number, master: AudioNode, cueBus: AudioNode) {
    this.ctx = ctx
    this.input = ctx.createGain()
    this.trim = ctx.createGain()
    this.low = ctx.createBiquadFilter()
    this.mid = ctx.createBiquadFilter()
    this.high = ctx.createBiquadFilter()
    this.smartEq = ctx.createBiquadFilter()
    this.low.type = 'lowshelf'
    this.low.frequency.value = 220
    this.mid.type = 'peaking'
    this.mid.frequency.value = 1000
    this.mid.Q.value = 0.7
    this.high.type = 'highshelf'
    this.high.frequency.value = 4000
    this.smartEq.type = 'lowshelf'
    this.smartEq.frequency.value = 220
    this.cfx = new Cfx(ctx, ir, noise, beatSec)
    this.meter = ctx.createAnalyser()
    this.meter.fftSize = 1024
    this.fader = ctx.createGain()
    this.slot = new Slot(ctx)
    this.xf = ctx.createGain()
    this.cue = ctx.createGain()
    this.cue.gain.value = 0
    this.input.connect(this.trim).connect(this.low).connect(this.mid).connect(this.high).connect(this.smartEq).connect(this.cfx.input)
    this.cfx.output.connect(this.meter)
    this.cfx.output.connect(this.fader).connect(this.slot.input)
    this.slot.output.connect(this.xf).connect(master)
    this.cfx.output.connect(this.cue).connect(cueBus)
    this.setTrim(0.5)
  }

  private glide(p: AudioParam, v: number): void {
    p.setTargetAtTime(v, this.ctx.currentTime, 0.01)
  }

  setTrim(v: number): void {
    this.trimVal = v
    // -inf … 0 dB … +9 dB around the centre detent.
    const g = v < 0.5 ? Math.pow(v / 0.5, 2) : dbToGain(9 * ((v - 0.5) / 0.5))
    this.glide(this.trim.gain, g * this.autoGain)
  }

  setAutoGain(g: number): void {
    this.autoGain = g
    this.setTrim(this.trimVal)
  }

  setEq(band: 'low' | 'mid' | 'high', v: number): void {
    this.glide(this[band].gain, eqDb(v))
  }

  setFader(v: number): void {
    this.glide(this.fader.gain, v * v)
  }

  setXf(g: number): void {
    this.glide(this.xf.gain, g)
  }

  setCue(on: boolean): void {
    this.glide(this.cue.gain, on ? 1 : 0)
  }

  setSmartEq(db: number): void {
    this.glide(this.smartEq.gain, db)
  }
}

export type OutputMode = 'master' | 'split' | 'quad' | 'device'

export class Sampler {
  readonly bus: GainNode
  readonly names: string[] = [...SAMPLE_NAMES]
  readonly bufs: (AudioBuffer | null)[] = []
  private readonly voices: (AudioBufferSourceNode | null)[] = []
  private readonly ctx: BaseAudioContext

  constructor(ctx: BaseAudioContext, out: AudioNode) {
    this.ctx = ctx
    this.bus = ctx.createGain()
    this.bus.connect(out)
    for (let i = 0; i < 16; i++) {
      const data = renderSample(i, ctx.sampleRate)
      const b = ctx.createBuffer(1, data.length, ctx.sampleRate)
      b.copyToChannel(data, 0)
      this.bufs.push(b)
      this.voices.push(null)
    }
  }

  set(i: number, name: string, buf: AudioBuffer): void {
    this.stop(i)
    this.names[i] = name
    this.bufs[i] = buf
  }

  trigger(i: number): void {
    const b = this.bufs[i]
    if (!b) return
    this.stop(i)
    const s = this.ctx.createBufferSource()
    s.buffer = b
    s.connect(this.bus)
    s.onended = () => {
      if (this.voices[i] === s) this.voices[i] = null
    }
    s.start()
    this.voices[i] = s
  }

  stop(i: number): void {
    const v = this.voices[i]
    if (v) {
      v.onended = null
      v.stop()
      v.disconnect()
      this.voices[i] = null
    }
  }

  playing(i: number): boolean {
    return this.voices[i] !== null
  }
}

type SinkCtx = AudioContext & { setSinkId?: (id: string) => Promise<void> }

export class Engine {
  readonly ctx: AudioContext
  readonly ir: AudioBuffer
  readonly noise: AudioBuffer
  readonly masterBus: GainNode
  readonly masterSlot: Slot
  readonly masterGain: GainNode
  readonly limiter: DynamicsCompressorNode
  readonly masterOut: GainNode
  readonly cueBus: GainNode
  readonly masterCue: GainNode
  readonly hpCue: GainNode
  readonly hpMaster: GainNode
  readonly hpOut: GainNode
  readonly meterL: AnalyserNode
  readonly meterR: AnalyserNode
  readonly ch: [Channel, Channel]
  readonly sampler: Sampler
  outMode: OutputMode = 'master'
  private links: [AudioNode, AudioNode][] = []
  private cueCtx: SinkCtx | null = null
  private cueStream: MediaStreamAudioDestinationNode | null = null
  private recDest: MediaStreamAudioDestinationNode | null = null
  private rec: MediaRecorder | null = null
  private recChunks: Blob[] = []
  recStart = 0
  private micGain: GainNode | null = null
  private micPending = false
  private readonly buf = new Float32Array(1024)

  constructor(beatSec: [() => number, () => number]) {
    const ctx = new AudioContext({ latencyHint: 'interactive' })
    this.ctx = ctx
    this.ir = makeImpulse(ctx, 2.6, 3)
    this.noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate)
    const nd = this.noise.getChannelData(0)
    for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1

    this.masterBus = ctx.createGain()
    this.masterSlot = new Slot(ctx)
    this.masterGain = ctx.createGain()
    this.limiter = ctx.createDynamicsCompressor()
    this.limiter.threshold.value = -1.5
    this.limiter.knee.value = 0
    this.limiter.ratio.value = 20
    this.limiter.attack.value = 0.002
    this.limiter.release.value = 0.12
    this.masterOut = ctx.createGain()
    this.masterBus.connect(this.masterSlot.input)
    this.masterSlot.output.connect(this.masterGain)
    this.masterGain.connect(this.limiter).connect(this.masterOut)

    const split = ctx.createChannelSplitter(2)
    this.meterL = ctx.createAnalyser()
    this.meterR = ctx.createAnalyser()
    this.meterL.fftSize = this.meterR.fftSize = 1024
    this.masterGain.connect(split)
    split.connect(this.meterL, 0)
    split.connect(this.meterR, 1)

    this.cueBus = ctx.createGain()
    this.masterCue = ctx.createGain()
    this.masterCue.gain.value = 0
    this.masterOut.connect(this.masterCue).connect(this.cueBus)
    this.hpCue = ctx.createGain()
    this.hpMaster = ctx.createGain()
    this.hpOut = ctx.createGain()
    this.cueBus.connect(this.hpCue).connect(this.hpOut)
    this.masterOut.connect(this.hpMaster).connect(this.hpOut)

    this.ch = [
      new Channel(ctx, this.ir, this.noise, beatSec[0], this.masterBus, this.cueBus),
      new Channel(ctx, this.ir, this.noise, beatSec[1], this.masterBus, this.cueBus),
    ]
    this.sampler = new Sampler(ctx, this.masterBus)
    this.setOutput('master')
  }

  async init(workletUrl: string): Promise<void> {
    await this.ctx.audioWorklet.addModule(workletUrl)
  }

  private glide(p: AudioParam, v: number): void {
    p.setTargetAtTime(v, this.ctx.currentTime, 0.01)
  }

  setMasterLevel(v: number): void {
    // 0 dB around 80% travel, +4 dB at the top; the limiter catches peaks.
    this.glide(this.masterGain.gain, Math.pow(v / 0.8, 2))
  }

  setXfader(x: number, curve: 'smooth' | 'sharp'): void {
    let a: number
    let b: number
    if (curve === 'smooth') {
      a = Math.cos((x * Math.PI) / 2)
      b = Math.sin((x * Math.PI) / 2)
    } else {
      a = Math.min(1, (1 - x) / 0.06)
      b = Math.min(1, x / 0.06)
    }
    this.ch[0].setXf(a)
    this.ch[1].setXf(b)
  }

  setHpMix(x: number): void {
    this.glide(this.hpCue.gain, Math.cos((x * Math.PI) / 2))
    this.glide(this.hpMaster.gain, Math.sin((x * Math.PI) / 2))
  }

  setHpLevel(v: number): void {
    this.glide(this.hpOut.gain, v * v * 1.4)
  }

  setMasterCue(on: boolean): void {
    this.glide(this.masterCue.gain, on ? 1 : 0)
  }

  get quadAvailable(): boolean {
    return this.ctx.destination.maxChannelCount >= 4
  }

  async setOutput(mode: OutputMode, cueDevice?: string): Promise<void> {
    const ctx = this.ctx
    for (const [a, b] of this.links) {
      try {
        a.disconnect(b)
      } catch {
        // already gone
      }
    }
    this.links = []
    if (this.cueCtx) {
      void this.cueCtx.close()
      this.cueCtx = null
    }
    const link = (a: AudioNode, b: AudioNode, o = 0, i = 0): void => {
      a.connect(b, o, i)
      this.links.push([a, b])
    }
    const dest = ctx.destination
    if (mode === 'quad' && !this.quadAvailable) mode = 'master'
    this.outMode = mode
    dest.channelCount = mode === 'quad' ? 4 : 2
    dest.channelInterpretation = mode === 'quad' ? 'discrete' : 'speakers'

    if (mode === 'split') {
      // Mono cue in the left ear, mono master in the right.
      const m = ctx.createGain()
      const h = ctx.createGain()
      for (const g of [m, h]) {
        g.channelCount = 1
        g.channelCountMode = 'explicit'
      }
      const merge = ctx.createChannelMerger(2)
      link(this.hpOut, h)
      link(h, merge, 0, 0)
      link(this.masterOut, m)
      link(m, merge, 0, 1)
      link(merge, dest)
    } else if (mode === 'quad') {
      // The FLX4's own interface: outputs 1/2 master, 3/4 headphones.
      const sm = ctx.createChannelSplitter(2)
      const sh = ctx.createChannelSplitter(2)
      const merge = ctx.createChannelMerger(4)
      link(this.masterOut, sm)
      link(this.hpOut, sh)
      link(sm, merge, 0, 0)
      link(sm, merge, 1, 1)
      link(sh, merge, 0, 2)
      link(sh, merge, 1, 3)
      link(merge, dest)
    } else {
      link(this.masterOut, dest)
    }
    if (mode === 'device' && cueDevice) {
      this.cueStream ??= ctx.createMediaStreamDestination()
      link(this.hpOut, this.cueStream)
      const c = new AudioContext({ latencyHint: 'interactive' }) as SinkCtx
      await c.setSinkId?.(cueDevice)
      c.createMediaStreamSource(this.cueStream.stream).connect(c.destination)
      await c.resume()
      this.cueCtx = c
    }
  }

  async setMasterDevice(id: string): Promise<void> {
    await (this.ctx as SinkCtx).setSinkId?.(id)
  }

  get canPickDevice(): boolean {
    return typeof (this.ctx as SinkCtx).setSinkId === 'function'
  }

  peak(a: AnalyserNode): number {
    a.getFloatTimeDomainData(this.buf)
    let p = 0
    for (let i = 0; i < this.buf.length; i++) {
      const v = Math.abs(this.buf[i])
      if (v > p) p = v
    }
    return p
  }

  async setMic(v: number): Promise<void> {
    if (v > 0 && !this.micGain && !this.micPending) {
      this.micPending = true
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        })
        this.micGain = this.ctx.createGain()
        this.ctx.createMediaStreamSource(stream).connect(this.micGain).connect(this.masterBus)
      } catch {
        // permission denied; the knob just does nothing
      } finally {
        this.micPending = false
      }
    }
    if (this.micGain) this.glide(this.micGain.gain, v * v * 2)
  }

  get recording(): boolean {
    return this.rec !== null
  }

  startRecording(): void {
    if (this.rec) return
    this.recDest ??= this.ctx.createMediaStreamDestination()
    this.masterOut.connect(this.recDest)
    const type = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm'].find((t) => MediaRecorder.isTypeSupported(t))
    this.rec = new MediaRecorder(this.recDest.stream, type ? { mimeType: type, audioBitsPerSecond: 256000 } : undefined)
    this.recChunks = []
    this.rec.ondataavailable = (e) => this.recChunks.push(e.data)
    this.rec.start(1000)
    this.recStart = performance.now()
  }

  stopRecording(): Promise<Blob> {
    return new Promise((resolve) => {
      const r = this.rec
      if (!r) return resolve(new Blob())
      r.onstop = () => {
        resolve(new Blob(this.recChunks, { type: r.mimeType }))
        if (this.recDest) this.masterOut.disconnect(this.recDest)
      }
      r.stop()
      this.rec = null
    })
  }
}
