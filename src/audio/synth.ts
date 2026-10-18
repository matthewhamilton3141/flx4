// Small offline synth used for the two built-in demo tracks and the 16
// sampler sounds, so the app is playable before any files are added.

export interface DemoSpec {
  name: string
  bpm: number
  bars: number
  root: number // semitones from A
  seed: number
  prog: [number, 'min' | 'maj'][]
}

export const DEMOS: DemoSpec[] = [
  { name: 'Monochrome', bpm: 124, bars: 64, root: 0, seed: 7, prog: [[0, 'min'], [-4, 'maj'], [3, 'maj'], [-2, 'maj']] },
  { name: 'Grayscale', bpm: 128, bars: 64, root: -4, seed: 19, prog: [[0, 'min'], [-2, 'maj'], [-4, 'maj'], [-5, 'min']] },
]

function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// RBJ biquad, direct form I.
class Biquad {
  b0 = 1
  b1 = 0
  b2 = 0
  a1 = 0
  a2 = 0
  x1 = 0
  x2 = 0
  y1 = 0
  y2 = 0
  constructor(type: 'lp' | 'hp' | 'bp', f: number, q: number, sr: number) {
    const w = (2 * Math.PI * f) / sr
    const c = Math.cos(w)
    const al = Math.sin(w) / (2 * q)
    const a0 = 1 + al
    let b0: number
    let b1: number
    let b2: number
    if (type === 'lp') {
      b0 = (1 - c) / 2
      b1 = 1 - c
      b2 = (1 - c) / 2
    } else if (type === 'hp') {
      b0 = (1 + c) / 2
      b1 = -(1 + c)
      b2 = (1 + c) / 2
    } else {
      b0 = al
      b1 = 0
      b2 = -al
    }
    this.b0 = b0 / a0
    this.b1 = b1 / a0
    this.b2 = b2 / a0
    this.a1 = (-2 * c) / a0
    this.a2 = (1 - al) / a0
  }
  step(x: number): number {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2
    this.x2 = this.x1
    this.x1 = x
    this.y2 = this.y1
    this.y1 = y
    return y
  }
}

const TAU = Math.PI * 2

