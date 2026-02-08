# Troubleshooting

## Invalid signature (401)

Symptoms:
- Webhook returns 401 `invalid_signature`.

Checks:
- Ensure `TELNYX_PUBLIC_KEY` or `TELNYX_WEBHOOK_SECRET` is correct.
- Confirm Telnyx is sending `telnyx-timestamp` and signature headers.
- Verify system clock skew is within 5 minutes.

## "The number you dialed is not configured."

Symptoms:
- Call is answered and immediately hangs up with the message.

Checks:
- Confirm DID is in E.164 format.
- Ensure Redis has a mapping at `${TENANTMAP_PREFIX}:did:${e164}`.

## "This number is not fully configured."

Symptoms:
- Call is answered and hangs up with the message.

Checks:
- Confirm tenantcfg exists at `${TENANTCFG_PREFIX}:${tenantId}`.
- Validate tenantcfg v1 schema (contractVersion, required fields, E.164 DIDs).

## Capacity errors

Symptoms:
- "We are currently at capacity" or "unable to accept your call".

Checks:
- Inspect Redis capacity keys and overrides.
- Confirm tenantcfg caps are reasonable.
- Look for `capacity_denied` or `capacity_eval_failed` logs.

## STT or TTS failures

Symptoms:
- No transcription or TTS playback errors.

Checks:
- Validate `WHISPER_URL` or tenantcfg `stt.whisperUrl`.
- Validate `KOKORO_URL` or tenantcfg `tts.kokoroUrl` (Kokoro), or `tts.coquiXttsUrl` (Coqui XTTS).
- Check network connectivity from the runtime host.

## Fuzzy or distorted outbound (TTS) audio

Symptoms:
- Assistant or greeting sounds muffled, crackly, “underwater,” or otherwise fuzzy on PSTN calls.

Common causes and fixes:

1. **PLAYBACK_PROFILE vs transport**  
   For **PSTN** calls, TTS (and the greeting) should be run through the telephony pipeline: resample to 16 kHz, highpass, RMS normalize, de-esser, limiter. That only runs when `PLAYBACK_PROFILE=pstn`.  
   - If you use **PSTN** but have `PLAYBACK_PROFILE=hd`, the runtime sends raw TTS (e.g. 24 kHz from XTTS) to Telnyx. The carrier may misinterpret sample rate or apply poor resampling, which often sounds fuzzy or wrong.  
   - **Fix:** Set `PLAYBACK_PROFILE=pstn` in `.env` when taking PSTN calls. Use `hd` only for WebRTC/HD transport.

2. **Sample rate mismatch**  
   XTTS outputs 24 kHz. The pipeline resamples to `PLAYBACK_PSTN_SAMPLE_RATE` (default 16 kHz). If the pipeline is skipped (see above) or the target rate doesn’t match what Telnyx/carrier expect, playback can sound off.  
   - **Check:** `PLAYBACK_PSTN_SAMPLE_RATE=16000` (or 8000 if your carrier is narrowband). Ensure the pipeline is applied (see above).

3. **XTTS tuning**  
   Aggressive or odd XTTS settings can make speech sound rough or artificial.  
   - Try lowering `COQUI_TEMPERATURE` (e.g. 0.5–0.6) for more stable output.  
   - Set `COQUI_SPEED=1.0`; values far from 1.0 can introduce artifacts.  
   - See [docs/xtts-tuning.md](xtts-tuning.md).

4. **Levels / clipping**  
   Very hot TTS can clip in the pipeline limiter or downstream.  
   - Pipeline uses RMS target and a soft limiter. If you added custom gain elsewhere, reduce it.  
   - Check logs for `tts_telephony_mastering_applied` (confirms pipeline ran) and any level-related warnings.

5. **Inbound (caller) audio fuzzy**  
   If the **caller** sounds fuzzy, the cause is usually before or outside the runtime: network/carrier, AMR-WB decode, or packet loss.  
   - Confirm `TELNYX_ACCEPT_CODECS` and decode settings match what Telnyx sends.  
   - Check for `amrwb_*` or decode errors in logs.

