# Ravendr

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/ojusave/ravendr)

A voice-first personal knowledge base. You talk; it researches, fact-checks, stores, and recalls what you discussed across sessions.

This repo is written as a **Render learning path**: the product is real, but the point is to see how [Render Workflows](https://render.com/workflows) and the [`@renderinc/sdk`](https://www.npmjs.com/package/@renderinc/sdk) fit together so the app is straightforward to deploy and safe to change.

## Table of contents

- [Highlights](#highlights)
- [Why build it this way on Render](#why-build-it-this-way-on-render)
- [How it works](#how-it-works)
- [Prerequisites](#prerequisites)
- [Deploy](#deploy)
- [Configuration](#configuration)
- [Project structure](#project-structure)
- [API](#api)
- [Troubleshooting](#troubleshooting)

## Highlights

- **Same SDK, two roles**: the workflow service registers work with `task()` from `@renderinc/sdk/workflows`; the web service triggers runs with `Render` from `@renderinc/sdk`. One dependency, two clear boundaries.
- **Thin web, heavy tasks**: HTTP, WebSockets, and streaming stay in the Hono app. Research, Claude calls, and Postgres writes run in workflow tasks with their own plans, timeouts, and retries.
- **Two trigger patterns you can copy**: fire-and-forget `startTask` for background ingest (voice can keep going), and `startTask` plus `.get()` when the voice agent must block on an answer (recall). The voice proxy and the optional HTTP pipeline endpoints both use the same slugs.
- **Blueprint for the boring parts**: [`render.yaml`](render.yaml) stands up the web service and Postgres. You add the workflow service in the dashboard once; after that, most changes are “edit task code, redeploy the workflow,” not replumbing the whole stack.
- **Four tools, one pipeline**: [AssemblyAI](https://www.assemblyai.com) handles voice tool calls on the web service. [You.com](https://you.com) supplies web evidence inside workflow tasks. [Mastra](https://github.com/mastra-ai/mastra) agents (`factCheckerAgent`, `connectorAgent`, `synthesizerAgent`) run structured judgments and prose in those same tasks via [`src/lib/mastra-workflow.ts`](src/lib/mastra-workflow.ts). [Render Workflows](https://render.com/workflows) executes the durable graph (fact-check, deep dive, connect, store, recall).

## Why build it this way on Render

If you are learning Render, the useful idea is not “use workflows because the docs say so.” It is **where state and CPU live**.

The browser talks to [AssemblyAI](https://www.assemblyai.com) over a WebSocket relay in `src/server.ts` and `src/voice/proxy.ts`. That connection should stay responsive. If you run long research loops and LLM calls in the same process as that relay, you risk timeouts, memory pressure, and noisy deploys: every research tweak becomes a web deploy.

Render Workflows move that work to a **separate service** with isolated scaling and runtime settings. The web service only needs an API key and the SDK to **dispatch** work and optionally **wait** for a result.

**Define tasks** in the workflow service (see `src/workflows/`). Each exported `task({ name, plan, timeoutSeconds, retry }, fn)` is one unit you can tune without touching the web tier. Ingest combines You.com search with Mastra structured outputs in [`src/lib/mastra-workflow.ts`](src/lib/mastra-workflow.ts), then stores to Postgres. Example: `factCheck` in [`src/workflows/ingest.ts`](src/workflows/ingest.ts) calls You.com `quickSearch` and passes evidence into the Mastra fact-checker agent.

**Trigger tasks** from the web service with `new Render()` and `render.workflows.startTask(\`${WORKFLOW_SLUG}/ingest\`, [topic, claim])`. The string `${WORKFLOW_SLUG}/taskExportName` is the contract between services: it must match the workflow service name in the Render dashboard and the `name` you pass to `task()`.

**Change behavior** by editing the task implementation and redeploying the workflow service. The web service keeps dispatching the same slug until you intentionally change arguments or add new tasks. That is the main payoff of the split: product iteration on agents and tools does not require redeploying the voice edge on every tweak.

**Observe runs** in the Render dashboard (task runs, logs, failures). The UI also surfaces recent runs via Postgres-backed tracking; see `src/pipeline/orchestrator.ts` for how SSE phases mirror polling and `started.get()`.

Together with the [langchain-example](https://github.com/ojusave/langchain-test) and [render-workflows-llamaindex](https://github.com/ojusave/render-workflows-llamaindex) repos in the same family, this layout shows the same “thin orchestrator, fat tasks” pattern in Python and Node so you can pick the stack you prefer without guessing how Render fits in.

## How it works

![Architecture](static/images/architecture.png)

The web service proxies WebSocket audio between the browser and AssemblyAI’s voice agent. When the agent calls a tool, the server routes it to a Render Workflow that runs in the background.

![Workflow pipelines](static/images/pipelines.png)

Two calling patterns: `startTask` alone for fire-and-forget (ingest runs while you keep talking), `startTask` + `.get()` when the voice agent needs a result before it can speak (recall).

## Prerequisites

- [AssemblyAI](https://www.assemblyai.com/app), [Render](https://render.com/docs/api#1-create-an-api-key), [Anthropic](https://console.anthropic.com/), and [You.com](https://you.com) API keys
- A [Render account](https://render.com/register?utm_source=github&utm_medium=referral&utm_campaign=ojus_demos&utm_content=readme_link)

## Deploy

### 1. Web service + database (via Blueprint)

Click **Deploy to Render** above. The [`render.yaml`](render.yaml) creates the web service and a PostgreSQL database. During setup, set `ASSEMBLYAI_API_KEY`, `RENDER_API_KEY`, and **`WORKFLOW_SLUG`** (the Workflow service name you will create or already use, for example `ravendr-workflows`). The slug must match the Workflow service name in the dashboard exactly.

### 2. Workflow service (manual)

1. [Render Dashboard](https://dashboard.render.com) > **New** > **Workflow**
2. Connect the same repo
3. Build: `npm install && npm run build`
4. Start: `node dist/workflows/index.js`
5. Name: `ravendr-workflows` (must match `WORKFLOW_SLUG`)
6. Env vars: `ANTHROPIC_API_KEY`, `YOU_API_KEY`, `DATABASE_URL` ([Internal URL](https://render.com/docs/databases#connecting-from-within-render)), `NODE_VERSION`: `22`

## Configuration

| Variable | Where | Default | Description |
|---|---|---|---|
| `ASSEMBLYAI_API_KEY` | Web service | (required) | Voice agent |
| `RENDER_API_KEY` | Web service | (required) | Workflow triggers |
| `DATABASE_URL` | Both | (required) | PostgreSQL connection string |
| `WORKFLOW_SLUG` | Web service | `ravendr-workflows` | Must match workflow service name |
| `ANTHROPIC_API_KEY` | Workflow | (required) | Claude for AI agents |
| `YOU_API_KEY` | Workflow | (required) | Web research |
| `ANTHROPIC_MODEL` | Workflow | `claude-sonnet-4-20250514` | Claude model ID |

Optional on the web service only (add in the Dashboard **Environment** tab; omitted from [`render.yaml`](render.yaml) so Deploy stays short): `POLL_INTERVAL_MS`, `RENDER_DASHBOARD_TASKS_URL`.

## Project structure

```
src/
  server.ts              Hono web server (HTTP + WebSocket)
  voice/
    config.ts            AssemblyAI session config and tool definitions
    proxy.ts             WebSocket proxy: browser <> AssemblyAI <> Workflows
  agents/
    index.ts             Supervisor agent + sub-agent composition
    fact-checker.ts      Scores claim confidence against evidence
    synthesizer.ts       Voice-friendly summaries
    connector.ts         Cross-topic relationship detection
  tools/
    learn.ts             learn_topic > Ingest workflow
    recall.ts            recall_topic > Recall workflow
    report.ts            generate_report > Report workflow
  workflows/
    index.ts             Workflow entry point
    ingest.ts            factCheck + deepDive > connect > store
    recall.ts            search > freshen > synthesize
    report.ts            gather > cluster > crossRef (parallel) > generate
  lib/
    db.ts                PostgreSQL schema + queries
    you-client.ts        You.com Research API wrapper
    mastra-workflow.ts   Mastra agents + You.com evidence inside tasks
  static/index.html      Voice UI and workflow activity panel
render.yaml              Render Blueprint
```

## API

**`WebSocket /ws/voice`**: proxies audio between browser and AssemblyAI. Intercepts tool calls and routes to Render Workflows.

**`GET /api/workflows/recent`**: 10 most recent workflow runs.

**`GET /api/knowledge`**: all knowledge entries.

**`GET /api/report/:taskRunId`**: result of a completed report task.

**`GET /health`**: `{ "status": "ok" }`.

## Troubleshooting

**Deploy fails or health check never goes green**: the web process listens on `0.0.0.0` and `PORT` (set by Render). The HTTP server must use Hono’s Node adapter (`getRequestListener` from `@hono/node-server`), not raw `createServer(app.fetch)`, or static file middleware can throw `this.raw.headers.get is not a function` during health checks. Confirm **Build** logs show `npm run build` succeeding and **Shell** start command is `node dist/server.js` from the repo root. If the **workflow** service failed, open its logs: it needs `DATABASE_URL` (Internal URL), `YOU_API_KEY`, `ANTHROPIC_API_KEY`, and a start command that runs the compiled entry (for example `node dist/workflows/index.js` after the same build as the web service).

**Voice connection fails**: check `ASSEMBLYAI_API_KEY` is set on the web service.

**Workflows never complete**: verify the workflow service name matches `WORKFLOW_SLUG` (default: `ravendr-workflows`).

**"recall" returns empty**: ingest runs in the background. If you recall a topic right after mentioning it, the research may still be running.

**Database errors**: web service gets `DATABASE_URL` from Blueprint. Workflow service needs it copied manually from the database settings (Internal URL).
