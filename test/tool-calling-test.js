#!/usr/bin/env node
/**
 * tool-calling-test.js
 *
 * Verifies llama-server's OpenAI-compatible tool_calls pipeline against Qwen3.
 * The llama-server's --jinja flag activates the Qwen3 native tool parser; if
 * this test passes, the Vibe MyBooks "AI categorize transactions" flow will
 * work with the same provider code as the Anthropic/OpenAI paths.
 *
 * Scenario: Vibe MyBooks sees a bank transaction description and needs the
 * model to call post_transaction_code() with a normalized vendor name and
 * a suggested GL account.
 *
 * Run:  node test/tool-calling-test.js
 */

const BASE = process.env.LLAMA_BASE_URL ?? "http://localhost:8080";
const MODEL = process.env.LLAMA_MODEL ?? "qwen3-8b-vibe";

const tools = [
  {
    type: "function",
    function: {
      name: "post_transaction_code",
      description:
        "Record a bookkeeping decision for a single bank transaction. " +
        "Always call this exactly once per transaction presented.",
      parameters: {
        type: "object",
        properties: {
          normalized_vendor: {
            type: "string",
            description:
              "Clean human-readable vendor name, e.g. 'Amazon' or " +
              "'Shell Gas Station' — strip payment processor prefixes, " +
              "store numbers, dates, and transaction IDs.",
          },
          gl_account: {
            type: "string",
            enum: [
              "Office Supplies",
              "Software & Subscriptions",
              "Meals & Entertainment",
              "Travel",
              "Automobile Expense",
              "Utilities",
              "Professional Fees",
              "Bank Fees",
              "Owner Draw",
              "Other Expense",
              "Income",
            ],
            description: "Most likely General Ledger account for this charge.",
          },
          confidence: {
            type: "number",
            minimum: 0,
            maximum: 1,
            description: "Model self-reported confidence (0 to 1).",
          },
          needs_review: {
            type: "boolean",
            description:
              "True when the description is ambiguous and a human should verify.",
          },
        },
        required: ["normalized_vendor", "gl_account", "confidence", "needs_review"],
      },
    },
  },
];

async function classifyOne(description) {
  const resp = await fetch(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        {
          role: "system",
          content:
            "You are a bookkeeping assistant. For each bank transaction " +
            "description, call post_transaction_code exactly once with your " +
            "best categorization. Use needs_review=true only when the " +
            "description genuinely does not identify the vendor or purpose.",
        },
        {
          role: "user",
          content: `Bank description: "${description}"`,
        },
      ],
      tools,
      tool_choice: "auto",
      temperature: 0.2,
      max_tokens: 400,
    }),
  });

  if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
  const data = await resp.json();
  const msg = data.choices?.[0]?.message;

  if (!msg?.tool_calls?.length) {
    return { ok: false, raw: msg?.content ?? "(no content, no tool_calls)" };
  }

  const call = msg.tool_calls[0];
  let args;
  try {
    args = JSON.parse(call.function.arguments);
  } catch (e) {
    return { ok: false, raw: call.function.arguments };
  }
  return { ok: true, tool: call.function.name, args };
}

const samples = [
  "SQ *BLUE BOTTLE COFFEE 4532 OAKLAND CA",
  "AMZN Mktp US*2K4HG1AB3 AMZN.COM/BILL WA",
  "ANTHROPIC.COM   SAN FRANCISCO CA",
  "SHELL OIL 57442311002 SPRINGFIELD MO",
  "COMCAST CABLE COMM 800-COMCAST PA",
  "CHECK 1042",
];

async function main() {
  for (const s of samples) {
    const t0 = Date.now();
    const r = await classifyOne(s);
    const ms = Date.now() - t0;
    if (!r.ok) {
      console.log(`[✗] ${s}`);
      console.log(`    fallback text: ${r.raw}`);
      continue;
    }
    console.log(`[✓] (${ms}ms) ${s}`);
    console.log(`    → ${r.tool}(${JSON.stringify(r.args)})`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
