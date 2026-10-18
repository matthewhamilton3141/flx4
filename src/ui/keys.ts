// Computer-keyboard control. Shift on the keyboard is SHIFT on both decks.

import type { App } from '../app.ts'
import { MODE_BUTTONS } from '../app.ts'
import { button, param, setShift } from '../bus.ts'

export const KEYS: [string, string, string][] = [
  // [code, control, label for the help sheet]
  ['KeyX', 'd1.play', 'X'], ['KeyZ', 'd1.cue', 'Z'], ['KeyC', 'd1.sync', 'C'],
  ['KeyA', 'd1.loopIn', 'A'], ['KeyS', 'd1.loopOut', 'S'], ['KeyD', 'd1.reloop', 'D'],
  ['KeyG', 'd1.hpcue', 'G'], ['BracketLeft', 'd1.load', '['],
  ['Digit1', 'd1.pad0', '1'], ['Digit2', 'd1.pad1', '2'], ['Digit3', 'd1.pad2', '3'], ['Digit4', 'd1.pad3', '4'],
  ['KeyQ', 'd1.pad4', 'Q'], ['KeyW', 'd1.pad5', 'W'], ['KeyE', 'd1.pad6', 'E'], ['KeyR', 'd1.pad7', 'R'],
  ['Period', 'd2.play', '.'], ['Comma', 'd2.cue', ','], ['Slash', 'd2.sync', '/'],
  ['KeyJ', 'd2.loopIn', 'J'], ['KeyK', 'd2.loopOut', 'K'], ['KeyL', 'd2.reloop', 'L'],
  ['KeyH', 'd2.hpcue', 'H'], ['BracketRight', 'd2.load', ']'],
  ['Digit7', 'd2.pad0', '7'], ['Digit8', 'd2.pad1', '8'], ['Digit9', 'd2.pad2', '9'], ['Digit0', 'd2.pad3', '0'],
  ['KeyU', 'd2.pad4', 'U'], ['KeyI', 'd2.pad5', 'I'], ['KeyO', 'd2.pad6', 'O'], ['KeyP', 'd2.pad7', 'P'],
  ['Enter', 'browse.push', 'Enter'], ['Backslash', 'fx.on', '\\'],
]

const BEND: Record<string, [1 | 2, number]> = { KeyV: [1, -1], KeyB: [1, 1], KeyN: [2, -1], KeyM: [2, 1] }
const MODE_CYCLE: Record<string, 1 | 2> = { KeyT: 1, KeyY: 2 }

export function bindKeys(app: App, toggleHelp: () => void): void {
  const map = new Map(KEYS.map(([code, id]) => [code, id]))
  const bending = new Map<string, number>()
  const typing = (e: KeyboardEvent): boolean => {
    const t = e.target as HTMLElement | null
    return !!t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')
  }

  window.addEventListener('keydown', (e) => {
    if (typing(e) || e.metaKey || e.ctrlKey) return
    if (e.key === 'Shift') {
      setShift(1, true)
      setShift(2, true)
      return
    }
    const id = map.get(e.code)
    if (id) {
      e.preventDefault()
      button(id).press(true)
      return
    }
    if (e.code in BEND) {
      e.preventDefault()
      if (!bending.has(e.code)) {
        const [n, dir] = BEND[e.code]
        bending.set(e.code, window.setInterval(() => app.decks[n - 1].jogTurn(dir * 0.012, false, false), 16))
      }
      return
    }
    if (e.code in MODE_CYCLE && !e.repeat) {
      const d = app.decks[MODE_CYCLE[e.code] - 1]
      const base = MODE_BUTTONS.findIndex((m) => d.padMode === m || { hotcue: 'keyboard', padfx1: 'padfx2', beatjump: 'beatloop', sampler: 'keyshift' }[m] === d.padMode)
      d.modeBtn(MODE_BUTTONS[(base + 1) % 4], true, e.shiftKey)
      return
    }
    const xf = param('xfader')
    switch (e.code) {
      case 'ArrowLeft':
      case 'ArrowRight': {
        e.preventDefault()
        const dir = e.code === 'ArrowLeft' ? -1 : 1
        xf.set(e.shiftKey ? (dir < 0 ? 0 : 1) : xf.value + dir * 0.05, 'key')
        return
      }
      case 'ArrowUp':
      case 'ArrowDown':
        e.preventDefault()
        app.browse(e.code === 'ArrowUp' ? -1 : 1)
        return
      case 'Backquote':
        toggleHelp()
        return
    }
  })

  window.addEventListener('keyup', (e) => {
    if (e.key === 'Shift') {
      setShift(1, false)
      setShift(2, false)
      return
    }
    const id = map.get(e.code)
    if (id) button(id).press(false)
    const t = bending.get(e.code)
    if (t !== undefined) {
      clearInterval(t)
      bending.delete(e.code)
    }
  })

  window.addEventListener('blur', () => {
    for (const [, id] of KEYS) button(id).press(false)
    for (const t of bending.values()) clearInterval(t)
    bending.clear()
    setShift(1, false)
    setShift(2, false)
  })
}
