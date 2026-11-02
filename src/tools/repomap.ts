import { rgPath } from "@vscode/ripgrep";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setImmediate as yieldToLoop } from "node:timers/promises";
import { setFlagsFromString } from "node:v8";
import type { Language, Parser, Query } from "web-tree-sitter";
import { z } from "zod";
import { runProcess } from "../util/process.js";
import { defineTool } from "./types.js";

const MAX_FILES = 3000;
const MAX_FILE_BYTES = 200_000;
const MAX_SYMBOLS_PER_FILE = 12;
const MAX_LINE_CHARS = 100;
const PARSE_BUDGET_MS = 5000;
const DAMPING = 0.85;
const ITERATIONS = 20;
// a name defined all over the place (get, init, run) says nothing about how files relate
const MAX_DEFINITIONS_PER_NAME = 8;
const MIN_NAME_LENGTH = 3;
/** Below this there's little to navigate, and the map would only add tokens. */
export const MIN_FILES_FOR_MAP = 4;

const TSX_QUERY = `
(function_declaration name: (identifier) @name)
(generator_function_declaration name: (identifier) @name)
(class_declaration name: (type_identifier) @name)
(abstract_class_declaration name: (type_identifier) @name)
(method_definition name: (property_identifier) @name)
(interface_declaration name: (type_identifier) @name)
(type_alias_declaration name: (type_identifier) @name)
(enum_declaration name: (identifier) @name)
(program (lexical_declaration (variable_declarator name: (identifier) @name)))
(program (export_statement (lexical_declaration (variable_declarator name: (identifier) @name))))
(call_expression function: (identifier) @ref)
(call_expression function: (member_expression property: (property_identifier) @ref))
(new_expression constructor: (identifier) @ref)
(import_specifier name: (identifier) @ref)
(type_identifier) @ref`;

const PY_QUERY = `
(function_definition name: (identifier) @name)
(class_definition name: (identifier) @name)
(module (expression_statement (assignment left: (identifier) @name)))
(call function: (identifier) @ref)
(call function: (attribute attribute: (identifier) @ref))
(import_from_statement name: (dotted_name (identifier) @ref))`;

const GO_QUERY = `
(function_declaration name: (identifier) @name)
(method_declaration name: (field_identifier) @name)
(type_spec name: (type_identifier) @name)
(call_expression function: (identifier) @ref)
(call_expression function: (selector_expression field: (field_identifier) @ref))
(type_identifier) @ref`;

const RUST_QUERY = `
(function_item name: (identifier) @name)
(function_signature_item name: (identifier) @name)
(struct_item name: (type_identifier) @name)
(enum_item name: (type_identifier) @name)
(trait_item name: (type_identifier) @name)
(call_expression function: (identifier) @ref)
(call_expression function: (field_expression field: (field_identifier) @ref))
(call_expression function: (scoped_identifier name: (identifier) @ref))
(type_identifier) @ref`;

const JAVA_QUERY = `
(class_declaration name: (identifier) @name)
(interface_declaration name: (identifier) @name)
(enum_declaration name: (identifier) @name)
(method_declaration name: (identifier) @name)
(method_invocation name: (identifier) @ref)
(type_identifier) @ref`;

// tsx also parses plain TypeScript and JavaScript. One grammar matters because loading a second
// one in the same process takes seconds, and most web projects then never need to. The cost: an
// old-style <T>x cast reads as JSX, so the symbols after it in that file are lost from the map.
const TSX = { grammar: "tsx", query: TSX_QUERY };

const LANGUAGES: Record<string, { grammar: string; query: string }> = {
  ".ts": TSX,
  ".mts": TSX,
  ".cts": TSX,
  ".tsx": TSX,
  ".js": TSX,
  ".mjs": TSX,
  ".cjs": TSX,
  ".jsx": TSX,
  ".py": { grammar: "python", query: PY_QUERY },
  ".go": { grammar: "go", query: GO_QUERY },
  ".rs": { grammar: "rust", query: RUST_QUERY },
  ".java": { grammar: "java", query: JAVA_QUERY },
};

// where a model rarely needs to navigate to, and which would otherwise crowd out the source
const TEST_FILE = /(^|\/)(tests?|__tests__|specs?|e2e|fixtures?)\/|[._-](test|spec)\.[^/]+$|(^|\/)test_[^/]+$/i;

interface Symbol {
  name: string;
  row: number;
  line: string;
}

interface FileInfo {
  mtimeMs: number;
  symbols: Symbol[];
  /** referenced name -> times */
  refs: Map<string, number>;
}

// grammars are copied next to the bundle by the build, and come from the dev dependency in tests
function grammarPath(grammar: string): string {
  const file = `tree-sitter-${grammar}.wasm`;
  const bundled = join(dirname(fileURLToPath(import.meta.url)), "grammars", file);
  return existsSync(bundled) ? bundled : createRequire(import.meta.url).resolve(`tree-sitter-wasms/out/${file}`);
}

/** Parses source files, loading tree-sitter and each grammar only when first needed. */
class SymbolExtractor {
  private parser?: Promise<Parser>;
  private readonly languages = new Map<string, Promise<{ language: Language; query: Query }>>();

