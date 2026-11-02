import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { Agent, type AgentEvents } from "../src/agent/agent.js";
import { COMPACT_MARKER, TRIMMED_MARKER, buildSummaryMessage, findSplit, isContextOverflow, trimToolOutputs } from "../src/agent/context.js";
import { Permissions } from "../src/agent/permissions.js";
import { ProviderError } from "../src/providers/sse.js";
import { Checkpoints } from "../src/session/checkpoints.js";
import { ToolRegistry } from "../src/tools/index.js";
import { detectShell } from "../src/tools/shell.js";
import type { Message, StreamEvent } from "../src/types.js";
import { ScriptedProvider, tempDir, textStep } from "./helpers.js";

const big = (label: string, n = 2000) => `${label} `.repeat(n / (label.length + 1));

const userText = (text: string): Message => ({ role: "user", content: [{ type: "text", text }] });
const call = (id: string, name: string, input: unknown): Message => ({
  role: "assistant",
  content: [{ type: "tool_call", id, name, input }],
});
const result = (id: string, content: string): Message => ({ role: "user", content: [{ type: "tool_result", id, content }] });
const resultText = (m: Message) => (m.content[0] as { content: string }).content;

/** A tool step reporting that the request used this many tokens. */
const toolAt = (tokens: number, name: string, input: unknown, id: string): StreamEvent[] => [
  { type: "tool_call", call: { type: "tool_call", id, name, input } },
  { type: "done", stopReason: "tool_use", usage: { inputTokens: tokens, outputTokens: 5 } },
];

function makeAgent(steps: ConstructorParameters<typeof ScriptedProvider>[0], contextLimit = 10_000) {
  const cwd = tempDir();
  const provider = new ScriptedProvider(steps);
  const agent = new Agent({
    provider,
    tools: new ToolRegistry(),
    permissions: new Permissions("auto", async () => "allow"),
    system: "test",
    cwd,
    shell: detectShell(),
    contextLimit,
    checkpoints: new Checkpoints(cwd, join(tempDir(), "checkpoints")),
  });
  const notices: string[] = [];
  const events: AgentEvents = { onNotice: (m) => notices.push(m) };
  return { agent, provider, cwd, notices, events };
}

/** Every tool result must directly follow the call it answers, and roles must alternate. */
function assertWellFormed(messages: Message[]) {
  assert.equal(messages[0]?.role, "user");
  messages.forEach((m, i) => {
    if (i) assert.notEqual(m.role, messages[i - 1]!.role, `roles alternate at ${i}`);
    for (const p of m.content) {
      if (p.type !== "tool_result") continue;
      const before = messages[i - 1]!;
      assert.ok(before.content.some((c) => c.type === "tool_call" && c.id === p.id), `result ${p.id} follows its call`);
    }
  });
}

