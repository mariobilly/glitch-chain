import type { EffectDef, Instance, Keyframe, Mask, Modulator, Params } from './types'
import { isNumberParam } from './types'
import { glitchMachine } from './glitchMachine'
import { rgbSplit } from './rgbSplit'
import { blockGlitch } from './blockGlitch'
import { fontLayer } from './fontLayer'
import { tapeRot } from './tapeRot'
import { crt } from './crt'
import { pixelate, echo, grade } from './misc'
import { datamosh } from './datamosh'
import { pixelSort } from './pixelSort'
import { glow } from './glow'
import { displace, feedbackWarp, kaleido } from './warp'
import { layerSettings } from './layer'
import { depthBlur, depthFog, depthParallax } from './depth'
import { filmGrain, lut } from './finish'
import { punch } from './punch'

const LIST: EffectDef[] = [
  glitchMachine,
  datamosh,
  pixelSort,
  fontLayer,
  tapeRot,
  crt,
  glow,
  depthFog,
  depthBlur,
  depthParallax,
  displace,
  feedbackWarp,
  kaleido,
  rgbSplit,
  blockGlitch,
  pixelate,
  echo,
  grade,
  lut,
  filmGrain,
  punch
]

export const EFFECTS: Record<string, EffectDef> = Object.fromEntries([...LIST, layerSettings].map((e) => [e.id, e]))
/** Effects the user can add (the per-layer settings card is not one of them). */
export const EFFECT_LIST = LIST

let counter = 0
export const newUid = (): string => `fx${Date.now().toString(36)}${(counter++).toString(36)}`

export function defaultParams(def: EffectDef): Params {
  return Object.fromEntries(def.params.map((p) => [p.key, p.default]))
}

export interface InstanceInit {
  enabled?: boolean
  params?: Params
  mods?: Partial<Modulator>[]
  /** Legacy single modulator (presets saved before multi-mod support). */
  mod?: Partial<Modulator>
  keys?: Record<string, Keyframe[]>
  mask?: Partial<Mask>
}

export const defaultMask = (): Mask => ({
  source: 'none',
  invert: false,
  feather: 0.35,
  expand: 1,
  show: false,
  color: '#e02030',
  tolerance: 0.15,
  label: 'cup',
  track: '',
  polys: [],
  depthLo: 0.5,
  depthHi: 1
})

export function newModulator(effectId: string, m: Partial<Modulator> = {}): Modulator {
  const firstNum = EFFECTS[effectId].params.find(isNumberParam)
  return { target: firstNum?.key ?? '', shape: 'sine', rate: 0.5, depth: 0.2, trigger: 'beat', every: 1, attack: 0.01, decay: 0.25, ...m }
}

export function createInstance(effectId: string, init: InstanceInit = {}): Instance {
  const def = EFFECTS[effectId]
  const mods = init.mods ?? (init.mod && init.mod.shape !== 'off' ? [init.mod] : [])
  return {
    uid: newUid(),
    effectId,
    enabled: init.enabled ?? true,
    params: { ...defaultParams(def), ...(init.params ?? {}) },
    mods: mods.map((m) => newModulator(effectId, m)),
    keys: structuredClone(init.keys ?? {}),
    mask: { ...defaultMask(), ...(init.mask ?? {}) }
  }
}

export function randomizeParams(inst: Instance): void {
  const def = EFFECTS[inst.effectId]
  for (const p of def.params) {
    if (!isNumberParam(p)) continue
    const r = p.min + Math.random() * (p.max - p.min)
    inst.params[p.key] = p.step ? Math.round(r / p.step) * p.step : r
  }
}
