import type { CallState, Lead } from "../runTypes";

export interface IntakeHints {
  missingContactFields: (keyof Lead)[];
  hasMinimumContact: boolean;
  summary: string;
}

const CONTACT_FIELDS: (keyof Lead)[] = ["name", "phone", "email", "address"];

export function analyzeIntake(lead: Lead): IntakeHints {
  const missingContactFields: (keyof Lead)[] = [];
  for (const field of CONTACT_FIELDS) {
    if (!lead[field]) missingContactFields.push(field);
  }

  const hasMinimumContact = !!lead.name && (!!lead.phone || !!lead.email);

  const summary = [
    hasMinimumContact
      ? "We have enough contact info to follow up."
      : "We are still missing some key contact details.",
    missingContactFields.length
      ? `Missing contact fields: ${missingContactFields.join(", ")}.`
      : "No required contact fields appear to be missing.",
  ].join(" ");

  return {
    missingContactFields,
    hasMinimumContact,
    summary,
  };
}

export function buildIntakeGuidance(call: CallState): string {
  const hints = analyzeIntake(call.lead);
  return [
    "INTAKE GOALS:",
    "- Collect caller name, phone, email, and address.",
    "- Understand the basic nature of the project or service they need.",
    "",
    `Intake assessment: ${hints.summary}`,
  ].join("\n");
}
