# syntax=docker/dockerfile:1.7
# -----------------------------------------------------------------------------
# llama-vibe-appliance (CPU)
# Serves Qwen3-8B Q4_K_M via llama.cpp's OpenAI-compatible HTTP server.
# The GGUF is baked into the image so the appliance has zero external deps
# at runtime — matches the NucBox M6 distribution model for Vibe TB / MyBooks.
#
# Build locally:
#   docker build -t ghcr.io/kisaesdevlab/llama-vibe:cpu-latest -f Dockerfile .
#
# Or pull the CI-built image (published by .github/workflows/docker.yml):
#   docker pull ghcr.io/kisaesdevlab/llama-vibe:cpu-latest
#
# Run:
#   docker run --rm -p 8080:8080 --name vibe-llm \
#     ghcr.io/kisaesdevlab/llama-vibe:cpu-latest
#
# Pin to a specific llama.cpp release if you want reproducible behavior.
# See https://github.com/ggml-org/llama.cpp/pkgs/container/llama.cpp for tags.
# -----------------------------------------------------------------------------

# ---- Stage 1: download the GGUF (cached by BuildKit) ------------------------
FROM debian:bookworm-slim AS model-fetch

ARG MODEL_REPO=bartowski/Qwen_Qwen3-8B-GGUF
ARG MODEL_FILE=Qwen_Qwen3-8B-Q4_K_M.gguf
ARG MODEL_SHA256=""

RUN apt-get update && \
    apt-get install -y --no-install-recommends ca-certificates curl && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /models

# Huggingface resolves /resolve/main/<file> to a CDN URL with redirects.
# --fail makes curl exit non-zero on 4xx/5xx; -L follows redirects.
RUN --mount=type=cache,target=/root/.cache \
    curl -fL --retry 5 --retry-delay 2 \
      -o "${MODEL_FILE}" \
      "https://huggingface.co/${MODEL_REPO}/resolve/main/${MODEL_FILE}?download=true"

# Optional integrity check. Leave MODEL_SHA256 empty to skip during development;
# pin a digest for production builds.
RUN if [ -n "${MODEL_SHA256}" ]; then \
      echo "${MODEL_SHA256}  ${MODEL_FILE}" | sha256sum -c - ; \
    fi

# ---- Stage 2: assemble runtime image ---------------------------------------
# Pin the llama.cpp base to a known-good build. "server" is CPU-only.
# Swap to :server-vulkan (see Dockerfile.vulkan) for AMD iGPU acceleration
# on the NucBox M6 / M6 Ultra Radeon 660M / 760M.
FROM ghcr.io/ggml-org/llama.cpp:server AS runtime

# Re-declare MODEL_FILE in the runtime stage so a --build-arg override
# flows through to the COPY below (ARGs don't cross stage boundaries).
ARG MODEL_FILE=Qwen_Qwen3-8B-Q4_K_M.gguf

# Model lives inside the image so the appliance is self-contained.
COPY --from=model-fetch /models/${MODEL_FILE} /models/model.gguf

# --- Tunable server args (override with env on `docker run -e ...`) ----------
# See: https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md
ENV LLAMA_ARG_MODEL=/models/model.gguf \
    LLAMA_ARG_HOST=0.0.0.0 \
    LLAMA_ARG_PORT=8080 \
    \
    # 16K context: fits the Vibe TB tax-code crosswalk system prompt
    # plus multi-turn chat. Bump to 32768 if you need more; memory grows ~linear.
    LLAMA_ARG_CTX_SIZE=16384 \
    \
    # Flash-attention reduces KV-cache memory and speeds up inference.
    LLAMA_ARG_FLASH_ATTN=on \
    \
    # Continuous batching lets concurrent requests share the decode stream.
    # --parallel 2 is a sensible default for a single-firm appliance.
    LLAMA_ARG_N_PARALLEL=2 \
    LLAMA_ARG_CONT_BATCHING=1 \
    \
    # KV-cache quantization: q8_0 halves KV memory with negligible quality loss.
    LLAMA_ARG_CACHE_TYPE_K=q8_0 \
    LLAMA_ARG_CACHE_TYPE_V=q8_0 \
    \
    # Thread count. Auto-detects but cap at physical cores on Ryzen 5 6600H (6c/12t).
    LLAMA_ARG_THREADS=6 \
    \
    # mmap keeps weights in page cache (shared across restarts).
    LLAMA_ARG_MLOCK=0 \
    \
    # --jinja enables the embedded chat template AND activates the
    # OpenAI-compatible tool-calling parser for Qwen3. This is REQUIRED
    # for /v1/chat/completions with tools[] to work.
    LLAMA_ARG_JINJA=1 \
    \
    # Qwen3 supports --reasoning-format deepseek to split <think>...</think>
    # into a separate `reasoning_content` field. Non-thinking mode is the
    # default for Qwen3-8B via the chat template; leave this on so that if
    # a caller enables thinking, it comes back cleanly structured.
    LLAMA_ARG_REASONING_FORMAT=deepseek \
    \
    # Sampler defaults recommended by the Qwen team for Qwen3 non-thinking.
    LLAMA_ARG_TEMP=0.7 \
    LLAMA_ARG_TOP_K=20 \
    LLAMA_ARG_TOP_P=0.8 \
    LLAMA_ARG_MIN_P=0.0 \
    \
    # Friendly alias reported by /v1/models. The Vibe TB LLM abstraction layer
    # can key on this to route capability-appropriate requests.
    LLAMA_ARG_ALIAS=qwen3-8b-vibe

EXPOSE 8080

# Healthcheck — the exec-form CMD exits non-zero on its own if the binary is
# missing or unlaunchable, so we don't tack on `|| exit 1` (which would be
# ignored anyway when mixed with JSON exec form).
HEALTHCHECK --interval=30s --timeout=10s --start-period=180s --retries=3 \
  CMD ["/app/llama-server", "--version"]

# The base image's entrypoint is already `/app/llama-server`, and it reads every
# LLAMA_ARG_* env var. No CMD override needed.
