# llama-vibe-appliance

A self-hosted, Docker-packaged llama.cpp inference server tuned for the AI
workloads in **Vibe Trial Balance** and **Vibe MyBooks** — tax-code crosswalk
classification, bookkeeping categorization, support chat, and any other
OpenAI-compatible completion traffic the multi-provider LLM abstraction layer
routes to `provider: "llama-cpp"`.

The result is an OpenAI-compatible HTTP server at `http://localhost:8080/v1`
serving **Qwen3-8B** (Q4_K_M, ~4.9 GB), with native tool-calling and
JSON-schema-constrained decoding working out of the box.

---

## Why Qwen3-8B Q4_K_M

| Requirement | How Qwen3-8B satisfies it |
|---|---|
| Commercial-friendly license (this repo is MIT) | Apache 2.0 |
| Strong tool / function calling | llama.cpp has a built-in `--jinja` tool-call parser specifically for Qwen3 — standard JSON tool-call format, no custom XML parser required |
| Grammar-constrained JSON output | llama-server supports OpenAI `response_format: {type:"json_schema"}` and converts schemas into GBNF |
| Fits on NucBox M6 alongside Postgres, Redis, app stack | ~4.9 GB weights + ~2 GB KV cache at 16K ctx ≈ **7–9 GB working set** |
| Runs at usable speed on Ryzen 5 6600H/7640HS | ~12–20 tok/s CPU-only; ~25–40 tok/s with Vulkan iGPU offload |
| Sane context window for CLAUDE.md-style long prompts | 32K native, 128K via YaRN |

**Runner-up: Qwen3-4B Q4_K_M** (~2.5 GB). Same provider code, same chat
template, same tool-call format. Swap the `MODEL_FILE` build arg when a
customer's box is tight on RAM (16 GB M6 base model) or when GLM-OCR and
Vibe MyBooks are co-hosted.

**Deliberately avoided:**

