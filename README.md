
<h1 align="center">Ravendr</h1>

<p align="center">
  Voice-first research demo. Click the mic, say a topic, get a cited briefing back.<br/>
  Every step is a Render Workflow task.
</p>

<p align="center">
  <a href="https://render.com/deploy?repo=https://github.com/ojusave/ravendr"><img src="https://render.com/images/deploy-to-render-button.svg" alt="Deploy to Render" height="32" /></a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/node-%E2%89%A522-339933?logo=node.js&logoColor=white&style=flat-square" alt="Node 22+" />
  <img src="https://img.shields.io/badge/typescript-strict-3178c6?logo=typescript&logoColor=white&style=flat-square" alt="TypeScript strict" />
  <img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="MIT" />
</p>

## Stack

| | Platform | Job |
|---|---|---|
| <img src="./static/images/logos/render.svg" width="28" /> | **[Render Workflows](https://render.com/docs/workflows)** | Orchestrator. `voiceSession` task owns the session; `plan_queries → search_branch × N → synthesize` are independently-retried subtasks. |
| <img src="./static/images/logos/assemblyai.png" width="28" /> | **[AssemblyAI Voice Agent](https://www.assemblyai.com/docs/voice-agents/voice-agent-api)** | STT + VAD + LLM + TTS in one WebSocket. Lives inside the voiceSession task. |
| <img src="./static/images/logos/mastra.png" width="28" /> | **[Mastra](https://mastra.ai/docs/agents/overview)** | Agent primitive. Plans queries and writes the briefing using Anthropic **Sonnet 4** (see `ANTHROPIC_MODEL` in `src/config.ts`). |
| <img src="./static/images/logos/youcom.png" width="28" /> | **[You.com Research](https://you.com/docs/search/overview)** | One call per planned angle, fanned out in parallel. |

## Architecture

![Architecture](static/images/architecture-diagram.gif)

- Click mic → `POST /api/start` → Render dispatches `voiceSession`.
- Task opens AssemblyAI and a reverse WS back to the broker; audio tunnels through.
- You speak a topic. AssemblyAI fires `research(topic)`. The tool dispatches the research subtask.
- Each subtask emits a phase event via Postgres NOTIFY → SSE → activity feed.
- `briefing.ready` fires; tool.result returns the full briefing; AssemblyAI reads it aloud.

## Why Render Workflows

Render Workflows is a serverless task system. Each task is a TypeScript function wrapped in `task({ name, plan, timeoutSeconds, retry })`. It runs in its own isolated instance and shows up in the Render dashboard with logs, status, and a one-click replay.

Three properties of Workflows shape the architecture here.

**Durable run IDs.** When `POST /api/start` dispatches `voiceSession`, the SDK returns a `taskRunId` that survives browser disconnects and server restarts. The cleanup daemon uses that ID to cancel expired sessions later, regardless of which instance it runs on.

**Per-task isolation and retry.** `classify_ask` runs on a small instance with a 30 second timeout and two retries. `search_branch` runs on a larger one with three minutes and an aggressive backoff. Each stage fails independently, so a flaky search branch does not poison the whole pipeline.

**Observability and replay.** Every stage shows up as a separate task run in the Render dashboard. When something misbehaves you open the run, inspect its inputs and outputs, and replay it against the same snapshot. No log grepping across services.

The `voiceSession` task is the root. It holds the AssemblyAI WebSocket and dispatches `research` as a subtask when the agent fires the tool call. `research` then chains the five Mastra and You.com stages under a 60 second budget. If the search fan-out runs long, `racePartial` ships whatever branches finished by the deadline rather than waiting for the rest.

## Run locally

```bash
cp .env.example .env
createdb ravendr
npm install
npm run migrate
npm run dev           # web service on :3000
npm run dev:tasks     # workflow runner in a second terminal
```

Required env on **both** services:
- `DATABASE_URL`, `ANTHROPIC_API_KEY`, `YOU_API_KEY`, `ASSEMBLYAI_API_KEY`

Web only: `RENDER_API_KEY`, `WORKFLOW_SLUG` (default `ravendr-workflow`).

## Deploy

1. Fork. Hit **Deploy to Render**. The Blueprint creates `ravendr-web` + `ravendr-db`.
2. In the dashboard, create a Workflow service `ravendr-workflow`, same repo, start command `node dist/render/tasks/index.js`.
3. Put secrets in an env group `ravendr-shared` so both services share them.
4. Migrations run on every web deploy (`preDeployCommand: npm run migrate`).

## Repo layout

One folder per vendor. Each owns its protocol or SDK; the Render task files are thin orchestration glue that compose them.

```
src/
  server.ts  routes.ts  config.ts      web service composition root
  assemblyai/
    voice-agent.ts                      AssemblyAI WebSocket protocol client
  mastra/
    agents.ts                           Planner, synthesizer, verifier factories
  youcom/
    research.ts                         You.com Research API adapter
  render/
    db.ts                               typed Postgres queries
    event-bus.ts                        LISTEN/NOTIFY event bus
    session-broker.ts                   pairs /ws/client with /ws/task
    workflow-dispatcher.ts              @renderinc/sdk wrapper
    tasks/
      index.ts                          auto-registers every task with Render
      research.ts                       ROOT orchestrator (pure Render Workflows)
      assemblyai/
        voice-session.ts                holds AssemblyAI WS + reverse WS
      mastra/
        classify-ask.ts                 ask-shape classifier
        plan-queries.ts                 shape-aware planner
        synthesize.ts                   shape-aware synthesizer
        verify.ts                       shape-aware verifier + 1-retry
      youcom/
        search-branch.ts                one You.com call (× N parallel)
  shared/                               ports + events + envelope + errors + logger

static/                                 vanilla ES modules (index.html + main.js + mic.js)
```

## Known limitation

AssemblyAI's Voice Agent doesn't let the server force the agent to speak a specific string. After `tool.result` the agent's LLM usually reads the briefing aloud, but not always. When it goes silent, the briefing still renders on screen; voice is the soft path, UI is the hard one. For guaranteed single-voice narration of every phase, swap AssemblyAI for OpenAI Realtime (`conversation.item.create`).

## License

MIT
