/**
 * Built-in workflow action handlers.
 *
 * Each action receives a PipelineContext and its step config,
 * and returns an output object.
 */

import type { PipelineContext, CallEndedEvent } from "./types";
import { createLead } from "./db";
import { pool } from "../db";
import * as crypto from "crypto";

// ── send_email ───────────────────────────────────

export async function sendEmail(
  ctx: PipelineContext,
  config: {
    to: string;
    subject?: string;
    body?: string;
    smtpHost?: string;
    smtpPort?: number;
    smtpUser?: string;
    smtpPass?: string;
    fromAddress?: string;
  }
): Promise<{ sent: boolean; to: string; subject: string }> {
  // Dynamically import nodemailer (it may not be installed yet)
  let nodemailer: any;
  try {
    nodemailer = await import("nodemailer");
  } catch {
    console.warn("[actions/send_email] nodemailer not installed, skipping");
    return { sent: false, to: config.to, subject: config.subject ?? "" };
  }

  // Get SMTP config from step config or env
  const host = config.smtpHost || process.env.SMTP_HOST || "localhost";
  const port = config.smtpPort || parseInt(process.env.SMTP_PORT || "587");
  const user = config.smtpUser || process.env.SMTP_USER || "";
  const pass = config.smtpPass || process.env.SMTP_PASS || "";
  const from = config.fromAddress || process.env.SMTP_FROM || "noreply@veralux.ai";

  const subject = interpolate(config.subject || "Workflow notification", ctx);
  const body = interpolate(config.body || "A workflow event occurred.", ctx);

  const transporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: user ? { user, pass } : undefined,
  });

  await transporter.sendMail({
    from,
    to: config.to,
    subject,
    text: body,
    html: body.replace(/\n/g, "<br>"),
  });

  return { sent: true, to: config.to, subject };
}

// ── send_sms ─────────────────────────────────────

export async function sendSms(
  ctx: PipelineContext,
  config: {
    to: string;
    message?: string;
    from?: string;
  }
): Promise<{ sent: boolean; to: string }> {
  const message = interpolate(config.message || "You have a new notification from VeraLux.", ctx);
  const from = config.from || process.env.TELNYX_PHONE_NUMBER;

  if (!from) {
    console.warn("[actions/send_sms] No from number configured");
    return { sent: false, to: config.to };
  }

  const apiKey = process.env.TELNYX_API_KEY;
  if (!apiKey) {
    console.warn("[actions/send_sms] TELNYX_API_KEY not set");
    return { sent: false, to: config.to };
  }

  try {
    const resp = await fetch("https://api.telnyx.com/v2/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        from,
        to: config.to,
        text: message,
      }),
    });

    if (!resp.ok) {
      const errBody = await resp.text();
      console.error("[actions/send_sms] Telnyx error:", errBody);
      return { sent: false, to: config.to };
    }

    return { sent: true, to: config.to };
  } catch (err) {
    console.error("[actions/send_sms] Error:", err);
    return { sent: false, to: config.to };
  }
}

// ── fire_webhook ─────────────────────────────────

export async function fireWebhook(
  ctx: PipelineContext,
  config: {
    url: string;
    method?: string;
    headers?: Record<string, string>;
    secret?: string;
    includeTranscript?: boolean;
    includeStepOutputs?: boolean;
  }
): Promise<{ statusCode: number; success: boolean }> {
  const payload: Record<string, any> = {
    event: ctx.event.type,
    tenantId: ctx.tenantId,
    workflowId: ctx.workflow.id,
    workflowName: ctx.workflow.name,
    runId: ctx.runId,
    timestamp: new Date().toISOString(),
  };

  if (config.includeTranscript !== false && ctx.event.type !== "scheduled") {
    const callEvent = ctx.event as CallEndedEvent;
    payload.transcript = callEvent.transcript;
    payload.callId = callEvent.callId;
    payload.callerId = callEvent.callerId;
  }

  if (config.includeStepOutputs) {
    payload.previousSteps = ctx.stepOutputs;
  }

  const bodyStr = JSON.stringify(payload);

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(config.headers ?? {}),
  };

  // HMAC signature
  if (config.secret) {
    const sig = crypto
      .createHmac("sha256", config.secret)
      .update(bodyStr)
      .digest("hex");
    headers["X-Veralux-Signature"] = sig;
  }

  const resp = await fetch(config.url, {
    method: config.method || "POST",
    headers,
    body: bodyStr,
  });

  return {
    statusCode: resp.status,
    success: resp.ok,
  };
}

