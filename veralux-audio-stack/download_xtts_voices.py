#!/usr/bin/env python3
"""
Download Coqui XTTS-v2 sample speaker WAVs into xtts_voices/ for default voice options.
Run once before starting xtts_server if you want built-in voices (en_sample, es_sample, etc.).
"""
import os
import sys
from pathlib import Path

# Coqui XTTS-v2 samples on Hugging Face (resolve/main)
BASE = "https://huggingface.co/coqui/XTTS-v2/resolve/main/samples"
SAMPLES = [
    "de_sample.wav",
    "en_sample.wav",
    "es_sample.wav",
    "fr_sample.wav",
    "ja-sample.wav",
    "pt_sample.wav",
    "tr_sample.wav",
    "zh-cn-sample.wav",
]


def main():
    base_dir = Path(__file__).resolve().parent
    voices_dir = Path(os.getenv("XTTS_VOICES_DIR", str(base_dir / "xtts_voices")))
    voices_dir.mkdir(parents=True, exist_ok=True)

    import ssl
    import urllib.request
    import urllib.error
    print("Downloading XTTS default voices to", voices_dir)
    # macOS Python often lacks certs; try default first, then unverified
    ctx = ssl.create_default_context()
    try:
        urllib.request.urlopen(f"{BASE}/", timeout=5, context=ctx)
    except (ssl.SSLError, urllib.error.URLError):
        ctx = ssl._create_unverified_context()
        print("  (using SSL fallback; run Install Certificates.command for your Python to fix)", file=sys.stderr)
    for name in SAMPLES:
        path = voices_dir / name
        if path.is_file():
            print("  skip (exists):", name)
            continue
        url = f"{BASE}/{name}"
        try:
            with urllib.request.urlopen(url, timeout=30, context=ctx) as resp:
                path.write_bytes(resp.read())
            print("  ok:", name)
        except Exception as e:
            print("  failed:", name, e, file=sys.stderr)

    # So server fallback "default_voice.wav" works when no voice_id is sent
    default_voice = voices_dir / "default_voice.wav"
    en_sample = voices_dir / "en_sample.wav"
    if not default_voice.is_file() and en_sample.is_file():
        import shutil
        shutil.copy2(en_sample, default_voice)
        print("  default_voice.wav (copy of en_sample.wav)")
    print("Done. Start xtts_server and use GET /voices to list voice_id options.")


if __name__ == "__main__":
    main()
