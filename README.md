# autocode

A coding agent for the terminal. Works with Gemini, Anthropic, Groq, Ollama and any OpenAI-compatible server.

## Setup

```
npm install
npm run build
npm link
```

Set the key for the provider you use: `GEMINI_API_KEY`, `ANTHROPIC_API_KEY` or `GROQ_API_KEY`. Ollama needs none.

## Usage

```
autocode                              # interactive
autocode "add a dark mode toggle"     # interactive, starting with a message
autocode -m gemini                    # pick a profile
autocode -m gemini:gemini-3.6-flash   # profile and model
autocode -p "fix the build" -y        # one-shot, auto-approve
autocode --resume                     # continue the last session in this directory
autocode --sessions                   # list saved sessions
autocode --list-profiles
```

Commands: `/undo`, `/compact`, `/model`, `/models`, `/ps`, `/mcp`, `/clear`, `/yolo`, `/usage`, `/help`, `/exit`. Esc or Ctrl+C interrupts the agent; end a line with `\` for a new line.

`/undo` restores files to before the last turn that changed them. Snapshots live in a separate git repo under `~/.autocode/checkpoints`, so your own repo is never touched. Sessions are saved to `~/.autocode/sessions`.

Old tool output is trimmed at 50% of the context limit and the conversation is summarized at 80%. A map of the code, built with tree-sitter and ranked with PageRank, is added to the system prompt (TypeScript, JavaScript, Python, Go, Rust, Java).

## Config

Built-in profiles: `gemini`, `anthropic`, `groq`, `ollama`. Add or override them in `~/.autocode/config.json`:

```json
{
  "defaultProfile": "gemini",
  "profiles": {
    "ollama": { "provider": "openai", "model": "qwen2.5-coder:32b", "baseUrl": "http://localhost:11434/v1" },
    "openrouter": {
      "provider": "openai",
      "model": "...",
      "baseUrl": "https://openrouter.ai/api/v1",
      "apiKeyEnv": "OPENROUTER_API_KEY"
    }
  }
}
```

`provider` is `gemini`, `anthropic` or `openai`. `AGENTS.md` in the working directory is added to the system prompt.

Profiles also take `requestsPerMinute`, to wait rather than hit a known rate limit, and `contextLimit` in tokens. Rate limits and dropped streams are retried on their own. `"repoMap": false` turns off the code map.

MCP servers over stdio go at the top level of the config, with an optional `env`. Their tools ask for permission like shell commands do:

```json
{
  "mcpServers": {
    "files": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/dir"]
    }
  }
}
```

Web search uses DuckDuckGo by default. To use your own SearXNG instance instead, add `"searxngUrl": "http://localhost:8080"` (JSON output must be enabled on the instance).

## Development

```
npm run dev
npm test
npm run typecheck
```

Benchmarks and results are in [bench](bench/README.md).