// ── LLM helper ───────────────────────────────────

/** Resolve the OpenAI-compatible chat completions endpoint. */
function getLlmEndpoint(): string {
  const base = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
  // Normalise to always end at /v1/chat/completions
  if (base.endsWith("/chat/completions")) return base;
  const trimmed = base.replace(/\/+$/, "");
  if (trimmed.endsWith("/v1")) return `${trimmed}/chat/completions`;
  return `${trimmed}/v1/chat/completions`;
}

function getLlmApiKey(): string {
  return process.env.OPENAI_API_KEY || "ollama";
}

function getLlmModel(override?: string): string {
  return override || process.env.OPENAI_MODEL || "qwen2.5:7b";
}

// ── ai_summarize ─────────────────────────────────

export async function aiSummarize(
  ctx: PipelineContext,
  config: {
    prompt?: string;
    maxTokens?: number;
    model?: string;
  }
): Promise<{ summary: string }> {
  const callEvent = ctx.event as CallEndedEvent;
  const transcript =
    callEvent.transcript ??
    callEvent.turns?.map(t => `${t.role}: ${t.content}`).join("\n") ??
    "";

  const systemPrompt =
    config.prompt ??
    "You are an assistant that summarizes phone call transcripts. Provide a concise summary including key points, action items, and any follow-up needed.";

  const model = getLlmModel(config.model);
  const endpoint = getLlmEndpoint();
  const apiKey = getLlmApiKey();

  const resp = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: `Please summarize the following call transcript:\n\n${transcript}` },
      ],
      max_tokens: config.maxTokens || 500,
      temperature: 0.3,
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    console.error("[actions/ai_summarize] LLM error:", errText);
    return { summary: `[AI summarize error: ${resp.status}]` };
  }

  const data = await resp.json() as any;
  return {
    summary: data.choices?.[0]?.message?.content?.trim() ?? "[No summary generated]",
  };
}

// ── ai_extract ───────────────────────────────────

export async function aiExtract(
  ctx: PipelineContext,
  config: {
    prompt?: string;
    fields?: string[];
    model?: string;
  }
): Promise<{ extracted: Record<string, any> }> {
  const callEvent = ctx.event as CallEndedEvent;
  const transcript =
    callEvent.transcript ??
    callEvent.turns?.map(t => `${t.role}: ${t.content}`).join("\n") ??
    "";

  const fields = config.fields ?? ["name", "phone", "email", "issue", "category", "priority"];

  const systemPrompt =
    config.prompt ??
    `You are a data extraction assistant. Extract the following fields from the phone call transcript: ${fields.join(", ")}. Return ONLY a JSON object with these fields. If a field is not found, use null. No explanation, just JSON.`;

  const model = getLlmModel(config.model);
  const endpoint = getLlmEndpoint();
  const apiKey = getLlmApiKey();

  const resp = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: `Extract data from this call transcript:\n\n${transcript}` },
      ],
      max_tokens: 500,
      temperature: 0,
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    console.error("[actions/ai_extract] LLM error:", errText);
    return { extracted: { error: `AI extraction error: ${resp.status}` } };
  }

  const data = await resp.json() as any;
  const content = data.choices?.[0]?.message?.content?.trim() ?? "{}";

  try {
    // The LLM may wrap JSON in markdown code fences — strip them
    const cleaned = content.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/, "");
    return { extracted: JSON.parse(cleaned) };
  } catch {
    return { extracted: { raw: content } };
  }
}

// ── store_lead ───────────────────────────────────

