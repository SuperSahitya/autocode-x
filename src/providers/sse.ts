export interface SSEMessage {
  event?: string;
  data: string;
}

export async function* parseSSE(body: ReadableStream<Uint8Array>): AsyncGenerator<SSEMessage> {
  const decoder = new TextDecoder();
  let buffer = "";
  let event: string | undefined;
  let data: string[] = [];

  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
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
  if (data.length) yield { event, data: data.join("\n") };
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryable = false,
  ) {
    super(message);
  }
}

export async function postWithRetry(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal?: AbortSignal,
  maxRetries = 3,
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      if (signal?.aborted) throw err;
      const code = ((err as Error).cause as { code?: string } | undefined)?.code;
      // nothing listening, retrying won't help
      if (code === "ECONNREFUSED") {
        throw new ProviderError(`Could not connect to ${new URL(url).origin}. Is the server running? (Ollama: \`ollama serve\`)`);
      }
      if (attempt >= maxRetries) {
        throw new ProviderError(`Request to ${url} failed: ${code ?? (err as Error).message}`);
      }
      await sleep(backoff(attempt), signal);
      continue;
    }
    if (res.ok && res.body) return res;

    const text = await res.text().catch(() => "");
    const retryable = res.status === 429 || res.status === 529 || res.status >= 500;
    if (!retryable || attempt >= maxRetries) {
      throw new ProviderError(`HTTP ${res.status}: ${text.slice(0, 500)}`, res.status, retryable);
    }
    const retryAfter = Number(res.headers.get("retry-after"));
    await sleep(retryAfter > 0 ? retryAfter * 1000 : backoff(attempt), signal);
  }
}

export async function getJSON(url: string, headers: Record<string, string>): Promise<any> {
  const res = await fetch(url, { headers }).catch((err: Error) => {
    throw new ProviderError(`Request to ${url} failed: ${err.message}`);
  });
  if (!res.ok) throw new ProviderError(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`, res.status);
  return res.json();
}

const backoff =(attempt: number) => Math.min(1000 * 2 ** attempt, 15_000) + Math.random() * 250;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(signal.reason);
    }, { once: true });
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
