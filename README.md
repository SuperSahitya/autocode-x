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
autocode -m gemini                    # pick a profile
autocode -m gemini:gemini-3.6-flash   # profile and model
autocode -p "fix the build" -y        # one-shot, auto-approve
autocode --list-profiles
```

In the REPL: `/model`, `/models`, `/ps`, `/clear`, `/yolo`, `/usage`, `/help`, `/exit`. Ctrl+C interrupts the agent.

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

Web search uses DuckDuckGo by default. To use your own SearXNG instance instead, add `"searxngUrl": "http://localhost:8080"` (JSON output must be enabled on the instance).

## Development

```
npm run dev
npm test
npm run typecheck
```
