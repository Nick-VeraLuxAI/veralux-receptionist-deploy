import type { CallState } from "./runTypes";
import { runReceptionistTurn } from "./receptionist";
import { transcribeAudio } from "./whisper";
import { synthesizeReply } from "./tts_kokoro";
import { tenants, DEFAULT_TENANT_ID } from "./tenants";

export interface AudioFrameResult {
  updatedState: CallState;
  replyAudio: Buffer;
}

export async function handleRawAudioFrame(
  tenantId: string,
  callId: string,
  pcmBuffer: Buffer
): Promise<AudioFrameResult> {
  const ctx = tenants.getOrCreate(tenantId || DEFAULT_TENANT_ID);
  const call = ctx.calls.getCall(callId);
  if (!call) {
    throw new Error(`Call ${callId} not found`);
  }

  const transcription = await transcribeAudio(pcmBuffer, {
    tenantId: ctx.id,
    config: ctx.config,
  });

  const result = await runReceptionistTurn({
    tenantId: ctx.id,
    state: call,
    callerMessage: transcription.text,
  });
  ctx.calls.save(result.state);

  const replyAudio = await synthesizeReply(result.replyText, {
    tenantId: ctx.id,
    config: ctx.config,
  });

  return {
    updatedState: result.state,
    replyAudio,
  };
}
