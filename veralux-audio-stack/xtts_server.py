from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel
from fastapi.responses import Response, JSONResponse
from TTS.api import TTS
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.util import get_remote_address
from slowapi.errors import RateLimitExceeded
import uvicorn
import io
import logging
import os
import sys
import numpy as np
import soundfile as sf
import inspect

# Logging: level from env (default INFO), to stderr with timestamp
LOG_LEVEL = getattr(logging, os.getenv("XTTS_LOG_LEVEL", "INFO").upper(), logging.INFO)
logging.basicConfig(
    level=LOG_LEVEL,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
    stream=sys.stderr,
)
logger = logging.getLogger("xtts_server")

# PyTorch 2.6+ defaults to weights_only=True; XTTS checkpoints use pickle (e.g. XttsConfig).
# Patch TTS's loader so Coqui checkpoints load (trusted source).
import TTS.utils.io as _tts_io
_orig_load_fsspec = _tts_io.load_fsspec
def _load_fsspec_allow_pickle(*args, **kwargs):
    kwargs.setdefault("weights_only", False)
    return _orig_load_fsspec(*args, **kwargs)
_tts_io.load_fsspec = _load_fsspec_allow_pickle

# Rate limiting
RATE_LIMIT = os.getenv("RATE_LIMIT_PER_MINUTE", "30")
limiter = Limiter(key_func=get_remote_address)

app = FastAPI()
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

# ───────────────────────────────────────────────
# XTTS (Coqui TTS) — default v2 (speed/temperature tunings)
# v1.1: xtts_v1.1 | v2: xtts_v2
# ───────────────────────────────────────────────
MODEL_NAME = os.getenv(
    "XTTS_MODEL_NAME",
    "tts_models/multilingual/multi-dataset/xtts_v2",
)

USE_GPU = os.getenv("XTTS_USE_GPU", "false").lower() in ("1", "true", "yes")
_BASE_DIR = os.path.dirname(os.path.abspath(__file__))
VOICES_DIR = os.getenv("XTTS_VOICES_DIR", os.path.join(_BASE_DIR, "xtts_voices"))
# XTTS model outputs 24 kHz; we can resample to output rate (default 24 kHz)
MODEL_SAMPLE_RATE = 24000
OUTPUT_SAMPLE_RATE = int(os.getenv("XTTS_OUTPUT_SAMPLE_RATE", "24000"))

tts = TTS(MODEL_NAME, gpu=USE_GPU)

# Introspect what this specific install/model supports
_TTS_SIG = inspect.signature(tts.tts)
_TTS_PARAMS = set(_TTS_SIG.parameters.keys())

# Optional COQUI_* env defaults (used when request omits a tuning)
def _coqui_env_float(key: str, default: str | None = None) -> float | None:
    v = os.getenv(key)
    if v is None:
        return float(default) if default is not None else None
    try:
        return float(v)
    except ValueError:
        return None

def _coqui_env_bool(key: str, default: str | None = None) -> bool | None:
    v = os.getenv(key)
    if v is None:
        return {"1": True, "true": True, "yes": True}.get((default or "").lower()) if default else None
    return v.lower() in ("1", "true", "yes")


def _log_voices_dir_state() -> None:
    """Log VOICES_DIR path, existence, and list of .wav files (for debugging 400/500)."""
    exists = os.path.isdir(VOICES_DIR)
    logger.info("voices_dir=%s exists=%s", VOICES_DIR, exists)
    if exists:
        try:
            wavs = sorted(f for f in os.listdir(VOICES_DIR) if f.lower().endswith(".wav"))
            logger.info("voices_dir contains %d wav(s): %s", len(wavs), wavs if len(wavs) <= 20 else wavs[:20] + ["..."])
        except OSError as e:
            logger.warning("voices_dir listdir failed: %s", e)
    else:
        logger.warning("voices_dir missing; run: python download_xtts_voices.py")


class TTSRequest(BaseModel):
    # REQUIRED
    text: str

    # Language
    language: str | None = "en"

    # Voice selection (choose ONE):
    # 1) voice_id -> voices/<voice_id>.wav
    voice_id: str | None = None
    # 2) direct path to wav file
    speaker_wav: str | None = None

    # Optional extras (only forwarded if supported by your installed signature)
    speaker: str | None = None
    emotion: str | None = None
    style: str | None = None
    style_wav: str | None = None

    # Speed/tempo if supported
    speed: float | None = None

    # Split text into sentences and synthesize separately (default True in TTS API)
    split_sentences: bool | None = None

    # Output sample rate (Hz). If set, resample from model 24k to this (e.g. 16000).
    output_sample_rate: int | None = None

    # Optional sampler knobs if supported (best-effort)
    temperature: float | None = None
    top_p: float | None = None
    top_k: int | None = None
    repetition_penalty: float | None = None
    length_penalty: float | None = None


