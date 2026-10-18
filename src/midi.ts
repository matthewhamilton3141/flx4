// A real DDJ-FLX4 over Web MIDI. The message numbers follow the controller's
// published MIDI layout (cross-checked against Mixxx's FLX4 mapping): decks on
// channels 1/2, mixer on 7, beat FX on 5/6, pads on 8–11.

import type { App } from './app.ts'
import { button, param, setShift } from './bus.ts'

type Target =
  | { k: 'btn'; id: string; shift?: boolean }
  | { k: 'param'; id: string; lsb?: boolean; tempo?: boolean }
  | { k: 'jog'; deck: 1 | 2; top: boolean; search?: boolean }
  | { k: 'touch'; deck: 1 | 2 }
  | { k: 'shift'; deck: 1 | 2 }
  | { k: 'browse'; fast?: boolean }
  | { k: 'fxch'; ch: 0 | 1 }

const TICKS_PER_REV = 720
const PAD_MODE_OFFSETS = [0x00, 0x10, 0x20, 0x30, 0x40, 0x50, 0x60, 0x70]
const PAD_LED_OFFSET: Record<string, number> = {
  hotcue: 0x00, padfx1: 0x10, beatjump: 0x20, sampler: 0x30,
  keyboard: 0x40, padfx2: 0x50, beatloop: 0x60, keyshift: 0x70,
}

function buildMap(): Map<number, Target> {
  const m = new Map<number, Target>()
  const key = (status: number, d1: number): number => (status << 8) | d1
  for (const n of [1, 2] as const) {
    const note = 0x90 + n - 1
    const cc = 0xb0 + n - 1
    const btn = (d1: number, id: string, shift = false): void => {
      m.set(key(note, d1), { k: 'btn', id: `d${n}.${id}`, shift })
    }
    btn(0x0b, 'play')
    btn(0x0e, 'play', true)
    btn(0x0c, 'cue')
    btn(0x48, 'cue', true)
    btn(0x58, 'sync')
    btn(0x5c, 'syncMaster')
    btn(0x60, 'sync', true)
    btn(0x10, 'loopIn')
    btn(0x4c, 'loopIn', true)
    btn(0x11, 'loopOut')
    btn(0x4e, 'loopOut', true)
    btn(0x4d, 'reloop')
    btn(0x50, 'reloop', true)
    btn(0x51, 'callPrev')
    btn(0x3e, 'callPrev', true)
    btn(0x53, 'callNext')
    btn(0x3d, 'callNext', true)
    btn(0x1b, 'mode.hotcue')
    btn(0x69, 'mode.hotcue', true)
    btn(0x1e, 'mode.padfx1')
    btn(0x6b, 'mode.padfx1', true)
    btn(0x20, 'mode.beatjump')
    btn(0x6d, 'mode.beatjump', true)
    btn(0x22, 'mode.sampler')
    btn(0x6f, 'mode.sampler', true)
    btn(0x54, 'hpcue')
    btn(0x68, 'hpcue', true)
    m.set(key(note, 0x3f), { k: 'shift', deck: n })
    m.set(key(note, 0x36), { k: 'touch', deck: n })
    m.set(key(note, 0x67), { k: 'touch', deck: n })
    m.set(key(cc, 0x22), { k: 'jog', deck: n, top: true })
    m.set(key(cc, 0x23), { k: 'jog', deck: n, top: false })
    m.set(key(cc, 0x21), { k: 'jog', deck: n, top: false })
    m.set(key(cc, 0x29), { k: 'jog', deck: n, top: true, search: true })
    m.set(key(cc, 0x1f), { k: 'jog', deck: n, top: false, search: true })
    const prm = (d1: number, id: string, tempo = false): void => {
      m.set(key(cc, d1), { k: 'param', id: `d${n}.${id}`, tempo })
      m.set(key(cc, d1 + 0x20), { k: 'param', id: `d${n}.${id}`, lsb: true, tempo })
    }
    prm(0x00, 'tempo', true)
    prm(0x04, 'trim')
    prm(0x07, 'hi')
    prm(0x0b, 'mid')
    prm(0x0f, 'low')
    prm(0x13, 'fader')
    const padNote = 0x97 + (n - 1) * 2
    for (const off of PAD_MODE_OFFSETS) {
      for (let i = 0; i < 8; i++) {
        m.set(key(padNote, off + i), { k: 'btn', id: `d${n}.pad${i}` })
        m.set(key(padNote + 1, off + i), { k: 'btn', id: `d${n}.pad${i}`, shift: true })
      }
    }
  }
  const mix = (d1: number, id: string): void => {
    m.set(key(0xb6, d1), { k: 'param', id })
    m.set(key(0xb6, d1 + 0x20), { k: 'param', id, lsb: true })
  }
  mix(0x17, 'd1.cfx')
  mix(0x18, 'd2.cfx')
  mix(0x1f, 'xfader')
  mix(0x0c, 'hpMix')
  m.set(key(0xb6, 0x40), { k: 'browse' })
  m.set(key(0xb6, 0x64), { k: 'browse', fast: true })
  m.set(key(0x96, 0x46), { k: 'btn', id: 'd1.load' })
  m.set(key(0x96, 0x47), { k: 'btn', id: 'd2.load' })
  m.set(key(0x96, 0x58), { k: 'btn', id: 'd1.load', shift: true })
  m.set(key(0x96, 0x59), { k: 'btn', id: 'd2.load', shift: true })
  m.set(key(0x96, 0x41), { k: 'btn', id: 'browse.push' })
  m.set(key(0x94, 0x63), { k: 'btn', id: 'fx.select' })
  m.set(key(0x94, 0x64), { k: 'btn', id: 'fx.select', shift: true })
  m.set(key(0x94, 0x4a), { k: 'btn', id: 'fx.beatL' })
  m.set(key(0x94, 0x4b), { k: 'btn', id: 'fx.beatR' })
  for (const st of [0x94, 0x95]) {
    m.set(key(st, 0x47), { k: 'btn', id: 'fx.on' })
    m.set(key(st, 0x43), { k: 'btn', id: 'fx.on', shift: true })
  }
  m.set(key(0x94, 0x10), { k: 'fxch', ch: 0 })
  m.set(key(0x95, 0x11), { k: 'fxch', ch: 1 })
  m.set(key(0xb4, 0x02), { k: 'param', id: 'fx.level' })
  m.set(key(0xb4, 0x22), { k: 'param', id: 'fx.level', lsb: true })
  return m
}

