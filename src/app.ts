// Wires the audio engine to the control bus: every knob, fader, button and
// LED on the controller is defined here.

import type { Analysis } from './audio/analysis.ts'
import { CFX_LIST, type CfxType } from './audio/cfx.ts'
import {
  BEAT_JUMPS, BEAT_LOOPS, Deck, KEY_SHIFTS, KEYBOARD, PAD_FX, samplerSlot,
  type DeckEnv, type ModeButton, type Track,
} from './audio/deck.ts'
import workletUrl from './audio/deck-worklet.ts?worker&url'
import { Engine, type OutputMode } from './audio/engine.ts'
import { BEATS, beatLabel, FX_LIST, FxUnit } from './audio/fx.ts'
import { DEMOS } from './audio/synth.ts'
import type { WorkerBody } from './audio/worker.ts'
import { button, param, setShift, type Handler, type Src } from './bus.ts'

export interface Prefs {
  theme: 'auto' | 'light' | 'dark'
  cfx: CfxType
  xfCurve: 'smooth' | 'sharp'
  quantize: boolean
  zoom: number
  libOpen: boolean
}

const PREFS_KEY = 'flx4.prefs'
const CUES_KEY = 'flx4.cues.'
const AUDIO_EXT = /\.(mp3|wav|aiff?|flac|m4a|aac|ogg|oga|opus|webm|mp4)$/i

function store<T>(key: string): T | null {
  try {
    const v = localStorage.getItem(key)
    return v ? (JSON.parse(v) as T) : null
  } catch {
    return null
  }
}

function save(key: string, v: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(v))
  } catch {
    // storage unavailable: settings just won't persist
  }
}

export const MODE_BUTTONS: ModeButton[] = ['hotcue', 'padfx1', 'beatjump', 'sampler']

export class App {
  readonly engine: Engine
  readonly decks: [Deck, Deck]
  readonly beatFx: FxUnit
  tracks: Track[] = []
  sel = 0
  masterDeck: Deck
  prefs: Prefs = { theme: 'auto', cfx: 'space', xfCurve: 'smooth', quantize: true, zoom: 1, libOpen: false }
  smartFader = false
  smartCfx = false
  hpCue = [false, false]
  masterCue = false
  fxCh = 2 // 0: CH1, 1: CH2, 2: MASTER
  toast = ''
  toastUntil = 0
  onLibrary: () => void = () => {}
  private readonly worker: Worker
  private readonly reqs = new Map<number, (v: unknown) => void>()
  private nextReq = 1
  private nextTrack = 1

  static async create(): Promise<App> {
    // Engine first (decks need its channels), worklet module before decks.
    const holder: { app?: App } = {}
    const beatSec = (i: number) => () => {
      const d = holder.app?.decks[i]
      return d && d.bpm ? 60 / d.bpm : 0.5
    }
    const engine = new Engine([beatSec(0), beatSec(1)])
    await engine.init(workletUrl)
    const app = new App(engine)
    holder.app = app
    return app
  }

  private constructor(engine: Engine) {
    this.engine = engine
    const loaded = store<Partial<Prefs>>(PREFS_KEY)
    if (loaded) Object.assign(this.prefs, loaded)

    const env: DeckEnv = {
      other: (d) => (d === this.decks[0] ? this.decks[1] : this.decks[0]),
      master: () => this.masterDeck,
      setMaster: (d) => this.setMaster(d),
      quantize: () => this.prefs.quantize,
      sampler: engine.sampler,
      saveCues: (t) => save(CUES_KEY + t.key, t.cues),
      onPlayState: (d) => this.onPlayState(d),
    }
    const ctx = engine.ctx
    this.decks = [new Deck(1, ctx, engine.ch[0], engine.ir, env), new Deck(2, ctx, engine.ch[1], engine.ir, env)]
    this.masterDeck = this.decks[0]
    this.beatFx = new FxUnit(ctx, { bpm: () => this.fxDeck.bpm, nextBeat: () => this.fxDeck.nextBeatTime() }, engine.ir)

    this.worker = new Worker(new URL('./audio/worker.ts', import.meta.url), { type: 'module' })
    this.worker.onmessage = (e: MessageEvent<{ id: number; result: unknown }>) => {
      this.reqs.get(e.data.id)?.(e.data.result)
      this.reqs.delete(e.data.id)
    }

    this.bind()
    this.applyCfx()
    window.setInterval(() => this.tick(), 100)
  }

