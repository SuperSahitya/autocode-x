import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { Agent } from "../src/agent/agent.js";
import { Permissions } from "../src/agent/permissions.js";
import { Checkpoints } from "../src/session/checkpoints.js";
import { SessionStore } from "../src/session/store.js";
import { ToolRegistry } from "../src/tools/index.js";
import { detectShell } from "../src/tools/shell.js";
import { ScriptedProvider, tempDir, textStep, toolStep } from "./helpers.js";

function makeAgent(steps: ConstructorParameters<typeof ScriptedProvider>[0]) {
  const cwd = tempDir();
  const agent = new Agent({
    provider: new ScriptedProvider(steps),
    tools: new ToolRegistry(),
    permissions: new Permissions("auto", async () => "allow"),
    system: "test",
    cwd,
    shell: detectShell(),
    checkpoints: new Checkpoints(cwd, join(tempDir(), "checkpoints")),
  });
  return { agent, cwd, read: () => readFileSync(join(cwd, "a.txt"), "utf8") };
}

test("undo reverts each turn's files and drops it from the conversation", async () => {
  const { agent, cwd, read } = makeAgent([
    toolStep("write_file", { path: "a.txt", content: "one\n" }),
    textStep("created"),
    toolStep("bash", { command: "echo two > a.txt" }),
    textStep("changed"),
  ]);
  await agent.run("create a.txt");
  const afterFirst = agent.messages.length;
  await agent.run("change it with a command");
  assert.equal(read().trim(), "two");
  assert.equal(agent.checkpoints.length, 2);

  let r = await agent.undo();
  assert.deepEqual(r?.files, ["a.txt"]);
  assert.equal(read(), "one\n");
  assert.equal(agent.messages.length, afterFirst);

  r = await agent.undo();
  assert.equal(r?.checkpoint.label, "create a.txt");
  assert.equal(existsSync(join(cwd, "a.txt")), false);
  assert.equal(agent.messages.length, 0);

  assert.equal(await agent.undo(), undefined);
});

test("read-only turns don't create checkpoints", async () => {
  const { agent } = makeAgent([toolStep("list_dir", {}), textStep("nothing here")]);
  await agent.run("look around");
  assert.equal(agent.checkpoints.length, 0);
});

test("undo skips read-only turns and reverts the last turn that changed files", async () => {
  const { agent, cwd } = makeAgent([
    toolStep("write_file", { path: "a.txt", content: "one\n" }),
    textStep("ok"),
    toolStep("read_file", { path: "a.txt" }),
    textStep("read it"),
  ]);
  await agent.run("create");
  await agent.run("read");
  const r = await agent.undo(); // the read-only second turn made no checkpoint, so this undoes the first
  assert.equal(r?.checkpoint.label, "create");
  assert.equal(existsSync(join(cwd, "a.txt")), false);
  assert.equal(agent.messages.length, 0, "both turns came after the checkpoint");
});

test("session store: save, load latest, load by id, list", () => {
  const store = new SessionStore(join(tempDir(), "sessions"));
  const cwd = tempDir();

  const empty = store.create(cwd, "gemini", "gemini-3.5-flash-lite");
  store.save(empty);
  assert.equal(store.load(cwd), undefined, "empty sessions aren't written");

  const a = store.create(cwd, "gemini", "gemini-3.5-flash-lite");
  a.messages.push({ role: "user", content: [{ type: "text", text: "build   a\ncounter" }] });
  store.save(a);
  const b = store.create(cwd, "groq", "openai/gpt-oss-120b");
  b.messages.push({ role: "user", content: [{ type: "text", text: "second" }] });
  store.save(b);
  store.create(tempDir(), "x", "y"); // another project, never saved

  assert.equal(store.load(cwd)?.id, b.id, "latest for the directory");
  const loaded = store.load(cwd, a.id)!;
  assert.equal(loaded.title, "build a counter");
  assert.equal(loaded.profile, "gemini");
  assert.deepEqual(loaded.messages, a.messages);
  assert.deepEqual(store.list(cwd).map((s) => s.id).sort(), [a.id, b.id].sort());
  assert.equal(store.load(cwd, "nope"), undefined);
  assert.equal(store.load(tempDir()), undefined, "other directories have no sessions");
});
