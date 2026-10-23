import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { AnthropicProvider } from "./providers/anthropic.js";
import { OpenAIProvider } from "./providers/openai.js";
import type { Provider } from "./types.js";

const ProfileSchema = z.object({
  provider: z.enum(["anthropic", "openai"]),
  model: z.string(),
  baseUrl: z.string().optional(),
  apiKey: z.string().optional(),
  apiKeyEnv: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  maxTokens: z.number().int().positive().optional(),
});
export type Profile = z.infer<typeof ProfileSchema>;

const ConfigSchema = z.object({
  defaultProfile: z.string().optional(),
  profiles: z.record(z.string(), ProfileSchema).default({}),
  /** "bash" | "powershell" | path, auto-detected when unset */
  shell: z.string().optional(),
});
export type Config = z.infer<typeof ConfigSchema>;

const BUILTIN_PROFILES: Record<string, Profile> = {
  anthropic: { provider: "anthropic", model: "claude-sonnet-5-5", apiKeyEnv: "ANTHROPIC_API_KEY" },
  ollama: { provider: "openai", model: "qwen2.5-coder:14b", baseUrl: "http://localhost:11434/v1" },
};

export const CONFIG_DIR = join(homedir(), ".autocode");

// Project-level config is not read: a repo shouldn't be able to redirect your API key.
export function loadConfig(): Config {
  const path = process.env.AUTOCODE_CONFIG ?? join(CONFIG_DIR, "config.json");
  let user: Config = { profiles: {} };
  if (existsSync(path)) {
    try {
      user = ConfigSchema.parse(JSON.parse(readFileSync(path, "utf8")));
    } catch (err) {
      throw new Error(`Invalid config at ${path}: ${(err as Error).message}`);
    }
  }
  return { ...user, profiles: { ...BUILTIN_PROFILES, ...user.profiles } };
}

export function resolveProfile(config: Config, name?: string, modelOverride?: string): { name: string; profile: Profile } {
  const chosen = name ?? config.defaultProfile ?? (process.env.ANTHROPIC_API_KEY ? "anthropic" : "ollama");
  const profile = config.profiles[chosen];
  if (!profile) {
    throw new Error(`Unknown profile "${chosen}". Available: ${Object.keys(config.profiles).join(", ")}`);
  }
  return { name: chosen, profile: modelOverride ? { ...profile, model: modelOverride } : profile };
}

export function createProvider(profile: Profile): Provider {
  const apiKey = profile.apiKey ?? (profile.apiKeyEnv ? process.env[profile.apiKeyEnv] : undefined);
  switch (profile.provider) {
    case "anthropic":
      if (!apiKey) {
        throw new Error(`No API key for Anthropic. Set ${profile.apiKeyEnv ?? "ANTHROPIC_API_KEY"} or add apiKey to the profile.`);
      }
      return new AnthropicProvider({ model: profile.model, apiKey, baseUrl: profile.baseUrl });
    case "openai":
      return new OpenAIProvider({
        model: profile.model,
        baseUrl: profile.baseUrl ?? "https://api.openai.com/v1",
        apiKey,
        headers: profile.headers,
      });
  }
}
