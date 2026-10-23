import { resolve } from "node:path";
import { Command } from "commander";
import pc from "picocolors";
import { Agent } from "./agent/agent.js";
import { Permissions, type Decision, type PermissionRequest } from "./agent/permissions.js";
import { buildSystemPrompt } from "./agent/prompt.js";
import { createProvider, loadConfig, resolveProfile } from "./config.js";
import { ToolRegistry } from "./tools/index.js";
import { detectShell } from "./tools/shell.js";
import { Renderer } from "./ui/render.js";
import { Repl } from "./ui/repl.js";

const VERSION = "0.1.0";

interface CliOptions {
  print?: string;
  profile?: string;
  model?: string;
  yolo?: boolean;
  cwd?: string;
  maxSteps?: string;
  listProfiles?: boolean;
}

async function main(): Promise<void> {
  const program = new Command()
    .name("autocode")
    .description("A minimal, fast, multi-provider coding agent")
    .version(VERSION)
    .option("-p, --print <prompt>", "run one prompt non-interactively, print the answer, and exit")
    .option("--profile <name>", "model profile from ~/.autocode/config.json (built-in: anthropic, ollama)")
    .option("-m, --model <model>", "override the profile's model")
    .option("-y, --yolo", "auto-approve file writes and shell commands")
    .option("-C, --cwd <dir>", "working directory")
    .option("--max-steps <n>", "max model round-trips per request", "100")
    .option("--list-profiles", "list configured profiles and exit")
    .parse();
  const opts = program.opts<CliOptions>();

  const config = loadConfig();
  if (opts.listProfiles) {
    for (const [name, p] of Object.entries(config.profiles)) {
      console.log(`${pc.bold(name.padEnd(14))} ${p.provider.padEnd(10)} ${p.model}${p.baseUrl ? pc.dim(`  ${p.baseUrl}`) : ""}`);
    }
    return;
  }

  const cwd = resolve(opts.cwd ?? process.cwd());
  const { name: profileName, profile } = resolveProfile(config, opts.profile, opts.model);
  const shell = detectShell(config.shell);
  const headless = opts.print !== undefined;

  const renderer = headless ? new Renderer(process.stdout, process.stderr) : new Renderer();
  let repl: Repl | undefined;
  const prompt = (req: PermissionRequest): Promise<Decision> => {
    if (repl) return repl.askPermission(req);
    renderer.error(`Denied ${req.tool.name} (non-interactive mode; pass --yolo to allow writes and commands).`);
    return Promise.resolve("deny");
  };
  const permissions = new Permissions(opts.yolo ? "auto" : "ask", prompt);

  const agent = new Agent({
    provider: createProvider(profile),
    tools: new ToolRegistry(),
    permissions,
    system: buildSystemPrompt(cwd, shell),
    cwd,
    shell,
    maxTokens: profile.maxTokens,
    maxSteps: Number(opts.maxSteps),
  });

  if (headless) {
    const ac = new AbortController();
    process.on("SIGINT", () => ac.abort());
    renderer.startTurn();
    try {
      await agent.run(opts.print!, renderer.events, ac.signal);
    } finally {
      renderer.endTurn();
    }
    return;
  }

  repl = new Repl({
    agent,
    permissions,
    renderer,
    setModel: (model) => {
      agent.provider = createProvider({ ...profile, model });
    },
  });
  const banner =
    `${pc.bold(pc.cyan("autocode"))} ${pc.dim(`v${VERSION}`)}  ` +
    `${profileName} ${pc.dim("·")} ${profile.model} ${pc.dim("·")} ${pc.dim(cwd)}` +
    (opts.yolo ? `  ${pc.yellow("[yolo]")}` : "");
  await repl.start(banner);
}

main().catch((err: Error) => {
  console.error(pc.red(`✖ ${err.message}`));
  process.exit(1);
});
