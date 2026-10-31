import type { Gpu } from '../gl/Gpu'

export type ParamValue = number | string | boolean
export type Params = Record<string, ParamValue>

interface Base {
  key: string
  label?: string
}
export type ParamDef =
  | (Base & { type?: 'number'; min: number; max: number; step?: number; default: number })
  | (Base & { type: 'bool'; default: boolean })
  | (Base & { type: 'color'; default: string })
  | (Base & { type: 'select'; options: Record<string, number | string>; default: number | string })
  | (Base & { type: 'text'; default: string })
  /** A file path chosen with a button (e.g. a .cube LUT). */
  | (Base & { type: 'file'; default: string; filters: { name: string; extensions: string[] }[]; /** Other params to set when a file is chosen. */ sets?: Record<string, string | number | boolean> })

export interface PrepareContext {
  /** This effect's input image. */
  input: WebGLTexture
  width: number
  height: number
  time: number
  /** Param values for this frame (modulators applied). */
  params: Params
  frame: number
}

export interface EffectRuntime {
  /** Extra textures bound as sampler uniforms (name -> texture). */
  textures?(params: Params, w: number, h: number): Record<string, WebGLTexture>
  /** Run extra GPU passes before the main shader; returned textures are bound as samplers. */
  prepare?(ctx: PrepareContext): Record<string, WebGLTexture>
  /** Drop temporal state (called on resize and at the start of renders). */
  reset?(): void
  dispose(): void
}

export interface EffectDef {
  id: string
  name: string
  params: ParamDef[]
  /** GLSL body (after the shared header): must write `outColor`. */
  frag: string
  runtime?: (gl: WebGL2RenderingContext, gpu: Gpu) => EffectRuntime
  /** Reads the layer's depth (`uniform sampler2D uDepth`, 1 = near): depth is estimated when this is used. */
  needsDepth?: boolean
  /** Params that can be set by clicking the preview (e.g. focus distance from the depth under the cursor). */
  pickers?: { param: string; label: string; from: 'depth' }[]
}

export type AudioBand = 'level' | 'low' | 'mid' | 'high' | 'beat' | 'kick' | 'snare' | 'hat'
export type ModShape = 'off' | 'sine' | 'saw' | 'square' | 'random' | `audio-${AudioBand}` | 'hit'
/** What fires a beat hit. */
export type HitTrigger = 'beat' | 'offbeat' | 'bar' | 'kick' | 'snare' | 'hat'
export interface Modulator {
  target: string
  shape: ModShape
  /** Hz for LFO shapes; ignored by audio shapes. */
  rate: number
  /** Fraction of the param range. LFOs swing ±depth, audio adds depth × envelope (negative ducks). */
  depth: number
  /** Beat hits: what fires them, every how many, and the envelope (seconds). */
  trigger?: HitTrigger
  every?: number
  attack?: number
  decay?: number
}

export type Ease = 'linear' | 'ease' | 'hold'
export interface Keyframe {
  t: number
  v: number
  ease: Ease
}

export type MaskSource =
  | 'none'
  | 'face'
  | 'person'
  | 'hair'
  | 'skin'
  | 'clothes'
  | 'hands'
  | 'fingers'
  | 'arms'
  | 'legs'
  | 'color'
  | 'shape'
  | 'draw'
  | 'object'
  | 'track'
  | 'depth'

/** Limits where an effect applies: the effect is blended over its input through this mask. */
export interface Mask {
  source: MaskSource
  invert: boolean
  /** Edge softness 0..1. */
  feather: number
  /** Grows (>1) or shrinks (<1) the masked area. */
  expand: number
  /** Tint the masked area so it's visible while tuning. */
  show: boolean
  /** color key: the key color and how far from it still counts. */
  color: string
  tolerance: number
  /** object: detector class name (e.g. "cup"). */
  label: string
  /** track: id of a precomputed mask track (AI object selection, see vision/Segmenter). */
  track: string
  /** draw: freehand polygons in output uv (x right, y down, 0..1), each a flat [x0, y0, x1, y1, ...] list. */
  polys: number[][]
  /** depth: keep the band between these depths (0 = farthest, 1 = nearest). */
  depthLo: number
  depthHi: number
}

/**
 * Shape masks keep their geometry in the instance params under these keys, so the existing keyframe,
 * auto-key and modulator machinery animates them like any slider. Units: output uv (y down), angle in radians.
 */
export const SHAPE_PARAMS = {
  'mask.cx': { label: 'shape x', min: -0.5, max: 1.5, default: 0.5 },
  'mask.cy': { label: 'shape y', min: -0.5, max: 1.5, default: 0.45 },
  'mask.w': { label: 'shape width', min: 0.01, max: 2, default: 0.5 },
  'mask.h': { label: 'shape height', min: 0.01, max: 2, default: 0.3 },
  'mask.angle': { label: 'shape angle', min: -3.1416, max: 3.1416, default: 0 },
  'mask.round': { label: 'shape roundness', min: 0, max: 1, default: 1 }
} as const
export type ShapeKey = keyof typeof SHAPE_PARAMS

export interface Instance {
  uid: string
  effectId: string
  enabled: boolean
  params: Params
  mods: Modulator[]
  /** Keyframed number params: key -> keys sorted by time. */
  keys: Record<string, Keyframe[]>
  mask: Mask
}

export const isNumberParam = (p: ParamDef): p is Extract<ParamDef, { min: number }> =>
  p.type === undefined || p.type === 'number'
