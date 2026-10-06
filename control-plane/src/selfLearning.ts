import type { PromptConfig } from "./config";
import type { CallHistoryRow } from "./db";
import type { AnalyticsSnapshot } from "./analytics";
import { callLLM } from "./localLLM";

const MAX_CALLS_FOR_ANALYSIS = 25;
const MAX_TRANSCRIPT_CHARS = 900;
const MAX_SUMMARY_CHARS = 300;
const MAX_TOP_QUESTIONS = 12;
const MIN_QUESTION_COUNT = 2;

const QUESTION_START_RE =
  /^(who|what|when|where|why|how|can|could|would|will|do|does|did|is|are|am|may|should)\b/i;

export interface LearningSuggestion {
  summary: string;
  policyPromptAppend: string;
  businessFaqAppend: string;
  shouldApply: boolean;
  source: "model" | "heuristic";
}

export interface RunSelfLearningInput {
  tenantId: string;
  prompts: PromptConfig;
  callHistoryRows: CallHistoryRow[];
  analytics: AnalyticsSnapshot;
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 3))}...`;
}

function squeezeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function isLikelyQuestion(text: string): boolean {
  const cleaned = squeezeWhitespace(text);
  if (!cleaned) return false;
  if (cleaned.includes("?")) return true;
  return QUESTION_START_RE.test(cleaned);
}

function normalizeQuestion(text: string): string {
  const cleaned = squeezeWhitespace(text).toLowerCase();
  return cleaned.replace(/[?!.]+$/g, "");
}

function extractRecurringQuestions(input: RunSelfLearningInput): Array<{ text: string; count: number }> {
  const counts = new Map<string, { text: string; count: number }>();

  for (const q of input.analytics.topQuestions.slice(0, MAX_TOP_QUESTIONS)) {
    if (!isLikelyQuestion(q.text)) continue;
    const key = normalizeQuestion(q.text);
    const existing = counts.get(key);
    if (existing) {
      existing.count += q.count;
    } else {
      counts.set(key, { text: squeezeWhitespace(q.text), count: q.count });
    }
  }

  for (const row of input.callHistoryRows.slice(0, MAX_CALLS_FOR_ANALYSIS)) {
    const history = Array.isArray(row.history) ? row.history : [];
    for (const turn of history) {
      if (!turn || typeof turn !== "object") continue;
      const role = typeof (turn as Record<string, unknown>).role === "string"
        ? String((turn as Record<string, unknown>).role)
        : typeof (turn as Record<string, unknown>).from === "string"
        ? String((turn as Record<string, unknown>).from)
        : "";
      if (role !== "caller") continue;
      const content = typeof (turn as Record<string, unknown>).content === "string"
        ? String((turn as Record<string, unknown>).content)
        : typeof (turn as Record<string, unknown>).message === "string"
        ? String((turn as Record<string, unknown>).message)
        : "";
      if (!isLikelyQuestion(content)) continue;

      const key = normalizeQuestion(content);
      const existing = counts.get(key);
      if (existing) {
        existing.count += 1;
      } else {
        counts.set(key, { text: squeezeWhitespace(content), count: 1 });
      }
    }
  }

  return [...counts.values()]
    .filter((q) => q.count >= MIN_QUESTION_COUNT)
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);
}

function buildLearningPrompt(
  prompts: PromptConfig,
  calls: CallHistoryRow[],
  recurringQuestions: Array<{ text: string; count: number }>
): string {
  const callContext = calls.slice(0, MAX_CALLS_FOR_ANALYSIS).map((c, idx) => {
    const summary = c.summary ? truncate(squeezeWhitespace(c.summary), MAX_SUMMARY_CHARS) : "";
    const transcript = c.transcript
      ? truncate(squeezeWhitespace(c.transcript), MAX_TRANSCRIPT_CHARS)
      : "";
    return [
      `CALL ${idx + 1}:`,
      `- stage: ${c.stage || "unknown"}`,
      `- summary: ${summary || "(none)"}`,
      `- transcript_excerpt: ${transcript || "(none)"}`,
    ].join("\n");
  });

  const questionLines = recurringQuestions.length
    ? recurringQuestions.map((q) => `- (${q.count}x) ${q.text}`).join("\n")
    : "- none";

  return [
    "You are improving a phone receptionist prompt set using recent call outcomes.",
    "Return ONLY a JSON object (no markdown) with keys:",
    'summary: string, policyPromptAppend: string, businessFaqAppend: string, shouldApply: boolean',
    "",
    "Rules:",
    "- Keep additions concise and high-signal.",
    "- Do not invent business facts, prices, hours, or guarantees.",
    "- Prefer robust fallback behavior (collect callback info, offer transfer).",
    "- If there is not enough signal, return empty strings and shouldApply=false.",
    "",
    "CURRENT POLICY PROMPT:",
    prompts.policyPrompt || "(empty)",
    "",
    "CURRENT BUSINESS FAQ:",
    prompts.businessFaq || "(empty)",
    "",
    "RECURRING CALLER QUESTIONS:",
    questionLines,
    "",
    "RECENT CALLS:",
    callContext.join("\n\n") || "(none)",
  ].join("\n");
}

function parseSuggestion(raw: string): LearningSuggestion | null {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]) as Record<string, unknown>;
    const summary = typeof parsed.summary === "string" ? parsed.summary.trim() : "";
    const policyPromptAppend =
      typeof parsed.policyPromptAppend === "string" ? parsed.policyPromptAppend.trim() : "";
    const businessFaqAppend =
      typeof parsed.businessFaqAppend === "string" ? parsed.businessFaqAppend.trim() : "";
    const shouldApply = parsed.shouldApply === true;

    return {
      summary: truncate(summary, 1500),
      policyPromptAppend: truncate(policyPromptAppend, 3000),
      businessFaqAppend: truncate(businessFaqAppend, 3000),
      shouldApply,
      source: "model",
    };
  } catch {
    return null;
  }
}

function buildHeuristicSuggestion(
  recurringQuestions: Array<{ text: string; count: number }>
): LearningSuggestion {
  if (recurringQuestions.length === 0) {
    return {
      summary: "No recurring question pattern found in recent calls.",
      policyPromptAppend: "",
      businessFaqAppend: "",
      shouldApply: false,
      source: "heuristic",
    };
  }

  const lines = recurringQuestions
    .slice(0, 5)
    .map((q) => `- Common caller question (${q.count}x): "${q.text}"`);

  const faqAppend = [
    "Frequently asked caller topics to handle consistently:",
    ...lines,
    "- If an answer is not explicitly configured, collect contact details and offer team follow-up.",
  ].join("\n");

  return {
    summary: "Generated FAQ guidance from repeated caller questions.",
    policyPromptAppend:
      "When callers ask a question that is not explicitly covered in configured business information, avoid guessing. Offer to collect contact details and route to the team for follow-up.",
    businessFaqAppend: faqAppend,
    shouldApply: true,
    source: "heuristic",
  };
}

function appendWithHeader(existing: string, header: string, addition: string): string {
  const trimmedExisting = (existing || "").trim();
  const trimmedAddition = (addition || "").trim();
  if (!trimmedAddition) return trimmedExisting;
  if (trimmedExisting.toLowerCase().includes(trimmedAddition.toLowerCase())) {
    return trimmedExisting;
  }

  const block = `${header}\n${trimmedAddition}`;
  if (!trimmedExisting) return block;
  return `${trimmedExisting}\n\n${block}`;
}

export function applyLearningSuggestion(
  prompts: PromptConfig,
  suggestion: LearningSuggestion
): Partial<PromptConfig> {
  if (!suggestion.shouldApply) return {};
  const stamp = new Date().toISOString().slice(0, 10);
  const policyHeader = `SELF-LEARNING UPDATE (${stamp})`;
  const faqHeader = `SELF-LEARNING FAQ UPDATE (${stamp})`;

  const nextPolicy = appendWithHeader(
    prompts.policyPrompt || "",
    policyHeader,
    suggestion.policyPromptAppend
  );
  const nextFaq = appendWithHeader(
    prompts.businessFaq || "",
    faqHeader,
    suggestion.businessFaqAppend
  );

  const updates: Partial<PromptConfig> = {};
  if (nextPolicy !== (prompts.policyPrompt || "").trim()) {
    updates.policyPrompt = nextPolicy;
  }
  if (nextFaq !== (prompts.businessFaq || "").trim()) {
    updates.businessFaq = nextFaq;
  }
  return updates;
}

export async function runSelfLearning(
  input: RunSelfLearningInput
): Promise<LearningSuggestion> {
  const recurringQuestions = extractRecurringQuestions(input);
  const prompt = buildLearningPrompt(input.prompts, input.callHistoryRows, recurringQuestions);

  try {
    const modelResp = await callLLM({ prompt }, { tenantId: input.tenantId });
    const parsed = parseSuggestion(modelResp.rawText);
    if (parsed) {
      const hasAnyContent = !!parsed.policyPromptAppend || !!parsed.businessFaqAppend;
      return {
        ...parsed,
        shouldApply: parsed.shouldApply && hasAnyContent,
      };
    }
  } catch (err) {
    console.error("[self-learning] model generation failed:", err);
  }

  return buildHeuristicSuggestion(recurringQuestions);
}
