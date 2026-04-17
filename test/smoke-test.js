#!/usr/bin/env node
/**
 * smoke-test.js
 *
 * Basic round-trip against the llama-server /v1/chat/completions endpoint.
 * Run:  node test/smoke-test.js
 *
 * Env:
 *   LLAMA_BASE_URL  (default http://localhost:8080)
 *   LLAMA_MODEL     (default qwen3-8b-vibe — matches LLAMA_ARG_ALIAS)
 */

const BASE = process.env.LLAMA_BASE_URL ?? "http://localhost:8080";
const MODEL = process.env.LLAMA_MODEL ?? "qwen3-8b-vibe";

async function main() {
  const t0 = Date.now();

  const resp = await fetch(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        {
          role: "system",
          content:
            "You are a terse assistant for a CPA. Answer in one sentence.",
        },
        {
          role: "user",
          content:
            "In US GAAP, under which balance sheet section does 'Accumulated Depreciation' normally appear, and is its natural balance a debit or credit?",
        },
      ],
      temperature: 0.2,
      max_tokens: 120,
    }),
  });

  if (!resp.ok) {
    console.error(`HTTP ${resp.status}: ${await resp.text()}`);
    process.exit(1);
  }

  const data = await resp.json();
  const msg = data.choices?.[0]?.message?.content ?? "(no content)";
  const elapsed = ((Date.now() - t0) / 1000).toFixed(2);

  console.log("--- llama-server response ---");
  console.log(msg.trim());
  console.log(`--- ${elapsed}s, ${data.usage?.completion_tokens ?? "?"} tokens out ---`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
