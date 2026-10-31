import type { SourceParams } from '../gl/Pipeline'
import type { Instance } from '../effects/types'
import type { InstanceInit } from '../effects'

export interface PresetLayer extends InstanceInit {
  effectId: string
}

export interface Preset {
  name: string
  builtin?: boolean
  output?: string
  /** Timeline length in seconds, relevant when the preset has keyframes. */
  duration?: number
  source?: Partial<SourceParams>
  chain: PresetLayer[]
}

export const DEFAULT_SOURCE: SourceParams = {
  fit: 0,
  zoom: 1,
  panX: 0,
  panY: 0,
  gray: 0,
  contrast: 1,
  brightness: 0
}

export const toPresetLayers = (chain: Instance[]): PresetLayer[] =>
  chain.map(({ effectId, enabled, params, mods, keys, mask }) => structuredClone({ effectId, enabled, params, mods, keys, mask }))

export const BUILTIN_PRESETS: Preset[] = [
  {
    name: 'Violent By Design',
    builtin: true,
    source: { gray: 1, contrast: 1.2 },
    chain: [
      { effectId: 'glitchMachine', params: { amount: 0.95, yMin: 0.2, yMax: 0.6, bands: 30 } },
      { effectId: 'fontLayer' },
      {
        effectId: 'glitchMachine',
        params: { amount: 0.7, yMin: 0.52, yMax: 0.72, density: 0.45, shift: 0.04, stretch: 0.85, rainbow: 0.5, speed: 4 },
        mods: [{ target: 'amount', shape: 'random', rate: 3, depth: 0.25 }]
      },
      { effectId: 'tapeRot' },
      { effectId: 'rgbSplit', params: { amount: 0.004 } },
      { effectId: 'crt' }
    ]
  },
  {
    name: 'Beat Tear (audio)',
    builtin: true,
    source: { gray: 1, contrast: 1.2 },
    chain: [
      {
        effectId: 'glitchMachine',
        params: { amount: 0.15, yMin: 0.05, yMax: 0.95, density: 0.55, speed: 10 },
        mods: [
          { target: 'amount', shape: 'audio-beat', depth: 0.85 },
          { target: 'shift', shape: 'audio-low', depth: 0.25 }
        ]
      },
      { effectId: 'rgbSplit', params: { amount: 0.002 }, mods: [{ target: 'amount', shape: 'audio-beat', depth: 0.35 }] },
      { effectId: 'tapeRot', params: { noise: 0.1 }, mods: [{ target: 'noise', shape: 'audio-high', depth: 0.5 }] },
      { effectId: 'crt', params: { brightness: 1.2 }, mods: [{ target: 'brightness', shape: 'audio-level', depth: 0.2 }] }
    ]
  },
  {
    name: 'Face Tear',
    builtin: true,
    source: { gray: 1, contrast: 1.15 },
    chain: [
      {
        effectId: 'glitchMachine',
        params: { amount: 1, yMin: 0, yMax: 1, density: 0.7, bands: 40 },
        mask: { source: 'face', feather: 0.45, expand: 1.15 }
      },
      { effectId: 'rgbSplit', params: { amount: 0.008 }, mask: { source: 'face', feather: 0.6, expand: 1.3 } },
      { effectId: 'tapeRot', params: { noise: 0.12 } },
      { effectId: 'crt' }
    ]
  },
  {
    name: 'Glitch Fingers',
    builtin: true,
    source: { gray: 1, contrast: 1.15 },
    chain: [
      {
        effectId: 'glitchMachine',
        params: { amount: 1, yMin: 0, yMax: 1, density: 0.75, bands: 60, stretch: 0.9 },
        mask: { source: 'fingers', feather: 0.4, expand: 1.4 }
      },
      { effectId: 'rgbSplit', params: { amount: 0.01 }, mask: { source: 'hands', feather: 0.6, expand: 1.2 } },
      { effectId: 'tapeRot', params: { noise: 0.1 } },
      { effectId: 'crt' }
    ]
  },
  {
    name: 'Clean Tear',
    builtin: true,
    chain: [
      { effectId: 'glitchMachine', params: { rainbow: 0.35, yMin: 0.1, yMax: 0.9, density: 0.5 } },
      { effectId: 'rgbSplit' }
    ]
  },
  {
    name: 'Tape Rot',
    builtin: true,
    chain: [
      { effectId: 'tapeRot', params: { jitter: 0.008, tracking: 0.8, bleed: 0.016, saturation: 2, noise: 0.3, levels: 24 } },
      { effectId: 'grade', params: { contrast: 1.25, saturation: 1.4 } },
      { effectId: 'crt', params: { mask: 0.75, maskSize: 4, lines: 300 } }
    ]
  },
  {
    name: 'Block Crush',
    builtin: true,
    chain: [
      { effectId: 'blockGlitch', params: { amount: 0.3 }, mods: [{ target: 'amount', shape: 'random', rate: 2, depth: 0.2 }] },
      { effectId: 'echo', params: { feedback: 0.8 } },
      { effectId: 'rgbSplit', params: { amount: 0.01 } },
      { effectId: 'pixelate', params: { size: 3 } }
    ]
  },
  {
    name: 'Datamosh Melt',
    builtin: true,
    chain: [
      {
        effectId: 'datamosh',
        params: { strength: 1.8, block: 16, drift: 0.002 },
        // Beats act like I-frames: the image snaps clean on the hit, then melts again.
        mods: [{ target: 'refresh', shape: 'audio-beat', depth: 0.9 }]
      },
      { effectId: 'rgbSplit', params: { amount: 0.004 } },
      { effectId: 'tapeRot', params: { noise: 0.08, tracking: 0.2 } }
    ]
  },
  {
    name: 'Pixel Sort Drip',
    builtin: true,
    chain: [
      { effectId: 'pixelSort', params: { axis: 1, lo: 0.3, hi: 1, chunk: 512 }, mods: [{ target: 'lo', shape: 'sine', rate: 0.15, depth: 0.1 }] },
      { effectId: 'grade', params: { contrast: 1.2, saturation: 1.3 } },
      { effectId: 'glow', params: { threshold: 0.7, intensity: 0.8 } }
    ]
  },
  {
    name: 'Face Sort',
    builtin: true,
    source: { contrast: 1.1 },
    chain: [
      { effectId: 'pixelSort', params: { axis: 1, lo: 0.25, hi: 1, chunk: 256, reverse: true }, mask: { source: 'face', feather: 0.3, expand: 1.25 } },
      { effectId: 'rgbSplit', params: { amount: 0.003 } },
      { effectId: 'crt', params: { mask: 0.4 } }
    ]
  },
  {
    name: 'Neon Glow Tape',
    builtin: true,
    chain: [
      { effectId: 'tapeRot', params: { saturation: 2.2, bleed: 0.012 } },
      { effectId: 'glow', params: { threshold: 0.45, intensity: 1.6, streak: 0.5, tint: '#ff6ad5' } },
      { effectId: 'crt', params: { bloom: 0.1 } }
    ]
  },
  {
    name: 'Liquid Displace',
    builtin: true,
    chain: [
      { effectId: 'displace', params: { amount: 0.05, scale: 3, speed: 0.5, rgb: 0.5 } },
      { effectId: 'feedbackWarp', params: { feedback: 0.6, zoom: 1.0, rotate: 0, warp: 0.006, hue: 0.03 } },
      { effectId: 'glow', params: { threshold: 0.6, intensity: 0.7 } }
    ]
  },
  {
    name: 'Feedback Tunnel',
    builtin: true,
    chain: [
      { effectId: 'kaleido', params: { mode: 3, segments: 6, spin: 0.08 } },
      { effectId: 'feedbackWarp', params: { feedback: 0.82, mode: 2, zoom: 1.035, rotate: 0.02, hue: 0.12, saturate: 1.05 } },
      { effectId: 'grade', params: { contrast: 1.25, gamma: 0.9 } },
      { effectId: 'glow', params: { threshold: 0.85, intensity: 0.6 } },
      { effectId: 'rgbSplit', params: { amount: 0.003 } }
    ]
  },
  {
    name: 'Hair Sort',
    builtin: true,
    chain: [
      { effectId: 'pixelSort', params: { axis: 1, lo: 0, hi: 0.8, chunk: 512, reverse: true }, mask: { source: 'hair', feather: 0.3 } },
      { effectId: 'glow', params: { threshold: 0.7, intensity: 0.6 } }
    ]
  },
  {
    name: 'Clothes Mosh',
    builtin: true,
    chain: [
      { effectId: 'datamosh', params: { strength: 2.2, block: 24, drift: 0.004 }, mask: { source: 'clothes', feather: 0.25 } },
      { effectId: 'rgbSplit', params: { amount: 0.004 }, mask: { source: 'clothes', feather: 0.4 } },
      { effectId: 'crt', params: { mask: 0.35 } }
    ]
  },
  {
    name: 'Glitch Arms',
    builtin: true,
    source: { gray: 1, contrast: 1.1 },
    chain: [
      { effectId: 'glitchMachine', params: { amount: 1, yMin: 0, yMax: 1, density: 0.7, bands: 50 }, mask: { source: 'arms', feather: 0.35, expand: 1.3 } },
      { effectId: 'displace', params: { amount: 0.03, rgb: 0.6 }, mask: { source: 'arms', feather: 0.5, expand: 1.5 } },
      { effectId: 'tapeRot', params: { noise: 0.1 } }
    ]
  },
  {
    name: 'Skin Glow',
    builtin: true,
    chain: [
      { effectId: 'glow', params: { threshold: 0.55, intensity: 0.7, radius: 1.2, tint: '#ffb0c8' }, mask: { source: 'skin', feather: 0.4 } },
      { effectId: 'grade', params: { saturation: 0.6, contrast: 1.2 }, mask: { source: 'skin', invert: true, feather: 0.4 } }
    ]
  },
  {
    name: 'VHS Pixel Sort',
    builtin: true,
    chain: [
      { effectId: 'tapeRot', params: { saturation: 1.8, tracking: 0.3 } },
      { effectId: 'pixelSort', params: { axis: 0, lo: 0.5, hi: 1, chunk: 256, res: 0.5 }, mods: [{ target: 'lo', shape: 'audio-level', depth: -0.25 }] },
      { effectId: 'crt', params: { mask: 0.6, lines: 360 } }
    ]
  },
  {
    name: 'Beat Kaleido',
    builtin: true,
    chain: [
      {
        effectId: 'kaleido',
        params: { mode: 3, segments: 6, spin: 0.05, zoom: 1 },
        mods: [
          { target: 'segments', shape: 'audio-beat', depth: 0.3 },
          { target: 'zoom', shape: 'audio-low', depth: 0.1 }
        ]
      },
      { effectId: 'feedbackWarp', params: { feedback: 0.7, mode: 0, zoom: 1.015, rotate: -0.01, hue: 0.06 } },
      { effectId: 'glow', params: { threshold: 0.7, intensity: 0.8 }, mods: [{ target: 'intensity', shape: 'audio-beat', depth: 0.3 }] }
    ]
  },
  {
    name: 'Melt Face',
    builtin: true,
    chain: [
      {
        effectId: 'datamosh',
        params: { strength: 2.5, block: 12, drift: 0.006, bleed: 0.02 },
        mask: { source: 'face', feather: 0.5, expand: 1.3 },
        mods: [{ target: 'refresh', shape: 'audio-beat', depth: 0.8 }]
      },
      { effectId: 'glitchMachine', params: { amount: 0.5, density: 0.3, rainbow: 0.4 }, mask: { source: 'face', feather: 0.5, expand: 1.2 } },
      { effectId: 'tapeRot', params: { noise: 0.1 } }
    ]
  },
  {
    name: 'Print Error',
    builtin: true,
    chain: [
      { effectId: 'displace', params: { map: 3, amount: 0.03, scale: 8, speed: 1.5, rgb: 0.8 } },
      { effectId: 'pixelSort', params: { axis: 0, by: 1, lo: 0.1, hi: 0.9, chunk: 128 } },
      { effectId: 'grade', params: { posterize: 6, saturation: 1.6, contrast: 1.3 } },
      { effectId: 'rgbSplit', params: { amount: 0.006, angle: 90 } }
    ]
  },
  {
    name: '2.5D Parallax',
    builtin: true,
    chain: [
      { effectId: 'depthParallax', params: { amount: 0.025, speed: 0.25, orbit: 0.6, zoom: 0.03 } },
      { effectId: 'glow', params: { threshold: 0.75, intensity: 0.5 } }
    ]
  },
  {
    name: 'Portrait Focus',
    builtin: true,
    chain: [
      { effectId: 'depthBlur', params: { focus: 0.85, range: 0.15, blur: 18, bokeh: 0.5 } },
      { effectId: 'grade', params: { saturation: 0.5, contrast: 1.1 }, mask: { source: 'depth', depthLo: 0, depthHi: 0.55, feather: 0.6 } }
    ]
  },
  {
    name: 'Foggy Background Tear',
    builtin: true,
    chain: [
      { effectId: 'glitchMachine', params: { amount: 1, yMin: 0, yMax: 1, density: 0.6 }, mask: { source: 'depth', depthLo: 0, depthHi: 0.45, feather: 0.5 } },
      { effectId: 'depthFog', params: { density: 0.6, color: '#b8c4d6' } },
      { effectId: 'crt', params: { mask: 0.35 } }
    ]
  },
  {
    name: 'Foreground Tear',
    builtin: true,
    source: { gray: 1, contrast: 1.15 },
    chain: [
      { effectId: 'glitchMachine', params: { amount: 1, yMin: 0, yMax: 1, density: 0.7, bands: 40 }, mask: { source: 'depth', depthLo: 0.6, depthHi: 1, feather: 0.4 } },
      { effectId: 'rgbSplit', params: { amount: 0.006 }, mask: { source: 'depth', depthLo: 0.55, depthHi: 1, feather: 0.6 } },
      { effectId: 'tapeRot', params: { noise: 0.1 } }
    ]
  },
  {
    name: 'Film Stock',
    builtin: true,
    chain: [
      { effectId: 'lut', params: { look: 'Faded Film', intensity: 0.9 } },
      { effectId: 'glow', params: { threshold: 0.8, intensity: 0.35, tint: '#ffd9b0' } },
      { effectId: 'filmGrain', params: { amount: 0.4, size: 1.4, vignette: 0.35 } }
    ]
  },
  {
    name: 'Neon Noir',
    builtin: true,
    chain: [
      { effectId: 'lut', params: { look: 'Cyberpunk' } },
      { effectId: 'glitchMachine', params: { amount: 0.6, density: 0.35, rainbow: 0.4 } },
      { effectId: 'glow', params: { threshold: 0.55, intensity: 1.2, streak: 0.4 } },
      { effectId: 'filmGrain', params: { amount: 0.25, color: 0.4 } }
    ]
  },
  {
    name: 'Beat Hits',
    builtin: true,
    chain: [
      {
        effectId: 'glitchMachine',
        params: { amount: 0, density: 0.45 },
        mods: [{ target: 'amount', shape: 'hit', trigger: 'kick', every: 1, attack: 0, decay: 0.3, depth: 0.9 }]
      },
      {
        effectId: 'rgbSplit',
        params: { amount: 0.002 },
        mods: [{ target: 'amount', shape: 'hit', trigger: 'snare', every: 1, attack: 0, decay: 0.25, depth: 0.5 }]
      },
      {
        effectId: 'punch',
        params: {},
        mods: [
          { target: 'zoom', shape: 'hit', trigger: 'bar', every: 1, attack: 0, decay: 0.45, depth: 0.35 },
          { target: 'flash', shape: 'hit', trigger: 'bar', every: 1, attack: 0, decay: 0.15, depth: 0.35 },
          { target: 'shake', shape: 'hit', trigger: 'snare', every: 1, attack: 0, decay: 0.2, depth: 0.4 }
        ]
      },
      { effectId: 'tapeRot', params: { noise: 0.08 } }
    ]
  }
]
