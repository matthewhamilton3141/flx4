// On-screen controls. Each one drives a Param or Button on the bus and
// listens back, so MIDI and keyboard moves show up here too.

import type { Deck } from '../audio/deck.ts'
import { button, isShift, latchShift, param, type Param } from '../bus.ts'

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag)
  if (cls) el.className = cls
  if (text) el.textContent = text
  return el
}

const SVG = 'http://www.w3.org/2000/svg'
function s<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG, tag)
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v))
  return el
}

function arc(cx: number, cy: number, r: number, a0: number, a1: number): string {
  const p = (a: number): string => {
    const rad = ((a - 90) * Math.PI) / 180
    return `${(cx + r * Math.cos(rad)).toFixed(2)} ${(cy + r * Math.sin(rad)).toFixed(2)}`
  }
  if (Math.abs(a1 - a0) < 0.5) return ''
  const [from, to] = a0 < a1 ? [a0, a1] : [a1, a0]
  return `M ${p(from)} A ${r} ${r} 0 ${to - from > 180 ? 1 : 0} 1 ${p(to)}`
}

export function labeled(el: HTMLElement, label: string, cls = ''): HTMLElement {
  const w = h('div', `ctl ${cls}`)
  w.append(el, h('span', 'lbl', label))
  return w
}

// Rotary: drag up/down (Alt for fine), scroll, double-click to reset.
export function knob(id: string, label: string, opts: { size?: number; center?: boolean; def?: number; min?: number; max?: number; cls?: string } = {}): HTMLElement {
  const p = param(id, opts.def ?? 0.5, opts.min ?? 0, opts.max ?? 1)
  const size = opts.size ?? 40
  const el = h('div', 'knob')
  el.style.width = el.style.height = `${size}px`
  el.tabIndex = -1
  const svg = s('svg', { viewBox: '0 0 40 40', width: size, height: size })
  const track = s('path', { class: 'k-track', d: arc(20, 20, 18, -135, 135) })
  const val = s('path', { class: 'k-val' })
  const body = s('circle', { class: 'k-body', cx: 20, cy: 20, r: 14 })
  const ind = s('line', { class: 'k-ind', x1: 20, y1: 8, x2: 20, y2: 15 })
  svg.append(track, val, body, ind)
  el.append(svg)
  const center = opts.center ?? false
  const draw = (v: number): void => {
    const n = (v - p.min) / (p.max - p.min)
    const a = -135 + n * 270
    ind.setAttribute('transform', `rotate(${a} 20 20)`)
    val.setAttribute('d', arc(20, 20, 18, center ? 0 : -135, a))
  }
  p.on(draw)
  draw(p.value)

  let startY = 0
  let startV = 0
  el.addEventListener('pointerdown', (e) => {
    el.setPointerCapture(e.pointerId)
    startY = e.clientY
    startV = p.value
    el.classList.add('active')
    e.preventDefault()
  })
  el.addEventListener('pointermove', (e) => {
    if (!el.hasPointerCapture(e.pointerId)) return
    const range = p.max - p.min
    let v = startV + ((startY - e.clientY) / (e.altKey ? 800 : 200)) * range
    if (center && Math.abs(v - p.def) < range * 0.015) v = p.def
    p.set(v, 'ui')
  })
  const end = (e: PointerEvent): void => {
    el.releasePointerCapture(e.pointerId)
    el.classList.remove('active')
  }
  el.addEventListener('pointerup', end)
  el.addEventListener('pointercancel', end)
  el.addEventListener('dblclick', () => p.reset())
  el.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault()
      p.set(p.value - (e.deltaY / 1500) * (p.max - p.min), 'ui')
    },
    { passive: false },
  )
  return labeled(el, label, opts.cls ?? '')
}

