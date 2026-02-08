export type Stage =
  | "greeting"
  | "qualifying"
  | "scheduling"
  | "handoff"
  | "closed";

export const STAGES: Stage[] = [
  "greeting",
  "qualifying",
  "scheduling",
  "handoff",
  "closed",
];

export type ReceptionistAction =
  | "handoff-to-human"
  | "end-call"
  | "confirm-schedule"
  | "collect-missing-contact"
  | "collect-project-details"
  | "clarify-question"
  | "small-talk-brief"
  | "error-fallback";

export const ALLOWED_ACTIONS: ReceptionistAction[] = [
  "handoff-to-human",
  "end-call",
  "confirm-schedule",
  "collect-missing-contact",
  "collect-project-details",
  "clarify-question",
  "small-talk-brief",
  "error-fallback",
];

export type CallOutcome =
  | "new-lead"
  | "existing-customer"
  | "info-only"
  | "spam-or-mistake"
  | "internal-test"
  | "unknown";

export function isStage(value: unknown): value is Stage {
  return typeof value === "string" && STAGES.includes(value as Stage);
}

export function normalizeActions(actions: unknown): ReceptionistAction[] {
  if (!Array.isArray(actions)) return [];
  const set = new Set<string>();
  for (const a of actions) {
    if (typeof a !== "string") continue;
    if ((ALLOWED_ACTIONS as string[]).includes(a)) {
      set.add(a as ReceptionistAction);
    }
  }
  return Array.from(set) as ReceptionistAction[];
}

export interface Lead {
  name?: string;
  email?: string;
  phone?: string;
  company?: string;
  address?: string;
  preferredDate?: string;
  preferredTimeWindow?: string;
  serviceType?: string;
  notes?: string;
  [key: string]: unknown;
}

export type HistoryActor = "caller" | "assistant" | "system";

export interface HistoryItem {
  from: HistoryActor;
  message: string;
  timestamp: number;
}

export interface CallState {
  id: string;
  tenantId: string;
  callerId?: string;
  stage: Stage;
  lead: Lead;
  history: HistoryItem[];
  lastActivityAt?: number;
  createdAt?: number;
}

export interface LLMActionResult {
  replyText: string;
  actions?: ReceptionistAction[];
  stage?: Stage;
  leadUpdates?: Partial<Lead>;
  outcome?: CallOutcome;
  rawText: string;
}