def _first_wav_in_voices_dir() -> str | None:
    """Return path to first .wav in VOICES_DIR (sorted), or None."""
    if not os.path.isdir(VOICES_DIR):
        return None
    wavs = sorted(f for f in os.listdir(VOICES_DIR) if f.lower().endswith(".wav"))
    if not wavs:
        return None
    return os.path.join(VOICES_DIR, wavs[0])


def resolve_speaker_wav(req: TTSRequest) -> str | None:
    """
    Priority:
      speaker_wav (explicit path) >
      voice_id or speaker (voices/<id>.wav) >
      voices/default_voice.wav >
      first .wav in voices dir (e.g. en_sample.wav after download_xtts_voices.py) >
      None
    """
    if req.speaker_wav and os.path.isfile(req.speaker_wav):
        logger.debug("resolve_speaker_wav: using request speaker_wav path=%s", req.speaker_wav)
        return req.speaker_wav
    if req.speaker_wav:
        logger.debug("resolve_speaker_wav: request speaker_wav=%s not a file, skipping", req.speaker_wav)

    voice_id = req.voice_id or req.speaker
    if voice_id:
        candidate = os.path.join(VOICES_DIR, f"{voice_id}.wav")
        if os.path.exists(candidate):
            logger.debug("resolve_speaker_wav: voice_id=%s -> %s", voice_id, candidate)
            return candidate
        logger.debug("resolve_speaker_wav: voice_id=%s -> candidate %s not found", voice_id, candidate)

    fallback = os.path.join(VOICES_DIR, "default_voice.wav")
    if os.path.exists(fallback):
        logger.debug("resolve_speaker_wav: using default_voice.wav")
        return fallback
    logger.debug("resolve_speaker_wav: default_voice.wav not found at %s", fallback)

    first = _first_wav_in_voices_dir()
    if first:
        logger.debug("resolve_speaker_wav: using first wav in dir: %s", first)
        return first
    logger.debug("resolve_speaker_wav: no wav in voices_dir, returning None")
    return None


def build_tts_kwargs(req: TTSRequest) -> dict:
    """
    Build kwargs for tts.tts(), only including parameters
    that this specific model actually supports.
    """
    kwargs: dict = {}

    # speaker wav resolution
    speaker_wav = resolve_speaker_wav(req)
    if speaker_wav is not None and "speaker_wav" in _TTS_PARAMS:
        kwargs["speaker_wav"] = speaker_wav

    # Optional fields: forward if in tts() signature (e.g. speed, language, split_sentences)
    candidate_fields = [
        "language",
        "emotion",
        "style",
        "style_wav",
        "speed",
        "split_sentences",
        "temperature",
        "top_p",
        "top_k",
        "repetition_penalty",
        "length_penalty",
    ]
    # COQUI_* env defaults when request omits a tuning
    _coqui_defaults = {
        "temperature": _coqui_env_float("COQUI_TEMPERATURE"),
        "length_penalty": _coqui_env_float("COQUI_LENGTH_PENALTY"),
        "repetition_penalty": _coqui_env_float("COQUI_REPETITION_PENALTY"),
        "top_p": _coqui_env_float("COQUI_TOP_P"),
        "speed": _coqui_env_float("COQUI_SPEED"),
        "split_sentences": _coqui_env_bool("COQUI_SPLIT_SENTENCES"),
    }
    top_k_val = _coqui_env_float("COQUI_TOP_K")
    if top_k_val is not None:
        _coqui_defaults["top_k"] = int(top_k_val)

    passthrough_kwargs = {"temperature", "top_p", "top_k", "repetition_penalty", "length_penalty"}

    for field in candidate_fields:
        value = getattr(req, field)
        if value is None and field in _coqui_defaults:
            value = _coqui_defaults[field]
        if value is None:
            continue
        if field in _TTS_PARAMS:
            kwargs[field] = value
        elif field in passthrough_kwargs:
            kwargs[field] = value  # reach XTTS synthesize() via **kwargs

    return kwargs