export async function storeLead(
  ctx: PipelineContext,
  config: {
    /** Use extracted data from a previous ai_extract step (by order number) */
    fromStep?: number;
    name?: string;
    phone?: string;
    email?: string;
    issue?: string;
    category?: string;
    priority?: string;
    notes?: string;
  }
): Promise<{ leadId: string }> {
  const callEvent = ctx.event as CallEndedEvent;

  // Get data from a previous AI extract or build_quote step if specified
  let extractedData: Record<string, any> = {};
  if (config.fromStep !== undefined && ctx.stepOutputs[config.fromStep]) {
    const prev = ctx.stepOutputs[config.fromStep];
    // build_quote outputs { quote: {...} }, ai_extract outputs { extracted: {...} }
    extractedData = prev?.quote ?? prev?.extracted ?? {};
  }

  // Also check the event's lead data
  const eventLead = callEvent.lead ?? {};

  // Merge: config overrides > extracted > event lead
  // Quote data uses customerName/customerPhone/customerEmail fields
  const leadData = {
    tenantId: ctx.tenantId,
    callId: callEvent.callId ?? undefined,
    name: config.name || extractedData.customerName || extractedData.name || eventLead.name || undefined,
    phone: config.phone || extractedData.customerPhone || extractedData.phone || eventLead.phone || callEvent.callerId || undefined,
    email: config.email || extractedData.customerEmail || extractedData.email || eventLead.email || undefined,
    issue: config.issue || extractedData.issue || eventLead.issue || undefined,
    category: config.category || extractedData.category || eventLead.category || undefined,
    priority: config.priority || extractedData.priority || "normal",
    notes: config.notes || extractedData.notes || undefined,
    rawExtract: Object.keys(extractedData).length ? extractedData : undefined,
    sourceWorkflowId: ctx.workflow.id,
  };

  const lead = await createLead(leadData);
  return { leadId: lead.id };
}

// ── Tenant pricing helpers ───────────────────────

/**
 * Fetch the tenant's pricing data from the database.
 */
async function fetchTenantPricing(tenantId: string): Promise<{
  items: Array<{ name: string; price: string; description?: string }>;
  notes?: string;
}> {
  try {
    const result = await pool.query(
      "SELECT pricing FROM tenant_configs WHERE tenant_id = $1",
      [tenantId]
    );
    if (result.rows.length > 0 && result.rows[0].pricing) {
      const pricing = result.rows[0].pricing;
      return {
        items: Array.isArray(pricing.items) ? pricing.items : [],
        notes: pricing.notes || undefined,
      };
    }
  } catch (err) {
    console.error("[actions] Failed to fetch tenant pricing:", err);
  }
  return { items: [] };
}

/**
 * Parse a price string like "$2.50/sqft", "$150/hour", "$49.99 each" into numeric amount and unit.
 */
function parsePriceString(price: string): { amount: number; unit: string } {
  if (!price) return { amount: 0, unit: "each" };
  // Extract numeric value
  const numMatch = price.match(/[\d,]+\.?\d*/);
  const amount = numMatch ? parseFloat(numMatch[0].replace(/,/g, "")) : 0;
  // Extract unit (text after / or after the number)
  const unitMatch = price.match(/\/\s*(\w+)/) || price.match(/per\s+(\w+)/i) || price.match(/\d\s+(\w+)/);
  const unit = unitMatch ? unitMatch[1] : "each";
  return { amount, unit };
}

// ── ai_extract_quote ─────────────────────────────