export function renderDemo(sr: number, spec: DemoSpec): { L: Float32Array; R: Float32Array } {
  const beat = 60 / spec.bpm
  const bar = beat * 4
  const total = Math.ceil((spec.bars * bar + 2) * sr)
  const L = new Float32Array(total)
  const R = new Float32Array(total)
  const rand = rng(spec.seed)
  const noise = (): number => rand() * 2 - 1
  const pump = (t: number): number => 1 - 0.65 * Math.exp(-(t % beat) * 9)

  const put = (t0: number, len: number, fn: (t: number, i: number) => [number, number]): void => {
    const s0 = Math.round(t0 * sr)
    const n = Math.min(Math.round(len * sr), total - s0)
    for (let i = 0; i < n; i++) {
      const [a, b] = fn(i / sr, i)
      L[s0 + i] += a
      R[s0 + i] += b
    }
  }

  const kick = (t0: number): void => {
    let ph = 0
    put(t0, 0.42, (t) => {
      const f = 46 + 115 * Math.exp(-t * 28)
      ph += (TAU * f) / sr
      const v = Math.tanh(1.7 * (Math.sin(ph) * Math.exp(-t * 6.5) + 0.25 * Math.exp(-t * 320) * noise())) * 0.85
      return [v, v]
    })
  }
  const clap = (t0: number): void => {
    const bp = new Biquad('bp', 1400, 1.1, sr)
    put(t0, 0.3, (t) => {
      const e = t < 0.024 ? 0.55 + 0.45 * Math.cos((TAU * t) / 0.008) : Math.exp(-(t - 0.024) * 15)
      const v = bp.step(noise()) * e * 0.9
      return [v * 0.9, v]
    })
  }
  const hat = (t0: number, open: boolean): void => {
    const hp = new Biquad('hp', 7500, 0.7, sr)
    const amp = open ? 0.16 : 0.09
    put(t0, open ? 0.35 : 0.06, (t) => {
      const v = hp.step(noise()) * Math.exp(-t * (open ? 11 : 60)) * amp
      return open ? [v * 0.7, v] : [v, v * 0.8]
    })
  }
  const crash = (t0: number): void => {
    const hp = new Biquad('hp', 4200, 0.6, sr)
    put(t0, 2.6, (t) => {
      const v = hp.step(noise()) * Math.exp(-t * 1.7) * 0.09
      return [v, v * 0.9]
    })
  }
  const bass = (t0: number, dur: number, f: number): void => {
    let ph = 0
    let y1 = 0
    let y2 = 0
    put(t0, dur + 0.05, (t) => {
      ph = (ph + f / sr) % 1
      const fc = 180 + 1000 * Math.exp(-t * 16)
      const a = 1 - Math.exp((-TAU * fc) / sr)
      y1 += a * (2 * ph - 1 - y1)
      y2 += a * (y1 - y2)
      const env = Math.min(1, t / 0.004) * (t < dur ? 1 : Math.exp(-(t - dur) * 80))
      const v = (y2 * 0.34 + Math.sin(TAU * f * t) * 0.24) * env
      return [v, v]
    })
  }
  const chord = (t0: number, dur: number, freqs: number[]): void => {
    const ph = new Float64Array(freqs.length * 2)
    let y1 = 0
    let y2 = 0
    let z1 = 0
    let z2 = 0
    const a = 1 - Math.exp((-TAU * 1300) / sr)
    put(t0, dur + 0.2, (t) => {
      let l = 0
      let r = 0
      for (let k = 0; k < freqs.length; k++) {
        const fa = freqs[k] * 1.004
        const fb = freqs[k] * 0.996
        ph[2 * k] = (ph[2 * k] + fa / sr) % 1
        ph[2 * k + 1] = (ph[2 * k + 1] + fb / sr) % 1
        l += 2 * ph[2 * k] - 1
        r += 2 * ph[2 * k + 1] - 1
      }
      y1 += a * (l - y1)
      y2 += a * (y1 - y2)
      z1 += a * (r - z1)
      z2 += a * (z1 - z2)
      const env = Math.min(1, t / 0.03) * (t < dur ? 1 : Math.exp(-(t - dur) * 25))
      const g = 0.055 * env * pump(t0 + t)
      return [y2 * g, z2 * g]
    })
  }
  const lead = (t0: number, f: number, pan: number, amp: number): void => {
    let y = 0
    const a = 1 - Math.exp((-TAU * 2600) / sr)
    put(t0, 0.3, (t) => {
      y += a * (Math.tanh(4 * Math.sin(TAU * f * t)) - y)
      const v = y * Math.exp(-t * 11) * amp
      return [v * (1 - pan), v * (1 + pan)]
    })
  }
  const riser = (t0: number, dur: number): void => {
    let y = 0
    put(t0, dur, (t) => {
      const x = t / dur
      const fc = 400 * Math.pow(25, x)
      const a = 1 - Math.exp((-TAU * fc) / sr)
      y += a * (noise() - y)
      const v = y * x * x * 0.22
      return [v, v]
    })
  }

  const A = 110 * Math.pow(2, spec.root / 12)
  const midiF = (semi: number, base: number): number => base * Math.pow(2, semi / 12)
  for (let b = 0; b < spec.bars; b++) {
    const sec = Math.floor(b / 8)
    const t = b * bar
    const [deg, qual] = spec.prog[Math.floor(b / 2) % spec.prog.length]
    const third = qual === 'min' ? 3 : 4
    const drums = sec !== 4
    if (b % 8 === 0 && [1, 2, 3, 5, 6].includes(sec)) crash(t)
    for (let q = 0; q < 4; q++) {
      const tb = t + q * beat
      if (drums) kick(tb)
      if (drums && sec >= 1) {
        hat(tb + beat / 2, true)
        if (q === 1 || q === 3) clap(tb)
      }
      if (drums) {
        hat(tb + beat / 4, false)
        hat(tb + (3 * beat) / 4, false)
      }
      if ([2, 3, 5, 6].includes(sec) || (sec === 7 && b < 60)) {
        const oct = b % 4 === 3 && q === 3 ? 12 : 0
        bass(tb + beat / 2, beat * 0.32, midiF(deg + oct, A / 2))
      }
    }
    if (sec >= 3 && sec <= 6 && b % 2 === 0) {
      const base = A * 2
      chord(t, bar * 2 - 0.05, [midiF(deg, base), midiF(deg + third, base), midiF(deg + 7, base)])
    }
    if (sec === 5 || sec === 6) {
      const tones = [0, third, 7, 12]
      for (let s = 0; s < 16; s++) {
        const f = midiF(deg + tones[(s + (b % 2)) % 4] + 12, A * 2)
        const ts = t + (s * beat) / 4
        lead(ts, f, 0, 0.05)
        lead(ts + (3 * beat) / 4, f, s % 2 ? 0.6 : -0.6, 0.018)
      }
    }
    if (b === 38) riser(t, bar * 2)
  }

  let max = 1e-9
  for (let i = 0; i < total; i++) max = Math.max(max, Math.abs(L[i]), Math.abs(R[i]))
  const s = 0.89 / max
  for (let i = 0; i < total; i++) {
    L[i] *= s
    R[i] *= s
  }
  return { L, R }
}

export const SAMPLE_NAMES = [
  'KICK', 'SNARE', 'CLAP', 'HAT', 'OPEN HAT', 'CRASH', 'TOM', 'RIM',
  'HORN', 'SIREN', 'LASER', 'RISER', 'DROP', 'REWIND', 'SCRATCH', 'STAB',
]

