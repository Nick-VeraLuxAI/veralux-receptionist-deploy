import type {
  CallState,
  HistoryItem,
  LLMActionResult,
  Lead,
  ReceptionistAction,
  CallOutcome,
  Stage,
} from "./runTypes";
import { isStage, normalizeActions } from "./runTypes";
import { callLLM } from "./localLLM";
import type { LLMConfigStore } from "./config";
import { tenants, DEFAULT_TENANT_ID } from "./tenants";
import { buildIntakeGuidance, analyzeIntake } from "./workflows/intake";
import { buildQuotingGuidance, analyzeQuoting } from "./workflows/quoting";
import { buildSchedulingGuidance, analyzeScheduling } from "./workflows/scheduling";

export interface ReceptionistTurnInput {
  tenantId: string;
  state: CallState;
  callerMessage: string;
}

export interface ReceptionistTurnResult {
  text: string;
  reply: string;
  state: CallState;
  replyText: string;
  actions: ReceptionistAction[];
  systemPrompt: string;
  llmResponseText: string;
}

function summarizeLead(lead: Lead): string {
  const parts: string[] = [];
  if (lead.name) parts.push(`name=${lead.name}`);
  if (lead.email) parts.push(`email=${lead.email}`);
  if (lead.phone) parts.push(`phone=${lead.phone}`);
  if (lead.serviceType) parts.push(`serviceType=${lead.serviceType}`);
  if (lead.address) parts.push(`address=${lead.address}`);
  return parts.length ? parts.join(", ") : "none yet";
}

function summarizeHistory(history: HistoryItem[], maxItems = 6): string {
  const recent = history.slice(-maxItems);
  if (recent.length === 0) return "No prior messages.";
  return recent
    .map((h) => `${h.from}: ${h.message}`)
    .join("\n");
}

function autoPromoteStage(state: CallState): void {
  if (state.stage === "greeting") {
    const { hasMinimumContact } = analyzeIntake(state.lead);
    if (hasMinimumContact) {
      state.stage = "qualifying";
      return;
    }
  }

  if (state.stage === "qualifying") {
    const quotingHints = analyzeQuoting(state.lead);
    const hasEnoughForQuote = quotingHints.missingQuoteFields.length === 0;
    if (hasEnoughForQuote) {
      state.stage = "scheduling";
      return;
    }
  }

  if (state.stage === "scheduling") {
    const intakeHints = analyzeIntake(state.lead);
    const quotingHints = analyzeQuoting(state.lead);
    const schedulingHints = analyzeScheduling(state.lead);

    const hasContact = intakeHints.hasMinimumContact;
    const hasQuoteInfo = quotingHints.missingQuoteFields.length === 0;
    const hasScheduleWindow = schedulingHints.hasPreferredWindow;

    if (hasContact && hasQuoteInfo && hasScheduleWindow) {
      state.stage = "closed";
      return;
    }
  }
}

function inferDefaultActions(state: CallState): ReceptionistAction[] {
  if (state.stage === "greeting" || state.stage === "qualifying") {
    const intakeHints = analyzeIntake(state.lead);
    if (!intakeHints.hasMinimumContact) {
      return ["collect-missing-contact"];
    }
    const quotingHints = analyzeQuoting(state.lead);
    if (quotingHints.missingQuoteFields.length > 0) {
      return ["collect-project-details"];
    }
    return ["clarify-question"];
  }

  if (state.stage === "scheduling") {
    const schedulingHints = analyzeScheduling(state.lead);
    const quotingHints = analyzeQuoting(state.lead);

    if (!schedulingHints.hasPreferredWindow) {
      return ["clarify-question"];
    }

    if (quotingHints.missingQuoteFields.length > 0) {
      return ["collect-project-details"];
    }

    return ["confirm-schedule"];
  }

  if (state.stage === "handoff") {
    // Default expectation in handoff stage:
    // - Ask if there is anything else
    // - Potentially answer a simple FAQ
    // The model can explicitly choose "handoff-to-human" via JSON when needed.
    return ["clarify-question"];
  }

  if (state.stage === "closed") {
    // Call is effectively done. We may pass context to a human and end the call.
    return ["handoff-to-human", "end-call"];
  }

  return [];
}

