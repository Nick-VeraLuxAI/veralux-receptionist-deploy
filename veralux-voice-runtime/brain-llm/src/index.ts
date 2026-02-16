/**
 * Brain LLM service for veralux-voice-runtime: OpenAI-compatible backend with transfer support.
 * Receives POST /reply (and /reply/stream) from the runtime and returns { text, transfer? }.
 * Loads .env from this dir first, then parent .env (root) so OPENAI_API_KEY can live in one place.
 */

import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config(); // brain-llm/.env
dotenv.config({ path: path.resolve(__dirname, '../../.env') }); // root .env (overrides / supplies OPENAI_API_KEY)

import express, { Request, Response } from 'express';
import OpenAI from 'openai';
import type {
  BrainReplyRequest,
  BrainReplyResponse,
  BrainTransferAction,
  TransferProfile,
} from './types.js';

const PORT = Number(process.env.PORT ?? 3001);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY?.trim() || 'ollama';
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL?.trim() || undefined;
const MODEL = process.env.OPENAI_MODEL?.trim() ?? 'qwen2.5:7b';
const MAX_TOKENS = Number(process.env.BRAIN_MAX_TOKENS ?? 50);
// Ollama is 8-9x slower when tools are passed (even an empty array).
// We detect end_call and transfer_call intent via heuristics instead.
const TOOLS_DISABLED = (process.env.BRAIN_DISABLE_TOOLS ?? 'true').toLowerCase() === 'true';

const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
  ...(OPENAI_BASE_URL ? { baseURL: OPENAI_BASE_URL } : {}),
});

console.log(`Brain config: model=${MODEL}, maxTokens=${MAX_TOKENS}, baseURL=${OPENAI_BASE_URL || 'default (api.openai.com)'}`);

const TRANSFER_TOOL_NAME = 'transfer_call';
const END_CALL_TOOL_NAME = 'end_call';

function buildSystemPrompt(
  transferProfiles?: TransferProfile[],
  assistantContext?: Record<string, string>,
): string {
  // IMPORTANT: This prompt must be SHORT and SIMPLE for local models.
  // Do NOT add JSON schemas, complex rules, or verbose instructions.
  let prompt = `You are a friendly phone receptionist. Answer the caller's question in one short sentence, then ask "Anything else I can help with?"

IMPORTANT: Reply with plain spoken English only. Never output JSON, code, or structured data.`;

  if (assistantContext && Object.keys(assistantContext).length > 0) {
    prompt += `\n\nHere is the business info you know:`;
    for (const [section, text] of Object.entries(assistantContext)) {
      if (text?.trim()) {
        prompt += `\n${section}: ${text.trim()}`;
      }
    }
  }

  if (transferProfiles?.length) {
    prompt += `\n\nYou can transfer calls to: ${transferProfiles.map((p) => `${p.holder || p.name} (${p.responsibilities.join(', ')})`).join(', ')}.`;
  }

  return prompt;
}

function historyToMessages(history: BrainReplyRequest['history'], transcript: string): OpenAI.Chat.ChatCompletionMessageParam[] {
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];

  for (const turn of history) {
    if (turn.role === 'system') {
      messages.push({ role: 'system', content: turn.content });
    } else if (turn.role === 'user') {
      messages.push({ role: 'user', content: turn.content });
    } else if (turn.role === 'assistant') {
      messages.push({ role: 'assistant', content: turn.content });
    }
  }

  messages.push({ role: 'user', content: transcript });
  return messages;
}

function getEndCallToolDefinition(): OpenAI.Chat.ChatCompletionTool {
  return {
    type: 'function',
    function: {
      name: END_CALL_TOOL_NAME,
      description:
        'End the phone call ONLY when the caller explicitly says goodbye or says they have no more questions. ' +
        'Examples of when to use: "bye", "goodbye", "no thanks", "that\'s all", "I\'m good", "nothing else". ' +
        'Do NOT use this tool when the caller is asking a question — even if the question contains words like "close", "closing", "done", or "finish". ' +
        'Questions like "what time do you close?" or "when do you close?" are asking about business hours — answer them, do NOT end the call.',
      parameters: {
        type: 'object',
        properties: {
          goodbye_message: {
            type: 'string',
            description: 'A warm goodbye message to say before hanging up (e.g. "Alright, have a great day! Goodbye.").',
          },
        },
        required: ['goodbye_message'],
      },
    },
  };
}

