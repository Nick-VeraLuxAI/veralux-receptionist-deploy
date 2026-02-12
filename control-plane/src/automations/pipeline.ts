/**
 * Step pipeline: executes workflow steps sequentially,
 * passing context (event data + previous step outputs) through each step.
 */

import type {
  Workflow, WorkflowEvent, PipelineContext, StepResult, WorkflowStep,
} from "./types";
import { createRun, updateRun, getWorkflow } from "./db";
import { actionHandlers } from "./actions";
import { retryJob } from "./jobQueue";
import type { WorkflowJob } from "./jobQueue";

/**
 * Execute a full workflow pipeline.
 */
export async function executePipeline(job: WorkflowJob): Promise<void> {
  const { workflowId, tenantId, event } = job;

  // Load the workflow definition
  const workflow = await getWorkflow(workflowId, tenantId);
  if (!workflow) {
    console.warn(`[pipeline] Workflow ${workflowId} not found for tenant ${tenantId}, skipping`);
    return;
  }

  if (!workflow.enabled) {
    console.log(`[pipeline] Workflow "${workflow.name}" is disabled, skipping`);
    return;
  }

  // Sort steps by order
  const steps = [...workflow.steps].sort((a, b) => a.order - b.order);

  // Create a run record
  const run = await createRun({
    workflowId,
    tenantId,
    triggerEvent: event as any,
    stepsTotal: steps.length,
  });

  const ctx: PipelineContext = {
    event,
    workflow,
    runId: run.id,
    tenantId,
    stepOutputs: {},
  };

  const results: StepResult[] = [];
  let failed = false;

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const handler = actionHandlers[step.action];

    if (!handler) {
      const result: StepResult = {
        action: step.action,
        order: step.order,
        status: "error",
        error: `Unknown action: ${step.action}`,
      };
      results.push(result);
      failed = true;

      await updateRun(run.id, {
        status: "failed",
        stepsCompleted: i,
        result: results,
        error: result.error,
      }, tenantId);
      break;
    }

    const startTime = Date.now();
    try {
      const output = await handler(ctx, step.config ?? {});
      const result: StepResult = {
        action: step.action,
        order: step.order,
        status: "ok",
        output,
        durationMs: Date.now() - startTime,
      };
      results.push(result);
      ctx.stepOutputs[step.order] = output;

      await updateRun(run.id, {
        stepsCompleted: i + 1,
        result: results,
      }, tenantId);

      console.log(
        `[pipeline] Step ${i + 1}/${steps.length} (${step.action}) completed in ${result.durationMs}ms`
      );
    } catch (err: any) {
      const result: StepResult = {
        action: step.action,
        order: step.order,
        status: "error",
        error: err.message ?? String(err),
        durationMs: Date.now() - startTime,
      };
      results.push(result);
      failed = true;

      console.error(
        `[pipeline] Step ${i + 1}/${steps.length} (${step.action}) failed:`,
        err.message
      );

      await updateRun(run.id, {
        status: "failed",
        stepsCompleted: i,
        result: results,
        error: result.error,
      }, tenantId);
      break;
    }
  }

  if (!failed) {
    await updateRun(run.id, {
      status: "completed",
      stepsCompleted: steps.length,
      result: results,
    }, tenantId);
    console.log(
      `[pipeline] Workflow "${workflow.name}" completed successfully (${steps.length} steps)`
    );
  } else {
    // Retry the job if possible
    const retried = await retryJob(job);
    if (retried) {
      console.log(`[pipeline] Workflow "${workflow.name}" queued for retry`);
    } else {
      console.warn(`[pipeline] Workflow "${workflow.name}" failed after max retries`);
    }
  }
}

/**
 * Execute a workflow pipeline in dry-run mode (no side effects).
 * Returns the results without persisting anything.
 */
export async function dryRunPipeline(
  workflow: Workflow,
  event: WorkflowEvent
): Promise<{ steps: StepResult[]; wouldMatch: boolean }> {
  const steps = [...workflow.steps].sort((a, b) => a.order - b.order);

  const ctx: PipelineContext = {
    event,
    workflow,
    runId: "dry-run",
    tenantId: workflow.tenantId,
    stepOutputs: {},
  };

  const results: StepResult[] = [];

  // Check if conditions would match
  // We simulate — just verify each step handler exists and describe what would happen
  for (const step of steps) {
    const handler = actionHandlers[step.action];
    if (!handler) {
      results.push({
        action: step.action,
        order: step.order,
        status: "error",
        error: `Unknown action: ${step.action}`,
      });
      continue;
    }

    results.push({
      action: step.action,
      order: step.order,
      status: "ok",
      output: {
        dryRun: true,
        description: `Would execute ${step.action} with config: ${JSON.stringify(step.config)}`,
      },
    });
  }

  return { steps: results, wouldMatch: true };
}
