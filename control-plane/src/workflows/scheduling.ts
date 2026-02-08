import type { CallState, Lead } from "../runTypes";

export interface SchedulingHints {
  hasPreferredWindow: boolean;
  summary: string;
}

export function analyzeScheduling(lead: Lead): SchedulingHints {
  const hasPreferredWindow = !!lead.preferredDate || !!lead.preferredTimeWindow;

  const summary = hasPreferredWindow
    ? "Caller has provided some preferred date/time information."
    : "Caller has NOT provided any clear preferred date or time yet.";

  return {
    hasPreferredWindow,
    summary,
  };
}

export function buildSchedulingGuidance(call: CallState): string {
  const hints = analyzeScheduling(call.lead);
  return [
    "SCHEDULING GOALS:",
    "- Confirm if the caller has any preferred dates or time windows.",
    "- Confirm if there are any constraints (weekdays vs weekends, mornings vs afternoons).",
    "- Move toward either booking or a clear follow-up next step.",
    "",
    `Scheduling assessment: ${hints.summary}`,
  ].join("\n");
}
