// The software side you'd see on the laptop: deck readouts, scrolling
// 3-band waveforms with the beat grid, overviews, and the library.

import type { App } from '../app.ts'
import type { Deck, Track } from '../audio/deck.ts'
import { TEMPO_RANGES } from '../audio/deck.ts'
import { btn, h } from './widgets.ts'

interface Colors {
  fg: string
  bg: string
  mut: string
  font: string
}

export function readColors(): Colors {
  const cs = getComputedStyle(document.documentElement)
  return {
    fg: cs.getPropertyValue('--fg').trim() || '#000',
    bg: cs.getPropertyValue('--bg').trim() || '#fff',
    mut: cs.getPropertyValue('--mut').trim() || '#888',
    font: cs.getPropertyValue('--font').trim() || 'sans-serif',
  }
}

const fmt = (t: number): string => {
  const s = Math.max(0, t)
  const m = Math.floor(s / 60)
  const r = s - m * 60
  return `${String(m).padStart(2, '0')}:${r.toFixed(1).padStart(4, '0')}`
}

function fitCanvas(c: HTMLCanvasElement): CanvasRenderingContext2D {
  const dpr = window.devicePixelRatio || 1
  const w = Math.max(1, Math.round(c.clientWidth * dpr))
  const hh = Math.max(1, Math.round(c.clientHeight * dpr))
  if (c.width !== w || c.height !== hh) {
    c.width = w
    c.height = hh
  }
  const g = c.getContext('2d')!
  g.setTransform(dpr, 0, 0, dpr, 0, 0)
  return g
}

function setText(el: HTMLElement, t: string): void {
  if (el.textContent !== t) el.textContent = t
}

class DeckPanel {
  readonly el: HTMLElement
  private readonly d: Deck
  private readonly name = h('b', 'name')
  private readonly artist = h('span', 'artist')
  private readonly bpm = h('b', 'bpm-v')
  private readonly time = h('span', 'time')
  private readonly tempo = h('button', 'tempo-v')
  private readonly key = h('span', 'key-v')
  private readonly beat = h('span', 'beat-v')
  private readonly loop = h('span', 'loop-v')
  private readonly overview = h('canvas', 'overview')
  private remaining = true
  private cache: { id: number; w: number; h: number; theme: string; img: HTMLCanvasElement } | null = null

  constructor(d: Deck) {
    this.d = d
    const n = d.n
    this.el = h('div', `dinfo dinfo${n}`)
    this.el.dataset.deck = String(n)
    const num = h('span', 'num', String(n))
    const title = h('div', 'title')
    title.append(this.name, this.artist)
    const bpm = h('div', 'bpm')
    bpm.append(this.bpm, h('span', 'unit', 'BPM'))
    const row1 = h('div', 'row1')
    row1.append(num, title, bpm)

    this.tempo.title = 'Tempo range (SHIFT + BEAT SYNC)'
    this.tempo.addEventListener('click', () => d.cycleRange())
    this.time.title = 'Click: elapsed / remaining'
    this.time.addEventListener('click', () => (this.remaining = !this.remaining))
    const badges = h('div', 'badges')
    badges.append(
      btn(`d${n}.syncMaster`, 'MASTER', { cls: 'badge', title: 'Tempo master (or hold BEAT SYNC)' }),
      btn(`d${n}.syncBadge`, 'SYNC', { cls: 'badge' }),
      btn(`d${n}.keylock`, 'MT', { cls: 'badge', title: 'Master Tempo: keep pitch when changing tempo' }),
      btn(`d${n}.slip`, 'SLIP', { cls: 'badge', title: 'Slip: scratches and held hot cues return to where the track would be' }),
      btn(`d${n}.vinyl`, 'VINYL', { cls: 'badge', title: 'Vinyl mode: touching the platter scratches' }),
    )
    const row2 = h('div', 'row2')
    row2.append(this.time, this.tempo, this.key, this.beat, this.loop, badges)
    this.el.append(row1, row2, this.overview)

    let seeking = false
    const seekTo = (e: PointerEvent): void => {
      const r = this.overview.getBoundingClientRect()
      if (d.track) d.seek(((e.clientX - r.left) / r.width) * d.duration)
    }
    this.overview.addEventListener('pointerdown', (e) => {
      seeking = true
      this.overview.setPointerCapture(e.pointerId)
      seekTo(e)
    })
    this.overview.addEventListener('pointermove', (e) => seeking && seekTo(e))
    this.overview.addEventListener('pointerup', () => (seeking = false))
  }

