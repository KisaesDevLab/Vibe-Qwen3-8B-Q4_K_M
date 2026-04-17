#!/usr/bin/env bash
# Downloads Qwen3-8B Q4_K_M GGUF into ./models for the dev compose profile.
# Run once, then `docker compose --profile dev up`.

set -euo pipefail

MODEL_REPO="${MODEL_REPO:-bartowski/Qwen_Qwen3-8B-GGUF}"
MODEL_FILE="${MODEL_FILE:-Qwen_Qwen3-8B-Q4_K_M.gguf}"

cd "$(dirname "$0")/.."
mkdir -p models
cd models

if [[ -f "${MODEL_FILE}" ]]; then
  echo "[i] ${MODEL_FILE} already present — skipping download."
  echo "    Delete it to force a re-download."
  exit 0
fi

echo "[+] Downloading ${MODEL_REPO}/${MODEL_FILE} (~4.9 GB)..."
curl -fL --retry 5 --retry-delay 2 --progress-bar \
  -o "${MODEL_FILE}" \
  "https://huggingface.co/${MODEL_REPO}/resolve/main/${MODEL_FILE}?download=true"

echo "[✓] Saved to $(pwd)/${MODEL_FILE}"
ls -lh "${MODEL_FILE}"
