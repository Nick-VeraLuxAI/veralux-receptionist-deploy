/**
 * Control Plane integration for the voice runtime.
 * Reports call events (start, end with transcript) and analytics
 * to the control plane so dashboards and workflow automation stay current.
 */

import { env } from './env';
import pino from 'pino';

const log = pino({ name: 'control-plane' });

interface CallTranscriptTurn {
  role: string;
  content: string;
  timestamp?: string;
}

interface ReportCallEndParams {
  tenantId: string;
  callId: string;
  callerId?: string;
  durationMs?: number;
  turns: CallTranscriptTurn[];
  transcript: string;
  lead?: Record<string, any>;
}

function isConfigured(): boolean {
  return !!(env.CONTROL_PLANE_URL && env.CONTROL_PLANE_API_KEY);
}

/** Common headers for control-plane requests */
function cpHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'X-Admin-Key': env.CONTROL_PLANE_API_KEY!,
  };
}

/* ──────────────────────────────────────────────────────────────────────────
   Analytics helpers — fire-and-forget, never throw
   ────────────────────────────────────────────────────────────────────────── */

/**
 * Report a new call to the analytics counter and call registry.
 * Should be called when a session is first created / answered.
 */
export async function reportCallStart(tenantId: string, callId: string, callerId?: string): Promise<void> {
  if (!isConfigured()) return;
  const base = env.CONTROL_PLANE_URL!;
  try {
    // 1. Increment the analytics call counter
    const analyticsResp = await fetch(`${base}/api/runtime/analytics`, {
      method: 'POST',
      headers: cpHeaders(),
      body: JSON.stringify({ tenantId, event: 'call_started' }),
    });
    if (!analyticsResp.ok) {
      const body = await analyticsResp.text().catch(() => '');
      log.warn({ event: 'cp_analytics_call_start_failed', status: analyticsResp.status, body: body.slice(0, 200) }, 'analytics call_started failed');
    }

    // 2. Create the call record in the calls registry
    const callsResp = await fetch(`${base}/api/runtime/calls`, {
      method: 'POST',
      headers: cpHeaders(),
      body: JSON.stringify({
        tenantId,
        callId,
        action: 'start',
        callState: { callerId, stage: 'start' },
      }),
    });
    if (!callsResp.ok) {
      const body = await callsResp.text().catch(() => '');
      log.warn({ event: 'cp_calls_start_failed', status: callsResp.status, body: body.slice(0, 200) }, 'calls start failed');
    } else {
      log.info({ event: 'control_plane_call_started', call_id: callId, tenant_id: tenantId }, 'call start reported to control plane');
    }
  } catch (err) {
    log.warn({ err, event: 'cp_call_start_error', call_id: callId }, 'control plane call start error');
  }
}

/**
 * Report a caller (user) message to the analytics counter.
 * Should be called each time the STT produces a final user transcript.
 */
export async function reportCallerMessage(tenantId: string, text: string): Promise<void> {
  if (!isConfigured()) return;
  const base = env.CONTROL_PLANE_URL!;
  try {
    const resp = await fetch(`${base}/api/runtime/analytics`, {
      method: 'POST',
      headers: cpHeaders(),
      body: JSON.stringify({ tenantId, event: 'caller_message', text }),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      log.warn({ event: 'cp_analytics_message_failed', status: resp.status, body: body.slice(0, 200) }, 'analytics caller_message failed');
    }
  } catch (err) {
    log.warn({ err, event: 'cp_caller_message_error' }, 'control plane caller_message error');
  }
}

/* ──────────────────────────────────────────────────────────────────────────
   Call end (with transcript) — existing
   ────────────────────────────────────────────────────────────────────────── */

/**
 * Report a call end event (with full transcript) to the control plane.
 * This fires asynchronously and never throws — errors are logged only.
 */
export async function reportCallEnd(params: ReportCallEndParams): Promise<void> {
  if (!isConfigured()) return;

  const url = `${env.CONTROL_PLANE_URL}/api/runtime/calls`;

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: cpHeaders(),
      body: JSON.stringify({
        tenantId: params.tenantId,
        callId: params.callId,
        action: 'end',
        transcript: params.transcript,
        callState: {
          callerId: params.callerId,
          stage: 'end',
          lead: params.lead,
          history: params.turns,
        },
      }),
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      log.warn(
        {
          event: 'control_plane_report_failed',
          status: resp.status,
          body: body.slice(0, 200),
          call_id: params.callId,
        },
        'control plane report call end failed',
      );
    } else {
      log.info(
        {
          event: 'control_plane_report_ok',
          call_id: params.callId,
          tenant_id: params.tenantId,
        },
        'call end reported to control plane',
      );
    }
  } catch (err) {
    log.warn(
      { err, event: 'control_plane_report_error', call_id: params.callId },
      'control plane report call end error',
    );
  }
}