function getTransferToolDefinition(): OpenAI.Chat.ChatCompletionTool[] {
  return [
    {
      type: 'function',
      function: {
        name: TRANSFER_TOOL_NAME,
        description:
          'Transfer the call to another number (person or department). Call this when the caller asks to speak to someone or be transferred to sales, support, etc.',
        parameters: {
          type: 'object',
          properties: {
            to: {
              type: 'string',
              description: 'E.164 phone number or SIP URI to transfer to (must match a destination from the transfer options).',
            },
            message_to_caller: {
              type: 'string',
              description: 'Short phrase to say to the caller before transferring (e.g. "I\'ll connect you with Morgan in Sales now.").',
            },
          },
          required: ['to', 'message_to_caller'],
        },
      },
    },
  ];
}

function findProfileByDestination(
  transferProfiles: TransferProfile[] | undefined,
  to: string,
): TransferProfile | undefined {
  if (!transferProfiles?.length) return undefined;
  return transferProfiles.find((p) => p.destination === to || p.destination === to.trim());
}

/**
 * Detect if the assistant's response is a goodbye/farewell that should end the call.
 * Checks: the user indicated they're done + the assistant said goodbye (not asking another question).
 */
function isGoodbyeResponse(
  assistantText: string,
  userTranscript: string,
  history: BrainReplyRequest['history'],
): boolean {
  const reply = assistantText.toLowerCase();
  const user = userTranscript.toLowerCase();

  // The assistant's reply should contain goodbye-like language
  const goodbyePhrases = [
    'goodbye', 'good bye', 'bye', 'have a great day', 'have a good day',
    'have a nice day', 'have a wonderful day', 'take care', 'talk to you later',
    'thanks for calling', 'thank you for calling',
  ];
  const hasGoodbye = goodbyePhrases.some((p) => reply.includes(p));
  if (!hasGoodbye) return false;

  // The assistant's reply should NOT end with a question (meaning they're still prompting)
  const endsWithQuestion = reply.trimEnd().endsWith('?');
  if (endsWithQuestion) return false;

  // Extra check: the user's last message should indicate they're done
  const doneIndicators = [
    'no', 'nope', 'nah', "that's all", 'thats all', "that's it", 'thats it',
    "i'm good", 'im good', 'all good', 'all set', 'thanks', 'thank you',
    'bye', 'goodbye', 'good bye', 'have a good', 'nothing else', 'no thanks',
    'no thank you',
  ];
  const userDone = doneIndicators.some((d) => user.includes(d));

  // Also check if the previous assistant message asked "anything else?"
  const lastAssistant = [...history].reverse().find((t) => t.role === 'assistant');
  const askedAnythingElse = lastAssistant?.content.toLowerCase().includes('anything else') ||
    lastAssistant?.content.toLowerCase().includes('help you with') ||
    lastAssistant?.content.toLowerCase().includes('can i help');

  return userDone || (hasGoodbye && !!askedAnythingElse);
}

/**
 * Detect whether the caller's transcript is a question.
 * When the caller is asking something, we should never end the call.
 */