export async function aiExtractQuote(
  ctx: PipelineContext,
  config: {
    taxRate?: number;
    model?: string;
  }
): Promise<{ extracted: Record<string, any> }> {
  const callEvent = ctx.event as CallEndedEvent;
  const transcript =
    callEvent.transcript ??
    callEvent.turns?.map(t => `${t.role}: ${t.content}`).join("\n") ??
    "";

  // Fetch the tenant's existing pricing from the database
  const tenantPricing = await fetchTenantPricing(ctx.tenantId);
  const priceListText = tenantPricing.items.length > 0
    ? `\n\nAvailable products/services and pricing:\n${tenantPricing.items.map(p => `- ${p.name}: ${p.price}${p.description ? ` (${p.description})` : ""}`).join("\n")}`
    : "";

  const systemPrompt = `You are a quote extraction assistant. Analyze the phone call transcript and extract information needed to build a quote.${priceListText}

Return ONLY a JSON object (no explanation) with:
{
  "customerName": "string or null",
  "customerPhone": "string or null",
  "customerEmail": "string or null",
  "lineItems": [
    {
      "description": "item/service name",
      "type": "service or product",
      "quantity": number,
      "unitPrice": number,
      "unit": "hour/each/sqft/etc"
    }
  ],
  "notes": "any special requirements, delivery notes, or context from the call"
}

Match requested items to the price list when possible. If the caller mentions something not on the price list, include it with unitPrice: 0 and a note. Estimate quantities from context clues in the conversation.`;

  const model = getLlmModel(config.model);
  const endpoint = getLlmEndpoint();
  const apiKey = getLlmApiKey();

  const resp = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: `Extract quote details from this call transcript:\n\n${transcript}` },
      ],
      max_tokens: 1000,
      temperature: 0,
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    console.error("[actions/ai_extract_quote] LLM error:", errText);
    return { extracted: { error: `AI quote extraction error: ${resp.status}` } };
  }

  const data = await resp.json() as any;
  const content = data.choices?.[0]?.message?.content?.trim() ?? "{}";

  try {
    // The LLM may wrap JSON in markdown code fences — strip them
    const cleaned = content.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/, "");
    const parsed = JSON.parse(cleaned);
    // Also carry caller info from the event
    if (!parsed.customerPhone && callEvent.callerId) {
      parsed.customerPhone = callEvent.callerId;
    }
    return { extracted: parsed };
  } catch {
    return { extracted: { raw: content } };
  }
}

// ── build_quote ──────────────────────────────────

export async function buildQuote(
  ctx: PipelineContext,
  config: {
    fromStep?: number;
    taxRate?: number;
  }
): Promise<{ quote: Record<string, any> }> {
  // Get raw extracted data from the previous ai_extract_quote step
  let extractedData: Record<string, any> = {};
  if (config.fromStep !== undefined && ctx.stepOutputs[config.fromStep]) {
    extractedData = ctx.stepOutputs[config.fromStep]?.extracted ?? {};
  }

  const taxRate = config.taxRate ?? 0;

  // Fetch the tenant's existing pricing to validate against
  const tenantPricing = await fetchTenantPricing(ctx.tenantId);

  // Build a lookup map from existing tenant pricing
  // Parse price strings like "$2.50/sqft" or "$150/hour" into numeric values
  const priceMap = new Map<string, { unitPrice: number; unit: string; type: string }>();
  for (const item of tenantPricing.items) {
    const parsed = parsePriceString(item.price);
    priceMap.set(item.name.toLowerCase(), {
      unitPrice: parsed.amount,
      unit: parsed.unit,
      type: item.description?.toLowerCase().includes("product") ? "product" : "service",
    });
  }

  // Validate and enforce real prices for line items
  const rawItems = extractedData.lineItems ?? [];
  const lineItems: Array<{
    description: string;
    type: string;
    quantity: number;
    unitPrice: number;
    unit: string;
    total: number;
  }> = [];

  for (const item of rawItems) {
    const qty = Math.max(Number(item.quantity) || 1, 0);
    // Try to match to price list for accurate pricing
    const matched = priceMap.get((item.description || "").toLowerCase());
    const unitPrice = matched ? matched.unitPrice : (Number(item.unitPrice) || 0);
    const unit = matched ? matched.unit : (item.unit || "each");
    const type = matched ? matched.type : (item.type || "service");

    lineItems.push({
      description: item.description || "Unnamed item",
      type,
      quantity: qty,
      unitPrice,
      unit,
      total: Math.round(qty * unitPrice * 100) / 100,
    });
  }

  const subtotal = Math.round(lineItems.reduce((sum, item) => sum + item.total, 0) * 100) / 100;
  const tax = Math.round(subtotal * taxRate * 100) / 100;
  const grandTotal = Math.round((subtotal + tax) * 100) / 100;

  // Generate quote number: Q-YYYYMMDD-XXXX
  const now = new Date();
  const datePart = now.toISOString().slice(0, 10).replace(/-/g, "");
  const randPart = crypto.randomBytes(2).toString("hex").toUpperCase();
  const quoteNumber = `Q-${datePart}-${randPart}`;

  const quote = {
    quoteNumber,
    customerName: extractedData.customerName || null,
    customerPhone: extractedData.customerPhone || null,
    customerEmail: extractedData.customerEmail || null,
    lineItems,
    subtotal,
    taxRate,
    tax,
    grandTotal,
    notes: extractedData.notes || null,
    status: "draft",
    createdAt: now.toISOString(),
  };

  return { quote };
}