- **Qwen3-Coder** — uses a custom XML tool-call format that requires a
  separate parser; llama.cpp support is still unstable (GitHub issue #15012).
  Great at agentic coding; wrong shape for bookkeeping classification.
- **Qwen3.5-9B** — newer and higher-benchmark, but tool-calling fixes were
  still landing as of March 2026 and LM Studio/Ollama compatibility caveats
  exist. Worth revisiting in a quarter.
- **Phi-4 14B / Gemma 3 27B** — better quality ceiling but push the M6
  uncomfortably close to RAM limits once Postgres and Node are also running.
- **Qwen3 30B MoE** — needs too much RAM; the 3B active parameters are
  misleading because all 30B must still be resident.

---

## Repo layout

```
.
├── Dockerfile              # CPU-only appliance, model baked in
├── Dockerfile.vulkan       # Same, but with AMD iGPU (Vulkan) acceleration
├── docker-compose.yml      # dev / appliance / vulkan profiles
├── scripts/
│   └── download-model.sh   # for the `dev` profile (volume-mounted model)
├── test/
│   ├── smoke-test.js       # basic chat completion round-trip
│   ├── tool-calling-test.js       # Vibe MyBooks transaction categorization
│   └── tb-classification-test.js  # Vibe TB tax-code crosswalk
└── integration/
    └── vibe-llama-provider.ts     # drop-in OpenAI-shape provider
```

---

## Quick start

### Development (fast iteration, bring-your-own-model)

```bash
./scripts/download-model.sh        # ~4.9 GB to ./models/
docker compose --profile dev up
node test/smoke-test.js
node test/tool-calling-test.js
node test/tb-classification-test.js
```

### Production appliance (CPU, model baked in)

```bash
docker compose --profile appliance build
docker compose --profile appliance up -d
```

### Production appliance (Vulkan / AMD iGPU)

Host prerequisite on Ubuntu Server 24.04 LTS:

```bash
sudo apt-get install -y mesa-vulkan-drivers vulkan-tools
vulkaninfo --summary       # verify an AMD Radeon device is listed
```

Then:

```bash
docker compose --profile vulkan build
docker compose --profile vulkan up -d
```

---

## Sizing math (NucBox M6 baseline)

Hardware: Ryzen 5 6600H, 32 GB DDR5-4800, Radeon 660M (RDNA2, shared memory).

| Component | Working set |
|---|---|
| Qwen3-8B Q4_K_M weights (mmap) | ~4.9 GB |
| KV cache @ 16K ctx, q8_0 | ~1.8 GB |
| llama-server overhead + graph | ~0.5 GB |
| Vulkan UMA frame buffer (BIOS) | 2–8 GB (counts against system RAM) |
| **LLM container total** | **~8–15 GB** |
| Postgres 16, Redis 7, BullMQ, Node.js app | ~3–5 GB |
| Docker / OS | ~2 GB |
| **Target headroom** | **~12–20 GB remaining of 32 GB** |

If you ever see OOM under load, the first thing to lower is `LLAMA_ARG_CTX_SIZE`
(16384 → 8192 halves the KV cache), not the quantization.

---

## Integration with the capability-driven model registry

The provider in `integration/vibe-llama-provider.ts` implements the
OpenAI-compatible surface that your existing Anthropic / Ollama /
OpenAI-compatible providers already share. Register it as:

```ts
{
  id: "qwen3-8b-vibe",
  provider: "llama-cpp",
  wire_format: "openai",
  route_hint: "local.self-hosted",
  capabilities: {
    chat: true,
    tools: true,
    json_schema: true,
    grammar: true,         // GBNF passthrough — llama.cpp-specific extension
    vision: false,
    streaming: true,
    context_tokens: 16384
  }
}
```

### Routing guidance

| Task | Route to |
|---|---|
| Tax code classification (Vibe TB) | `llama-cpp` (fast, deterministic with `response_format: json_schema`) |
| Transaction categorization (Vibe MyBooks) | `llama-cpp` with tool calls |
| Support chat answers about tax basics | `llama-cpp` |
| Questions that need recent case law or current-year IRS guidance | Anthropic (Claude has a far wider, more current knowledge base) |
| OCR of scanned PDFs | GLM-OCR on separate Ollama endpoint |
| High-stakes advisory content on a specific client return | Anthropic, with human review |

The capability flags let the registry reject requests that Qwen3-8B can't
serve (e.g. `vision: true` requests would fall through to a VL-capable
provider) without hard-coding provider preferences in caller code.

---

## What llama-server gives you beyond "an endpoint"

Worth knowing because several of these change how you prompt:

- **`/v1/chat/completions`** — OpenAI-compatible, supports `tools`,
  `tool_choice`, `response_format`, `stream`.
- **`/v1/models`** — returns `qwen3-8b-vibe` (from `LLAMA_ARG_ALIAS`).
- **`/health`** — used by Docker's healthcheck.
- **`/props`** — reports live server config (ctx size, n_parallel, etc.).
  Useful for the `describe()` method in the provider to report accurate
  capability limits.
- **`/completion`** — llama.cpp-native endpoint with extra parameters
  (`grammar`, `n_probs`, `min_keep`). Use when you want to pass GBNF
  directly for grammars that aren't expressible as JSON Schema.
- **`reasoning_content`** — when `LLAMA_ARG_REASONING_FORMAT=deepseek`,
  Qwen3 thinking-mode output is split from final content into a separate
  field. Non-thinking mode is the default for Qwen3-8B, so this will be
  empty unless you explicitly opt in.

---

## Upgrade path

When you're ready to move beyond Qwen3-8B:

1. **Qwen3.5-9B** once tool-calling is fully stable in llama.cpp (monitor
   [ggml-org/llama.cpp issue #20837](https://github.com/ggml-org/llama.cpp/issues/20837)).
   Same license, same chat template shape.
2. **Qwen3-VL-8B-Instruct** for in-appliance receipt/invoice vision — would
   replace GLM-OCR for many workflows with a single unified model.
3. **Granite 3.x 8B** if you want a model with business/legal fine-tuning.
   Apache 2.0, solid tool calling, ships with the same OpenAI wire format.

Because the provider speaks pure OpenAI chat-completions and advertises
capabilities through `describe()`, swapping the model is a matter of
rebuilding the image with a new `MODEL_REPO` / `MODEL_FILE` build arg and
optionally bumping the advertised `context_tokens`.

---

## Known gotchas

- **First start is slow.** Loading a 4.9 GB GGUF from disk into mmap
  takes 20–60 s on the M6's NVMe. That's why `start_period: 180s` is set
  on the healthcheck. The container will show `starting` until the model
  is resident.
- **`--jinja` is mandatory.** Without it, tool calls come back as raw text
  inside `content` instead of parsed `tool_calls[]`. The Dockerfile sets
  `LLAMA_ARG_JINJA=1`; don't turn it off.
- **KV cache at q8_0 is the memory knob.** If you go to `f16` for quality,
  double the KV cache budget in the sizing table above.
- **Cold concurrency.** `--parallel 2` means two concurrent decodes share
  the GPU/CPU. A third request queues. For a single-firm appliance this is
  fine; scale up only if you see queue latency in practice.