function isCallerQuestion(transcript: string): boolean {
  const t = transcript.trim().toLowerCase();
  if (t.endsWith('?')) return true;
  // Question starters (Whisper sometimes drops the "?" so we check prefixes)
  const questionStarters = [
    'what', 'when', 'where', 'how', 'who', 'which', 'why',
    'do you', 'does', 'can you', 'can i', 'could you', 'is there',
    'are you', 'are there', 'will you', 'would you',
  ];
  if (questionStarters.some((q) => t.startsWith(q))) return true;
  // Catch common question patterns even when Whisper mangles the start
  // e.g. "The time you guys close." or "Time to get close." → about business hours
  const questionPatterns = [
    /\btime\b.*\b(close|open|closing|opening|hours)\b/,
    /\b(close|open|closing|opening)\b.*\btime\b/,
    /\bhours\b/,
    /\bwhat time\b/,
    /\bwhen do\b/,
    /\bhow much\b/,
    /\bhow long\b/,
    /\bwhere are\b/,
    /\bwhere is\b/,
    /\bdo you (have|offer|provide|do|sell|take)\b/,
    /\baddress\b/,
    /\blocation\b/,
    /\bpric(e|ing|es)\b/,
    /\bcost\b/,
    /\bestimate\b/,
  ];
  return questionPatterns.some((p) => p.test(t));
}

/**
 * Match caller transcript against transfer profiles using heuristic keywords.
 * Handles two cases:
 *   1. Explicit transfer: "transfer me to sales", "can I speak to Morgan"
 *   2. Implicit help-seeking: "I need someone to help me with a quote",
 *      "looking for someone who handles estimates", "who do I talk to about billing"
 * Returns { profile, reason } or undefined.
 */
function matchTransferProfile(
  transcript: string,
  transferProfiles: TransferProfile[] | undefined,
): { profile: TransferProfile; reason: 'explicit' | 'implicit' } | undefined {
  if (!transferProfiles?.length) return undefined;
  const t = transcript.toLowerCase();

  // --- Explicit transfer keywords ---
  const hasExplicitTransfer =
    /\b(transfer|connect|speak to|talk to|speak with|talk with|put me through)\b/i.test(t);

  // --- Implicit help-seeking patterns ---
  // Catches: "I need someone who can help with X", "looking for someone to do X",
  //          "who handles X", "is there anyone who does X", "I need help with X",
  //          "can someone help me with X", "I want to get a quote/estimate"
  const hasImplicitTransfer =
    /\b(looking for someone|need someone|is there (someone|anyone|somebody)|who (handles|does|can help|deals with)|need help with|can someone|could someone|want to (get|start|begin|set up|schedule)|need (a|to get a) (quote|estimate|consultation|appointment|callback))\b/i.test(t);

  if (!hasExplicitTransfer && !hasImplicitTransfer) return undefined;

  const reason = hasExplicitTransfer ? 'explicit' as const : 'implicit' as const;

  // Try matching by holder name, profile name, or responsibility keywords
  for (const p of transferProfiles) {
    const nameMatch = p.holder && t.includes(p.holder.toLowerCase());
    const nameMatch2 = p.name && t.includes(p.name.toLowerCase());
    // Check each responsibility word/phrase
    const respMatch = p.responsibilities.some((r) => {
      const rLower = r.toLowerCase();
      // Direct mention of the responsibility
      if (t.includes(rLower)) return true;
      // Also check individual words for multi-word responsibilities (e.g. "sales quotes")
      const words = rLower.split(/\s+/).filter((w) => w.length > 3);
      return words.length > 0 && words.some((w) => t.includes(w));
    });
    if (nameMatch || nameMatch2 || respMatch) return { profile: p, reason };
  }

  // If caller uses explicit "transfer me" and there's only one profile, use it
  if (hasExplicitTransfer && transferProfiles.length === 1) {
    return { profile: transferProfiles[0], reason };
  }

  // If implicit help-seeking but no specific match, and only one profile, use it
  if (hasImplicitTransfer && transferProfiles.length === 1) {
    return { profile: transferProfiles[0], reason };
  }

  return undefined;
}

