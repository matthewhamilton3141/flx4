// The controller itself, laid out like the hardware: deck 1 | mixer | deck 2,
// with the browse/load and BEAT FX strip across the top.

import type { App } from '../app.ts'
import { samplerSlot, type Deck } from '../audio/deck.ts'
import { FX_LIST } from '../audio/fx.ts'
import { button, isShift } from '../bus.ts'
import { btn, encoder, fader, h, jog, knob, lever, meter, pad } from './widgets.ts'

export interface Surface {
  el: HTMLElement
  frame(): void
}

function deckBlock(app: App, d: Deck): { el: HTMLElement; frame(): void } {
  const n = d.n
  const el = h('section', `deck deck${n}`)
  el.dataset.deck = String(n)

  const loops = h('div', 'loops')
  loops.append(
    btn(`d${n}.loopIn`, 'IN', { shift: '4 BEAT', cls: 'sm' }),
    btn(`d${n}.loopOut`, 'OUT', { cls: 'sm' }),
    btn(`d${n}.reloop`, 'RELOOP/EXIT', { cls: 'sm wide' }),
  )
  const call = h('div', 'call')
  call.append(
    btn(`d${n}.callPrev`, '◀', { cls: 'sm sq', title: 'CUE/LOOP CALL: halve loop · previous cue (SHIFT: jump −4)' }),
    h('span', 'tiny', 'CUE/LOOP CALL'),
    btn(`d${n}.callNext`, '▶', { cls: 'sm sq', title: 'CUE/LOOP CALL: double loop · next cue (SHIFT: jump +4)' }),
  )
  const head = h('div', 'deck-head')
  head.append(loops, call)

  const { el: jogEl, marker } = jog(d, 290)

  const transport = h('div', 'transport')
  transport.append(
    btn(`d${n}.shift`, 'SHIFT', { cls: 'sm shift' }),
    btn(`d${n}.cue`, 'CUE', { cls: 'round' }),
    btn(`d${n}.play`, '▶❚❚', { cls: 'round' }),
  )

  const modes = h('div', 'modes')
  modes.append(
    btn(`d${n}.mode.hotcue`, 'HOT CUE', { shift: 'KEYBOARD', cls: 'mode' }),
    btn(`d${n}.mode.padfx1`, 'PAD FX1', { shift: 'PAD FX2', cls: 'mode' }),
    btn(`d${n}.mode.beatjump`, 'BEAT JUMP', { shift: 'BEAT LOOP', cls: 'mode' }),
    btn(`d${n}.mode.sampler`, 'SAMPLER', { shift: 'KEY SHIFT', cls: 'mode' }),
  )
  const grid = h('div', 'pads')
  const pads = Array.from({ length: 8 }, (_, i) => pad(d, i))
  for (const [i, p] of pads.entries()) {
    grid.append(p.el)
    // Drop an audio file on a sampler pad to replace that slot.
    p.el.addEventListener('dragover', (e) => {
      if (d.padMode === 'sampler') e.preventDefault()
    })
    p.el.addEventListener('drop', async (e) => {
      if (d.padMode !== 'sampler') return
      const f = e.dataTransfer?.files[0]
      if (!f) return
      e.preventDefault()
      e.stopPropagation()
      try {
        const buf = await app.engine.ctx.decodeAudioData(await f.arrayBuffer())
        app.engine.sampler.set(samplerSlot(n, i), f.name.replace(/\.[^.]+$/, '').slice(0, 10).toUpperCase(), buf)
      } catch {
        app.say(`Couldn't decode ${f.name}`)
      }
    })
  }
  const padArea = h('div', 'pad-area')
  padArea.append(modes, grid)
  const bottom = h('div', 'deck-bottom')
  bottom.append(transport, padArea)

  const main = h('div', 'deck-main')
  main.append(head, jogEl, bottom)

  const tempoCol = h('div', 'tempo-col')
  tempoCol.append(
    btn(`d${n}.sync`, 'BEAT SYNC', { shift: 'TEMPO RANGE', cls: 'sm sync', title: 'Hold 1 s: make this deck the master' }),
    fader(`d${n}.tempo`, 'TEMPO', { length: 370, def: 0, min: -1, max: 1, topIsMin: true, ticks: 10, detent: true, cls: 'tempo' }),
  )
  const tempoLed = h('i', 'tempo-led')
  tempoCol.append(tempoLed)
  el.append(main, tempoCol)

  const padText = pads.map(() => '')
  return {
    el,
    frame() {
      marker.setAttribute('transform', `rotate(${((d.pos / 1.8) * 360) % 360} 150 150)`)
      for (let i = 0; i < 8; i++) {
        const t = app.padLabel(d, i)
        if (t !== padText[i]) {
          padText[i] = t
          pads[i].label.textContent = t
        }
      }
      tempoLed.classList.toggle('on', Math.abs(d.tempo) < 0.002)
    },
  }
}

