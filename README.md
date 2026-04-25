
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

## Prerequisites

| Account / Tool | Why |
|---|---|
| [Render](https://dashboard.render.com/register) | Hosts the web service, Postgres, and Workflow runner. |
| [AssemblyAI](https://www.assemblyai.com/app) | Voice Agent API key. |
| [Anthropic](https://console.anthropic.com) | API key for the Mastra agents (Sonnet). |
| [You.com](https://you.com/platform) | Search API key. |
| Node 22+ | Local development. |
| Postgres | Local development (Render Postgres in production). |

## Configuration

Required environment variables on **both** the web service and the workflow service unless noted otherwise:

| Variable | Description | Source |
|---|---|---|
| `DATABASE_URL` | Postgres connection string. | Render auto-injects from the `ravendr-db` Blueprint. Set it manually for local dev. |
| `ANTHROPIC_API_KEY` | Used by every Mastra agent. | https://console.anthropic.com |
| `YOU_API_KEY` | Used by `search_branch`. | https://you.com/platform |
| `ASSEMBLYAI_API_KEY` | Used by `voice_session`. | https://www.assemblyai.com/app |
| `ANTHROPIC_MODEL` | Override the LLM (default `claude-sonnet-4-20250514`). | Optional. |
| `RENDER_API_KEY` | Web service only. Used to dispatch and cancel Workflow runs. | https://dashboard.render.com/settings/api-keys |
| `WORKFLOW_SLUG` | Web service only. Slug of the Workflow service (default `ravendr-workflow`). | Your Render dashboard. |

## Run locally

```bash
cp .env.example .env       # fill in API keys
createdb ravendr           # local Postgres
npm install
npm run migrate            # apply migrations
npm run dev                # web service on :3000
npm run dev:tasks          # workflow runner in a second terminal
```

## Deploy

1. Fork. Hit **Deploy to Render**. The Blueprint creates `ravendr-web` + `ravendr-db`.
2. In the dashboard, create a Workflow service `ravendr-workflow`, same repo, start command `node dist/render/tasks/index.js`.
3. Put secrets in an env group `ravendr-shared` so both services share them.
4. Migrations run on every web deploy via `preDeployCommand: npm run migrate`.

## Repo layout

One folder per vendor. Each owns its protocol or SDK; the Render task files are thin orchestration glue that compose them.

```
src/
  server.ts  routes.ts  config.ts    web service composition root
  assemblyai/                         AssemblyAI WebSocket protocol client
  mastra/                             Agent factories (classifier, planner, synthesizer, verifier)
  youcom/                             You.com Research API adapter
  render/
    db.ts  event-bus.ts  session-broker.ts  workflow-dispatcher.ts
    tasks/                            workflow tasks (auto-registered by tasks/index.ts)
      research.ts                     orchestrator
      assemblyai/voice-session.ts     root task; holds AssemblyAI + reverse WS
      mastra/                         classify-ask · plan-queries · synthesize · verify
      youcom/search-branch.ts         one You.com call (× N parallel)
  shared/                             ports · events · errors · envelope · logger

static/                               vanilla ES modules (index.html · main.js · mic.js)
migrations/                           sequenced .sql files applied by npm run migrate
```

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Failed to create session` after deploy | Migrations have not run. Set `preDeployCommand: npm run migrate` on the web service in the Render dashboard, then redeploy. |
| Workflow tasks fail with `RENDER_API_KEY missing` | The web service needs `RENDER_API_KEY` set so it can dispatch Workflow runs. Add it in the env group `ravendr-shared`. |
| `503 AT_CAPACITY` from `/api/start` | The demo is at its 100-session cap. Wait a minute, or bump `MAX_CONCURRENT_SESSIONS` in `src/config.ts`. |
| Task disappears from the dashboard mid-session | The cleanup daemon cancelled it because the 15-minute TTL elapsed. Start a new session. |
| Voice goes silent during research | AssemblyAI's agent does not always narrate the tool result. The briefing still renders on screen with sources, so the experience is preserved. |

## License

MIT
