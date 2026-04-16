#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

PYTHON="$(mise which python 2>/dev/null || which python3)"
echo "Using Python: $PYTHON"

if [ ! -d .venv ]; then
    echo "Creating virtual environment..."
    "$PYTHON" -m venv .venv
fi

echo "Installing dependencies..."
source .venv/bin/activate
pip install --upgrade pip
pip install whisperx pyannote.audio sounddevice soundfile

echo ""
echo "Setup complete!"
echo ""
echo "Next steps:"
echo "  1. Create a free HuggingFace account at https://huggingface.co"
echo "  2. Accept the pyannote model licenses:"
echo "     - https://huggingface.co/pyannote/segmentation-3.0"
echo "     - https://huggingface.co/pyannote/speaker-diarization-3.1"
echo "  3. Run: .venv/bin/hf auth login"
