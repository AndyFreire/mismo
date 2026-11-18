#!/usr/bin/env bash
# fetch_models.sh
# Downloads the Google MediaPipe model files into web/models/.
# Run once from anywhere:   bash scripts/fetch_models.sh
# Then commit web/models/ so the live site, the catalog build script and the
# evaluation all use byte-for-byte the same model files.

set -euo pipefail

cd "$(dirname "$0")/.."
mkdir -p web/models

BASE="https://storage.googleapis.com/mediapipe-models"

# download <model-folder> <file-name>
# Tries the pinned version "1" first, then "latest" if "1" is not published.
download() {
  local folder="$1" name="$2" out="web/models/$2"
  if [ -s "$out" ]; then
    echo "already have  $out"
    return
  fi
  echo "downloading   $out"
  curl -fsSL --retry 3 -o "$out" "$BASE/$folder/float32/1/$name" ||
    curl -fsSL --retry 3 -o "$out" "$BASE/$folder/float32/latest/$name"
}

# Visual similarity (step 1 onward)
download image_embedder/mobilenet_v3_small mobilenet_v3_small.tflite
download image_embedder/mobilenet_v3_large mobilenet_v3_large.tflite

# Low-confidence category label (used in step 4)
download image_classifier/efficientnet_lite0 efficientnet_lite0.tflite

echo
echo "Model files:"
ls -lh web/models/*.tflite

echo
echo "SHA-256 (paste these into the README so results are reproducible):"
if command -v shasum >/dev/null 2>&1; then
  shasum -a 256 web/models/*.tflite
else
  sha256sum web/models/*.tflite
fi
