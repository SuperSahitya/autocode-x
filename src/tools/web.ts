import { z } from "zod";
import { ToolError, defineTool } from "./types.js";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const FETCH_TIMEOUT = 20_000;
const MAX_BODY_BYTES = 5 * 1024 * 1024;
const PAGE_CHARS = 40_000;

// only reads with an offset use the cache, so paging doesn't refetch but a fresh read
// (e.g. re-checking a dev server after an edit) always does
const pageCache = new Map<string, string>();
const CACHE_SIZE = 20;

async function readCapped(res: Response): Promise<string> {
  const reader = res.body!.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (bytes < MAX_BODY_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    bytes += value.length;
  }
  await reader.cancel().catch(() => {});
  return Buffer.concat(chunks).toString("utf8");
}

async function httpGet(url: string, signal: AbortSignal, init: RequestInit = {}): Promise<Response> {
  try {
    return await fetch(url, {
      ...init,
      redirect: "follow",
      signal: AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT)]),
      // keep headers minimal: extra browser-like headers (e.g. accept-language) get DuckDuckGo to serve a challenge
      headers: { "user-agent": USER_AGENT, ...init.headers },
    });
  } catch (err) {
    if (signal.aborted) throw err;
    const e = err as Error;
    throw new ToolError(`Request failed: ${e.name === "TimeoutError" ? "timed out" : ((e.cause as Error)?.message ?? e.message)}`);
  }
}

export async function htmlToMarkdown(html: string, url: string): Promise<{ title: string; markdown: string }> {
  // loaded lazily so they don't slow down startup
  const [{ parseHTML }, { Readability }, { default: TurndownService }] = await Promise.all([
    import("linkedom"),
    import("@mozilla/readability"),
    import("turndown"),
  ]);

  const { document } = parseHTML(html);
  const title = document.querySelector("title")?.textContent?.trim() ?? "";
  let content: string | undefined;
  try {
    type ReadabilityDoc = ConstructorParameters<typeof Readability>[0];
    const article = new Readability(document.cloneNode(true) as unknown as ReadabilityDoc).parse();
    if (article?.content && (article.textContent?.trim().length ?? 0) > 200) content = article.content;
  } catch {
    // fall back to the whole body below
  }
  if (!content) {
    for (const el of document.querySelectorAll("script, style, noscript, svg, nav, header, footer, iframe, form")) el.remove();
    content = document.body?.innerHTML ?? html;
  }

  const td = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-" });
  td.remove(["script", "style", "noscript"]);
  td.addRule("links", {
    filter: "a",
    replacement: (text, node) => {
      const href = (node as { getAttribute(name: string): string | null }).getAttribute("href");
      const label = text.trim();
      if (!label) return "";
      if (!href || href.startsWith("#") || href.startsWith("javascript:")) return label;
      try {
        return `[${label}](${new URL(href, url).href})`;
      } catch {
        return label;
      }
    },
  });
  td.addRule("images", { filter: "img", replacement: () => "" });

  const markdown = td.turndown(content ?? "").replace(/\n{3,}/g, "\n\n").trim();
  return { title, markdown };
}

async function loadPage(url: string, signal: AbortSignal, useCache: boolean): Promise<string> {
  const cached = useCache ? pageCache.get(url) : undefined;
  if (cached) return cached;

  const res = await httpGet(url, signal);
  if (!res.ok) throw new ToolError(`HTTP ${res.status} ${res.statusText} for ${url}`);
  const type = res.headers.get("content-type") ?? "";
  const body = await readCapped(res);
  let text: string;
  if (type.includes("html")) {
    const { title, markdown } = await htmlToMarkdown(body, res.url || url);
    text = `${title ? `# ${title}\n` : ""}URL: ${res.url || url}\n\n${markdown}`;
  } else if (/text\/|json|xml|javascript|yaml|toml/.test(type) || !type) {
    text = body;
  } else {
    throw new ToolError(`Unsupported content type "${type}" for ${url}`);
  }

  pageCache.delete(url);
  pageCache.set(url, text);
  if (pageCache.size > CACHE_SIZE) pageCache.delete(pageCache.keys().next().value!);
  return text;
}

