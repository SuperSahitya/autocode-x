import assert from "node:assert/strict";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { Agent } from "../src/agent/agent.js";
import { Permissions } from "../src/agent/permissions.js";
import { ToolRegistry } from "../src/tools/index.js";
import { RepoMap, rankFiles, repoMapTool } from "../src/tools/repomap.js";
import { detectShell } from "../src/tools/shell.js";
import { ScriptedProvider, makeCtx, tempDir, textStep } from "./helpers.js";

function project(files: Record<string, string>): string {
  const cwd = tempDir();
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(cwd, path)), { recursive: true });
    writeFileSync(join(cwd, path), content);
  }
  return cwd;
}

const APP = {
  "src/db.ts": `export class Database {\n  query(sql: string) {\n    return [];\n  }\n}\nexport function connectDatabase(url: string): Database {\n  return new Database();\n}\n`,
  "src/users.ts": `import { connectDatabase } from "./db";\nexport function findUser(id: string) {\n  return connectDatabase("x").query(id);\n}\n`,
  "src/orders.ts": `import { connectDatabase } from "./db";\nexport function findOrder(id: string) {\n  return connectDatabase("x").query(id);\n}\n`,
  "src/billing.ts": `import { findOrder } from "./orders";\nimport { connectDatabase } from "./db";\nexport function charge(id: string) {\n  connectDatabase("y");\n  return findOrder(id);\n}\n`,
  "src/leaf.ts": `export function unusedHelper() {\n  return 1;\n}\n`,
};

test("the most depended-on file comes first, with its signatures but no bodies", async () => {
  const map = await new RepoMap(project(APP)).build();
  assert.ok(map.startsWith("src/db.ts\n"), map);
  assert.match(map, /export class Database/);
  assert.match(map, /query\(sql: string\)/);
  assert.match(map, /export function connectDatabase\(url: string\): Database/);
  assert.doesNotMatch(map, /return \[\]/);
  assert.ok(map.indexOf("src/orders.ts") < map.indexOf("src/leaf.ts"), "used files rank above unused ones");
});

test("focus pulls in a file or a symbol that would otherwise rank low", async () => {
  const map = new RepoMap(project(APP));
  assert.ok((await map.build({ focus: ["leaf.ts"] })).startsWith("src/leaf.ts\n"));
  assert.ok((await map.build({ focus: ["unusedHelper"] })).startsWith("src/leaf.ts\n"));
  // billing depends on orders, so focusing on billing should lift orders above users
  const billing = await map.build({ focus: ["src/billing.ts"] });
  assert.ok(billing.indexOf("src/orders.ts") < billing.indexOf("src/users.ts"), billing);
});

test("the token budget is respected and says what was left out", async () => {
  const map = await new RepoMap(project(APP)).build({ maxTokens: 40 });
  assert.ok(map.length < 40 * 4 + 40, map);
  assert.match(map, /\.\.\. \d+ more files$/);
});

test("a small project gets no map", async () => {
  assert.equal(await new RepoMap(project({ "a.ts": "export const a = 1;\n", "b.ts": "export const b = 2;\n" })).build(), "");
});

test("every supported language loads and finds its symbols", async () => {
  const map = await new RepoMap(
    project({
      "a.ts": "export interface Shape {}\nexport type Size = number;\nexport enum Color { Red }\nexport abstract class Base {}\nexport const makeThing = () => 1;\n",
      "b.tsx": "export function Button() {\n  return <div />;\n}\n",
      "c.js": "class Widget {\n  render() {}\n}\nfunction setup() {}\nconst topLevel = 1;\n",
      "d.py": "MAX_SIZE = 10\nclass Loader:\n    def fetch(self):\n        return helper()\ndef helper():\n    pass\n",
      "e.go": "package main\ntype Server struct{}\nfunc (s Server) Serve() {}\nfunc main() {}\n",
      "f.rs": "struct Config {}\nenum Mode { A }\ntrait Runner { fn start(&self); }\nfn launch() {}\n",
      "G.java": "class Account {\n  void deposit() {}\n}\ninterface Bank {}\n",
    }),
  ).build({ maxTokens: 2000 });
  for (const expected of [
    "interface Shape", "type Size", "enum Color", "abstract class Base", "makeThing",
    "function Button",
    "class Widget", "render()", "function setup", "topLevel",
    "MAX_SIZE", "class Loader", "def fetch", "def helper",
    "type Server", "Serve()", "func main",
    "struct Config", "enum Mode", "trait Runner", "fn launch", "fn start",
    "class Account", "void deposit", "interface Bank",
  ]) {
    assert.ok(map.includes(expected), `missing ${expected} in:\n${map}`);
  }
});

test("broken syntax doesn't stop the rest of the file being mapped", async () => {
  const map = await new RepoMap(
    project({ ...APP, "src/broken.ts": "export function works() {\n  return 1;\n}\nfunction ( {{{\nexport function alsoWorks() {}\n" }),
  ).build({ maxTokens: 2000 });
  assert.match(map, /function works/);
});

test("TypeScript generics that look like JSX don't lose what comes after them", async () => {
  const map = await new RepoMap(
    project({
      ...APP,
      "src/generics.ts": [
        "export const identity = <T>(value: T) => value;",
        "export function afterArrow() {}",
        "export class Later<T> {",
        "  method(): T[] {",
        "    return [];",
        "  }",
        "}",
        "",
      ].join("\n"),
    }),
  ).build({ focus: ["generics.ts"], maxTokens: 2000 });
  assert.match(map, /identity/);
  assert.match(map, /afterArrow/);
  assert.match(map, /class Later/);
});

