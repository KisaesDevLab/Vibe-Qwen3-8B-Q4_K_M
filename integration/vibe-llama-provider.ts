/**
 * vibe-llama-provider.ts
 *
 * Drop-in provider for the Vibe TB / Vibe MyBooks multi-provider LLM
 * abstraction layer. Conforms to the OpenAI Chat Completions API shape so
 * nothing downstream of the provider interface has to change — llama-server
 * implements the same endpoint.
 *
 * Drop this alongside the existing Anthropic / Ollama / OpenAI-compatible
 * providers. Register it in the model registry as, e.g.:
 *
 *   {
 *     id: "qwen3-8b-vibe",
 *     provider: "llama-cpp",
 *     wire_format: "openai",
 *     capabilities: {
 *       chat: true,
 *       tools: true,
 *       json_schema: true,
 *       vision: false,
 *       embedding: false,          // embeddings need a separate llama-server
 *       context_tokens: 16384
 *     },
 *     route_hint: "local.self-hosted"
 *   }
 *
 * Because llama-server speaks the OpenAI wire format natively, this provider
 * is a thin typed wrapper — most of the value is centralizing the base URL,
 * timeouts, and capability advertising.
 */

// -- Minimal OpenAI-compatible types. Mirror the shapes you already use. -----
export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface ChatMessage {
  role: ChatRole;
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
  name?: string;
}

export interface ToolDef {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>; // JSON Schema
  };
}

export interface ChatCompletionRequest {
  messages: ChatMessage[];
  tools?: ToolDef[];
  tool_choice?: "auto" | "none" | { type: "function"; function: { name: string } };
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stream?: boolean;
  response_format?:
    | { type: "json_object" }
    | {
        type: "json_schema";
        json_schema: {
          name: string;
          strict?: boolean;
          schema: Record<string, unknown>;
        };
      };
  // llama.cpp extension: pass a GBNF grammar directly if you want even tighter
  // control than json_schema gives you.
  grammar?: string;
}

export interface ChatCompletionResponse {
  id: string;
  model: string;
  choices: Array<{
    index: number;
    message: ChatMessage;
    finish_reason: "stop" | "length" | "tool_calls" | string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

// -- Provider ---------------------------------------------------------------

export interface LlamaVibeProviderOptions {
  /** Base URL of the llama-server container. Defaults to env or localhost. */
  baseUrl?: string;
  /** Model alias reported by /v1/models. Must match LLAMA_ARG_ALIAS. */
  model?: string;
  /** Request timeout in ms. Defaults to 120_000 — local inference is slower than cloud. */
  timeoutMs?: number;
  /** Shared fetch impl. Node 20 has global fetch; injected for tests. */
  fetchImpl?: typeof fetch;
}

export class LlamaVibeProvider {
  readonly id = "llama-cpp";
  readonly baseUrl: string;
  readonly model: string;
  readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: LlamaVibeProviderOptions = {}) {
    this.baseUrl =
      opts.baseUrl ?? process.env.LLAMA_BASE_URL ?? "http://localhost:8080";
    this.model = opts.model ?? process.env.LLAMA_MODEL ?? "qwen3-8b-vibe";
    this.timeoutMs = opts.timeoutMs ?? 120_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /**
   * Report the model's live capabilities. Used by the capability-driven
   * registry to decide when this provider can handle a request vs when to
   * fall back to Anthropic / OpenAI.
   */
  async describe(): Promise<{
    id: string;
    model: string;
    healthy: boolean;
    capabilities: {
      chat: true;
      tools: true;
      json_schema: true;
      grammar: true;
      vision: false;
      streaming: true;
      context_tokens: number;
    };
  }> {
    const healthy = await this.isHealthy();
    return {
      id: this.id,
      model: this.model,
      healthy,
      capabilities: {
        chat: true,
        tools: true,
        json_schema: true,
        grammar: true,
        vision: false,
        streaming: true,
        // Matches LLAMA_ARG_CTX_SIZE in the Dockerfile. If you need this to
        // reflect the live server setting, fetch /props and read ctx_size.
        context_tokens: 16384,
      },
    };
  }

  async isHealthy(): Promise<boolean> {
    try {
      const r = await this.fetchImpl(`${this.baseUrl}/health`, {
        signal: AbortSignal.timeout(3000),
      });
      return r.ok;
    } catch {
      return false;
    }
  }

  async chat(req: ChatCompletionRequest): Promise<ChatCompletionResponse> {
    const body = JSON.stringify({ model: this.model, ...req });
    const r = await this.fetchImpl(`${this.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!r.ok) {
      const text = await r.text().catch(() => "");
      throw new LlamaVibeError(
        `llama-server responded ${r.status}: ${text.slice(0, 500)}`,
        r.status
      );
    }
    return (await r.json()) as ChatCompletionResponse;
  }

  /**
   * Streaming variant. Yields chat.completion.chunk deltas in the OpenAI SSE
   * format. Use this for the Vibe TB support chat so tokens appear as they
   * decode — critical for perceived responsiveness on CPU inference.
   */
  async *chatStream(
    req: ChatCompletionRequest
  ): AsyncGenerator<ChatCompletionResponse["choices"][0]["message"]> {
    const r = await this.fetchImpl(`${this.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: this.model, ...req, stream: true }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!r.ok || !r.body) {
      const text = r.body ? await r.text().catch(() => "") : "";
      throw new LlamaVibeError(
        `llama-server stream responded ${r.status}: ${text.slice(0, 500)}`,
        r.status
      );
    }

    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === "[DONE]") return;
        try {
          const parsed = JSON.parse(payload);
          const delta = parsed.choices?.[0]?.delta;
          if (delta) yield delta as ChatMessage;
        } catch {
          // Ignore malformed lines — llama-server occasionally sends keepalives.
        }
      }
    }
  }
}

export class LlamaVibeError extends Error {
  constructor(msg: string, public status?: number) {
    super(msg);
    this.name = "LlamaVibeError";
  }
}

// -- Example usage ----------------------------------------------------------
//
// import { LlamaVibeProvider } from "./vibe-llama-provider";
//
// const llm = new LlamaVibeProvider();
//
// // Plain chat
// const r = await llm.chat({
//   messages: [{ role: "user", content: "What's GAAP vs tax basis?" }],
//   max_tokens: 200,
// });
// console.log(r.choices[0].message.content);
//
// // Schema-constrained classification (used by Vibe TB tax mapping)
// const classified = await llm.chat({
//   messages: [
//     { role: "system", content: "Classify account names to 1065 tax codes." },
//     { role: "user",   content: "Account: Meals - Client (50%)" },
//   ],
//   response_format: {
//     type: "json_schema",
//     json_schema: {
//       name: "classification",
//       strict: true,
//       schema: {
//         type: "object",
//         additionalProperties: false,
//         required: ["tax_code", "confidence"],
//         properties: {
//           tax_code: { type: "string" },
//           confidence: { type: "number", minimum: 0, maximum: 1 },
//         },
//       },
//     },
//   },
// });
// const parsed = JSON.parse(classified.choices[0].message.content ?? "{}");