  private getParser(): Promise<Parser> {
    // V8's optimizing tier would compile the whole grammar after first use and hold up the event
    // loop for seconds, far more than it could ever save parsing a repo for a few hundred ms
    setFlagsFromString("--liftoff-only");
    return (this.parser ??= import("web-tree-sitter").then(async ({ Parser }) => {
      await Parser.init();
      return new Parser();
    }));
  }

  private getLanguage(grammar: string, source: string) {
    let loaded = this.languages.get(grammar);
    if (!loaded) {
      loaded = import("web-tree-sitter").then(async ({ Language, Query }) => {
        await this.getParser();
        const language = await Language.load(grammarPath(grammar));
        return { language, query: new Query(language, source) };
      });
      this.languages.set(grammar, loaded);
    }
    return loaded;
  }

  async extract(path: string, content: string): Promise<Pick<FileInfo, "symbols" | "refs"> | undefined> {
    const spec = LANGUAGES[extname(path).toLowerCase()];
    if (!spec) return undefined;
    const [parser, { language, query }] = await Promise.all([this.getParser(), this.getLanguage(spec.grammar, spec.query)]);
    parser.setLanguage(language);
    const tree = parser.parse(content);
    if (!tree) return undefined;
    try {
      const lines = content.split("\n");
      const symbols: Symbol[] = [];
      const refs = new Map<string, number>();
      for (const { name, node } of query.captures(tree.rootNode)) {
        if (name === "name") {
          symbols.push({ name: node.text, row: node.startPosition.row, line: lines[node.startPosition.row] ?? "" });
        } else {
          refs.set(node.text, (refs.get(node.text) ?? 0) + 1);
        }
      }
      return { symbols, refs };
    } finally {
      tree.delete();
    }
  }
}

/**
 * Ranks files by how much the rest of the code depends on them: an edge runs from each file to the
 * files defining the names it uses. It matches names, not types, so same-named symbols get linked.
 * Rarer names count for more, which keeps most of that noise down.
 */
export function rankFiles(files: Map<string, Pick<FileInfo, "symbols" | "refs">>, isFocus: (file: string) => boolean): Map<string, number> {
  const definedIn = new Map<string, Set<string>>();
  for (const [file, info] of files) {
    for (const s of info.symbols) {
      if (s.name.length < MIN_NAME_LENGTH) continue;
      if (!definedIn.has(s.name)) definedIn.set(s.name, new Set());
      definedIn.get(s.name)!.add(file);
    }
  }

  const edges = new Map<string, Map<string, number>>();
  for (const [file, info] of files) {
    const out = new Map<string, number>();
    for (const [name, count] of info.refs) {
      const owners = definedIn.get(name);
      if (!owners || owners.size > MAX_DEFINITIONS_PER_NAME) continue;
      for (const owner of owners) {
        if (owner !== file) out.set(owner, (out.get(owner) ?? 0) + Math.sqrt(count) / owners.size);
      }
    }
    edges.set(file, out);
  }

  const names = [...files.keys()];
  const focused = names.filter(isFocus);
  // where a random walk restarts: the focus files if there are any, otherwise anywhere
  const restart = new Map(names.map((f) => [f, focused.length ? (focused.includes(f) ? 1 / focused.length : 0) : 1 / names.length]));
  let rank = new Map(names.map((f) => [f, 1 / names.length]));

  for (let i = 0; i < ITERATIONS; i++) {
    const next = new Map(names.map((f) => [f, (1 - DAMPING) * restart.get(f)!]));
    let dangling = 0;
    for (const file of names) {
      const out = edges.get(file)!;
      const total = [...out.values()].reduce((a, b) => a + b, 0);
      if (!total) {
        dangling += rank.get(file)!;
        continue;
      }
      for (const [to, weight] of out) next.set(to, next.get(to)! + DAMPING * rank.get(file)! * (weight / total));
    }
    for (const f of names) next.set(f, next.get(f)! + DAMPING * dangling * restart.get(f)!);
    rank = next;
  }
  return rank;
}

