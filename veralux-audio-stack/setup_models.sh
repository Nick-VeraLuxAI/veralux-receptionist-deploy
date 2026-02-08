#!/bin/bash
# setup_models.sh - Download all models needed for veralux-audio-stack
#
# Usage: ./setup_models.sh
#
# This script downloads:
#   - Kokoro TTS models (kokoro-v1.0.onnx, voices-v1.0.bin)
#   - XTTS v2 model (~1.8 GB) and default voices
#   - Whisper model (optional, downloads on first use anyway)

set -e

echo "=========================================="
echo "  veralux-audio-stack Model Setup"
echo "=========================================="
echo ""

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Kokoro models
KOKORO_MODEL_URL="https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files/kokoro-v1.0.onnx"
KOKORO_VOICES_URL="https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files/voices-v1.0.bin"
KOKORO_DIR="kokoro-models"

echo -e "${YELLOW}[1/4] Downloading Kokoro TTS models...${NC}"
mkdir -p "$KOKORO_DIR"

if [ -f "$KOKORO_DIR/kokoro-v1.0.onnx" ]; then
    echo "  kokoro-v1.0.onnx already exists, skipping"
else
    echo "  Downloading kokoro-v1.0.onnx (~310 MB)..."
    curl -L --progress-bar -o "$KOKORO_DIR/kokoro-v1.0.onnx" "$KOKORO_MODEL_URL"
fi

if [ -f "$KOKORO_DIR/voices-v1.0.bin" ]; then
    echo "  voices-v1.0.bin already exists, skipping"
else
    echo "  Downloading voices-v1.0.bin (~330 MB)..."
    curl -L --progress-bar -o "$KOKORO_DIR/voices-v1.0.bin" "$KOKORO_VOICES_URL"
fi
echo -e "${GREEN}  Kokoro models ready in $KOKORO_DIR/${NC}"
echo ""

# XTTS voices (speaker samples)
echo -e "${YELLOW}[2/4] Downloading XTTS default voices...${NC}"
if [ -d "xtts_voices" ] && [ "$(ls -A xtts_voices 2>/dev/null)" ]; then
    echo "  xtts_voices/ already populated, skipping"
else
    if command -v python3 &> /dev/null; then
        python3 download_xtts_voices.py
    elif command -v python &> /dev/null; then
        python download_xtts_voices.py
    else
        echo "  WARNING: Python not found. Run 'python download_xtts_voices.py' manually."
    fi
fi
echo -e "${GREEN}  XTTS voices ready in xtts_voices/${NC}"
echo ""

# XTTS model weights
echo -e "${YELLOW}[3/4] Downloading XTTS v2 model (~1.8 GB)...${NC}"
XTTS_ENV="xtts-env"
XTTS_CACHE="$HOME/.local/share/tts"

# Check if model already downloaded
if [ -d "$XTTS_CACHE/tts_models--multilingual--multi-dataset--xtts_v2" ]; then
    echo "  XTTS v2 model already cached, skipping"
    echo -e "${GREEN}  XTTS model ready in $XTTS_CACHE/${NC}"
else
    # Check if xtts-env exists
    if [ -d "$XTTS_ENV" ] && [ -f "$XTTS_ENV/bin/activate" ]; then
        echo "  Using existing $XTTS_ENV..."
        source "$XTTS_ENV/bin/activate"
        python -c "from TTS.api import TTS; TTS('tts_models/multilingual/multi-dataset/xtts_v2')" 2>&1 | grep -v "^$" || true
        deactivate
        echo -e "${GREEN}  XTTS model ready in $XTTS_CACHE/${NC}"
    else
        echo -e "${RED}  xtts-env not found. Creating it now...${NC}"
        echo "  This will install TTS dependencies and download the model."
        echo ""
        
        # Create virtual environment
        python3 -m venv "$XTTS_ENV"
        source "$XTTS_ENV/bin/activate"
        
        pip install --upgrade pip > /dev/null
        echo "  Installing TTS library (this may take a few minutes)..."
        pip install -r xtts-requirements.txt > /dev/null 2>&1
        
        echo "  Downloading XTTS v2 model..."
        python -c "from TTS.api import TTS; TTS('tts_models/multilingual/multi-dataset/xtts_v2')" 2>&1 | grep -v "^$" || true
        
        deactivate
        echo -e "${GREEN}  XTTS model ready in $XTTS_CACHE/${NC}"
    fi
fi
echo ""

# Whisper model (optional)
echo -e "${YELLOW}[4/4] Whisper model...${NC}"
echo "  Whisper models download automatically on first transcription request."
echo "  No manual download needed (~500 MB for 'small' model)."
echo ""

echo "=========================================="
echo -e "${GREEN}  Setup complete!${NC}"
echo "=========================================="
echo ""
echo "Models downloaded:"
echo "  - Kokoro:  $KOKORO_DIR/"
echo "  - XTTS:    $XTTS_CACHE/"
echo "  - Voices:  xtts_voices/"
echo ""
echo "Next steps:"
echo "  1. Run with Docker: docker compose up -d"
echo "  2. Or run locally: see README.md for venv setup"
echo ""
