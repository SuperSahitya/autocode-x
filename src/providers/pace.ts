import type { ChatRequest, Provider, StreamEvent } from "../types.js";
import { sleep } from "./sse.js";

const WINDOW_MS = 60_000;

/** Holds requests back to stay under a known per-minute limit, instead of finding it by getting a 429. */
export class PacedProvider implements Provider {
  private readonly sent: number[] = [];

  constructor(
    private readonly inner: Provider,
    private readonly requestsPerMinute: number,
    private readonly now = Date.now,
  ) {}

  get name() {
    return this.inner.name;
  }

  get model() {
    return this.inner.model;
  }

  listModels() {
    return this.inner.listModels();
  }

  async *stream(req: ChatRequest): AsyncGenerator<StreamEvent> {
    await this.acquire(req);
    yield* this.inner.stream(req);
  }

  private async acquire(req: ChatRequest): Promise<void> {
    while (this.sent.length && this.now() - this.sent[0]! >= WINDOW_MS) this.sent.shift();
    if (this.sent.length >= this.requestsPerMinute) {
      const wait = this.sent[0]! + WINDOW_MS - this.now();
      req.onWait?.(`Pacing to ${this.requestsPerMinute} requests a minute, waiting ${Math.ceil(wait / 1000)}s.`);
      await sleep(wait, req.signal);
      return this.acquire(req);
    }
    this.sent.push(this.now());
  }
}
