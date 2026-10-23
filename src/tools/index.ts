import { z } from "zod";
import type { ToolCallPart, ToolSpec } from "../types.js";
import { bashOutputTool, bashTool, killProcessTool } from "./bash.js";
import { editFileTool, listDirTool, readFileTool, writeFileTool } from "./fs.js";
import { globTool, grepTool } from "./search.js";
import { webFetchTool, webSearchTool } from "./web.js";
import { ToolError, type Tool, type ToolContext, type ToolOutput } from "./types.js";

export const DEFAULT_TOOLS: Tool[] = [
  readFileTool,
  writeFileTool,
  editFileTool,
  listDirTool,
  globTool,
  grepTool,
  bashTool,
  bashOutputTool,
  killProcessTool,
  webSearchTool,
  webFetchTool,
];

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  constructor(tools: Tool[] = DEFAULT_TOOLS) {
    for (const t of tools) this.tools.set(t.name, t);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  specs(): ToolSpec[] {
    return [...this.tools.values()].map((t) => {
      const { $schema: _, ...parameters } = z.toJSONSchema(t.schema) as Record<string, unknown>;
      return { name: t.name, description: t.description, parameters };
    });
  }

  parse(call: ToolCallPart): { tool: Tool; input: unknown } | { error: string } {
    const tool = this.tools.get(call.name);
    if (!tool) return { error: `Unknown tool "${call.name}". Available: ${[...this.tools.keys()].join(", ")}` };
    const raw = call.input as { __invalid_json?: string } | undefined;
    if (raw?.__invalid_json !== undefined) {
      return { error: `Arguments were not valid JSON: ${raw.__invalid_json.slice(0, 200)}` };
    }
    const parsed = tool.schema.safeParse(call.input);
    if (!parsed.success) return { error: `Invalid arguments for ${call.name}:\n${z.prettifyError(parsed.error)}` };
    return { tool, input: parsed.data };
  }

  async execute(tool: Tool, input: unknown, ctx: ToolContext): Promise<ToolOutput> {
    try {
      const out = await tool.run(input, ctx);
      return typeof out === "string" ? { output: out } : out;
    } catch (err) {
      if (err instanceof ToolError) return { output: err.message, isError: true };
      if (ctx.signal.aborted) return { output: "Interrupted by user.", isError: true };
      return { output: `${tool.name} failed: ${(err as Error).message}`, isError: true };
    }
  }
}
