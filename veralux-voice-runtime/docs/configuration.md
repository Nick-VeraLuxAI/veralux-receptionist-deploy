# Configuration

Configuration is read from environment variables via `dotenv` and validated at startup in `src/env.ts`. Missing required variables cause startup to fail.

## Required environment variables

- `PORT`: HTTP listen port.
- `TELNYX_API_KEY`: API key used by the Telnyx client.
- `TELNYX_PUBLIC_KEY`: Telnyx public key for webhook signature verification.
- `MEDIA_STREAM_TOKEN`: Token required for the media WebSocket.
- `AUDIO_PUBLIC_BASE_URL`: Base URL for public audio assets.
- `AUDIO_STORAGE_DIR`: Local directory for storing wav files.
- `WHISPER_URL`: Whisper HTTP endpoint.
- `KOKORO_URL`: Kokoro HTTP endpoint.
- `STT_CHUNK_MS`: STT chunk interval in milliseconds.
- `STT_SILENCE_MS`: Silence timeout before flushing a chunk. Lower values (e.g. 500–700 ms) finalize utterances sooner so the assistant can respond before the user hangs up; higher values wait for longer pauses.
- `STT_NO_FRAME_FINALIZE_MS` (default `1000`): If no audio frames are received for this many ms while in speech, the utterance is finalized (so the assistant can respond even when the stream goes quiet before disconnect). Clamped 400–5000 ms.
- `DEAD_AIR_MS`: Timeout before a reprompt.
- `REDIS_URL`: Redis connection URL.
- `GLOBAL_CONCURRENCY_CAP`: Global concurrent call limit.
- `TENANT_CONCURRENCY_CAP_DEFAULT`: Default per-tenant concurrent limit.
- `TENANT_CALLS_PER_MIN_CAP_DEFAULT`: Default per-tenant RPM limit.
- `CAPACITY_TTL_SECONDS`: TTL for active call tracking keys.

## Optional environment variables

- `TENANTMAP_PREFIX` (default `tenantmap`): Redis prefix for DID and cap override keys.
- `TENANTCFG_PREFIX` (default `tenantcfg`): Redis prefix for tenant config.
- `CAP_PREFIX` (default `cap`): Redis prefix for capacity tracking keys.
- `AUDIO_CLEANUP_HOURS` (default `24`): Max age before local audio cleanup.
- `TELNYX_WEBHOOK_SECRET`: HMAC secret for webhook verification when using HMAC.
- `LOG_LEVEL` (default `info`): Logging verbosity.
- `STT_PRE_ROLL_MS` (default `1200`): Pre-roll buffer length (ms) prepended to each utterance.
- `STT_AEC_ENABLED` (default `false`): Enable SpeexDSP acoustic echo cancellation. Requires libspeexdsp: `brew install speexdsp` (macOS) or `apt install libspeexdsp-dev` (Linux). Uses the far-end reference from Tier 3 to suppress assistant playback in mic capture. When enabled, pre-roll is taken from ChunkedSTT's internal buffer (not the coordinator ring) to avoid mixing raw + AEC-processed audio, which can cause transcript duplication ("starts over").

### Tier 5: Production hardening

- `STT_NOISE_FLOOR_ENABLED` (default `true`): Estimate ambient noise floor from pre-speech frames and adapt RMS/peak thresholds dynamically.
- `STT_NOISE_FLOOR_ALPHA` (default `0.05`): Exponential smoothing factor for noise floor estimation.
- `STT_NOISE_FLOOR_MIN_SAMPLES` (default `30`): Minimum frames before using adaptive thresholds.
- `STT_ADAPTIVE_RMS_MULTIPLIER` (default `2.0`): Speech RMS floor = noise_floor × multiplier.
- `STT_ADAPTIVE_PEAK_MULTIPLIER` (default `2.5`): Speech peak floor = noise_floor × multiplier.
- `STT_ADAPTIVE_FLOOR_MIN_RMS` (default `0.01`): Minimum RMS floor regardless of noise.
- `STT_ADAPTIVE_FLOOR_MIN_PEAK` (default `0.03`): Minimum peak floor regardless of noise.
- `STT_LATE_FINAL_WATCHDOG_ENABLED` (default `true`): Force finalization if speech has been ongoing for too long without silence-based finalize.
- `STT_LATE_FINAL_WATCHDOG_MS` (default `8000`): Max ms of continuous speech before watchdog forces final.

Per-call metrics are logged at teardown (`call_session_teardown`) and recorded to Prometheus: `call_completions_total`, `call_duration_seconds`, `call_turns`, `call_empty_transcript_pct`.

## Call transcript (summarizer)

At teardown the runtime emits a **full call transcript** (caller + assistant text only; no audio). This avoids storing large amounts of audio for later analysis.

