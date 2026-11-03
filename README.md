# autocode

A coding agent for the terminal. Works with Gemini, Anthropic, Groq, Ollama and any OpenAI-compatible server.

## Setup

```
npm install
npm run build
npm link
```

Set `GEMINI_API_KEY`, `ANTHROPIC_API_KEY` or `GROQ_API_KEY`. Ollama doesn't need one.

## Usage

```
autocode                              # interactive
autocode "add a dark mode toggle"     # start with a message
autocode -m gemini:gemini-3.6-flash   # pick a profile and model
autocode -p "fix the build" -y        # one-shot, auto-approve
autocode --resume                     # continue the last session here
```

Commands: `/undo`, `/compact`, `/model`, `/models`, `/ps`, `/mcp`, `/clear`, `/yolo`, `/usage`, `/help`, `/exit`.

## Config

`~/.autocode/config.json`:

```json
{
  "defaultProfile": "ollama",
  "profiles": {
    "ollama": { "provider": "openai", "model": "qwen2.5-coder:32b", "baseUrl": "http://localhost:11434/v1" }
  },
  "mcpServers": {
    "files": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/dir"] }
  }
}
```

`provider` is `gemini`, `anthropic` or `openai`. Profiles also take `apiKeyEnv`, `requestsPerMinute` and `contextLimit`.

`"repoMap": false` turns off the code map. `"searxngUrl"` uses your own SearXNG for web search instead of DuckDuckGo.

`AGENTS.md` in the working directory is added to the system prompt.

## Development

```
npm run dev
npm test
npm run typecheck
```

Benchmarks are in [bench](bench/README.md).