/** POST /reply — non-streaming reply. */
async function handleReply(req: Request, res: Response): Promise<void> {
  const body = req.body as BrainReplyRequest;
  const { transcript, history, transferProfiles, assistantContext } = body;

  if (!transcript || typeof transcript !== 'string') {
    res.status(400).json({ error: 'transcript (string) is required' });
    return;
  }

  const startMs = Date.now();

  // Heuristic: check for transfer intent BEFORE calling the LLM
  const transferMatch = matchTransferProfile(transcript, transferProfiles);
  if (transferMatch) {
    const { profile, reason } = transferMatch;
    const who = profile.holder || profile.name;
    // Explicit: "One moment, I'll connect you with Morgan now."
    // Implicit: "I can connect you with Morgan — they handle quotes and estimates. One moment!"
    const message = reason === 'explicit'
      ? `One moment, I'll connect you with ${who} now.`
      : `I can connect you with ${who}${profile.responsibilities.length ? ' — they handle ' + profile.responsibilities.join(', ') : ''}. One moment!`;
    const transfer: BrainTransferAction = { to: profile.destination };
    if (profile.audioUrl) transfer.audioUrl = profile.audioUrl;
    if (profile.timeoutSecs) transfer.timeoutSecs = profile.timeoutSecs;
    console.log(`[brain] transfer detected (${reason}) → ${profile.destination} (${Date.now() - startMs}ms)`);
    res.json({ text: message, transfer } as BrainReplyResponse);
    return;
  }

  const systemPrompt = buildSystemPrompt(transferProfiles, assistantContext);
  console.log(`[brain] transcript="${transcript}" | assistantContext keys=${assistantContext ? Object.keys(assistantContext).join(',') : 'NONE'} | tools=DISABLED(heuristic)`);
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: 'system', content: systemPrompt },
    ...historyToMessages(history ?? [], transcript),
  ];

  try {
    // NEVER pass tools to Ollama — it causes an 8-9x slowdown.
    // Intent detection (end_call, transfer) is handled via heuristics.
    const completion = await openai.chat.completions.create({
      model: MODEL,
      messages,
      max_tokens: MAX_TOKENS,
    });

    const choice = completion.choices?.[0];
    if (!choice) {
      res.status(502).json({ error: 'No completion choice' });
      return;
    }

    const content = choice.message.content;
    const text = content && typeof content === 'string' ? content.trim() : 'Got it. How can I help?';
    const elapsedMs = Date.now() - startMs;
    console.log(`[brain] LLM response (${elapsedMs}ms): "${text}"`);

    const response: BrainReplyResponse = { text };

    // Post-LLM: check if the LLM suggested a transfer in its response
    // e.g. "Let me connect you with Morgan" or "I'll transfer you to sales"
    if (transferProfiles?.length) {
      const postMatch = matchTransferProfile(text, transferProfiles);
      if (postMatch) {
        const { profile } = postMatch;
        const transfer: BrainTransferAction = { to: profile.destination };
        if (profile.audioUrl) transfer.audioUrl = profile.audioUrl;
        if (profile.timeoutSecs) transfer.timeoutSecs = profile.timeoutSecs;
        response.transfer = transfer;
        console.log(`[brain] transfer detected in LLM response → ${profile.destination}`);
      }
    }

    // Detect goodbye/end_call via heuristic
    if (!response.transfer && isGoodbyeResponse(text, transcript, history ?? [])) {
      response.hangup = true;
      console.log(`[brain] goodbye detected via heuristic → hangup`);
    }

    res.json(response);
  } catch (err) {
    console.error('OpenAI reply error:', err);
    res.status(500).json({
      text: "I'm sorry, I had a problem responding. Please try again.",
      error: err instanceof Error ? err.message : 'Unknown error',
    });
  }
}

