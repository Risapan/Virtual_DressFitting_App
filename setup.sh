#!/bin/zsh
# One-time setup: Python env + offline copies of the body tracker.
set -e
cd "$(dirname "$0")"
command -v uv >/dev/null || { echo "Install uv first: curl -LsSf https://astral.sh/uv/install.sh | sh"; exit 1; }
[ -d .venv ] || uv venv --python 3.11 .venv
uv pip install --python .venv/bin/python -q fastapi "uvicorn[standard]" python-multipart pillow numpy
[[ "$1" == "--rembg" ]] && uv pip install --python .venv/bin/python -q "rembg[cpu]"

MP=https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14
mkdir -p static/vendor/mediapipe/wasm static/models
[ -f static/vendor/mediapipe/vision_bundle.mjs ] || curl -sfL -o static/vendor/mediapipe/vision_bundle.mjs $MP/vision_bundle.mjs
for f in vision_wasm_internal.js vision_wasm_internal.wasm vision_wasm_nosimd_internal.js vision_wasm_nosimd_internal.wasm; do
  [ -f static/vendor/mediapipe/wasm/$f ] || curl -sfL -o static/vendor/mediapipe/wasm/$f $MP/wasm/$f
done
[ -f static/models/pose_landmarker_full.task ] || curl -sfL -o static/models/pose_landmarker_full.task \
  https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/latest/pose_landmarker_full.task
.venv/bin/python tools/make_samples.py
echo "Setup done. Run ./start.sh"
