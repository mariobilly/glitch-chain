import type { EffectDef } from './types'

export const BLEND_MODES = { normal: 0, add: 1, screen: 2, multiply: 3, overlay: 4, difference: 5, lighten: 6, darken: 7, subtract: 8 }

/**
 * Per-layer settings, shown as the pinned first card of every layer. It is not an image effect: the pipeline
 * reads its blend/opacity (keyframes and modulators included) and its mask to composite the layer, and its
 * enabled toggle is the layer's visibility.
 */
export const layerSettings: EffectDef = {
  id: 'layer',
  name: 'Layer',
  params: [
    { key: 'blend', label: 'blend', type: 'select', options: BLEND_MODES, default: 0 },
    { key: 'opacity', min: 0, max: 1, default: 1 }
  ],
  frag: `void main() { outColor = texture(uTex, vUv); }`
}
