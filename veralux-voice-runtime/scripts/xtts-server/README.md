# XTTS server for veralux-voice-runtime

This server matches what the runtime's Coqui client sends and expects.

## Contract

- **POST /tts** – JSON body: `{ "text", "language"?, "voice_id"?, "speaker"?, "speaker_wav"? }`
- **Response** – Raw WAV bytes, `Content-Type: audio/wav`
- **GET /voices** – Returns list of preset voice IDs you can use as `voice_id`

## Setup and run

```bash
cd scripts/xtts-server
python3 -m venv xtts-env
source xtts-env/bin/activate   # Windows: xtts-env\Scripts\activate
pip install -r requirements.txt
uvicorn xtts_server:app --host 0.0.0.0 --port 7002 --reload
```

## Runtime .env

```bash
TTS_MODE=coqui_xtts
COQUI_XTTS_URL=http://127.0.0.1:7002/tts
KOKORO_VOICE_ID=af_bella
```

Use a `voice_id` from `GET http://127.0.0.1:7002/voices` (or set `COQUI_VOICE_ID`).

## If you use your own xtts_server.py

Your server must:

1. Expose **POST /tts** (or set `COQUI_XTTS_URL` to your path).
2. Accept JSON with **text** and either **voice_id** (or **speaker**) or **speaker_wav**.
3. Return **raw WAV bytes** with **Content-Type: audio/wav** (not JSON).

If it returns JSON (e.g. `{"error":"..."}`) or a different path, the runtime will fail. Either change the server to match the contract above, or use this reference server.
