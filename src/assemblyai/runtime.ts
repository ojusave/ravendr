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
 * Adapter over AssemblyAI's Voice Agent API (WSS).
 *
 * Protocol reference events (subject to API verification during integration):
 *   client → server : session.update, input.audio, tool.result
 *   server → client : session.ready, transcript.user, tool.call, reply.audio, reply.done
 *
 * We register a single tool, `research(topic)`, so every substantive user
 * utterance is routed through our own app logic (the narrator + workflow
 * dispatcher) rather than AssemblyAI's built-in LLM.
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

      // Handshake: resolve when the WS is open and session.update is sent.
      // Proceed after a short timeout even if AssemblyAI's "session.ready"
      // (or whatever equivalent) hasn't arrived — browser needs to progress.
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
          ws.send(
            JSON.stringify({
              type: "session.update",
              session: {
                system_prompt:
                  "You are a voice host. When the user speaks, call the tool `research` with their exact spoken text as the `topic` argument, and speak its return value verbatim. Never generate content on your own.",
                output: { voice: config.voice },
                tools: [
                  {
                    id: "research",
                    description:
                      "Research a topic. Pass the user's spoken request as `topic`.",
                    input_schema: {
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
          logger.warn({ code, reason: reasonText }, "AssemblyAI WS closed during handshake");
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
          logger.warn({ raw: raw.toString("utf8").slice(0, 200) }, "non-JSON upstream message");
          return;
        }
        if (debugMessageCount < 10) {
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
          case "transcript.user":
            if (event.is_final === false) {
              opts.onEvent?.({
                kind: "user.transcript.partial",
                text: String(event.text ?? ""),
              });
            } else {
              opts.onEvent?.({
                kind: "user.transcript.final",
                text: String(event.text ?? ""),
              });
            }
            break;
          case "tool.call": {
            const id = String(event.tool_call_id ?? event.id ?? "");
            const name = String(event.tool?.name ?? event.name ?? "");
            const args = event.tool?.arguments ?? event.arguments ?? {};
            const controller = new AbortController();
            pendingToolCalls.set(id, controller);
            try {
              const result =
                (await opts.onToolCall?.(name, args)) ??
                (name === "research" && typeof args.topic === "string"
                  ? await opts.onUserTurn(args.topic)
                  : "");
              ws.send(
                JSON.stringify({
                  type: "tool.result",
                  tool_call_id: id,
                  result,
                })
              );
            } catch (err) {
              logger.error({ err, name, id }, "tool.call handler failed");
              ws.send(
                JSON.stringify({
                  type: "tool.result",
                  tool_call_id: id,
                  result: "Sorry — something went wrong handling that.",
                })
              );
            } finally {
              pendingToolCalls.delete(id);
            }
            break;
          }
          case "reply.audio": {
            const audio = event.audio;
            if (typeof audio === "string") {
              const chunk = Buffer.from(audio, "base64");
              for (const l of audioListeners) l(chunk);
            }
            break;
          }
          case "reply.started":
            opts.onEvent?.({ kind: "agent.reply.started" });
            break;
          case "reply.done":
            opts.onEvent?.({
              kind: "agent.reply.done",
              status: event.status === "interrupted" ? "interrupted" : "ok",
            });
            break;
          case "error":
            opts.onEvent?.({
              kind: "error",
              message: String(event.message ?? "unknown voice error"),
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
        async say(text: string) {
          // Best-effort server-initiated speech. Exact event shape may need
          // tweaking during integration; fallback is a separate TTS channel
          // handled by the ws-proxy on top of this session.
          if (ws.readyState !== WebSocket.OPEN) return;
          ws.send(
            JSON.stringify({
              type: "broadcast.speech",
              text,
            })
          );
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