  frame(c: Colors, theme: string): void {
    const d = this.d
    const t = d.track
    setText(this.name, t ? t.name : 'No track')
    setText(this.artist, t ? (t.status === 'ready' ? t.artist : t.status === 'error' ? 'could not decode' : `${t.status}…`) : 'Drop a file here or press LOAD')
    setText(this.bpm, d.bpm ? d.bpm.toFixed(2) : '—')
    const pos = d.pos
    setText(this.time, t ? (this.remaining ? '−' + fmt(d.duration - pos) : fmt(pos)) : '--:--.-')
    const pct = (d.rate - 1) * 100
    const range = TEMPO_RANGES[d.rangeIdx]
    setText(this.tempo, `${pct >= 0 ? '+' : '−'}${Math.abs(pct).toFixed(2)}%  ${range >= 1 ? 'WIDE' : '±' + Math.round(range * 100)}`)
    setText(this.key, d.semis ? `KEY ${d.semis > 0 ? '+' : ''}${d.semis}` : '')
    if (t?.bpm) {
      const b = Math.floor(d.beatAt(pos) + 1e-3)
      setText(this.beat, `${Math.floor(b / 4) + 1}.${(((b % 4) + 4) % 4) + 1}`)
    } else setText(this.beat, '')
    const l = d.loop
    setText(this.loop, l.on && d.beatLen ? `LOOP ${fmtBeats((l.out - l.in) / d.beatLen)}` : l.on ? 'LOOP' : '')
    this.drawOverview(c, theme)
  }

  private drawOverview(c: Colors, theme: string): void {
    const cv = this.overview
    const g = fitCanvas(cv)
    const W = cv.clientWidth
    const H = cv.clientHeight
    g.clearRect(0, 0, W, H)
    const d = this.d
    const t = d.track
    if (!t?.wave) {
      g.fillStyle = c.mut
      g.fillRect(0, H / 2, W, 1)
      return
    }
    const dpr = window.devicePixelRatio || 1
    if (!this.cache || this.cache.id !== t.id || this.cache.w !== W || this.cache.h !== H || this.cache.theme !== theme) {
      const img = document.createElement('canvas')
      img.width = Math.round(W * dpr)
      img.height = Math.round(H * dpr)
      const ig = img.getContext('2d')!
      ig.scale(dpr, dpr)
      const w = t.wave
      const per = w.peak.length / W
      for (const [arr, alpha] of [[w.low, 0.3], [w.mid, 0.55], [w.high, 1]] as const) {
        ig.fillStyle = c.fg
        ig.globalAlpha = alpha
        for (let x = 0; x < W; x++) {
          let m = 0
          const a = Math.floor(x * per)
          const b = Math.max(a + 1, Math.floor((x + 1) * per))
          for (let i = a; i < b; i++) if (arr[i] > m) m = arr[i]
          const hh = (m / 255) * (H / 2 - 1)
          ig.fillRect(x, H / 2 - hh, 1, hh * 2)
        }
      }
      this.cache = { id: t.id, w: W, h: H, theme, img }
    }
    const px = (d.pos / d.duration) * W
    g.save()
    g.globalAlpha = 0.3
    g.beginPath()
    g.rect(0, 0, px, H)
    g.clip()
    g.drawImage(this.cache.img, 0, 0, W, H)
    g.restore()
    g.save()
    g.beginPath()
    g.rect(px, 0, W - px, H)
    g.clip()
    g.drawImage(this.cache.img, 0, 0, W, H)
    g.restore()
    g.fillStyle = c.fg
    const l = d.loop
    if (l.in >= 0 && l.out > l.in) {
      g.globalAlpha = l.on ? 0.22 : 0.1
      g.fillRect((l.in / d.duration) * W, 0, Math.max(1, ((l.out - l.in) / d.duration) * W), H)
      g.globalAlpha = 1
    }
    g.font = `600 9px ${c.font}`
    for (const [i, hc] of d.hot.entries()) {
      if (hc === null || hc === undefined) continue
      const x = (hc / d.duration) * W
      g.fillRect(x, 0, 1, H)
      g.fillRect(x, 0, 9, 10)
      g.fillStyle = c.bg
      g.fillText('ABCDEFGH'[i], x + 1.5, 8.5)
      g.fillStyle = c.fg
    }
    const cx = (d.cuePoint / d.duration) * W
    g.beginPath()
    g.moveTo(cx - 4, H)
    g.lineTo(cx + 4, H)
    g.lineTo(cx, H - 6)
    g.fill()
    g.fillRect(Math.round(px) - 1, 0, 2, H)
  }
}