function channel(n: 1 | 2): { el: HTMLElement; m: ReturnType<typeof meter> } {
  const el = h('div', `chan chan${n}`)
  el.append(
    knob(`d${n}.trim`, 'TRIM', { center: true, size: 36 }),
    knob(`d${n}.hi`, 'HI', { center: true, size: 36 }),
    knob(`d${n}.mid`, 'MID', { center: true, size: 36 }),
    knob(`d${n}.low`, 'LOW', { center: true, size: 36 }),
    knob(`d${n}.cfx`, 'CFX', { center: true, size: 36, cls: 'cfx' }),
    btn(`d${n}.hpcue`, 'CUE', { cls: 'sm hp', shift: 'QUANTIZE' }),
    fader(`d${n}.fader`, String(n), { length: 132, def: 1, ticks: 10, cls: 'chfader' }),
  )
  const m = meter(9)
  return { el, m }
}

export function buildSurface(app: App): Surface {
  const el = h('div', 'surface')

  // Top strip: logo + mic | browse/load | beat FX.
  const top = h('div', 'top-strip')
  const left = h('div', 'ts-left')
  const front = h('div', 'front')
  front.append(
    knob('hpMix', 'PHONES MIX', { size: 32, def: 0.5, center: true }),
    knob('hpLevel', 'PHONES LEVEL', { size: 32, def: 0.6 }),
  )
  left.append(h('div', 'logo', 'DDJ-FLX4'), knob('mic', 'MIC LEVEL', { def: 0, size: 32 }), front)
  const center = h('div', 'ts-center')
  center.append(
    knob('master', 'MASTER', { def: 0.8, size: 36 }),
    btn('d1.load', 'LOAD 1', { cls: 'sm load' }),
    encoder('BROWSE', 46, (n) => app.browse(n), () => {
      button('browse.push').press(true)
      button('browse.push').press(false)
    }),
    btn('d2.load', 'LOAD 2', { cls: 'sm load' }),
    btn('masterCue', 'MASTER', { sub: 'CUE', cls: 'sm hp' }),
  )
  const fx = h('div', 'ts-fx')
  const fxName = h('div', 'fx-name', '')
  const fxScreen = h('div', 'fx-screen')
  fxScreen.append(fxName)
  fx.append(
    fxScreen,
    btn('fx.select', 'FX SELECT', { cls: 'sm' }),
    btn('fx.beatL', '◀', { cls: 'sm sq' }),
    btn('fx.beatR', '▶', { cls: 'sm sq' }),
    lever('fx.ch', ['1', '2', 'M']),
    knob('fx.level', 'LEVEL/DEPTH', { size: 38 }),
    btn('fx.on', 'ON/OFF', { cls: 'sm fxon' }),
  )
  top.append(left, center, fx)

  const d1 = deckBlock(app, app.decks[0])
  const d2 = deckBlock(app, app.decks[1])

  const mixer = h('section', 'mixer')
  const c1 = channel(1)
  const c2 = channel(2)
  const meters = h('div', 'meters')
  const ml = meter(9)
  const mr = meter(9)
  meters.append(c1.m.el, h('span', 'mgap'), ml.el, mr.el, h('span', 'mgap'), c2.m.el)
  const strips = h('div', 'strips')
  strips.append(c1.el, meters, c2.el)
  const smart = h('div', 'smart')
  smart.append(btn('smartCfx', 'SMART CFX', { cls: 'sm' }), btn('smartFader', 'SMART FADER', { cls: 'sm' }))
  const xf = fader('xfader', 'CROSSFADER', { length: 220, horizontal: true, def: 0.5, ticks: 8, detent: true, cls: 'xf' })
  mixer.append(strips, smart, xf)

  el.append(top, d1.el, mixer, d2.el)

  return {
    el,
    frame() {
      el.classList.toggle('shift1', isShift(1))
      el.classList.toggle('shift2', isShift(2))
      d1.frame()
      d2.frame()
      const e = app.engine
      c1.m.set(e.peak(e.ch[0].meter))
      c2.m.set(e.peak(e.ch[1].meter))
      ml.set(e.peak(e.meterL))
      mr.set(e.peak(e.meterR))
      const info = FX_LIST.find((f) => f.type === app.beatFx.type)!
      const txt = `${info.name}  ${app.fxBeatLabel}`
      if (fxName.textContent !== txt) fxName.textContent = txt
    },
  }
}
