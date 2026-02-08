import type { CallState, Lead } from "../runTypes";

export interface QuotingHints {
  missingQuoteFields: string[];
  summary: string;
}

const QUOTE_FIELDS: (keyof Lead | string)[] = [
  "serviceType",
  "notes",
  "preferredDate",
  "preferredTimeWindow",
  "address",
  "budget",
];

export function analyzeQuoting(lead: Lead): QuotingHints {
  const missing: string[] = [];
  for (const field of QUOTE_FIELDS) {
    const key = field as keyof Lead;
    if (!lead[key]) missing.push(String(field));
  }

  const summary = missing.length
    ? `Missing quote-related details: ${missing.join(", ")}.`
    : "We appear to have enough information to outline a basic quote.";

  return {
    missingQuoteFields: missing,
    summary,
  };
}

export function buildQuotingGuidance(call: CallState): string {
  const hints = analyzeQuoting(call.lead);
  return [
    "QUOTING GOALS:",
    "- Clarify the type of work (e.g. lawn cleanup, landscape design, hardscaping, maintenance).",
    "- Clarify the size/scope (e.g. front yard only, whole property, approximate square footage).",
    "- Clarify any budget expectations or constraints.",
    "",
    `Quoting assessment: ${hints.summary}`,
  ].join("\n");
}