function fmtBeats(b: number): string {
  if (b >= 1) return String(Math.round(b * 100) / 100)
  const inv = Math.round(1 / b)
  return `1/${inv}`
}

// Two scrolling waveforms around a fixed playhead. Time is scaled by each
// deck's rate so synced decks show their grids lined up.
class Waveforms {
  readonly el: HTMLElement
  private readonly app: App
  private readonly cvs: HTMLCanvasElement[]

  constructor(app: App) {
    this.app = app
    this.el = h('div', 'waves')
    this.cvs = [h('canvas', 'wave'), h('canvas', 'wave')]
    this.cvs.forEach((c, i) => (c.dataset.deck = String(i + 1)))
    const zoom = h('div', 'zoom')
    const out = h('button', 'zbtn', '−')
    const inn = h('button', 'zbtn', '+')
    out.title = 'Zoom out'
    inn.title = 'Zoom in'
    out.addEventListener('click', () => this.setZoom(app.prefs.zoom / 1.5))
    inn.addEventListener('click', () => this.setZoom(app.prefs.zoom * 1.5))
    zoom.append(out, inn)
    this.el.append(this.cvs[0], this.cvs[1], zoom)
    for (const [i, c] of this.cvs.entries()) {
      // Drag a waveform to nudge/scratch that deck like grabbing the platter.
      let last = 0
      c.addEventListener('pointerdown', (e) => {
        c.setPointerCapture(e.pointerId)
        last = e.clientX
        app.decks[i].jogTouch(true)
      })
      c.addEventListener('pointermove', (e) => {
        if (!c.hasPointerCapture(e.pointerId)) return
        const dx = e.clientX - last
        last = e.clientX
        const pps = 150 * app.prefs.zoom
        app.decks[i].jogTurn(-dx / pps / 1.8, true, false)
      })
      const up = (): void => app.decks[i].jogTouch(false)
      c.addEventListener('pointerup', up)
      c.addEventListener('pointercancel', up)
    }
  }

  private setZoom(z: number): void {
    this.app.prefs.zoom = Math.max(0.25, Math.min(6, z))
    this.app.savePrefs()
  }

  frame(c: Colors): void {
    for (const [i, cv] of this.cvs.entries()) this.draw(cv, this.app.decks[i], c)
  }