export function renderSample(i: number, sr: number): Float32Array<ArrayBuffer> {
  const rand = rng(100 + i)
  const noise = (): number => rand() * 2 - 1
  const make = (dur: number, fn: (t: number) => number): Float32Array<ArrayBuffer> => {
    const n = Math.round(dur * sr)
    const out = new Float32Array(n)
    for (let k = 0; k < n; k++) out[k] = fn(k / sr)
    const fade = Math.min(n, Math.round(0.005 * sr))
    for (let k = 0; k < fade; k++) out[n - 1 - k] *= k / fade
    return out
  }
  let ph = 0
  const osc = (f: number): number => {
    ph += f / sr
    return ph % 1
  }
  switch (i) {
    case 0:
      return make(0.5, (t) => {
        ph += (TAU * (45 + 120 * Math.exp(-t * 26))) / sr
        return Math.tanh(1.8 * Math.sin(ph) * Math.exp(-t * 6)) * 0.9
      })
    case 1: {
      const bp = new Biquad('hp', 1200, 0.7, sr)
      return make(0.3, (t) => (Math.sin(TAU * 190 * t) * 0.5 * Math.exp(-t * 30) + bp.step(noise()) * 0.6) * Math.exp(-t * 14))
    }
    case 2: {
      const bp = new Biquad('bp', 1400, 1.1, sr)
      return make(0.3, (t) => bp.step(noise()) * (t < 0.024 ? 0.6 + 0.4 * Math.cos((TAU * t) / 0.008) : Math.exp(-(t - 0.024) * 14)) * 1.6)
    }
    case 3: {
      const hp = new Biquad('hp', 8000, 0.7, sr)
      return make(0.08, (t) => hp.step(noise()) * Math.exp(-t * 55) * 0.8)
    }
    case 4: {
      const hp = new Biquad('hp', 7000, 0.7, sr)
      return make(0.5, (t) => hp.step(noise()) * Math.exp(-t * 8) * 0.7)
    }
    case 5: {
      const hp = new Biquad('hp', 4000, 0.6, sr)
      return make(2.5, (t) => hp.step(noise()) * Math.exp(-t * 1.6) * 0.6)
    }
    case 6:
      return make(0.5, (t) => {
        ph += (TAU * (90 + 60 * Math.exp(-t * 12))) / sr
        return Math.sin(ph) * Math.exp(-t * 7) * 0.8
      })
    case 7: {
      const bp = new Biquad('bp', 1800, 4, sr)
      return make(0.08, (t) => (bp.step(noise()) * 2 + Math.sin(TAU * 520 * t) * 0.3) * Math.exp(-t * 60))
    }
    case 8: {
      const blast = (t: number): number => {
        const f = 466 * (1 + 0.01 * Math.sin(TAU * 6 * t))
        let v = 0
        for (const m of [1, 1.26, 1.5]) v += 2 * ((f * m * t) % 1) - 1
        return Math.tanh(v * 0.6) * 0.5
      }
      return make(1.4, (t) => {
        const seg = t < 0.18 ? t : t < 0.36 ? t - 0.22 : t - 0.44
        const on = t < 0.18 || (t > 0.22 && t < 0.36) || t > 0.44
        return on ? blast(t) * Math.min(1, seg / 0.01) * (t > 0.44 ? Math.min(1, (1.4 - t) / 0.3) : 1) : 0
      })
    }
    case 9:
      return make(2, (t) => Math.sin((ph += (TAU * (700 + 450 * Math.sin(TAU * 1.5 * t))) / sr)) * 0.45)
    case 10:
      return make(0.35, (t) => (2 * osc(3000 * Math.exp(-t * 14) + 80) - 1) * Math.exp(-t * 6) * 0.45)
    case 11: {
      let y = 0
      return make(2, (t) => {
        const a = 1 - Math.exp((-TAU * 300 * Math.pow(40, t / 2)) / sr)
        y += a * (noise() - y)
        return y * (t / 2) * 0.8
      })
    }
    case 12:
      return make(2, (t) => {
        ph += (TAU * (70 * Math.exp(-t * 1.2) + 28)) / sr
        return Math.tanh(2 * Math.sin(ph)) * Math.exp(-t * 1.4) * 0.8
      })
    case 13:
      return make(1.2, (t) => {
        const f = 600 * (1 - t / 1.3) * (1 + 0.5 * Math.sin(TAU * 9 * t))
        return ((2 * osc(f) - 1) * 0.4 + noise() * 0.1) * Math.min(1, (1.2 - t) * 4)
      })
    case 14: {
      const bp = new Biquad('bp', 1200, 2, sr)
      return make(0.5, (t) => {
        const f = 300 + 900 * Math.abs(Math.sin(TAU * 4 * t))
        return (bp.step(noise()) * 0.8 + (2 * osc(f) - 1) * 0.25) * Math.sin(Math.PI * Math.min(1, t / 0.5))
      })
    }
    default: {
      const fs = [220, 261.6, 329.6, 440]
      let y = 0
      return make(0.6, (t) => {
        let v = 0
        for (const f of fs) v += 2 * ((f * t * 1.003) % 1) - 1 + 2 * ((f * t * 0.997) % 1) - 1
        const a = 1 - Math.exp((-TAU * (500 + 3000 * Math.exp(-t * 12))) / sr)
        y += a * (v - y)
        return y * 0.09 * Math.exp(-t * 5)
      })
    }
  }
}
