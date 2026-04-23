<p align="center">
  <img src="./static/images/og-image.svg" alt="Ravendr — voice-first research on the Render stack" width="720" />
</p>

<h1 align="center">Ravendr</h1>

<p align="center">
  <strong>Voice-first research demo on the Render stack.<br/>Tap the mic, say a topic, watch Render Workflows orchestrate the pipeline live.</strong>
</p>

<p align="center">
  <a href="https://render.com/deploy?repo=https://github.com/ojusave/ravendr">
    <img src="https://render.com/images/deploy-to-render-button.svg" alt="Deploy to Render" />
  </a>
</p>

<p align="center">
  <a href="https://render.com/register?utm_source=github&utm_medium=referral&utm_campaign=ojus_demos&utm_content=readme_hero">
    <img src="https://img.shields.io/badge/Sign%20up%20on%20Render-6c63ff?style=for-the-badge&logo=render&logoColor=white" alt="Sign up on Render" />
  </a>
  <a href="https://github.com/ojusave/ravendr/actions"><img src="https://img.shields.io/badge/node-%3E%3D22-339933?logo=node.js&logoColor=white" alt="Node 22+" /></a>
  <a href="https://github.com/ojusave/ravendr/blob/main/package.json"><img src="https://img.shields.io/badge/typescript-strict-3178c6?logo=typescript&logoColor=white" alt="TypeScript strict" /></a>
  <a href="https://github.com/ojusave/ravendr/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT" /></a>
</p>

---

Ravendr is a voice-in, briefing-out research demo. You click the mic, say a topic, and a Render Workflow fans out across four platforms to pull back a cited briefing — every step visible live on screen and narrated at the end by the same AssemblyAI voice that took your question.

## The stack

