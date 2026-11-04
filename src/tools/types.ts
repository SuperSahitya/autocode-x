import type { z } from "zod";
import type { ProcessManager } from "./processes.js";
import type { ShellInfo } from "./shell.js";

/** "memory" changes saved notes, so it asks like a write but has nothing for /undo to restore */
export type ToolKind = "read" | "write" | "exec" | "network" | "memory";

export interface ToolContext {
  cwd: string;
  signal: AbortSignal;
  shell: ShellInfo;
  /** abs path -> mtimeMs at last read/write */
  fileState: Map<string, number>;
  processes: ProcessManager;
  /** counts the user's requests, for limits that start over with each one */
  turn: number;
  searxngUrl?: string;
  /** streams a running command's output to the UI */
  onOutput?: (chunk: string) => void;
}

export interface ToolOutput {
  output: string;
  /** shown to the user instead of output, e.g. a diff */
  display?: string;
  isError?: boolean;
}

export interface Tool<S extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  schema: S;
  /** JSON Schema to advertise when it didn't come from schema, as with MCP tools */
  parameters?: Record<string, unknown>;
  kind: ToolKind;
  summarize(input: z.infer<S>): string;
  /** scope of "always allow"; defaults to the tool name, undefined = never remember */
  permissionKey?(input: z.infer<S>): string | undefined;
  run(input: z.infer<S>, ctx: ToolContext): Promise<ToolOutput | string>;
}

export const defineTool = <S extends z.ZodType>(tool: Tool<S>): Tool<S> => tool;

export class ToolError extends Error {}
