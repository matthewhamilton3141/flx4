// Every control on the controller is a Param (continuous) or a Button
// (momentary, with an LED). The on-screen surface, the keyboard and a real
// DDJ-FLX4 over MIDI all drive the same objects, so they stay in sync.

export type Src = 'ui' | 'midi' | 'key' | 'app'
type Listener = (v: number, src: Src) => void

export class Param {
  readonly id: string
  readonly def: number
  readonly min: number
  readonly max: number
  value: number
  private ls: Listener[] = []

  constructor(id: string, def: number, min: number, max: number) {
    this.id = id
    this.def = def
    this.min = min
    this.max = max
    this.value = def
  }

  set(v: number, src: Src = 'app'): void {
    v = Math.min(this.max, Math.max(this.min, v))
    if (v === this.value) return
    this.value = v
    for (const l of this.ls) l(v, src)
  }

  reset(src: Src = 'ui'): void {
    this.set(this.def, src)
  }

  on(l: Listener): () => void {
    this.ls.push(l)
    return () => {
      this.ls = this.ls.filter((x) => x !== l)
    }
  }
}

export type Handler = (down: boolean, shift: boolean) => void

export class Button {
  readonly id: string
  readonly deck: 0 | 1 | 2
  readonly led: Param
  down = false
  handler: Handler = () => {}
  private shiftAtDown = false

  constructor(id: string) {
    this.id = id
    this.deck = id.startsWith('d1.') ? 1 : id.startsWith('d2.') ? 2 : 0
    this.led = new Param(id + ':led', 0, 0, 1)
  }

  press(down: boolean, shift?: boolean): void {
    if (down === this.down) return
    this.down = down
    if (down) this.shiftAtDown = shift ?? isShift(this.deck)
    this.handler(down, this.shiftAtDown)
    if (down && !this.id.endsWith('.shift')) consumeLatch(this.deck)
  }
}

const params = new Map<string, Param>()
const buttons = new Map<string, Button>()

export function param(id: string, def = 0, min = 0, max = 1): Param {
  let p = params.get(id)
  if (!p) {
    p = new Param(id, def, min, max)
    params.set(id, p)
  }
  return p
}

export function button(id: string): Button {
  let b = buttons.get(id)
  if (!b) {
    b = new Button(id)
    buttons.set(id, b)
  }
  return b
}

// SHIFT: held (physical/keyboard/long-press) or latched by a quick tap on the
// on-screen button, in which case it applies to the next press on that deck.
const held = [false, false, false]
const latched = [false, false, false]

export function setShift(deck: 1 | 2, on: boolean): void {
  held[deck] = on
  if (!on) latched[deck] = false
  button(`d${deck}.shift`).led.set(on ? 1 : 0)
}

export function latchShift(deck: 1 | 2): void {
  latched[deck] = true
}

export function isShift(deck: 0 | 1 | 2): boolean {
  return deck === 0 ? held[1] || held[2] : held[deck]
}

function consumeLatch(deck: 0 | 1 | 2): void {
  for (const d of deck === 0 ? ([1, 2] as const) : ([deck] as const)) {
    if (latched[d]) {
      const b = button(`d${d}.shift`)
      b.down = false
      setShift(d, false)
    }
  }
}
