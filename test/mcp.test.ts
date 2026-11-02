import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { Agent } from "../src/agent/agent.js";
import { Permissions } from "../src/agent/permissions.js";
import { ToolRegistry } from "../src/tools/index.js";
import { McpClient, McpManager, toolsFor } from "../src/tools/mcp.js";
import { detectShell } from "../src/tools/shell.js";
import { ScriptedProvider, makeCtx, tempDir, textStep, toolStep } from "./helpers.js";

const SERVER = fileURLToPath(new URL("./fixtures/mcp-server.mjs", import.meta.url));
const config = (...args: string[]) => ({ command: process.execPath, args: [SERVER, ...args] });

const open: { close(): void }[] = [];
after(() => open.forEach((c) => c.close()));

async function connect(env?: Record<string, string>) {
  const client = new McpClient("fixture", { ...config(), env });
  open.push(client);
  await client.connect();
  const registry = new ToolRegistry(toolsFor(client));
  const call = async (name: string, input: unknown = {}) => {
    const tool = registry.get(`mcp__fixture__${name}`)!;
    return registry.execute(tool, input, makeCtx(tempDir()));
  };
  return { client, registry, call };
}

test("connects, lists every page of tools, and ignores log lines on stdout", async () => {
  const { client } = await connect();
  assert.deepEqual(client.tools.map((t) => t.name), ["echo", "fail", "rich", "huge", "hang", "die", "get-env", "boom"]);
});

test("tools are advertised with the server's schema", async () => {
  const { registry } = await connect();
  const spec = registry.specs().find((s) => s.name === "mcp__fixture__echo")!;
  assert.equal(spec.description, "Echoes its input");
  assert.deepEqual(spec.parameters, { type: "object", properties: { message: { type: "string" } }, required: ["message"] });
  const bare = registry.specs().find((s) => s.name === "mcp__fixture__fail")!;
  assert.deepEqual(bare.parameters, { type: "object", properties: {} }, "a missing schema still gives providers an object");
  assert.ok(registry.specs().every((s) => /^[a-zA-Z0-9_-]{1,64}$/.test(s.name)), "names are valid for every provider");
});

test("calls return text, and other content is described rather than dropped", async () => {
  const { call } = await connect();
  assert.equal((await call("echo", { message: "hi" })).output, "echo: hi");
  assert.equal((await call("rich")).output, "a\n[image content not shown]\nb");
});

test("failures come back as tool errors the model can see", async () => {
  const { call } = await connect();
  assert.deepEqual(await call("fail"), { output: "the database is down", isError: true });
  const boom = await call("boom");
  assert.equal(boom.isError, true);
  assert.match(boom.output, /kaboom/);
});

test("huge output is cut down so it can't flood the context", async () => {
  const { call } = await connect();
  const { output } = await call("huge");
  assert.ok(output.length < 21_000, String(output.length));
  assert.match(output, /truncated/);
});

test("env from the config reaches the server", async () => {
  const { call } = await connect({ FIXTURE_TOKEN: "secret-value" });
  assert.equal((await call("get-env")).output, "secret-value");
});

test("a call that never answers times out, and can be interrupted", async () => {
  const { client } = await connect();
  await assert.rejects(client.callTool("hang", {}, undefined, 50), /tools\/call timed out/);
  const ac = new AbortController();
  const call = client.callTool("hang", {}, ac.signal);
  ac.abort();
  await assert.rejects(call, /Interrupted by user/);
  const still = await client.callTool("echo", { message: "still alive" });
  assert.match(still.content![0]!.text!, /still alive/);
});

test("a server that dies mid-call fails that call with its last words", async () => {
  const { call } = await connect();
  const died = await call("die");
  assert.equal(died.isError, true);
  assert.match(died.output, /exited with code 7.*out of memory/s);
});

test("one broken server doesn't stop the others", async () => {
  const manager = new McpManager({ good: config(), broken: config("crash-on-start"), missing: { command: "no-such-command-anywhere" } });
  open.push(manager);
  const tools = await manager.connect(5000);
  assert.ok(tools.some((t) => t.name === "mcp__good__echo"));
  assert.ok(tools.every((t) => !t.name.includes("broken")));
  assert.match(manager.errors.get("broken")!, /exited with code 3.*missing API token/s);
  assert.ok(manager.errors.has("missing"));
  const status = manager.status();
  assert.match(status, /good: 8 tools \(echo, fail/);
  assert.match(status, /broken: failed/);
});

test("no servers configured means no work and a clear status", async () => {
  const manager = new McpManager(undefined);
  assert.deepEqual(await manager.connect(), []);
  assert.equal(manager.status(), "No MCP servers configured.");
});

test("the agent asks before calling an MCP tool, and passes the result to the model", async () => {
  const { client } = await connect();
  const asked: string[] = [];
  const provider = new ScriptedProvider([toolStep("mcp__fixture__echo", { message: "through the agent" }), textStep("done")]);
  const agent = new Agent({
    provider,
    tools: new ToolRegistry(toolsFor(client)),
    permissions: new Permissions("ask", async (req) => {
      asked.push(req.tool.name);
      return "allow";
    }),
    system: "test",
    cwd: tempDir(),
    shell: detectShell(),
  });
  await agent.run("use the server");
  assert.deepEqual(asked, ["mcp__fixture__echo"]);
  assert.deepEqual(agent.messages[2]!.content[0], { type: "tool_result", id: "t1", content: "echo: through the agent", isError: undefined });
  assert.ok(provider.requests[0]!.tools.some((t) => t.name === "mcp__fixture__echo"));
});

test("tools added once connected appear from the first request", async () => {
  const { client } = await connect();
  const tools = new ToolRegistry([]);
  const provider = new ScriptedProvider([textStep("ok")]);
  const agent = new Agent({
    provider,
    tools,
    permissions: new Permissions("auto", async () => "allow"),
    system: "test",
    cwd: tempDir(),
    shell: detectShell(),
    projectContext: async (_signal, notify) => {
      tools.add(toolsFor(client));
      notify("MCP server other didn't start: nope");
      return "";
    },
  });
  const notices: string[] = [];
  await agent.run("hi", { onNotice: (m) => notices.push(m) });
  assert.equal(provider.requests[0]!.tools.length, 8);
  assert.deepEqual(notices, ["MCP server other didn't start: nope"]);
});
