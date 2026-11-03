import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { load as loadSqliteVec } from "sqlite-vec";
import { projectKey } from "../session/checkpoints.js";
import type { Session } from "../session/store.js";
import type { Message } from "../types.js";
import { EMBEDDING_DIMENSIONS, type Embedder } from "./embed.js";

const CHUNK_CHARS = 1500;
const DEFAULT_LIMIT = 5;
// chosen with bench:memory --tune: a weak keyword match shouldn't outrank a close match by meaning
const RANKING_WEIGHTS = [0.5, 1];
const RRF_K = 60;
// Gemini's free tier allows 100 texts a minute, so a search never has to stop and wait.
// Later searches embed the rest, which still match on keywords until then.
const MAX_EMBEDDED_PER_SEARCH = 90;

const STOPWORDS = new Set(
  "a an and are as at be but by did do does for from had has have how i if in into is it its me my no not of on or our should so that the their them then there these they this to up us was we were what when where which who why will with would you your s t d m ll re ve".split(" "),
);

export interface MemoryItem {
  id: number;
  kind: "note" | "session";
  title: string;
  text: string;
  updatedAt: number;
}

export interface RecallResult {
  items: MemoryItem[];
  /** set when the search fell back to keywords */
  warning?: string;
}

export interface MemoryOptions {
  path: string;
  cwd: string;
  embedder?: Embedder;
  /** the conversations to search, read at most once per run as they don't change under us */
  sessions?(): Session[];
}

