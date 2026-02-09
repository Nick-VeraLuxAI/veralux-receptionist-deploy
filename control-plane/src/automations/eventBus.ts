/**
 * In-process event bus for workflow triggers.
 *
 * The voice runtime POSTs call events to the control plane.
 * This module receives those events, derives secondary triggers
 * (after_hours, keyword, missed), and dispatches to the matcher.
 */

import type { CallEndedEvent, WorkflowEvent, TriggerType } from "./types";
import { matchAndEnqueue } from "./matcher";

type Listener = (event: WorkflowEvent) => void;

const listeners = new Map<string, Set<Listener>>();

export function on(eventType: string, fn: Listener): void {
  if (!listeners.has(eventType)) listeners.set(eventType, new Set());
  listeners.get(eventType)!.add(fn);
}

export function off(eventType: string, fn: Listener): void {
  listeners.get(eventType)?.delete(fn);
}

function emit(eventType: string, event: WorkflowEvent): void {
  const fns = listeners.get(eventType);
  if (fns) {
    for (const fn of fns) {
      try {
        fn(event);
      } catch (err) {
        console.error(`[eventBus] listener error for ${eventType}:`, err);
      }
    }
  }
}

/**
 * Called when the voice runtime reports a call has ended.
 * Derives all applicable trigger types and dispatches them.
 */
export async function handleCallEnded(event: CallEndedEvent): Promise<void> {
  const triggers: TriggerType[] = ["call_ended"];

  // Derive after_hours_call — we always emit it; matcher checks time ranges
  triggers.push("after_hours_call");

  // Derive keyword_detected — we always emit it; matcher checks keyword matches
  if (event.transcript || event.turns?.length) {
    triggers.push("keyword_detected");
  }

  // Derive missed_call — short duration or zero turns
  const turnCount = event.turns?.length ?? 0;
  const durationSec = (event.durationMs ?? 0) / 1000;
  if (turnCount <= 1 || durationSec < 15) {
    triggers.push("missed_call");
  }

  // Emit to in-process listeners
  for (const trigger of triggers) {
    emit(trigger, { ...event, type: trigger as any });
  }

  // Dispatch to workflow matcher for each trigger type
  for (const trigger of triggers) {
    try {
      await matchAndEnqueue(event.tenantId, trigger, event);
    } catch (err) {
      console.error(`[eventBus] matchAndEnqueue failed for ${trigger}:`, err);
    }
  }
}

/**
 * Called by the scheduled trigger loop.
 */
export async function handleScheduledTrigger(
  tenantId: string,
  workflowId: string
): Promise<void> {
  const event: WorkflowEvent = {
    type: "scheduled",
    tenantId,
    workflowId,
    timestamp: new Date().toISOString(),
  };
  emit("scheduled", event);
  try {
    await matchAndEnqueue(tenantId, "scheduled", event);
  } catch (err) {
    console.error(`[eventBus] scheduled matchAndEnqueue failed:`, err);
  }
}
