// A minimal MCP server for the tests. It misbehaves in the ways real servers do.
import { createInterface } from "node:readline";

const mode = process.argv[2];
if (mode === "crash-on-start") {
  console.error("missing API token");
  process.exit(3);
}

const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const text = (t) => ({ content: [{ type: "text", text: t }] });

const PAGES = [
  [
    {
      name: "echo",
      description: "Echoes its input",
      inputSchema: { $schema: "http://json-schema.org/draft-07/schema#", type: "object", properties: { message: { type: "string" } }, required: ["message"] },
    },
    { name: "fail", description: "Reports a tool-level failure" },
  ],
  [
    { name: "rich", description: "Returns several kinds of content" },
    { name: "huge", description: "Returns far too much" },
    { name: "hang", description: "Never answers" },
    { name: "die", description: "Crashes the server" },
    { name: "get-env", description: "Reads an env var" },
    { name: "boom", description: "Fails at the protocol level" },
  ],
];

// servers shouldn't write logs to stdout, but some do
console.log("starting up...");

createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, method, params } = JSON.parse(line);
  if (method === "initialize") return send({ id, result: { protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } } });
  if (method === "tools/list") {
    const page = Number(params.cursor ?? 0);
    return send({ id, result: { tools: PAGES[page], ...(page + 1 < PAGES.length ? { nextCursor: String(page + 1) } : {}) } });
  }
  if (method !== "tools/call") return;

  // a request from the server partway through, which the client has to answer
  send({ id: 9000, method: "ping" });
  send({ id: 9001, method: "sampling/createMessage", params: {} });

  const { name, arguments: args } = params;
  switch (name) {
    case "echo":
      return send({ id, result: text(`echo: ${args.message}`) });
    case "fail":
      return send({ id, result: { isError: true, content: [{ type: "text", text: "the database is down" }] } });
    case "rich":
      return send({ id, result: { content: [{ type: "text", text: "a" }, { type: "image", data: "xx", mimeType: "image/png" }, { type: "resource", resource: { uri: "file:///x", text: "b" } }] } });
    case "huge":
      return send({ id, result: text("x".repeat(100_000)) });
    case "get-env":
      return send({ id, result: text(String(process.env.FIXTURE_TOKEN)) });
    case "boom":
      return send({ id, error: { code: -32000, message: "kaboom" } });
    case "die":
      console.error("fatal: out of memory");
      return process.exit(7);
    case "hang":
      return;
  }
});
