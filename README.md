# Ravendr: Voice Knowledge Base Builder

A voice-first knowledge base builder that lets you have ongoing conversations about topics you're learning. Ravendr researches, fact-checks, and stores everything: then recalls it on demand with freshness checks.

Built with **Mastra** (agent orchestration), **You.com** (web research), **AssemblyAI** (voice agents), and **Render Workflows** (durable background tasks).

## How It Works

Talk about any topic, and Ravendr kicks off background research workflows:

1. **Learn**: discuss a topic, and Ravendr triggers an Ingest workflow that fact-checks your claims and deep-researches the topic in parallel
2. **Recall**: ask "what do I know about X?" and Ravendr searches your knowledge base, checks freshness against live web data, and reads back a briefing
3. **Report**: request a full synthesis and Ravendr clusters, cross-references, and generates a comprehensive report

## Architecture

```
Browser (mic/speaker)
    ↕ WebSocket
Hono Server (Render Web Service)
    ↕ WebSocket proxy
AssemblyAI Voice Agent API
    ↕ tool.call / tool.result
Render Workflows (3 workflow types)
    ↕ tasks
You.com Research API + Anthropic Claude
    ↕ results
PostgreSQL (Render Managed DB)
```

### Three Workflow Types

| Workflow | Pattern | Trigger | Tasks |
|----------|---------|---------|-------|
| **Ingest** | Parallel + chain | Fire-and-forget | factCheck + deepDive (parallel) → connect → store |
| **Recall** | Sequential chain | Trigger-and-wait | search → freshen → synthesize |
| **Report** | Dynamic parallel | Fire-and-forget | gather → cluster → crossReference (parallel per cluster) → report |

## Deploy to Render

### Step 1: Deploy the web service + database via Blueprint

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/ojusave/ravendr)

This creates:
- **Web Service** (`ravendr-web`): Hono server, voice proxy, static UI
- **PostgreSQL** (`ravendr-db`): knowledge store

### Step 2: Create the Workflow service manually

Render Workflows are in beta and cannot be deployed via Blueprint. Create the workflow service from the [Render Dashboard](https://dashboard.render.com/):

1. Go to **New** → **Workflow**
2. Connect the same GitHub repo (`ojusave/ravendr`)
3. Set the service name to `ravendr-workflows`
4. Configure:
   - **Build command**: `npm install && npm run build`
   - **Start command**: `node dist/workflows/index.js`
   - **Plan**: Starter
5. Add environment variables:

| Variable | Value |
|----------|-------|
| `ANTHROPIC_API_KEY` | Your Anthropic API key ([console.anthropic.com](https://console.anthropic.com/)) |
| `YOU_API_KEY` | Your You.com API key ([you.com](https://you.com)) |
| `ANTHROPIC_MODEL` | `claude-sonnet-4-20250514` |
| `DATABASE_URL` | Copy from the `ravendr-db` database's connection info |
| `NODE_VERSION` | `22` |

6. Once the workflow service is running, update the web service's `WORKFLOW_SLUG` env var to match the workflow service slug (defaults to `ravendr-workflows`)

### Required API Keys

| Key | Service | Where to Get |
|-----|---------|-------------|
| `ASSEMBLYAI_API_KEY` | Web | [assemblyai.com/app](https://www.assemblyai.com/app) |
| `RENDER_API_KEY` | Web | [render.com/docs/api](https://render.com/docs/api#1-create-an-api-key) |
| `ANTHROPIC_API_KEY` | Workflow | [console.anthropic.com](https://console.anthropic.com/) |
| `YOU_API_KEY` | Workflow | [you.com](https://you.com) |

## Local Development

```bash
cp .env.example .env
# Fill in your API keys

npm install
npm run dev
```

The web server starts at `http://localhost:3000`. You need a running PostgreSQL instance for the knowledge store.

## Project Structure

```
ravendr/
  src/
    server.ts              # Hono server: API routes, WebSocket proxy, static
    voice/
      config.ts            # AssemblyAI session config + tool definitions
      proxy.ts             # WebSocket proxy: browser ↔ AssemblyAI
    agents/
      index.ts             # Supervisor agent + sub-agent composition
      fact-checker.ts      # Validates claims
      synthesizer.ts       # Generates voice-friendly summaries
      connector.ts         # Finds cross-topic connections
    tools/
      learn.ts             # learn_topic: triggers Ingest workflow
      recall.ts            # recall_topic: triggers Recall workflow
      report.ts            # generate_report: triggers Report workflow
      status.ts            # check_status: polls workflow runs
    workflows/
      ingest.ts            # Ingest: factCheck + deepDive → connect → store
      recall.ts            # Recall: search → freshen → synthesize
      report.ts            # Report: gather → cluster → crossRef → report
      index.ts             # Workflow entry point
    lib/
      db.ts                # PostgreSQL schema + queries
      you-client.ts        # You.com Research API wrapper
      llm.ts               # Anthropic Claude helper
      render-utils.ts      # Render signup URLs + branding
    static/
      index.html           # Web UI: voice controls + knowledge dashboard
  render.yaml              # Render Blueprint (web service + database)
```

## Tech Stack

- **[Mastra](https://mastra.ai)**: TypeScript AI agent framework: supervisor pattern, sub-agents, tool system
- **[You.com](https://you.com)**: Research API with tiered effort (lite for fact-checks, deep for topic expansion)
- **[AssemblyAI](https://www.assemblyai.com)**: Voice Agent API: speech-to-speech with tool calling over WebSocket
- **[Render Workflows](https://render.com/workflows)**: durable background tasks with retries, parallelism, and observability
- **[Hono](https://hono.dev)**: lightweight web framework
- **[PostgreSQL](https://www.postgresql.org)**: knowledge store

## License

MIT
