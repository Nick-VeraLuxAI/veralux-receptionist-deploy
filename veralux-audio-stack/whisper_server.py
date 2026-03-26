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
RATE_LIMIT = os.getenv("RATE_LIMIT_PER_MINUTE", "120")
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
WHISPER_BEAM_SIZE = int(os.getenv("WHISPER_BEAM_SIZE", "5"))
WHISPER_LANGUAGE = os.getenv("WHISPER_LANGUAGE", "en")
WHISPER_VAD_FILTER = os.getenv("WHISPER_VAD_FILTER", "true").lower() in {"1", "true", "yes"}
WHISPER_INITIAL_PROMPT = os.getenv(
    "WHISPER_INITIAL_PROMPT",
    "Phone call with a receptionist. The caller may ask to speak with the owner, "
    "manager, schedule an appointment, ask about business hours, services, or pricing.",
)
WHISPER_ALLOW_FALLBACK = os.getenv("WHISPER_ALLOW_FALLBACK", "true").lower() in {"1", "true", "yes"}

# Confidence-based retry: if avg_logprob is below this threshold, retry with higher beam
WHISPER_RETRY_LOGPROB_THRESHOLD = float(
    os.getenv("WHISPER_RETRY_LOGPROB_THRESHOLD", "-0.5")
)
WHISPER_RETRY_BEAM_SIZE = int(os.getenv("WHISPER_RETRY_BEAM_SIZE", "10"))

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


def _deduplicate_text(text: str) -> str:
    """Remove repeated phrases that Whisper sometimes hallucinates on short audio."""
    import re
    stripped = text.strip()
    if not stripped:
        return stripped

    # 1) Regex: detect a phrase repeated 2+ times (with optional separators)
    #    e.g. "Yes, I'm pricing for Yes, I'm pricing for Yes, I'm pricing for"
    deduped = re.sub(
        r'(.{8,}?)\s*(?:\1\s*)+',
        r'\1',
        stripped,
        flags=re.IGNORECASE,
    )
    if deduped != stripped:
        stripped = deduped.strip()

    # 2) Split on sentence boundaries and remove near-duplicate trailing fragments
    sentences = re.split(r'(?<=[.?!])\s+', stripped)
    if len(sentences) <= 1:
        return stripped
    result = [sentences[0]]
    for s in sentences[1:]:
        clean = s.rstrip('- ').lower()
        if clean and not sentences[0].lower().startswith(clean):
            result.append(s)
    return ' '.join(result)


WHISPER_CONDITION_ON_PREV = os.getenv(
    "WHISPER_CONDITION_ON_PREVIOUS_TEXT", "false"
).lower() in {"1", "true", "yes"}
WHISPER_COMPRESSION_RATIO_THRESHOLD = float(
    os.getenv("WHISPER_COMPRESSION_RATIO_THRESHOLD", "2.4")
)
WHISPER_LOG_PROB_THRESHOLD = float(
    os.getenv("WHISPER_LOG_PROB_THRESHOLD", "-1.0")
)
WHISPER_REPETITION_PENALTY = float(
    os.getenv("WHISPER_REPETITION_PENALTY", "1.1")
)
WHISPER_NO_SPEECH_THRESHOLD = float(
    os.getenv("WHISPER_NO_SPEECH_THRESHOLD", "0.6")
)

logging.basicConfig(level=logging.INFO)
logger.info(
    "Whisper config: model=%s device=%s compute=%s beam=%d vad=%s no_speech=%.2f "
    "compress_ratio=%.1f log_prob=%.1f rep_penalty=%.1f",
    WHISPER_MODEL, WHISPER_DEVICE, WHISPER_COMPUTE_TYPE, WHISPER_BEAM_SIZE,
    WHISPER_VAD_FILTER, WHISPER_NO_SPEECH_THRESHOLD,
    WHISPER_COMPRESSION_RATIO_THRESHOLD, WHISPER_LOG_PROB_THRESHOLD,
    WHISPER_REPETITION_PENALTY,
)


