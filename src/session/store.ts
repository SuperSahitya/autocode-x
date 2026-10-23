import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentState } from "../agent/agent.js";
import { projectKey } from "./checkpoints.js";

export interface Session extends AgentState {
  version: 1;
  id: string;
  cwd: string;
  title: string;
  profile: string;
  model: string;
  createdAt: number;
  updatedAt: number;
}

export interface SessionSummary {
  id: string;
  title: string;
  updatedAt: number;
}

// Files are named <project key>_<id>.json so a project's sessions can be found without opening them.
export class SessionStore {
  constructor(private readonly dir: string) {}

  create(cwd: string, profile: string, model: string): Session {
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
    const now = Date.now();
    return {
      version: 1,
      id: `${stamp}-${randomBytes(2).toString("hex")}`,
      cwd,
      title: "",
      profile,
      model,
      createdAt: now,
      updatedAt: now,
      messages: [],
      usage: { inputTokens: 0, outputTokens: 0 },
      checkpoints: [],
    };
  }

  save(session: Session): void {
    if (!session.messages.length) return;
    session.updatedAt = Date.now();
    if (!session.title) {
      const first = session.messages[0]?.content.find((p) => p.type === "text");
      session.title = first?.type === "text" ? first.text.replace(/\s+/g, " ").slice(0, 80) : "";
    }
    mkdirSync(this.dir, { recursive: true });
    const path = this.path(session.cwd, session.id);
    // write then rename, so a crash mid-save never leaves a truncated session
    writeFileSync(`${path}.tmp`, JSON.stringify(session));
    renameSync(`${path}.tmp`, path);
  }

  /** Load by id, or the most recently updated session for this project when id is omitted. */
  load(cwd: string, id?: string): Session | undefined {
    const file = id ? this.files().find((f) => f.endsWith(`_${id}.json`)) : this.forProject(cwd)[0];
    if (!file) return undefined;
    return JSON.parse(readFileSync(join(this.dir, file), "utf8")) as Session;
  }

  list(cwd: string, limit = 10): SessionSummary[] {
    return this.forProject(cwd)
      .slice(0, limit)
      .map((f) => {
        const s = JSON.parse(readFileSync(join(this.dir, f), "utf8")) as Session;
        return { id: s.id, title: s.title, updatedAt: s.updatedAt };
      });
  }

  private path(cwd: string, id: string): string {
    return join(this.dir, `${projectKey(cwd)}_${id}.json`);
  }

  private files(): string[] {
    try {
      return readdirSync(this.dir).filter((f) => f.endsWith(".json"));
    } catch {
      return [];
    }
  }

  private forProject(cwd: string): string[] {
    const prefix = `${projectKey(cwd)}_`;
    return this.files()
      .filter((f) => f.startsWith(prefix))
      .map((f) => ({ f, mtime: statSync(join(this.dir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
      .map((x) => x.f);
  }
}
