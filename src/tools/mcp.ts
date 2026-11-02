import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { z } from "zod";
import { killTree } from "../util/process.js";
import { truncateMiddle } from "../util/text.js";
import { ToolError, defineTool, type Tool } from "./types.js";

const PROTOCOL_VERSION = "2025-06-18";
const CONNECT_TIMEOUT_MS = 30_000;
const CALL_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_CHARS = 20_000;
// the most any of the providers accept
const MAX_TOOL_NAME = 64;

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

interface McpContent {
  type: string;
  text?: string;
  resource?: { uri?: string; text?: string };
}

interface Pending {
  resolve(result: any): void;
  reject(err: Error): void;
}

const quoteForCmd = (arg: string) => (/[\s"&|<>^]/.test(arg) ? `"${arg.replace(/"/g, '""')}"` : arg);

function launch({ command, args = [], env }: McpServerConfig): ChildProcessWithoutNullStreams {
  const options = {
    env: { ...process.env, ...env },
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"] as ["pipe", "pipe", "pipe"],
    // own process group so the whole tree can be killed
    detached: process.platform !== "win32",
  };
  // npx and friends are .cmd files on Windows, which only start through a shell
  if (process.platform === "win32") return spawn([command, ...args].map(quoteForCmd).join(" "), { ...options, shell: true });
  return spawn(command, args, options);
}

/** A Model Context Protocol client over stdio: JSON-RPC, one message per line. */
export class McpClient {
  tools: McpToolInfo[] = [];
  private child?: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private stderrTail = "";

  constructor(
    readonly name: string,
    private readonly config: McpServerConfig,
  ) {}

  async connect(timeoutMs = CONNECT_TIMEOUT_MS): Promise<void> {
    const child = launch(this.config);
    this.child = child;
    child.stderr.on("data", (b: Buffer) => {
      this.stderrTail = (this.stderrTail + b.toString("utf8")).slice(-500);
    });
    child.stdin.on("error", () => {}); // reported through "close" instead
    child.on("error", (err) => this.failAll(err.message));
    child.on("close", (code) => this.failAll(`server exited with code ${code}`));
    createInterface({ input: child.stdout }).on("line", (line) => this.onLine(line));

    await this.request(
      "initialize",
      { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "autocode", version: "1" } },
      timeoutMs,
    );
    this.notify("notifications/initialized");

    let cursor: string | undefined;
    do {
      const page = await this.request("tools/list", cursor ? { cursor } : {}, timeoutMs);
      this.tools.push(...(page.tools ?? []));
      cursor = page.nextCursor;
    } while (cursor);
  }

  async callTool(name: string, args: unknown, signal?: AbortSignal, timeoutMs = CALL_TIMEOUT_MS) {
    return this.request("tools/call", { name, arguments: args ?? {} }, timeoutMs, signal) as Promise<{
      content?: McpContent[];
      isError?: boolean;
    }>;
  }

  close(): void {
    const pid = this.child?.pid;
    this.child = undefined;
    killTree(pid, true);
  }

  private request(method: string, params: unknown, timeoutMs: number, signal?: AbortSignal): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const finish = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        this.pending.delete(id);
      };
      const cancel = (message: string) => {
        finish();
        this.notify("notifications/cancelled", { requestId: id, reason: message });
        reject(new Error(message));
      };
      const onAbort = () => cancel("Interrupted by user.");
      const timer = setTimeout(() => cancel(`${method} timed out after ${timeoutMs / 1000}s`), timeoutMs);
      signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, {
        resolve: (result) => {
          finish();
          resolve(result);
        },
        reject: (err) => {
          finish();
          reject(err);
        },
      });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  private notify(method: string, params?: unknown): void {
    this.send({ jsonrpc: "2.0", method, ...(params ? { params } : {}) });
  }

  private send(message: unknown): void {
    if (this.child?.stdin.writable) this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private onLine(line: string): void {
    let message: any;
    try {
      message = JSON.parse(line);
    } catch {
      return; // servers shouldn't log to stdout, but some do
    }
    if (message.method) {
      // a request from the server. Nothing beyond ping is advertised in our capabilities.
      if (message.id === undefined) return;
      const reply = message.method === "ping" ? { result: {} } : { error: { code: -32601, message: "Method not found" } };
      this.send({ jsonrpc: "2.0", id: message.id, ...reply });
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    if (message.error) pending.reject(new Error(message.error.message ?? "MCP error"));
    else pending.resolve(message.result ?? {});
  }

  private failAll(reason: string): void {
    const detail = this.stderrTail.trim();
    const err = new Error(detail ? `${reason}: ${detail}` : reason);
    for (const p of [...this.pending.values()]) p.reject(err);
  }
}

function renderContent(content: McpContent[] = []): string {
  return content
    .map((c) => {
      if (c.type === "text") return c.text ?? "";
      if (c.type === "resource") return c.resource?.text ?? `[resource: ${c.resource?.uri ?? "unknown"}]`;
      return `[${c.type} content not shown]`;
    })
    .join("\n");
}

const toolName = (server: string, tool: string) => `mcp__${server}__${tool}`.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, MAX_TOOL_NAME);

export function toolsFor(client: McpClient): Tool[] {
  return client.tools.map((info) => {
    const tool = defineTool({
      name: toolName(client.name, info.name),
      // what a server's tool does is unknown, so it's treated like a shell command: ask first, snapshot first
      kind: "exec",
      description: info.description ?? `${info.name} from the ${client.name} MCP server`,
      schema: z.looseObject({}),
      summarize: (input) => JSON.stringify(input).slice(0, 100),
      async run(input, ctx) {
        const result = await client.callTool(info.name, input, ctx.signal);
        const output = truncateMiddle(renderContent(result.content), MAX_OUTPUT_CHARS);
        if (result.isError) throw new ToolError(output || `${info.name} failed`);
        return output || "(no output)";
      },
    });
    return { ...tool, parameters: { type: "object", properties: {}, ...info.inputSchema, $schema: undefined } } as Tool;
  });
}

export class McpManager {
  readonly clients: McpClient[];
  readonly errors = new Map<string, string>();

  constructor(servers: Record<string, McpServerConfig> = {}) {
    this.clients = Object.entries(servers).map(([name, config]) => new McpClient(name, config));
  }

  /** Never rejects: one broken server shouldn't take the others, or the agent, down with it. */
  async connect(timeoutMs?: number): Promise<Tool[]> {
    const results = await Promise.all(
      this.clients.map(async (client) => {
        try {
          await client.connect(timeoutMs);
          return toolsFor(client);
        } catch (err) {
          this.errors.set(client.name, (err as Error).message);
          client.close();
          return [];
        }
      }),
    );
    return results.flat();
  }

  status(): string {
    if (!this.clients.length) return "No MCP servers configured.";
    return this.clients
      .map((c) => {
        const error = this.errors.get(c.name);
        return error ? `${c.name}: failed (${error})` : `${c.name}: ${c.tools.length} tools${c.tools.length ? ` (${c.tools.map((t) => t.name).join(", ")})` : ""}`;
      })
      .join("\n");
  }

  close(): void {
    for (const c of this.clients) c.close();
  }
}
