import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { Checkpoints } from "../src/session/checkpoints.js";
import { tempDir } from "./helpers.js";

function project() {
  const cwd = tempDir();
  const store = new Checkpoints(cwd, join(tempDir(), "checkpoints"));
  const write = (p: string, s: string) => {
    mkdirSync(join(cwd, p, ".."), { recursive: true });
    writeFileSync(join(cwd, p), s);
  };
  const read = (p: string) => readFileSync(join(cwd, p), "utf8");
  return { cwd, store, write, read };
}

test("restore brings back modified and deleted files and removes new ones", async () => {
  const { cwd, store, write, read } = project();
  write("src/app.ts", "v1\n");
  write("README.md", "readme\n");
  const cp = (await store.create("before turn"))!;
  assert.match(cp, /^[0-9a-f]{40}$/);

  write("src/app.ts", "v2\n");
  rmSync(join(cwd, "README.md"));
  write("src/new/extra.ts", "new\n");

  const changed = await store.restore(cp);
  assert.deepEqual(changed.sort(), ["README.md", "src/app.ts", "src/new/extra.ts"]);
  assert.equal(read("src/app.ts"), "v1\n");
  assert.equal(read("README.md"), "readme\n");
  assert.equal(existsSync(join(cwd, "src/new/extra.ts")), false);
});

test("line endings survive byte-for-byte, whatever the project's .gitattributes say", async () => {
  const { store, write, read } = project();
  write(".gitattributes", "* text=auto eol=crlf\n");
  write("lf.txt", "a\nb\n");
  write("crlf.txt", "a\r\nb\r\n");
  const cp = (await store.create("cp"))!;
  write("lf.txt", "changed\n");
  write("crlf.txt", "changed\n");
  await store.restore(cp);
  assert.equal(read("lf.txt"), "a\nb\n");
  assert.equal(read("crlf.txt"), "a\r\nb\r\n");
});

test("dependencies and build output are never touched", async () => {
  const { cwd, store, write } = project();
  write("index.js", "1\n");
  const cp = (await store.create("cp"))!;
  write("node_modules/react/index.js", "lib\n");
  write("dist/bundle.js", "built\n");
  write("index.js", "2\n");
  const changed = await store.restore(cp);
  assert.deepEqual(changed, ["index.js"]);
  assert.ok(existsSync(join(cwd, "node_modules/react/index.js")));
  assert.ok(existsSync(join(cwd, "dist/bundle.js")));
});

test("respects the project's .gitignore and leaves its own .git alone", async () => {
  const { cwd, store, write } = project();
  write(".gitignore", "secrets.env\n");
  write(".git/HEAD", "ref: refs/heads/main\n");
  write("a.txt", "1\n");
  const cp = (await store.create("cp"))!;
  write("secrets.env", "KEY=1\n");
  write("a.txt", "2\n");
  assert.deepEqual(await store.restore(cp), ["a.txt"]);
  assert.ok(existsSync(join(cwd, "secrets.env")));
  assert.equal(readFileSync(join(cwd, ".git/HEAD"), "utf8"), "ref: refs/heads/main\n");
});

test("nothing to restore when nothing changed", async () => {
  const { store, write } = project();
  write("a.txt", "1\n");
  const cp = (await store.create("cp"))!;
  assert.deepEqual(await store.restore(cp), []);
});
