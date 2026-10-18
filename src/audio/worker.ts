// Off-main-thread analysis and demo-track rendering.
import { analyze } from './analysis.ts'
import { DEMOS, renderDemo } from './synth.ts'

export type WorkerBody =
  | { t: 'analyze'; L: Float32Array; R: Float32Array; sr: number }
  | { t: 'demo'; index: number; sr: number }
export type WorkerReq = WorkerBody & { id: number }

self.onmessage = (e: MessageEvent<WorkerReq>) => {
  const m = e.data
  if (m.t === 'analyze') {
    const a = analyze(m.L, m.R, m.sr)
    const w = a.wave
    self.postMessage({ id: m.id, result: a }, { transfer: [w.peak.buffer, w.low.buffer, w.mid.buffer, w.high.buffer] })
  } else {
    const { L, R } = renderDemo(m.sr, DEMOS[m.index])
    self.postMessage({ id: m.id, result: { L, R } }, { transfer: [L.buffer, R.buffer] })
  }
}
