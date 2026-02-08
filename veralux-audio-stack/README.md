# veralux-audio-stack

FastAPI-based services that expose Kokoro TTS, Coqui XTTS TTS, and Faster-Whisper transcription endpoints. Each stack runs in its own Python virtual environment to keep dependencies clean.

## Prerequisites
- Python 3.10+ with `venv` available
- `ffmpeg` installed and on your `PATH` (required by `faster-whisper`)
- Kokoro model assets (`kokoro-v1.0.onnx`, `voices-v1.0.bin`) placed at the project root (for Kokoro only)

## Kokoro TTS environment
```bash
python3 -m venv kokoro-env
source kokoro-env/bin/activate
pip install --upgrade pip
pip install fastapi uvicorn kokoro-onnx soundfile numpy
```

Run the service with:
```bash
source kokoro-env/bin/activate
uvicorn kokoro_server:app --host 0.0.0.0 --port 7001 --reload
```

`kokoro_server.py` expects `kokoro-v1.0.onnx` and `voices-v1.0.bin` in the same directory. The `/tts` endpoint accepts JSON shaped like:
```json
{
  "text": "Hello there",
  "voice_id": "af_heart",
  "rate": 1.1
}
```

## Coqui XTTS TTS environment

XTTS v2 is a multilingual voice-cloning TTS model. It supports **default voices** (choose by `voice_id`) or a custom speaker WAV per request.

```bash
python3 -m venv xtts-env
source xtts-env/bin/activate
pip install --upgrade pip
pip install -r xtts-requirements.txt
```

(Includes `python-multipart` for FastAPI multipart/form endpoints like `/tts_file`.)

`xtts-requirements.txt` pins `transformers==4.33.0` so Coqui TTS 0.22 can import `BeamSearchScorer` (newer transformers moved it and break the server). If you already installed a newer transformers, run: `pip install transformers==4.33.0` then start the server again.

**Default voices:** Run once to download Coqui’s sample speaker WAVs into `xtts_voices/` (or set `XTTS_VOICES_DIR`):

```bash
python download_xtts_voices.py
```

Run the service with (use the venv’s Python so the reloader subprocess sees TTS):

```bash
source xtts-env/bin/activate
python -m uvicorn xtts_server:app --host 0.0.0.0 --port 7002 --reload
```

Or without reload: `uvicorn xtts_server:app --host 0.0.0.0 --port 7002`

Optional env vars: `XTTS_MODEL_NAME` (default **v2**: `tts_models/multilingual/multi-dataset/xtts_v2`; use `xtts_v1.1` for v1.1), `XTTS_USE_GPU`, `XTTS_VOICES_DIR` (default `xtts_voices`), `XTTS_OUTPUT_SAMPLE_RATE` (default `24000`), `XTTS_LOG_LEVEL` (e.g. `DEBUG`).

**COQUI_* tuning defaults** (used when the request doesn’t send a value): `COQUI_TEMPERATURE`, `COQUI_LENGTH_PENALTY`, `COQUI_REPETITION_PENALTY`, `COQUI_TOP_K`, `COQUI_TOP_P`, `COQUI_SPEED`, `COQUI_SPLIT_SENTENCES` (e.g. `true`/`false`). Your values above are valid; set them in the server env and they apply to every request unless overridden in the JSON body.

**Endpoints:**

- **GET /voices** — list available default voice IDs (from WAVs in `XTTS_VOICES_DIR`).
- **POST /tts** (JSON, compatible with veralux-voice-runtime): `text` (required), optional `language` (default `"en"`), `voice_id` or `speaker` (preset voice), `speaker_wav` (URL or server path for cloning), or `speaker_wav_base64`. Optional `output_sample_rate` (e.g. `24000` or `16000`; default from env `XTTS_OUTPUT_SAMPLE_RATE` is `24000`). Success: **200**, **`Content-Type: audio/wav`**, body = **raw WAV bytes** (no JSON).
- **POST /tts_file** (multipart): `text`, `language`, and optional `voice_id` or file `speaker_wav` → returns `audio/wav`.

**Tunings (send in POST /tts JSON to change how the voice sounds):**

- **Speed** (`speed`) — How fast the speech is. Number between about 0.5 and 2.0; `1.0` is normal.  
  - Example: `"speed": 1.1` slightly faster; `"speed": 0.9` slightly slower.  
  - If the voice feels draggy or sad, try **1.1–1.2** for a bit more energy.

- **Temperature** (`temperature`) — How “random” or varied the delivery is.  
  - **Low** (e.g. 0.3–0.5): more monotone, stable, can sound flat or depressing.  
  - **Higher** (e.g. 0.7–0.9): more variation in tone and rhythm, can sound more natural or lively.  
  - If the voice sounds depressing or robotic, try **`"temperature": 0.75` or `0.85`** (XTTS often defaults lower).