  private draw(cv: HTMLCanvasElement, d: Deck, c: Colors): void {
    const g = fitCanvas(cv)
    const W = cv.clientWidth
    const H = cv.clientHeight
    g.clearRect(0, 0, W, H)
    const t = d.track
    const mid = H / 2
    g.fillStyle = c.fg
    if (!t?.wave) {
      g.globalAlpha = 0.3
      g.fillRect(0, mid, W, 1)
      g.globalAlpha = 1
      g.fillRect(Math.round(W / 2) - 1, 0, 2, H)
      return
    }
    const w = t.wave
    const pps = 150 * this.app.prefs.zoom
    const rate = d.rate > 0.01 ? d.rate : 1
    const pos = d.pos
    const half = W / 2
    const span = rate / pps // track seconds per pixel
    const toX = (time: number): number => half + (time - pos) / span

    // Loop region under everything.
    const l = d.loop
    if (l.in >= 0 && l.out > l.in) {
      g.globalAlpha = l.on ? 0.14 : 0.06
      g.fillRect(toX(l.in), 0, toX(l.out) - toX(l.in), H)
    }
    for (const [arr, alpha, scale] of [[w.low, 0.28, 1], [w.mid, 0.55, 0.85], [w.high, 1, 0.7]] as const) {
      g.globalAlpha = alpha
      g.beginPath()
      for (let x = 0; x < W; x++) {
        const t0 = pos + (x - half) * span
        const a = Math.floor(t0 * w.rate)
        const b = Math.max(a + 1, Math.floor((t0 + span) * w.rate))
        let m = 0
        for (let k = Math.max(0, a); k < Math.min(arr.length, b); k++) if (arr[k] > m) m = arr[k]
        if (!m) continue
        const hh = (m / 255) * (mid - 2) * scale
        g.rect(x, mid - hh, 1, hh * 2)
      }
      g.fill()
    }

    // Beat grid, bars heavier, with bar numbers.
    if (t.bpm) {
      const bl = 60 / t.bpm
      const b0 = Math.ceil(d.beatAt(pos - half * span))
      const b1 = Math.floor(d.beatAt(pos + half * span))
      g.font = `600 9px ${c.font}`
      for (let b = Math.max(b0, Math.ceil(-t.firstBeat / bl)); b <= b1; b++) {
        const x = Math.round(toX(t.firstBeat + b * bl))
        const bar = ((b % 4) + 4) % 4 === 0
        g.globalAlpha = bar ? 0.75 : 0.25
        g.fillRect(x, 0, bar ? 1.5 : 1, bar ? H : 6)
        if (bar) {
          g.fillRect(x, H - 6, 1.5, 6)
          g.globalAlpha = 0.7
          g.fillText(String(Math.floor(b / 4) + 1), x + 3, H - 3)
        }
      }
      // Phase: which beat of the bar we're on.
      const cur = ((Math.floor(d.beatAt(pos) + 1e-3) % 4) + 4) % 4
      for (let k = 0; k < 4; k++) {
        g.globalAlpha = 1
        if (k === cur) g.fillRect(6 + k * 12, 5, 9, 5)
        else g.strokeRect(6.5 + k * 12, 5.5, 8, 4)
      }
    }

    g.globalAlpha = 1
    g.font = `700 9px ${c.font}`
    for (const [i, hc] of d.hot.entries()) {
      if (hc === null || hc === undefined) continue
      const x = Math.round(toX(hc))
      if (x < -12 || x > W) continue
      g.fillRect(x, 0, 1, H)
      g.fillRect(x, 0, 11, 11)
      g.fillStyle = c.bg
      g.fillText('ABCDEFGH'[i], x + 2.5, 9)
      g.fillStyle = c.fg
    }
    const cx = toX(d.cuePoint)
    g.beginPath()
    g.moveTo(cx - 5, H)
    g.lineTo(cx + 5, H)
    g.lineTo(cx, H - 7)
    g.fill()

    g.fillRect(Math.round(half) - 1, 0, 2, H)
    g.fillText(String(d.n), W - 12, 11)
  }
}

class Library {
  readonly el: HTMLElement
  private readonly app: App
  private readonly body: HTMLTableSectionElement
  private readonly count = h('span', 'count')
  private readonly current = h('span', 'current')

