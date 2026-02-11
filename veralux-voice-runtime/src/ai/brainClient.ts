import { env } from '../env';
import { log } from '../log';
import { ConversationTurn } from '../calls/types';
import type { TransferProfile } from '../tenants/tenantConfig';
import { defaultBrainReply } from './defaultBrain';

/** Per-tenant context for the assistant: pricing, products, hours, policies, etc. Keys are section names; values are text. */
export type AssistantContext = Record<string, string>;

export interface AssistantReplyInput {
  tenantId?: string;
  callControlId: string;
  transcript: string;
  history: ConversationTurn[];
  /** Transfer profiles (departments/positions) so the LLM can route callers by intent. */
  transferProfiles?: TransferProfile[];
  /** Context for answering: pricing, products, hours, policies, etc. (used by local and API brain). */
  assistantContext?: AssistantContext;
}

export type AssistantReplySource =
  | 'brain_http'
  | 'brain_http_stream'
  | 'brain_local_default'
  | 'fallback_error';

/** When the brain wants to transfer the call, it can return this in the reply. */
export interface AssistantTransferAction {
  /** E.164 number or SIP URI to transfer to. */
  to: string;
  /** Optional hold message URL (WAV/MP3) played while destination rings. */
  audioUrl?: string;
  /** Timeout in seconds for destination to answer (5–600). */
  timeoutSecs?: number;
}

/** Voice directive for hot-swapping between preset and cloned voices. */
export interface AssistantVoiceDirective {
  /** Voice mode: 'preset' uses built-in voice_id, 'cloned' uses reference audio. */
  mode: 'preset' | 'cloned';
  /**
   * Optional override speakerWavUrl for cloned mode (one-time use).
   * If not provided, uses the tenant config's clonedVoice.speakerWavUrl.
   */
  speakerWavUrl?: string;
}

export interface AssistantReplyResult {
  text: string;
  source: AssistantReplySource;
  /** If set, the runtime will play `text` (if any) then transfer the call to `to`. */
  transfer?: AssistantTransferAction;
  /** If set, the runtime will switch voice mode before playing the response. */
  voiceDirective?: AssistantVoiceDirective;
  /** If true, the runtime will play `text` (goodbye) then hang up the call. */
  hangup?: boolean;
}

const ERROR_FALLBACK_TEXT = 'Sorry - I had a problem responding. Can you repeat that?';

function parseTransferAction(
  raw: unknown,
): AssistantTransferAction | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as { to?: unknown; audioUrl?: unknown; timeoutSecs?: unknown };
  const to = typeof o.to === 'string' && o.to.trim() ? o.to.trim() : undefined;
  if (!to) return undefined;
  const audioUrl =
    typeof o.audioUrl === 'string' && o.audioUrl.trim() ? o.audioUrl.trim() : undefined;
  const timeoutSecs =
    typeof o.timeoutSecs === 'number' && o.timeoutSecs >= 5 && o.timeoutSecs <= 600
      ? o.timeoutSecs
      : undefined;
  return { to, audioUrl, timeoutSecs };
}

function parseVoiceDirective(
  raw: unknown,
): AssistantVoiceDirective | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as { mode?: unknown; speakerWavUrl?: unknown };

  // mode is required and must be 'preset' or 'cloned'
  const mode = typeof o.mode === 'string' ? o.mode.trim().toLowerCase() : undefined;
  if (mode !== 'preset' && mode !== 'cloned') return undefined;

  const speakerWavUrl =
    typeof o.speakerWavUrl === 'string' && o.speakerWavUrl.trim()
      ? o.speakerWavUrl.trim()
      : undefined;

  return { mode, speakerWavUrl };
}

function buildBrainUrl(base: string): string {
  const trimmed = base.replace(/\/$/, '');
  if (trimmed.endsWith('/reply/stream')) {
    return trimmed.replace(/\/reply\/stream$/, '/reply');
  }
  if (trimmed.endsWith('/reply')) {
    return trimmed;
  }
  return `${trimmed}/reply`;
}

function buildBrainStreamUrl(base: string): string {
  const trimmed = base.replace(/\/$/, '');
  if (trimmed.endsWith('/reply/stream')) {
    return trimmed;
  }
  let path = env.BRAIN_STREAM_PATH;
  if (!path.startsWith('/')) {
    path = `/${path}`;
  }
  if (trimmed.endsWith('/reply') && path.startsWith('/reply/')) {
    path = path.slice('/reply'.length);
  }
  return `${trimmed}${path}`;
}

async function readResponseText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

