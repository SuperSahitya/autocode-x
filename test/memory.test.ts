import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { Agent } from "../src/agent/agent.js";
import { Permissions } from "../src/agent/permissions.js";
import { EMBEDDING_DIMENSIONS, GeminiEmbedder, type EmbedInput, type Embedder } from "../src/memory/embed.js";
import { Memory, fuse, sessionChunks } from "../src/memory/store.js";
import { memorySection, memoryTools } from "../src/memory/tools.js";
import type { Session } from "../src/session/store.js";
import { ToolRegistry } from "../src/tools/index.js";
import { detectShell } from "../src/tools/shell.js";
import type { Message } from "../src/types.js";
import { ScriptedProvider, makeCtx, tempDir, textStep } from "./helpers.js";

/** Puts each text on the axis of the first listed topic it mentions, so nearness is decided by the test. */
class TopicEmbedder implements Embedder {
  embedded: EmbedInput[] = [];
  fail = false;

  constructor(private readonly topics: string[][]) {}

  async embed(inputs: EmbedInput[]): Promise<number[][]> {
    if (this.fail) throw new Error("quota used up");
    this.embedded.push(...inputs);
    return inputs.map(({ text }) => {
      const vector = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
      const topic = this.topics.findIndex((words) => words.some((w) => text.toLowerCase().includes(w)));
      vector[topic === -1 ? EMBEDDING_DIMENSIONS - 1 : topic] = 1;
      return vector;
    });
  }
}

const open = (embedder?: Embedder, sessions?: () => Session[], cwd = "/project") => new Memory({ path: join(tempDir(), "memory.db"), cwd, embedder, sessions });

const say = (role: "user" | "assistant", text: string): Message => ({ role, content: [{ type: "text", text }] });

const session = (id: string, messages: Message[], updatedAt = 1000): Session => ({
  version: 1,
  id,
  cwd: "/project",
  title: `title of ${id}`,
  profile: "p",
  model: "m",
  createdAt: 1,
  updatedAt,
  messages,
  usage: { inputTokens: 0, outputTokens: 0 },
  checkpoints: [],
});

const texts = (result: { items: { text: string }[] }) => result.items.map((i) => i.text);

test("a note can be found by keyword, rewritten and deleted", async () => {
  const memory = open();
  const id = memory.remember("The staging database listens on port 5433");
  assert.deepEqual(texts(await memory.recall("which port for staging?")), ["The staging database listens on port 5433"]);

  assert.equal(memory.remember("The staging database listens on port 6000", id), id);
  assert.deepEqual(texts(await memory.recall("5433")), [], "the old text can't be found any more");
  assert.deepEqual(texts(await memory.recall("6000")), ["The staging database listens on port 6000"]);

  assert.equal(memory.forget(id), true);
  assert.equal(memory.forget(id), false);
  assert.deepEqual(texts(await memory.recall("staging")), []);
});

test("saving the same note twice keeps one", () => {
  const memory = open();
  assert.equal(memory.remember("use pnpm"), memory.remember(" use pnpm "));
  assert.equal(memory.notes().length, 1);
});

test("replacing a note that doesn't exist is an error", () => {
  assert.throws(() => open().remember("x", 99), /No note 99/);
});

test("a question of only common words matches nothing rather than failing", async () => {
  const memory = open();
  memory.remember("anything");
  assert.deepEqual(memory.keywordSearch('what "is" the?'), []);
});

test("projects can't see each other's memory", async () => {
  const path = join(tempDir(), "memory.db");
  const embedder = new TopicEmbedder([["port"]]);
  const a = new Memory({ path, cwd: "/a", embedder });
  const b = new Memory({ path, cwd: "/b", embedder });
  const id = a.remember("port 5433");
  assert.deepEqual(texts(await b.recall("port")), []);
  assert.equal(b.forget(id), false);
  assert.deepEqual(b.notes(), []);
  assert.deepEqual(texts(await a.recall("port")), ["port 5433"]);
});