/** Only what the people said: tool output is large, can hold anything, and can be read again from the files. */
export function sessionChunks(messages: Message[]): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const message of messages) {
    for (const part of message.content) {
      if (part.type !== "text" || !part.text.trim()) continue;
      const line = `${message.role}: ${part.text.trim()}`;
      for (let i = 0; i < line.length; i += CHUNK_CHARS) {
        const piece = line.slice(i, i + CHUNK_CHARS);
        if (current && current.length + piece.length > CHUNK_CHARS) {
          chunks.push(current);
          current = "";
        }
        current += (current ? "\n" : "") + piece;
      }
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

/** Reciprocal rank fusion: rewards ranking well in each list, without having to compare their scores. */
export function fuse(rankings: number[][], weights: number[] = []): number[] {
  const scores = new Map<number, number>();
  rankings.forEach((ranking, list) => {
    ranking.forEach((id, rank) => scores.set(id, (scores.get(id) ?? 0) + (weights[list] ?? 1) / (RRF_K + rank + 1)));
  });
  return [...scores.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}

const toBlob = (vector: number[]) => new Uint8Array(new Float32Array(vector).buffer);

function openDatabase(path: string): DatabaseSync {
  // loaded this way to keep Node's "SQLite is experimental" warning out of the terminal
  const emitWarning = process.emitWarning;
  process.emitWarning = () => {};
  try {
    const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
    return new DatabaseSync(path, { allowExtension: true });
  } finally {
    process.emitWarning = emitWarning;
  }
}

/** Saved notes and past conversations for each project, searchable by keyword and by meaning, in one SQLite file. */
export class Memory {
  embedder?: Embedder;
  private readonly db: DatabaseSync;
  private readonly project: string;
  private readonly hasVectors: boolean;
  private sessionsIndexed = false;
  private embedding?: Promise<number>;

  constructor(private readonly opts: MemoryOptions) {
    mkdirSync(dirname(opts.path), { recursive: true });
    this.project = projectKey(opts.cwd);
    this.embedder = opts.embedder;
    this.db = openDatabase(opts.path);
    this.hasVectors = this.loadVectors();
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 3000;
      CREATE TABLE IF NOT EXISTS items (
        id INTEGER PRIMARY KEY,
        project TEXT NOT NULL,
        kind TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT '',
        title TEXT NOT NULL DEFAULT '',
        text TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        embedded INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS items_by_project ON items (project, kind);
      CREATE TABLE IF NOT EXISTS indexed_sessions (id TEXT PRIMARY KEY, updated_at INTEGER NOT NULL);
      CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(text, tokenize = 'porter unicode61');
    `);
    if (this.hasVectors) {
      this.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS items_vec USING vec0(project TEXT, embedding FLOAT[${EMBEDDING_DIMENSIONS}] distance_metric=cosine);`);
    }
  }

  // sqlite-vec has no build for some platforms, and keywords still work without it
  private loadVectors(): boolean {
    try {
      loadSqliteVec(this.db);
      this.db.enableLoadExtension(false);
      return true;
    } catch {
      return false;
    }
  }

  close(): void {
    this.db.close();
  }

  /** Saves a note, or rewrites one that's out of date. Returns its id. */
  remember(text: string, replaces?: number): number {
    const content = text.trim();
    if (replaces !== undefined) {
      if (!this.note(replaces)) throw new Error(`No note ${replaces}.`);
      this.removeIndexed(replaces);
      this.db.prepare("UPDATE items SET text = ?, updated_at = ?, embedded = 0 WHERE id = ?").run(content, Date.now(), replaces);
      this.db.prepare("INSERT INTO items_fts (rowid, text) VALUES (?, ?)").run(replaces, content);
      return replaces;
    }
    const same = this.db.prepare("SELECT id FROM items WHERE project = ? AND kind = 'note' AND text = ?").get(this.project, content) as { id: number } | undefined;
    return same?.id ?? this.insert("note", "", "", content);
  }

  forget(id: number): boolean {
    if (!this.note(id)) return false;
    this.remove(id);
    return true;
  }

  /** Newest first. */
  notes(): MemoryItem[] {
    const rows = this.db.prepare(`${SELECT_ITEM} WHERE project = ? AND kind = 'note' ORDER BY updated_at DESC, id DESC`).all(this.project);
    return rows as unknown as MemoryItem[];
  }

  /** Brings the given conversations into the index. Text dropped by compaction stays searchable. */
  indexSessions(sessions: Session[]): void {
    const seen = this.db.prepare("SELECT updated_at AS updatedAt FROM indexed_sessions WHERE id = ?");
    const existing = this.db.prepare("SELECT id, text FROM items WHERE project = ? AND kind = 'session' AND source = ?");
    const mark = this.db.prepare("INSERT INTO indexed_sessions (id, updated_at) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET updated_at = excluded.updated_at");
    for (const session of sessions) {
      if ((seen.get(session.id) as { updatedAt: number } | undefined)?.updatedAt === session.updatedAt) continue;
      const chunks = sessionChunks(session.messages);
      const old = existing.all(this.project, session.id) as { id: number; text: string }[];
      const kept = new Set(old.map((o) => o.text));
      for (const chunk of chunks) if (!kept.has(chunk)) this.insert("session", session.id, session.title, chunk, session.updatedAt);
      // only the last chunk of a conversation can grow; its shorter version would just crowd the results
      for (const o of old) if (chunks.some((c) => c !== o.text && c.startsWith(o.text))) this.remove(o.id);
      mark.run(session.id, session.updatedAt);
    }
  }

  // searches in one response run together, and shouldn't each embed the same items
  /** Returns how many items it embedded. */
  embedPending(signal?: AbortSignal): Promise<number> {
    this.embedding ??= this.embedBatch(signal).finally(() => (this.embedding = undefined));
    return this.embedding;
  }

  private async embedBatch(signal?: AbortSignal): Promise<number> {
    if (!this.embedder || !this.hasVectors) return 0;
    const pending = this.db
      .prepare("SELECT id, title, text FROM items WHERE project = ? AND embedded = 0 ORDER BY updated_at DESC LIMIT ?")
      .all(this.project, MAX_EMBEDDED_PER_SEARCH) as { id: number; title: string; text: string }[];
    if (!pending.length) return 0;
    const vectors = await this.embedder.embed(pending.map((p) => ({ kind: "document" as const, title: p.title, text: p.text })), signal);
    pending.forEach((p, i) => this.storeVector(p.id, vectors[i]!));
    return pending.length;
  }

  private storeVector(id: number, vector: number[]): void {
    this.db.prepare("INSERT INTO items_vec (rowid, project, embedding) VALUES (?, ?, ?)").run(BigInt(id), this.project, toBlob(vector));
    this.db.prepare("UPDATE items SET embedded = 1 WHERE id = ?").run(id);
  }

  /** Item ids, best first. */
  keywordSearch(query: string, limit = DEFAULT_LIMIT): number[] {
    const words = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])].filter((w) => !STOPWORDS.has(w));
    if (!words.length) return [];
    const rows = this.db
      .prepare(
        `SELECT items.id AS id FROM items_fts JOIN items ON items.id = items_fts.rowid
         WHERE items_fts MATCH ? AND items.project = ? ORDER BY bm25(items_fts) LIMIT ?`,
      )
      .all(words.map((w) => `"${w}"`).join(" OR "), this.project, limit) as { id: number }[];
    return rows.map((r) => r.id);
  }

  /** Item ids, nearest first. */
  vectorSearch(vector: number[], limit = DEFAULT_LIMIT): number[] {
    if (!this.hasVectors) return [];
    const rows = this.db
      .prepare("SELECT rowid AS id FROM items_vec WHERE embedding MATCH ? AND k = ? AND project = ? ORDER BY distance")
      .all(toBlob(vector), limit, this.project) as { id: number }[];
    return rows.map((r) => r.id);
  }

  async recall(query: string, limit = DEFAULT_LIMIT, signal?: AbortSignal): Promise<RecallResult> {
    if (!this.sessionsIndexed && this.opts.sessions) {
      this.indexSessions(this.opts.sessions());
      this.sessionsIndexed = true;
    }
    const rankings = [this.keywordSearch(query, limit)];
    let warning: string | undefined;
    if (this.embedder && this.hasVectors) {
      try {
        await this.embedPending(signal);
        const [vector] = await this.embedder.embed([{ kind: "query", text: query }], signal);
        rankings.push(this.vectorSearch(vector!, limit));
      } catch (err) {
        signal?.throwIfAborted();
        warning = `Searched by keyword only, as embedding failed: ${(err as Error).message}`;
      }
    }
    return { items: fuse(rankings, RANKING_WEIGHTS).slice(0, limit).map((id) => this.item(id)!), warning };
  }

  private insert(kind: MemoryItem["kind"], source: string, title: string, text: string, updatedAt = Date.now()): number {
    const { lastInsertRowid } = this.db.prepare("INSERT INTO items (project, kind, source, title, text, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run(this.project, kind, source, title, text, updatedAt);
    this.db.prepare("INSERT INTO items_fts (rowid, text) VALUES (?, ?)").run(lastInsertRowid, text);
    return Number(lastInsertRowid);
  }

  private remove(id: number): void {
    this.removeIndexed(id);
    this.db.prepare("DELETE FROM items WHERE id = ?").run(id);
  }

  private removeIndexed(id: number): void {
    this.db.prepare("DELETE FROM items_fts WHERE rowid = ?").run(id);
    if (this.hasVectors) this.db.prepare("DELETE FROM items_vec WHERE rowid = ?").run(BigInt(id));
  }

  item(id: number): MemoryItem | undefined {
    return this.db.prepare(`${SELECT_ITEM} WHERE id = ? AND project = ?`).get(id, this.project) as MemoryItem | undefined;
  }

  private note(id: number): MemoryItem | undefined {
    const item = this.item(id);
    return item?.kind === "note" ? item : undefined;
  }
}

const SELECT_ITEM = "SELECT id, kind, title, text, updated_at AS updatedAt FROM items";