// Linear fader. `top` is the value at the top (or left) end.
export function fader(id: string, label: string, opts: { length: number; horizontal?: boolean; def?: number; min?: number; max?: number; topIsMin?: boolean; ticks?: number; detent?: boolean; cls?: string }): HTMLElement {
  const p = param(id, opts.def ?? 0.5, opts.min ?? 0, opts.max ?? 1)
  const hz = !!opts.horizontal
  const el = h('div', `fader ${hz ? 'hz' : 'vt'}`)
  el.style[hz ? 'width' : 'height'] = `${opts.length}px`
  const slot = h('div', 'slot')
  const cap = h('div', 'cap')
  el.append(slot)
  if (opts.ticks) {
    const t = h('div', 'ticks')
    for (let i = 0; i <= opts.ticks; i++) {
      const tick = h('i', i === opts.ticks / 2 && opts.detent ? 'mid' : '')
      tick.style[hz ? 'left' : 'top'] = `${(i / opts.ticks) * 100}%`
      t.append(tick)
    }
    el.append(t)
  }
  el.append(cap)
  // f: 0 at the top/left end, 1 at the bottom/right.
  const toF = (v: number): number => {
    const n = (v - p.min) / (p.max - p.min)
    return hz || opts.topIsMin ? n : 1 - n
  }
  const fromF = (f: number): number => {
    const n = hz || opts.topIsMin ? f : 1 - f
    return p.min + n * (p.max - p.min)
  }
  const draw = (v: number): void => {
    const f = toF(v)
    cap.style[hz ? 'left' : 'top'] = `calc(${f * 100}% - ${f * (hz ? 22 : 34)}px)`
  }
  p.on(draw)
  draw(p.value)

  let grab = 0
  const fAt = (e: PointerEvent): number => {
    const r = el.getBoundingClientRect()
    const c = cap.getBoundingClientRect()
    const len = hz ? r.width - c.width : r.height - c.height
    const pos = (hz ? e.clientX - r.left - c.width / 2 : e.clientY - r.top - c.height / 2) - grab
    return Math.max(0, Math.min(1, pos / len))
  }
  el.addEventListener('pointerdown', (e) => {
    el.setPointerCapture(e.pointerId)
    const c = cap.getBoundingClientRect()
    const onCap = hz ? e.clientX >= c.left && e.clientX <= c.right : e.clientY >= c.top && e.clientY <= c.bottom
    grab = onCap ? (hz ? e.clientX - (c.left + c.width / 2) : e.clientY - (c.top + c.height / 2)) : 0
    move(e)
    e.preventDefault()
  })
  const move = (e: PointerEvent): void => {
    if (!el.hasPointerCapture(e.pointerId)) return
    let v = fromF(fAt(e))
    if (opts.detent && Math.abs(v - p.def) < (p.max - p.min) * 0.012) v = p.def
    p.set(v, 'ui')
  }
  el.addEventListener('pointermove', move)
  el.addEventListener('pointerup', (e) => el.releasePointerCapture(e.pointerId))
  el.addEventListener('dblclick', () => p.reset())
  el.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault()
      const d = (hz ? e.deltaX || e.deltaY : e.deltaY) / 2000
      p.set(p.value + (hz || opts.topIsMin ? d : -d) * (p.max - p.min), 'ui')
    },
    { passive: false },
  )
  return labeled(el, label, opts.cls ?? '')
}

function ledClass(el: HTMLElement, v: number): void {
  el.dataset.led = v >= 1 ? 'on' : v > 0 ? 'dim' : 'off'
}

// Momentary button bound to a bus Button; LED shows as fill.
// `shift` is the SHIFT function printed on the hardware; it only shows while
// SHIFT is held so the surface stays quiet otherwise.
export function btn(id: string, label: string, opts: { sub?: string; shift?: string; cls?: string; title?: string } = {}): HTMLElement {
  const b = button(id)
  const el = h('button', `btn ${opts.cls ?? ''}`)
  el.type = 'button'
  el.append(h('span', 'main', label))
  if (opts.sub) el.append(h('span', 'sub', opts.sub))
  if (opts.shift) el.append(h('span', 'shift-sub', opts.shift))
  if (opts.title) el.title = opts.title
  b.led.on((v) => ledClass(el, v))
  ledClass(el, b.led.value)
  const isShiftBtn = id.endsWith('.shift')
  let downAt = 0
  el.addEventListener('pointerdown', (e) => {
    el.setPointerCapture(e.pointerId)
    downAt = performance.now()
    b.press(true)
    e.preventDefault()
  })
  const up = (): void => {
    if (!b.down) return
    // A quick tap on SHIFT latches it for the next press on that deck.
    if (isShiftBtn && performance.now() - downAt < 250) {
      latchShift(b.deck as 1 | 2)
      return
    }
    b.press(false)
  }
  el.addEventListener('pointerup', up)
  el.addEventListener('pointercancel', up)
  el.addEventListener('contextmenu', (e) => e.preventDefault())
  return el
}

export function pad(d: Deck, i: number): { el: HTMLElement; label: HTMLElement } {
  const el = btn(`d${d.n}.pad${i}`, '', { cls: 'pad' })
  const label = el.querySelector('.main') as HTMLElement
  return { el, label }
}

