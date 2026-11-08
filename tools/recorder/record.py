#!/usr/bin/env python3
"""Record audio from a selected device to WAV using sounddevice + soundfile."""

import argparse
import signal
import sys

import sounddevice as sd
import soundfile as sf


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("output", help="Output WAV file path")
    parser.add_argument("--device", type=int, required=True, help="Audio device index")
    parser.add_argument("--channels", type=int, default=1)
    parser.add_argument("--samplerate", type=int, default=48000)
    args = parser.parse_args()

    # Open output file for streaming write
    with sf.SoundFile(
        args.output,
        mode="w",
        samplerate=args.samplerate,
        channels=args.channels,
        subtype="PCM_16",
    ) as f:
        def callback(indata, frames, time, status):
            if status:
                print(status, file=sys.stderr)
            f.write(indata)

        def stop(sig, frame):
            raise SystemExit(0)

        signal.signal(signal.SIGINT, stop)
        signal.signal(signal.SIGTERM, stop)

        with sd.InputStream(
            device=args.device,
            channels=args.channels,
            samplerate=args.samplerate,
            callback=callback,
        ):
            signal.pause()


if __name__ == "__main__":
    main()