  constructor(app: App, onAdd: () => void) {
    this.app = app
    this.el = h('div', 'library')
    // Collapsed it's one line showing the BROWSE selection; click to open.
    const head = h('div', 'lib-head')
    const toggle = h('button', 'lib-toggle')
    toggle.append(h('span', 'caret', '▸'), h('b', '', 'Collection'), this.count)
    toggle.addEventListener('click', () => {
      app.prefs.libOpen = !app.prefs.libOpen
      app.savePrefs()
      this.el.classList.toggle('open', app.prefs.libOpen)
      this.render()
    })
    const add = h('button', 'add', 'Add files…')
    add.addEventListener('click', onAdd)
    head.append(toggle, this.current, add)
    this.el.classList.toggle('open', app.prefs.libOpen)
    const table = h('table')
    const thead = h('thead')
    const tr = h('tr')
    for (const c of ['#', 'Title', 'Artist', 'BPM', 'Time', '', 'Load']) tr.append(h('th', '', c))
    thead.append(tr)
    this.body = h('tbody')
    table.append(thead, this.body)
    const wrap = h('div', 'lib-scroll')
    wrap.append(table)
    this.el.append(head, wrap)
    app.onLibrary = () => this.render()
  }

  render(): void {
    const app = this.app
    setText(this.count, `${app.tracks.length} track${app.tracks.length === 1 ? '' : 's'}`)
    const sel = app.tracks[app.sel]
    setText(this.current, sel ? `▸ ${sel.name}${sel.bpm ? '  ' + sel.bpm.toFixed(1) : ''}` : 'Drop audio anywhere to add it')
    this.body.replaceChildren(
      ...app.tracks.map((t, i) => {
        const tr = h('tr')
        if (i === app.sel) tr.className = 'sel'
        tr.draggable = true
        tr.addEventListener('dragstart', (e) => e.dataTransfer?.setData('text/x-flx4-track', String(t.id)))
        tr.addEventListener('click', () => {
          app.sel = i
          this.render()
        })
        tr.addEventListener('dblclick', () => {
          app.sel = i
          const d = !app.decks[0].playing ? 1 : 2
          app.loadDeck(d, t)
        })
        const st = t.status === 'ready' ? '' : t.status === 'error' ? 'error' : t.status + '…'
        const loadCell = h('td', 'loads')
        for (const n of [1, 2] as const) {
          const b = h('button', 'mini', String(n))
          b.title = `Load to deck ${n}`
          b.addEventListener('click', (e) => {
            e.stopPropagation()
            app.loadDeck(n, t)
          })
          loadCell.append(b)
        }
        tr.append(
          h('td', 'idx', String(i + 1)),
          h('td', 'ttl', t.name),
          h('td', 'art', t.artist),
          h('td', 'r', t.bpm ? t.bpm.toFixed(2) : ''),
          h('td', 'r', t.duration ? fmt(t.duration).replace(/\.\d$/, '') : ''),
          h('td', 'st', st),
          loadCell,
        )
        return tr
      }),
    )
    this.body.querySelector('tr.sel')?.scrollIntoView({ block: 'nearest' })
  }
}

export interface Screen {
  el: HTMLElement
  frame(theme: string): void
  colors(): void
}

export function trackById(app: App, id: number): Track | undefined {
  return app.tracks.find((t) => t.id === id)
}

export function buildScreen(app: App, onAdd: () => void): Screen {
  const el = h('div', 'screen')
  const panels = app.decks.map((d) => new DeckPanel(d))
  const infos = h('div', 'infos')
  infos.append(panels[0].el, panels[1].el)
  const waves = new Waveforms(app)
  const lib = new Library(app, onAdd)
  el.append(infos, waves.el, lib.el)
  lib.render()
  let c = readColors()
  return {
    el,
    colors: () => (c = readColors()),
    frame(theme) {
      for (const p of panels) p.frame(c, theme)
      waves.frame(c)
    },
  }
}
