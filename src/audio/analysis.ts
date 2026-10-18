// Track analysis: 3-band waveform, tempo, beat grid and loudness. Pure
// functions so the worker and the tests share them.

export const WAVE_RATE = 150 // waveform points per second

export interface WaveData {
  rate: number
  peak: Uint8Array
  low: Uint8Array
  mid: Uint8Array
  high: Uint8Array
}

export interface Analysis {
  bpm: number // 0 when no tempo could be found
  firstBeat: number // seconds; the grid is firstBeat + k * 60 / bpm
  gain: number // auto-gain multiplier toward a common loudness
  wave: WaveData
}

const FPS = 100 // onset frames per second
const ENV_HOP = 64

export function analyze(L: Float32Array, R: Float32Array, sr: number): Analysis {
  const n = L.length
  const hop = sr / WAVE_RATE
  const nw = Math.max(1, Math.ceil(n / hop))
  const peak = new Float32Array(nw)
  const lo = new Float32Array(nw)
  const mi = new Float32Array(nw)
  const hi = new Float32Array(nw)

  const fhop = Math.round(sr / FPS)
  const nf = Math.max(1, Math.ceil(n / fhop))
  const eLow = new Float32Array(nf)
  const eMid = new Float32Array(nf)
  const eHigh = new Float32Array(nf)
  const env = new Float32Array(Math.ceil(n / ENV_HOP) + 1)

  const aLo = 1 - Math.exp((-2 * Math.PI * 160) / sr)
  const aHi = 1 - Math.exp((-2 * Math.PI * 2500) / sr)
  let l1 = 0
  let l2 = 0
  let h1 = 0
  let h2 = 0
  let sumSq = 0
  const invHop = 1 / hop
  for (let i = 0; i < n; i++) {
    const m = (L[i] + R[i]) * 0.5
    sumSq += m * m
    l1 += aLo * (m - l1)
    l2 += aLo * (l1 - l2)
    h1 += aHi * (m - h1)
    h2 += aHi * (h1 - h2)
    const low = l2
    const high = m - h2
    const mid = h2 - l2
    const w = (i * invHop) | 0
    const am = m < 0 ? -m : m
    const al = low < 0 ? -low : low
    const amid = mid < 0 ? -mid : mid
    const ah = high < 0 ? -high : high
    if (am > peak[w]) peak[w] = am
    if (al > lo[w]) lo[w] = al
    if (amid > mi[w]) mi[w] = amid
    if (ah > hi[w]) hi[w] = ah
    const f = (i / fhop) | 0
    eLow[f] += low * low
    eMid[f] += mid * mid
    eHigh[f] += high * high
    const e = i >> 6
    if (al > env[e]) env[e] = al
  }

  let maxPeak = 1e-9
  for (let i = 0; i < nw; i++) if (peak[i] > maxPeak) maxPeak = peak[i]
  const q = (src: Float32Array): Uint8Array => {
    const out = new Uint8Array(src.length)
    const s = 255 / maxPeak
    for (let i = 0; i < src.length; i++) out[i] = Math.min(255, src[i] * s)
    return out
  }
  const wave: WaveData = { rate: WAVE_RATE, peak: q(peak), low: q(lo), mid: q(mi), high: q(hi) }

  const rms = Math.sqrt(sumSq / Math.max(1, n))
  const db = 20 * Math.log10(rms + 1e-9)
  const gain = Math.min(3, Math.max(0.3, Math.pow(10, (-13 - db) / 20)))

  const onset = onsetCurve([eLow, eMid, eHigh], [1, 0.6, 0.8], fhop)
  const tempo = n / sr >= 8 ? findTempo(onset) : null
  if (!tempo) return { bpm: 0, firstBeat: 0, gain, wave }

  const beatSec = 60 / tempo.bpm
  const t0 = refinePhase((tempo.phase + 0.5) / FPS, beatSec, env, sr, n / sr)
  const firstBeat = firstLoudBeat(t0, beatSec, env, sr, n / sr)
  return { bpm: tempo.bpm, firstBeat, gain, wave }
}

function onsetCurve(bands: Float32Array[], weights: number[], fhop: number): Float32Array {
  const nf = bands[0].length
  const out = new Float32Array(nf)
  for (let b = 0; b < bands.length; b++) {
    const e = bands[b]
    let prev = Math.log1p((1000 * e[0]) / fhop)
    for (let f = 1; f < nf; f++) {
      const cur = Math.log1p((1000 * e[f]) / fhop)
      const d = cur - prev
      if (d > 0) out[f] += weights[b] * d
      prev = cur
    }
  }
  // Remove the slow-moving baseline so only attacks remain.
  const W = 16
  const res = new Float32Array(nf)
  let acc = 0
  for (let f = 0; f < nf; f++) {
    acc += out[f]
    if (f >= W) acc -= out[f - W]
    const mean = acc / Math.min(f + 1, W)
    res[f] = Math.max(0, out[f] - mean)
  }
  return res
}

