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
const MODEL = process.env.OPENAI_MODEL?.trim() ?? 'llama3.2:3b';
const MAX_TOKENS = Number(process.env.BRAIN_MAX_TOKENS ?? 80);

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
  let prompt = `You are a phone receptionist. Reply in exactly this format:

[short answer]. Anything else I can help with?

Examples:
- "We close at 5 PM. Anything else I can help with?"
- "We're at 123 Main Street. Anything else I can help with?"
- "I'm not sure about that. Anything else I can help with?"
- "Have a great day! Goodbye."

Rules:
1. Your answer MUST be one short sentence ending with a period, followed by "Anything else I can help with?"
2. ONLY use facts from the business info below. If you don't know, say "I'm not sure about that."
3. If the caller says goodbye or no more questions, just say "Have a great day! Goodbye."
4. Never start with "We actually" or add filler. Be direct.`;

  if (assistantContext && Object.keys(assistantContext).length > 0) {
    prompt += `\n\nUse the following information when answering questions. Answer only from this context when the caller asks about these topics:\n\n`;
    for (const [section, text] of Object.entries(assistantContext)) {
      if (text?.trim()) {
        prompt += `${section}:\n${text.trim()}\n\n`;
      }
    }
  }

  if (transferProfiles?.length) {
    prompt += `You can transfer the caller to a person or department. When the caller asks to speak to someone, or their need matches a department below, use the transfer_call tool with that profile's destination number and a brief message to the caller (e.g. "I'll connect you with Morgan in Sales now.").

Transfer options (use the exact \`destination\` value when calling transfer_call):
${transferProfiles
  .map(
    (p) =>
      `- ${p.name}${p.holder ? ` (${p.holder})` : ''}: handles ${p.responsibilities.join(', ')}. destination: ${p.destination}`,
  )
  .join('\n')}

Only use transfer_call when the caller clearly wants to be transferred or their request matches one of the above. Otherwise just answer in your normal voice.`;
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
        'End the phone call after saying goodbye. Use this when the caller indicates they are done (e.g. "no thanks", "that\'s all", "goodbye", "I\'m good").',
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

/** POST /reply — non-streaming reply. */
async function handleReply(req: Request, res: Response): Promise<void> {
  const body = req.body as BrainReplyRequest;
  const { transcript, history, transferProfiles, assistantContext } = body;

  if (!transcript || typeof transcript !== 'string') {
    res.status(400).json({ error: 'transcript (string) is required' });
    return;
  }

  const systemPrompt = buildSystemPrompt(transferProfiles, assistantContext);
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: 'system', content: systemPrompt },
    ...historyToMessages(history ?? [], transcript),
  ];

  // Always include end_call tool; add transfer tool when profiles exist
  const tools: OpenAI.Chat.ChatCompletionTool[] = [
    getEndCallToolDefinition(),
    ...(transferProfiles?.length ? getTransferToolDefinition() : []),
  ];

  try {
    const completion = await openai.chat.completions.create({
      model: MODEL,
      messages,
      tools,
      tool_choice: 'auto',
      max_tokens: MAX_TOKENS,
    });

    const choice = completion.choices?.[0];
    if (!choice) {
      res.status(502).json({ error: 'No completion choice' });
      return;
    }

    const message = choice.message;
    const response: BrainReplyResponse = { text: 'Got it. How can I help?' };

    // Check for end_call tool call
    const endCallTool = message.tool_calls?.find((tc) => tc.function?.name === END_CALL_TOOL_NAME);
    if (endCallTool?.function?.arguments) {
      try {
        const args = JSON.parse(endCallTool.function.arguments) as { goodbye_message?: string };
        response.text = args.goodbye_message?.trim() || 'Have a great day! Goodbye.';
      } catch {
        response.text = 'Have a great day! Goodbye.';
      }
      response.hangup = true;
      res.json(response);
      return;
    }

    // Check for transfer tool call
    const toolCall = message.tool_calls?.find((tc) => tc.function?.name === TRANSFER_TOOL_NAME);
    if (toolCall?.function?.arguments) {
      try {
        const args = JSON.parse(toolCall.function.arguments) as {
          to?: string;
          message_to_caller?: string;
        };
        const to = typeof args.to === 'string' && args.to.trim() ? args.to.trim() : undefined;
        const messageToCaller =
          typeof args.message_to_caller === 'string' && args.message_to_caller.trim()
            ? args.message_to_caller.trim()
            : 'One moment while I transfer you.';

        if (to) {
          response.text = messageToCaller;
          const transfer: BrainTransferAction = { to };
          const profile = findProfileByDestination(transferProfiles, to);
          if (profile?.audioUrl) transfer.audioUrl = profile.audioUrl;
          if (profile?.timeoutSecs) transfer.timeoutSecs = profile.timeoutSecs;
          response.transfer = transfer;
        } else {
          response.text = message.content && typeof message.content === 'string'
            ? String(message.content).trim()
            : messageToCaller;
        }
      } catch {
        response.text =
          message.content && typeof message.content === 'string'
            ? String(message.content).trim()
            : response.text;
      }
    } else {
      const content = message.content;
      response.text =
        content && typeof content === 'string' ? String(content).trim() : response.text;
    }

    // Fallback: detect goodbye intent heuristically if the tool wasn't called
    if (!response.transfer && !response.hangup && isGoodbyeResponse(response.text, transcript, history ?? [])) {
      response.hangup = true;
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

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const systemPrompt = buildSystemPrompt(transferProfiles, assistantContext);
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: 'system', content: systemPrompt },
    ...historyToMessages(history ?? [], transcript),
  ];

  // Always include end_call tool; add transfer tool when profiles exist
  const tools: OpenAI.Chat.ChatCompletionTool[] = [
    getEndCallToolDefinition(),
    ...(transferProfiles?.length ? getTransferToolDefinition() : []),
  ];

  try {
    const stream = await openai.chat.completions.create({
      model: MODEL,
      messages,
      tools,
      tool_choice: 'auto',
      max_tokens: MAX_TOKENS,
      stream: true,
    });

    let fullContent = '';
    const toolCallsByIndex: Map<number, { name: string; args: string }> = new Map();

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
      if (delta.tool_calls?.length) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;
          const existing = toolCallsByIndex.get(idx);
          const name =
            (existing?.name ?? tc.function?.name ?? '').trim() || (tc.function?.name ?? '');
          const args = (existing?.args ?? '') + (tc.function?.arguments ?? '');
          toolCallsByIndex.set(idx, { name, args });
        }
      }
    }

    const toolCalls = Array.from(toolCallsByIndex.values());
    let finalText = fullContent.trim();
    let transfer: BrainTransferAction | undefined;
    let hangup = false;

    // Check for end_call tool
    const endCallTool = toolCalls.find((tc) => tc.name === END_CALL_TOOL_NAME);
    if (endCallTool?.args) {
      try {
        const args = JSON.parse(endCallTool.args) as { goodbye_message?: string };
        finalText = args.goodbye_message?.trim() || finalText || 'Have a great day! Goodbye.';
      } catch {
        if (!finalText) finalText = 'Have a great day! Goodbye.';
      }
      hangup = true;
    }

    // Check for transfer tool
    if (!hangup) {
      const transferTool = toolCalls.find((tc) => tc.name === TRANSFER_TOOL_NAME);
      if (transferTool?.args) {
        try {
          const args = JSON.parse(transferTool.args) as {
            to?: string;
            message_to_caller?: string;
          };
          const to = typeof args.to === 'string' && args.to.trim() ? args.to.trim() : undefined;
          if (to) {
            finalText =
              typeof args.message_to_caller === 'string' && args.message_to_caller.trim()
                ? args.message_to_caller.trim()
                : 'One moment while I transfer you.';
            transfer = { to };
            const profile = findProfileByDestination(transferProfiles, to);
            if (profile?.audioUrl) transfer.audioUrl = profile.audioUrl;
            if (profile?.timeoutSecs) transfer.timeoutSecs = profile.timeoutSecs;
          }
        } catch {
          // keep finalText from content
        }
      }
    }

    if (!finalText) finalText = fullContent.trim() || 'Got it. How can I help?';

    const donePayload: BrainReplyResponse = { text: finalText };
    if (transfer) donePayload.transfer = transfer;
    // Fallback: detect goodbye intent heuristically if the tool wasn't called
    if (!transfer && !hangup && isGoodbyeResponse(finalText, transcript, history ?? [])) {
      hangup = true;
    }
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

app.listen(PORT, () => {
  console.log(`brain-llm listening on port ${PORT} (model: ${MODEL})`);
});