test("trimming drops old output, keeps recent output, and keeps the end of command output", () => {
  const messages: Message[] = [
    userText("go"),
    call("old", "read_file", { path: "a.ts" }),
    result("old", big("old-file")),
    call("cmd", "bash", { command: "npm test" }),
    result("cmd", `${big("noise")}\n# fail 3`),
  ];
  for (let i = 0; i < 6; i++) messages.push(call(`r${i}`, "read_file", { path: `f${i}.ts` }), result(`r${i}`, big("recent")));

  assert.ok(trimToolOutputs(messages) > 0);
  assert.ok(resultText(messages[2]!).startsWith(TRIMMED_MARKER));
  assert.match(resultText(messages[2]!), /read_file returned \d+ chars/);
  assert.ok(resultText(messages[4]!).startsWith(TRIMMED_MARKER));
  assert.match(resultText(messages[4]!), /# fail 3/, "a command can't be safely rerun, so its outcome stays");
  assert.ok(resultText(messages.at(-1)!).startsWith("recent"));
  assert.equal(trimToolOutputs(messages), 0, "nothing left to trim the second time");
});

test("trimming removes a read that a later identical read replaced, even if recent", () => {
  const messages: Message[] = [
    userText("go"),
    call("a", "read_file", { path: "a.ts" }),
    result("a", "version one of a.ts, not very long"),
    call("b", "read_file", { path: "a.ts" }),
    result("b", "version two of a.ts"),
  ];
  // short and recent, so only being out of date gets the first one trimmed; its stub is longer than it
  messages[2] = result("a", big("version-one", 400));
  trimToolOutputs(messages);
  assert.ok(resultText(messages[2]!).startsWith(TRIMMED_MARKER));
  assert.equal(resultText(messages[4]!), "version two of a.ts");
});

test("findSplit always cuts at an assistant message", () => {
  const messages: Message[] = [
    userText("first"),
    call("a", "read_file", {}),
    result("a", big("x", 4000)),
    call("b", "read_file", {}),
    result("b", big("y", 4000)),
    { role: "assistant", content: [{ type: "text", text: "done" }] },
  ];
  assert.equal(findSplit(messages, 0), 5);
  assert.equal(findSplit(messages, 1100), 3);
  assert.equal(findSplit(messages, 100_000), 3, "there must be something before the cut to summarize");
  assert.equal(findSplit(messages.slice(0, 2), 0), undefined);
});

test("the summary keeps requests and files through repeated compaction", () => {
  const first = buildSummaryMessage(
    [userText("add a  login\npage"), call("w", "write_file", { path: "src/login.ts", content: "x" }), result("w", "ok")],
    "Login page added.",
  );
  assert.match(first, /## User requests\n- add a login page/);
  assert.match(first, /## Files changed\n- src\/login\.ts/);
  assert.match(first, /Login page added\./);

  const second = buildSummaryMessage(
    [userText(first), call("e", "edit_file", { path: "src/app.ts" }), result("e", "ok"), userText("now add logout")],
    "",
  );
  assert.ok(second.startsWith(COMPACT_MARKER));
  assert.match(second, /- add a login page\n- now add logout/);
  assert.match(second, /- src\/login\.ts\n- src\/app\.ts/);
  assert.doesNotMatch(second, /## Summary/);
});

test("overflow errors are recognized across providers", () => {
  const overflow = (m: string, status = 400) => isContextOverflow(new ProviderError(m, status));
  assert.ok(overflow("HTTP 400: The input token count (1200000) exceeds the maximum number of tokens allowed"));
  assert.ok(overflow("HTTP 400: prompt is too long: 210000 tokens > 200000 maximum"));
  assert.ok(overflow("HTTP 400: This model's maximum context length is 128000 tokens"));
  assert.ok(!overflow("HTTP 400: bad schema"));
  assert.ok(!overflow("HTTP 429: too long a queue", 429));
  assert.ok(!isContextOverflow(new Error("context length")));
});

test("trimming alone avoids a summary request when it frees enough", async () => {
  const { agent, provider } = makeAgent([
    toolAt(100, "list_dir", {}, "t1"),
    toolAt(100, "list_dir", {}, "t2"),
    textStep("done"),
  ]);
  agent.messages.push(userText("earlier"));
  agent.messages.push(call("old", "read_file", { path: "a.ts" }), result("old", big("old", 24_000)));
  for (let i = 0; i < 6; i++) agent.messages.push(call(`r${i}`, "read_file", { path: `f${i}` }), result(`r${i}`, "short"));
  agent.messages.push({ role: "assistant", content: [{ type: "text", text: "ok" }] });

  await agent.run("next");
  assert.equal(provider.calls, 3, "no extra request was spent on a summary");
  assert.ok(provider.requests[0]!.messages.every((m) => m.content.every((p) => p.type !== "text" || !p.text.startsWith(COMPACT_MARKER))));
  assert.ok(resultText(provider.requests[0]!.messages[2]!).startsWith(TRIMMED_MARKER));
});

test("a long turn compacts partway through and stays well-formed", async () => {
  const { agent, provider, notices, events } = makeAgent([
    toolAt(1000, "write_file", { path: "made.txt", content: "x\n" }, "t1"),
    toolAt(9000, "read_file", { path: "made.txt" }, "t2"),
    textStep("Summary of the work."),
    textStep("All done."),
  ]);
  // plain text, so trimming can't help and only a summary can free the space
  agent.messages.push(userText(big("background", 16_000)));
  agent.messages.push({ role: "assistant", content: [{ type: "text", text: "noted" }] });

  await agent.run("make the file", events);

  assert.equal(provider.calls, 4);
  const summaryRequest = provider.requests[2]!;
  assert.equal(summaryRequest.tools.length, 0);
  assert.match(summaryRequest.messages[0]!.content[0]!.type === "text" ? summaryRequest.messages[0]!.content[0]!.text : "", /^User: background/);

  const after = provider.requests[3]!.messages;
  assertWellFormed(after);
  const first = after[0]!.content[0]!;
  assert.ok(first.type === "text" && first.text.startsWith(COMPACT_MARKER));
  assert.ok(first.type === "text" && first.text.includes("- make the file"), "the request in progress survives verbatim");
  assert.ok(first.type === "text" && first.text.includes("Summary of the work."));
  assert.ok(notices.some((n) => n.startsWith("Compacted the conversation")));
  assert.equal(agent.totalUsage.requests, 4, "the summary counts toward usage");
});

test("a failed summary still compacts, using the plain notes", async () => {
  const failing = async function* (): AsyncGenerator<StreamEvent> {
    throw new ProviderError("HTTP 500: nope", 500);
  };
  const { agent, provider, notices, events } = makeAgent([failing, textStep("carried on")]);
  agent.messages.push(userText(big("old request", 40_000)), { role: "assistant", content: [{ type: "text", text: "ok" }] });
  agent.messages.push(userText("second"), { role: "assistant", content: [{ type: "text", text: "ok" }] });

  await agent.run("third", events);

  assert.ok(notices.some((n) => n.includes("Couldn't summarize")));
  const first = provider.requests[1]!.messages[0]!.content[0]!;
  assert.ok(first.type === "text" && first.text.startsWith(COMPACT_MARKER));
  assert.ok(first.type === "text" && first.text.includes("- second"));
  assert.doesNotMatch(first.type === "text" ? first.text : "", /## Summary/);
});

test("an overflow error compacts once and retries, then gives up", async () => {
  const overflow = async function* (): AsyncGenerator<StreamEvent> {
    throw new ProviderError("HTTP 400: input token count exceeds the maximum", 400);
  };
  const { agent, provider } = makeAgent([overflow, textStep("short summary"), textStep("worked")], 1_000_000);
  agent.messages.push(userText("one"), { role: "assistant", content: [{ type: "text", text: "a" }] });
  agent.messages.push(userText("two"), { role: "assistant", content: [{ type: "text", text: "b" }] });
  await agent.run("three");
  assert.equal(provider.calls, 3);
  assert.deepEqual(agent.messages.at(-1)!.content, [{ type: "text", text: "worked" }]);

  const stuck = makeAgent([overflow, textStep("short summary"), overflow], 1_000_000);
  stuck.agent.messages.push(userText("one"), { role: "assistant", content: [{ type: "text", text: "a" }] });
  stuck.agent.messages.push(userText("two"), { role: "assistant", content: [{ type: "text", text: "b" }] });
  await assert.rejects(stuck.agent.run("three"), /exceeds the maximum/);
  assert.equal(stuck.provider.calls, 3);
});

test("/compact has nothing to do on a short conversation and spends no request", async () => {
  const { agent, provider } = makeAgent([textStep("hi")]);
  await agent.run("hello");
  assert.equal(await agent.compact(), undefined);
  assert.equal(provider.calls, 1);
});

test("undo still works after compaction", async () => {
  const { agent, cwd } = makeAgent([
    toolAt(100, "write_file", { path: "a.txt", content: "one\n" }, "w1"),
    textStep("made a"),
    toolAt(100, "write_file", { path: "b.txt", content: "two\n" }, "w2"),
    textStep("made b"),
    textStep("the summary"),
  ]);
  await agent.run("make a");
  await agent.run("make b");
  assert.ok(await agent.compact());
  const checkpoints = agent.checkpoints;
  assert.equal(checkpoints.length, 2);
  assert.equal(checkpoints[0]!.compacted, true, "the first turn is inside the summary");
  assert.equal(checkpoints[1]!.compacted, true, "and so is the start of the second");

  await agent.undo();
  assert.equal(existsSync(join(cwd, "b.txt")), false);
  assert.equal(readFileSync(join(cwd, "a.txt"), "utf8"), "one\n");
  assert.equal(agent.messages.length, 1);
  const parts = agent.messages[0]!.content;
  assert.ok(parts.at(-1)!.type === "text" && (parts.at(-1) as { text: string }).text.includes('before "make b"'));

  await agent.undo();
  assert.equal(existsSync(join(cwd, "a.txt")), false);
});

test("a checkpoint newer than the cut still drops just its own turn", async () => {
  const { agent, cwd } = makeAgent([
    textStep("reply one"),
    textStep("reply two"),
    textStep("the summary"),
    toolAt(100, "write_file", { path: "c.txt", content: "x\n" }, "w"),
    textStep("made c"),
  ]);
  await agent.run("one");
  await agent.run("two");
  assert.ok(await agent.compact());
  const before = agent.messages.length;
  await agent.run("make c");
  assert.ok(!agent.checkpoints[0]!.compacted);

  await agent.undo();
  assert.equal(existsSync(join(cwd, "c.txt")), false);
  assert.equal(agent.messages.length, before);
  assertWellFormed(agent.messages);
});

test("reported usage is preferred over estimating", async () => {
  const { agent } = makeAgent([[{ type: "text", delta: "hi" }, { type: "done", stopReason: "end_turn", usage: { inputTokens: 700, outputTokens: 5, cacheReadTokens: 300 } }]]);
  await agent.run("hello");
  assert.ok(agent.contextTokens() >= 1000 && agent.contextTokens() < 1010, String(agent.contextTokens()));
});