// LEDs: [status, note] pairs that mirror each button's LED, including the
// SHIFT layer so lights stay correct while SHIFT is held.
function ledTargets(): [string, [number, number][]][] {
  const out: [string, [number, number][]][] = []
  for (const n of [1, 2] as const) {
    const s = 0x90 + n - 1
    out.push([`d${n}.play`, [[s, 0x0b], [s, 0x47]]])
    out.push([`d${n}.cue`, [[s, 0x0c], [s, 0x48]]])
    out.push([`d${n}.sync`, [[s, 0x58], [s, 0x60]]])
    out.push([`d${n}.loopIn`, [[s, 0x10], [s, 0x4c]]])
    out.push([`d${n}.loopOut`, [[s, 0x11], [s, 0x4e]]])
    out.push([`d${n}.reloop`, [[s, 0x4d], [s, 0x50]]])
    out.push([`d${n}.hpcue`, [[s, 0x54], [s, 0x68]]])
    out.push([`d${n}.mode.hotcue`, [[s, 0x1b], [s, 0x69]]])
    out.push([`d${n}.mode.padfx1`, [[s, 0x1e], [s, 0x6b]]])
    out.push([`d${n}.mode.beatjump`, [[s, 0x20], [s, 0x6d]]])
    out.push([`d${n}.mode.sampler`, [[s, 0x22], [s, 0x6f]]])
  }
  out.push(['fx.on', [[0x94, 0x47], [0x94, 0x43], [0x95, 0x47], [0x95, 0x43]]])
  return out
}

type MidiAccess = {
  inputs: Map<string, MIDIInput>
  outputs: Map<string, MIDIOutput>
  onstatechange: ((e: Event) => void) | null
}

export class Midi {
  status = 'Not connected'
  lastMsg = ''
  connected = false
  private readonly app: App
  private readonly map = buildMap()
  private access: MidiAccess | null = null
  private out: MIDIOutput | null = null
  private readonly msb = new Map<string, number>()
  private readonly sent = new Map<number, number>()
  private keepAlive = 0
  private sysex = false
  private fxCh = [false, false]

  constructor(app: App) {
    this.app = app
  }

  get supported(): boolean {
    return 'requestMIDIAccess' in navigator
  }

  async connect(): Promise<void> {
    if (!this.supported) {
      this.status = 'Web MIDI needs Chrome or Edge'
      return
    }
    try {
      // SysEx lets us send the FLX4's keep-alive; fall back without it.
      try {
        this.access = (await navigator.requestMIDIAccess({ sysex: true })) as unknown as MidiAccess
        this.sysex = true
      } catch {
        this.access = (await navigator.requestMIDIAccess()) as unknown as MidiAccess
      }
    } catch {
      this.status = 'MIDI permission denied'
      return
    }
    this.access.onstatechange = () => this.attach()
    this.attach()
  }