  private call<T>(req: WorkerBody, transfer: Transferable[] = []): Promise<T> {
    const id = this.nextReq++
    return new Promise((resolve) => {
      this.reqs.set(id, resolve as (v: unknown) => void)
      this.worker.postMessage({ ...req, id }, transfer)
    })
  }

  savePrefs(): void {
    save(PREFS_KEY, this.prefs)
  }

  say(msg: string): void {
    this.toast = msg
    this.toastUntil = performance.now() + 3500
  }

  get fxDeck(): Deck {
    return this.fxCh === 2 ? this.masterDeck : this.decks[this.fxCh]
  }

  // ── controls ────────────────────────────────────────────────────────────

  private bind(): void {
    const e = this.engine
    const p = (id: string, def: number, fn: (v: number, src: Src) => void, min = 0, max = 1): void => {
      const q = param(id, def, min, max)
      q.on(fn)
      fn(q.value, 'app')
    }
    const b = (id: string, fn: Handler): void => {
      button(id).handler = fn
    }

    for (const d of this.decks) {
      const n = d.n
      const i = n - 1
      const ch = e.ch[i]
      p(`d${n}.tempo`, 0, (v, src) => {
        d.setTempo(v, src !== 'app')
        if (this.smartFader) this.smartUpdate()
      }, -1, 1)
      p(`d${n}.trim`, 0.5, (v) => ch.setTrim(v))
      p(`d${n}.hi`, 0.5, (v) => ch.setEq('high', v))
      p(`d${n}.mid`, 0.5, (v) => ch.setEq('mid', v))
      p(`d${n}.low`, 0.5, (v) => ch.setEq('low', v))
      p(`d${n}.cfx`, 0.5, (v) => ch.cfx.set(v * 2 - 1))
      p(`d${n}.fader`, 1, (v) => ch.setFader(v))

      b(`d${n}.play`, (dn, s) => d.playBtn(dn, s))
      b(`d${n}.cue`, (dn, s) => d.cueBtn(dn, s))
      b(`d${n}.sync`, (dn, s) => d.syncBtn(dn, s))
      b(`d${n}.syncMaster`, (dn) => dn && this.setMaster(d))
      b(`d${n}.shift`, (dn) => setShift(n, dn))
      b(`d${n}.loopIn`, (dn, s) => d.loopInBtn(dn, s))
      b(`d${n}.loopOut`, (dn) => d.loopOutBtn(dn))
      b(`d${n}.reloop`, (dn, s) => d.reloopBtn(dn, s))
      b(`d${n}.callPrev`, (dn, s) => d.callBtn(-1, dn, s))
      b(`d${n}.callNext`, (dn, s) => d.callBtn(1, dn, s))
      for (const m of MODE_BUTTONS) b(`d${n}.mode.${m}`, (dn, s) => d.modeBtn(m, dn, s))
      for (let k = 0; k < 8; k++) b(`d${n}.pad${k}`, (dn, s) => d.pad(k, dn, s))
      b(`d${n}.load`, (dn, s) => dn && this.loadDeck(n, undefined, s))
      b(`d${n}.hpcue`, (dn, s) => {
        if (!dn) return
        if (s) return this.toggleQuantize()
        this.hpCue[i] = !this.hpCue[i]
        ch.setCue(this.hpCue[i])
      })
      b(`d${n}.keylock`, (dn) => dn && d.toggleKeylock())
      b(`d${n}.slip`, (dn) => dn && (d.slip = !d.slip))
      b(`d${n}.vinyl`, (dn) => dn && (d.vinyl = !d.vinyl))
      b(`d${n}.range`, (dn) => dn && d.cycleRange())
      b(`d${n}.syncBadge`, (dn) => dn && d.toggleSync())
    }

    p('xfader', 0.5, (v) => {
      e.setXfader(v, this.prefs.xfCurve)
      if (this.smartFader) this.smartUpdate()
    })
    p('master', 0.8, (v) => e.setMasterLevel(v))
    p('hpMix', 0.5, (v) => e.setHpMix(v))
    p('hpLevel', 0.6, (v) => e.setHpLevel(v))
    p('mic', 0, (v) => void e.setMic(v))
    p('fx.level', 0.5, (v) => this.beatFx.setDepth(v))
    p('fx.ch', 2, (v) => this.assignFx(Math.round(v)), 0, 2)
    p('sampler.vol', 0.8, (v) => e.sampler.bus.gain.setTargetAtTime(v * v, e.ctx.currentTime, 0.01))

    b('masterCue', (dn) => {
      if (!dn) return
      this.masterCue = !this.masterCue
      e.setMasterCue(this.masterCue)
    })
    b('fx.select', (dn, s) => dn && this.selectFx(s ? -1 : 1))
    b('fx.beatL', (dn) => dn && this.stepFxBeat(-1))
    b('fx.beatR', (dn) => dn && this.stepFxBeat(1))
    // Tap toggles; hold for more than half a second for a momentary hit.
    let fxDownAt = 0
    let fxTurnedOn = false
    b('fx.on', (dn, s) => {
      if (s) {
        if (dn) this.beatFx.setOn(false)
        return
      }
      if (dn) {
        fxDownAt = performance.now()
        fxTurnedOn = !this.beatFx.on
        this.beatFx.setOn(fxTurnedOn)
      } else if (fxTurnedOn && performance.now() - fxDownAt > 500) {
        this.beatFx.setOn(false)
      }
    })
    b('smartFader', (dn) => {
      if (!dn) return
      this.smartFader = !this.smartFader
      this.smartUpdate()
      this.say(this.smartFader ? 'Smart Fader on: the crossfader blends tempo and swaps bass' : 'Smart Fader off')
    })
    b('smartCfx', (dn) => {
      if (!dn) return
      this.smartCfx = !this.smartCfx
      this.applyCfx()
    })
    b('quantize', (dn) => dn && this.toggleQuantize())
    b('browse.push', (dn) => dn && this.loadDeck(this.idleDeck().n))
  }