- **top_p** (`top_p`) — Nucleus sampling; affects which words/phrasings are chosen.  
  - Around **0.85–0.95** is typical. Slightly higher can add variety; too high can get unstable.

- **Sample rate** — Send `"output_sample_rate": 24000` or `16000` (or set env `XTTS_OUTPUT_SAMPLE_RATE`). Doesn’t change tone; only technical format.

**Why might audio sound like less than 16 kHz?** (1) **Output sample rate** — If `XTTS_OUTPUT_SAMPLE_RATE` or request `output_sample_rate` is set to 8000 (or another low value), the WAV really is that rate and will sound narrow/telephone-like. Default is 24000. (2) **Resampling** — When output is 16 kHz, the server resamples from 24 kHz; we use FFT-based resampling (scipy) when available so 16k output doesn’t sound muffled. Install `scipy` so the server uses it. (3) **Playback** — If the client plays the WAV at the wrong rate (e.g. treats 24k as 8k), it will sound slow and low. Check that the player uses the WAV’s sample rate.

- **Different voice** — Use `voice_id` (e.g. `"en_sample"`, `"es_sample"`) or your own WAV in `speaker_wav`. A different reference speaker can make a big difference; the default sample might sound flat for your use.

- **Different model** — Set env `XTTS_MODEL_NAME` (default is v2). Restart server after changing.

**Quick fix for a “depressing” or flat voice:** try a request with `"temperature": 0.8` and `"speed": 1.1`. If it’s still too flat, try another `voice_id` from GET `/voices` or a different reference WAV.

**What to expect from each tuning**

| Tuning | Typical range | What you’ll notice |
|--------|----------------|--------------------|
| **temperature** | 0.4–0.9 | **Lower:** flatter, more monotone, stable (can sound dull or sad). **Higher:** more pitch/rhythm variation, more “alive” (can get wobbly or inconsistent if too high). Start ~0.65–0.8 for a balanced, natural feel. |
| **speed** | 0.8–1.5 | **1.0** = normal pace. **&lt;1** = slower (calm, clear). **&gt;1** = faster (more energy; too high can sound rushed). 1.05–1.15 is a safe “slightly more energetic” band. |
| **top_p** | 0.8–0.98 | Controls how “predictable” the next token is. **Lower:** more conservative, stable. **Higher:** more variety in phrasing (slightly more natural, or slightly weirder). 0.85–0.9 is a good default. |
| **top_k** | 20–100 | Similar idea to top_p: fewer options (lower) = more stable; more options (higher) = more variety. 50 is a reasonable middle ground. |
| **repetition_penalty** | 1.0–5.0 | **Higher** = model avoids repeating the same words/phrases. Too low and you may hear loops; too high and phrasing can get odd. 2.0 is a common default. |
| **length_penalty** | 0.5–2.0 | Biases toward shorter or longer outputs. **&gt;1** = prefers shorter; **&lt;1** = can allow longer. Often leave at 1.0 unless you see cut-off or rambling. |
| **split_sentences** | true / false | **true:** text is split into sentences and synthesized in chunks (default; usually better quality and more consistent). **false:** whole text in one go (can use more VRAM; sometimes different prosody). |

In short: **temperature** and **speed** have the biggest impact on “depressing vs lively.” **top_p** and **top_k** add finer control over variety; **repetition_penalty** and **length_penalty** help avoid repeats and length issues.

**Upbeat / peppy preset** — For a more energetic, lively delivery, use higher temperature and slightly faster speed. Example env (or send these in POST /tts JSON):

```bash
COQUI_TEMPERATURE=0.80
COQUI_LENGTH_PENALTY=1.0
COQUI_REPETITION_PENALTY=2.0
COQUI_TOP_K=50
COQUI_TOP_P=0.92
COQUI_SPEED=1.18
COQUI_SPLIT_SENTENCES=true
```

Key changes from a neutral/flat setup: **temperature 0.78–0.85** (more variation in tone), **speed 1.15–1.2** (brisker pace). If it gets too bouncy or unstable, nudge temperature down to 0.75 or speed to 1.12.

Default voice IDs after running `download_xtts_voices.py`: `de_sample`, `en_sample`, `es_sample`, `fr_sample`, `ja-sample`, `pt_sample`, `tr_sample`, `zh-cn-sample`. You can add more WAVs to `xtts_voices/`; the filename stem becomes the `voice_id`.

Supported `language` codes: `en`, `es`, `fr`, `de`, `it`, `pt`, `pl`, `tr`, `ru`, `nl`, `cs`, `ar`, `zh-cn`, `ja`, `hu`, `ko`, `hi`.

## Whisper transcription environment
```bash
python3 -m venv whisper-env
source whisper-env/bin/activate
pip install --upgrade pip
pip install fastapi uvicorn faster-whisper
```

