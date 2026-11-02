import type { ChatRequest, Message, Provider, StopReason, StreamEvent, ToolCallPart, Usage } from "../types.js";
import { ProviderError, cutOff, getJSON, parseSSE, parseToolArgs, postWithRetry } from "./sse.js";

export interface OpenAIOptions {
  model: string;
  baseUrl: string;
  apiKey?: string;
  headers?: Record<string, string>;
}

// Chat Completions. Also covers Ollama, LM Studio, vLLM, OpenRouter, Groq.
export class OpenAIProvider implements Provider {
  readonly name = "openai";
  readonly model: string;
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  // api.openai.com wants max_completion_tokens, compatible servers use max_tokens
  private readonly maxTokensParam: string;

  constructor(opts: OpenAIOptions) {
    this.model = opts.model;
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.headers = { ...opts.headers };
    if (opts.apiKey) this.headers.authorization = `Bearer ${opts.apiKey}`;
    this.maxTokensParam = this.baseUrl.includes("api.openai.com") ? "max_completion_tokens" : "max_tokens";
  }

  async listModels(): Promise<string[]> {
    const res = await getJSON(`${this.baseUrl}/models`, this.headers);
    return res.data.map((m: { id: string }) => m.id).sort();
  }

  async *stream(req: ChatRequest): AsyncGenerator<StreamEvent> {
    const body: Record<string, unknown> = {
      model: this.model,
      stream: true,
      stream_options: { include_usage: true },
      [this.maxTokensParam]: req.maxTokens,
      messages: [{ role: "system", content: req.system }, ...toOpenAIMessages(req.messages)],
    };
    if (req.tools.length) {
      body.tools = req.tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
    }
    const res = await postWithRetry(`${this.baseUrl}/chat/completions`, this.headers, body, req);

    const usage: Usage = { inputTokens: 0, outputTokens: 0 };
    let finish: string | undefined;
    let sawDone = false;
    const calls = new Map<number, { id: string; name: string; args: string }>();

    for await (const msg of parseSSE(res.body!)) {
      if (msg.data === "[DONE]") {
        sawDone = true;
        break;
      }
      const chunk = JSON.parse(msg.data);
      if (chunk.error) throw new ProviderError(`Stream error: ${chunk.error.message ?? msg.data}`, undefined, true);
      if (chunk.usage) {
        usage.inputTokens = chunk.usage.prompt_tokens ?? 0;
        usage.outputTokens = chunk.usage.completion_tokens ?? 0;
        usage.cacheReadTokens = chunk.usage.prompt_tokens_details?.cached_tokens;
      }
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta ?? {};
      if (delta.content) yield { type: "text", delta: delta.content };
      for (const tc of delta.tool_calls ?? []) {
        const idx = tc.index ?? calls.size;
        let c = calls.get(idx);
        if (!c) calls.set(idx, (c = { id: "", name: "", args: "" }));
        if (tc.id) c.id = tc.id;
        if (tc.function?.name) c.name += tc.function.name;
        if (tc.function?.arguments) {
          c.args += typeof tc.function.arguments === "string" ? tc.function.arguments : JSON.stringify(tc.function.arguments);
        }
      }
      if (choice.finish_reason) finish = choice.finish_reason;
    }

    if (!sawDone && !finish) throw cutOff();

    const ordered = [...calls.entries()].sort(([a], [b]) => a - b);
    for (const [i, c] of ordered) {
      const call: ToolCallPart = {
        type: "tool_call",
        id: c.id || `call_${Date.now().toString(36)}_${i}`,
        name: c.name,
        input: parseToolArgs(c.args),
      };
      yield { type: "tool_call", call };
    }
    // Ollama reports "stop" even when it returned tool calls
    const stopReason: StopReason = calls.size ? "tool_use" : mapFinish(finish);
    yield { type: "done", stopReason, usage };
  }
}

function mapFinish(reason: string | undefined): StopReason {
  switch (reason) {
    case "stop":
      return "end_turn";
    case "tool_calls":
    case "function_call":
      return "tool_use";
    case "length":
      return "max_tokens";
    default:
      return "other";
  }
}

function toOpenAIMessages(messages: Message[]): unknown[] {
  const out: unknown[] = [];
  for (const m of messages) {
    if (m.role === "assistant") {
      const text = m.content.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("");
      const toolCalls = m.content.flatMap((p) =>
        p.type === "tool_call"
          ? [{ id: p.id, type: "function", function: { name: p.name, arguments: JSON.stringify(p.input ?? {}) } }]
          : [],
      );
      out.push({ role: "assistant", content: text || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) });
    } else {
      // tool results must directly follow the assistant turn
      for (const p of m.content) {
        if (p.type === "tool_result") {
          out.push({ role: "tool", tool_call_id: p.id, content: p.isError ? `Error: ${p.content}` : p.content });
        }
      }
      const text = m.content.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n");
      if (text) out.push({ role: "user", content: text });
    }
  }
  return out;
}
