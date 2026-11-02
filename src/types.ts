export interface TextPart {
  type: "text";
  text: string;
}

export interface ToolCallPart {
  type: "tool_call";
  id: string;
  name: string;
  input: unknown;
  /** provider-specific data that must be sent back as-is, e.g. Gemini thought signatures */
  meta?: Record<string, string>;
}

export interface ToolResultPart {
  type: "tool_result";
  id: string;
  content: string;
  isError?: boolean;
}

export type Message =
  | { role: "user"; content: (TextPart | ToolResultPart)[] }
  | { role: "assistant"; content: (TextPart | ToolCallPart)[] };

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /** model requests sent, retries included */
  requests?: number;
}

export type StopReason = "end_turn" | "tool_use" | "max_tokens" | "error" | "other";

export type StreamEvent =
  | { type: "text"; delta: string }
  /** emitted once the arguments are complete */
  | { type: "tool_call"; call: ToolCallPart }
  | { type: "done"; stopReason: StopReason; usage: Usage };

export interface ChatRequest {
  system: string;
  messages: Message[];
  tools: ToolSpec[];
  maxTokens: number;
  signal?: AbortSignal;
  /** told about each resend, so a pause doesn't look like a hang */
  onRetry?(message: string): void;
  /** told when a request is held back before it's sent */
  onWait?(message: string): void;
}

export interface Provider {
  readonly name: string;
  readonly model: string;
  stream(req: ChatRequest): AsyncIterable<StreamEvent>;
  listModels(): Promise<string[]>;
}
