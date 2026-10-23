# autocode

A coding agent for the terminal. Works with Anthropic, OpenAI and OpenAI-compatible servers (Ollama, Groq, OpenRouter, ...).

## Setup

```
npm install
npm run build
npm link
```

## Usage

```
autocode                          # interactive
autocode --profile ollama         # use a profile
autocode -m <model>               # override the model
autocode -p "fix the build" -y    # one-shot, auto-approve
```

In the REPL: `/help`, `/clear`, `/model`, `/yolo`, `/usage`, `/exit`. Ctrl+C interrupts the agent.

## Config

`~/.autocode/config.json`:

```json
{
  "defaultProfile": "ollama",
  "profiles": {
    "ollama": { "provider": "openai", "model": "qwen2.5-coder:14b", "baseUrl": "http://localhost:11434/v1" },
    "openrouter": {
      "provider": "openai",
      "model": "...",
      "baseUrl": "https://openrouter.ai/api/v1",
      "apiKeyEnv": "OPENROUTER_API_KEY"
    }
  }
}
```

Built-in profiles: `anthropic` (needs `ANTHROPIC_API_KEY`) and `ollama`. `AGENTS.md` in the working directory is added to the system prompt.

## Development

```
npm run dev
npm test
npm run typecheck
```
