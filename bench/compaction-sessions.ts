// Scripted coding sessions on this repo. The file reads are real; the requests, errors and decisions are made up,
// with values arbitrary enough that a model can't guess them. Facts are spread evenly from start to end.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Message } from "../src/types.js";
import { seeded, hash } from "./lib.js";

export type FactKind = "user_constraint" | "assistant_decision" | "tool_output" | "file_changed" | "command" | "file_content";

export interface Fact {
  kind: FactKind;
  question: string;
  answer: string;
}

type Beat =
  | { user: string }
  | { say: string }
  | { read: string }
  | { bash: string; output: string; isError?: boolean }
  | { edit: string; change: string };

export interface Scenario {
  name: string;
  beats: Beat[];
  facts: Fact[];
}

const ROOT = join(import.meta.dirname, "..");
// half reads, which trimming can stub out, and half writes, whose content stays in the conversation
const TARGET_CHARS = 196_000; // about 49k tokens

function sourceFiles(): string[] {
  const walk = (dir: string): string[] =>
    readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((e) => {
      const path = `${dir}/${e.name}`;
      if (e.isDirectory()) return walk(path);
      return /\.tsx?$/.test(e.name) ? [path] : [];
    });
  return [...walk("src"), ...walk("test")].sort();
}

export function buildMessages(scenario: Scenario): Message[] {
  const rng = seeded(hash(scenario.name));
  const files = sourceFiles()
    .map((f) => ({ f, r: rng() }))
    .sort((a, b) => a.r - b.r)
    .map((x) => x.f);

  const messages: Message[] = [];
  let id = 0;
  const pushUser = (part: { type: "text"; text: string } | { type: "tool_result"; id: string; content: string; isError?: boolean }) => {
    const last = messages.at(-1);
    if (last?.role === "user") last.content.push(part);
    else messages.push({ role: "user", content: [part] });
  };
  const tool = (name: string, input: unknown, content: string, isError?: boolean) => {
    const callId = `call_${++id}`;
    messages.push({ role: "assistant", content: [{ type: "tool_call", id: callId, name, input }] });
    pushUser({ type: "tool_result", id: callId, content, isError });
  };
  const read = (path: string) => {
    const content = readFileSync(join(ROOT, path), "utf8");
    tool("read_file", { path }, content);
    return content.length;
  };

  let fillerChars = 0;
  let next = 0;
  const pad = () => {
    const path = files[next % files.length]!;
    if (next++ % 2) {
      const content = readFileSync(join(ROOT, path), "utf8");
      tool("write_file", { path, content }, `Wrote ${path}`);
      fillerChars += content.length;
    } else fillerChars += read(path);
  };
  scenario.beats.forEach((beat, i) => {
    if ("user" in beat) {
      // the model always answers before the user speaks again
      if (messages.at(-1)?.role === "user") messages.push({ role: "assistant", content: [{ type: "text", text: "Understood so far, carrying on." }] });
      pushUser({ type: "text", text: beat.user });
    } else if ("say" in beat) {
      messages.push({ role: "assistant", content: [{ type: "text", text: beat.say }] });
      // keeps roles alternating when the next beat is the model again
      pushUser({ type: "text", text: "Sounds good, continue." });
    } else if ("read" in beat) {
      fillerChars += read(beat.read);
    } else if ("bash" in beat) {
      tool("bash", { command: beat.bash }, beat.output, beat.isError);
    } else {
      tool("edit_file", { path: beat.edit, description: beat.change }, `Edited ${beat.edit}: ${beat.change}`);
    }
    // padding after each beat, so the beats end up spread across the whole session
    const wanted = ((i + 1) / scenario.beats.length) * TARGET_CHARS;
    while (fillerChars < wanted) pad();
  });
  messages.push({ role: "assistant", content: [{ type: "text", text: "That's everything so far." }] });
  return messages;
}

