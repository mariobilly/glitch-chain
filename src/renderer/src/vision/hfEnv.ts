import { env } from '@huggingface/transformers'

// Everything is bundled with the app: never reach for the Hugging Face hub or a CDN.
env.allowRemoteModels = false
env.allowLocalModels = true
env.useBrowserCache = false
env.localModelPath = new URL('hf/', document.baseURI).href
if (env.backends.onnx.wasm) env.backends.onnx.wasm.wasmPaths = new URL('ort/', document.baseURI).href
