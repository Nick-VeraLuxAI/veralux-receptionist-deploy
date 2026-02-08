from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel
from kokoro_onnx import Kokoro
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.util import get_remote_address
from slowapi.errors import RateLimitExceeded
from starlette.concurrency import run_in_threadpool
import asyncio
import logging
import soundfile as sf
import io
import os

# Rate limiting
RATE_LIMIT = os.getenv("RATE_LIMIT_PER_MINUTE", "30")
limiter = Limiter(key_func=get_remote_address)

app = FastAPI()
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

logger = logging.getLogger("kokoro_server")

KOKORO_MODEL_PATH = os.getenv("KOKORO_MODEL_PATH", "kokoro-v1.0.onnx")
KOKORO_VOICES_PATH = os.getenv("KOKORO_VOICES_PATH", "voices-v1.0.bin")
KOKORO_DEFAULT_VOICE = os.getenv("KOKORO_DEFAULT_VOICE", "bf_emma")
KOKORO_MAX_TEXT_CHARS = int(os.getenv("KOKORO_MAX_TEXT_CHARS", "1000"))
KOKORO_MAX_CONCURRENT = int(os.getenv("KOKORO_MAX_CONCURRENT", "2"))
KOKORO_MIN_SPEED = float(os.getenv("KOKORO_MIN_SPEED", "0.5"))
KOKORO_MAX_SPEED = float(os.getenv("KOKORO_MAX_SPEED", "1.5"))
KOKORO_DEVICE = os.getenv("KOKORO_DEVICE")

# Load Kokoro model + voices at startup (configurable for future GPU use).
if KOKORO_DEVICE:
    try:
        kokoro = Kokoro(KOKORO_MODEL_PATH, KOKORO_VOICES_PATH, device=KOKORO_DEVICE)
    except TypeError:
        logger.warning(
            "KOKORO_DEVICE set but kokoro_onnx does not support device arg; using default device"
        )
        kokoro = Kokoro(KOKORO_MODEL_PATH, KOKORO_VOICES_PATH)
else:
    kokoro = Kokoro(KOKORO_MODEL_PATH, KOKORO_VOICES_PATH)

tts_semaphore = asyncio.Semaphore(KOKORO_MAX_CONCURRENT)


class TTSRequest(BaseModel):
    text: str
    voice_id: str | None = KOKORO_DEFAULT_VOICE  # default voice if client doesn't send one

    # new tuning fields (match what your Node code sends)
    rate: float | None = 1.0       # maps to Kokoro "speed"
    energy: float | None = 1.0     # currently unused, placeholder
    variation: float | None = 1.0  # currently unused, placeholder


def _synthesize_wav(text: str, voice: str, speed: float) -> bytes:
    samples, sample_rate = kokoro.create(
        text,
        voice=voice,
        speed=speed,
    )
    buf = io.BytesIO()
    sf.write(buf, samples, sample_rate, format="WAV")
    return buf.getvalue()


@app.get("/health")
def health():
    return {
        "status": "ok",
        "model": KOKORO_MODEL_PATH,
        "voices": KOKORO_VOICES_PATH,
        "device": KOKORO_DEVICE or "default",
    }


@app.post("/tts")
@limiter.limit(f"{RATE_LIMIT}/minute")
async def synthesize(request: Request, req: TTSRequest):
    try:
        text = (req.text or "").strip()
        if not text:
            return JSONResponse({"error": "text is required"}, status_code=400)
        if len(text) > KOKORO_MAX_TEXT_CHARS:
            return JSONResponse({"error": "text too long"}, status_code=413)

        # voice: use what the client sends, fall back to default
        voice = req.voice_id or KOKORO_DEFAULT_VOICE

        # map rate -> speed for Kokoro
        speed = req.rate if req.rate is not None else 1.0
        if speed < KOKORO_MIN_SPEED:
            speed = KOKORO_MIN_SPEED
        if speed > KOKORO_MAX_SPEED:
            speed = KOKORO_MAX_SPEED

        # (energy / variation are accepted but not used for now)
        # You *could* later use them to choose different voices
        # or tweak text shaping on the Node side.

        async with tts_semaphore:
            wav_bytes = await run_in_threadpool(_synthesize_wav, text, voice, speed)

        return Response(content=wav_bytes, media_type="audio/wav")
    except Exception:
        logger.exception("TTS synthesis failed")
        return JSONResponse({"error": "TTS synthesis failed"}, status_code=500)