  toggleQuantize(): void {
    this.prefs.quantize = !this.prefs.quantize
    this.savePrefs()
  }

  setCfxType(t: CfxType): void {
    this.prefs.cfx = t
    this.savePrefs()
    this.applyCfx()
  }

  setXfCurve(c: 'smooth' | 'sharp'): void {
    this.prefs.xfCurve = c
    this.savePrefs()
    this.engine.setXfader(param('xfader').value, c)
  }

  private applyCfx(): void {
    for (const ch of this.engine.ch) ch.cfx.setType(this.smartCfx ? this.prefs.cfx : 'filter')
  }

  get cfxName(): string {
    return this.smartCfx ? CFX_LIST.find((c) => c.type === this.prefs.cfx)!.name : 'FILTER'
  }

  private assignFx(i: number): void {
    this.fxCh = i
    const e = this.engine
    for (const s of [e.ch[0].slot, e.ch[1].slot, e.masterSlot]) s.assign(null)
    ;[e.ch[0].slot, e.ch[1].slot, e.masterSlot][i].assign(this.beatFx)
  }

  private selectFx(dir: number): void {
    const i = FX_LIST.findIndex((f) => f.type === this.beatFx.type)
    this.beatFx.setType(FX_LIST[(i + dir + FX_LIST.length) % FX_LIST.length].type)
  }

