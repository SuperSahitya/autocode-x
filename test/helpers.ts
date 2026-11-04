import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext } from "../src/tools/types.js";
import type { ChatRequest, Provider, StreamEvent } from "../src/types.js";
import { ProcessManager } from "../src/tools/processes.js";
import { detectShell } from "../src/tools/shell.js";

export const tempDir = () => mkdtempSync(join(tmpdir(), "autocode-test-"));

export const makeCtx = (cwd: string): ToolContext => ({
  cwd,
  signal: new AbortController().signal,
  shell: detectShell(),
  fileState: new Map(),
  processes: new ProcessManager(),
  turn: 1,
});

/**
 * In-process provider that plays back one scripted list of events per model call.
 * A step can be a function, e.g. to block until aborted.
 */
export class ScriptedProvider implements Provider {
  readonly name = "scripted";
  readonly model = "scripted-1";
  calls = 0;
  /** what each call was sent, copied because the agent keeps changing its messages */
  readonly requests: ChatRequest[] = [];

  constructor(private readonly steps: (StreamEvent[] | ((signal?: AbortSignal) => AsyncIterable<StreamEvent>))[]) {}

  async listModels() {
    return [this.model];
  }

  async *stream(req: ChatRequest): AsyncGenerator<StreamEvent> {
    this.requests.push({ ...req, messages: structuredClone(req.messages) });
    const step = this.steps[this.calls++] ?? [{ type: "done", stopReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0 } }];
    if (typeof step === "function") return yield* step(req.signal);
    for (const ev of step) {
      await new Promise((r) => setTimeout(r, 5));
      yield ev;
    }
  }
}

export const textStep = (text: string, usage = { inputTokens: 10, outputTokens: 5 }): StreamEvent[] => [
  { type: "text", delta: text },
  { type: "done", stopReason: "end_turn", usage },
];

export const toolStep = (name: string, input: unknown, id = "t1"): StreamEvent[] => [
  { type: "tool_call", call: { type: "tool_call", id, name, input } },
  { type: "done", stopReason: "tool_use", usage: { inputTokens: 10, outputTokens: 5 } },
];

/** Serves fixed responses by path; counts hits so tests can check caching. */
export async function staticServer(routes: Record<string, { type: string; body: string; status?: number }>) {
  const hits: Record<string, number> = {};
  const server = createServer((req, res) => {
    const path = new URL(req.url!, "http://x").pathname;
    hits[path] = (hits[path] ?? 0) + 1;
    const route = routes[path];
    if (!route) return res.writeHead(404).end("not found");
    res.writeHead(route.status ?? 200, { "content-type": route.type }).end(route.body);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, hits, close: () => server.close() };
}

/**
 * A fake streaming LLM endpoint. Each request gets the next scripted list of SSE `data:` payloads;
 * request bodies are recorded so tests can assert what the adapter sent.
 */
export async function mockSSEServer(script: unknown[][]) {
  const requests: any[] = [];
  const server = createServer(async (req: IncomingMessage, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push(JSON.parse(body));
    const events = script[requests.length - 1] ?? [];
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const ev of events) {
      // Split each event across writes to exercise the parser's buffering.
      const line = `data: ${typeof ev === "string" ? ev : JSON.stringify(ev)}\n\n`;
      const mid = Math.floor(line.length / 2);
      res.write(line.slice(0, mid));
      res.write(line.slice(mid));
    }
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, requests, close: () => server.close() };
}