function parseSseBlock(block: string): { event: string; data: string } | null {
  const lines = block.split('\n');
  let event = 'message';
  const dataLines: string[] = [];

  for (const line of lines) {
    if (!line || line.startsWith(':')) {
      continue;
    }
    if (line.startsWith('event:')) {
      event = line.slice('event:'.length).trim();
      continue;
    }
    if (line.startsWith('data:')) {
      dataLines.push(line.slice('data:'.length).trimStart());
    }
  }

  if (dataLines.length === 0) {
    return null;
  }

  return { event, data: dataLines.join('\n') };
}

async function readSseStream(
  response: Response,
  onEvent: (event: { event: string; data: string }) => boolean | void,
): Promise<void> {
  if (!response.body) {
    throw new Error('brain stream missing body');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    buffer = buffer.replace(/\r\n/g, '\n');

    let boundaryIndex = buffer.indexOf('\n\n');
    while (boundaryIndex !== -1) {
      const block = buffer.slice(0, boundaryIndex);
      buffer = buffer.slice(boundaryIndex + 2);
      const parsed = parseSseBlock(block);
      if (parsed) {
        const shouldContinue = onEvent(parsed);
        if (shouldContinue === false) {
          await reader.cancel();
          return;
        }
      }
      boundaryIndex = buffer.indexOf('\n\n');
    }
  }

  buffer += decoder.decode();
  buffer = buffer.replace(/\r\n/g, '\n');

  const trailing = buffer.trim();
  if (trailing) {
    const parsed = parseSseBlock(trailing);
    if (parsed) {
      onEvent(parsed);
    }
  }
}

export async function generateAssistantReply(
  input: AssistantReplyInput,
): Promise<AssistantReplyResult> {
  if (env.BRAIN_USE_LOCAL || !env.BRAIN_URL) {
    const text = defaultBrainReply({
      transcript: input.transcript,
      tenantId: input.tenantId,
      assistantContext: input.assistantContext,
    });
    log.info(
      {
        event: 'brain_route',
        source: 'brain_local_default',
        tenant_id: input.tenantId,
        call_control_id: input.callControlId,
        brain_use_local: env.BRAIN_USE_LOCAL,
        has_brain_url: !!env.BRAIN_URL,
      },
      'brain routed to local default',
    );
    return { text, source: 'brain_local_default' };
  }

  const url = buildBrainUrl(env.BRAIN_URL);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), env.BRAIN_TIMEOUT_MS);

  try {
    log.info(
      {
        event: 'brain_route',
        source: 'brain_http',
        tenant_id: input.tenantId,
        call_control_id: input.callControlId,
        has_brain_url: true,
      },
      'brain routed to http',
    );

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        tenantId: input.tenantId,
        callControlId: input.callControlId,
        transcript: input.transcript,
        history: input.history,
        ...(input.transferProfiles?.length
          ? { transferProfiles: input.transferProfiles }
          : {}),
        ...(input.assistantContext &&
        Object.keys(input.assistantContext).length > 0
          ? { assistantContext: input.assistantContext }
          : {}),
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await readResponseText(response);
      const preview = body.length > 500 ? `${body.slice(0, 500)}...` : body;
      throw new Error(`brain reply failed ${response.status}: ${preview}`);
    }

    const data = (await response.json()) as {
      text?: unknown;
      transfer?: { to?: unknown; audioUrl?: unknown; timeoutSecs?: unknown };
      voiceDirective?: { mode?: unknown; speakerWavUrl?: unknown };
      hangup?: unknown;
    };
    const text = typeof data.text === 'string' ? data.text.trim() : '';
    const transfer = parseTransferAction(data.transfer);
    const voiceDirective = parseVoiceDirective(data.voiceDirective);
    const hangup = data.hangup === true;
    if (!text && !transfer?.to && !hangup) {
      throw new Error('brain reply missing text and transfer');
    }

    const result: AssistantReplyResult = {
      text: text || 'One moment.',
      source: 'brain_http',
    };
    if (transfer) result.transfer = transfer;
    if (voiceDirective) result.voiceDirective = voiceDirective;
    if (hangup) result.hangup = true;
    return result;
  } catch (error) {
    log.error(
      {
        err: error,
        event: 'brain_reply_failed',
        call_control_id: input.callControlId,
        tenant_id: input.tenantId,
      },
      'brain reply failed',
    );
    return { text: ERROR_FALLBACK_TEXT, source: 'fallback_error' };
  } finally {
    clearTimeout(timeout);
  }
}

