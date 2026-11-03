import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { AnthropicProvider } from "./providers/anthropic.js";
import { GeminiEmbedder, type Embedder } from "./memory/embed.js";
import { GeminiProvider } from "./providers/gemini.js";
import { OpenAIProvider } from "./providers/openai.js";
import { PacedProvider } from "./providers/pace.js";
import type { Provider } from "./types.js";

const ProfileSchema = z.object({
  provider: z.enum(["anthropic", "openai", "gemini"]),
  model: z.string(),
  baseUrl: z.string().optional(),
  apiKey: z.string().optional(),
  apiKeyEnv: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  maxTokens: z.number().int().positive().optional(),
  /** waits instead of exceeding this, for APIs with a known rate limit */
  requestsPerMinute: z.number().int().positive().optional(),
  /** tokens to work within before trimming and compacting */
  contextLimit: z.number().int().positive().optional(),
});
export type Profile = z.infer<typeof ProfileSchema>;

const ConfigSchema = z.object({
  defaultProfile: z.string().optional(),
  profiles: z.record(z.string(), ProfileSchema).default({}),
  /** "bash" | "powershell" | path, auto-detected when unset */
  shell: z.string().optional(),
  /** SearXNG instance for web_search instead of DuckDuckGo */
  searxngUrl: z.string().optional(),
  /** false stops adding a map of the code to the system prompt; the repo_map tool stays available */
  repoMap: z.boolean().optional(),
  /** false turns off saved notes and searching past sessions */
  memory: z.boolean().optional(),
  /** send memory to Gemini for embeddings; defaults to on only while using a Gemini profile */
  memoryEmbeddings: z.boolean().optional(),
  mcpServers: z
    .record(
      z.string(),
      z.object({
        command: z.string(),
        args: z.array(z.string()).optional(),
        env: z.record(z.string(), z.string()).optional(),
      }),
    )
    .optional(),
});
export type Config = z.infer<typeof ConfigSchema>;

const BUILTIN_PROFILES: Record<string, Profile> = {
  anthropic: { provider: "anthropic", model: "claude-sonnet-5-5", apiKeyEnv: "ANTHROPIC_API_KEY", contextLimit: 150_000 },
  gemini: { provider: "gemini", model: "gemini-3.5-flash-lite", apiKeyEnv: "GEMINI_API_KEY" },
  groq: {
    provider: "openai",
    model: "openai/gpt-oss-120b",
    baseUrl: "https://api.groq.com/openai/v1",
    apiKeyEnv: "GROQ_API_KEY",
  },
  ollama: { provider: "openai", model: "qwen2.5-coder:14b", baseUrl: "http://localhost:11434/v1", contextLimit: 32_000 },
};

export const CONFIG_DIR = process.env.AUTOCODE_HOME ?? join(homedir(), ".autocode");

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

export interface ResolvedProfile {
  name: string;
  profile: Profile;
}

function defaultProfileName(config: Config): string {
  if (config.defaultProfile) return config.defaultProfile;
  const withKey = ["anthropic", "gemini", "groq"].find((n) => {
    const env = config.profiles[n]?.apiKeyEnv;
    return env && process.env[env];
  });
  return withKey ?? "ollama";
}

/**
 * Accepts "profile", "profile:model" or a bare model id (applied to the current profile).
 * Ollama-style ids like "qwen2.5-coder:14b" stay intact because "qwen2.5-coder" isn't a profile.
 */
export function resolveModelSpec(config: Config, spec: string | undefined, current?: string): ResolvedProfile {
  let name = current ?? defaultProfileName(config);
  let model: string | undefined;
  if (spec) {
    const colon = spec.indexOf(":");
    if (config.profiles[spec]) name = spec;
    else if (colon > 0 && config.profiles[spec.slice(0, colon)]) {
      name = spec.slice(0, colon);
      model = spec.slice(colon + 1);
    } else model = spec;
  }
  const profile = config.profiles[name];
  if (!profile) throw new Error(`Unknown profile "${name}". Available: ${Object.keys(config.profiles).join(", ")}`);
  return { name, profile: model ? { ...profile, model } : profile };
}

export function createProvider(profile: Profile): Provider {
  const provider = createAdapter(profile);
  return profile.requestsPerMinute ? new PacedProvider(provider, profile.requestsPerMinute) : provider;
}

const apiKeyOf = (profile: Profile) => profile.apiKey ?? (profile.apiKeyEnv ? process.env[profile.apiKeyEnv] : undefined);

// off for other providers, so choosing a local model doesn't quietly send your sessions to Google
export function createEmbedder(config: Config, current: Profile): Embedder | undefined {
  if (!(config.memoryEmbeddings ?? current.provider === "gemini")) return undefined;
  const profile = current.provider === "gemini" ? current : config.profiles.gemini;
  const apiKey = profile && apiKeyOf(profile);
  return apiKey ? new GeminiEmbedder(apiKey, profile.baseUrl) : undefined;
}

function createAdapter(profile: Profile): Provider {
  const apiKey = apiKeyOf(profile);
  if (!apiKey && profile.apiKeyEnv) {
    throw new Error(`No API key: set ${profile.apiKeyEnv} or add apiKey to the profile.`);
  }
  switch (profile.provider) {
    case "anthropic":
      return new AnthropicProvider({ model: profile.model, apiKey: apiKey!, baseUrl: profile.baseUrl });
    case "gemini":
      return new GeminiProvider({ model: profile.model, apiKey: apiKey!, baseUrl: profile.baseUrl });
    case "openai":
      return new OpenAIProvider({
        model: profile.model,
        baseUrl: profile.baseUrl ?? "https://api.openai.com/v1",
        apiKey,
        headers: profile.headers,
      });
  }
}