function interp(o: Float32Array, x: number): number {
  const i = Math.floor(x)
  if (i < 0 || i + 1 >= o.length) return 0
  const f = x - i
  return o[i] * (1 - f) + o[i + 1] * f
}

// Best phase and comb energy for a beat period given in onset frames.
function comb(o: Float32Array, period: number): { score: number; phase: number } {
  let best = -1
  let bestPh = 0
  const nf = o.length
  for (let ph = 0; ph < period; ph += 0.5) {
    let s = 0
    for (let x = ph; x < nf - 1; x += period) s += interp(o, x)
    if (s > best) {
      best = s
      bestPh = ph
    }
  }
  const beats = Math.max(1, (nf - 1) / period)
  return { score: best / beats, phase: bestPh }
}

export function findTempo(o: Float32Array): { bpm: number; phase: number } | null {
  const nf = o.length
  const minLag = Math.floor((FPS * 60) / 200)
  const maxLag = Math.ceil((FPS * 60) / 60)
  if (nf < maxLag * 4) return null
  const ac = new Float32Array(maxLag * 2 + 2)
  for (let lag = minLag; lag < ac.length; lag++) {
    let s = 0
    for (let t = 0; t + lag < nf; t++) s += o[t] * o[t + lag]
    ac[lag] = s / (nf - lag)
  }
  let bestLag = 0
  let bestScore = 0
  for (let lag = minLag; lag <= maxLag; lag++) {
    const bpm = (60 * FPS) / lag
    const prior = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 120) / 0.9, 2))
    const s = (ac[lag] + 0.5 * ac[Math.min(ac.length - 1, lag * 2)]) * prior
    if (s > bestScore) {
      bestScore = s
      bestLag = lag
    }
  }
  if (!bestLag || bestScore <= 0) return null
  let bpm = (60 * FPS) / bestLag
  while (bpm < 78) bpm *= 2
  while (bpm >= 180) bpm /= 2

  // Refine on a continuous grid with the comb: coarse, then fine.
  let best = { bpm, score: -1, phase: 0 }
  const scan = (from: number, to: number, step: number): void => {
    for (let b = from; b <= to; b += step) {
      const c = comb(o, (60 * FPS) / b)
      if (c.score > best.score) best = { bpm: b, score: c.score, phase: c.phase }
    }
  }
  scan(bpm * 0.96, bpm * 1.04, 0.1)
  const coarse = best.bpm
  scan(coarse - 0.15, coarse + 0.15, 0.005)

  let out = best.bpm
  if (Math.abs(out - Math.round(out)) < 0.06) out = Math.round(out)
  else out = Math.round(out * 100) / 100
  const ph = comb(o, (60 * FPS) / out).phase
  return { bpm: out, phase: ph }
}

// Snap the grid to actual kick attacks using a ~1.5 ms low-band envelope.
function refinePhase(t0: number, beatSec: number, env: Float32Array, sr: number, dur: number): number {
  const dt = ENV_HOP / sr
  let maxEnv = 0
  for (let i = 0; i < env.length; i++) if (env[i] > maxEnv) maxEnv = env[i]
  const devs: number[] = []
  const k0 = Math.ceil(-t0 / beatSec)
  for (let k = k0; t0 + k * beatSec < dur; k++) {
    const tk = t0 + k * beatSec
    const a = Math.max(2, Math.floor((tk - 0.03) / dt))
    const b = Math.min(env.length - 1, Math.ceil((tk + 0.03) / dt))
    let bestJ = -1
    let bestRise = 0.1 * maxEnv
    for (let j = a; j <= b; j++) {
      const rise = env[j] - env[j - 2]
      if (rise > bestRise) {
        bestRise = rise
        bestJ = j
      }
    }
    if (bestJ >= 0) devs.push((bestJ - 1) * dt - tk)
  }
  if (devs.length < 4) return t0
  devs.sort((x, y) => x - y)
  return t0 + devs[devs.length >> 1]
}

function firstLoudBeat(t0: number, beatSec: number, env: Float32Array, sr: number, dur: number): number {
  const dt = ENV_HOP / sr
  let maxEnv = 0
  for (let i = 0; i < env.length; i++) if (env[i] > maxEnv) maxEnv = env[i]
  const k0 = Math.ceil((-t0 - 0.005) / beatSec)
  for (let k = k0; t0 + k * beatSec < dur; k++) {
    const tk = t0 + k * beatSec
    const a = Math.max(0, Math.floor((tk - 0.01) / dt))
    const b = Math.min(env.length - 1, Math.ceil((tk + 0.03) / dt))
    for (let j = a; j <= b; j++) if (env[j] > 0.2 * maxEnv) return tk
  }
  const m = t0 % beatSec
  return m < 0 ? m + beatSec : m
}
