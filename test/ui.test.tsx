import assert from "node:assert/strict";
import { test } from "node:test";
import { render } from "ink-testing-library";
import { Agent } from "../src/agent/agent.js";
import { Permissions } from "../src/agent/permissions.js";
import { join } from "node:path";
import { Checkpoints } from "../src/session/checkpoints.js";
import { ToolRegistry } from "../src/tools/index.js";
import { detectShell } from "../src/tools/shell.js";
import type { StreamEvent } from "../src/types.js";
import { App, PermissionBridge, splitCompleted } from "../src/ui/app.js";
import { renderMarkdown } from "../src/ui/markdown.js";
import { stripAnsi } from "../src/util/text.js";
import { ScriptedProvider, tempDir, textStep, toolStep } from "./helpers.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(check: () => boolean, what: string, timeout = 5000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeout) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

function setup(steps: ConstructorParameters<typeof ScriptedProvider>[0], mode: "ask" | "auto" = "auto") {
  const cwd = tempDir();
  const bridge = new PermissionBridge();
  const permissions = new Permissions(mode, (req) => bridge.ask(req));
  const agent = new Agent({
    provider: new ScriptedProvider(steps),
    tools: new ToolRegistry(),
    permissions,
    system: "test",
    cwd,
    shell: detectShell(),
    checkpoints: new Checkpoints(cwd, join(tempDir(), "checkpoints")),
  });
  const ui = render(
    <App
      agent={agent}
      permissions={permissions}
      bridge={bridge}
      banner="autocode test"
      modelLabel={() => "scripted · scripted-1"}
      switchModel={(s) => s}
    />,
  );
  // everything written so far, static scrollback included
  const screen = () => stripAnsi(ui.frames.join("\n"));
  const type = async (text: string) => {
    ui.stdin.write(text);
    await sleep(30);
  };
  return { ui, agent, screen, type };
}

