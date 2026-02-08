from fastapi import FastAPI, Request, UploadFile, File
from fastapi.responses import JSONResponse
from faster_whisper import WhisperModel
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.util import get_remote_address
from slowapi.errors import RateLimitExceeded
from starlette.concurrency import run_in_threadpool
import asyncio
import logging
import tempfile
import os
from pathlib import Path

# Rate limiting
RATE_LIMIT = os.getenv("RATE_LIMIT_PER_MINUTE", "30")
limiter = Limiter(key_func=get_remote_address)

app = FastAPI()
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

logger = logging.getLogger("whisper_server")

MAX_BODY_BYTES = int(os.getenv("WHISPER_MAX_BODY_BYTES", str(25 * 1024 * 1024)))
MAX_CONCURRENT = int(os.getenv("WHISPER_MAX_CONCURRENT", "2"))
WHISPER_MODEL = os.getenv("WHISPER_MODEL", "small")
WHISPER_DEVICE = os.getenv("WHISPER_DEVICE", "cpu")
WHISPER_COMPUTE_TYPE = os.getenv("WHISPER_COMPUTE_TYPE", "int8")
WHISPER_BEAM_SIZE = int(os.getenv("WHISPER_BEAM_SIZE", "1"))
WHISPER_LANGUAGE = os.getenv("WHISPER_LANGUAGE", "en")
WHISPER_VAD_FILTER = os.getenv("WHISPER_VAD_FILTER", "true").lower() in {"1", "true", "yes"}
WHISPER_ALLOW_FALLBACK = os.getenv("WHISPER_ALLOW_FALLBACK", "true").lower() in {"1", "true", "yes"}

# Load Whisper model once at startup (configurable for future GPU use).
try:
    model = WhisperModel(
        WHISPER_MODEL,
        device=WHISPER_DEVICE,
        compute_type=WHISPER_COMPUTE_TYPE,
    )
except Exception:
    if WHISPER_DEVICE != "cpu" and WHISPER_ALLOW_FALLBACK:
        logger.exception(
            "Whisper init failed for device=%s; falling back to cpu",
            WHISPER_DEVICE,
        )
        model = WhisperModel(
            WHISPER_MODEL,
            device="cpu",
            compute_type="int8",
        )
    else:
        raise

transcribe_semaphore = asyncio.Semaphore(MAX_CONCURRENT)


def _transcribe_file(path: str) -> str:
    segments, _info = model.transcribe(
        path,
        beam_size=WHISPER_BEAM_SIZE,
        language=WHISPER_LANGUAGE,
        vad_filter=WHISPER_VAD_FILTER,
    )
    text_chunks = [seg.text for seg in segments]
    return "".join(text_chunks).strip()


def _choose_suffix(content_type: str | None, filename: str | None) -> str:
    """
    faster-whisper uses PyAV under the hood; container hints matter.
    Use filename extension when available, otherwise infer from Content-Type.
    """
    if filename:
        suf = Path(filename).suffix.lower()
        if suf in {".wav", ".webm", ".mp3", ".m4a", ".ogg", ".flac"}:
            return suf

    ct = (content_type or "").lower()
    if "wav" in ct:
        return ".wav"
    if "webm" in ct:
        return ".webm"
    if "mpeg" in ct or "mp3" in ct:
        return ".mp3"
    if "ogg" in ct:
        return ".ogg"
    if "flac" in ct:
        return ".flac"

    # Default to wav because your runtime commonly sends wav
    return ".wav"


@app.get("/health")
def health():
    return {
        "status": "ok",
        "model": WHISPER_MODEL,
        "device": WHISPER_DEVICE,
    }


# ---- RAW BODY endpoint (matches your Node runtime: Content-Type: audio/wav, body = wav bytes)
@app.post("/transcribe")
@limiter.limit(f"{RATE_LIMIT}/minute")
async def transcribe(request: Request):
    tmp_path = None
    try:
        content_length = request.headers.get("content-length")
        if content_length:
            try:
                if int(content_length) > MAX_BODY_BYTES:
                    return JSONResponse({"error": "Audio payload too large"}, status_code=413)
            except ValueError:
                return JSONResponse({"error": "Invalid Content-Length header"}, status_code=400)

        body = await request.body()
        if not body:
            return JSONResponse({"error": "Empty request body"}, status_code=400)
        if len(body) > MAX_BODY_BYTES:
            return JSONResponse({"error": "Audio payload too large"}, status_code=413)

        # Pick suffix based on Content-Type (DO NOT force .webm)
        suffix = _choose_suffix(request.headers.get("content-type"), None)

        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
            tmp.write(body)
            tmp_path = tmp.name

        async with transcribe_semaphore:
            text = await run_in_threadpool(_transcribe_file, tmp_path)

        return JSONResponse({"text": text})

    except Exception:
        logger.exception("Transcription failed")
        return JSONResponse({"error": "Transcription failed"}, status_code=500)
    finally:
        if tmp_path and os.path.exists(tmp_path):
            try:
                os.remove(tmp_path)
            except OSError:
                logger.warning("Failed to remove temp file: %s", tmp_path)


# ---- MULTIPART endpoint (matches your curl: -F file=@... )
@app.post("/transcribe_file")
@limiter.limit(f"{RATE_LIMIT}/minute")
async def transcribe_file(request: Request, file: UploadFile = File(...)):
    tmp_path = None
    try:
        data = await file.read()
        if not data:
            return JSONResponse({"error": "Empty file"}, status_code=400)
        if len(data) > MAX_BODY_BYTES:
            return JSONResponse({"error": "Audio payload too large"}, status_code=413)

        suffix = _choose_suffix(file.content_type, file.filename)

        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
            tmp.write(data)
            tmp_path = tmp.name

        async with transcribe_semaphore:
            text = await run_in_threadpool(_transcribe_file, tmp_path)

        return JSONResponse({"text": text})

    except Exception:
        logger.exception("Transcription failed")
        return JSONResponse({"error": "Transcription failed"}, status_code=500)
    finally:
        if tmp_path and os.path.exists(tmp_path):
            try:
                os.remove(tmp_path)
            except OSError:
                logger.warning("Failed to remove temp file: %s", tmp_path)
