/**
 * Normalize a phone number to digits and leading + only (for lookup/matching).
 * Not E.164 validation; use runtimeContract.normalizeE164 for that.
 */
export function normalizePhoneNumber(input?: string): string {
  if (!input) return "";
  return input.replace(/[^\d+]/g, "");
}
