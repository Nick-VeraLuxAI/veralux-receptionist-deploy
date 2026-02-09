/**
 * Shared types for the workflow automation engine.
 */

// ── Trigger types ────────────────────────────────

export type TriggerType =
  | "call_ended"
  | "after_hours_call"
  | "keyword_detected"
  | "missed_call"
  | "scheduled";

export interface TriggerConfig {
  /** Keywords to match in transcript (for keyword_detected) */
  keywords?: string[];
  /** Cron expression (for scheduled) */
  cronExpression?: string;
  /** Business hours start HH:MM (for after_hours_call) */
  businessHoursStart?: string;
  /** Business hours end HH:MM (for after_hours_call) */
  businessHoursEnd?: string;
  /** Timezone (for after_hours / scheduled) */
  timezone?: string;
  /** Max call duration in seconds to qualify as missed (for missed_call) */
  maxDurationSeconds?: number;
  /** Minimum turns to not count as missed (for missed_call) */
  minTurns?: number;
}

// ── Action types ─────────────────────────────────

export type ActionType =
  | "send_email"
  | "send_sms"
  | "fire_webhook"
  | "ai_summarize"
  | "ai_extract"
  | "store_lead";

export interface WorkflowStep {
  action: ActionType;
  config: Record<string, any>;
  order: number;
}

// ── Workflow definition ──────────────────────────

export interface Workflow {
  id: string;
  tenantId: string;
  name: string;
  enabled: boolean;
  triggerType: TriggerType;
  triggerConfig: TriggerConfig;
  steps: WorkflowStep[];
  createdBy: string;
  adminLocked: boolean;
  createdAt: string;
  updatedAt: string;
}

// ── Workflow run ─────────────────────────────────

export type RunStatus = "pending" | "running" | "completed" | "failed";

export interface WorkflowRun {
  id: string;
  workflowId: string;
  tenantId: string;
  triggerEvent: Record<string, any>;
  status: RunStatus;
  stepsCompleted: number;
  stepsTotal: number;
  result: StepResult[];
  error: string | null;
  startedAt: string;
  completedAt: string | null;
}

export interface StepResult {
  action: ActionType;
  order: number;
  status: "ok" | "error";
  output?: any;
  error?: string;
  durationMs?: number;
}

// ── Lead ─────────────────────────────────────────

export interface Lead {
  id: string;
  tenantId: string;
  callId: string | null;
  name: string | null;
  phone: string | null;
  email: string | null;
  issue: string | null;
  category: string | null;
  priority: string;
  notes: string | null;
  rawExtract: Record<string, any> | null;
  sourceWorkflowId: string | null;
  createdAt: string;
}

// ── Event payload ────────────────────────────────

export interface CallEndedEvent {
  type: "call_ended";
  tenantId: string;
  callId: string;
  callerId?: string;
  calledNumber?: string;
  durationMs?: number;
  turns?: Array<{ role: string; content: string; timestamp?: string }>;
  transcript?: string;
  lead?: Record<string, any>;
  timestamp: string;
}

export interface ScheduledEvent {
  type: "scheduled";
  tenantId: string;
  workflowId: string;
  timestamp: string;
}

export type WorkflowEvent = CallEndedEvent | ScheduledEvent;

// ── Pipeline context ─────────────────────────────

export interface PipelineContext {
  event: WorkflowEvent;
  workflow: Workflow;
  runId: string;
  tenantId: string;
  /** Accumulated outputs from previous steps (keyed by step order) */
  stepOutputs: Record<number, any>;
}

// ── Workflow settings ────────────────────────────

export interface WorkflowSettings {
  ownerCanEdit: boolean;
}
