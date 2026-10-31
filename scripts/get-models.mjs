// Fetches the AI models Glitch Chain runs locally (they're too big for git). Runs after `npm install`;
// run it again with `npm run models`. Every file is checked against its SHA-256, and files already in
// place are skipped, so after the first run the app never goes online.
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, statSync, copyFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const HF_DIR = join(ROOT, 'src/renderer/public/hf')
const MP_DIR = join(ROOT, 'src/renderer/src/assets/models')
const ORT_DIR = join(ROOT, 'src/renderer/public/ort')

const hf = (repo, rev) => (file) => `https://huggingface.co/${repo}/resolve/${rev}/${file}`
const mp = (path) => `https://storage.googleapis.com/mediapipe-models/${path}`
const SAM = hf('Xenova/sam-vit-base', 'e9ff25bcbb89d0be0758fcdf28e91193bb7eb6e9')
const DEPTH = hf('onnx-community/depth-anything-v2-small', '4472b7362082ad9968fee890ca0f1e5aca36b93d')
const DINO = hf('onnx-community/grounding-dino-tiny-ONNX', 'ff690b0a8050566c290287545bd059350f3e9096')

// [where it goes, where it comes from, size, sha256]. Versioned URLs where the version matches the file the app was
// built with; the pose model only matches "latest", and the checksum catches it if Google ever replaces it.
const MODELS = [
  // Hugging Face (transformers.js): AI masks from a click or a text prompt, and depth
  [join(HF_DIR, 'Xenova/sam-vit-base/onnx/vision_encoder_fp16.onnx'), SAM('onnx/vision_encoder_fp16.onnx'),
    180194619, '806b471147ba0b6e8dc33f912aecb35bd29c1eb337b6a7acb0bf9bed0766cc8b'],
  [join(HF_DIR, 'Xenova/sam-vit-base/onnx/prompt_encoder_mask_decoder_fp16.onnx'), SAM('onnx/prompt_encoder_mask_decoder_fp16.onnx'),
    8550118, 'df24d49a6f1a5dc0dbbecd84ca0fff9f14c76e63b81fd35c2b92c1321b007f71'],
  [join(HF_DIR, 'onnx-community/grounding-dino-tiny-ONNX/onnx/model_q4f16.onnx'), DINO('onnx/model_q4f16.onnx'),
    151069879, '48435b57e5a5ca01792596b9c64277260b734c10aed320109505c8e71238d6ac'],
  [join(HF_DIR, 'onnx-community/depth-anything-v2-small/onnx/model_fp16.onnx'), DEPTH('onnx/model_fp16.onnx'),
    49642442, '2df6223f206b5164e21f664ace61dabeb9bb6a49b8b5a3e00510b4807d0f5b04'],
  // MediaPipe: face, person, body parts, hands, pose and object tracking
  [join(MP_DIR, 'blaze_face_short_range.tflite'), mp('face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite'),
    229746, 'b4578f35940bf5a1a655214a1cce5cab13eba73c1297cd78e1a04c2380b0152f'],
  [join(MP_DIR, 'selfie_segmenter.tflite'), mp('image_segmenter/selfie_segmenter/float16/1/selfie_segmenter.tflite'),
    249537, '191ac9529ae506ee0beefa6b2c945a172dab9d07d1e802a290a4e4038226658b'],
  [join(MP_DIR, 'selfie_multiclass_256x256.tflite'), mp('image_segmenter/selfie_multiclass_256x256/float32/1/selfie_multiclass_256x256.tflite'),
    16371837, 'c6748b1253a99067ef71f7e26ca71096cd449baefa8f101900ea23016507e0e0'],
  [join(MP_DIR, 'hand_landmarker.task'), mp('hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task'),
    7819105, 'fbc2a30080c3c557093b5ddfc334698132eb341044ccee322ccf8bcf3607cde1'],
  [join(MP_DIR, 'pose_landmarker_full.task'), mp('pose_landmarker/pose_landmarker_full/float16/latest/pose_landmarker_full.task'),
    9398198, '4eaa5eb7a98365221087693fcc286334cf0858e2eb6e15b506aa4a7ecdcec4ad'],
  [join(MP_DIR, 'efficientdet_lite2.tflite'), mp('object_detector/efficientdet_lite2/float16/1/efficientdet_lite2.tflite'),
    12138859, '5d4ebec1029bc9907aeadb9e7b4ac9cb1da6a19d01ad375210a9ae18ba173302']
]

const sha256 = async (file) => {
  const h = createHash('sha256')
  await pipeline(createReadStream(file), h)
  return h.digest('hex')
}

async function fetchOne([dest, url, size, hash]) {
  const name = dest.slice(ROOT.length + 1).replaceAll('\\', '/')
  if (existsSync(dest) && statSync(dest).size === size && (await sha256(dest)) === hash) return console.log(`  ok    ${name}`)
  mkdirSync(dirname(dest), { recursive: true })
  console.log(`  fetch ${name} (${(size / 1e6).toFixed(1)} MB)`)
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)
  const part = dest + '.part'
  await pipeline(Readable.fromWeb(res.body), createWriteStream(part))
  const got = await sha256(part)
  if (got !== hash) throw new Error(`${name}: checksum mismatch (got ${got})`)
  renameSync(part, dest)
}

console.log('Glitch Chain models (about 450 MB the first time):')
try {
  for (const m of MODELS) await fetchOne(m)
} catch (e) {
  console.error(`\nCouldn't fetch the models: ${e.message}\nCheck your connection and run: npm run models`)
  process.exit(1)
}

// ONNX Runtime's WebAssembly build, served next to the page so transformers.js never needs a CDN
const ortDist = join(ROOT, 'node_modules/onnxruntime-web/dist')
mkdirSync(ORT_DIR, { recursive: true })
for (const f of ['ort-wasm-simd-threaded.asyncify.mjs', 'ort-wasm-simd-threaded.asyncify.wasm']) copyFileSync(join(ortDist, f), join(ORT_DIR, f))
console.log('  ok    ONNX Runtime wasm')
