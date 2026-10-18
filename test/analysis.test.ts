import { test } from 'node:test'
import assert from 'node:assert/strict'
import { analyze } from '../src/audio/analysis.ts'
import { DEMOS, renderDemo, renderSample, SAMPLE_NAMES } from '../src/audio/synth.ts'

const SR = 44100

for (const spec of DEMOS) {
  test(`demo "${spec.name}" analyzes to ${spec.bpm} BPM with grid on the first kick`, () => {
    const { L, R } = renderDemo(SR, spec)
    const a = analyze(L, R, SR)
    assert.equal(a.bpm, spec.bpm)
    assert.ok(Math.abs(a.firstBeat) < 0.008, `firstBeat ${a.firstBeat}`)
    assert.ok(a.gain > 0.3 && a.gain < 3)
    assert.equal(a.wave.peak.length, Math.ceil(L.length / (SR / 150)))
  })
}

test('non-integer tempo and an offset start are recovered', () => {
  const { L, R } = renderDemo(SR, DEMOS[0])
  // Resample to 1.03x speed and prepend 0.25 s of silence.
  const speed = 1.03
  const pad = Math.round(0.25 * SR)
  const n = Math.floor(L.length / speed)
  const L2 = new Float32Array(n + pad)
  const R2 = new Float32Array(n + pad)
  for (let i = 0; i < n; i++) {
    const x = i * speed
    const k = Math.floor(x)
    const f = x - k
    L2[pad + i] = L[k] * (1 - f) + (L[k + 1] ?? 0) * f
    R2[pad + i] = R[k] * (1 - f) + (R[k + 1] ?? 0) * f
  }
  const a = analyze(L2, R2, SR)
  assert.ok(Math.abs(a.bpm - 124 * speed) < 0.05, `bpm ${a.bpm}`)
  assert.ok(Math.abs(a.firstBeat - 0.25) < 0.008, `firstBeat ${a.firstBeat}`)
})

test('silence yields no tempo', () => {
  const z = new Float32Array(SR * 10)
  assert.equal(analyze(z, z, SR).bpm, 0)
})

test('all sampler sounds render finite audio', () => {
  for (let i = 0; i < SAMPLE_NAMES.length; i++) {
    const s = renderSample(i, SR)
    assert.ok(s.length > 1000)
    let peak = 0
    for (const v of s) { assert.ok(Number.isFinite(v)); peak = Math.max(peak, Math.abs(v)) }
    assert.ok(peak > 0.05 && peak <= 1.5, `${SAMPLE_NAMES[i]} peak ${peak}`)
  }
})
