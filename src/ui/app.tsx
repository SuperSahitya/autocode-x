import { Box, Static, Text, useApp, useInput } from "ink";
import pc from "picocolors";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Agent, AgentEvents } from "../agent/agent.js";
import { COMPACT_MARKER } from "../agent/context.js";
import type { Decision, PermissionRequest, Permissions } from "../agent/permissions.js";
import type { Message, ToolResultPart } from "../types.js";
import { formatLiveOutput, formatTokens, formatToolHeader, formatToolResult, oneLine } from "./format.js";
import { InputBox } from "./input.js";
import { renderMarkdown } from "./markdown.js";

/** Lets the agent's permission check open a prompt in the UI. */
export class PermissionBridge {
  handler?: (req: PermissionRequest) => Promise<Decision>;
  ask = (req: PermissionRequest): Promise<Decision> => (this.handler ? this.handler(req) : Promise.resolve("deny"));
}

export interface AppProps {
  agent: Agent;
  permissions: Permissions;
  bridge: PermissionBridge;
  banner: string;
  modelLabel(): string;
  /** returns a label for the new model; throws if the spec is invalid */
  switchModel(spec: string): string;
  initialPrompt?: string;
  mcpStatus?(): string;
}

type EntryData =
  | { kind: "banner" | "user" | "assistant" | "info" | "error"; text: string }
  | { kind: "tool"; header: string; result: string };
type Entry = EntryData & { id: number };

interface LiveTool {
  header: string;
  output: string;
}

const COMMANDS = ["/help", "/undo", "/compact", "/clear", "/model", "/models", "/ps", "/mcp", "/yolo", "/usage", "/exit"];

const HELP = `Commands
  /undo           revert the files changed by the last turn and drop it from the conversation
  /compact        summarize older messages now to free up context (one request)
  /model [spec]   show or switch: <model>, <profile> or <profile>:<model>
  /models         list models from the current provider
  /ps             list background processes
  /mcp            list MCP servers and their tools
  /clear          start a new conversation
  /yolo           toggle auto-approve for writes and commands
  /usage          requests, tokens and context used by this session
  /exit           quit
Keys
  enter submits · \\ then enter for a new line · ↑↓ history · tab completes commands
  esc or ctrl+c interrupts the agent · ctrl+c twice quits`;

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const INPUT_KEYS = ["path", "command", "url", "query", "pattern", "id"];

/** Rebuild the scrollback for a resumed session from its messages. */
export function transcriptEntries(messages: Message[]): EntryData[] {
  const results = new Map<string, ToolResultPart>();
  for (const m of messages) for (const p of m.content) if (p.type === "tool_result") results.set(p.id, p);

  const out: EntryData[] = [];
  for (const m of messages) {
    for (const p of m.content) {
      if (p.type === "text" && p.text.startsWith(COMPACT_MARKER)) out.push({ kind: "info", text: "Earlier messages were compacted." });
      else if (p.type === "text" && p.text.trim()) out.push({ kind: m.role === "user" ? "user" : "assistant", text: p.text });
      if (p.type === "tool_call") {
        const input = (p.input ?? {}) as Record<string, unknown>;
        const key = INPUT_KEYS.find((k) => typeof input[k] === "string");
        const r = results.get(p.id);
        out.push({
          kind: "tool",
          header: formatToolHeader(p, key ? String(input[key]) : ""),
          result: r ? formatToolResult(p, { output: r.content, isError: r.isError }) : "",
        });
      }
    }
  }
  return out;
}

