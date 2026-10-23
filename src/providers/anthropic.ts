import type { ChatRequest, Message, Provider, StopReason, StreamEvent, Usage } from "../types.js";
import { ProviderError, getJSON, parseSSE, parseToolArgs, postWithRetry } from "./sse.js";

export interface AnthropicOptions {
  model: string;
  apiKey: string;
  baseUrl?: string;
}

export class AnthropicProvider implements Provider {
  readonly name = "anthropic";
  readonly model: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(opts: AnthropicOptions) {
    this.model = opts.model;
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? "https://api.anthropic.com").replace(/\/+$/, "");
  }

  async listModels(): Promise<string[]> {
    const res = await getJSON(`${this.baseUrl}/v1/models?limit=100`, this.headers());
    return res.data.map((m: { id: string }) => m.id);
  }

  private headers() {
    return { "x-api-key": this.apiKey, "anthropic-version": "2023-06-01" };
  }

  async *stream(req: ChatRequest): AsyncGenerator<StreamEvent> {
    const body = {
      model: this.model,
      max_tokens: req.maxTokens,
      stream: true,
      // tools render before system, so this caches both
      system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
      tools: req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })),
      messages: toAnthropicMessages(req.messages),
    };
    const res = await postWithRetry(`${this.baseUrl}/v1/messages`, this.headers(), body, req.signal);

    const usage: Usage = { inputTokens: 0, outputTokens: 0 };
    let stopReason: StopReason = "other";
    const blocks = new Map<number, { kind: "tool"; id: string; name: string; json: string } | { kind: "other" }>();

    for await (const msg of parseSSE(res.body!)) {
      const ev = JSON.parse(msg.data);
      switch (ev.type) {
        case "message_start": {
          const u = ev.message?.usage ?? {};
          usage.inputTokens = u.input_tokens ?? 0;
          usage.outputTokens = u.output_tokens ?? 0;
          usage.cacheReadTokens = u.cache_read_input_tokens ?? 0;
          usage.cacheWriteTokens = u.cache_creation_input_tokens ?? 0;
          break;
        }
        case "content_block_start": {
          const b = ev.content_block;
          blocks.set(ev.index, b.type === "tool_use" ? { kind: "tool", id: b.id, name: b.name, json: "" } : { kind: "other" });
          break;
        }
        case "content_block_delta": {
          const d = ev.delta;
          if (d.type === "text_delta") yield { type: "text", delta: d.text };
          else if (d.type === "input_json_delta") {
            const b = blocks.get(ev.index);
            if (b?.kind === "tool") b.json += d.partial_json;
          }
          break;
        }
        case "content_block_stop": {
          const b = blocks.get(ev.index);
          if (b?.kind === "tool") {
            yield { type: "tool_call", call: { type: "tool_call", id: b.id, name: b.name, input: parseToolArgs(b.json) } };
          }
          break;
        }
        case "message_delta": {
          if (ev.usage?.output_tokens != null) usage.outputTokens = ev.usage.output_tokens;
          stopReason = mapStop(ev.delta?.stop_reason);
          break;
        }
        case "error":
          throw new ProviderError(`Anthropic stream error: ${ev.error?.message ?? msg.data}`);
      }
    }
    yield { type: "done", stopReason, usage };
  }
}

function mapStop(reason: string | undefined): StopReason {
  switch (reason) {
    case "end_turn":
    case "stop_sequence":
      return "end_turn";
    case "tool_use":
      return "tool_use";
    case "max_tokens":
      return "max_tokens";
    default:
      return "other";
  }
}

function toAnthropicMessages(messages: Message[]): unknown[] {
  const out = messages.map((m) => ({
    role: m.role,
    content: m.content
      .filter((p) => !(p.type === "text" && p.text === ""))
      .map((p): Record<string, unknown> => {
        switch (p.type) {
          case "text":
            return { type: "text", text: p.text };
          case "tool_call":
            return { type: "tool_use", id: p.id, name: p.name, input: p.input };
          case "tool_result":
            return { type: "tool_result", tool_use_id: p.id, content: p.content, is_error: p.isError || undefined };
        }
      }),
  }));
  // cache the conversation prefix
  const last = out.at(-1)?.content.at(-1);
  if (last) last.cache_control = { type: "ephemeral" };
  return out;
}