6. **Is AMR-WB actually in use?**  
   The runtime **requests** the codec via `TELNYX_STREAM_CODEC` when it calls Telnyx “start streaming.” Telnyx may still negotiate something else with the carrier (e.g. fallback to PCMU if the carrier does not support wideband).  
   - **Requested codec:** On each call you should see a log `telnyx_stream_start` with `stream_codec: "AMR-WB"` if `.env` has `TELNYX_STREAM_CODEC=AMR-WB`.  
   - **Actual codec:** After the media WebSocket connects, look for `media_ingest_codec_detected` with `codec: "AMR-WB"`. If you see `codec: "PCMU"` (or another codec), the call is not using AMR-WB end-to-end and quality will be narrowband.  
   - Ensure `TELNYX_AMRWB_DECODE=true` and `TELNYX_ACCEPT_CODECS` includes `AMR-WB` so the runtime accepts and decodes it.

## Media WebSocket disconnects

Symptoms:
- WebSocket closes with code 1008 or no audio ingestion.

Checks:
- Confirm `MEDIA_STREAM_TOKEN` matches the query param.
- Ensure the call session exists before media connects.

## No response when user hangs up right after speaking

Symptoms:
- User says something and hangs up; no assistant reply is heard.
- Logs show `late_final_captured` and `telnyx_call_control_ignored_post_end` with status 422 ("Call has already ended").

Explanation:
- STT often finalizes only when the media stream stops (e.g. on hangup). The transcript then arrives after the call has ended. We attempt playback for that "late final" transcript, but Telnyx rejects the command because the call is no longer active.

What helps:
- **Lower the silence threshold** so the runtime finalizes the utterance on a short pause *before* the user hangs up. Set `STT_SILENCE_MS` (and optionally `STT_SILENCE_END_MS`) to a smaller value (e.g. 500–700 ms). The assistant can then respond while the call is still up.
- **No-frame timeout**: If the media stream stops sending frames after the user speaks (e.g. carrier stops sending silence), the runtime now finalizes after `STT_NO_FRAME_FINALIZE_MS` (default 1000 ms) with no frames received. That sends the utterance to STT and lets the assistant respond before the call is torn down. You can lower it (e.g. 800) for faster response when the stream goes quiet.
- Encourage users to pause briefly after speaking so the system can detect end-of-utterance and respond in time.

## Transcript "starts over" or duplicates at the end

Symptoms:
- Whisper transcript or WAV sounds like the utterance plays correctly, then the beginning repeats at the end (e.g. "what time do you guys close- What time do you").

Cause:
- When AEC is enabled, the coordinator's ring buffer (used for pre-roll) receives raw mic audio, while the STT receives AEC-processed audio. Mixing them can cause timing/phase issues and duplication.

What helps:
- With `STT_AEC_ENABLED=true`, pre-roll now comes from ChunkedSTT's internal buffer (all AEC-processed) to avoid mixing. Restart and retest.
- If the issue persists without AEC, try `STT_RX_POSTPROCESS_ENABLED=true` or `STT_PREWHISPER_DEDUPE_WINDOW=64` to catch upstream frame replay.

## Whisper mishears or drops words

Symptoms:
- Transcript is close but wrong (e.g. "The time you guys close" instead of "What time do you guys close?").

What helps:

1. **Language hint**  
   Set `STT_LANGUAGE=en` (or your language code) so Whisper doesn’t guess. Sent as a query param to your Whisper server.

2. **Initial prompt (bias)**  
   Set `STT_WHISPER_PROMPT` to example phrases you expect. Many Whisper servers use this to bias decoding (e.g. "What time do you close. When do you close."). Sent as a `prompt` query param; if your server supports `initial_prompt` or similar, it may need to read that param.

3. **Server-side**  
   Use a larger Whisper model (e.g. medium or large) and ensure the server accepts `language` and `prompt` (or `initial_prompt`) from the request URL.