export async function generateAssistantReplyStream(
  input: AssistantReplyInput,
  onToken: (chunk: string) => void,
): Promise<AssistantReplyResult> {
  if (env.BRAIN_USE_LOCAL || !env.BRAIN_URL || !env.BRAIN_STREAMING_ENABLED) {
    return generateAssistantReply(input);
  }

  const streamUrl = buildBrainStreamUrl(env.BRAIN_URL);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), env.BRAIN_TIMEOUT_MS);
  const startedAt = Date.now();
  const tokenLogEvery = 10;

  let fullText = '';
  let tokenCount = 0;
  let sawTokens = false;
  let transfer: AssistantTransferAction | undefined;
  let voiceDirective: AssistantVoiceDirective | undefined;
  let hangup = false;

  try {
    log.info(
      {
        event: 'brain_route',
        source: 'brain_http_stream',
        tenant_id: input.tenantId,
        call_control_id: input.callControlId,
        has_brain_url: true,
      },
      'brain routed to stream',
    );

    const response = await fetch(streamUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify({
        tenantId: input.tenantId,
        callControlId: input.callControlId,
        transcript: input.transcript,
        history: input.history,
        ...(input.transferProfiles?.length
          ? { transferProfiles: input.transferProfiles }
          : {}),
        ...(input.assistantContext &&
        Object.keys(input.assistantContext).length > 0
          ? { assistantContext: input.assistantContext }
          : {}),
      }),
      signal: controller.signal,
    });

    const contentType = response.headers.get('content-type') ?? '';
    if (!response.ok) {
      const body = await readResponseText(response);
      const preview = body.length > 500 ? `${body.slice(0, 500)}...` : body;
      throw new Error(`brain stream failed ${response.status}: ${preview}`);
    }

    if (!contentType.includes('text/event-stream')) {
      throw new Error(`brain stream unsupported content-type: ${contentType}`);
    }

    log.info(
      {
        event: 'brain_stream_start',
        tenant_id: input.tenantId,
        call_control_id: input.callControlId,
      },
      'brain stream start',
    );

    await readSseStream(response, ({ event, data }) => {
      if (event === 'ping' || event === 'meta') {
        return;
      }

      let payload: unknown;
      if (data) {
        try {
          payload = JSON.parse(data);
        } catch {
          payload = undefined;
        }
      }

      if (event === 'token') {
        const chunk = payload && typeof (payload as { t?: unknown }).t === 'string'
          ? (payload as { t: string }).t
          : '';
        if (!chunk) {
          return;
        }
        sawTokens = true;
        fullText += chunk;
        tokenCount += 1;
        if (tokenCount % tokenLogEvery === 0) {
          log.info(
            {
              event: 'brain_stream_token',
              chunk_len: chunk.length,
              total_len: fullText.length,
              tenant_id: input.tenantId,
              call_control_id: input.callControlId,
            },
            'brain stream token',
          );
        }
        onToken(chunk);
        return;
      }

      if (event === 'done') {
        const p = payload as { text?: unknown; transfer?: unknown; voiceDirective?: unknown; hangup?: unknown } | undefined;
        const text = p && typeof p.text === 'string' ? p.text : '';
        if (text) {
          fullText = text;
        }
        transfer = parseTransferAction(p?.transfer);
        voiceDirective = parseVoiceDirective(p?.voiceDirective);
        if (p?.hangup === true) hangup = true;
        return false;
      }

      if (event === 'error') {
        const message =
          payload && typeof (payload as { message?: unknown }).message === 'string'
            ? (payload as { message: string }).message
            : 'brain stream error';
        throw new Error(message);
      }
    });

    const trimmed = fullText.trim();
    if (!trimmed) {
      throw new Error('brain stream missing text');
    }

    const durationMs = Date.now() - startedAt;
    log.info(
      {
        event: 'brain_stream_done',
        total_len: trimmed.length,
        duration_ms: durationMs,
        tenant_id: input.tenantId,
        call_control_id: input.callControlId,
      },
      'brain stream done',
    );

    const result: AssistantReplyResult = {
      text: trimmed,
      source: 'brain_http_stream',
    };
    if (transfer) result.transfer = transfer;
    if (voiceDirective) result.voiceDirective = voiceDirective;
    if (hangup) result.hangup = true;
    return result;
  } catch (error) {
    log.warn(
      {
        err: error,
        event: 'brain_stream_error',
        tenant_id: input.tenantId,
        call_control_id: input.callControlId,
      },
      'brain stream error',
    );
    if (sawTokens && fullText.trim()) {
      return { text: fullText.trim(), source: 'brain_http_stream' };
    }
    return generateAssistantReply(input);
  } finally {
    clearTimeout(timeout);
  }
}