def _transcribe_file(
    path: str,
    *,
    language: str | None = None,
    prompt: str | None = None,
    beam_size: int | None = None,
) -> dict:
    effective_lang = language or WHISPER_LANGUAGE
    effective_prompt = prompt or WHISPER_INITIAL_PROMPT or None
    effective_beam = beam_size or WHISPER_BEAM_SIZE

    file_size = os.path.getsize(path)
    logger.info(
        "transcribe start: file=%s size=%d lang=%s vad=%s beam=%d no_speech=%.2f model=%s",
        path, file_size, effective_lang, WHISPER_VAD_FILTER, effective_beam,
        WHISPER_NO_SPEECH_THRESHOLD, WHISPER_MODEL,
    )

    segments, info = model.transcribe(
        path,
        beam_size=effective_beam,
        language=effective_lang,
        vad_filter=WHISPER_VAD_FILTER,
        initial_prompt=effective_prompt,
        no_speech_threshold=WHISPER_NO_SPEECH_THRESHOLD,
        condition_on_previous_text=WHISPER_CONDITION_ON_PREV,
        compression_ratio_threshold=WHISPER_COMPRESSION_RATIO_THRESHOLD,
        log_prob_threshold=WHISPER_LOG_PROB_THRESHOLD,
        repetition_penalty=WHISPER_REPETITION_PENALTY,
    )
    all_segments = list(segments)
    text_chunks = [seg.text for seg in all_segments]

    # Compute weighted average log probability across all segments
    total_duration = 0.0
    weighted_logprob = 0.0
    for seg in all_segments:
        seg_dur = max(seg.end - seg.start, 0.01)
        weighted_logprob += seg.avg_logprob * seg_dur
        total_duration += seg_dur
    avg_logprob = weighted_logprob / total_duration if total_duration > 0 else -1.0

    logger.info(
        "transcribe done: segments=%d lang=%s lang_prob=%.3f duration=%.2fs avg_logprob=%.3f beam=%d",
        len(all_segments),
        info.language,
        info.language_probability,
        info.duration,
        avg_logprob,
        effective_beam,
    )
    for i, seg in enumerate(all_segments):
        logger.info(
            "  seg[%d] [%.2f-%.2f] avg_logprob=%.3f no_speech=%.3f text=%r",
            i, seg.start, seg.end, seg.avg_logprob, seg.no_speech_prob, seg.text,
        )

    raw = "".join(text_chunks).strip()
    return {"text": _deduplicate_text(raw), "avg_logprob": round(avg_logprob, 4)}


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

        # Read optional per-request overrides from query params
        req_language = request.query_params.get("language")
        req_prompt = request.query_params.get("prompt")

        async with transcribe_semaphore:
            result = await run_in_threadpool(
                _transcribe_file, tmp_path, language=req_language, prompt=req_prompt,
            )

            # Confidence-based retry: if first pass has low confidence, retry with higher beam
            if (
                result["avg_logprob"] < WHISPER_RETRY_LOGPROB_THRESHOLD
                and result["text"].strip()
                and WHISPER_RETRY_BEAM_SIZE > WHISPER_BEAM_SIZE
            ):
                logger.info(
                    "low confidence (%.3f < %.3f), retrying with beam=%d",
                    result["avg_logprob"], WHISPER_RETRY_LOGPROB_THRESHOLD,
                    WHISPER_RETRY_BEAM_SIZE,
                )
                retry_result = await run_in_threadpool(
                    _transcribe_file, tmp_path,
                    language=req_language, prompt=req_prompt,
                    beam_size=WHISPER_RETRY_BEAM_SIZE,
                )
                # Use retry if it has better confidence
                if retry_result["avg_logprob"] > result["avg_logprob"]:
                    logger.info(
                        "retry improved: %.3f -> %.3f, text=%r",
                        result["avg_logprob"], retry_result["avg_logprob"],
                        retry_result["text"][:60],
                    )
                    result = retry_result
                else:
                    logger.info("retry did not improve (%.3f), keeping original", retry_result["avg_logprob"])

        return JSONResponse(result)

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
            result = await run_in_threadpool(_transcribe_file, tmp_path)

        return JSONResponse(result)

    except Exception:
        logger.exception("Transcription failed")
        return JSONResponse({"error": "Transcription failed"}, status_code=500)
    finally:
        if tmp_path and os.path.exists(tmp_path):
            try:
                os.remove(tmp_path)
            except OSError:
                logger.warning("Failed to remove temp file: %s", tmp_path)
