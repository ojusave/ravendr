/**
 * Workflow task entry-point. `npm run start:tasks` runs this file; the
 * @renderinc/sdk auto-registers every exported task with Render.
 *
 * Tasks are grouped by the vendor they primarily integrate with:
 *
 *   assemblyai/  — owns the Voice Agent WebSocket
 *   mastra/      — all LLM-driven reasoning (classify, plan, synth, verify)
 *   youcom/      — fans out research calls
 *
 * research.ts at the root is vendor-neutral — it's the pure Render
 * Workflows orchestration that composes the above.
 */
export { voiceSession } from "./assemblyai/voice-session.js";
export { research } from "./research.js";
export { classify_ask } from "./mastra/classify-ask.js";
export { plan_queries } from "./mastra/plan-queries.js";
export { synthesize } from "./mastra/synthesize.js";
export { verify } from "./mastra/verify.js";
export { search_branch } from "./youcom/search-branch.js";
