import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, parse, resolve } from "node:path";
import { runProcess } from "../util/process.js";

/** Stable short id for a project directory. */
export const projectKey = (cwd: string) => createHash("sha1").update(resolve(cwd).toLowerCase()).digest("hex").slice(0, 16);

export interface Checkpoint {
  commit: string;
  label: string;
  createdAt: number;
  /** conversation length when the checkpoint was taken, so undo can drop the turn too */
  messageCount: number;
  /** parts in the trailing user message at that point, if the turn merged into it */
  lastPartCount?: number;
  /** the turn has since been folded into a summary, so undo can restore its files but not cut it out */
  compacted?: boolean;
}

// Never snapshotted: dependencies, build output and caches are large and regenerable.
const EXCLUDES = [
  "node_modules/",
  "dist/",
  "build/",
  "out/",
  ".next/",
  ".nuxt/",
  ".svelte-kit/",
  ".turbo/",
  ".cache/",
  "coverage/",
  "target/",
  ".gradle/",
  ".venv/",
  "venv/",
  "__pycache__/",
  "*.log",
];

// Byte-exact snapshots regardless of the user's git config or the project's .gitattributes.
const GIT_CONFIG = [
  "-c", "core.autocrlf=false",
  "-c", "core.safecrlf=false",
  "-c", "core.longpaths=true",
  "-c", "core.quotepath=false",
  "-c", "core.fsmonitor=false",
  "-c", "commit.gpgsign=false",
  "-c", "user.name=autocode",
  "-c", "user.email=autocode@localhost",
];

/**
 * Snapshots of the working directory in a separate git repo (~/.autocode/checkpoints/<hash>),
 * so the project's own repository and history are never touched.
 */
export class Checkpoints {
  readonly gitDir: string;
  private ready?: Promise<string | undefined>;
  disabledReason?: string;

  constructor(
    readonly cwd: string,
    baseDir: string,
  ) {
    this.gitDir = join(baseDir, projectKey(cwd));
    const root = parse(resolve(cwd)).root;
    if (resolve(cwd) === resolve(homedir()) || resolve(cwd) === root) {
      this.disabledReason = "checkpoints are off in your home directory or a drive root";
    }
  }

  private async git(args: string[]): Promise<string> {
    const res = await runProcess("git", [...GIT_CONFIG, `--git-dir=${this.gitDir}`, `--work-tree=${this.cwd}`, ...args], {
      cwd: this.cwd,
      timeoutMs: 60_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    if (res.exitCode !== 0) throw new Error(`git ${args[0]} failed: ${res.output.trim().slice(0, 300)}`);
    return res.output;
  }

  private init(): Promise<string | undefined> {
    this.ready ??= (async () => {
      if (this.disabledReason) return this.disabledReason;
      try {
        if (!existsSync(join(this.gitDir, "HEAD"))) {
          mkdirSync(this.gitDir, { recursive: true });
          await this.git(["init", "-q"]);
          writeFileSync(join(this.gitDir, "info", "exclude"), EXCLUDES.join("\n") + "\n");
          // overrides the project's .gitattributes, which would otherwise rewrite line endings on restore
          writeFileSync(join(this.gitDir, "info", "attributes"), "* -text -filter -diff\n");
        }
        return undefined;
      } catch (err) {
        return `checkpoints unavailable: ${(err as Error).message}`;
      }
    })().then((reason) => (this.disabledReason = reason));
    return this.ready;
  }

  /** Snapshot the working tree. Returns the commit id, or undefined if checkpoints are unavailable. */
  async create(label: string): Promise<string | undefined> {
    if (await this.init()) return undefined;
    await this.git(["add", "-A", "--ignore-errors", "."]);
    await this.git(["commit", "-q", "--allow-empty", "--no-verify", "-m", label.slice(0, 200)]);
    return (await this.git(["rev-parse", "HEAD"])).trim();
  }

  /** Files that differ between a checkpoint and the current working tree. */
  async changedSince(commit: string): Promise<string[]> {
    if (await this.init()) return [];
    await this.git(["add", "-A", "--ignore-errors", "."]);
    const out = await this.git(["diff", "--cached", "--name-only", commit]);
    return out.split(/\r?\n/).filter(Boolean);
  }

  /**
   * Put the working tree back to a checkpoint: modified and deleted files are restored, files created
   * since are removed. Ignored paths (node_modules, ...) are left alone. Returns the files that changed.
   */
  async restore(commit: string): Promise<string[]> {
    const changed = await this.changedSince(commit);
    if (changed.length) {
      // the index now mirrors the working tree, so a reset read-tree also removes files added since
      await this.git(["read-tree", "-u", "--reset", commit]);
    }
    return changed;
  }
}
