// config.js
// One place for every version number and asset path, so upgrades are a one-line change.

export const APP_NAME = "Mismo"; // Spanish for "the same"

// MediaPipe Tasks Vision (Google AI Edge). Pinned so the browser and the
// catalog build script always run the exact same engine version.
export const MEDIAPIPE_VERSION = "1.2.3";
export const MEDIAPIPE_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}`;

// Model files live in web/models/ (downloaded once by scripts/fetch_models.sh
// and committed). Serving them from our own site means the catalog build
// script can use the identical file, and the browser can cache it offline.
export const MODELS = {
  small: {
    label: "MobileNet-V3 small (embedder)",
    path: "models/mobilenet_v3_small.tflite",
  },
  large: {
    label: "MobileNet-V3 large (embedder)",
    path: "models/mobilenet_v3_large.tflite",
  },
};

// Both embedder models expect a 224 x 224 image. We do the square crop and
// resize ourselves so the browser and the Python build step see the same pixels.
export const MODEL_INPUT_SIZE = 224;
