import { lexer, type Token, type Tokens } from "marked";
import pc from "picocolors";
import { stripAnsi } from "../util/text.js";

const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'" };
const decode = (s: string) => s.replace(/&(amp|lt|gt|quot|#39);/g, (m) => ENTITIES[m]!);

/** Render markdown to ANSI-styled text for the terminal. */
export function renderMarkdown(src: string): string {
  return blocks(lexer(src)).trimEnd();
}

function blocks(tokens: Token[]): string {
  const out: string[] = [];
  for (const t of tokens) {
    const s = block(t);
    if (s !== undefined) out.push(s);
  }
  return out.join("\n\n");
}

function block(t: Token): string | undefined {
  switch (t.type) {
    case "heading": {
      const text = inline((t as Tokens.Heading).tokens);
      return (t as Tokens.Heading).depth <= 2 ? pc.bold(pc.underline(text)) : pc.bold(text);
    }
    case "paragraph":
      return inline((t as Tokens.Paragraph).tokens);
    case "text":
      return "tokens" in t && t.tokens ? inline(t.tokens) : decode(t.text);
    case "code":
      return codeBlock((t as Tokens.Code).text, (t as Tokens.Code).lang);
    case "list":
      return list(t as Tokens.List);
    case "blockquote":
      return blocks((t as Tokens.Blockquote).tokens)
        .split("\n")
        .map((l) => pc.dim("│ ") + pc.italic(l))
        .join("\n");
    case "table":
      return table(t as Tokens.Table);
    case "hr":
      return pc.dim("─".repeat(40));
    case "html":
      return decode(t.raw.trim());
    case "space":
      return undefined;
    default:
      return "raw" in t ? t.raw.trim() : undefined;
  }
}

function inline(tokens: Token[] = []): string {
  return tokens
    .map((t) => {
      switch (t.type) {
        case "strong":
          return pc.bold(inline((t as Tokens.Strong).tokens));
        case "em":
          return pc.italic(inline((t as Tokens.Em).tokens));
        case "del":
          return pc.strikethrough(inline((t as Tokens.Del).tokens));
        case "codespan":
          return pc.cyan(decode((t as Tokens.Codespan).text));
        case "link": {
          const l = t as Tokens.Link;
          const text = inline(l.tokens);
          return stripAnsi(text) === l.href || l.href.startsWith("mailto:")
            ? pc.blue(pc.underline(text))
            : `${pc.blue(text)} ${pc.dim(`(${l.href})`)}`;
        }
        case "image":
          return pc.dim(`[image: ${(t as Tokens.Image).text}]`);
        case "br":
          return "\n";
        case "text":
          return "tokens" in t && t.tokens ? inline(t.tokens) : decode(t.text);
        case "escape":
          return (t as Tokens.Escape).text;
        case "checkbox":
          return ""; // the list marker already shows it
        default:
          return decode(t.raw);
      }
    })
    .join("");
}

// nesting comes from indenting every continuation line of an item, so nested lists indent naturally
function list(l: Tokens.List): string {
  const start = typeof l.start === "number" ? l.start : 1;
  return l.items
    .map((item, i) => {
      const marker = item.task ? (item.checked ? pc.green("✔") : pc.dim("☐")) : l.ordered ? `${start + i}.` : pc.dim("•");
      const parts = item.tokens
        .filter((t) => t.type !== "checkbox")
        .map((t) => (t.type === "list" ? "\n" + list(t as Tokens.List) : (block(t) ?? "")));
      const body = parts.join("").trimStart().replace(/\n(?!\s*\n)/g, "\n  ");
      return `${marker} ${body}`;
    })
    .join(l.loose ? "\n\n" : "\n");
}

function table(t: Tokens.Table): string {
  const rows = [t.header, ...t.rows].map((row) => row.map((cell) => inline(cell.tokens)));
  const widths = t.header.map((_, c) => Math.max(...rows.map((r) => stripAnsi(r[c] ?? "").length)));
  const fmt = (row: string[], header: boolean) =>
    row
      .map((cell, c) => {
        const pad = " ".repeat(widths[c]! - stripAnsi(cell).length);
        const text = header ? pc.bold(cell) : cell;
        return t.align[c] === "right" ? pad + text : text + pad;
      })
      .join(pc.dim(" │ "));
  const sep = pc.dim(widths.map((w) => "─".repeat(w)).join("─┼─"));
  return [fmt(rows[0]!, true), sep, ...rows.slice(1).map((r) => fmt(r, false))].join("\n");
}

const KEYWORDS = new Set(
  (
    "const let var function return if else for while do switch case break continue new class extends import export " +
    "from default async await try catch finally throw typeof instanceof in of interface type enum public private " +
    "protected readonly static def lambda pass with as yield not and or is None True False null undefined true false " +
    "fn pub mut impl struct use mod match self this package func go defer"
  ).split(" "),
);

// Small regex highlighter: comments, strings, numbers and common keywords. Good enough for a terminal.
const TOKEN = /(\/\/.*|#(?![!\[]).*|\/\*[\s\S]*?\*\/)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|\b(\d+(?:\.\d+)?)\b|\b([A-Za-z_]\w*)\b/g;

function highlight(code: string, lang?: string): string {
  if (lang && /^(text|txt|plain|console|output)$/.test(lang)) return code;
  const isShell = lang ? /^(sh|bash|shell|zsh|ps1|powershell)$/.test(lang) : false;
  return code.replace(TOKEN, (m, comment, str, num, word) => {
    if (comment) return comment.startsWith("#") && !isShell && !/^(py|python|rb|ruby|yaml|yml|toml)$/.test(lang ?? "") ? m : pc.dim(m);
    if (str) return pc.green(m);
    if (num) return pc.yellow(m);
    if (word && KEYWORDS.has(word)) return pc.magenta(m);
    return m;
  });
}

function codeBlock(code: string, lang?: string): string {
  const label = lang ? pc.dim(` ${lang}`) : "";
  const lines = highlight(code.replace(/\n$/, ""), lang).split("\n");
  return pc.dim("╭") + label + "\n" + lines.map((l) => pc.dim("│ ") + l).join("\n") + "\n" + pc.dim("╰");
}