  private stepFxBeat(dir: number): void {
    let i = BEATS.indexOf(this.beatFx.beat)
    if (i < 0) i = BEATS.findIndex((b) => b >= this.beatFx.beat)
    this.beatFx.setBeat(BEATS[Math.max(0, Math.min(BEATS.length - 1, i + dir))])
  }

  get fxBeatLabel(): string {
    return this.beatFx.type === 'reverb' ? '—' : beatLabel(this.beatFx.beat)
  }

  private setMaster(d: Deck): void {
    if (this.masterDeck === d) return
    if (d.sync) d.holdRate = d.rate
    this.masterDeck = d
    const o = d === this.decks[0] ? this.decks[1] : this.decks[0]
    if (o.sync) o.applyRate()
  }

  private onPlayState(d: Deck): void {
    const o = d === this.decks[0] ? this.decks[1] : this.decks[0]
    if (d.playing && !this.masterDeck.playing) this.setMaster(d)
    else if (!d.playing && this.masterDeck === d && o.playing) this.setMaster(o)
  }

  private smartUpdate(): void {
    const [A, B] = this.decks
    const ch = this.engine.ch
    if (!this.smartFader) {
      for (const d of this.decks) {
        if (d.smartRate !== null) {
          d.smartRate = null
          d.applyRate()
        }
      }
      ch[0].setSmartEq(0)
      ch[1].setSmartEq(0)
      return
    }
    const x = param('xfader').value
    if (A.track?.bpm && B.track?.bpm) {
      const bA = A.track.bpm * A.sliderRate
      const bB = B.track.bpm * B.sliderRate
      const target = bA + (bB - bA) * x
      A.smartRate = target / A.track.bpm
      B.smartRate = target / B.track.bpm
      A.applyRate()
      B.applyRate()
    }
    ch[0].setSmartEq(x > 0.5 ? -26 * (x - 0.5) * 2 : 0)
    ch[1].setSmartEq(x < 0.5 ? -26 * (0.5 - x) * 2 : 0)
  }

  private tick(): void {
    this.beatFx.tick()
    for (const d of this.decks) d.fx.tick()
    for (const ch of this.engine.ch) ch.cfx.tick()
  }

  async setOutput(mode: OutputMode, device?: string): Promise<void> {
    try {
      await this.engine.setOutput(mode, device)
    } catch {
      this.say('That output is not available in this browser')
      await this.engine.setOutput('master')
    }
  }

  // ── library ─────────────────────────────────────────────────────────────

  browse(delta: number): void {
    if (!this.tracks.length) return
    this.sel = Math.max(0, Math.min(this.tracks.length - 1, this.sel + delta))
    this.onLibrary()
  }

  private idleDeck(): Deck {
    const [a, b] = this.decks
    if (!a.track) return a
    if (!b.track) return b
    if (a.playing && !b.playing) return b
    if (b.playing && !a.playing) return a
    return this.masterDeck === a ? b : a
  }

  loadDeck(n: 1 | 2, t: Track | undefined = this.tracks[this.sel], force = false): void {
    const d = this.decks[n - 1]
    if (!t) return this.say('The library is empty. Drop audio files anywhere to add them.')
    if (!t.buffer) return this.say(`${t.name} is still decoding`)
    if (d.playing && !force) return this.say(`Deck ${n} is playing. Pause it first, or SHIFT + LOAD.`)
    const o = this.decks[2 - n]
    const doubles = o.track === t
    d.load(t, doubles ? o : undefined)
    param(`d${n}.tempo`).set(d.tempo, 'app')
    if (doubles) this.say(`Instant doubles: deck ${n} copied deck ${o.n}`)
    if (this.smartFader) this.smartUpdate()
  }