function renderFile(path: string, info: Pick<FileInfo, "symbols">, usage: Map<string, number>): string {
  const seen = new Set<number>();
  const unique = info.symbols.filter((s) => !seen.has(s.row) && seen.add(s.row));
  const shown = unique
    .map((s, i) => ({ s, i }))
    .sort((a, b) => (usage.get(b.s.name) ?? 0) - (usage.get(a.s.name) ?? 0) || a.i - b.i)
    .slice(0, MAX_SYMBOLS_PER_FILE)
    .sort((a, b) => a.s.row - b.s.row);
  const lines = shown.map(({ s }) => {
    const text = s.line.trimEnd().replace(/\s*[{(:=]\s*$/, "").replace(/\t/g, "  ");
    return `  ${text.length > MAX_LINE_CHARS ? `${text.slice(0, MAX_LINE_CHARS - 1)}…` : text}`;
  });
  if (unique.length > shown.length) lines.push(`  ... ${unique.length - shown.length} more`);
  return `${path}\n${lines.join("\n")}`;
}

export interface RepoMapOptions {
  /** file paths or symbol names to centre the map on */
  focus?: string[];
  maxTokens?: number;
  signal?: AbortSignal;
}

export class RepoMap {
  private readonly cache = new Map<string, FileInfo>();
  private readonly extractor = new SymbolExtractor();

  constructor(private readonly cwd: string) {}

  /** Empty when the project has too little source code to be worth mapping. */
  async build({ focus = [], maxTokens = 1000, signal }: RepoMapOptions = {}): Promise<string> {
    const scanned = await this.scan(focus.length > 0, signal);
    const wanted = focus.map((f) => f.replaceAll("\\", "/").toLowerCase());
    const definesFocus = (file: string) => scanned.get(file)!.symbols.some((s) => focus.includes(s.name));
    const isFocus = (file: string) => wanted.some((f) => file.toLowerCase().includes(f)) || definesFocus(file);

    // tests only appear when asked for, by a focus that matches them
    const files = new Map([...scanned].filter(([file]) => !TEST_FILE.test(file) || isFocus(file)));
    if (files.size < MIN_FILES_FOR_MAP) return "";
    const rank = rankFiles(files, isFocus);

    const usage = new Map<string, number>();
    for (const info of files.values()) for (const [name, count] of info.refs) usage.set(name, (usage.get(name) ?? 0) + count);

    const ordered = [...files.keys()].filter((f) => files.get(f)!.symbols.length).sort((a, b) => rank.get(b)! - rank.get(a)! || a.localeCompare(b));
    const out: string[] = [];
    let chars = 0;
    for (const file of ordered) {
      const block = renderFile(file, files.get(file)!, usage);
      if (chars + block.length > maxTokens * 4) {
        if (out.length) break;
        continue;
      }
      out.push(block);
      chars += block.length + 1;
    }
    const left = ordered.length - out.length;
    return out.join("\n") + (left > 0 ? `\n... ${left} more files` : "");
  }

  private async scan(includeTests: boolean, signal?: AbortSignal): Promise<Map<string, FileInfo>> {
    const listed = await runProcess(rgPath, ["--files", "--no-messages"], { cwd: this.cwd, signal, timeoutMs: 15_000 });
    const sources = listed.output
      .split(/\r?\n/)
      .map((p) => p.replaceAll("\\", "/"))
      .filter((p) => p && LANGUAGES[extname(p).toLowerCase()] && (includeTests || !TEST_FILE.test(p)));

    // the project's main language first, so that if time runs out it's the rarer ones that get skipped
    const grammarOf = (p: string) => LANGUAGES[extname(p).toLowerCase()]!.grammar;
    const counts = new Map<string, number>();
    for (const p of sources) counts.set(grammarOf(p), (counts.get(grammarOf(p)) ?? 0) + 1);
    const paths = sources
      .sort(
        (a, b) =>
          counts.get(grammarOf(b))! - counts.get(grammarOf(a))! ||
          a.split("/").length - b.split("/").length ||
          a.localeCompare(b),
      )
      .slice(0, MAX_FILES);

    const files = new Map<string, FileInfo>();
    const deadline = Date.now() + PARSE_BUDGET_MS;
    for (const [i, path] of paths.entries()) {
      signal?.throwIfAborted();
      // a partial map beats holding up the first request on a huge repo
      if (Date.now() > deadline) break;
      if (i % 20 === 0) await yieldToLoop();
      const info = await this.load(path).catch(() => undefined);
      if (info) files.set(path, info);
    }
    return files;
  }

  private async load(path: string): Promise<FileInfo | undefined> {
    const abs = join(this.cwd, path);
    const { mtimeMs, size } = await stat(abs);
    const cached = this.cache.get(path);
    if (cached?.mtimeMs === mtimeMs) return cached;
    if (size > MAX_FILE_BYTES) return undefined;
    const parsed = await this.extractor.extract(path, await readFile(abs, "utf8"));
    if (!parsed) return undefined;
    const info = { mtimeMs, ...parsed };
    this.cache.set(path, info);
    return info;
  }
}

const maps = new Map<string, RepoMap>();

export const repoMapFor = (cwd: string): RepoMap => {
  let map = maps.get(cwd);
  if (!map) maps.set(cwd, (map = new RepoMap(cwd)));
  return map;
};

export const repoMapTool = defineTool({
  name: "repo_map",
  kind: "read",
  description:
    "Outline of the codebase: the most depended-on files with their key classes and functions, ranked using a parse of the source. " +
    "Pass focus to centre it on the files or symbols you're working with and what relates to them.",
  schema: z.object({
    focus: z.array(z.string()).optional().describe("File paths or symbol names"),
    max_tokens: z.number().int().min(200).max(8000).optional().describe("Size of the outline, default 1500"),
  }),
  summarize: (i) => i.focus?.join(", ") ?? "",
  async run({ focus, max_tokens = 1500 }, ctx) {
    const map = await repoMapFor(ctx.cwd).build({ focus, maxTokens: max_tokens, signal: ctx.signal });
    return map || "Too little source code here to map; use list_dir and read_file.";
  },
});
