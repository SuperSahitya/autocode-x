import { ProviderError, postWithRetry } from "../providers/sse.js";

const MODEL = "gemini-embedding-2";
const BATCH_SIZE = 100;
export const EMBEDDING_DIMENSIONS = 768;

export type EmbedInput = { kind: "query"; text: string } | { kind: "document"; title?: string; text: string };

export interface Embedder {
  embed(inputs: EmbedInput[], signal?: AbortSignal): Promise<number[][]>;
}

// this model takes the task as part of the text rather than as a task_type field
const withTask = (input: EmbedInput) =>
  input.kind === "query" ? `task: question answering | query: ${input.text}` : `title: ${input.title || "none"} | text: ${input.text}`;

export class GeminiEmbedder implements Embedder {
  private readonly baseUrl: string;

  constructor(
    private readonly apiKey: string,
    baseUrl = "https://generativelanguage.googleapis.com",
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  async embed(inputs: EmbedInput[], signal?: AbortSignal): Promise<number[][]> {
    const vectors: number[][] = [];
    for (let i = 0; i < inputs.length; i += BATCH_SIZE) {
      const requests = inputs.slice(i, i + BATCH_SIZE).map((input) => ({
        model: `models/${MODEL}`,
        content: { parts: [{ text: withTask(input) }] },
        outputDimensionality: EMBEDDING_DIMENSIONS,
      }));
      const res = await postWithRetry(`${this.baseUrl}/v1beta/models/${MODEL}:batchEmbedContents`, { "x-goog-api-key": this.apiKey }, { requests }, { signal });
      const { embeddings } = (await res.json()) as { embeddings?: { values: number[] }[] };
      if (embeddings?.length !== requests.length) throw new ProviderError(`Expected ${requests.length} embeddings, got ${embeddings?.length ?? 0}.`);
      vectors.push(...embeddings.map((e) => e.values));
    }
    return vectors;
  }
}
