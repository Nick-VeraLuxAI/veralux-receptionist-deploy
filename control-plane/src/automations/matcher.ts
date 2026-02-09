/**
 * Workflow matcher: given a trigger event, finds all matching workflows
 * for the tenant and enqueues them for execution.
 */

import type { TriggerType, WorkflowEvent, Workflow, CallEndedEvent } from "./types";
import { getEnabledWorkflowsByTrigger } from "./db";
import { enqueueJob } from "./jobQueue";

/**
 * Check if a workflow's trigger conditions match the event.
 */
function evaluateConditions(workflow: Workflow, event: WorkflowEvent): boolean {
  const cfg = workflow.triggerConfig;

  switch (workflow.triggerType) {
    case "call_ended":
      // Always matches — no additional conditions
      return true;

    case "after_hours_call": {
      // Check if the event occurred outside business hours
      const start = cfg.businessHoursStart ?? "09:00";
      const end = cfg.businessHoursEnd ?? "17:00";
      const tz = cfg.timezone ?? "America/New_York";

      try {
        const eventTime = new Date(event.timestamp);
        // Get hour:minute in the tenant's timezone
        const formatter = new Intl.DateTimeFormat("en-US", {
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
          timeZone: tz,
        });
        const parts = formatter.formatToParts(eventTime);
        const hour = parseInt(parts.find(p => p.type === "hour")?.value ?? "12");
        const minute = parseInt(parts.find(p => p.type === "minute")?.value ?? "0");
        const currentMinutes = hour * 60 + minute;

        const [startH, startM] = start.split(":").map(Number);
        const [endH, endM] = end.split(":").map(Number);
        const startMinutes = startH * 60 + startM;
        const endMinutes = endH * 60 + endM;

        // Outside business hours = before start or after end
        return currentMinutes < startMinutes || currentMinutes >= endMinutes;
      } catch {
        return false;
      }
    }

    case "keyword_detected": {
      const keywords = cfg.keywords ?? [];
      if (keywords.length === 0) return false;

      // Build transcript text from event
      const callEvent = event as CallEndedEvent;
      const text = (
        callEvent.transcript ??
        callEvent.turns?.map(t => t.content).join(" ") ??
        ""
      ).toLowerCase();

      return keywords.some(kw => text.includes(kw.toLowerCase()));
    }

    case "missed_call": {
      const callEvent = event as CallEndedEvent;
      const maxDuration = (cfg.maxDurationSeconds ?? 15) * 1000;
      const minTurns = cfg.minTurns ?? 2;

      const duration = callEvent.durationMs ?? 0;
      const turnCount = callEvent.turns?.length ?? 0;

      return duration < maxDuration || turnCount < minTurns;
    }

    case "scheduled":
      // Scheduled triggers are dispatched by the scheduler, always match
      return true;

    default:
      return false;
  }
}

/**
 * Find all matching workflows for a trigger event and enqueue them.
 */
export async function matchAndEnqueue(
  tenantId: string,
  triggerType: TriggerType,
  event: WorkflowEvent
): Promise<number> {
  const workflows = await getEnabledWorkflowsByTrigger(tenantId, triggerType);
  let enqueued = 0;

  for (const wf of workflows) {
    if (evaluateConditions(wf, event)) {
      try {
        await enqueueJob({
          workflowId: wf.id,
          tenantId,
          event,
        });
        enqueued++;
        console.log(`[matcher] Enqueued workflow "${wf.name}" (${wf.id}) for ${triggerType}`);
      } catch (err) {
        console.error(`[matcher] Failed to enqueue workflow ${wf.id}:`, err);
      }
    }
  }

  return enqueued;
}