  private attach(): void {
    const a = this.access
    if (!a) return
    const isFlx = (p: MIDIPort): boolean => /FLX4|DDJ/i.test(p.name ?? '')
    const ins = [...a.inputs.values()]
    for (const i of ins) i.onmidimessage = (e) => this.onMessage(e as MIDIMessageEvent)
    const flxIn = ins.find(isFlx)
    this.out = [...a.outputs.values()].find(isFlx) ?? null
    this.connected = !!flxIn
    this.status = flxIn ? flxIn.name ?? 'DDJ-FLX4' : ins.length ? `${ins.length} MIDI input(s), no FLX4` : 'No MIDI devices'
    this.sent.clear()
    clearInterval(this.keepAlive)
    if (this.out) {
      // Deck "track loaded" sweep, like rekordbox does on connect.
      this.send(0x9f, 0x00, 0x7f)
      this.send(0x9f, 0x01, 0x7f)
      if (this.sysex) {
        this.keepAlive = window.setInterval(() => {
          try {
            this.out?.send([0xf0, 0x00, 0x40, 0x05, 0x00, 0x00, 0x04, 0x05, 0x00, 0x50, 0x02, 0xf7])
          } catch {
            // port went away
          }
        }, 200)
      }
    }
  }

  private onMessage(e: MIDIMessageEvent): void {
    const d = e.data
    if (!d || d.length < 3) return
    let [st, d1, v] = d
    if ((st & 0xf0) === 0x80) {
      st = 0x90 | (st & 0x0f)
      v = 0
    }
    const t = this.map.get((st << 8) | d1)
    this.lastMsg = `${hex(st)} ${hex(d1)} ${hex(v)}${t ? '' : ' (unmapped)'}`
    if (!t) return
    switch (t.k) {
      case 'btn':
        button(t.id).press(v > 0, t.shift)
        return
      case 'shift':
        setShift(t.deck, v > 0)
        return
      case 'touch':
        this.app.decks[t.deck - 1].jogTouch(v > 0)
        return
      case 'jog': {
        const deck = this.app.decks[t.deck - 1]
        const revs = (v - 64) / TICKS_PER_REV
        if (t.search) deck.jogTurn(revs, t.top, true)
        else deck.jogTurn(revs, t.top, false)
        return
      }
      case 'browse':
        this.app.browse((v < 64 ? v : v - 128) * (t.fast ? 5 : 1))
        return
      case 'fxch':
        this.fxCh[t.ch] = v > 0
        param('fx.ch').set(this.fxCh[0] ? 0 : this.fxCh[1] ? 1 : 2, 'midi')
        return
      case 'param': {
        const p = param(t.id)
        let norm: number
        if (t.lsb) {
          const hi = this.msb.get(t.id) ?? 0
          norm = (hi * 128 + v) / 16383
        } else {
          this.msb.set(t.id, v)
          norm = v / 127
        }
        // Tempo is 14-bit with + (faster) at the bottom: rate = 1 − value/8192.
        const val = t.tempo ? 1 - norm * (16383 / 8192) : p.min + norm * (p.max - p.min)
        p.set(val, 'midi')
        return
      }
    }
  }

  private send(st: number, d1: number, v: number): void {
    const k = (st << 8) | d1
    if (this.sent.get(k) === v) return
    this.sent.set(k, v)
    try {
      this.out?.send([st, d1, v])
    } catch {
      // port went away
    }
  }

  private readonly leds = ledTargets()

  // Called every frame: pushes changed LEDs and the channel level meters.
  frame(levels: [number, number]): void {
    if (!this.out) return
    for (const [id, pairs] of this.leds) {
      const v = button(id).led.value >= 1 ? 0x7f : 0
      for (const [st, d1] of pairs) this.send(st, d1, v)
    }
    for (const d of this.app.decks) {
      const off = PAD_LED_OFFSET[d.padMode]
      const st = 0x97 + (d.n - 1) * 2
      for (let i = 0; i < 8; i++) {
        const v = button(`d${d.n}.pad${i}`).led.value >= 1 ? 0x7f : 0
        this.send(st, off + i, v)
        this.send(st + 1, off + i, v)
      }
    }
    this.send(0xb0, 0x02, Math.round(Math.min(1, levels[0]) * 127))
    this.send(0xb1, 0x02, Math.round(Math.min(1, levels[1]) * 127))
  }
}

const hex = (n: number): string => n.toString(16).toUpperCase().padStart(2, '0')
