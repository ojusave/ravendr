import type { PhaseEvent, Tier } from "./events.js";

/**
 * Ports — contracts the app depends on. Implementations live in vendor folders:
 *   VoiceRuntime     → src/assemblyai/runtime.ts
 *   ResearchProvider → src/youcom/research.ts  (also handles synthesis + citations)
 *   EventBus         → src/render/event-bus.ts
 *
 * Nothing in src/research, src/narrator, or src/routes imports a vendor
 * directly — everything goes through these interfaces. Swap-by-adapter.
 */

// ─── Voice (AssemblyAI) ─────────────────────────────────────────────
export interface VoiceRuntime {
  /**
   * Open an upstream voice-agent session. Caller owns lifecycle; returned
   * handle is closed when the user's WebSocket disconnects.
   */
  openSession(opts: VoiceSessionOpts): Promise<VoiceSession>;
}

export interface VoiceToolDef {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface VoiceSessionOpts {
  sessionId: string;
  /** System prompt for the voice agent. If omitted, a safe default is used. */
  systemPrompt?: string;
  /** First utterance spoken on connect. */
  greeting?: string;
  /** Tools registered on session.update. */
  tools?: VoiceToolDef[];
  /** Fallback path: called when the agent doesn't call a tool for a final transcript. */
  onUserTurn: (text: string) => Promise<string>;
  /** Called when the agent fires any tool.call. Must return the text to speak. */
  onToolCall?: (name: string, args: Record<string, unknown>) => Promise<string>;
  /** Low-level event stream for logging/transcript forwarding. */
  onEvent?: (event: VoiceEvent) => void;
  signal?: AbortSignal;
}

export interface VoiceSession {
  /** Feed a PCM audio chunk from the user mic into the upstream voice agent. */
  sendUserAudio(chunk: Uint8Array): void;
  /** Register a handler for PCM audio chunks returned by the upstream voice agent. */
  onAgentAudio(handler: (chunk: Uint8Array) => void): void;
  /** Proactively speak text to the user (e.g., narrator lines). */
  say(text: string): Promise<void>;
  close(): Promise<void>;
}

export type VoiceEvent =
  | { kind: "session.ready" }
  | { kind: "user.transcript.partial"; text: string }
  | { kind: "user.transcript.final"; text: string }
  | { kind: "agent.transcript"; text: string; interrupted: boolean }
  | { kind: "agent.reply.started" }
  | { kind: "agent.reply.done"; status: "ok" | "interrupted" }
  | { kind: "error"; message: string };

// ─── Research (You.com — also provides synthesis + citations) ──────
export interface ResearchProvider {
  research(input: ResearchInput): Promise<ResearchResult>;
}

export interface ResearchInput {
  query: string;
  tier: Tier;
  signal?: AbortSignal;
}

export interface ResearchResult {
  content: string;
  sources: ResearchSource[];
  latencyMs: number;
}

export interface ResearchSource {
  url: string;
  title: string;
  snippet?: string;
}

// ─── Event bus (Postgres LISTEN/NOTIFY) ─────────────────────────────
export interface EventBus {
  publish(event: PhaseEvent): Promise<void>;
  /**
   * Subscribe to all events for a given sessionId.
   * Returns an async disposer.
   */
  subscribe(sessionId: string, handler: (event: PhaseEvent) => void): () => void;
}
