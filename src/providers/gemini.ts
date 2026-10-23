import type { ChatRequest, Message, Provider, StopReason, StreamEvent, ToolCallPart, Usage } from "../types.js";
import { ProviderError, getJSON, parseSSE, postWithRetry } from "./sse.js";

export interface GeminiOptions {
  model: string;
  apiKey: string;
  baseUrl?: string;
}

// Accepted by the API in place of a real signature, for calls the model didn't produce
// (e.g. history carried over after switching from another provider).
const SKIP_SIGNATURE = "skip_thought_signature_validator";

export class GeminiProvider implements Provider {
  readonly name = "gemini";
  readonly model: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(opts: GeminiOptions) {
    this.model = opts.model;
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? "https://generativelanguage.googleapis.com").replace(/\/+$/, "");
  }

  async listModels(): Promise<string[]> {
    const res = await getJSON(`${this.baseUrl}/v1beta/models?pageSize=200`, { "x-goog-api-key": this.apiKey });
    return res.models
      .filter((m: { supportedGenerationMethods?: string[] }) => m.supportedGenerationMethods?.includes("generateContent"))
      .map((m: { name: string }) => m.name.replace(/^models\//, ""));
  }

  async *stream(req: ChatRequest): AsyncGenerator<StreamEvent> {
    const body: Record<string, unknown> = {
      systemInstruction: { parts: [{ text: req.system }] },
      contents: toGeminiContents(req.messages),
      generationConfig: { maxOutputTokens: req.maxTokens },
    };
    if (req.tools.length) {
      body.tools = [
        {
          functionDeclarations: req.tools.map((t) => ({
            name: t.name,
            description: t.description,
            parametersJsonSchema: t.parameters,
          })),
        },
      ];
    }
    const res = await postWithRetry(
      `${this.baseUrl}/v1beta/models/${this.model}:streamGenerateContent?alt=sse`,
      { "x-goog-api-key": this.apiKey },
      body,
      req.signal,
    );

    const usage: Usage = { inputTokens: 0, outputTokens: 0 };
    const calls: ToolCallPart[] = [];
    let finish: string | undefined;

    for await (const msg of parseSSE(res.body!)) {
      const chunk = JSON.parse(msg.data);
      if (chunk.error) throw new ProviderError(`Gemini error: ${chunk.error.message ?? msg.data}`);
      if (chunk.usageMetadata) {
        const u = chunk.usageMetadata;
        const cached = u.cachedContentTokenCount ?? 0;
        usage.inputTokens = (u.promptTokenCount ?? 0) - cached;
        usage.cacheReadTokens = cached;
        usage.outputTokens = (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0);
      }
      const candidate = chunk.candidates?.[0];
      if (!candidate) continue;
      for (const part of candidate.content?.parts ?? []) {
        if (part.thought) continue;
        if (part.functionCall) {
          const fc = part.functionCall;
          const meta: Record<string, string> = {};
          if (fc.id) meta.nativeId = fc.id;
          if (part.thoughtSignature) meta.thoughtSignature = part.thoughtSignature;
          calls.push({
            type: "tool_call",
            id: fc.id ?? `gemini_${Date.now().toString(36)}_${calls.length}`,
            name: fc.name,
            input: fc.args ?? {},
            meta,
          });
        } else if (part.text) {
          yield { type: "text", delta: part.text };
        }
      }
      if (candidate.finishReason) finish = candidate.finishReason;
    }

    for (const call of calls) yield { type: "tool_call", call };
    if (finish && !["STOP", "MAX_TOKENS"].includes(finish) && calls.length === 0) {
      throw new ProviderError(`Gemini stopped with ${finish}`);
    }
    const stopReason: StopReason = calls.length ? "tool_use" : finish === "MAX_TOKENS" ? "max_tokens" : "end_turn";
    yield { type: "done", stopReason, usage };
  }
}

function toGeminiContents(messages: Message[]): unknown[] {
  // functionResponse needs the function name, which our tool results don't carry
  const calls = new Map<string, ToolCallPart>();

  return messages.map((m) => {
    if (m.role === "assistant") {
      let first = true;
      const parts = m.content.flatMap((p): Record<string, unknown>[] => {
        if (p.type === "text") return p.text ? [{ text: p.text }] : [];
        calls.set(p.id, p);
        const part: Record<string, unknown> = {
          functionCall: { name: p.name, args: p.input ?? {}, ...(p.meta?.nativeId ? { id: p.meta.nativeId } : {}) },
        };
        // only the first call of a turn carries the signature
        const signature = p.meta?.thoughtSignature ?? (first ? SKIP_SIGNATURE : undefined);
        if (signature) part.thoughtSignature = signature;
        first = false;
        return [part];
      });
      return { role: "model", parts };
    }
    const parts = m.content.map((p) => {
      if (p.type === "text") return { text: p.text };
      const call = calls.get(p.id);
      return {
        functionResponse: {
          name: call?.name ?? "unknown",
          response: p.isError ? { error: p.content } : { output: p.content },
          ...(call?.meta?.nativeId ? { id: call.meta.nativeId } : {}),
        },
      };
    });
    return { role: "user", parts };
  });
}