  private newTrack(key: string, name: string, artist: string): Track {
    const cues = store<Track['cues']>(CUES_KEY + key) ?? { cue: -1, hot: new Array(8).fill(null) }
    return {
      id: this.nextTrack++, key, name, artist, buffer: null, duration: 0,
      bpm: 0, firstBeat: 0, gain: 1, wave: null, status: 'decoding', cues,
    }
  }

  async addFiles(files: File[], loadTo?: 1 | 2): Promise<void> {
    const audio = files.filter((f) => f.type.startsWith('audio') || AUDIO_EXT.test(f.name))
    if (!audio.length) return this.say('No audio files in that drop')
    const made = audio.map((f) => {
      const base = f.name.replace(/\.[^.]+$/, '')
      const dash = base.indexOf(' - ')
      const t = dash > 0
        ? this.newTrack(`${f.name}|${f.size}`, base.slice(dash + 3), base.slice(0, dash))
        : this.newTrack(`${f.name}|${f.size}`, base, '')
      this.tracks.push(t)
      return { f, t }
    })
    this.sel = this.tracks.length - made.length
    this.onLibrary()
    for (const [k, { f, t }] of made.entries()) {
      try {
        t.buffer = await this.engine.ctx.decodeAudioData(await f.arrayBuffer())
        t.duration = t.buffer.duration
        t.status = 'analyzing'
        this.onLibrary()
        if (loadTo && k === 0) this.loadDeck(loadTo, t)
        const L = t.buffer.getChannelData(0).slice()
        const R = t.buffer.getChannelData(t.buffer.numberOfChannels > 1 ? 1 : 0).slice()
        await this.analyzed(t, L, R)
      } catch {
        t.status = 'error'
        this.onLibrary()
      }
    }
  }

  private async analyzed(t: Track, L: Float32Array<ArrayBuffer>, R: Float32Array<ArrayBuffer>): Promise<void> {
    const a = await this.call<Analysis>({ t: 'analyze', L, R, sr: this.engine.ctx.sampleRate }, [L.buffer, R.buffer])
    t.bpm = a.bpm
    t.firstBeat = a.firstBeat
    t.gain = a.gain
    t.wave = a.wave
    t.status = 'ready'
    for (const d of this.decks) if (d.track === t) d.trackUpdated()
    this.onLibrary()
  }

  async loadDemos(): Promise<void> {
    const sr = this.engine.ctx.sampleRate
    const made = DEMOS.map((spec) => {
      const t = this.newTrack('demo:' + spec.name, spec.name, 'FLX4 demo')
      this.tracks.push(t)
      return t
    })
    this.onLibrary()
    for (const [i, t] of made.entries()) {
      const { L, R } = await this.call<{ L: Float32Array<ArrayBuffer>; R: Float32Array<ArrayBuffer> }>({ t: 'demo', index: i, sr })
      const buf = this.engine.ctx.createBuffer(2, L.length, sr)
      buf.copyToChannel(L, 0)
      buf.copyToChannel(R, 1)
      t.buffer = buf
      t.duration = buf.duration
      t.status = 'analyzing'
      this.onLibrary()
      await this.analyzed(t, L, R)
      const d = this.decks[i]
      if (d && !d.track) this.loadDeck(d.n, t)
    }
  }

  // ── what the surface shows ──────────────────────────────────────────────

  padLabel(d: Deck, i: number): string {
    switch (d.padMode) {
      case 'hotcue':
        return 'ABCDEFGH'[i]
      case 'keyboard':
        return (KEYBOARD[i] > 0 ? '+' : '') + KEYBOARD[i]
      case 'padfx1':
      case 'padfx2':
        return PAD_FX[d.padMode][i].label
      case 'beatjump':
        return (BEAT_JUMPS[i] < 0 ? '◀ ' : '▶ ') + Math.abs(BEAT_JUMPS[i])
      case 'beatloop':
        return beatLabel(BEAT_LOOPS[i])
      case 'sampler':
        return this.engine.sampler.names[samplerSlot(d.n, i)]
      case 'keyshift':
        return KEY_SHIFTS[i] === 0 ? '0' : (KEY_SHIFTS[i] > 0 ? '+' : '') + KEY_SHIFTS[i]
    }
  }

