/** A face as an ellipse in source-normalized coords (x right, y down, 0..1). Radii are fractions of width/height. */
export interface Face {
  cx: number
  cy: number
  rx: number
  ry: number
  angle: number
}

/** A rounded segment in source pixels: [ax, ay, bx, by, radius]. Limb masks are unions of these. */
export type Capsule = [number, number, number, number, number]
export type LimbKind = 'hands' | 'fingers' | 'legs' | 'arms'
export const LIMB_KINDS: LimbKind[] = ['hands', 'fingers', 'legs', 'arms']
export const MAX_FACES = 4
export const MAX_CAPSULES = 64

/** Which models the enabled effects in a chain need. */
export interface Needs {
  face: boolean
  person: boolean
  /** Multiclass body parts: hair / skin / clothes. */
  parts: boolean
  hands: boolean
  /** Body pose: legs and arms. */
  pose: boolean
  /** General object detector (80 COCO classes). */
  objects: boolean
}
export const anyNeed = (n: Needs): boolean => n.face || n.person || n.parts || n.hands || n.pose || n.objects

export function maskNeeds(chain: { enabled: boolean; mask: { source: string } }[]): Needs {
  const src = new Set(chain.filter((i) => i.enabled).map((i) => i.mask.source))
  return {
    face: src.has('face'),
    person: src.has('person'),
    parts: src.has('hair') || src.has('skin') || src.has('clothes'),
    hands: src.has('hands') || src.has('fingers'),
    pose: src.has('legs') || src.has('arms'),
    objects: src.has('object')
  }
}

/** A detected object box in source pixels (y down). */
export interface ObjBox {
  label: string
  x: number
  y: number
  w: number
  h: number
  score: number
}
export const MAX_BOXES = 16

/** The detector's classes (COCO), in the order people usually look for them. */
export const OBJECT_LABELS = [
  'person', 'car', 'cup', 'bottle', 'cell phone', 'laptop', 'chair', 'couch', 'bed', 'dining table', 'tv', 'book', 'clock',
  'vase', 'potted plant', 'dog', 'cat', 'bird', 'horse', 'bicycle', 'motorcycle', 'bus', 'truck', 'train', 'airplane', 'boat',
  'traffic light', 'stop sign', 'bench', 'backpack', 'umbrella', 'handbag', 'tie', 'suitcase', 'frisbee', 'skis', 'snowboard',
  'sports ball', 'kite', 'baseball bat', 'baseball glove', 'skateboard', 'surfboard', 'tennis racket', 'wine glass', 'fork',
  'knife', 'spoon', 'bowl', 'banana', 'apple', 'sandwich', 'orange', 'broccoli', 'carrot', 'hot dog', 'pizza', 'donut', 'cake',
  'toilet', 'mouse', 'remote', 'keyboard', 'microwave', 'oven', 'toaster', 'sink', 'refrigerator', 'scissors', 'teddy bear',
  'hair drier', 'toothbrush', 'fire hydrant', 'parking meter', 'sheep', 'cow', 'elephant', 'bear', 'zebra', 'giraffe'
]

/** A mask image (source space, top-down rows): 1 channel for person, RGBA for parts. */
export interface MaskData {
  w: number
  h: number
  data: Uint8Array
}

export interface VisionResult {
  faces: Face[]
  caps: Record<LimbKind, Capsule[]>
  handCount: number
  poseCount: number
  objects: ObjBox[]
  person?: MaskData
  /** r = hair, g = skin (face + body), b = clothes, a = person. */
  parts?: MaskData
}

export interface ModelUrls {
  loader: string
  wasm: string
  face: string
  person: string
  parts: string
  hand: string
  pose: string
  object: string
}