export const SCENARIOS: Scenario[] = [
  {
    name: "pacer-burst-guard",
    beats: [
      { user: "Add burst protection to the pacer for our Groq profile. Hard limit from me: never above 27 requests per minute, the shared org key gets suspended past that." },
      { read: "src/providers/sse.ts" },
      { bash: "npx tsx --test test/retry.test.ts", output: "not ok 4 - pacer holds the window\n  AssertionError [ERR_ASSERTION]: pacer window drifted by 1843ms (expected < 250ms)", isError: true },
      { say: "I rejected a token bucket here. I'm going with the sliding window plus a new option called burstGuardMs, defaulting to 4200." },
      { edit: "src/providers/pace.ts", change: "add burstGuardMs and hold back requests inside the guard" },
      { edit: "src/config.ts", change: "accept burstGuardMs in the profile schema" },
      { user: "The ticket for this is OPS-4471, put that in the changelog entry rather than the commit message." },
      { bash: "AUTOCODE_PACE_TRACE=1 npx tsx scripts/pace-soak.ts --minutes 3", output: "soak finished: 81 requests, 0 rejected, peak 26/min" },
    ],
    facts: [
      { kind: "user_constraint", question: "What is the hard requests-per-minute limit I gave for the Groq profile?", answer: "\\b27\\b" },
      { kind: "user_constraint", question: "What is the ticket number for the pacer work?", answer: "4471" },
      { kind: "file_content", question: "What value does MAX_WAIT_MS have in src/providers/sse.ts?", answer: "120[_,]?000|120 ?s|2 min" },
      { kind: "tool_output", question: "By how many milliseconds did the failing retry test say the pacer window drifted?", answer: "1843" },
      { kind: "tool_output", question: "What peak per-minute rate did the soak test report?", answer: "\\b26\\b" },
      { kind: "assistant_decision", question: "What is the name of the new pacer option?", answer: "burstGuardMs" },
      { kind: "assistant_decision", question: "What default value was chosen for the new pacer option?", answer: "4200" },
      { kind: "file_changed", question: "Which file got the logic that holds requests back inside the guard?", answer: "pace\\.ts" },
      { kind: "file_changed", question: "Which file was changed to accept the new option in the profile schema?", answer: "config\\.ts" },
      { kind: "command", question: "Which environment variable turned on tracing for the soak test?", answer: "AUTOCODE_PACE_TRACE" },
    ],
  },
  {
    name: "mcp-reconnect",
    beats: [
      { user: "MCP servers die overnight on my machine and never come back. Make the client reconnect, but give up after 9 attempts because a looping server once filled my disk with logs." },
      { read: "src/tools/mcp.ts" },
      { bash: "AUTOCODE_MCP_LOG=trace node dist/index.js -p hello", output: "[mcp] postgres: server exited with code 137: FATAL: role \"svc_reader_7\" does not exist", isError: true },
      { say: "The exit is the server being OOM-killed, so I'll restart it. I'm adding a backoff table called RECONNECT_STEPS with a ceiling of 75 seconds." },
      { user: "Whatever you do, don't reconnect during a tool call. Mark it failed with the code MCP_GONE_17 so I can grep for it." },
      { edit: "src/tools/mcp.ts", change: "add RECONNECT_STEPS and reconnect after a crash" },
      { edit: "src/ui/app.tsx", change: "show reconnect attempts in /mcp" },
      { bash: "npx tsx --test test/mcp.test.ts", output: "not ok 7 - reconnects after a crash\n  Error: expected 3 restarts, saw 5 after 6120ms", isError: true },
      { say: "The extra restarts came from the close event firing twice, so I'm guarding that with a flag named restartQueued." },
    ],
    facts: [
      { kind: "user_constraint", question: "After how many reconnect attempts did I say the client must give up?", answer: "\\b9\\b|nine" },
      { kind: "user_constraint", question: "What error code did I ask for on a tool call that's cut off by a server crash?", answer: "MCP_GONE_17" },
      { kind: "file_content", question: "What value does MAX_OUTPUT_CHARS have in src/tools/mcp.ts?", answer: "20[_,]?000|20k" },
      { kind: "tool_output", question: "Which Postgres role did the crashed server complain about?", answer: "svc_reader_7" },
      { kind: "tool_output", question: "How many restarts did the failing reconnect test actually see?", answer: "\\b5\\b|five" },
      { kind: "assistant_decision", question: "What is the ceiling of the reconnect backoff, in seconds?", answer: "\\b75\\b" },
      { kind: "assistant_decision", question: "What is the flag called that guards against the double close event?", answer: "restartQueued" },
      { kind: "file_changed", question: "Which file was changed to show reconnect attempts to the user?", answer: "app\\.tsx" },
      { kind: "file_changed", question: "Which file holds RECONNECT_STEPS?", answer: "mcp\\.ts" },
      { kind: "command", question: "Which environment variable did I use to get MCP trace logs?", answer: "AUTOCODE_MCP_LOG" },
    ],
  },
  {
    name: "web-fetch-cache",
    beats: [
      { user: "web_fetch keeps serving stale docs pages. Cache entries must expire after 840 seconds, that's what our docs CDN uses." },
      { bash: "curl -sI https://docs.internal.test/guide | grep -i etag", output: 'etag: W/"b71f-qx93"' },
      { read: "src/tools/web.ts" },
      { say: "I'll revalidate with the ETag instead of only using a timer. The new cache class will be called PageLedger." },
      { edit: "src/tools/web.ts", change: "replace the page cache with PageLedger and revalidate using If-None-Match" },
      { user: "Never send cookies on these requests, security review SEC-2286 flagged that." },
      { bash: "npx tsx --test test/web.test.ts", output: "not ok 3 - revalidates with the etag\n  AssertionError: expected status 304, got 412 from /guide?rev=58", isError: true },
      { say: "The 412 was the weak ETag being sent in the wrong header. I'm stripping the W/ prefix in a helper called bareEtag." },
      { edit: "src/util/text.ts", change: "add the bareEtag helper" },
      { bash: "WEB_CACHE_DIR=/tmp/pl npm run dev -- -p 'fetch the guide twice'", output: "PageLedger: 1 miss, 1 revalidated, 2211 bytes saved" },
    ],
    facts: [
      { kind: "user_constraint", question: "After how many seconds did I say cache entries must expire?", answer: "\\b840\\b" },
      { kind: "user_constraint", question: "Which security review flagged sending cookies?", answer: "SEC-2286" },
      { kind: "file_content", question: "What value does PAGE_CHARS have in src/tools/web.ts?", answer: "40[_,]?000|40k" },
      { kind: "tool_output", question: "What ETag did the docs server return for the guide page?", answer: "b71f-qx93" },
      { kind: "tool_output", question: "What status code did the failing revalidation test get instead of 304?", answer: "\\b412\\b" },
      { kind: "tool_output", question: "How many bytes did the final run say were saved?", answer: "2211" },
      { kind: "assistant_decision", question: "What is the new cache class called?", answer: "PageLedger" },
      { kind: "assistant_decision", question: "What is the helper that strips the W/ prefix called?", answer: "bareEtag" },
      { kind: "file_changed", question: "Which file was the helper for stripping the weak ETag prefix added to?", answer: "text\\.ts" },
      { kind: "command", question: "Which environment variable set the cache directory in the final run?", answer: "WEB_CACHE_DIR" },
    ],
  },
  {
    name: "checkpoint-long-paths",
    beats: [
      { user: "/undo breaks on our monorepo on Windows because of long paths. Support paths up to 1024 characters, that's our deepest generated folder." },
      { read: "src/session/checkpoints.ts" },
      { bash: "git -C C:/work/mono status", output: "fatal: cannot create directory at 'packages/gen-3381/out': Filename too long", isError: true },
      { say: "I'm passing core.longpaths on every shadow git call through one wrapper, shadowGit, rather than editing each call." },
      { edit: "src/session/checkpoints.ts", change: "route every git call through shadowGit" },
      { user: "Leave the snapshots folder name alone, our backup job greps for it. And the max snapshot size stays at 650 MB." },
      { bash: "npx tsx --test test/checkpoints.test.ts", output: "not ok 2 - restores deleted files\n  Error: missing packages/gen-3381/out/z9.bin after restore (restored 412 of 413)", isError: true },
      { say: "The file was skipped by the global ignore, so restore now has to run with core.excludesFile set to an empty file named .shadow-noignore." },
      { edit: "src/session/store.ts", change: "record the shadow repo format version in the session" },
      { bash: "SHADOW_DEBUG=2 npx tsx scripts/undo-soak.ts --turns 40", output: "undo soak: 40 turns, 40 restores, slowest 3170ms" },
    ],
    facts: [
      { kind: "user_constraint", question: "What is the path length I said must be supported?", answer: "1024" },
      { kind: "user_constraint", question: "What maximum snapshot size did I say must stay?", answer: "\\b650\\b" },
      { kind: "file_content", question: "What is the second entry of the EXCLUDES list in src/session/checkpoints.ts?", answer: "dist" },
      { kind: "tool_output", question: "Which generated folder number appeared in the Filename too long error?", answer: "3381" },
      { kind: "tool_output", question: "How many of the files did the failing restore test restore, and which file was missing?", answer: "z9\\.bin|\\b412\\b" },
      { kind: "tool_output", question: "What was the slowest restore in the undo soak, in milliseconds?", answer: "3170" },
      { kind: "assistant_decision", question: "What is the wrapper around shadow git calls called?", answer: "shadowGit" },
      { kind: "assistant_decision", question: "What is the empty ignore file called?", answer: "shadow-noignore" },
      { kind: "file_changed", question: "Which file was changed to record the shadow repo format version?", answer: "store\\.ts" },
      { kind: "command", question: "Which environment variable turned on debug output in the undo soak?", answer: "SHADOW_DEBUG" },
    ],
  },
  {
    name: "markdown-tables",
    beats: [
      { user: "Wide markdown tables wrap badly in the terminal. Cut cells at 38 characters, and use the character ¦ to mark a cut because our log scraper already understands it." },
      { read: "src/ui/markdown.ts" },
      { bash: "npx tsx scripts/render-sample.ts docs/wide.md", output: "row 17 overflowed the terminal by 64 columns at width 132", isError: true },
      { say: "Measuring by string length is the bug, emoji count as two columns. I'll add a function named cellWidth instead of pulling in a library." },
      { edit: "src/ui/markdown.ts", change: "measure with cellWidth and cut long cells" },
      { user: "No new npm packages for this. We have an audit, ticket AUD-9052, and each new package needs sign-off." },
      { bash: "npx tsx --test test/ui.test.tsx", output: "not ok 1 - markdown renders\n  Expected '│ a¦ │' but got '│ a… │' at line 88", isError: true },
      { say: "That test expected the old ellipsis. I also found right-aligned columns were lost, so alignment now lives in a map called columnAlign." },
      { edit: "src/ui/render.ts", change: "pass the terminal width down to the table renderer" },
      { bash: "FORCE_WIDTH=96 npx tsx scripts/render-sample.ts docs/wide.md", output: "rendered 41 rows, 0 overflowed" },
    ],
    facts: [
      { kind: "user_constraint", question: "At how many characters did I say table cells must be cut?", answer: "\\b38\\b" },
      { kind: "user_constraint", question: "What is the audit ticket number?", answer: "AUD-9052" },
      { kind: "file_content", question: "How many times is the horizontal rule character repeated in src/ui/markdown.ts?", answer: "\b40\b" },
      { kind: "tool_output", question: "Which row overflowed in the first render attempt?", answer: "\\b17\\b" },
      { kind: "tool_output", question: "How many rows did the final render produce?", answer: "\\b41\\b" },
      { kind: "assistant_decision", question: "What is the new width-measuring function called?", answer: "cellWidth" },
      { kind: "assistant_decision", question: "What is the map that holds column alignment called?", answer: "columnAlign" },
      { kind: "file_changed", question: "Which file was changed to pass the terminal width down?", answer: "render\\.ts" },
      { kind: "file_changed", question: "Which file holds the cell cutting logic?", answer: "markdown\\.ts" },
      { kind: "command", question: "Which environment variable forced the terminal width in the last run?", answer: "FORCE_WIDTH" },
    ],
  },
  {
    name: "repomap-kotlin",
    beats: [
      { user: "Add Kotlin to the repo map, our Android team wants it. The grammar has to stay under 3 MB because the package has a size budget." },
      { read: "src/tools/repomap.ts" },
      { bash: "ls -la node_modules/tree-sitter-wasms/out | grep kotlin", output: "-rw-r--r-- 1 dev dev 2764118 tree-sitter-kotlin.wasm" },
      { say: "It fits. Kotlin files parse with a query I'm calling KOTLIN_QUERY, and it skips anything under a folder named generated-kt." },
      { edit: "src/tools/repomap.ts", change: "add KOTLIN_QUERY and the .kt and .kts extensions" },
      { edit: "tsup.config.ts", change: "copy the Kotlin grammar into dist" },
      { user: "Test on our app, it's the repo named droid-ledger. And don't let the Kotlin work slow startup past 1400ms on it." },
      { bash: "npx tsx scripts/map-time.ts ../droid-ledger", output: "parsed 2875 files in 1612ms; query error at offset 233: impossible pattern", isError: true },
      { say: "The class_declaration capture was wrong for this grammar version, so I fixed the query. Parse time is down because I also cap Kotlin files at 90000 bytes." },
      { bash: "MAP_PROFILE=1 npx tsx scripts/map-time.ts ../droid-ledger", output: "parsed 2875 files in 1188ms; 0 query errors" },
    ],
    facts: [
      { kind: "user_constraint", question: "What size limit did I give for the grammar?", answer: "\\b3 ?MB" },
      { kind: "user_constraint", question: "What is the name of the repo I said to test on?", answer: "droid-ledger" },
      { kind: "file_content", question: "What value does MAX_SYMBOLS_PER_FILE have in src/tools/repomap.ts?", answer: "\\b12\\b" },
      { kind: "tool_output", question: "What was the exact size in bytes of the Kotlin grammar file?", answer: "2764118" },
      { kind: "tool_output", question: "At what offset did the query error occur?", answer: "\\b233\\b" },
      { kind: "tool_output", question: "How long did parsing take in the final run, in milliseconds?", answer: "1188" },
      { kind: "assistant_decision", question: "What folder name do Kotlin files get skipped under?", answer: "generated-kt" },
      { kind: "assistant_decision", question: "What byte cap was put on Kotlin files?", answer: "90[_,]?000|90 ?k" },
      { kind: "file_changed", question: "Which file was changed to copy the Kotlin grammar into dist?", answer: "tsup\\.config" },
      { kind: "command", question: "Which environment variable was set for the last timing run?", answer: "MAP_PROFILE" },
    ],
  },
];