  // LED brightness: 0 off, 0.5 dim (on-screen only), 1 lit.
  updateLeds(now: number): void {
    const slow = Math.floor(now / 500) % 2 === 0 ? 1 : 0
    const fast = Math.floor(now / 160) % 2 === 0 ? 1 : 0
    const led = (id: string, v: number): void => button(id).led.set(v)
    for (const d of this.decks) {
      const n = d.n
      const loaded = !!d.track
      const atCue = loaded && Math.abs(d.pos - d.cuePoint) < 0.01
      led(`d${n}.play`, d.playing ? 1 : loaded ? slow : 0)
      led(`d${n}.cue`, d.cuePreview ? 1 : d.playing || !loaded ? 0 : atCue ? 1 : fast)
      led(`d${n}.sync`, d.sync ? 1 : 0)
      led(`d${n}.syncBadge`, d.sync ? 1 : 0)
      led(`d${n}.syncMaster`, this.masterDeck === d ? 1 : 0)
      const l = d.loop
      led(`d${n}.loopIn`, l.on ? slow : l.in >= 0 && l.out < 0 ? 1 : 0)
      led(`d${n}.loopOut`, l.on ? slow : 0)
      led(`d${n}.reloop`, l.on ? 1 : l.in >= 0 && l.out > l.in ? 0.5 : 0)
      led(`d${n}.callPrev`, l.on ? 0.5 : 0)
      led(`d${n}.callNext`, l.on ? 0.5 : 0)
      for (const m of MODE_BUTTONS) {
        const alt = { hotcue: 'keyboard', padfx1: 'padfx2', beatjump: 'beatloop', sampler: 'keyshift' }[m]
        led(`d${n}.mode.${m}`, d.padMode === m ? 1 : d.padMode === alt ? slow : 0)
      }
      for (let i = 0; i < 8; i++) led(`d${n}.pad${i}`, this.padLed(d, i, fast))
      led(`d${n}.hpcue`, this.hpCue[n - 1] ? 1 : 0)
      led(`d${n}.keylock`, d.keylock ? 1 : 0)
      led(`d${n}.slip`, d.slip ? 1 : 0)
      led(`d${n}.vinyl`, d.vinyl ? 1 : 0)
    }
    led('masterCue', this.masterCue ? 1 : 0)
    led('fx.on', this.beatFx.on ? slow * 0.5 + 0.5 : 0)
    led('smartFader', this.smartFader ? 1 : 0)
    led('smartCfx', this.smartCfx ? 1 : 0)
    led('quantize', this.prefs.quantize ? 1 : 0)
  }

  private padLed(d: Deck, i: number, fast: number): number {
    const held = d.padsDown[i]
    switch (d.padMode) {
      case 'hotcue':
        return d.hot[i] !== null && d.hot[i] !== undefined ? 1 : held ? 1 : 0
      case 'keyboard':
        return d.semis === KEYBOARD[i] ? 1 : 0.5
      case 'padfx1':
      case 'padfx2':
      case 'beatjump':
        return held ? 1 : 0.5
      case 'beatloop': {
        const l = d.loop
        const len = d.beatLen ? (l.out - l.in) / d.beatLen : 0
        return l.on && Math.abs(len - BEAT_LOOPS[i]) < 1e-3 ? 1 : 0.5
      }
      case 'sampler': {
        const slot = samplerSlot(d.n, i)
        if (this.engine.sampler.playing(slot)) return fast
        return this.engine.sampler.bufs[slot] ? 1 : 0
      }
      case 'keyshift':
        return d.semis === KEY_SHIFTS[i] ? 1 : 0.5
    }
  }
}
