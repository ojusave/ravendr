import { WebSocket } from "ws";
import type {
  VoiceRuntime,
  VoiceSession,
  VoiceSessionOpts,
} from "../shared/ports.js";
import { AppError } from "../shared/errors.js";
import { logger } from "../shared/logger.js";

export interface AssemblyAIConfig {
  apiKey: string;
  agentUrl: string;
  voice: string;
}

/**
 * Adapter over AssemblyAI Voice Agent API.
 *
 * Protocol ref: https://www.assemblyai.com/docs/voice-agents/voice-agent-api
 *   client → server : session.update, input.audio, tool.result
 *   server → client : session.ready, transcript.user.delta, transcript.user,
 *                     transcript.agent, reply.started, reply.audio, reply.done,
 *                     tool.call, session.error, error
 *
 * We register a single tool `research(topic)`. The agent's system prompt
 * tells it to call `research` with the user's exact spoken topic, and speak
 * back the tool's returned string verbatim.
 *
 * No server-initiated speech exists in AssemblyAI's API — narrator phase
 * lines are spoken by the browser via speechSynthesis instead.
 */
export function createAssemblyAIRuntime(config: AssemblyAIConfig): VoiceRuntime {
  return {
    async openSession(opts: VoiceSessionOpts): Promise<VoiceSession> {
      logger.info({ url: config.agentUrl }, "opening AssemblyAI WS");
      const ws = new WebSocket(config.agentUrl, {
        headers: { authorization: `Bearer ${config.apiKey}` },
      });

      const audioListeners: ((chunk: Uint8Array) => void)[] = [];
      const pendingToolCalls = new Map<string, AbortController>();

      // Resolve when session.update is sent. 5s hard ceiling.
      const HANDSHAKE_TIMEOUT_MS = 5_000;
      const ready = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          logger.warn(
            { state: ws.readyState },
            "AssemblyAI handshake timed out — proceeding anyway"
          );
          resolve();
        }, HANDSHAKE_TIMEOUT_MS);

        ws.once("open", () => {
          logger.info("AssemblyAI WS open, sending session.update");
          // Minimum-viable session config per docs. If this fails to activate
          // (no session.ready within ~30s) it's almost certainly an account
          // / plan issue, not a field-shape issue.
          ws.send(
            JSON.stringify({
              type: "session.update",
              session: {
                system_prompt:
                  "You help users research topics. When a user asks about something, call the `research` tool with their request as the `topic` argument, then read back the result.",
                output: { voice: config.voice },
                greeting: "Hi! Tell me a topic to research.",
                tools: [
                  {
                    type: "function",
                    name: "research",
                    description: "Look up a topic and return a spoken briefing.",
                    parameters: {
                      type: "object",
                      properties: {
                        topic: { type: "string" },
                      },
                      required: ["topic"],
                    },
                  },
                ],
              },
            })
          );
          clearTimeout(timer);
          resolve();
        });
        ws.once("error", (err) => {
          clearTimeout(timer);
          logger.error({ err: (err as Error).message }, "AssemblyAI WS error");
          reject(new AppError("UPSTREAM_VOICE", "voice ws error", { cause: err }));
        });
        ws.once("close", (code, reason) => {
          clearTimeout(timer);
          const reasonText = reason?.toString() ?? "";
          logger.warn(
            { code, reason: reasonText },
            "AssemblyAI WS closed during handshake"
          );
          reject(
            new AppError(
              "UPSTREAM_VOICE",
              `voice ws closed before ready (code=${code} reason=${reasonText})`
            )
          );
        });
      });

      let debugMessageCount = 0;
      ws.on("message", async (raw: Buffer) => {
        const event = safeParse(raw);
        if (!event) {
          logger.warn(
            { raw: raw.toString("utf8").slice(0, 200) },
            "non-JSON upstream message"
          );
          return;
        }
        if (debugMessageCount < 15) {
          logger.info(
            { type: event.type, keys: Object.keys(event).slice(0, 8) },
            "AssemblyAI upstream message"
          );
          debugMessageCount++;
        }
        switch (event.type) {
          case "session.ready":
            opts.onEvent?.({ kind: "session.ready" });
            break;

          case "transcript.user.delta":
            opts.onEvent?.({
              kind: "user.transcript.partial",
              text: String(event.text ?? ""),
            });
            break;

          case "transcript.user":
            opts.onEvent?.({
              kind: "user.transcript.final",
              text: String(event.text ?? ""),
            });
            break;

          case "transcript.agent":
            opts.onEvent?.({
              kind: "agent.transcript",
              text: String(event.text ?? ""),
              interrupted: Boolean(event.interrupted),
            });
            break;

          case "reply.started":
            opts.onEvent?.({ kind: "agent.reply.started" });
            break;

          case "reply.done":
            opts.onEvent?.({
              kind: "agent.reply.done",
              status: event.status === "interrupted" ? "interrupted" : "ok",
            });
            break;

          case "reply.audio": {
            // The audio payload is `data`, not `audio`.
            const audio = event.data;
            if (typeof audio === "string") {
              const chunk = Buffer.from(audio, "base64");
              for (const l of audioListeners) l(chunk);
            }
            break;
          }

          case "tool.call": {
            const id = String(event.call_id ?? "");
            const name = String(event.name ?? "");
            const args =
              (event.args as Record<string, unknown> | undefined) ?? {};
            const controller = new AbortController();
            pendingToolCalls.set(id, controller);
            try {
              const reply =
                (await opts.onToolCall?.(name, args)) ??
                (name === "research" && typeof args.topic === "string"
                  ? await opts.onUserTurn(args.topic)
                  : "");
              ws.send(
                JSON.stringify({
                  type: "tool.result",
                  call_id: id,
                  // Docs: `result` must be a JSON string.
                  result: JSON.stringify(reply),
                })
              );
            } catch (err) {
              logger.error({ err, name, id }, "tool.call handler failed");
              ws.send(
                JSON.stringify({
                  type: "tool.result",
                  call_id: id,
                  result: JSON.stringify(
                    "Sorry — something went wrong handling that."
                  ),
                })
              );
            } finally {
              pendingToolCalls.delete(id);
            }
            break;
          }

          case "session.error":
          case "error":
            opts.onEvent?.({
              kind: "error",
              message: `${event.code ?? ""}: ${event.message ?? "unknown voice error"}`,
            });
            break;
        }
      });

      opts.signal?.addEventListener("abort", () => ws.close(), { once: true });
      await ready;

      return {
        sendUserAudio(chunk: Uint8Array) {
          if (ws.readyState !== WebSocket.OPEN) return;
          ws.send(
            JSON.stringify({
              type: "input.audio",
              audio: Buffer.from(chunk).toString("base64"),
            })
          );
        },
        onAgentAudio(handler) {
          audioListeners.push(handler);
        },
        async say(_text: string) {
          // AssemblyAI Voice Agent API has no server-initiated speech event.
          // Narrator phase lines are spoken by the browser via speechSynthesis
          // — see static/main.js.
        },
        async close() {
          for (const c of pendingToolCalls.values()) c.abort();
          ws.close();
        },
      };
    },
  };
}

function safeParse(raw: Buffer): Record<string, any> | null {
  try {
    return JSON.parse(raw.toString("utf8"));
  } catch {
    return null;
  }
}
