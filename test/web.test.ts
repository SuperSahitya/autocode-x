import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { ToolRegistry } from "../src/tools/index.js";
import { parseDuckDuckGo, parseDuckDuckGoLite, webFetchTool } from "../src/tools/web.js";
import { makeCtx, staticServer, tempDir } from "./helpers.js";

const registry = new ToolRegistry();

async function call(name: string, input: unknown, ctx = makeCtx(tempDir())) {
  const parsed = registry.parse({ type: "tool_call", id: "1", name, input });
  if ("error" in parsed) return { output: parsed.error, isError: true };
  return registry.execute(parsed.tool, parsed.input, ctx);
}

const article = `<!doctype html><html><head><title>Hooks Guide</title><script>trackEverything()</script></head>
<body>
  <nav><a href="/">Home</a> <a href="/blog">Blog</a> Site navigation menu</nav>
  <article>
    <h1>Using the State Hook<a href="#state" aria-label="anchor"></a></h1>
    <p>The State Hook lets you add React state to function components. ${"It keeps values between renders. ".repeat(12)}</p>
    <h2>Example</h2>
    <pre><code>const [count, setCount] = useState(0);</code></pre>
    <p>See the <a href="/docs/effects">Effect Hook</a> for side effects. ${"More detail about hooks. ".repeat(10)}</p>
  </article>
  <footer>Copyright footer text</footer>
</body></html>`;

let server: Awaited<ReturnType<typeof staticServer>>;
before(async () => {
  server = await staticServer({
    "/article": { type: "text/html; charset=utf-8", body: article },
    "/long.txt": { type: "text/plain", body: "x".repeat(50_000) + "THE END" },
    "/data.json": { type: "application/json", body: '{"ok":true}' },
    "/missing": { type: "text/plain", body: "gone", status: 410 },
    "/search": {
      type: "application/json",
      body: JSON.stringify({ results: [{ title: "Vite Guide", url: "https://vite.dev/guide/", content: "Getting started" }] }),
    },
  });
});
after(() => server.close());

test("web_fetch extracts the article as markdown", async () => {
  const r = await call("web_fetch", { url: `${server.url}/article` });
  assert.equal(r.isError, undefined, r.output);
  assert.match(r.output, /^# Hooks Guide\nURL: http/);
  assert.match(r.output, /## Example/);
  assert.match(r.output, /```\nconst \[count, setCount\] = useState\(0\);\n```/);
  assert.ok(r.output.includes(`[Effect Hook](${server.url}/docs/effects)`), "relative links become absolute");
  assert.doesNotMatch(r.output, /trackEverything|Site navigation|Copyright footer/);
  assert.doesNotMatch(r.output, /\[\]\(/, "empty anchor links are dropped");
});

test("web_fetch pages long content and reuses the cached page", async () => {
  const ctx = makeCtx(tempDir());
  let r = await call("web_fetch", { url: `${server.url}/long.txt` }, ctx);
  assert.match(r.output, /Call again with offset=40000/);
  r = await call("web_fetch", { url: `${server.url}/long.txt`, offset: 40000 }, ctx);
  assert.match(r.output, /THE END$/);
  assert.equal(server.hits["/long.txt"], 1);
});

test("web_fetch returns JSON as-is and reports HTTP errors", async () => {
  assert.equal((await call("web_fetch", { url: `${server.url}/data.json` })).output, '{"ok":true}');
  const r = await call("web_fetch", { url: `${server.url}/missing` });
  assert.equal(r.isError, true);
  assert.match(r.output, /HTTP 410/);
  assert.match((await call("web_fetch", { url: "file:///etc/passwd" })).output, /Only http and https/);
});

test("web_fetch asks permission per host", () => {
  assert.equal(webFetchTool.permissionKey!({ url: "https://react.dev/learn" }), "web_fetch:react.dev");
});

test("web_search uses SearXNG when configured", async () => {
  const ctx = { ...makeCtx(tempDir()), searxngUrl: server.url };
  const r = await call("web_search", { query: "vite" }, ctx);
  assert.equal(r.output, "1. Vite Guide\n   https://vite.dev/guide/\n   Getting started");
});

test("DuckDuckGo parser skips ads and unwraps redirect links", async () => {
  const html = `
    <div class="result result--ad"><a class="result__a" href="https://ads.example">Ad</a></div>
    <div class="result"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fvite.dev%2Fguide%2F&rut=x">Getting Started | Vite</a>
      <a class="result__snippet">Next   Generation Frontend Tooling</a></div>
    <div class="result"><a class="result__a" href="https://react.dev/">React</a></div>`;
  assert.deepEqual(await parseDuckDuckGo(html), [
    { title: "Getting Started | Vite", url: "https://vite.dev/guide/", snippet: "Next Generation Frontend Tooling" },
    { title: "React", url: "https://react.dev/", snippet: "" },
  ]);
});

test("DuckDuckGo lite parser pairs links with snippets", async () => {
  const html = `<table>
    <tr><td>1.</td><td><a rel="nofollow" href="https://vite.dev/guide/" class='result-link'>Getting Started | Vite</a></td></tr>
    <tr><td></td><td class='result-snippet'>See create-<b>vite</b>   for templates</td></tr>
    <tr><td></td><td><span class='link-text'>vite.dev/guide/</span></td></tr>
    <tr><td>2.</td><td><a rel="nofollow" href="https://react.dev/" class='result-link'>React</a></td></tr>
  </table>`;
  assert.deepEqual(await parseDuckDuckGoLite(html), [
    { title: "Getting Started | Vite", url: "https://vite.dev/guide/", snippet: "See create-vite for templates" },
    { title: "React", url: "https://react.dev/", snippet: "" },
  ]);
});
