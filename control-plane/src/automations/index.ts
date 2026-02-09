/**
 * Automation engine entry point.
 * Exports all public APIs and initializes the engine.
 */

export { handleCallEnded, handleScheduledTrigger } from "./eventBus";
export { matchAndEnqueue } from "./matcher";
export { executePipeline, dryRunPipeline } from "./pipeline";
export { enqueueJob, onJob, startPolling, stopPolling } from "./jobQueue";
export { startScheduler, stopScheduler } from "./scheduler";
export { actionHandlers } from "./actions";
export * from "./types";
export * from "./db";

import { onJob, startPolling } from "./jobQueue";
import { executePipeline } from "./pipeline";
import { startScheduler } from "./scheduler";

/**
 * Initialize the workflow automation engine.
 * Call once at server startup.
 */
export function initAutomationEngine(): void {
  // Register the pipeline executor as the job processor
  onJob((job) => {
    executePipeline(job).catch(err => {
      console.error("[automations] Pipeline execution error:", err);
    });
  });

  // Start polling for jobs
  startPolling(2000);

  // Start the scheduled trigger checker
  startScheduler(30_000);

  console.log("[automations] Workflow automation engine initialized");
}

/**
 * Gracefully shut down the engine.
 */
export function shutdownAutomationEngine(): void {
  const { stopPolling } = require("./jobQueue");
  const { stopScheduler } = require("./scheduler");
  stopPolling();
  stopScheduler();
  console.log("[automations] Workflow automation engine shut down");
}
