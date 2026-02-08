# Veralux Voice Runtime

Production-grade TypeScript runtime for Telnyx call control with real-time media ingest, STT, and TTS.

## Environment Variables

Required:
- PORT
- TELNYX_API_KEY
- TELNYX_PUBLIC_KEY
- MEDIA_STREAM_TOKEN
- AUDIO_PUBLIC_BASE_URL
- AUDIO_STORAGE_DIR
- WHISPER_URL
- KOKORO_URL
- STT_CHUNK_MS
- STT_SILENCE_MS
- DEAD_AIR_MS
- REDIS_URL
- GLOBAL_CONCURRENCY_CAP
- TENANT_CONCURRENCY_CAP_DEFAULT
- TENANT_CALLS_PER_MIN_CAP_DEFAULT
- CAPACITY_TTL_SECONDS

Optional (defaults shown):
- BRAIN_URL
- BRAIN_TIMEOUT_MS (8000)
- BRAIN_STREAMING_ENABLED (true)
- BRAIN_STREAM_PATH (/reply/stream)
- BRAIN_STREAM_PING_MS (15000)
- BRAIN_STREAM_FIRST_AUDIO_MAX_MS (2000)
- BRAIN_STREAM_SEGMENT_MIN_CHARS (120)
- BRAIN_STREAM_SEGMENT_NEXT_CHARS (180)
- TRANSPORT_MODE (pstn)
- WEBRTC_PORT (optional)
- WEBRTC_ALLOWED_ORIGINS (optional, comma-separated)
- TENANTMAP_PREFIX (tenantmap)
- CAP_PREFIX (cap)
- AUDIO_CLEANUP_HOURS (24)
- TELNYX_WEBHOOK_SECRET (for local webhook signing)
- TELNYX_INGEST_HEALTH_GRACE_MS (1200)
- TELNYX_INGEST_HEALTH_ENABLED (true)
- TELNYX_INGEST_HEALTH_RESTART_ENABLED (true)
- TELNYX_INGEST_POST_PLAYBACK_GRACE_MS (1200)
- TELNYX_INGEST_MIN_AUDIO_MS_SINCE_PLAYBACK_END (2000)
- TELNYX_AMRWB_MIN_DECODED_BYTES (320)
- TELNYX_INGEST_DECODE_FAILURES_BEFORE_FALLBACK (3)
- STT_PRE_ROLL_MS (1200)
- STT_PARTIAL_MIN_MS (600)
- STT_HIGHPASS_ENABLED (true)
- STT_HIGHPASS_CUTOFF_HZ (100)
- STT_DEBUG_DUMP_WHISPER_WAVS (false)
- STT_DEBUG_DUMP_PCM16 (false)

## Run Locally

1) Install deps:

```bash
npm install
```

2) Start Redis (optional for local mapping/caps):

```bash
./scripts/dev_redis.sh
```

3) Copy `.env.example` to `.env` and set any secrets (Telnyx keys, etc.). The example includes locked-in dev settings (STT debug dirs, Whisper URL, trace flags). The server creates `STT_DEBUG_DIR` and `AMRWB_DEBUG_DIR` at startup when set.

4) Run the server:

```bash
npm run dev
```

To also tee output to `/tmp/runtime.log`: `npm run dev:log`.

## Container Deployment

1) Copy `.env.example` to `.env` (or reuse your existing file) and ensure the values make sense for a container:
   - Set `PORT=3000` (or your preferred port).
   - Set `REDIS_URL=redis://redis:6379` so the runtime talks to the Compose Redis service.
   - Set `AUDIO_STORAGE_DIR=/var/lib/veralux/audio` so audio artifacts land on the mounted volume.

2) Create the host audio directory (Compose will bind it into the container):

```bash
mkdir -p audio
```

3) Build and run the runtime plus Redis:

```bash
docker compose up --build
```

This uses the multi-stage `Dockerfile` to compile the TypeScript sources, copy the runtime artifacts, and install only production dependencies. The container listens on `${PORT}` (default `3000`) and proxies `/public` assets as usual. All required environment variables (Telnyx, STT/TTS, etc.) are injected via `.env` so the runtime behaves exactly like the bare-metal process.

To rebuild after code changes:

```bash
docker compose build runtime
docker compose up runtime
```

To run only the image (without Compose), you can build/push it yourself:

```bash
docker build -t veralux/runtime .
docker run --env-file .env -p 3000:3000 \
  -e REDIS_URL=redis://host.docker.internal:6379 \
  -e AUDIO_STORAGE_DIR=/var/lib/veralux/audio \
  -v $(pwd)/audio:/var/lib/veralux/audio \
  veralux/runtime
```