function buildStageGuidance(state: CallState): string {
  if (state.stage === "scheduling") {
    return buildSchedulingGuidance(state);
  }
  if (state.stage === "greeting" || state.stage === "qualifying") {
    return [
      buildIntakeGuidance(state),
      "",
      buildQuotingGuidance(state),
      "",
      "RESPONSE RULES:",
      "- Ask ONE question at a time. Wait for the caller to answer before asking the next.",
      "- Do NOT say 'anything else I can help with?' or 'is there anything else?' during this stage. You are still collecting information — save that for after you have everything you need.",
      "- End your response with your qualifying question and nothing else.",
    ].join("\n");
  }
  if (state.stage === "handoff") {
    return [
      "HANDOFF / WRAP-UP GOALS:",
      "- You have collected the key details (contact, project scope, budget, timing). This stage is where you wrap up and route the call correctly.",
      "- First, ask: 'Before I connect you with the team or finalize anything, is there anything else I can help you with?'",
      "- If the caller has a simple, factual question you can answer confidently (an FAQ), answer it briefly and clearly. You may then ask once more if there is anything else.",
      "- If the caller asks a question that is unclear, complex, or policy-specific, say something like: 'I don't know the answer to that off the top of my head. Let me grab a team member who might have a better answer for you.' and include 'handoff-to-human' in actions.",
      "- Do NOT reopen intake or qualification. Do NOT re-ask for info you already have.",
    ].join("\n");
  }
  // closed
  return [
    "CLOSED STAGE:",
    "- You are done handling this call as the virtual receptionist.",
    "- Thank the caller warmly and end the conversation politely.",
    "- You may briefly remind them what will happen next (e.g., 'You should see a confirmation email soon.'), but do not introduce new tasks or questions.",
    "- Do not reopen the conversation unless the caller explicitly asks something new.",
  ].join("\n");
}

function buildPrompt(
  state: CallState,
  callerMessage: string,
  cfg: LLMConfigStore
): string {
  const { systemPreamble, policyPrompt, voicePrompt, schemaHint } = cfg.getPrompts();

  const historySummary = summarizeHistory(state.history);
  const stageGuidance = buildStageGuidance(state);

  // NOTE: In admin, schemaHint should tell the model:
  // - When stage === "handoff":
  //   - First ask if there is anything else you can help with.
  //   - If the caller asks a simple question you can answer, answer succinctly and keep stage as "handoff" or move to "closed" if they are done.
  //   - If the caller asks something you are not sure about, say you will grab a team member and include "handoff-to-human" in actions.
  // - When stage === "closed":
  //   - Thank the caller, explain next steps briefly if any, and include "end-call" (and optionally "handoff-to-human") in actions.

  return [
    systemPreamble ||
      "You are the VeraLux on-premises virtual receptionist for a local service business.",
    "",
    policyPrompt || "",
    "",
    voicePrompt || "",
    "",
    `CURRENT STAGE: ${state.stage}`,
    "",
    stageGuidance,
    "",
    "RECENT CONVERSATION (most recent last):",
    historySummary,
    "",
    "CALLER JUST SAID:",
    callerMessage,
    "",
    schemaHint ||
      `Respond ONLY with a single JSON object like:
{
  "replyText": "string - what you say to the caller",
  "actions": ["optional", "string", "flags"],
  "stage": "optional stage string: greeting|qualifying|scheduling|handoff|closed",
  "leadUpdates": { "optional": "updates to the lead object" },
  "outcome": "optional call outcome: new-lead|existing-customer|info-only|spam-or-mistake|internal-test|unknown"
}`,
  ].join("\n");
}

