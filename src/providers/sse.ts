export interface SSEMessage {
  event?: string;
  data: string;
}

const STALL_MS = 180_000;
// longer than this and the limit is not a short rate window, so waiting isn't useful
const MAX_WAIT_MS = 120_000;
const MAX_RETRIES = 5;

export async function* parseSSE(body: ReadableStream<Uint8Array>, stallMs = STALL_MS): AsyncGenerator<SSEMessage> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffer = "";
  let event: string | undefined;
  let data: string[] = [];

  try {
    for (;;) {
      const { done, value } = await readChunk(reader, stallMs);
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        let line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);

        if (line === "") {
          if (data.length) yield { event, data: data.join("\n") };
          event = undefined;
          data = [];
        } else if (line.startsWith(":")) {
          // comment
        } else {
          const colon = line.indexOf(":");
          const field = colon === -1 ? line : line.slice(0, colon);
          let value = colon === -1 ? "" : line.slice(colon + 1);
          if (value.startsWith(" ")) value = value.slice(1);
          if (field === "event") event = value;
          else if (field === "data") data.push(value);
        }
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  if (data.length) yield { event, data: data.join("\n") };
}

async function readChunk(reader: ReadableStreamDefaultReader<Uint8Array>, stallMs: number) {
  let timer: NodeJS.Timeout | undefined;
  const stalled = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ProviderError(`No data from the model for ${stallMs / 1000}s.`, undefined, true)), stallMs);
  });
  try {
    return await Promise.race([reader.read(), stalled]);
  } catch (err) {
    if (err instanceof ProviderError || (err as Error).name === "AbortError") throw err;
    throw new ProviderError(`Connection lost: ${(err as Error).message}`, undefined, true);
  } finally {
    clearTimeout(timer);
  }
}

export class ProviderError extends Error {
  /** retryable: it failed mid-stream, so the whole model call can safely be repeated */
  constructor(
    message: string,
    readonly status?: number,
    readonly retryable = false,
  ) {
    super(message);
  }
}

/** The stream closed with no sign of a finished response, which HTTP alone doesn't reveal. */
export const cutOff = () => new ProviderError("The model's response was cut off.", undefined, true);

export interface RetryOptions {
  signal?: AbortSignal;
  onRetry?(message: string): void;
  stallMs?: number;
}

export async function postWithRetry(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  opts: RetryOptions = {},
): Promise<Response> {
  const { signal, onRetry, stallMs = STALL_MS } = opts;
  for (let attempt = 0; ; attempt++) {
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(new Error(`no response after ${stallMs / 1000}s`)), stallMs);
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal,
      });
    } catch (err) {
      if (signal?.aborted) throw err;
      const code = ((err as Error).cause as { code?: string } | undefined)?.code;
      // nothing listening, retrying won't help
      if (code === "ECONNREFUSED") {
        throw new ProviderError(`Could not connect to ${new URL(url).origin}. Is the server running? (Ollama: \`ollama serve\`)`);
      }
      const reason = code ?? (err as Error).message;
      if (attempt >= MAX_RETRIES) throw new ProviderError(`Request to ${new URL(url).origin} failed: ${reason}`);
      const wait = backoff(attempt);
      onRetry?.(`Request failed (${reason}), retrying in ${formatWait(wait)} (${attempt + 1}/${MAX_RETRIES}).`);
      await sleep(wait, signal);
      continue;
    } finally {
      clearTimeout(timer);
    }
    if (res.ok && res.body) return res;

    const text = await res.text().catch(() => "");
    const message = `HTTP ${res.status}: ${errorMessage(text)}`;
    const retryable = res.status === 429 || res.status === 529 || res.status >= 500;
    if (!retryable || attempt >= MAX_RETRIES) throw new ProviderError(message, res.status);
    if (res.status === 429 && isQuotaExhausted(text)) {
      throw new ProviderError(`Quota used up, retrying won't help until it resets. ${message}`, res.status);
    }
    const hint = retryHint(res.headers.get("retry-after"), text);
    if (hint !== undefined && hint > MAX_WAIT_MS) {
      throw new ProviderError(`Rate limited for another ${formatWait(hint)}. ${message}`, res.status);
    }
    // rate limits reset on a window of seconds, so short waits only waste attempts
    const wait = hint !== undefined ? hint + 500 + Math.random() * 500 : backoff(attempt, res.status === 429);
    const reason = res.status === 429 ? "Rate limited" : `Server error (HTTP ${res.status})`;
    onRetry?.(`${reason}, retrying in ${formatWait(wait)} (${attempt + 1}/${MAX_RETRIES}).`);
    await sleep(wait, signal);
  }
}

/** How long the server asked us to wait, in ms: the Retry-After header, Gemini's retryDelay, or "try again in 7.6s". */
export function retryHint(header: string | null, body: string): number | undefined {
  if (header) {
    const seconds = Number(header);
    if (seconds >= 0 && !Number.isNaN(seconds)) return seconds * 1000;
    const date = Date.parse(header);
    if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  }
  const delay = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(body);
  if (delay) return Number(delay[1]) * 1000;
  const again = /try again in (?:(\d+)m)?(\d+(?:\.\d+)?)(ms|s)/i.exec(body);
  if (again) return Number(again[1] ?? 0) * 60_000 + Number(again[2]) * (again[3] === "ms" ? 1 : 1000);
  return undefined;
}

// not plain "billing": Gemini's per-minute limits also tell you to check your plan and billing details
export const isQuotaExhausted = (body: string) => /PerDay|per day|insufficient_quota|billing_hard_limit/i.test(body);

function errorMessage(body: string): string {
  try {
    const message = JSON.parse(body)?.error?.message;
    if (typeof message === "string") return message.slice(0, 500);
  } catch {
    // not JSON, show it as is
  }
  return body.slice(0, 500);
}

export async function getJSON(url: string, headers: Record<string, string>): Promise<any> {
  const res = await fetch(url, { headers }).catch((err: Error) => {
    throw new ProviderError(`Request to ${url} failed: ${err.message}`);
  });
  if (!res.ok) throw new ProviderError(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`, res.status);
  return res.json();
}

export const backoff = (attempt: number, rateLimited = false) =>
  Math.min((rateLimited ? 5000 : 1000) * 2 ** attempt, rateLimited ? 60_000 : 15_000) + Math.random() * 250;

const formatWait = (ms: number) => `${Math.ceil(ms / 1000)}s`;

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal!.reason);
    };
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function parseToolArgs(raw: string): unknown {
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return { __invalid_json: raw };
  }
}
