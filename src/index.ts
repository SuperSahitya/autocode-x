import { join, resolve } from "node:path";
import { Command } from "commander";
import pc from "picocolors";
import { Agent } from "./agent/agent.js";
import { DEFAULT_CONTEXT_LIMIT } from "./agent/context.js";
import { Permissions, type Decision, type PermissionRequest } from "./agent/permissions.js";
import { buildSystemPrompt } from "./agent/prompt.js";
import { CONFIG_DIR, createProvider, loadConfig, resolveModelSpec } from "./config.js";
import { Checkpoints } from "./session/checkpoints.js";
import { SessionStore, type Session } from "./session/store.js";
import { ToolRegistry } from "./tools/index.js";
import { detectShell } from "./tools/shell.js";
import { logo } from "./ui/logo.js";
import { Renderer } from "./ui/render.js";

const VERSION = "0.4.0";

interface CliOptions {
  print?: string;
  model?: string;
  yolo?: boolean;
  cwd?: string;
  maxSteps?: string;
  listProfiles?: boolean;
  resume?: string | boolean;
  sessions?: boolean;
}

async function main(): Promise<void> {
  const program = new Command()
    .name("autocode")
    .description("A minimal, fast, multi-provider coding agent")
    .version(VERSION)
    .argument("[prompt...]", "start the session with this message")
    .option("-p, --print <prompt>", "run one prompt non-interactively, print the answer, and exit")
    .option("-m, --model <spec>", "profile, profile:model, or a model id for the default profile")
    .option("-y, --yolo", "auto-approve file writes and shell commands")
    .option("-C, --cwd <dir>", "working directory")
    .option("--max-steps <n>", "max model round-trips per request", "100")
    .option("-r, --resume [id]", "resume a saved session (default: the latest in this directory)")
    .option("--sessions", "list saved sessions for this directory and exit")
    .option("--list-profiles", "list configured profiles and exit")
    .parse();
  const opts = program.opts<CliOptions>();
  const initialPrompt = program.args.join(" ").trim() || undefined;

  const config = loadConfig();
  if (opts.listProfiles) {
    for (const [name, p] of Object.entries(config.profiles)) {
      console.log(`${pc.bold(name.padEnd(12))} ${p.provider.padEnd(10)} ${p.model}${p.baseUrl ? pc.dim(`  ${p.baseUrl}`) : ""}`);
    }
    return;
  }

  const cwd = resolve(opts.cwd ?? process.cwd());
  const store = new SessionStore(join(CONFIG_DIR, "sessions"));
  if (opts.sessions) {
    const sessions = store.list(cwd);
    if (!sessions.length) console.log("No saved sessions for this directory.");
    for (const s of sessions) console.log(`${pc.bold(s.id)}  ${pc.dim(new Date(s.updatedAt).toLocaleString())}  ${s.title}`);
    return;
  }

  let resumed: Session | undefined;
  if (opts.resume) {
    const id = typeof opts.resume === "string" ? opts.resume : undefined;
    resumed = store.load(cwd, id);
    if (!resumed) throw new Error(id ? `No session "${id}". Run autocode --sessions to list them.` : "No saved session for this directory.");
  }
  // a resumed session keeps its model unless -m says otherwise
  const sessionModel = resumed && config.profiles[resumed.profile] ? `${resumed.profile}:${resumed.model}` : undefined;
  let current = resolveModelSpec(config, opts.model ?? sessionModel);
  const session = resumed ?? store.create(cwd, current.name, current.profile.model);
  const shell = detectShell(config.shell);
  const headless = opts.print !== undefined;

  let ask: (req: PermissionRequest) => Promise<Decision> = (req) => {
    renderer.error(`Denied ${req.tool.name} (non-interactive mode; pass --yolo to allow writes and commands).`);
    return Promise.resolve("deny");
  };
  const permissions = new Permissions(opts.yolo ? "auto" : "ask", (req) => ask(req));
  const renderer = new Renderer();

  const agent = new Agent({
    provider: createProvider(current.profile),
    tools: new ToolRegistry(),
    permissions,
    system: buildSystemPrompt(cwd, shell),
    cwd,
    shell,
    maxTokens: current.profile.maxTokens,
    contextLimit: current.profile.contextLimit,
    maxSteps: Number(opts.maxSteps),
    searxngUrl: config.searxngUrl,
    checkpoints: new Checkpoints(cwd, join(CONFIG_DIR, "checkpoints")),
    onTurnEnd: () => {
      Object.assign(session, agent.state(), { profile: current.name, model: current.profile.model });
      store.save(session);
    },
  });
  if (resumed) agent.load(resumed);
  process.on("exit", () => agent.dispose());
  const resumeHint = () =>
    session.messages.length ? pc.dim(`Resume this session with: autocode --resume ${session.id}`) : "";

  if (headless) {
    const ac = new AbortController();
    process.on("SIGINT", () => ac.abort());
    renderer.startTurn();
    try {
      await agent.run(opts.print!, renderer.events, ac.signal);
    } finally {
      renderer.endTurn();
      if (resumeHint()) process.stderr.write(resumeHint() + "\n");
    }
    return;
  }

  // loaded only for interactive sessions, so -p stays fast
  const [{ render }, { createElement }, { App, PermissionBridge }] = await Promise.all([
    import("ink"),
    import("react"),
    import("./ui/app.js"),
  ]);
  const bridge = new PermissionBridge();
  ask = bridge.ask;

  const modelLabel = () => `${current.name} · ${current.profile.model}`;
  const art = logo();
  const banner =
    (art ? `\n${art}\n\n` : `\n${pc.bold(pc.cyan("autocode"))} `) +
    `${pc.dim(`v${VERSION}`)}  ${modelLabel()} ${pc.dim("·")} ${pc.dim(cwd)}\n` +
    pc.dim("/help for commands · esc to interrupt");
  const app = render(
    createElement(App, {
      agent,
      permissions,
      bridge,
      banner,
      initialPrompt,
      modelLabel,
      switchModel: (spec: string) => {
        const next = resolveModelSpec(config, spec, current.name);
        agent.provider = createProvider(next.profile);
        agent.contextLimit = next.profile.contextLimit ?? DEFAULT_CONTEXT_LIMIT;
        current = next;
        return modelLabel();
      },
    }),
    { exitOnCtrlC: false },
  );
  await app.waitUntilExit();
  if (resumeHint()) console.log(resumeHint());
  process.exit(0);
}

main().catch((err: Error) => {
  console.error(pc.red(`✖ ${err.message}`));
  process.exit(1);
});