test("an old-style <T>x cast only costs the symbols after it in that file", async () => {
  const map = await new RepoMap(
    project({ ...APP, "src/old.ts": "export function beforeCast() {}\nconst cast = <string>someValue;\nexport function afterCast() {}\n" }),
  ).build({ focus: ["old.ts"], maxTokens: 2000 });
  assert.match(map, /beforeCast/);
  assert.doesNotMatch(map, /afterCast/);
  assert.match(map, /connectDatabase/, "other files are unaffected");
});

test("test files stay out of the map unless focused on", async () => {
  const tests = {
    "test/db.test.ts": `import { connectDatabase } from "../src/db";\nfunction checkConnection() {\n  connectDatabase("x");\n}\n`,
    "src/orders.spec.ts": `export function specHelper() {}\n`,
    "tests/test_thing.py": `def test_thing():\n    pass\n`,
  };
  const map = new RepoMap(project({ ...APP, ...tests }));
  const plain = await map.build({ maxTokens: 2000 });
  assert.doesNotMatch(plain, /checkConnection|specHelper|test_thing/);
  assert.match(await map.build({ focus: ["test/db.test.ts"], maxTokens: 2000 }), /checkConnection/);
  assert.match(await map.build({ focus: ["checkConnection"], maxTokens: 2000 }), /test\/db\.test\.ts/);
});

test("files ignored by git and unparseable files are skipped", async () => {
  const cwd = project({ ...APP, ".gitignore": "generated/\n", "generated/huge.ts": "export function hiddenThing() {}\n", "notes.md": "# hello\n" });
  mkdirSync(join(cwd, ".git"));
  const map = await new RepoMap(cwd).build({ maxTokens: 2000 });
  assert.doesNotMatch(map, /hiddenThing|notes\.md/);
});

test("only changed files are parsed again", async () => {
  const cwd = project(APP);
  const map = new RepoMap(cwd);
  await map.build({ maxTokens: 2000 });

  // same mtime, so the old parse is reused even though the content differs
  const path = join(cwd, "src/leaf.ts");
  const time = new Date(Date.now() - 60_000);
  utimesSync(path, time, time);
  await map.build({ maxTokens: 2000 });
  writeFileSync(path, "export function renamedHelper() {}\n");
  utimesSync(path, time, time);
  assert.match(await map.build({ maxTokens: 2000 }), /unusedHelper/);

  writeFileSync(path, "export function renamedHelper() {}\n");
  assert.match(await map.build({ maxTokens: 2000 }), /renamedHelper/);
});

test("ranks stay a distribution and don't blow up on files with no links", () => {
  const empty = { symbols: [], refs: new Map<string, number>() };
  const rank = rankFiles(new Map([["a.ts", empty], ["b.ts", empty]]), () => false);
  const total = [...rank.values()].reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(total - 1) < 1e-9, String(total));
  assert.equal(rank.get("a.ts"), rank.get("b.ts"));
});

test("a name defined everywhere creates no links", () => {
  const defines = (name: string) => ({ symbols: [{ name, row: 0, line: "" }], refs: new Map<string, number>() });
  const files = new Map<string, { symbols: { name: string; row: number; line: string }[]; refs: Map<string, number> }>();
  for (let i = 0; i < 10; i++) files.set(`f${i}.ts`, defines("common"));
  files.set("user.ts", { symbols: [], refs: new Map([["common", 50]]) });
  const rank = rankFiles(files, () => false);
  assert.ok(Math.abs(rank.get("f0.ts")! - rank.get("user.ts")!) < 1e-9, "no file gained rank from it");
});

test("the repo_map tool reports when there's too little to map", async () => {
  const cwd = project({ "a.ts": "export const a = 1;\n" });
  assert.match(String(await repoMapTool.run({}, makeCtx(cwd))), /Too little source code/);
  const out = await repoMapTool.run({ focus: ["leaf.ts"] }, makeCtx(project(APP)));
  assert.ok(String(out).startsWith("src/leaf.ts"));
});

test("the map is worked out once and stays in the system prompt for later requests", async () => {
  let loads = 0;
  const provider = new ScriptedProvider([textStep("one"), textStep("two")]);
  const agent = new Agent({
    provider,
    tools: new ToolRegistry([]),
    permissions: new Permissions("auto", async () => "allow"),
    system: "base",
    cwd: tempDir(),
    shell: detectShell(),
    projectContext: async () => {
      loads++;
      return "# Repository map";
    },
  });
  await agent.run("first");
  await agent.run("second");
  assert.equal(loads, 1);
  assert.equal(provider.requests[0]!.system, "base\n\n# Repository map");
  assert.equal(provider.requests[1]!.system, provider.requests[0]!.system);
});

test("a map that fails to build doesn't stop the turn", async () => {
  const provider = new ScriptedProvider([textStep("still fine")]);
  const agent = new Agent({
    provider,
    tools: new ToolRegistry([]),
    permissions: new Permissions("auto", async () => "allow"),
    system: "base",
    cwd: tempDir(),
    shell: detectShell(),
    projectContext: async () => {
      throw new Error("grammar missing");
    },
  });
  await agent.run("go");
  assert.equal(provider.requests[0]!.system, "base");
  assert.deepEqual(agent.messages.at(-1)!.content, [{ type: "text", text: "still fine" }]);
});
