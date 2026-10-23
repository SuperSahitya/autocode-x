import type { z } from "zod";
import type { ProcessManager } from "./processes.js";
import type { ShellInfo } from "./shell.js";

export type ToolKind = "read" | "write" | "exec" | "network";

export interface ToolContext {
  cwd: string;
  signal: AbortSignal;
  shell: ShellInfo;
  /** abs path -> mtimeMs at last read/write */
  fileState: Map<string, number>;
  processes: ProcessManager;
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
  kind: ToolKind;
  summarize(input: z.infer<S>): string;
  /** scope of "always allow"; defaults to the tool name, undefined = never remember */
  permissionKey?(input: z.infer<S>): string | undefined;
  run(input: z.infer<S>, ctx: ToolContext): Promise<ToolOutput | string>;
}

export const defineTool = <S extends z.ZodType>(tool: Tool<S>): Tool<S> => tool;

export class ToolError extends Error {}