| | Platform | Role |
|---|---|---|
| <img src="https://www.assemblyai.com/favicon.ico" width="24" /> | **[AssemblyAI Voice Agent](https://www.assemblyai.com/docs/voice-agents/voice-agent-api)** | Speech-to-text, VAD, turn-taking, LLM routing, text-to-speech. One WebSocket, voice in, voice out. |
| <img src="https://render.com/favicon.ico" width="24" /> | **[Render Workflows](https://render.com/docs/workflows)** | Durable orchestration. Every pipeline step is a separate task run with its own retry policy — if one branch fails, only that branch retries. |
| <img src="https://mastra.ai/favicon.ico" width="24" /> | **[Mastra](https://mastra.ai/docs/agents/overview)** | Agent primitive with a built-in model router. We use it to plan queries and synthesize the briefing via `anthropic/claude-sonnet-4`. |
| <img src="https://you.com/favicon.ico" width="24" /> | **[You.com Research API](https://you.com/docs/search/overview)** | Parallel web research with inline citations. One call per planned angle. |

Every platform is load-bearing: you can't cleanly remove any of them without the demo falling apart.

## How it works

```
Browser
  │  audio WS  ←→   Web service (~150 LoC broker)
  │  SSE feed  ←──       │  POST /api/start
  │                      │     client.workflows.startTask("voiceSession", …)
  │                      │  reverse audio WS  ←───────────────────────────┐
  │                      ▼                                                │
  │               Postgres (LISTEN/NOTIFY event bus)                      │
  │                      ▲                                                │
  └────── SSE ───────────┘                                                │
                                                                          │
 ╔════════════════ Render Workflow service ═══════════════════╗           │
 ║                                                            ║           │
 ║  voiceSession (root, up to 1h)  ──────────────────────────╬───────────┘
 ║    ├─ opens WebSocket to AssemblyAI                        ║
 ║    ├─ opens reverse WebSocket back to web service          ║
 ║    ├─ pipes mic ↔ AssemblyAI                               ║
 ║    └─ on tool.call "research(topic)":                      ║
 ║         await research(sessionId, topic)                   ║
 ║           ├─ await plan_queries(topic)          subtask    ║
 ║           ├─ await Promise.all([                           ║
 ║           │      search_branch × N              subtasks   ║
 ║           │   ])                                           ║
 ║           └─ await synthesize(topic, branches)  subtask    ║
 ║         send tool.result → AssemblyAI speaks briefing      ║
 ║                                                            ║
 ╚════════════════════════════════════════════════════════════╝
```

1. Click the mic → `POST /api/start` creates a session and dispatches the `voiceSession` task.
2. The task boots on Render, opens a WebSocket to AssemblyAI, and opens a reverse WebSocket back to the web service so mic audio and agent audio can tunnel through one broker.
3. AssemblyAI plays the greeting. User speaks a topic. AssemblyAI transcribes it and calls the `research` tool.
4. The tool dispatches `research(topic)` as a subtask. `research` itself dispatches `plan_queries`, then `Promise.all(search_branch × N)`, then `synthesize`. **Every one of those is its own Render task run, independently retried.**
5. Phase events flow back via Postgres NOTIFY → SSE → the activity feed and chain ribbon on screen.
6. When `briefing.ready` fires, the tool returns the full briefing text. AssemblyAI reads it aloud and the briefing panel renders with its source list.

## What you see

- **Sticky header** with a live session timer, GitHub / Deploy / Sign-up links, and a dark/light toggle.
- **Orb mic** that pulses purple while recording.
- **Chain ribbon** — one node per platform; the dot turns live while its layer is active, green when done.
- **Activity timeline** — every phase event as its own dated line, color-coded to the platform it belongs to.
- **Briefing card** with the full text and a deduplicated list of sources.

Everything matches the design language of the Render DDS (purple primary, Inter + Roboto 300, square corners, 1px borders, flat surfaces).

## Repo layout

```
src/
  server.ts                web service composition root
  routes.ts                HTTP (POST /api/start + SSE + briefing fetch)
  config.ts                Zod-validated env for web + workflow
  shared/                  ports + event types + envelope + errors + logger
  youcom/research.ts       You.com Research API adapter

  render/
    db.ts                  typed Postgres queries
    event-bus.ts           LISTEN/NOTIFY event bus
    session-broker.ts      pairs /ws/client and /ws/task, buffered & text-framed
    workflow-dispatcher.ts wraps @renderinc/sdk to start voiceSession
    tasks/
      voice-session.ts     ROOT task — AssemblyAI WS + reverse WS + research tool
      research.ts          subtask — orchestrates plan → parallel searches → synthesize
      plan-queries.ts      leaf — Mastra Agent plans queries via Anthropic
      search-branch.ts     leaf — one You.com Research call (× N in parallel)
      synthesize.ts        leaf — Mastra Agent writes the spoken briefing
      index.ts             task registration for the workflow service

static/                    vanilla ES modules
  index.html               UI
  main.js                  orchestrator
  mic.js                   PCM16 capture + playback
  chain-ribbon.js          ribbon state machine
  api-client.js            fetch + SSE + WebSocket wrappers
  images/
    og-image.svg           source for the social unfurl card
    og-image.png           generated — rerun scripts/build-og.mjs to refresh

migrations/0001_init.sql   sessions · briefings · sources · phase_events
scripts/build-og.mjs       SVG → PNG for og:image (uses @resvg/resvg-js)
render.yaml                web + db Blueprint (workflow service created manually)
```

## Quick start

```bash
cp .env.example .env          # fill in the keys
createdb ravendr
npm install
npm run migrate               # applies migrations
npm run dev                   # web service on :3000
# in a second terminal:
npm run dev:tasks             # workflow task runner
```

Then open `http://localhost:3000`, allow mic access, click the orb, and say a topic.

Required env vars on **both** services (the workflow service needs AssemblyAI too because that's where the voice session lives now):

- `DATABASE_URL` — Postgres connection
- `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` (default `claude-sonnet-4-20250514`)
- `YOU_API_KEY`, `YOU_BASE_URL`
- `ASSEMBLYAI_API_KEY`, `ASSEMBLYAI_VOICE` (default `claire`)

Web-service-only:

- `RENDER_API_KEY` — for dispatching the workflow task
- `WORKFLOW_SLUG` — defaults to `ravendr-workflow`
- `PUBLIC_WEB_URL` — optional fallback; normally inferred from `RENDER_EXTERNAL_URL` or the request Host header

## Deploy on Render

1. Fork this repo.
2. Click **Deploy to Render** above. The Blueprint provisions `ravendr-web` + `ravendr-db`.
3. In the dashboard, create a **Workflow service** named `ravendr-workflow`, connected to the same repo. Start command: `node dist/render/tasks/index.js`.
4. Create an **env group** called `ravendr-shared` and put the shared secrets (`ANTHROPIC_API_KEY`, `YOU_API_KEY`, `ASSEMBLYAI_API_KEY`, etc.) there. Both services pull from it.
5. Migrations run on each web-service deploy via `preDeployCommand: npm run migrate`.

## Design language

The UI mirrors the [Render DDS](https://github.com/R4ph-t/DDS) tokens — square corners, 1px borders, Inter body, Roboto 300 headers, Render purple (`#6c63ff`) as the primary accent. Dark mode is the default; the header toggle persists to `localStorage`.

The structure (sticky header + sidebar-free single column + timeline activity feed + rounded-corner-less flat cards) mirrors the pattern used in the [llamaindex-example](https://github.com/ojusave/render-workflows-llamaindex) repo.

## Known limitation — voice read-back reliability

AssemblyAI's Voice Agent doesn't expose a standalone TTS endpoint or a way for the server to force the agent to speak a specific string. After `tool.result` we send the full briefing; the agent's LLM **usually** reads it back, but not always. When it goes silent, the briefing is still on screen — the UI always renders, the voice is the soft path.

If you need guaranteed single-voice narration of each phase (not just the final briefing), the architectural fix is swapping AssemblyAI for OpenAI Realtime, which *does* expose `conversation.item.create` with `role: "assistant"` — the server can push text for the agent to speak.

## License

MIT
