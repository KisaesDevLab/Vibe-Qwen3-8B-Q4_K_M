#!/usr/bin/env node
/**
 * tb-classification-test.js
 *
 * Exercises the exact pattern Vibe Trial Balance will use to drive the
 * AI-assisted tax code crosswalk: JSON-schema-constrained decoding.
 *
 * llama-server supports OpenAI's `response_format: { type: "json_schema", ... }`
 * and converts the schema into a GBNF grammar that constrains every sampled
 * token to produce valid JSON. This means the model physically cannot emit
 * an out-of-schema response — which is exactly what you want for a workpaper
 * feature that feeds database rows.
 *
 * Run:  node test/tb-classification-test.js
 */

const BASE = process.env.LLAMA_BASE_URL ?? "http://localhost:8080";
const MODEL = process.env.LLAMA_MODEL ?? "qwen3-8b-vibe";

// A compact slice of the UltraTax CS crosswalk. In the real app this would be
// dynamically assembled from the 1,061-row crosswalk table, filtered to the
// return type (1040 / 1065 / 1120S) and activity (Business / Rental / etc.).
const TAX_CODES_1065 = [
  { code: "401",  label: "Gross receipts or sales" },
  { code: "403",  label: "Returns and allowances" },
  { code: "410",  label: "Purchases (COGS)" },
  { code: "412",  label: "Cost of labor (COGS)" },
  { code: "503",  label: "Salaries and wages (other than to partners)" },
  { code: "507",  label: "Guaranteed payments to partners" },
  { code: "509",  label: "Rent" },
  { code: "511",  label: "Taxes and licenses" },
  { code: "513",  label: "Interest expense" },
  { code: "515",  label: "Depreciation" },
  { code: "517",  label: "Employee benefit programs" },
  { code: "521",  label: "Advertising" },
  { code: "523",  label: "Office expense" },
  { code: "525",  label: "Travel" },
  { code: "527",  label: "Meals (50% deductible)" },
  { code: "531",  label: "Utilities" },
  { code: "533",  label: "Insurance" },
  { code: "537",  label: "Repairs and maintenance" },
  { code: "541",  label: "Professional fees" },
  { code: "599",  label: "Other deductions" },
];

const schema = {
  type: "object",
  additionalProperties: false,
  properties: {
    tax_code: {
      type: "string",
      enum: TAX_CODES_1065.map((t) => t.code),
    },
    tax_code_label: {
      type: "string",
      enum: TAX_CODES_1065.map((t) => t.label),
    },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    rationale: { type: "string", maxLength: 200 },
    needs_review: { type: "boolean" },
  },
  required: ["tax_code", "tax_code_label", "confidence", "rationale", "needs_review"],
};

const systemPrompt = `You map a Chart of Accounts entry to the correct UltraTax CS 1065 tax code.

Available tax codes (code — label):
${TAX_CODES_1065.map((t) => `  ${t.code} — ${t.label}`).join("\n")}

Rules:
- Pick the single best-fitting code.
- 'rationale' must be one short sentence explaining the match.
- 'confidence' reflects how obvious the mapping is (1.0 = unambiguous).
- Set 'needs_review' = true only when the account name is generic, a
  contra-account, or spans categories a preparer would want to eyeball.`;

async function classify(accountName) {
  const resp = await fetch(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: `Account name: "${accountName}"` },
      ],
      // Grammar-constrained JSON. The model cannot emit invalid output.
      response_format: {
        type: "json_schema",
        json_schema: { name: "tax_code_mapping", strict: true, schema },
      },
      temperature: 0.1,
      max_tokens: 300,
    }),
  });

  if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
  const data = await resp.json();
  const content = data.choices?.[0]?.message?.content ?? "{}";
  return JSON.parse(content);
}

const accounts = [
  "Meals - Client (50%)",
  "Rent Expense - Office",
  "Payroll - Admin Staff",
  "Guaranteed Payment - Partner A",
  "Legal & Accounting",
  "Dues & Subscriptions",     // ambiguous — might map to 523 or 599
  "Section 179 Depreciation",
  "Internet & Phone",
  "Shopify Fees",             // no direct line item
  "Bad Debt Expense",         // not in the list at all — should go Other
];

async function main() {
  for (const a of accounts) {
    const t0 = Date.now();
    const r = await classify(a);
    const ms = Date.now() - t0;
    console.log(`[${ms}ms] ${a}`);
    console.log(
      `   → ${r.tax_code} "${r.tax_code_label}"  conf=${r.confidence}  review=${r.needs_review}`
    );
    console.log(`     ${r.rationale}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