// ── Template interpolation ───────────────────────

/**
 * Recursively flatten an object for template interpolation.
 * { quote: { quoteNumber: "Q-123" } } with prefix "step.1"
 * → { "{{step.1.quote.quoteNumber}}": "Q-123", "{{step.1.quote}}": "[object Object]" }
 */
function flattenForInterpolation(
  obj: Record<string, any>,
  prefix: string,
  out: Record<string, string>,
  depth = 0
): void {
  if (depth > 3) return; // Prevent infinite recursion
  for (const [key, value] of Object.entries(obj)) {
    const path = `${prefix}.${key}`;
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      flattenForInterpolation(value, path, out, depth + 1);
    }
    out[`{{${path}}}`] = Array.isArray(value) ? value.join(", ") : String(value ?? "");
  }
}

/**
 * Simple template interpolation for email/SMS bodies.
 * Supports {{caller}}, {{transcript}}, {{summary}}, {{tenant}}, etc.
 */
function interpolate(template: string, ctx: PipelineContext): string {
  const callEvent = ctx.event as CallEndedEvent;
  const replacements: Record<string, string> = {
    "{{caller}}": callEvent.callerId ?? "Unknown",
    "{{callId}}": callEvent.callId ?? "",
    "{{tenant}}": ctx.tenantId,
    "{{workflow}}": ctx.workflow.name,
    "{{timestamp}}": new Date().toISOString(),
    "{{transcript}}":
      callEvent.transcript ??
      callEvent.turns?.map(t => `${t.role}: ${t.content}`).join("\n") ??
      "(no transcript)",
  };

  // Also substitute step outputs like {{step.1.summary}} and nested like {{step.1.quote.quoteNumber}}
  for (const [order, output] of Object.entries(ctx.stepOutputs)) {
    if (typeof output === "object" && output !== null) {
      flattenForInterpolation(output, `step.${order}`, replacements);
    }
  }

  // Also support {{extracted.customerEmail}} from the most recent extract step
  for (const [_order, output] of Object.entries(ctx.stepOutputs)) {
    if (output?.extracted && typeof output.extracted === "object") {
      for (const [k, v] of Object.entries(output.extracted)) {
        if (!replacements[`{{extracted.${k}}}`]) {
          replacements[`{{extracted.${k}}}`] = String(v ?? "");
        }
      }
    }
    if (output?.quote && typeof output.quote === "object") {
      for (const [k, v] of Object.entries(output.quote as Record<string, any>)) {
        if (!replacements[`{{extracted.${k}}}`]) {
          replacements[`{{extracted.${k}}}`] = String(v ?? "");
        }
      }
    }
  }

  let result = template;
  for (const [token, value] of Object.entries(replacements)) {
    result = result.split(token).join(value);
  }
  return result;
}

// ── Action registry ──────────────────────────────

export const actionHandlers: Record<
  string,
  (ctx: PipelineContext, config: Record<string, any>) => Promise<any>
> = {
  send_email: sendEmail as any,
  send_sms: sendSms as any,
  fire_webhook: fireWebhook as any,
  ai_summarize: aiSummarize as any,
  ai_extract: aiExtract as any,
  ai_extract_quote: aiExtractQuote as any,
  build_quote: buildQuote as any,
  store_lead: storeLead as any,
};