Run the service with:
```bash
source whisper-env/bin/activate
uvicorn whisper_server:app --host 0.0.0.0 --port 9000 --reload
```

The `/transcribe` endpoint accepts raw audio/webm bytes. The server writes the payload to a temp file and runs `WhisperModel("small", device="cpu", compute_type="int8")`. Adjust the model size in `whisper_server.py` if you need higher accuracy.

## Docker

The repo includes Dockerfiles and Compose for all three services, configured for production deployment.

**Prerequisites:** Docker and Docker Compose. For **Kokoro**, you must provide model files (see below).

**Production features included:**
- **TLS/HTTPS** via Traefik reverse proxy with Let's Encrypt auto-renewal
- **Rate limiting** (slowapi) — configurable requests/minute per IP
- **Gunicorn + Uvicorn workers** for production-grade concurrency
- **JSON logging** with max-size rotation (10–50MB, 3–5 files)
- **Non-root user** in all containers
- **Health checks** (`/health` endpoint, Docker HEALTHCHECK)
- **Graceful shutdown** (SIGTERM handling, 30s timeout)
- **Resource limits** (memory)
- **Model cache volumes** (XTTS, Whisper, TLS certs)
- **Internal bridge network** for service-to-service communication
- **Image versioning** (`veralux/xtts:1.0.0`, etc.)

### Quick Start (local development)

```bash
# Copy environment template
cp .env.example .env
# Edit .env: set DOMAIN, ACME_EMAIL, VERSION, tunings

# Build and run all services
docker compose up -d
```

Services available at:
- **Kokoro TTS** → `https://<DOMAIN>/kokoro/...` (or `http://localhost:7001` direct)
- **Coqui XTTS** → `https://<DOMAIN>/xtts/...` (or `http://localhost:7002` direct)
- **Whisper** → `https://<DOMAIN>/whisper/...` (or `http://localhost:9000` direct)

For local testing without TLS, set `DOMAIN=localhost` and access via HTTP on ports 7001/7002/9000 directly.

### Configuration

**Environment variables (.env):**

| Variable | Default | Description |
|----------|---------|-------------|
| `DOMAIN` | `localhost` | Domain for TLS certs (e.g. `audio.example.com`) |
| `ACME_EMAIL` | `admin@example.com` | Email for Let's Encrypt notifications |
| `VERSION` | `latest` | Image tag (e.g. `1.0.0`) |
| `RATE_LIMIT_PER_MINUTE` | `30` | Max requests/minute per IP |
| `COQUI_TEMPERATURE` | `0.80` | XTTS voice temperature |
| `COQUI_SPEED` | `1.18` | XTTS speed |
| `WHISPER_MODEL` | `small` | Whisper model size |

### GPU Support

For NVIDIA GPUs, use the GPU override file:

```bash
docker compose -f docker-compose.yml -f docker-compose.gpu.yml up -d
```

This uses `nvidia/cuda` base images and enables CUDA for XTTS and Whisper. Requires:
- NVIDIA Container Toolkit installed
- `nvidia-docker2` or Docker 19.03+ with GPU support

### Run Specific Services

```bash
docker compose up -d xtts whisper   # skip Kokoro
docker compose up -d xtts           # only XTTS
```

### Health Checks

```bash
docker compose ps                   # shows health status
curl http://localhost:7002/health   # XTTS
curl http://localhost:9000/health   # Whisper
curl http://localhost:7001/health   # Kokoro
```

### Single-image Run (without Compose)

```bash
# XTTS only
docker build -f Dockerfile.xtts -t xtts .
docker run -p 7002:7002 -v xtts-cache:/home/appuser/.local/share/tts xtts

# Whisper only
docker build -f Dockerfile.whisper -t whisper .
docker run -p 9000:9000 -v whisper-cache:/home/appuser/.cache/huggingface whisper

# Kokoro (mount dir with kokoro-v1.0.onnx and voices-v1.0.bin)
docker build -f Dockerfile.kokoro -t kokoro .
docker run -p 7001:7001 -v /path/to/kokoro-models:/models:ro kokoro
```

### Kokoro Model Files

Put `kokoro-v1.0.onnx` and `voices-v1.0.bin` in `./kokoro-models/`. If the folder is empty, the Kokoro container will fail at startup.

### Resource Limits

Default memory limits in `docker-compose.yml`: XTTS 4G, others 2G. Adjust `deploy.resources.limits.memory` as needed.

## Testing locally
- Hit Kokoro via `curl` or a REST client, saving the response body straight to a `.wav`.
- Hit Whisper by `curl --data-binary @sample.webm localhost:8082/transcribe`.
- Keep the virtual environments activated while running each server so the right dependencies and model files are accessible.
