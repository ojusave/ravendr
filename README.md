# Ravendr

**Tap the mic, say a topic, watch Render Workflows orchestrate a voice-first research pipeline in real time.**

Ravendr is a demo built on four platforms, each load-bearing at a distinct layer:

| Layer | Platform |
|---|---|
| Voice I/O (STT · VAD · LLM · TTS) | **AssemblyAI** Voice Agent API |
| Durable orchestration · every step a checkpointed task | **Render Workflows** |
| LLM reasoning (planning + synthesis) via a unified model router | **Mastra** (Agent + `anthropic/claude-sonnet-4`) |
| Parallel web research with citations | **You.com** Research API |

When you click the mic, Render dispatches a `voiceSession` workflow task. That task holds the AssemblyAI session, tunnels audio back to the browser via the web service, and — when the AssemblyAI agent fires its `research` tool — dispatches the research pipeline as a tree of Render subtasks. Planning, each parallel search, and synthesis are separate runs; a failure in one only retries that one.

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/ojusave/ravendr)

---

## Architecture

```
 Browser
   │   audio WS  ←→   Web service (broker only, ~150 LoC)
   │   SSE feed  ←──       │   POST /api/start
   │                        │       client.workflows.startTask("voiceSession", …)
   │                        │   reverse audio WS  ←───────────────────────────┐
   │                        ▼                                                 │
   │                 Postgres (LISTEN/NOTIFY for phase events)                │
   │                        ▲                                                 │
   │                        │                                                 │
   └──────── SSE ───────────┘                                                 │
                                                                              │
 ╔════════════════ Render Workflow service ═════════════════════╗             │
 ║                                                              ║             │
 ║  voiceSession (root task, up to 1h)  ────────────────────────╬─────────────┘
 ║    ├─ opens WebSocket to AssemblyAI                          ║
 ║    ├─ opens reverse WebSocket back to web service            ║
 ║    ├─ pipes mic ↔ AssemblyAI                                 ║
 ║    └─ on tool.call "start_research":                         ║
 ║         await research(sessionId, topic)   ← subtask         ║
 ║           ├─ await plan_queries(topic)       ← subtask       ║
 ║           ├─ await Promise.all([                             ║
 ║           │      search_branch × N           ← N subtasks    ║
 ║           │   ])                                             ║
 ║           └─ await synthesize(topic, branches) ← subtask     ║
 ║         send tool.result → AssemblyAI speaks briefing        ║
 ║                                                              ║
 ╚══════════════════════════════════════════════════════════════╝
```

**Why each piece is load-bearing:**
- **Render Workflows** — every meaningful step is a separate task run with its own retry config. If `search_branch #3` fails, only `#3` retries; the plan and other 4 branches are preserved.
- **AssemblyAI** — one WebSocket for STT + VAD + turn-taking + LLM + TTS. The voice session lives inside the workflow task.
- **Mastra** — Agent primitive calls Anthropic via the built-in model router (`anthropic/claude-sonnet-4-*`). No AI SDK leakage into our deps.
- **You.com** — parallel web research with inline citations, called per-branch.

## Flow

1. User clicks mic → `POST /api/start` → web service creates a session, issues an internal token, dispatches `voiceSession` task, returns `sessionId`.
2. Browser opens `/ws/client?sessionId=…` (audio in and out).
3. `voiceSession` task boots → opens `/ws/task?sessionId=…&token=…` back to the web service → the broker pairs them.
4. Task opens AssemblyAI session, sends greeting → AssemblyAI's voice plays the greeting out the browser.
5. User speaks a topic → AssemblyAI transcribes → its LLM calls `start_research(topic)`.
6. Task handler dispatches the `research` subtask asynchronously, subscribes to the phase-event bus, and returns an opening line for the agent to speak.
7. As `plan.ready`, `youcom.call.completed`, `agent.synthesizing`, `briefing.ready` events flow in from subtasks, the task's `next_update` tool streams each back as a narration payload. AssemblyAI's agent loops, speaking each event live.
8. When `briefing.ready` fires, the final narration payload carries the full briefing text. Agent reads it aloud. Done.
9. The browser also sees every phase event via SSE — the activity feed + chain ribbon fill in on screen while voice narrates.