test("markdown renders headings, lists, code and tables without raw syntax", () => {
  const out = stripAnsi(
    renderMarkdown("## Setup\n\n- run `npm i`\n- [x] done\n\n```ts\nconst a = 1;\n```\n\n| a | b |\n|---|--:|\n| x | 10 |"),
  );
  assert.match(out, /^Setup/);
  assert.match(out, /• run npm i/);
  assert.match(out, /✔ done/);
  assert.match(out, /│ const a = 1;/);
  assert.match(out, /a │  b\n──┼───\nx │ 10/);
  assert.doesNotMatch(out, /##|```|\*\*/);
});

test("splitCompleted never splits inside an open code fence", () => {
  assert.deepEqual(splitCompleted("para one\n\npara two"), ["para one", "para two"]);
  assert.deepEqual(splitCompleted("intro\n\n```js\nconst a = 1;\n\nconst b = 2;"), ["intro", "```js\nconst a = 1;\n\nconst b = 2;"]);
  assert.deepEqual(splitCompleted("no break yet"), ["", "no break yet"]);
});

test("a turn streams markdown and shows the tool call with live output", async () => {
  const script = "console.log('step one'); setTimeout(() => console.log('step two'), 300)";
  const { ui, screen, type } = setup([
    [{ type: "text", delta: "I'll run **it**." }, ...toolStep("bash", { command: `node -e "${script}"` })],
    textStep("All done:\n\n- ran the script"),
  ]);
  try {
    await type("run the script");
    await type("\r");
    await waitFor(() => screen().includes("step one"), "live output");
    assert.match(screen(), /❯ run the script/);
    assert.match(screen(), /I'll run it\./);
    await waitFor(() => screen().includes("• ran the script"), "final answer");
    assert.match(screen(), /● bash\(node -e/);
    assert.match(screen(), /step two\n\s+\[exit code 0\]/);
  } finally {
    ui.unmount();
  }
});

test("permission prompt: denying stops the turn", async () => {
  const { ui, agent, screen, type } = setup([toolStep("bash", { command: "echo hi" })], "ask");
  try {
    await type("say hi");
    await type("\r");
    await waitFor(() => screen().includes("Run bash?"), "permission prompt");
    assert.match(screen(), /don't ask again for echo \*/);
    await sleep(100); // the prompt subscribes to keys just after it first renders
    await type("n");
    await waitFor(() => screen().includes("The user denied"), "denial");
    const last = agent.messages.at(-1)!;
    assert.equal(last.content[0]!.type, "tool_result");
  } finally {
    ui.unmount();
  }
});

test("esc interrupts a running turn", async () => {
  const hang = async function* (signal?: AbortSignal): AsyncGenerator<StreamEvent> {
    yield { type: "text", delta: "Working on it" };
    await new Promise((_, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted"))));
  };
  const { ui, screen, type } = setup([hang]);
  try {
    await type("long task");
    await type("\r");
    await waitFor(() => screen().includes("esc to interrupt"), "running state");
    await type("\u001b");
    await waitFor(() => screen().includes("Interrupted"), "interrupt message");
  } finally {
    ui.unmount();
  }
});

test("slash commands and input editing", async () => {
  const { ui, screen, type } = setup([]);
  try {
    await type("/he");
    assert.match(screen(), /\/help/, "command hints");
    await type("\t");
    await type("\r");
    await waitFor(() => screen().includes("show or switch"), "help text");

    await type("/yolo\r");
    await waitFor(() => screen().includes("Auto-approve off"), "yolo toggle");

    await type("helo");
    await type("\u001b[D"); // left arrow
    await type("l");
    await type("\u007f\u007f"); // backspace twice
    assert.match(stripAnsi(ui.lastFrame()!), /❯ heo/);
  } finally {
    ui.unmount();
  }
});

test("/undo reverts the last turn's files", async () => {
  const { ui, agent, screen, type } = setup([toolStep("write_file", { path: "made.txt", content: "x\n" }), textStep("Made it.")]);
  try {
    await type("make a file");
    await type("\r");
    await waitFor(() => screen().includes("Made it."), "turn to finish");
    await type("/undo");
    await type("\r");
    await waitFor(() => screen().includes("Undid"), "undo message");
    assert.match(screen(), /Undid "make a file"\. Restored 1 file: made\.txt/);
    assert.equal(agent.messages.length, 0);
  } finally {
    ui.unmount();
  }
});

test("a resumed session replays its transcript", async () => {
  const bridge = new PermissionBridge();
  const permissions = new Permissions("auto", (req) => bridge.ask(req));
  const agent = new Agent({
    provider: new ScriptedProvider([]),
    tools: new ToolRegistry(),
    permissions,
    system: "test",
    cwd: tempDir(),
    shell: detectShell(),
  });
  agent.load({
    messages: [
      { role: "user", content: [{ type: "text", text: "earlier question" }] },
      { role: "assistant", content: [{ type: "text", text: "Looking." }, { type: "tool_call", id: "c1", name: "read_file", input: { path: "src/app.ts" } }] },
      { role: "user", content: [{ type: "tool_result", id: "c1", content: "1\tconst a = 1;" }] },
      { role: "assistant", content: [{ type: "text", text: "It defines **a**." }] },
    ],
    usage: { inputTokens: 1200, outputTokens: 300 },
    checkpoints: [],
  });
  const ui = render(
    <App agent={agent} permissions={permissions} bridge={bridge} banner="b" modelLabel={() => "m"} switchModel={(s) => s} />,
  );
  try {
    await sleep(100);
    const out = stripAnsi(ui.frames.join("\n"));
    assert.match(out, /❯ earlier question/);
    assert.match(out, /● read_file\(src\/app\.ts\)\n\s+⎿ Read 1 line/);
    assert.match(out, /It defines a\./);
    assert.match(out, /Resumed session/);
    assert.match(out, /↑1\.2k ↓300/);
  } finally {
    ui.unmount();
  }
});