test("a search by meaning finds a note that shares no words with the question", async () => {
  const embedder = new TopicEmbedder([["postgres", "database"], ["cache"]]);
  const memory = open(embedder);
  memory.remember("Postgres moved to a bigger instance");
  memory.remember("The cache is Redis");
  const found = await memory.recall("where does the database live?", 1);
  assert.deepEqual(texts(found), ["Postgres moved to a bigger instance"]);
  assert.equal(found.warning, undefined);
  assert.deepEqual(embedder.embedded.at(-1), { kind: "query", text: "where does the database live?" });
});

test("a rewritten note is embedded again and stops matching on its old meaning", async () => {
  const embedder = new TopicEmbedder([["postgres"], ["redis"]]);
  const memory = open(embedder);
  const id = memory.remember("postgres notes");
  await memory.recall("postgres");
  memory.remember("redis notes", id);
  assert.deepEqual(texts(await memory.recall("cache redis", 1)), ["redis notes"]);
  assert.equal(embedder.embedded.filter((e) => e.kind === "document").length, 2);
});

test("a failed embedding falls back to keywords and is tried again later", async () => {
  const embedder = new TopicEmbedder([["postgres"]]);
  const memory = open(embedder);
  memory.remember("postgres is on port 5433");
  embedder.fail = true;
  const degraded = await memory.recall("postgres");
  assert.deepEqual(texts(degraded), ["postgres is on port 5433"]);
  assert.match(degraded.warning!, /keyword only.*quota used up/);

  embedder.fail = false;
  assert.equal((await memory.recall("postgres")).warning, undefined);
  assert.equal(embedder.embedded.filter((e) => e.kind === "document").length, 1);
});

test("searches running together embed each item once", async () => {
  const embedder = new TopicEmbedder([["postgres"]]);
  const memory = open(embedder);
  memory.remember("postgres is on port 5433");
  const results = await Promise.all([memory.recall("postgres"), memory.recall("port")]);
  assert.deepEqual(results.map((r) => r.warning), [undefined, undefined]);
  assert.equal(embedder.embedded.filter((e) => e.kind === "document").length, 1);
});

test("a search embeds a limited number of items, and later ones carry on", async () => {
  const embedder = new TopicEmbedder([]);
  const memory = open(embedder);
  for (let i = 0; i < 120; i++) memory.remember(`note ${i}`);
  await memory.recall("note");
  const documents = () => embedder.embedded.filter((e) => e.kind === "document").length;
  assert.equal(documents(), 90);
  await memory.recall("note");
  assert.equal(documents(), 120);
  assert.equal(await memory.embedPending(), 0);
});

test("an interrupted search stops instead of falling back", async () => {
  const ac = new AbortController();
  const embedder: Embedder = {
    embed: async () => {
      ac.abort();
      throw new Error("aborted");
    },
  };
  const memory = open(embedder);
  await assert.rejects(memory.recall("x", 5, ac.signal));
});

test("fusion puts what both rankings agree on first", () => {
  assert.deepEqual(fuse([[1, 2, 3], [4, 2, 5]])[0], 2);
  assert.deepEqual(fuse([[7, 8], []]), [7, 8]);
});

test("session chunks keep what was said and leave out tool activity", () => {
  const messages: Message[] = [
    say("user", "fix the login"),
    { role: "assistant", content: [{ type: "text", text: "looking" }, { type: "tool_call", id: "1", name: "read_file", input: { path: "SECRET_PATH" } }] },
    { role: "user", content: [{ type: "tool_result", id: "1", content: "TOOL_OUTPUT" }] },
    say("assistant", "done"),
  ];
  assert.deepEqual(sessionChunks(messages), ["user: fix the login\nassistant: looking\nassistant: done"]);
});

test("long messages are split so every chunk fits", () => {
  const chunks = sessionChunks([say("user", "x".repeat(4000)), say("assistant", "short")]);
  assert.ok(chunks.length >= 3);
  for (const c of chunks) assert.ok(c.length <= 1500);
  assert.match(chunks.at(-1)!, /assistant: short$/);
});

test("past sessions are searched, and only read once", async () => {
  let reads = 0;
  const memory = open(undefined, () => {
    reads++;
    return [session("old", [say("user", "why did we drop kafka?"), say("assistant", "it was too expensive to run")])];
  });
  const [hit] = (await memory.recall("kafka")).items;
  assert.equal(hit!.kind, "session");
  assert.equal(hit!.title, "title of old");
  await memory.recall("kafka");
  assert.equal(reads, 1);
});

