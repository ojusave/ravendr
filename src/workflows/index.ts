/**
 * Workflow entry point: registers all tasks with the Render Workflows runtime.
 * Run with: tsx src/workflows/index.ts
 */

import "./ingest.js";
import "./recall.js";
import "./report.js";

console.log("Ravendr workflows registered: ingest, recall, report");