export const webFetchTool = defineTool({
  name: "web_fetch",
  kind: "network",
  description:
    "Fetch a URL and return its main content as markdown (HTML is cleaned up with Readability; text and JSON are " +
    `returned as-is). Returns up to ${PAGE_CHARS} characters; use offset to read further. ` +
    "Use it to read documentation, READMEs, changelogs, or check a local dev server.",
  schema: z.object({
    url: z.string().describe("http(s) URL"),
    offset: z.number().int().min(0).optional().describe("Character offset to continue reading from"),
  }),
  summarize: (i) => i.url + (i.offset ? ` @${i.offset}` : ""),
  permissionKey: (i) => {
    try {
      return `web_fetch:${new URL(i.url).host}`;
    } catch {
      return undefined;
    }
  },
  async run({ url, offset = 0 }, ctx) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new ToolError(`Invalid URL: ${url}`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new ToolError("Only http and https URLs are supported.");

    const text = await loadPage(parsed.href, ctx.signal, offset > 0);
    if (offset >= text.length) throw new ToolError(`offset ${offset} is past the end (${text.length} chars).`);
    const end = Math.min(text.length, offset + PAGE_CHARS);
    let out = text.slice(offset, end);
    if (end < text.length) out += `\n\n[Showing chars ${offset}-${end} of ${text.length}. Call again with offset=${end} for more.]`;
    return out;
  },
});

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export async function parseDuckDuckGo(html: string): Promise<SearchResult[]> {
  const { parseHTML } = await import("linkedom");
  const { document } = parseHTML(html);
  const results: SearchResult[] = [];
  for (const el of document.querySelectorAll(".result")) {
    if (el.classList.contains("result--ad")) continue;
    const link = el.querySelector(".result__a");
    let href = link?.getAttribute("href");
    if (!link || !href) continue;
    // sometimes links go through a redirect: //duckduckgo.com/l/?uddg=<encoded target>
    if (href.includes("duckduckgo.com/l/")) {
      const target = new URL(href, "https://duckduckgo.com").searchParams.get("uddg");
      if (target) href = target;
    }
    results.push({
      title: link.textContent?.trim() ?? "",
      url: href,
      snippet: el.querySelector(".result__snippet")?.textContent?.trim().replace(/\s+/g, " ") ?? "",
    });
  }
  return results;
}

// the lite page is a table: a row with the link, then a row with its snippet
export async function parseDuckDuckGoLite(html: string): Promise<SearchResult[]> {
  const { parseHTML } = await import("linkedom");
  const { document } = parseHTML(html);
  const results: SearchResult[] = [];
  for (const row of document.querySelectorAll("tr")) {
    const link = row.querySelector("a.result-link");
    const snippet = row.querySelector("td.result-snippet");
    if (link?.getAttribute("href")) {
      results.push({ title: link.textContent?.trim() ?? "", url: link.getAttribute("href")!, snippet: "" });
    } else if (snippet && results.length) {
      results.at(-1)!.snippet = snippet.textContent?.trim().replace(/\s+/g, " ") ?? "";
    }
  }
  return results;
}

const DDG_ENDPOINTS = [
  { url: "https://html.duckduckgo.com/html/", parse: parseDuckDuckGo },
  { url: "https://lite.duckduckgo.com/lite/", parse: parseDuckDuckGoLite },
];

async function searchDuckDuckGo(query: string, signal: AbortSignal): Promise<SearchResult[]> {
  for (const endpoint of DDG_ENDPOINTS) {
    const res = await httpGet(endpoint.url, signal, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ q: query }),
    });
    const html = await readCapped(res);
    const results = await endpoint.parse(html);
    // rate-limited clients get a 202 and a challenge page instead of results; try the next endpoint
    const blocked = !results.length && (res.status !== 200 || /anomaly|challenge/i.test(html));
    if (!blocked) return results;
  }
  throw new ToolError("DuckDuckGo refused the search (rate limited). Try again later, or set searxngUrl in ~/.autocode/config.json.");
}

async function searchSearxng(baseUrl: string, query: string, signal: AbortSignal): Promise<SearchResult[]> {
  const url = `${baseUrl.replace(/\/+$/, "")}/search?${new URLSearchParams({ q: query, format: "json" })}`;
  const res = await httpGet(url, signal, { headers: { accept: "application/json" } });
  if (!res.ok) throw new ToolError(`SearXNG returned HTTP ${res.status}. Is the JSON format enabled on the instance?`);
  const data = (await res.json()) as { results?: { title: string; url: string; content?: string }[] };
  return (data.results ?? []).map((r) => ({ title: r.title, url: r.url, snippet: r.content ?? "" }));
}

export const webSearchTool = defineTool({
  name: "web_search",
  kind: "read",
  description:
    "Search the web and return titles, URLs and snippets. Use web_fetch to read a result. " +
    "Useful for current docs, library versions, error messages and APIs you're unsure about.",
  schema: z.object({
    query: z.string().min(1).describe("Search query"),
    max_results: z.number().int().min(1).max(20).optional(),
  }),
  summarize: (i) => i.query,
  async run({ query, max_results = 8 }, ctx) {
    const results = ctx.searxngUrl
      ? await searchSearxng(ctx.searxngUrl, query, ctx.signal)
      : await searchDuckDuckGo(query, ctx.signal);
    if (!results.length) return "No results.";
    return results
      .slice(0, max_results)
      .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ""}`)
      .join("\n");
  },
});