- **Log event:** `call_transcript` — includes `transcript_turns` (array of `{ role, content, timestamp }`), `duration_ms`, `from`, `to`, etc.
- **Optional file:** If `CALL_TRANSCRIPT_DIR` is set, a JSON file is written per call (`transcript_<callControlId>_<timestamp>.json`) with the same structure. No audio is stored.

Use this for summarization, analytics, or compliance without collecting raw audio.

## Tenant configuration in Redis (tenantcfg v1)

Tenant config is loaded from Redis at `${TENANTCFG_PREFIX}:${tenantId}` and validated against the v1 schema. Required fields include:

- `contractVersion` (must be `"v1"`)
- `tenantId`
- `dids` (E.164 strings)
- `caps`, `stt`, `tts`, `audio`
- `webhookSecretRef` or `webhookSecret`

### Secret management with webhookSecretRef

Instead of storing secrets in plaintext (`webhookSecret`), you can use `webhookSecretRef` to reference secrets from environment variables:

```json
{
  "webhookSecretRef": "env:TENANT_ACME_WEBHOOK_SECRET"
}
```

The runtime resolves `env:VAR_NAME` by reading `process.env.VAR_NAME`. This keeps secrets out of Redis and allows you to inject them via your deployment environment (Kubernetes secrets, AWS Secrets Manager -> env, etc.).

If you provide both `webhookSecret` and `webhookSecretRef`, the plaintext `webhookSecret` takes precedence.

## DID mapping in Redis

To map a DID to a tenant:

```bash
redis-cli set tenantmap:did:+15551234567 tenant-1
```

DIDs are normalized to E.164 (`/^\+[1-9]\d{1,14}$/`). Invalid numbers are treated as missing.

## Prerecorded greeting (PSTN)

For PSTN calls, the runtime plays a greeting from a WAV file at startup. By default it generates that file with TTS, **resamples it to `PLAYBACK_PSTN_SAMPLE_RATE`** (e.g. 8000 or 16000 Hz) so Telnyx playback is correct, and writes it to `{AUDIO_STORAGE_DIR}/greeting.wav`. If that file **already exists** when the server starts, it is **removed** so a fresh greeting is generated from the current TTS config and `GREETING_TEXT`.

**To use your own prerecorded greeting:**

1. **Create or export your greeting as WAV** (e.g. from your DAW, Audacity, or a recording tool).
2. **Save it as `greeting.wav`** in the directory given by `AUDIO_STORAGE_DIR` in `.env`.
   - Example: if `AUDIO_STORAGE_DIR=/tmp/veralux-audio`, put the file at `/tmp/veralux-audio/greeting.wav`.
3. **Ensure the directory exists** (e.g. `mkdir -p /tmp/veralux-audio`).
4. **Start the runtime.** It will see the existing file, log `greeting asset ready` with `created: false`, and not overwrite it.

**Format:** WAV, mono. For PSTN, 8 kHz or 16 kHz is typical so Telnyx plays it correctly (e.g. 16 kHz if you use `PLAYBACK_PSTN_SAMPLE_RATE=16000`). The greeting is served at `{AUDIO_PUBLIC_BASE_URL}/greeting.wav`, so `AUDIO_PUBLIC_BASE_URL` must point at the same server that serves `AUDIO_STORAGE_DIR` (e.g. your ngrok URL with `/audio`).

If you remove the file or start with an empty `AUDIO_STORAGE_DIR`, the server will try to generate `greeting.wav` via TTS on startup (and retry every 60 seconds until it succeeds).

## Example .env

```bash
PORT=3000
TELNYX_API_KEY=...
TELNYX_PUBLIC_KEY=...
MEDIA_STREAM_TOKEN=devtoken
AUDIO_PUBLIC_BASE_URL=https://media.example.com/audio
AUDIO_STORAGE_DIR=/var/lib/voice/audio
WHISPER_URL=https://stt.example.com/v1/whisper
# TTS: kokoro_http (default) or coqui_xtts. When no tenant tts config, .env selects backend.
TTS_MODE=kokoro_http
KOKORO_URL=https://tts.example.com/v1/kokoro
# COQUI_XTTS_URL=http://localhost:7002/api/tts   # required when TTS_MODE=coqui_xtts
STT_CHUNK_MS=800
STT_SILENCE_MS=1200
STT_PRE_ROLL_MS=1200
DEAD_AIR_MS=15000
REDIS_URL=redis://localhost:6379
GLOBAL_CONCURRENCY_CAP=200
TENANT_CONCURRENCY_CAP_DEFAULT=10
TENANT_CALLS_PER_MIN_CAP_DEFAULT=120
CAPACITY_TTL_SECONDS=60
TENANTMAP_PREFIX=tenantmap
TENANTCFG_PREFIX=tenantcfg
CAP_PREFIX=cap
AUDIO_CLEANUP_HOURS=24
TELNYX_WEBHOOK_SECRET=devsecret
LOG_LEVEL=info
```
