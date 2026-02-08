from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from faster_whisper import WhisperModel
import tempfile
import os

app = FastAPI()

# Load Whisper model once at startup.
# You can change "small" to "base", "medium", etc. if you want.
model = WhisperModel("small", device="cpu", compute_type="int8")


@app.post("/transcribe")
async def transcribe(request: Request):
    try:
        # 1) Read raw bytes (WebM/Opus from browser or WAV from Node)
        body = await request.body()

        # 2) Write to a temporary file with a generic extension
        #    ffmpeg inside faster-whisper will detect the format
        with tempfile.NamedTemporaryFile(delete=False, suffix=".webm") as tmp:
            tmp.write(body)
            tmp_path = tmp.name

        # 3) Transcribe with faster-whisper
        segments, info = model.transcribe(
            tmp_path,
            beam_size=5,
            language=None,  # set to "en" to force English
        )

        text_chunks = [seg.text for seg in segments]
        text = "".join(text_chunks).strip()

        # 4) Clean up temp file
        os.remove(tmp_path)

        return JSONResponse({"text": text})

    except Exception as e:
        # Make sure we see any error clearly
        return JSONResponse({"error": str(e)}, status_code=500)
