import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { Agent } from "../src/agent/agent.js";
import { Permissions } from "../src/agent/permissions.js";
import { AnthropicProvider } from "../src/providers/anthropic.js";
import { OpenAIProvider } from "../src/providers/openai.js";
import { DEFAULT_TOOLS, ToolRegistry } from "../src/tools/index.js";
import { GeminiProvider } from "../src/providers/gemini.js";
import { detectShell } from "../src/tools/shell.js";
import type { Provider } from "../src/types.js";
import { mockSSEServer, tempDir } from "./helpers.js";

function makeAgent(provider: Provider, cwd: string, permissions = new Permissions("auto", async () => "allow")) {
  return new Agent({ provider, tools: new ToolRegistry(), permissions, system: "test", cwd, shell: detectShell() });
}

const writeArgs = JSON.stringify({ path: "hello.txt", content: "hi there\n" });

test("OpenAI-compatible: streamed tool call → tool runs → final answer", async () => {
  const chunk = (delta: unknown, finish: string | null = null) => ({ choices: [{ index: 0, delta, finish_reason: finish }] });
  const server = await mockSSEServer([
    [
      chunk({ role: "assistant", content: "Creating the file." }),
      // Arguments split across chunks, as real servers stream them.
      chunk({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "write_file", arguments: writeArgs.slice(0, 10) } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: writeArgs.slice(10) } }] }),
      chunk({}, "tool_calls"),
      { choices: [], usage: { prompt_tokens: 100, completion_tokens: 20 } },
      "[DONE]",
    ],
    [chunk({ content: "Done!" }), chunk({}, "stop"), "[DONE]"],
  ]);
  try {
    const cwd = tempDir();
    const agent = makeAgent(new OpenAIProvider({ model: "mock", baseUrl: server.url }), cwd);
    let text = "";
    await agent.run("make hello.txt", { onText: (d) => (text += d) });

    assert.equal(readFileSync(join(cwd, "hello.txt"), "utf8"), "hi there\n");
    assert.equal(text, "Creating the file.Done!");
    assert.equal(agent.totalUsage.inputTokens, 100);

    // Second request must carry the tool result as an OpenAI `tool` message right after the assistant call.
    const msgs = server.requests[1].messages;
    assert.deepEqual(msgs.map((m: any) => m.role), ["system", "user", "assistant", "tool"]);
    assert.equal(msgs[2].tool_calls[0].function.name, "write_file");
    assert.equal(msgs[3].tool_call_id, "call_1");
    assert.match(msgs[3].content, /Created hello.txt/);
    assert.equal(server.requests[0].tools.length, DEFAULT_TOOLS.length);
  } finally {
    server.close();
  }
});

test("Anthropic: input_json_delta assembly, tool_result round-trip, cache breakpoints", async () => {
  const server = await mockSSEServer([
    [
      { type: "message_start", message: { usage: { input_tokens: 50, output_tokens: 1, cache_read_input_tokens: 40 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "On it." } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "write_file", input: {} } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: writeArgs.slice(0, 7) } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: writeArgs.slice(7) } },
      { type: "content_block_stop", index: 1 },
      { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 30 } },
      { type: "message_stop" },
    ],
    [
      { type: "message_start", message: { usage: { input_tokens: 80, output_tokens: 1 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Done." } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } },
      { type: "message_stop" },
    ],
  ]);
  try {
    const cwd = tempDir();
    const agent = makeAgent(new AnthropicProvider({ model: "mock", apiKey: "test", baseUrl: server.url }), cwd);
    await agent.run("make hello.txt");

    assert.equal(readFileSync(join(cwd, "hello.txt"), "utf8"), "hi there\n");
    assert.deepEqual(agent.totalUsage, { inputTokens: 130, outputTokens: 33, cacheReadTokens: 40, cacheWriteTokens: 0, requests: 2 });

    const second = server.requests[1];
    assert.equal(second.system[0].cache_control.type, "ephemeral");
    const [, assistant, toolTurn] = second.messages;
    assert.deepEqual(assistant.content[1], { type: "tool_use", id: "toolu_1", name: "write_file", input: JSON.parse(writeArgs) });
    assert.equal(toolTurn.content[0].tool_use_id, "toolu_1");
    assert.equal(toolTurn.content.at(-1).cache_control.type, "ephemeral");
  } finally {
    server.close();
  }
});

test("Gemini: function call with thought signature round-trips", async () => {
  const args = JSON.parse(writeArgs);
  const server = await mockSSEServer([
    [
      { candidates: [{ content: { role: "model", parts: [{ text: "thinking...", thought: true }, { text: "Writing it." }] } }] },
      {
        candidates: [
          {
            content: { role: "model", parts: [{ functionCall: { name: "write_file", args }, thoughtSignature: "sig-abc" }] },
            finishReason: "STOP",
          },
        ],
        usageMetadata: { promptTokenCount: 120, cachedContentTokenCount: 20, candidatesTokenCount: 10, thoughtsTokenCount: 5 },
      },
    ],
    [{ candidates: [{ content: { role: "model", parts: [{ text: "Done." }] }, finishReason: "STOP" }] }],
  ]);
  try {
    const cwd = tempDir();
    const agent = makeAgent(new GeminiProvider({ model: "mock", apiKey: "k", baseUrl: server.url }), cwd);
    let text = "";
    await agent.run("make hello.txt", { onText: (d) => (text += d) });

    assert.equal(text, "Writing it.Done.", "thought parts are not shown");
    assert.equal(readFileSync(join(cwd, "hello.txt"), "utf8"), "hi there\n");
    assert.deepEqual(agent.totalUsage, { inputTokens: 100, outputTokens: 15, cacheReadTokens: 20, cacheWriteTokens: 0, requests: 2 });

    const req = server.requests[1];
    assert.equal(req.systemInstruction.parts[0].text, "test");
    assert.ok(req.tools[0].functionDeclarations[0].parametersJsonSchema);
    const [, model, user] = req.contents;
    assert.equal(model.role, "model");
    assert.deepEqual(model.parts[1], { functionCall: { name: "write_file", args }, thoughtSignature: "sig-abc" });
    assert.equal(user.parts[0].functionResponse.name, "write_file");
    assert.match(user.parts[0].functionResponse.response.output, /Created hello.txt/);
  } finally {
    server.close();
  }
});

test("denied tool call stops the turn and leaves a valid transcript", async () => {
  const chunk = (delta: unknown, finish: string | null = null) => ({ choices: [{ index: 0, delta, finish_reason: finish }] });
  const server = await mockSSEServer([
    [
      chunk({ tool_calls: [{ index: 0, id: "c1", function: { name: "bash", arguments: '{"command":"echo hi"}' } }] }),
      chunk({}, "tool_calls"),
      "[DONE]",
    ],
  ]);
  try {
    const agent = makeAgent(
      new OpenAIProvider({ model: "mock", baseUrl: server.url }),
      tempDir(),
      new Permissions("ask", async () => "deny"),
    );
    await agent.run("say hi");
    assert.equal(server.requests.length, 1, "should not call the model again after a denial");
    const last = agent.messages.at(-1)!;
    assert.equal(last.role, "user");
    assert.equal(last.content[0]!.type, "tool_result");
  } finally {
    server.close();
  }
});
