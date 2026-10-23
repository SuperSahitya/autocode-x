import type { Tool } from "../tools/types.js";

export type Decision = "allow" | "allow_always" | "deny";

export interface PermissionRequest {
  tool: Tool;
  input: unknown;
  summary: string;
  alwaysKey?: string;
}

export type PermissionMode = "ask" | "auto";

export class Permissions {
  private readonly always = new Set<string>();

  constructor(
    public mode: PermissionMode,
    private readonly prompt: (req: PermissionRequest) => Promise<Decision>,
  ) {}

  async check(tool: Tool, input: unknown, summary: string): Promise<boolean> {
    if (this.mode === "auto" || tool.kind === "read") return true;
    const alwaysKey = tool.permissionKey ? tool.permissionKey(input) : tool.name;
    if (alwaysKey && this.always.has(alwaysKey)) return true;

    const decision = await this.prompt({ tool, input, summary, alwaysKey });
    if (decision === "allow_always" && alwaysKey) this.always.add(alwaysKey);
    return decision !== "deny";
  }
}
