// embedder.js
// Shared engine code: load MediaPipe, prepare images, embed, compare.
// The probe page uses this today; the real app and the parity check will reuse it.

import { MEDIAPIPE_BASE, MODELS, MODEL_INPUT_SIZE } from "./config.js";

let mediapipe = null; // the imported MediaPipe JS module (loaded once)
let fileset = null;   // tells MediaPipe where its WebAssembly files live

async function loadMediaPipe() {
  if (!mediapipe) {
    mediapipe = await import(`${MEDIAPIPE_BASE}/vision_bundle.mjs`);
    fileset = await mediapipe.FilesetResolver.forVisionTasks(`${MEDIAPIPE_BASE}/wasm`);
  }
  return { mediapipe, fileset };
}

/**
 * Creates a MediaPipe ImageEmbedder.
 * @param {{modelKey?: "small"|"large", delegate?: "CPU"|"GPU"}} options
 * @returns {Promise<{embedder: any, stats: object}>}
 */
export async function createEmbedder({ modelKey = "small", delegate = "CPU" } = {}) {
  const model = MODELS[modelKey];
  if (!model) throw new Error(`Unknown model "${modelKey}"`);

  const t0 = performance.now();
  const { mediapipe, fileset } = await loadMediaPipe();
  const t1 = performance.now();

  const response = await fetch(model.path);
  if (!response.ok) {
    throw new Error(
      `Model file not found at ${model.path} (HTTP ${response.status}). ` +
        "Run scripts/fetch_models.sh, then commit and push web/models/."
    );
  }
  const modelBytes = new Uint8Array(await response.arrayBuffer());
  const t2 = performance.now();

  // CPU is the default on purpose: MediaPipe's GPU path has known
  // wrong-result bugs on iOS Safari, and this model is fast on CPU anyway.
  const embedder = await mediapipe.ImageEmbedder.createFromOptions(fileset, {
    baseOptions: { modelAssetBuffer: modelBytes, delegate },
    runningMode: "IMAGE",
  });
  const t3 = performance.now();

  return {
    embedder,
    stats: {
      model: model.label,
      modelKey,
      delegate,
      modelBytes: modelBytes.byteLength,
      libraryImportMs: Math.round(t1 - t0),
      modelDownloadMs: Math.round(t2 - t1),
      engineInitMs: Math.round(t3 - t2), // includes the WebAssembly download on a first visit
      totalMs: Math.round(t3 - t0),
      wasm: wasmResourceTiming(),
    },
  };
}

/** Best-effort size and time for the WebAssembly download, from the browser's own timing data. */
function wasmResourceTiming() {
  const entry = performance
    .getEntriesByType("resource")
    .find((e) => e.name.includes("vision_wasm") && e.name.endsWith(".wasm"));
  if (!entry) return null;
  // transferBytes > 0: downloaded now. transferBytes 0 with decodedBytes > 0: served from cache.
  // Both 0: the CDN did not share sizes with this page, so only the time is known.
  return {
    transferBytes: entry.transferSize ?? 0,
    decodedBytes: entry.decodedBodySize ?? 0,
    durationMs: Math.round(entry.duration),
  };
}

/**
 * Decodes an image file (camera photo or upload) into an <img>.
 * Using <img> means the browser applies the photo's EXIF rotation for us.
 */
export async function fileToImage(file) {
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.decoding = "async";
  img.src = url;
  try {
    await img.decode();
  } catch {
    URL.revokeObjectURL(url);
    throw new Error(
      `This browser could not decode "${file.name || "the photo"}" (${file.type || "unknown type"}). ` +
        "If it is a HEIC photo, try Safari or export it as JPEG."
    );
  }
  img.dataset.objectUrl = url; // so the caller can release it later
  return img;
}

/** Releases the memory held by an image made with fileToImage(). */
export function releaseImage(img) {
  if (img?.dataset?.objectUrl) URL.revokeObjectURL(img.dataset.objectUrl);
}

/**
 * Center-crops any image or video frame to a square and resizes it to
 * size x size. Downscales in halving steps, which avoids the jagged
 * aliasing a single huge resize causes and keeps memory low on phones.
 * @param {HTMLImageElement|HTMLVideoElement|HTMLCanvasElement|ImageBitmap} source
 */
export function toSquareCanvas(source, size = MODEL_INPUT_SIZE) {
  const width = source.naturalWidth || source.videoWidth || source.width;
  const height = source.naturalHeight || source.videoHeight || source.height;
  if (!width || !height) throw new Error("Image has no size yet (still loading?)");

  const side = Math.min(width, height);
  let sx = (width - side) / 2;
  let sy = (height - side) / 2;
  let current = source;
  let currentSide = side;

  while (currentSide / 2 > size) {
    const half = Math.floor(currentSide / 2);
    const step = makeCanvas(half);
    step.getContext("2d").drawImage(current, sx, sy, currentSide, currentSide, 0, 0, half, half);
    current = step;
    currentSide = half;
    sx = 0;
    sy = 0;
  }

  const out = makeCanvas(size);
  out.getContext("2d").drawImage(current, sx, sy, currentSide, currentSide, 0, 0, size, size);
  return out;
}

function makeCanvas(side) {
  const canvas = document.createElement("canvas");
  canvas.width = side;
  canvas.height = side;
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  return canvas;
}

/**
 * Runs the embedder on a prepared square canvas.
 * Note: MediaPipe's embed() is synchronous and briefly blocks the page.
 * @returns {{vector: Float32Array, ms: number}}
 */
export function embedCanvas(embedder, canvas) {
  const t0 = performance.now();
  const result = embedder.embed(canvas);
  const ms = performance.now() - t0;
  const values = result?.embeddings?.[0]?.floatEmbedding;
  if (!values?.length) throw new Error("Embedder returned no vector");
  return { vector: Float32Array.from(values), ms };
}

/** Length of a vector. Close to 1.0 means the model already normalizes its output. */
export function norm(v) {
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += v[i] * v[i];
  return Math.sqrt(sum);
}

/** Cosine similarity: 1.0 = same direction, 0 = unrelated. Safe whether or not vectors are normalized. */
export function cosine(a, b) {
  if (a.length !== b.length) throw new Error(`Vector sizes differ (${a.length} vs ${b.length})`);
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  const denom = norm(a) * norm(b);
  return denom === 0 ? 0 : dot / denom;
}

export function median(values) {
  const sorted = [...values].sort((x, y) => x - y);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
