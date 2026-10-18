// Page shell: top bar (outputs, settings, REC, MIDI), help, drag-and-drop,
// scaling the controller to the window, and the frame loop.

import type { App, Prefs } from '../app.ts'
import { CFX_LIST, type CfxType } from '../audio/cfx.ts'
import type { OutputMode } from '../audio/engine.ts'
import { Midi } from '../midi.ts'
import { KEYS, bindKeys } from './keys.ts'
import { buildScreen, trackById } from './screen.ts'
import { buildSurface } from './surface.ts'
import { h } from './widgets.ts'

function select<T extends string>(label: string, options: [T, string][], value: T, onChange: (v: T) => void): { el: HTMLElement; sel: HTMLSelectElement } {
  const el = h('label', 'tb-sel')
  el.append(h('span', '', label))
  const sel = h('select')
  for (const [v, t] of options) {
    const o = h('option', '', t)
    o.value = v
    sel.append(o)
  }
  sel.value = value
  sel.addEventListener('change', () => onChange(sel.value as T))
  el.append(sel)
  return { el, sel }
}

function applyTheme(t: Prefs['theme']): void {
  if (t === 'auto') delete document.documentElement.dataset.theme
  else document.documentElement.dataset.theme = t
}

export function buildUI(app: App): void {
  const root = document.getElementById('app')!
  const midi = new Midi(app)
  applyTheme(app.prefs.theme)

  // ── top bar ──
  const bar = h('header', 'topbar')
  const audioPill = h('button', 'pill warn', 'Click anywhere to start audio')
  const toast = h('div', 'toast')

  const out = select<OutputMode | 'device-pick'>('Output', [
    ['master', 'Master only'],
    ['split', 'Split cue (L cue · R master)'],
    ['quad', 'FLX4 4-ch (1/2 master · 3/4 phones)'],
    ['device', 'Phones on another device…'],
  ], 'master', async (v) => {
    if (v === 'device') {
      await fillDevices()
      devSel.el.hidden = false
      if (devSel.sel.value) await app.setOutput('device', devSel.sel.value)
    } else {
      devSel.el.hidden = true
      if (v === 'quad' && !app.engine.quadAvailable) {
        app.say('This output device has fewer than 4 channels. Pick the DDJ-FLX4 as your system output first.')
        out.sel.value = app.engine.outMode
        return
      }
      await app.setOutput(v as OutputMode)
    }
  })
  const devSel = select<string>('Phones', [], '', (v) => void app.setOutput('device', v))
  devSel.el.hidden = true
  const fillDevices = async (): Promise<void> => {
    try {
      const devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audiooutput')
      devSel.sel.replaceChildren(
        ...devs.map((d, i) => {
          const o = h('option', '', d.label || `Output ${i + 1}`)
          o.value = d.deviceId
          return o
        }),
      )
      if (!devs.length) app.say('No output devices visible to the browser')
    } catch {
      app.say('Could not list audio devices')
    }
  }
  const cfx = select<CfxType>('Smart CFX', CFX_LIST.map((c) => [c.type, c.name]), app.prefs.cfx, (v) => app.setCfxType(v))
  const curve = select<Prefs['xfCurve']>('X-fader', [['smooth', 'Smooth'], ['sharp', 'Sharp cut']], app.prefs.xfCurve, (v) => app.setXfCurve(v))

  const q = h('button', 'tb-btn', 'QUANTIZE')
  q.title = 'Quantize: hot cues, loops and jumps snap to the beat grid'
  q.addEventListener('click', () => app.toggleQuantize())

  const rec = h('button', 'tb-btn rec', 'REC')
  rec.title = 'Record the master output'
  rec.addEventListener('click', async () => {
    const e = app.engine
    if (!e.recording) {
      e.startRecording()
      return
    }
    const blob = await e.stopRecording()
    const a = h('a')
    a.href = URL.createObjectURL(blob)
    const ext = blob.type.includes('mp4') ? 'm4a' : 'webm'
    a.download = `flx4-mix-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.${ext}`
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 10000)
  })

  const midiBtn = h('button', 'tb-btn', 'CONNECT FLX4')
  midiBtn.title = 'Use a real DDJ-FLX4 over USB (Chrome/Edge)'
  midiBtn.addEventListener('click', () => void midi.connect())
  const midiInfo = h('span', 'midi-info')

  const theme = select<Prefs['theme']>('Theme', [['auto', 'Match system'], ['light', 'Light'], ['dark', 'Dark']], app.prefs.theme, (v) => {
    app.prefs.theme = v
    app.savePrefs()
    applyTheme(v)
    screen.colors()
  })
  const helpBtn = h('button', 'tb-btn', '?')
  helpBtn.title = 'Shortcuts and tips ( ` )'

  // Set-and-forget options live behind one button.
  const settingsBtn = h('button', 'tb-btn', 'SETTINGS')
  const settings = h('div', 'settings')
  settings.hidden = true
  settings.append(out.el, devSel.el, cfx.el, curve.el, theme.el)
  settingsBtn.addEventListener('click', (e) => {
    e.stopPropagation()
    settings.hidden = !settings.hidden
    settingsBtn.dataset.led = settings.hidden ? 'off' : 'on'
  })
  settings.addEventListener('click', (e) => e.stopPropagation())
  window.addEventListener('click', () => {
    settings.hidden = true
    settingsBtn.dataset.led = 'off'
  })

  const left = h('div', 'tb-left')
  left.append(h('b', 'brand', 'FLX4'), audioPill, toast)
  const right = h('div', 'tb-right')
  right.append(midiInfo, q, rec, midiBtn, settingsBtn, helpBtn, settings)
  bar.append(left, right)

  // ── file input ──
  const file = h('input')
  file.type = 'file'
  file.accept = 'audio/*'
  file.multiple = true
  file.hidden = true
  file.addEventListener('change', () => {
    if (file.files) void app.addFiles([...file.files])
    file.value = ''
  })

  const screen = buildScreen(app, () => file.click())
  const surface = buildSurface(app)
  const stage = h('div', 'stage')
  const scaler = h('div', 'scaler')
  scaler.append(surface.el)
  stage.append(scaler)

  // ── help ──
  const help = h('div', 'help')
  help.hidden = true
  const card = h('div', 'help-card')
  const close = h('button', 'tb-btn', 'CLOSE')
  close.addEventListener('click', () => (help.hidden = true))
  const k = (id: string): string => KEYS.find((x) => x[1] === id)?.[2] ?? ''
  const rows: [string, string, string][] = [
    ['PLAY / CUE / SYNC', `${k('d1.play')} ${k('d1.cue')} ${k('d1.sync')}`, `${k('d2.play')} ${k('d2.cue')} ${k('d2.sync')}`],
    ['LOOP IN / OUT / RELOOP', `${k('d1.loopIn')} ${k('d1.loopOut')} ${k('d1.reloop')}`, `${k('d2.loopIn')} ${k('d2.loopOut')} ${k('d2.reloop')}`],
    ['Pads 1–8', '1 2 3 4 / Q W E R', '7 8 9 0 / U I O P'],
    ['Pad mode (Shift: alt mode)', 'T', 'Y'],
    ['Pitch bend − / +', 'V B', 'N M'],
    ['Headphone CUE', k('d1.hpcue'), k('d2.hpcue')],
    ['LOAD selected track', '[', ']'],
  ]
  const table = h('table', 'keys')
  const th = h('tr')
  th.append(h('th', '', ''), h('th', '', 'Deck 1'), h('th', '', 'Deck 2'))
  table.append(th)
  for (const [a, b, c] of rows) {
    const tr = h('tr')
    tr.append(h('td', '', a), h('td', 'kbd', b), h('td', 'kbd', c))
    table.append(tr)
  }
  const tips = h('ul', 'tips')
  for (const t of [
    'Shift = SHIFT on both decks. A quick tap on an on-screen SHIFT latches it for one press.',
    '← → crossfader (Shift: slam), ↑ ↓ browse, Enter loads to the idle deck, \\ toggles BEAT FX, ` opens this.',
    'Knobs and faders: drag, scroll, or double-click to reset. Alt-drag for fine control.',
    'Jog: the inner platter scratches (VINYL on), the outer ring bends pitch. SHIFT + jog searches. You can also drag the waveforms.',
    'CUE works like a CDJ: tap while paused to set the cue, hold at the cue to preview.',
    'BEAT SYNC: tap to sync to the master deck, hold 1 s to make the deck master, SHIFT for tempo range.',
    'LOOP IN: hold or SHIFT for a 4-beat loop. CUE/LOOP CALL ◀ ▶ halve/double an active loop.',
    'Hot cue pads: press to set or jump, SHIFT + pad deletes. With QUANTIZE on, jumps land on the next beat.',
    'Drop audio onto a sampler pad (SAMPLER mode) to replace that sample.',
    'A real DDJ-FLX4 works too: CONNECT FLX4, then pick it as the output and choose "FLX4 4-ch" for headphone cueing.',
  ]) tips.append(h('li', '', t))
  card.append(h('h2', '', 'Shortcuts'), table, tips, close)
  help.append(card)
  help.addEventListener('click', (e) => {
    if (e.target === help) help.hidden = true
  })
  const toggleHelp = (): void => {
    help.hidden = !help.hidden
  }
  helpBtn.addEventListener('click', toggleHelp)

  root.append(bar, screen.el, stage, help, file)
  bindKeys(app, toggleHelp)

  // ── audio unlock ──
  const ctx = app.engine.ctx
  const unlock = (): void => {
    if (ctx.state !== 'running') void ctx.resume()
  }
  window.addEventListener('pointerdown', unlock, true)
  window.addEventListener('keydown', unlock, true)
  audioPill.addEventListener('click', unlock)

  // ── drag and drop ──
  let dragDepth = 0
  window.addEventListener('dragenter', (e) => {
    if (e.dataTransfer?.types.includes('Files')) {
      dragDepth++
      document.body.classList.add('dragging')
    }
  })
  window.addEventListener('dragleave', () => {
    if (--dragDepth <= 0) {
      dragDepth = 0
      document.body.classList.remove('dragging')
    }
  })
  window.addEventListener('dragover', (e) => e.preventDefault())
  window.addEventListener('drop', () => document.body.classList.remove('dragging'), true)
  window.addEventListener('drop', (e) => {
    e.preventDefault()
    dragDepth = 0
    document.body.classList.remove('dragging')
    unlock()
    const deckEl = (e.target as HTMLElement).closest<HTMLElement>('[data-deck]')
    const n = deckEl ? (Number(deckEl.dataset.deck) as 1 | 2) : undefined
    const id = e.dataTransfer?.getData('text/x-flx4-track')
    if (id) {
      const t = trackById(app, Number(id))
      if (t && n) app.loadDeck(n, t)
      return
    }
    const files = [...(e.dataTransfer?.files ?? [])]
    if (files.length) void app.addFiles(files, n)
  })

  // ── fit the controller to the window ──
  // Fill the width, but shrink to keep the whole controller on screen when
  // the window is short (never below 62%, where it'd get fiddly).
  const DESIGN_W = 1408
  const fit = (): void => {
    const w = stage.clientWidth - 32
    const top = stage.getBoundingClientRect().top + window.scrollY
    const avail = window.innerHeight - top - 14
    const s = Math.max(Math.min(0.62, w / DESIGN_W), Math.min(1.25, w / DESIGN_W, avail / surface.el.offsetHeight))
    scaler.style.transform = `scale(${s})`
    scaler.style.marginLeft = `${Math.max(0, (w - DESIGN_W * s) / 2)}px`
    stage.style.height = `${surface.el.offsetHeight * s + 20}px`
  }
  new ResizeObserver(fit).observe(stage)
  new ResizeObserver(fit).observe(screen.el)
  window.addEventListener('resize', fit)
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => screen.colors())

  // ── frame loop ──
  const frame = (now: number): void => {
    app.updateLeds(now)
    surface.frame()
    screen.frame(app.prefs.theme + document.documentElement.dataset.theme)
    const e = app.engine
    midi.frame([e.peak(e.ch[0].meter) * 1.4, e.peak(e.ch[1].meter) * 1.4])

    audioPill.hidden = ctx.state === 'running'
    q.dataset.led = app.prefs.quantize ? 'on' : 'off'
    rec.dataset.led = e.recording ? 'on' : 'off'
    const recTxt = e.recording ? `REC ${fmtClock((performance.now() - e.recStart) / 1000)}` : 'REC'
    if (rec.textContent !== recTxt) rec.textContent = recTxt
    midiBtn.dataset.led = midi.connected ? 'on' : 'off'
    const mi = midi.connected ? `${midi.status}${midi.lastMsg ? ' · ' + midi.lastMsg : ''}` : midi.status === 'Not connected' ? '' : midi.status
    if (midiInfo.textContent !== mi) midiInfo.textContent = mi
    const tt = now < app.toastUntil ? app.toast : ''
    if (toast.textContent !== tt) toast.textContent = tt
    requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)
}

const fmtClock = (s: number): string => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`