## Repo layout

```
src/
  server.ts                composition root for the web service
  routes.ts                HTTP routes: /api/start, /api/sessions/:id/events (SSE), /api/briefings/:id
  config.ts                Zod-validated env (BaseConfig + WebConfig)

  shared/                  ports.ts · events.ts · envelope.ts · errors.ts · logger.ts
  youcom/research.ts       You.com Research API adapter

  render/
    db.ts                  typed Postgres queries
    event-bus.ts           LISTEN/NOTIFY event bus
    session-broker.ts      pairs /ws/client + /ws/task, buffered & text-framed
    workflow-dispatcher.ts wraps @renderinc/sdk for voiceSession dispatch
    tasks/
      voice-session.ts     ROOT task: AssemblyAI WS + reverse WS + research orchestration
      research.ts          subtask: awaits plan → parallel searches → synthesize
      plan-queries.ts      leaf subtask: Mastra Agent plans queries via Anthropic
      search-branch.ts     leaf subtask: one You.com Research call (× N in parallel)
      synthesize.ts        leaf subtask: Mastra Agent writes the spoken briefing
      index.ts             task registration for the workflow service

static/                    vanilla ES modules — index.html · main.js · mic.js · chain-ribbon.js · api-client.js
migrations/                0001_init.sql
scripts/migrate.ts         applies every .sql file in order
render.yaml                Blueprint (web + db shared env group)
```

## Run locally

```bash
cp .env.example .env          # fill in the keys
createdb ravendr
npm install
npm run migrate               # applies migrations
npm run dev                   # web service on :3000
# second terminal — workflow task runner:
npm run dev:tasks
```

Open `http://localhost:3000`, grant mic permission, click mic, say a topic.

Required env vars (both services):
- `DATABASE_URL` — Postgres
- `ANTHROPIC_API_KEY` — Mastra reads this for its router
- `ANTHROPIC_MODEL` — e.g. `claude-sonnet-4-20250514` (auto-prefixed to `anthropic/…` for the router)
- `YOU_API_KEY`, `YOU_BASE_URL`
- `ASSEMBLYAI_API_KEY` — **required on the workflow service too** (voiceSession holds the WS)

Web-service-only:
- `RENDER_API_KEY`
- `WORKFLOW_SLUG` (default `ravendr-workflow`)
- `PUBLIC_WEB_URL` — optional fallback; normally the web service infers its own URL from `RENDER_EXTERNAL_URL` or the incoming request host

## Deploy on Render

1. Fork this repo.
2. Click **Deploy to Render** → Blueprint provisions `ravendr-web` + `ravendr-db`.
3. Create a **Workflow service** (`ravendr-workflow`) manually in the dashboard, connected to the same repo. Start command: `node dist/render/tasks/index.js`.
4. Put secrets on the `ravendr-shared` env group (both services read from it):
   - `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`
   - `YOU_API_KEY`, `YOU_BASE_URL`
   - `ASSEMBLYAI_API_KEY`, `ASSEMBLYAI_VOICE` (optional)
5. Web-service-only env:
   - `RENDER_API_KEY`, `WORKFLOW_SLUG`
6. Migrations run automatically on each web-service deploy via `preDeployCommand: npm run migrate`.

## Swap any platform

Adapters live behind two ports (`EventBus` in `src/shared/ports.ts`, `ResearchProvider` same file). Render Workflows is used directly via `@renderinc/sdk`. Mastra's Agent is instantiated per-subtask. You can swap in a different voice provider by reimplementing the AssemblyAI WS handling inside `src/render/tasks/voice-session.ts`, a different research provider by writing a new adapter against `ResearchProvider`, or a different LLM by changing the `model` string passed to `new Agent({...})`.

## License

MIT
