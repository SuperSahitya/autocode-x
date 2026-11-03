import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { Agent } from "../src/agent/agent.js";
import { Permissions } from "../src/agent/permissions.js";
import { AnthropicProvider } from "../src/providers/anthropic.js";
import { GeminiProvider } from "../src/providers/gemini.js";
import { OpenAIProvider } from "../src/providers/openai.js";
import { PacedProvider } from "../src/providers/pace.js";
import { ProviderError, parseSSE, postWithRetry, retryHint } from "../src/providers/sse.js";
import { ToolRegistry } from "../src/tools/index.js";
import { detectShell } from "../src/tools/shell.js";
import type { StreamEvent } from "../src/types.js";
import { ScriptedProvider, mockSSEServer, tempDir, textStep } from "./helpers.js";

/** Answers each request with the next scripted status and body. */
async function statusServer(script: { status: number; body?: string; headers?: Record<string, string> }[]) {
  let hits = 0;
  const server = createServer((req, res) => {
    req.resume();
    const step = script[Math.min(hits++, script.length - 1)]!;
    res.writeHead(step.status, step.headers).end(step.body ?? "");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, hits: () => hits, close: () => server.close() };
}

test("retryHint reads each way a server says how long to wait", () => {
  assert.equal(retryHint("7", ""), 7000);
  assert.equal(retryHint(null, '{"details":[{"retryDelay": "34s"}]}'), 34_000);
  assert.equal(retryHint(null, "Please try again in 7.5s."), 7500);
  assert.equal(retryHint(null, "Please try again in 1m2s."), 62_000);
  assert.equal(retryHint(null, "Please try again in 250ms."), 250);
  assert.equal(retryHint(null, "slow down"), undefined);
  const inTwoSeconds = new Date(Date.now() + 2000).toUTCString();
  assert.ok(retryHint(inTwoSeconds, "")! <= 2000);
});

test("a 429 waits for the delay in the body, then succeeds", async () => {
  const body = JSON.stringify({ error: { code: 429, message: "slow down", details: [{ retryDelay: "1s" }] } });
  const server = await statusServer([{ status: 429, body }, { status: 200, body: "ok" }]);
  const notices: string[] = [];
  const start = Date.now();
  try {
    const res = await postWithRetry(server.url, {}, {}, { onRetry: (m) => notices.push(m) });
    assert.equal(await res.text(), "ok");
    assert.ok(Date.now() - start >= 1000, "waited as long as the server asked");
    assert.equal(server.hits(), 2);
    assert.match(notices[0]!, /Rate limited, retrying in 2s/);
  } finally {
    server.close();
  }
});

test("a used-up daily quota fails on the first request", async () => {
  const body = JSON.stringify({ error: { code: 429, message: "quota", details: [{ quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier" }, { retryDelay: "1s" }] } });
  const server = await statusServer([{ status: 429, body }]);
  try {
    await assert.rejects(postWithRetry(server.url, {}, {}), /Quota used up/);
    assert.equal(server.hits(), 1);
  } finally {
    server.close();
  }
});

test("a wait longer than two minutes fails instead of hanging", async () => {
  const server = await statusServer([{ status: 429, headers: { "retry-after": "3600" } }]);
  try {
    await assert.rejects(postWithRetry(server.url, {}, {}), /Rate limited for another 3600s/);
    assert.equal(server.hits(), 1);
  } finally {
    server.close();
  }
});

test("other client errors aren't retried and show the API's message", async () => {
  const server = await statusServer([{ status: 400, body: JSON.stringify({ error: { message: "bad schema" } }) }]);
  try {
    await assert.rejects(postWithRetry(server.url, {}, {}), /HTTP 400: bad schema/);
    assert.equal(server.hits(), 1);
  } finally {
    server.close();
  }
});

test("a stalled stream fails instead of hanging", async () => {
  const silent = new ReadableStream<Uint8Array>({ start() {} });
  await assert.rejects(async () => {
    for await (const _ of parseSSE(silent, 20)) void _;
  }, /No data from the model/);
});

test("a stream cut off mid-response is retried without keeping the partial text", async () => {
  const dropped = async function* (): AsyncGenerator<StreamEvent> {
    yield { type: "text", delta: "half an ans" };
    throw new ProviderError("Connection lost: terminated", undefined, true);
  };
  const provider = new ScriptedProvider([dropped, textStep("the full answer")]);
  const agent = new Agent({
    provider,
    tools: new ToolRegistry([]),
    permissions: new Permissions("auto", async () => "allow"),
    system: "test",
    cwd: tempDir(),
    shell: detectShell(),
  });
  const notices: string[] = [];
  await agent.run("hi", { onNotice: (m) => notices.push(m) });

  assert.equal(provider.calls, 2);
  assert.deepEqual(agent.messages.at(-1), { role: "assistant", content: [{ type: "text", text: "the full answer" }] });
  assert.equal(agent.messages.length, 2);
  assert.equal(agent.totalUsage.requests, 2);
  assert.match(notices[0]!, /Connection lost: terminated Retrying \(1\/3\)/);
});

test("a stream that keeps failing gives up and surfaces the error", async () => {
  const dropped = async function* (): AsyncGenerator<StreamEvent> {
    throw new ProviderError("Connection lost", undefined, true);
  };
  const provider = new ScriptedProvider([dropped, dropped, dropped, dropped, dropped]);
  const agent = new Agent({
    provider,
    tools: new ToolRegistry([]),
    permissions: new Permissions("auto", async () => "allow"),
    system: "test",
    cwd: tempDir(),
    shell: detectShell(),
  });
  await assert.rejects(agent.run("hi"), /Connection lost/);
  assert.equal(provider.calls, 4, "the first try and three retries");
});

test("pacing holds a request back until the window has room", async () => {
  let clock = 0;
  const inner = new ScriptedProvider([textStep("a"), textStep("b")]);
  const paced = new PacedProvider(inner, 1, () => clock);
  const notices: string[] = [];
  const drain = async () => {
    for await (const _ of paced.stream({
      system: "",
      messages: [],
      tools: [],
      maxTokens: 1,
      onWait: (m) => {
        notices.push(m);
        clock = 60_000;
      },
    })) void _;
  };
  await drain();
  assert.equal(notices.length, 0);
  clock = 59_950; // 50ms left in the window
  await drain();
  assert.match(notices[0]!, /Pacing to 1 requests a minute, waiting 1s/);
  assert.equal(inner.calls, 2);
});

test("a stream that closes before the model finishes counts as dropped, not as the full answer", async () => {
  const partial: [string, unknown, (url: string) => { stream(req: any): AsyncIterable<StreamEvent> }][] = [
    ["openai", { choices: [{ index: 0, delta: { content: "half an ans" }, finish_reason: null }] }, (url) => new OpenAIProvider({ model: "m", baseUrl: url })],
    ["anthropic", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "half an ans" } }, (url) => new AnthropicProvider({ model: "m", apiKey: "k", baseUrl: url })],
    ["gemini", { candidates: [{ content: { role: "model", parts: [{ text: "half an ans" }] } }] }, (url) => new GeminiProvider({ model: "m", apiKey: "k", baseUrl: url })],
  ];
  for (const [name, event, create] of partial) {
    const server = await mockSSEServer([[event]]);
    const read = async () => {
      for await (const _ of create(server.url).stream({ system: "s", messages: [], tools: [], maxTokens: 10 }));
    };
    await assert.rejects(read, (err: ProviderError) => err.retryable && /cut off/.test(err.message), name);
    server.close();
  }
});

test("a malformed Gemini response can be repeated, but a safety block can't", async () => {
  const server = await mockSSEServer([[{ candidates: [{ finishReason: "MALFORMED_RESPONSE" }] }], [{ candidates: [{ finishReason: "SAFETY" }] }]]);
  const read = async () => {
    for await (const _ of new GeminiProvider({ model: "m", apiKey: "k", baseUrl: server.url }).stream({ system: "s", messages: [], tools: [], maxTokens: 10 }));
  };
  await assert.rejects(read, (err: ProviderError) => err.retryable);
  await assert.rejects(read, (err: ProviderError) => !err.retryable);
  server.close();
});