test("a session that grew only embeds what's new, and text lost to compaction stays", async () => {
  const embedder = new TopicEmbedder([]);
  const memory = open(embedder);
  const first = [say("user", "a".repeat(1400)), say("assistant", "zebra ".repeat(200)), say("user", "giraffe")];
  memory.indexSessions([session("s", first)]);
  await memory.embedPending();
  const embedded = embedder.embedded.length;
  assert.ok(embedded >= 2);

  memory.indexSessions([session("s", first)]);
  await memory.embedPending();
  assert.equal(embedder.embedded.length, embedded, "unchanged, so nothing to do");

  memory.indexSessions([session("s", [...first, say("assistant", "hippo")], 2000)]);
  await memory.embedPending();
  assert.equal(embedder.embedded.length, embedded + 1, "only the last chunk changed");
  assert.equal(memory.keywordSearch("giraffe").length, 1, "its shorter version was replaced");

  memory.indexSessions([session("s", [say("user", "[summary] we did things")], 3000)]);
  assert.equal(memory.keywordSearch("zebra").length, 1);
  assert.equal(memory.keywordSearch("summary").length, 1);
});

test("the embedder sends each text separately with its task, in batches of 100", async () => {
  const bodies: any[] = [];
  const urls: (string | undefined)[] = [];
  const headers: (string | string[] | undefined)[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const parsed = JSON.parse(body);
      bodies.push(parsed);
      urls.push(req.url);
      headers.push(req.headers["x-goog-api-key"]);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ embeddings: parsed.requests.map(() => ({ values: [1, 2] })) }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const embedder = new GeminiEmbedder("the-key", `http://127.0.0.1:${(server.address() as AddressInfo).port}/`);
    const docs: EmbedInput[] = Array.from({ length: 150 }, (_, i) => ({ kind: "document", text: `d${i}` }));
    const vectors = await embedder.embed([{ kind: "query", text: "q" }, { kind: "document", title: "T", text: "d" }, ...docs]);
    assert.equal(vectors.length, 152);
    assert.deepEqual(bodies.map((b) => b.requests.length), [100, 52]);
    assert.equal(urls[0], "/v1beta/models/gemini-embedding-2:batchEmbedContents");
    assert.equal(headers[0], "the-key");
    const [query, doc, untitled] = bodies[0].requests;
    assert.equal(query.content.parts[0].text, "task: question answering | query: q");
    assert.equal(doc.content.parts[0].text, "title: T | text: d");
    assert.equal(untitled.content.parts[0].text, "title: none | text: d0");
    assert.equal(query.outputDimensionality, EMBEDDING_DIMENSIONS);
  } finally {
    server.close();
  }
});