/** POST /reply/stream — streaming reply (tokens + done with optional transfer). */
async function handleReplyStream(req: Request, res: Response): Promise<void> {
  const body = req.body as BrainReplyRequest;
  const { transcript, history, transferProfiles, assistantContext } = body;

  if (!transcript || typeof transcript !== 'string') {
    res.status(400).json({ error: 'transcript (string) is required' });
    return;
  }

  // Heuristic: check for transfer intent BEFORE calling the LLM
  const transferMatch = matchTransferProfile(transcript, transferProfiles);
  if (transferMatch) {
    const { profile, reason } = transferMatch;
    const who = profile.holder || profile.name;
    const message = reason === 'explicit'
      ? `One moment, I'll connect you with ${who} now.`
      : `I can connect you with ${who}${profile.responsibilities.length ? ' — they handle ' + profile.responsibilities.join(', ') : ''}. One moment!`;
    const transfer: BrainTransferAction = { to: profile.destination };
    if (profile.audioUrl) transfer.audioUrl = profile.audioUrl;
    if (profile.timeoutSecs) transfer.timeoutSecs = profile.timeoutSecs;
    // Return as instant SSE done event (no LLM call needed)
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();
    res.write(`event: done\ndata: ${JSON.stringify({ text: message, transfer })}\n\n`);
    res.end();
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const systemPrompt = buildSystemPrompt(transferProfiles, assistantContext);
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: 'system', content: systemPrompt },
    ...historyToMessages(history ?? [], transcript),
  ];

  try {
    // NEVER pass tools to Ollama — 8-9x slowdown.
    const stream = await openai.chat.completions.create({
      model: MODEL,
      messages,
      max_tokens: MAX_TOKENS,
      stream: true,
    });

    let fullContent = '';

    for await (const chunk of stream) {
      const delta = chunk.choices?.[0]?.delta;
      if (!delta) continue;

      if (delta.content) {
        const text = typeof delta.content === 'string' ? delta.content : '';
        if (text) {
          fullContent += text;
          res.write(`event: token\ndata: ${JSON.stringify({ t: text })}\n\n`);
        }
      }
    }

    let finalText = fullContent.trim() || 'Got it. How can I help?';
    let hangup = false;

    // Detect goodbye/end_call via heuristic
    if (isGoodbyeResponse(finalText, transcript, history ?? [])) {
      hangup = true;
    }

    const donePayload: BrainReplyResponse = { text: finalText };
    if (hangup) donePayload.hangup = true;
    res.write(`event: done\ndata: ${JSON.stringify(donePayload)}\n\n`);
  } catch (err) {
    console.error('OpenAI stream error:', err);
    res.write(
      `event: done\ndata: ${JSON.stringify({ text: "I'm sorry, I had a problem. Please try again." })}\n\n`,
    );
  } finally {
    res.end();
  }
}

const app = express();
app.use(express.json({ limit: '1mb' }));

app.post('/reply', handleReply);
app.post('/reply/stream', handleReplyStream);

app.get('/health', (_req, res) => {
  res.json({ ok: true, model: MODEL });
});

/**
 * Warm up the Ollama model on startup so the first call doesn't incur a 2s cold-start.
 * Also sets keep_alive=30m and num_ctx=2048 for faster inference.
 */
async function warmupOllamaModel(): Promise<void> {
  const ollamaBase = OPENAI_BASE_URL?.replace(/\/v1\/?$/, '') || '';
  if (!ollamaBase || OPENAI_API_KEY !== 'ollama') return; // Only for Ollama
  try {
    const resp = await fetch(`${ollamaBase}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        prompt: 'hi',
        options: { num_ctx: 2048 },
        keep_alive: '30m',
        stream: false,
      }),
    });
    if (resp.ok) {
      console.log(`[brain] model ${MODEL} warmed up (num_ctx=2048, keep_alive=30m)`);
    } else {
      console.warn(`[brain] warmup failed: ${resp.status}`);
    }
  } catch (err) {
    console.warn(`[brain] warmup error (non-fatal):`, err);
  }
}

/** Re-ping Ollama every 25 min to prevent model eviction (default keep_alive=5m). */
function startKeepAlivePing(): void {
  const ollamaBase = OPENAI_BASE_URL?.replace(/\/v1\/?$/, '') || '';
  if (!ollamaBase || OPENAI_API_KEY !== 'ollama') return;
  setInterval(async () => {
    try {
      await fetch(`${ollamaBase}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: MODEL, prompt: '', keep_alive: '30m', stream: false }),
      });
    } catch { /* non-fatal */ }
  }, 25 * 60 * 1000); // every 25 minutes
}

app.listen(PORT, async () => {
  console.log(`brain-llm listening on port ${PORT} (model: ${MODEL})`);
  await warmupOllamaModel();
  startKeepAlivePing();
});
