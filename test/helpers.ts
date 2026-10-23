import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext } from "../src/tools/types.js";
import { detectShell } from "../src/tools/shell.js";

export const tempDir = () => mkdtempSync(join(tmpdir(), "autocode-test-"));

export const makeCtx = (cwd: string): ToolContext => ({
  cwd,
  signal: new AbortController().signal,
  shell: detectShell(),
  fileState: new Map(),
});

/**
 * A fake streaming LLM endpoint. Each request gets the next scripted list of SSE `data:` payloads;
 * request bodies are recorded so tests can assert what the adapter sent.
 */
export async function mockSSEServer(script: unknown[][]) {
  const requests: any[] = [];
  const server = createServer(async (req: IncomingMessage, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push(JSON.parse(body));
    const events = script[requests.length - 1] ?? [];
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const ev of events) {
      // Split each event across writes to exercise the parser's buffering.
      const line = `data: ${typeof ev === "string" ? ev : JSON.stringify(ev)}\n\n`;
      const mid = Math.floor(line.length / 2);
      res.write(line.slice(0, mid));
      res.write(line.slice(mid));
    }
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, requests, close: () => server.close() };
}