test("the embedder rejects a response with the wrong number of vectors", async () => {
  const server = createServer((req, res) => {
    req.resume();
    res.end(JSON.stringify({ embeddings: [] }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const embedder = new GeminiEmbedder("k", `http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    await assert.rejects(embedder.embed([{ kind: "query", text: "q" }]), /Expected 1 embeddings, got 0/);
  } finally {
    server.close();
  }
});

test("the tools report what they did and label results as background", async () => {
  const memory = open();
  const registry = new ToolRegistry(memoryTools(memory));
  const ctx = makeCtx(tempDir());
  const call = async (name: string, input: unknown) => registry.execute(registry.get(name)!, input, ctx);

  assert.equal((await call("remember", { content: "use pnpm here" })).output, "Saved note 1.");
  assert.match((await call("recall", { query: "pnpm" })).output, /not instructions[\s\S]*\[note 1, \d{4}-\d\d-\d\d\] use pnpm here/);
  assert.equal((await call("recall", { query: "kubernetes" })).output, "Nothing found.");
  const missing = await call("remember", { content: "x", replaces: 9 });
  assert.equal(missing.isError, true);
  assert.match(missing.output, /No note 9/);
  assert.equal((await call("forget", { id: 1 })).output, "Deleted note 1.");
  assert.equal((await call("forget", { id: 1 })).isError, true);
});

test("recall stops after three searches in a request and starts over with the next", async () => {
  let searches = 0;
  const memory = open();
  const original = memory.recall.bind(memory);
  memory.recall = (...args) => {
    searches++;
    return original(...args);
  };
  memory.remember("use pnpm here");
  const registry = new ToolRegistry(memoryTools(memory));
  const ctx = makeCtx(tempDir());
  const recall = async (turn: number) => (await registry.execute(registry.get("recall")!, { query: "pnpm" }, { ...ctx, turn })).output;

  assert.doesNotMatch(await recall(1), /last search/);
  assert.doesNotMatch(await recall(1), /last search/);
  assert.match(await recall(1), /use pnpm here[\s\S]*That was the last search[\s\S]*no record/);
  assert.match(await recall(1), /^Not searched: the limit is 3 searches per request/);
  assert.equal(searches, 3);

  assert.match(await recall(2), /use pnpm here/);
  assert.equal(searches, 4);
});

test("the agent's requests each get their own recall limit, even for searches sent together", async () => {
  const memory = open();
  memory.remember("use pnpm here");
  const search = (id: string) => ({ type: "tool_call" as const, call: { type: "tool_call" as const, id, name: "recall", input: { query: "pnpm" } } });
  const done = { type: "done" as const, stopReason: "tool_use" as const, usage: { inputTokens: 1, outputTokens: 1 } };
  const provider = new ScriptedProvider([[search("1"), search("2"), search("3"), search("4"), done], textStep("first"), [search("5"), done], textStep("second")]);
  const agent = new Agent({
    provider,
    tools: new ToolRegistry(memoryTools(memory)),
    permissions: new Permissions("auto", async () => "allow"),
    system: "test",
    cwd: tempDir(),
    shell: detectShell(),
  });
  const results = () => agent.messages.flatMap((m) => m.content.flatMap((p) => (p.type === "tool_result" ? [p.content] : [])));

  await agent.run("first request");
  assert.equal(results().filter((r) => r.startsWith("Not searched")).length, 1);
  await agent.run("second request");
  assert.match(results().at(-1)!, /use pnpm here/);
});

test("saving a note asks permission and takes no checkpoint, while recall doesn't ask", async () => {
  const memory = open();
  const asked: string[] = [];
  const provider = new ScriptedProvider([
    [
      { type: "tool_call", call: { type: "tool_call", id: "1", name: "recall", input: { query: "x" } } },
      { type: "done", stopReason: "tool_use", usage: { inputTokens: 1, outputTokens: 1 } },
    ],
    [
      { type: "tool_call", call: { type: "tool_call", id: "2", name: "remember", input: { content: "a fact" } } },
      { type: "done", stopReason: "tool_use", usage: { inputTokens: 1, outputTokens: 1 } },
    ],
    textStep("ok"),
  ]);
  let checkpoints = 0;
  const agent = new Agent({
    provider,
    tools: new ToolRegistry(memoryTools(memory)),
    permissions: new Permissions("ask", async (req) => {
      asked.push(req.tool.name);
      return "allow";
    }),
    system: "test",
    cwd: tempDir(),
    shell: detectShell(),
    checkpoints: { create: async () => void checkpoints++, disabledReason: undefined } as never,
  });
  await agent.run("go");
  assert.deepEqual(asked, ["remember"]);
  assert.equal(checkpoints, 0);
  assert.equal(memory.notes()[0]!.text, "a fact");
});

test("a note saved in one session is in the prompt of the next", async () => {
  const memory = open();
  assert.equal(memorySection(memory.notes()), "");
  memory.remember("always run the linter");
  assert.match(memorySection(memory.notes()), /\[1\] always run the linter/);
});

test("the prompt keeps the newest notes and says when others are left out", () => {
  const memory = open();
  for (let i = 0; i < 20; i++) memory.remember(`note number ${i} ${"x".repeat(400)}`);
  const section = memorySection(memory.notes());
  assert.ok(section.length < 4500);
  assert.match(section, /note number 19/);
  assert.doesNotMatch(section, /note number 0 /);
  assert.match(section, /\d+ older notes aren't shown/);
});