/** Split off the paragraphs that are complete (not inside an open code fence) so they can move to scrollback. */
export function splitCompleted(text: string): [done: string, rest: string] {
  let idx = text.lastIndexOf("\n\n");
  while (idx > 0) {
    const fences = (text.slice(0, idx).match(/^\s*(```|~~~)/gm) ?? []).length;
    if (fences % 2 === 0) return [text.slice(0, idx), text.slice(idx + 2)];
    idx = text.lastIndexOf("\n\n", idx - 1);
  }
  return ["", text];
}

export function App({ agent, permissions, bridge, banner, modelLabel, switchModel, initialPrompt, mcpStatus }: AppProps) {
  const { exit } = useApp();
  const nextId = useRef(0);
  const [entries, setEntries] = useState<Entry[]>(() => {
    const initial: EntryData[] = [{ kind: "banner", text: banner }];
    if (agent.messages.length) {
      initial.push(...transcriptEntries(agent.messages), { kind: "info", text: "Resumed session. /undo still works for its turns." });
    }
    return initial.map((e) => ({ ...e, id: nextId.current++ }));
  });
  const [running, setRunning] = useState(false);
  const [pending, setPending] = useState<{ req: PermissionRequest; resolve(d: Decision): void }>();
  const [history, setHistory] = useState<string[]>([]);
  const [queue, setQueue] = useState<string[]>([]);
  const [, setTick] = useState(0);
  const [frame, setFrame] = useState(0);
  const [exitHint, setExitHint] = useState(false);
  const [label, setLabel] = useState(modelLabel());
  const [yolo, setYolo] = useState(permissions.mode === "auto");

  // streaming state lives in refs and is flushed to the screen on a short timer
  const text = useRef("");
  const live = useRef(new Map<string, LiveTool>());
  const abort = useRef<AbortController>(undefined);
  const flushTimer = useRef<NodeJS.Timeout>(undefined);
  const turnStart = useRef(0);
  const lastCtrlC = useRef(0);

  const push = useCallback((...items: EntryData[]) => {
    setEntries((prev) => [...prev, ...items.map((e) => ({ ...e, id: nextId.current++ }))]);
  }, []);

  const flushText = (all: boolean) => {
    const [done, rest] = all ? [text.current, ""] : splitCompleted(text.current);
    if (done.trim()) push({ kind: "assistant", text: done });
    text.current = rest;
  };

  const schedule = () => {
    flushTimer.current ??= setTimeout(() => {
      flushTimer.current = undefined;
      flushText(false);
      setTick((t) => t + 1);
    }, 50);
  };

  useEffect(() => {
    bridge.handler = (req) => new Promise((resolve) => setPending({ req, resolve }));
    return () => {
      bridge.handler = undefined;
    };
  }, [bridge]);

  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setFrame((f) => f + 1), 100);
    return () => clearInterval(t);
  }, [running]);

  const interrupt = () => {
    abort.current?.abort();
    if (pending) {
      pending.resolve("deny");
      setPending(undefined);
    }
  };

  const runTurn = async (input: string) => {
    push({ kind: "user", text: input });
    setRunning(true);
    turnStart.current = Date.now();
    const ac = new AbortController();
    abort.current = ac;

    const events: AgentEvents = {
      onText: (delta) => {
        text.current += delta;
        schedule();
      },
      onTextDiscarded: () => {
        text.current = "";
        schedule();
      },
      onToolStart: (call, summary) => {
        flushText(true);
        live.current.set(call.id, { header: formatToolHeader(call, summary), output: "" });
        schedule();
      },
      onToolOutput: (call, chunk) => {
        const tool = live.current.get(call.id);
        if (tool) tool.output = (tool.output + chunk).slice(-20_000);
        schedule();
      },
      onNotice: (message) => push({ kind: "info", text: pc.yellow(message) }),
      onToolEnd: (call, result) => {
        const header = live.current.get(call.id)?.header ?? formatToolHeader(call, "");
        live.current.delete(call.id);
        push({ kind: "tool", header, result: formatToolResult(call, result) });
        schedule();
      },
    };

    try {
      await agent.run(input, events, ac.signal);
    } catch (err) {
      flushText(true);
      push({ kind: "error", text: (err as Error).message });
    } finally {
      flushText(true);
      live.current.clear();
      abort.current = undefined;
      if (ac.signal.aborted) push({ kind: "info", text: "Interrupted. What should I do instead?" });
      setRunning(false);
    }
  };

  const command = async (input: string) => {
    const [cmd, ...rest] = input.split(/\s+/);
    const arg = rest.join(" ");
    const info = (t: string) => push({ kind: "info", text: t });
    switch (cmd) {
      case "/help":
        return info(HELP);
      case "/undo": {
        if (running) return info("Wait for the current turn to finish, or press esc first.");
        try {
          const r = await agent.undo();
          if (!r) return info("Nothing to undo.");
          const files = r.files.length
            ? `Restored ${r.files.length} file${r.files.length === 1 ? "" : "s"}: ${r.files.slice(0, 8).join(", ")}${r.files.length > 8 ? ", ..." : ""}`
            : "No files had changed.";
          return info(`Undid "${oneLine(r.checkpoint.label, 60)}". ${files}`);
        } catch (err) {
          return push({ kind: "error", text: `Undo failed: ${(err as Error).message}` });
        }
      }
      case "/compact": {
        if (running) return info("Wait for the current turn to finish, or press esc first.");
        const ac = new AbortController();
        abort.current = ac;
        setRunning(true);
        try {
          const r = await agent.compact({ onNotice: (m) => push({ kind: "info", text: pc.yellow(m) }) }, ac.signal);
          if (!r && !ac.signal.aborted) info("Nothing to compact yet.");
        } finally {
          abort.current = undefined;
          setRunning(false);
        }
        return;
      }
      case "/clear":
        agent.clear();
        return info("Conversation cleared.");
      case "/model":
        try {
          if (arg) setLabel(switchModel(arg));
          return info(`Model: ${arg ? modelLabel() : label}`);
        } catch (err) {
          return push({ kind: "error", text: (err as Error).message });
        }
      case "/models":
        try {
          const models = await agent.provider.listModels();
          return info(models.map((m) => (m === agent.provider.model ? `* ${m}` : `  ${m}`)).join("\n"));
        } catch (err) {
          return push({ kind: "error", text: `Could not list models: ${(err as Error).message}` });
        }
      case "/ps": {
        const procs = agent.processes.list();
        return info(
          procs.length
            ? procs.map((p) => `${p.id}  ${p.running ? "running" : `exited ${p.exitCode}`}  ${p.command}`).join("\n")
            : "No background processes.",
        );
      }
      case "/mcp":
        return info(mcpStatus?.() ?? "No MCP servers configured.");
      case "/yolo":
        permissions.mode = permissions.mode === "auto" ? "ask" : "auto";
        setYolo(permissions.mode === "auto");
        return info(permissions.mode === "auto" ? "Auto-approve on: writes and commands run without asking." : "Auto-approve off.");
      case "/usage": {
        const u = agent.totalUsage;
        return info(
          `Session: ${u.requests ?? 0} requests, ${u.inputTokens} input, ${u.outputTokens} output, ${u.cacheReadTokens} cache read tokens.\n` +
            `Context: ~${agent.contextTokens()} of ${agent.contextLimit} tokens.`,
        );
      }
      case "/exit":
      case "/quit":
        return exit();
      default:
        return push({ kind: "error", text: `Unknown command ${cmd}. Try /help.` });
    }
  };

  const submit = (input: string) => {
    setHistory((h) => (h.at(-1) === input ? h : [...h, input]));
    setExitHint(false);
    if (input.startsWith("/")) return void command(input);
    if (running) return setQueue((q) => [...q, input]);
    void runTurn(input);
  };

  // run queued messages once the current turn ends
  useEffect(() => {
    if (running || !queue.length) return;
    const [next, ...rest] = queue;
    setQueue(rest);
    void runTurn(next!);
  }, [running, queue]);

  useEffect(() => {
    if (initialPrompt) submit(initialPrompt);
  }, []);

  const onCtrlC = (hadText: boolean) => {
    if (running) return interrupt();
    if (hadText) return;
    const now = Date.now();
    if (now - lastCtrlC.current < 2000) return exit();
    lastCtrlC.current = now;
    setExitHint(true);
  };

  const usage = agent.totalUsage;
  const status = [
    label,
    usage.inputTokens || usage.outputTokens ? `↑${formatTokens(usage.inputTokens)} ↓${formatTokens(usage.outputTokens)}` : "",
    yolo ? pc.yellow("yolo") : "",
  ]
    .filter(Boolean)
    .join(" · ");

  const liveTools = [...live.current.values()];
  const streaming = text.current.trim();

  return (
    <Box flexDirection="column">
      <Static items={entries}>{(e) => <EntryView key={e.id} entry={e} />}</Static>

      {streaming && (
        <Box marginTop={1} marginLeft={2}>
          <Text>{renderMarkdown(streaming)}</Text>
        </Box>
      )}

      {liveTools.map((t, i) => (
        <Box key={i} flexDirection="column" marginTop={1}>
          <Text>{t.header.replace(/^\S+/, pc.yellow(SPINNER[frame % SPINNER.length]!))}</Text>
          {t.output.trim() && <Text>{formatLiveOutput(t.output)}</Text>}
        </Box>
      ))}

      {running && !pending && !streaming && liveTools.length === 0 && (
        <Box marginTop={1}>
          <Text>
            {pc.cyan(SPINNER[frame % SPINNER.length]!)} {pc.dim(`Thinking ${Math.floor((Date.now() - turnStart.current) / 1000)}s · esc to interrupt`)}
          </Text>
        </Box>
      )}

      {pending && (
        <PermissionPrompt
          request={pending.req}
          onAnswer={(d) => {
            pending.resolve(d);
            setPending(undefined);
          }}
          onInterrupt={interrupt}
        />
      )}

      {queue.length > 0 && <Text>{pc.dim(`  queued: ${queue.map((q) => oneLine(q, 40)).join(", ")}`)}</Text>}

      <Box marginTop={1} flexDirection="column">
        <InputBox
          active={!pending}
          history={history}
          commands={COMMANDS}
          onSubmit={submit}
          onCtrlC={onCtrlC}
          onEscape={() => running && interrupt()}
        />
        <Text>
          {"  "}
          {pc.dim(status)}
          {exitHint ? pc.dim("  ·  press ctrl+c again to exit") : running ? pc.dim("  ·  esc to interrupt") : ""}
        </Text>
      </Box>
    </Box>
  );
}

function EntryView({ entry }: { entry: Entry }) {
  switch (entry.kind) {
    case "banner":
      return <Text>{entry.text}</Text>;
    case "user":
      return (
        <Box marginTop={1}>
          <Text>{pc.dim("❯ ") + pc.bold(entry.text)}</Text>
        </Box>
      );
    case "assistant":
      return (
        <Box marginTop={1} marginLeft={2}>
          <Text>{renderMarkdown(entry.text)}</Text>
        </Box>
      );
    case "tool":
      return (
        <Box flexDirection="column" marginTop={1}>
          <Text>{entry.header}</Text>
          <Text>{entry.result}</Text>
        </Box>
      );
    case "info":
      return (
        <Box marginTop={1}>
          <Text>{pc.dim(entry.text)}</Text>
        </Box>
      );
    case "error":
      return (
        <Box marginTop={1}>
          <Text>{pc.red(`✖ ${entry.text}`)}</Text>
        </Box>
      );
  }
}

function describeAlways(key: string): string {
  if (key.startsWith("bash:")) return `${key.slice(5)} *`;
  if (key.startsWith("web_fetch:")) return `any page on ${key.slice(10)}`;
  return key;
}

function PermissionPrompt({
  request,
  onAnswer,
  onInterrupt,
}: {
  request: PermissionRequest;
  onAnswer(d: Decision): void;
  onInterrupt(): void;
}) {
  const options: { label: string; key: string; decision: Decision }[] = [
    { label: "Yes", key: "y", decision: "allow" },
    ...(request.alwaysKey
      ? [{ label: `Yes, and don't ask again for ${describeAlways(request.alwaysKey)}`, key: "a", decision: "allow_always" as const }]
      : []),
    { label: "No, tell the agent what to do instead", key: "n", decision: "deny" },
  ];
  const [selected, setSelected] = useState(0);

  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === "c")) return onInterrupt();
    if (key.upArrow) return setSelected((s) => Math.max(0, s - 1));
    if (key.downArrow) return setSelected((s) => Math.min(options.length - 1, s + 1));
    if (key.return) return onAnswer(options[selected]!.decision);
    const byKey = options.find((o) => o.key === input.toLowerCase());
    if (byKey) onAnswer(byKey.decision);
  });

  const verb = request.tool.kind === "exec" ? "Run" : request.tool.kind === "network" ? "Fetch" : "Allow";
  return (
    <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor="yellow" paddingX={1}>
      <Text>
        {pc.yellow(`${verb} ${request.tool.name}?`)} {pc.dim(oneLine(request.summary, 200))}
      </Text>
      {options.map((o, i) => (
        <Text key={o.key}>
          {i === selected ? pc.cyan(`❯ ${o.label}`) : `  ${o.label}`} {pc.dim(`(${o.key})`)}
        </Text>
      ))}
    </Box>
  );
}