## Streaming (Brain SSE)

Brain:
- Start the Brain server with a POST `/reply/stream` SSE endpoint (`text/event-stream`).

Runtime (dev defaults shown):
```bash
export BRAIN_URL=http://localhost:4000
export BRAIN_STREAMING_ENABLED=true
export BRAIN_STREAM_PATH=/reply/stream
export BRAIN_STREAM_PING_MS=15000
export BRAIN_STREAM_FIRST_AUDIO_MAX_MS=2000
export BRAIN_STREAM_SEGMENT_MIN_CHARS=120
export BRAIN_STREAM_SEGMENT_NEXT_CHARS=180
```

If the stream endpoint is unavailable or does not return `text/event-stream`, the runtime falls back to `POST /reply`.

## Transport Modes

PSTN (default):
- `TRANSPORT_MODE=pstn`
- Use Telnyx Call Control + Media Streams as usual.

WebRTC HD (optional):
1) Set:
```bash
export TRANSPORT_MODE=webrtc_hd
export WEBRTC_ALLOWED_ORIGINS=http://localhost:4001
```
2) Install the optional WebRTC dependency (required for HD mode):
```bash
npm install
```
2) Ensure the tenant config exists in Redis.
3) Run the server and open:
```
http://localhost:4001/hd-call?tenant_id=tenantA
```
4) Click **Start Call** in the browser.

Notes:
- For true wideband playback, set `TTS_SAMPLE_RATE` or per-tenant `tts.sampleRate` to 24000/48000.
- PSTN remains unchanged and continues to use Telnyx webhooks.
- WebRTC endpoints are served on the main HTTP port; `WEBRTC_PORT` is reserved for future separation.
- If `wrtc` is not installed, the `/v1/webrtc/offer` endpoint returns `webrtc_init_failed`.

## Testing

### Unit Tests

```bash
npm test
```

### Integration Tests

Integration tests require a running Redis instance:

```bash
# Start Redis first
./scripts/dev_redis.sh

# Run integration tests
npm run test:integration
```

### Load Testing

**Webhook Throughput Test** - Measures HTTP request processing capacity:

```bash
# Basic load test (10 concurrent requests for 30s)
npm run load-test

# Higher concurrency
npm run load-test -- --concurrency 50 --duration 60

# Target specific RPS
npm run load-test -- --rps 100 --concurrency 20
```

Options:
- `--url <url>`: Target URL (default: `http://localhost:3000/webhooks/telnyx`)
- `--concurrency <n>`: Concurrent requests (default: 10)
- `--duration <seconds>`: Test duration (default: 30)
- `--rps <n>`: Target requests per second (optional)

**Concurrent Call Simulation** - Measures true concurrent call capacity with WebSocket media streams:

```bash
# Simulate 10 concurrent calls for 30s each
npm run load-test:calls

# Simulate 50 concurrent calls
npm run load-test:calls -- --calls 50 --duration 60

# Custom host/port
npm run load-test:calls -- --host 192.168.1.100 --port 4001 --calls 20
```

Options:
- `--host <host>`: Runtime host (default: localhost)
- `--port <port>`: Runtime port (default: 3000)
- `--calls <n>`: Number of concurrent calls (default: 10)
- `--duration <seconds>`: Call duration (default: 30)
- `--ramp <seconds>`: Ramp-up time (default: 5)
- `--token <token>`: Media stream token (default: from `MEDIA_STREAM_TOKEN` env)

This test simulates real call flow: `call.initiated` → `call.answered` → WebSocket media stream → `call.hangup`

## Test Webhooks

1) Set a local webhook signing secret for the verifier and exporter:

```bash
export TELNYX_WEBHOOK_SECRET=devsecret
```

2) Optional: map your test DID to a tenant in Redis:

```bash
redis-cli set tenantmap:did:+15551234567 tenant-1
```

3) Send sample call events:

```bash
export WEBHOOK_URL=http://localhost:3000/v1/telnyx/webhook
./scripts/smoke_webhook.sh
```

If the DID is not mapped, the runtime will answer with a "not configured" message and hang up.

## Test Media WebSocket

1) Ensure a session exists (send call.initiated with the same call_control_id).

2) Send fake audio frames:

```bash
export MEDIA_STREAM_TOKEN=devtoken
export CALL_CONTROL_ID=call_123
node scripts/smoke_media_ws.js
```

To expose your local server for Telnyx webhooks, use Cloudflare Tunnel (free, no account required):

```bash
./scripts/dev_cloudflare.sh
```

Or if you prefer ngrok:

```bash
./scripts/dev_ngrok.sh
```

Use the printed URLs to configure your Telnyx webhook settings.