// Jog wheel: the platter (inner disc) scratches in vinyl mode; the outer ring
// bends pitch. SHIFT + turn searches.
export function jog(d: Deck, size: number): { el: HTMLElement; marker: SVGGElement } {
  const el = h('div', 'jog')
  el.style.width = el.style.height = `${size}px`
  const svg = s('svg', { viewBox: '0 0 300 300', width: size, height: size })
  svg.append(s('circle', { class: 'j-ring', cx: 150, cy: 150, r: 147 }))
  for (let i = 0; i < 72; i++) {
    const a = (i / 72) * Math.PI * 2
    svg.append(
      s('line', {
        class: 'j-tick',
        x1: 150 + 140 * Math.cos(a), y1: 150 + 140 * Math.sin(a),
        x2: 150 + 132 * Math.cos(a), y2: 150 + 132 * Math.sin(a),
      }),
    )
  }
  svg.append(s('circle', { class: 'j-platter', cx: 150, cy: 150, r: 118 }))
  for (const r of [104, 90, 76]) svg.append(s('circle', { class: 'j-groove', cx: 150, cy: 150, r }))
  const marker = s('g')
  marker.append(s('line', { class: 'j-mark', x1: 150, y1: 36, x2: 150, y2: 70 }))
  svg.append(marker, s('circle', { class: 'j-hub', cx: 150, cy: 150, r: 28 }))
  el.append(svg)
  const deckLabel = h('div', 'j-label', String(d.n))
  el.append(deckLabel)

  let last = 0
  let top = false
  const angle = (e: PointerEvent | WheelEvent): { a: number; r: number } => {
    const rc = el.getBoundingClientRect()
    const x = e.clientX - (rc.left + rc.width / 2)
    const y = e.clientY - (rc.top + rc.height / 2)
    return { a: Math.atan2(y, x), r: Math.hypot(x, y) / (rc.width / 2) }
  }
  el.addEventListener('pointerdown', (e) => {
    el.setPointerCapture(e.pointerId)
    const { a, r } = angle(e)
    last = a
    top = r < 118 / 150
    if (top) {
      d.jogTouch(true)
      el.classList.add('touched')
    }
    e.preventDefault()
  })
  el.addEventListener('pointermove', (e) => {
    if (!el.hasPointerCapture(e.pointerId)) return
    const { a } = angle(e)
    let da = a - last
    if (da > Math.PI) da -= 2 * Math.PI
    if (da < -Math.PI) da += 2 * Math.PI
    last = a
    d.jogTurn(da / (2 * Math.PI), top, isShift(d.n))
  })
  const up = (e: PointerEvent): void => {
    el.releasePointerCapture(e.pointerId)
    if (top) d.jogTouch(false)
    top = false
    el.classList.remove('touched')
  }
  el.addEventListener('pointerup', up)
  el.addEventListener('pointercancel', up)
  el.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault()
      d.jogTurn(-e.deltaY / 3000, false, isShift(d.n))
    },
    { passive: false },
  )
  return { el, marker }
}

export function meter(segments: number): { el: HTMLElement; set: (level: number) => void } {
  const el = h('div', 'meter')
  const segs: HTMLElement[] = []
  for (let i = 0; i < segments; i++) {
    const seg = h('i')
    el.prepend(seg)
    segs.push(seg)
  }
  let shown = -1
  return {
    el,
    set: (level) => {
      // level is linear peak; map -36…0 dBFS onto the segments.
      const db = 20 * Math.log10(level + 1e-6)
      const lit = Math.max(0, Math.min(segments, Math.round(((db + 36) / 36) * segments)))
      if (lit === shown) return
      shown = lit
      segs.forEach((sg, i) => sg.classList.toggle('on', i < lit))
    },
  }
}

// FX channel lever: 1 / 2 / MASTER.
export function lever(id: string, labels: string[]): HTMLElement {
  const p: Param = param(id)
  const el = h('div', 'lever')
  const opts = labels.map((l, i) => {
    const o = h('button', 'lv', l)
    o.type = 'button'
    o.addEventListener('pointerdown', () => p.set(i, 'ui'))
    el.append(o)
    return o
  })
  const draw = (v: number): void => opts.forEach((o, i) => o.classList.toggle('sel', i === Math.round(v)))
  p.on(draw)
  draw(p.value)
  return el
}

// Endless rotary encoder (BROWSE): drag or scroll to step, click to press.
export function encoder(label: string, size: number, onStep: (n: number) => void, onPress: () => void): HTMLElement {
  const el = h('div', 'knob encoder')
  el.style.width = el.style.height = `${size}px`
  const svg = s('svg', { viewBox: '0 0 40 40', width: size, height: size })
  const ind = s('line', { class: 'k-ind', x1: 20, y1: 6, x2: 20, y2: 13 })
  svg.append(s('circle', { class: 'k-body', cx: 20, cy: 20, r: 17 }))
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * Math.PI * 2
    svg.append(s('line', { class: 'k-knurl', x1: 20 + 17 * Math.cos(a), y1: 20 + 17 * Math.sin(a), x2: 20 + 19 * Math.cos(a), y2: 20 + 19 * Math.sin(a) }))
  }
  svg.append(ind)
  el.append(svg)
  let angle = 0
  const step = (n: number): void => {
    angle += n * 15
    ind.setAttribute('transform', `rotate(${angle} 20 20)`)
    onStep(n)
  }
  let lastY = 0
  let moved = 0
  el.addEventListener('pointerdown', (e) => {
    el.setPointerCapture(e.pointerId)
    lastY = e.clientY
    moved = 0
    e.preventDefault()
  })
  el.addEventListener('pointermove', (e) => {
    if (!el.hasPointerCapture(e.pointerId)) return
    const dy = lastY - e.clientY
    if (Math.abs(dy) >= 12) {
      const n = Math.trunc(dy / 12)
      lastY -= n * 12
      moved += Math.abs(n)
      step(-n)
    }
  })
  el.addEventListener('pointerup', (e) => {
    el.releasePointerCapture(e.pointerId)
    if (!moved) onPress()
  })
  let wheel = 0
  el.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault()
      wheel += e.deltaY
      const n = Math.trunc(wheel / 40)
      if (n) {
        wheel -= n * 40
        step(n)
      }
    },
    { passive: false },
  )
  return labeled(el, label)
}