function safeParseLLMJson(rawText: string): Partial<LLMActionResult> {
  // Extract first JSON object-looking segment
  const match = rawText.match(/\{[\s\S]*\}/);
  if (!match) return {};
  try {
    const parsed = JSON.parse(match[0]);
    const result: Partial<LLMActionResult> = {};
    if (typeof parsed.replyText === "string") {
      result.replyText = parsed.replyText;
    }
    if (Array.isArray(parsed.actions)) {
      result.actions = parsed.actions as ReceptionistAction[];
    }
    if (typeof parsed.stage === "string" && isStage(parsed.stage)) {
      result.stage = parsed.stage as Stage;
    }
    if (parsed.leadUpdates && typeof parsed.leadUpdates === "object") {
      result.leadUpdates = parsed.leadUpdates as Partial<Lead>;
    }
    if (typeof parsed.outcome === "string") {
      result.outcome = parsed.outcome as CallOutcome;
    }
    return result;
  } catch {
    return {};
  }
}

export async function runReceptionistTurn(
  input: ReceptionistTurnInput
): Promise<ReceptionistTurnResult> {
  const { state, callerMessage } = input;
  const tenantId = input.tenantId || state.tenantId || DEFAULT_TENANT_ID;
  if (state.tenantId && state.tenantId !== tenantId) {
    throw new Error(
      `Call belongs to tenant ${state.tenantId}, but ${tenantId} was provided.`
    );
  }

  const tenant = tenants.getOrCreate(tenantId);
  const cfg = tenant.config;

  const now = Date.now();
  const callerHistoryItem: HistoryItem = {
    from: "caller",
    message: callerMessage,
    timestamp: now,
  };
  state.history = [...state.history, callerHistoryItem];
  tenant.analytics.recordCallerMessage(callerMessage);

  const prompt = buildPrompt(state, callerMessage, cfg);

  let llmRaw: string;
  let parsed: Partial<LLMActionResult> = {};
  try {
    const { rawText } = await callLLM({ prompt }, { tenantId, config: cfg });
    llmRaw = rawText;
    parsed = safeParseLLMJson(rawText);
  } catch (err) {
    console.error("runReceptionistTurn LLM error:", err);
    llmRaw = "";
  }

  const replyText =
    parsed.replyText && parsed.replyText.trim().length > 0
      ? parsed.replyText
      : "I'm sorry, I had a little trouble on my end. Could you please repeat that or tell me a bit more about what you need help with?";

  if (parsed.stage && isStage(parsed.stage)) {
    state.stage = parsed.stage;
  }

  if (parsed.leadUpdates) {
    state.lead = { ...state.lead, ...parsed.leadUpdates };
  }

  autoPromoteStage(state);

  const normalizedActions = normalizeActions(parsed.actions);
  let finalActions = normalizedActions;
  if (finalActions.length === 0) {
    finalActions = inferDefaultActions(state);
  }

  let outcome: CallOutcome = "unknown";
  if (parsed.outcome && typeof parsed.outcome === "string") {
    outcome = parsed.outcome as CallOutcome;
  } else {
    const hasName = !!state.lead.name;
    const hasContact = !!state.lead.phone || !!state.lead.email;
    if (state.stage === "closed" && hasName && hasContact) {
      outcome = "new-lead";
    } else if (state.stage === "closed") {
      outcome = "info-only";
    }
  }

  const assistantItem: HistoryItem = {
    from: "assistant",
    message: replyText,
    timestamp: Date.now(),
  };
  state.history = [...state.history, assistantItem];

  return {
    state,
    // ✅ old fields (keep compatibility)
    text: replyText,
    reply: replyText,

    // ✅ new fields (what you're actually using)
    replyText,
    actions: finalActions,
    systemPrompt: `Stage: ${state.stage} | Lead: ${summarizeLead(state.lead)}`,
    llmResponseText: llmRaw,
  };

}