def _resample(wav: np.ndarray, orig_sr: int, target_sr: int) -> np.ndarray:
    """Resample 1D float array from orig_sr to target_sr. Prefer FFT resampling when
    downsampling to avoid aliasing (linear interpolation can sound muffled / like <16 kHz).
    """
    if orig_sr == target_sr:
        return wav
    n = int(len(wav) * target_sr / orig_sr)
    if n <= 0:
        return wav
    # Downsampling: use FFT-based resample if available to avoid aliasing
    if target_sr < orig_sr:
        try:
            from scipy.signal import resample
            out = resample(wav, n).astype(np.float32)
            return out
        except ImportError:
            logger.debug("scipy not available; downsampling with linear interp (may sound muffled)")
    # Linear interpolation (fine for upsampling)
    old_x = np.arange(len(wav), dtype=np.float64)
    new_x = np.linspace(0, len(wav) - 1, num=n, dtype=np.float64)
    return np.interp(new_x, old_x, wav).astype(np.float32)


# Log env and voices dir once at import (so startup logs show state before first request)
logger.info(
    "model=%s gpu=%s voices_dir=%s model_sr=%s output_sr=%s tts_params=%s",
    MODEL_NAME, USE_GPU, VOICES_DIR, MODEL_SAMPLE_RATE, OUTPUT_SAMPLE_RATE, sorted(_TTS_PARAMS),
)
_log_voices_dir_state()


@app.get("/health")
def health():
    return {
        "status": "ok",
        "model": MODEL_NAME,
        "gpu": USE_GPU,
        "voices_dir": VOICES_DIR,
        "model_sample_rate": MODEL_SAMPLE_RATE,
        "output_sample_rate": OUTPUT_SAMPLE_RATE,
        "tts_supported_params": sorted(list(_TTS_PARAMS)),
    }


@app.get("/voices")
def voices():
    if not os.path.isdir(VOICES_DIR):
        return {"voices": []}
    items = []
    for f in os.listdir(VOICES_DIR):
        if f.lower().endswith(".wav"):
            items.append(os.path.splitext(f)[0])
    items.sort()
    return {"voices": items}


@app.post("/tts")
@limiter.limit(f"{RATE_LIMIT}/minute")
async def synthesize(request: Request, req: TTSRequest):
    text = (req.text or "").strip()
    logger.info(
        "POST /tts request: text_len=%d language=%s voice_id=%s speaker=%s speaker_wav=%s",
        len(text),
        getattr(req, "language", None),
        getattr(req, "voice_id", None),
        getattr(req, "speaker", None),
        ("<path>" if (getattr(req, "speaker_wav", None)) else None),
    )
    if not text:
        logger.warning("POST /tts 400: text_required")
        raise HTTPException(status_code=400, detail="text_required")

    tts_kwargs = build_tts_kwargs(req)
    resolved_speaker = tts_kwargs.get("speaker_wav")
    logger.info("POST /tts resolved speaker_wav=%s tts_kwargs=%s", resolved_speaker, tts_kwargs)

    # XTTS requires speaker_wav (path to WAV). Without it we get RuntimeError: AudioDecoder for None.
    if "speaker_wav" in _TTS_PARAMS and resolved_speaker is None:
        _log_voices_dir_state()
        logger.warning(
            "POST /tts 400: speaker required (no voice_id/speaker/speaker_wav and no wav in voices_dir)"
        )
        raise HTTPException(
            status_code=400,
            detail=(
                "speaker required: set voice_id or speaker (e.g. en_sample), or speaker_wav path. "
                f"Voices dir: {VOICES_DIR}. Run: python download_xtts_voices.py"
            ),
        )

    try:
        if "text" in _TTS_PARAMS:
            wav = tts.tts(text=text, **tts_kwargs)
        else:
            wav = tts.tts(text, **tts_kwargs)
    except Exception as e:
        logger.exception("POST /tts 500: TTS synthesis failed: %s", e)
        return JSONResponse(status_code=500, content={"error": str(e)})

    # Ensure numpy 1D float; XTTS returns 24 kHz
    wav = np.asarray(wav, dtype=np.float32).flatten()
    out_sr = req.output_sample_rate if req.output_sample_rate is not None else OUTPUT_SAMPLE_RATE
    if out_sr != MODEL_SAMPLE_RATE:
        wav = _resample(wav, MODEL_SAMPLE_RATE, out_sr)
        logger.debug("POST /tts resampled %s -> %s Hz", MODEL_SAMPLE_RATE, out_sr)
    buf = io.BytesIO()
    sf.write(buf, wav, out_sr, format="WAV")
    size = buf.getvalue()
    logger.info("POST /tts 200: speaker_wav=%s response_bytes=%d", resolved_speaker, len(size))
    return Response(content=size, media_type="audio/wav")


if __name__ == "__main__":
    # Use 7001 so it plugs into your existing XTTS_URL default
    uvicorn.run(app, host="0.0.0.0", port=7002)
