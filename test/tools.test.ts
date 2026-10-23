import assert from "node:assert/strict";
import { readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { commandPermissionKey } from "../src/tools/bash.js";
import { ToolRegistry } from "../src/tools/index.js";
import { makeCtx, tempDir } from "./helpers.js";

const registry = new ToolRegistry();

async function call(name: string, input: unknown, ctx = makeCtx(tempDir())) {
  const parsed = registry.parse({ type: "tool_call", id: "1", name, input });
  if ("error" in parsed) return { output: parsed.error, isError: true };
  return registry.execute(parsed.tool, parsed.input, ctx);
}

test("read_file numbers lines and pages with offset/limit", async () => {
  const ctx = makeCtx(tempDir());
  writeFileSync(join(ctx.cwd, "a.txt"), "one\ntwo\nthree\n");
  const r = await call("read_file", { path: "a.txt", offset: 2, limit: 1 }, ctx);
  assert.match(r.output, /^2\ttwo/);
  assert.match(r.output, /Showing lines 2-2 of 3/);
});

test("edit_file requires a prior read and rejects stale files", async () => {
  const ctx = makeCtx(tempDir());
  const file = join(ctx.cwd, "a.ts");
  writeFileSync(file, "const x = 1;\n");

  let r = await call("edit_file", { path: "a.ts", old_string: "1", new_string: "2" }, ctx);
  assert.equal(r.isError, true);
  assert.match(r.output, /hasn't been read/);

  await call("read_file", { path: "a.ts" }, ctx);
  utimesSync(file, new Date(), new Date(Date.now() + 5000)); // simulate an external change
  r = await call("edit_file", { path: "a.ts", old_string: "1", new_string: "2" }, ctx);
  assert.match(r.output, /modified since/);
});

test("edit_file enforces uniqueness and supports replace_all", async () => {
  const ctx = makeCtx(tempDir());
  const file = join(ctx.cwd, "a.ts");
  writeFileSync(file, "foo();\nfoo();\n");
  await call("read_file", { path: "a.ts" }, ctx);

  let r = await call("edit_file", { path: "a.ts", old_string: "foo", new_string: "bar" }, ctx);
  assert.match(r.output, /appears 2 times/);

  r = await call("edit_file", { path: "a.ts", old_string: "foo", new_string: "bar", replace_all: true }, ctx);
  assert.equal(r.isError, undefined);
  assert.equal(readFileSync(file, "utf8"), "bar();\nbar();\n");
  assert.ok(r.display?.includes("+bar();"));
});

test("edit_file preserves CRLF line endings", async () => {
  const ctx = makeCtx(tempDir());
  const file = join(ctx.cwd, "win.txt");
  writeFileSync(file, "line one\r\nline two\r\n");
  await call("read_file", { path: "win.txt" }, ctx);
  const r = await call("edit_file", { path: "win.txt", old_string: "one\nline two", new_string: "1\nline 2" }, ctx);
  assert.equal(r.isError, undefined, r.output);
  assert.equal(readFileSync(file, "utf8"), "line 1\r\nline 2\r\n");
});

test("write_file creates nested files and can then overwrite", async () => {
  const ctx = makeCtx(tempDir());
  let r = await call("write_file", { path: "src/deep/new.ts", content: "a\n" }, ctx);
  assert.match(r.output, /Created src\/deep\/new.ts/);
  // Written files count as seen, so an immediate overwrite is allowed.
  r = await call("write_file", { path: "src/deep/new.ts", content: "b\n" }, ctx);
  assert.match(r.output, /Overwrote/);
  assert.equal(readFileSync(join(ctx.cwd, "src/deep/new.ts"), "utf8"), "b\n");
});

test("glob and grep find files via ripgrep", async () => {
  const ctx = makeCtx(tempDir());
  writeFileSync(join(ctx.cwd, "x.ts"), "export const needle = 1;\n");
  writeFileSync(join(ctx.cwd, "y.md"), "nothing here\n");
  assert.equal((await call("glob", { pattern: "*.ts" }, ctx)).output, "x.ts");
  assert.match((await call("grep", { pattern: "needle" }, ctx)).output, /x\.ts/);
  assert.match((await call("grep", { pattern: "needle", output_mode: "content" }, ctx)).output, /:1:export const needle/);
  assert.equal((await call("grep", { pattern: "absent" }, ctx)).output, "No matches.");
});

test("bash returns output and exit code", async () => {
  let r = await call("bash", { command: "echo hello" });
  assert.match(r.output, /hello\n\[exit code 0\]/);
  r = await call("bash", { command: "exit 3" });
  assert.equal(r.isError, true);
  assert.match(r.output, /exit code 3/);
});

test("background process: start, read output, kill", async () => {
  const ctx = makeCtx(tempDir());
  try {
    const script = "console.log('ready'); setInterval(() => console.log('tick'), 100)";
    let r = await call("bash", { command: `node -e "${script}"`, run_in_background: true }, ctx);
    assert.match(r.output, /Started bg1/);
    assert.match(r.output, /ready/);
    assert.match(r.output, /bg1 running/);

    r = await call("bash_output", { id: "bg1", wait_ms: 2000 }, ctx);
    assert.match(r.output, /tick/);
    assert.doesNotMatch(r.output, /ready/, "only new output is returned");

    r = await call("kill_process", { id: "bg1" }, ctx);
    assert.match(r.output, /Killed bg1/);
    await new Promise((res) => setTimeout(res, 1000));
    assert.match((await call("bash_output", {}, ctx)).output, /bg1 exited/);
  } finally {
    ctx.processes.killAll();
  }
});

test("invalid arguments are reported back, not thrown", async () => {
  const r = await call("read_file", { nope: true });
  assert.equal(r.isError, true);
  assert.match(r.output, /Invalid arguments for read_file/);
});

test("bash permission keys scope 'always allow' narrowly", () => {
  assert.equal(commandPermissionKey("git status"), "bash:git status");
  assert.equal(commandPermissionKey("npm install --save zod"), "bash:npm install");
  assert.equal(commandPermissionKey("ls -la"), "bash:ls");
  assert.equal(commandPermissionKey("npm test && rm -rf /"), undefined);
});
