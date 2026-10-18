import { test } from 'node:test'
import assert from 'node:assert/strict'

const SR = 44100
const g = globalThis as Record<string, unknown>
g.sampleRate = SR
g.currentTime = 0
g.AudioWorkletProcessor = class { port = { postMessage: (_: unknown) => {}, onmessage: null } }
g.registerProcessor = () => {}
const { DeckProcessor } = await import('../src/audio/deck-worklet.ts')

function sine(f: number, sec: number): Float32Array {
  const a = new Float32Array(Math.round(sec * SR))
  for (let i = 0; i < a.length; i++) a[i] = 0.5 * Math.sin((2 * Math.PI * f * i) / SR)
  return a
}
function run(p: InstanceType<typeof DeckProcessor>, blocks: number): Float32Array {
  const out = new Float32Array(blocks * 128)
  for (let b = 0; b < blocks; b++) {
    const L = new Float32Array(128), R = new Float32Array(128)
    p.process([], [[L, R]])
    out.set(L, b * 128)
  }
  return out
}
// Zero-crossing frequency estimate.
function freq(x: Float32Array): number {
  let z = 0
  for (let i = 1; i < x.length; i++) if (x[i - 1] < 0 && x[i] >= 0) z++
  return (z * SR) / x.length
}
function deck(sig: Float32Array) {
  const p = new DeckProcessor()
  p.cmd({ t: 'load', L: sig, R: sig, pos: 0, seq: 1 })
  return p
}

test('plays at unity and advances position', () => {
  const p = deck(sine(440, 4))
  p.cmd({ t: 'play', on: true, seq: 2 })
  run(p, 50) // settle the start ramp
  const y = run(p, 344)
  assert.ok(Math.abs(freq(y) - 440) < 3, `f ${freq(y)}`)
  assert.ok(Math.abs(p.pos - 394 * 128) < 200)
})

test('tempo change shifts pitch, master tempo holds it', () => {
  const p = deck(sine(440, 6))
  p.cmd({ t: 'rate', v: 1.08 })
  p.cmd({ t: 'play', on: true, seq: 2 })
  run(p, 50)
  assert.ok(Math.abs(freq(run(p, 344)) - 475.2) < 4)
  p.cmd({ t: 'pitch', keylock: true, semis: 0 })
  run(p, 20)
  const y = run(p, 344)
  for (const v of y) assert.ok(Number.isFinite(v))
  assert.ok(Math.abs(freq(y) - 440) < 6, `keylock f ${freq(y)}`)
  const before = p.pos
  run(p, 100)
  assert.ok(Math.abs(p.pos - before - 100 * 128 * 1.08) < 50, 'transport still runs at 1.08x')
})

test('key shift +12 doubles pitch at unity tempo', () => {
  const p = deck(sine(220, 6))
  p.cmd({ t: 'pitch', keylock: false, semis: 12 })
  p.cmd({ t: 'play', on: true, seq: 2 })
  run(p, 60)
  assert.ok(Math.abs(freq(run(p, 344)) - 440) < 8)
})

test('loop wraps sample-accurately and slip returns to the shadow position', () => {
  const p = deck(sine(100, 10))
  p.cmd({ t: 'play', on: true, seq: 2 })
  run(p, 10)
  p.cmd({ t: 'slip', on: true })
  p.cmd({ t: 'loop', on: true, start: 2000, end: 6000 })
  run(p, 400)
  assert.ok(p.pos >= 2000 && p.pos < 6000, `pos ${p.pos}`)
  p.cmd({ t: 'loop', on: false, start: 0, end: 0 })
  p.cmd({ t: 'slip', on: false })
  assert.ok(Math.abs(p.pos - 410 * 128) < 300, `slip pos ${p.pos}`)
})

test('scratch follows jog movement, including backwards', () => {
  const p = deck(sine(100, 10))
  p.cmd({ t: 'seek', pos: SR * 2, seq: 2 })
  p.cmd({ t: 'scratch', on: true })
  p.cmd({ t: 'jog', d: -SR * 0.5 })
  run(p, 600)
  assert.ok(Math.abs(p.pos - SR * 1.5) < 50, `pos ${p.pos}`)
  p.cmd({ t: 'scratch', on: false })
  run(p, 100)
  assert.ok(Math.abs(p.rate) < 1e-3, 'paused deck stops after release')
})

test('stops and reports at track end', () => {
  const p = deck(sine(100, 0.5))
  const msgs: { t: string }[] = []
  ;(p.port as unknown as { postMessage: (m: { t: string }) => void }).postMessage = (m) => msgs.push(m)
  p.cmd({ t: 'play', on: true, seq: 2 })
  run(p, 300)
  assert.equal(p.playing, false)
  assert.ok(msgs.some((m) => m.t === 'ended'))
})

test('quantized seek waits for the playhead to reach the beat', () => {
  const p = deck(sine(100, 10))
  p.cmd({ t: 'play', on: true, seq: 2 })
  run(p, 10)
  p.cmd({ t: 'seek', pos: SR * 5, at: SR * 0.5, seq: 3 })
  run(p, 100) // ~0.29 s in: not there yet
  assert.ok(p.pos < SR * 0.5)
  run(p, 100)
  assert.ok(p.pos > SR * 5 && p.pos < SR * 5.3, `pos ${p.pos}`)
})
