# Recorder

The recorder is an optional, macOS-only stack. Install it with:

```sh
./dotfiles install --recorder
```

This installs `ffmpeg`, BlackHole 2ch, and a locked uv environment outside the
repository at `~/.local/share/dotfiles/recorder-venv`.

Manual setup is still required:

1. In Audio MIDI Setup, create a Multi-Output Device containing both your
   normal speakers/headphones and BlackHole 2ch.
2. Select that Multi-Output Device for system output when recording.
3. Accept the Hugging Face license for
   `pyannote/speaker-diarization-community-1`.
4. Run `rec auth`. This delegates to the Hugging Face CLI inside the recorder's
   isolated environment; no project dependency is exposed as a global command.

`rec` toggles basic recording. `rec auth` authenticates with Hugging Face.
`rec full` toggles recording and then cleans and transcribes it. Transcripts go
to `$NOTES_DIR/raw/meetings`; the default
`NOTES_DIR` is `~/notes` and is persisted in
`~/.config/dotfiles/paths.env`.
