#!/usr/bin/env python3
"""Transcribe meeting recordings with speaker diarization."""

import os
import sys
from pathlib import Path


def get_hf_token():
    """Resolve HuggingFace token from env or cached login."""
    token = os.environ.get("HF_TOKEN", "")
    if token:
        return token

    token_file = Path.home() / ".cache" / "huggingface" / "token"
    if token_file.exists():
        return token_file.read_text().strip()

    return ""


def transcribe_track(model, audio_path, device):
    """Transcribe a single audio track, return aligned segments."""
    import whisperx

    audio = whisperx.load_audio(audio_path)
    result = model.transcribe(audio, batch_size=4)

    if not result["segments"]:
        return []

    align_model, metadata = whisperx.load_align_model(
        language_code=result["language"], device=device
    )
    result = whisperx.align(
        result["segments"], align_model, metadata, audio, device
    )
    return result["segments"]


def diarize_track(audio_path, segments, device, hf_token):
    """Run pyannote diarization on a track, assign speaker IDs to segments."""
    import whisperx

    diarize_model = whisperx.DiarizationPipeline(
        use_auth_token=hf_token, device=device
    )
    audio = whisperx.load_audio(audio_path)
    diarize_result = diarize_model(audio)
    result = whisperx.assign_word_speakers(diarize_result, {"segments": segments})
    return result["segments"]


def merge_segments(mic_segments, sys_segments):
    """Merge two transcript segment lists chronologically."""
    combined = []

    for seg in mic_segments:
        combined.append({
            "start": seg["start"],
            "end": seg["end"],
            "speaker": "Me",
            "text": seg["text"].strip(),
        })

    for seg in sys_segments:
        combined.append({
            "start": seg["start"],
            "end": seg["end"],
            "speaker": seg.get("speaker", "Remote"),
            "text": seg["text"].strip(),
        })

    combined.sort(key=lambda s: s["start"])

    # Merge consecutive segments from the same speaker if gap < 2s
    merged = []
    for seg in combined:
        if (
            merged
            and merged[-1]["speaker"] == seg["speaker"]
            and seg["start"] - merged[-1]["end"] < 2.0
        ):
            merged[-1]["text"] += " " + seg["text"]
            merged[-1]["end"] = seg["end"]
        else:
            merged.append(dict(seg))

    return merged


def format_timestamp(seconds):
    """Format seconds as HH:MM:SS or MM:SS."""
    m, s = divmod(int(seconds), 60)
    h, m = divmod(m, 60)
    if h > 0:
        return f"{h}:{m:02d}:{s:02d}"
    return f"{m:02d}:{s:02d}"


def write_markdown(segments, output_path, rec_dir):
    """Write merged transcript as markdown."""
    dirname = Path(rec_dir).name
    with open(output_path, "w") as f:
        f.write(f"# Meeting Transcript — {dirname}\n\n")
        current_speaker = None
        for seg in segments:
            if seg["speaker"] != current_speaker:
                current_speaker = seg["speaker"]
                f.write(
                    f"\n**{current_speaker}** [{format_timestamp(seg['start'])}]\n\n"
                )
            f.write(f"{seg['text']}\n")
    return output_path


def main():
    if len(sys.argv) < 2:
        print("Usage: transcribe.py <recording-directory>")
        sys.exit(1)

    rec_dir = sys.argv[1]
    mic_path = os.path.join(rec_dir, "mic.wav")
    sys_path = os.path.join(rec_dir, "system.wav")
    output_path = os.path.join(rec_dir, "transcript.md")

    hf_token = get_hf_token()
    if not hf_token:
        print("Warning: No HuggingFace token found. Speaker diarization will be skipped.")
        print("Run: hf auth login  (or set HF_TOKEN env var)")
        print()

    # Lazy import so startup errors are clear
    import whisperx

    device = "cpu"  # whisperX doesn't fully support MPS yet
    compute_type = "int8"

    print(f"Loading whisperX model (large-v3) on {device}...")
    model = whisperx.load_model("large-v3", device, compute_type=compute_type)

    mic_segments = []
    sys_segments = []

    if os.path.exists(mic_path):
        print("Transcribing mic track...")
        mic_segments = transcribe_track(model, mic_path, device)
        print(f"  {len(mic_segments)} segments found")

    if os.path.exists(sys_path):
        print("Transcribing system audio track...")
        sys_segments = transcribe_track(model, sys_path, device)
        print(f"  {len(sys_segments)} segments found")

        if hf_token and sys_segments:
            print("Diarizing system audio (identifying speakers)...")
            sys_segments = diarize_track(sys_path, sys_segments, device, hf_token)
        elif not hf_token:
            for seg in sys_segments:
                seg["speaker"] = "Remote"

    if not mic_segments and not sys_segments:
        print("No speech detected in either track.")
        sys.exit(0)

    print("Merging transcripts...")
    merged = merge_segments(mic_segments, sys_segments)

    write_markdown(merged, output_path, rec_dir)
    print(f"\nTranscript saved: {output_path}")
    print(f"  {len(merged)} segments, {len(set(s['speaker'] for s in merged))} speakers")


if __name__ == "__main__":
    main()
