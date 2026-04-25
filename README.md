
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

## What it does

Tap the mic and say a research topic. Anything works: "Tell me about the Battle of Hastings", "List every tribe in the Bible", "Compare React Server Components and Remix loaders". About sixty seconds later, you get a cited briefing on screen, read aloud in a synthesized voice.

Behind the scenes the app classifies your ask, plans a fan-out of search queries, hits You.com in parallel, writes the briefing with Anthropic Sonnet, and verifies it for completeness. Every one of those steps runs as its own Render Workflow task that you can open in the dashboard, inspect, and replay.

## Stack

| | Platform | Job |
|---|---|---|
| <img src="./static/images/logos/render.svg" width="28" /> | **[Render Workflows](https://render.com/docs/workflows)** | Orchestrator. Every step of the pipeline runs as its own retriable, observable Render task. |
| <img src="./static/images/logos/assemblyai.png" width="28" /> | **[AssemblyAI Voice Agent](https://www.assemblyai.com/docs/voice-agents/voice-agent-api)** | Speech in, speech out. A single streaming WebSocket that handles transcription, LLM reasoning, and text-to-speech. |
| <img src="./static/images/logos/mastra.png" width="28" /> | **[Mastra](https://mastra.ai/docs/agents/overview)** | Agent runtime. Powers the classifier, planner, synthesizer, and verifier (Anthropic **Sonnet 4** under the hood, see `ANTHROPIC_MODEL` in `src/config.ts`). |
| <img src="./static/images/logos/youcom.png" width="28" /> | **[You.com Research](https://you.com/docs/search/overview)** | The search layer. One call per planned angle, fanned out in parallel. |

## Architecture

![Architecture](static/images/architecture-diagram.gif)

The flow, step by step:

1. **You click the mic.** The browser opens a WebSocket to the Render web service.
2. **The web service starts a Workflow.** It calls `render.workflows.startTask("voice_session", ...)`, which runs the `voice_session` task on Render. That task opens its own WebSocket to AssemblyAI's Voice Agent and a second WebSocket back to the web service so audio frames can flow in both directions between the browser and AssemblyAI.
3. **You speak a topic.** AssemblyAI transcribes the audio and decides to call its `research` tool with your topic.
4. **The research chain runs.** The `voice_session` task dispatches a `research` subtask, which chains five more tasks: `classify_ask` (what shape is the question), `plan_queries` (turn it into N search queries), `search_branch` (run those queries against You.com in parallel), `synthesize` (write the briefing with citations), `verify` (does the briefing actually answer the question; one retry if not).
5. **The activity feed updates live.** Each task publishes a phase event through Postgres `LISTEN/NOTIFY`. The web service relays those events over Server-Sent Events to the browser, which renders them as the activity stream you see on screen.
6. **Briefing comes back.** When `verify` is satisfied (or the 60-second budget runs out), the briefing is returned to AssemblyAI as the tool result. AssemblyAI reads it aloud in a synthesized voice. The same content renders on screen with sources in the right-hand panel.

## Why Render Workflows

Render Workflows is a serverless task system. Each task is a TypeScript function wrapped in `task({ name, plan, timeoutSeconds, retry })`. It runs in its own isolated instance and shows up in the Render dashboard with logs, status, and a one-click replay.

Three properties of Workflows shape the architecture here.

**Durable run IDs.** When `POST /api/start` dispatches `voiceSession`, the SDK returns a `taskRunId` that survives browser disconnects and server restarts. The cleanup daemon uses that ID to cancel expired sessions later, regardless of which instance it runs on.

**Per-task isolation and retry.** `classify_ask` runs on a small instance with a 30 second timeout and two retries. `search_branch` runs on a larger one with three minutes and an aggressive backoff. Each stage fails independently, so a flaky search branch does not poison the whole pipeline.

**Observability and replay.** Every stage shows up as a separate task run in the Render dashboard. When something misbehaves you open the run, inspect its inputs and outputs, and replay it against the same snapshot. No log grepping across services.

The `voiceSession` task is the root. It holds the AssemblyAI WebSocket and dispatches `research` as a subtask when the agent fires the tool call. `research` then chains the five Mastra and You.com stages under a 60 second budget. If the search fan-out runs long, `racePartial` ships whatever branches finished by the deadline rather than waiting for the rest.

### Setting up the Workflow service

In the Render Dashboard click **New > Workflow** and link this repo. Build command is `npm ci && npm run build` so the same compile step runs for both the web service and the workflow runner. Start command is `node dist/render/tasks/index.js`, which auto-registers every `task({...})` declaration under `src/render/tasks/` with Render.

Each task is a TypeScript function wrapped with the SDK:

```ts
import { task } from "@renderinc/sdk/workflows";

export const classify_ask = task(
  {
    name: "classify_ask",
    plan: "starter",
    timeoutSeconds: 30,
    retry: { maxRetries: 2, waitDurationMs: 500, backoffScaling: 1.5 },
  },
  async (sessionId: string, topic: string) => {
    // ...
  },
);
```

The web service triggers a registered task through the same SDK:

```ts
const { taskRunId } = await render.workflows.startTask(
  `${WORKFLOW_SLUG}/voice_session`,
  [{ sessionId, token, publicWebUrl }],
);
```

`taskRunId` is the durable handle. The cleanup daemon hands it to `cancelTaskRun(taskRunId)` when a session expires.

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

## License

MIT
