#!/usr/bin/env python3
"""Remove speaker bleed from a mic track using system audio as reference.

Two-stage acoustic echo cancellation:
  1. Linear Wiener FIR filter estimated from echo-dominant frames (when the
     user is not speaking), subtracted from the mic track.
  2. Residual echo suppression in the STFT domain — a frequency-dependent
     Wiener gain that further attenuates echo the linear stage couldn't
     cancel (non-linearities, distortion, etc.).
"""

import os
import sys

import numpy as np
import soundfile as sf
from scipy import fft, signal
from scipy.linalg import solve_toeplitz


FILTER_MS = 300             # Room impulse response length to model (ms)
FILTER_TRAIN_SEC = 120      # Enough audio for a stationary room response
MAX_DELAY_MS = 500          # Max speaker->mic delay to search (ms)
DELAY_PROBE_SEC = 30        # Seconds of audio to use for delay detection
FRAME_MS = 32               # VAD frame size
# Residual suppression
STFT_NFFT = 1024
STFT_HOP = 256
STFT_BLOCK_FRAMES = 1024
RES_ALPHA_ECHO_ONLY = 8.0   # Aggressive when user is silent
RES_ALPHA_DOUBLETALK = 2.0  # Gentle when user is speaking
RES_FLOOR = 0.03            # Minimum gain
RES_ATTACK = 0.6            # Smoothing toward smaller gains (fast)
RES_RELEASE = 0.93          # Smoothing toward larger gains (slow release)


def load_mono(path):
    data, rate = sf.read(path, dtype="float32", always_2d=True)
    return data.mean(axis=1), rate


def find_delay(mic, ref, rate):
    n = min(len(mic), len(ref), rate * DELAY_PROBE_SEC)
    max_lag = int(rate * MAX_DELAY_MS / 1000)
    m = mic[:n] - mic[:n].mean()
    r = ref[:n] - ref[:n].mean()
    corr = signal.correlate(m, r, mode="full")
    center = n - 1
    window = corr[center - max_lag : center + max_lag + 1]
    return int(np.argmax(np.abs(window)) - max_lag)


def align_ref(ref, delay, n):
    if delay >= 0:
        out = np.concatenate([np.zeros(delay, dtype=np.float32), ref])[:n]
    else:
        out = ref[-delay:]
        out = np.concatenate([out, np.zeros(n - len(out), dtype=np.float32)])
    return out[:n]


def echo_only_mask(mic, ref, rate, frame_samples):
    """Per-frame mask: True where mic looks like echo-only (no user speech).

    Heuristic: user is speaking when mic energy is much larger than ref energy.
    If ref is loud and mic isn't dramatically louder, we're in echo-only territory.
    """
    n_frames = len(mic) // frame_samples
    mic_rms = np.sqrt(np.mean(mic[: n_frames * frame_samples].reshape(n_frames, -1) ** 2, axis=1))
    ref_rms = np.sqrt(np.mean(ref[: n_frames * frame_samples].reshape(n_frames, -1) ** 2, axis=1))

    # Noise floor of mic (bottom 10%)
    mic_floor = np.percentile(mic_rms, 10) + 1e-6
    ref_floor = np.percentile(ref_rms, 10) + 1e-6

    ref_active = ref_rms > 5 * ref_floor
    mic_active_strong = mic_rms > 8 * mic_floor

    # Echo-only: ref active, AND mic not unusually strong compared to ref
    echo_only = ref_active & ~(mic_active_strong & (mic_rms > 2 * ref_rms))
    return echo_only


def wiener_filter(mic, ref, filter_len):
    """FIR filter w minimizing ||mic - ref * w||^2."""
    n = max(len(mic), len(ref))
    n_fft = fft.next_fast_len(2 * n - 1)

    R = fft.rfft(ref, n=n_fft)
    M = fft.rfft(mic, n=n_fft)

    auto = fft.irfft(R * np.conj(R))[:filter_len].astype(np.float64)
    cross = fft.irfft(M * np.conj(R))[:filter_len].astype(np.float64)

    auto[0] += 1e-4 * auto[0]  # Regularize
    w = solve_toeplitz(auto, cross)
    return w.astype(np.float32)


def _stft_frames(samples, first_frame, frame_count, sample_count):
    """Return one zero-padded block of overlapping analysis frames."""
    half_window = STFT_NFFT // 2
    first_sample = first_frame * STFT_HOP - half_window
    block_length = (frame_count - 1) * STFT_HOP + STFT_NFFT
    block = np.zeros(block_length, dtype=np.float32)
    source_start = max(first_sample, 0)
    source_end = min(first_sample + block_length, sample_count)
    if source_end > source_start:
        dest_start = source_start - first_sample
        block[dest_start : dest_start + source_end - source_start] = (
            samples[source_start:source_end]
        )
    return np.lib.stride_tricks.sliding_window_view(
        block, STFT_NFFT
    )[::STFT_HOP]


def _accumulate_overlap_add(output, frames, first_frame):
    """Add a block of synthesized frames without iterating over every frame."""
    overlap = STFT_NFFT // STFT_HOP
    for residue in range(overlap):
        local_start = (residue - first_frame) % overlap
        residue_frames = frames[local_start::overlap]
        if not len(residue_frames):
            continue
        output_start = (first_frame + local_start) * STFT_HOP
        flattened = residue_frames.reshape(-1)
        output[output_start : output_start + len(flattened)] += flattened


def _normalize_overlap_add(output, sample_count, frame_count, window):
    """Normalize periodic overlap and the finite recording edges in place."""
    half_window = STFT_NFFT // 2
    cleaned = output[half_window : half_window + sample_count]
    normalization = np.array(
        [np.sum(window[offset::STFT_HOP] ** 2) for offset in range(STFT_HOP)],
        dtype=np.float32,
    )
    left_edge_end = min(
        sample_count, STFT_NFFT - STFT_HOP - half_window
    )
    right_edge_start = max(
        left_edge_end, (frame_count * STFT_HOP) - half_window
    )

    def normalize_edge(start, end):
        if end <= start:
            return
        coordinates = np.arange(start + half_window, end + half_window)
        denominator = np.zeros(end - start, dtype=np.float32)
        first_touching_frame = max(
            0, (coordinates[0] - STFT_NFFT) // STFT_HOP
        )
        last_touching_frame = min(
            frame_count - 1, coordinates[-1] // STFT_HOP
        )
        for frame_index in range(
            first_touching_frame, last_touching_frame + 1
        ):
            window_indexes = coordinates - frame_index * STFT_HOP
            valid = (window_indexes >= 0) & (window_indexes < STFT_NFFT)
            denominator[valid] += window[window_indexes[valid]] ** 2
        cleaned[start:end] /= denominator

    normalize_edge(0, left_edge_end)
    normalize_edge(right_edge_start, sample_count)
    for residue in range(STFT_HOP):
        start = left_edge_end + (
            residue - (left_edge_end + half_window)
        ) % STFT_HOP
        cleaned[start:right_edge_start:STFT_HOP] /= normalization[residue]
    return cleaned


def residual_suppression(mic_clean, echo_est, rate):
    """Apply a bounded-memory STFT Wiener gain with temporal continuity."""
    n = min(len(mic_clean), len(echo_est))
    mic_clean = mic_clean[:n]
    echo_est = echo_est[:n]

    window = signal.get_window("hann", STFT_NFFT).astype(np.float32)
    frame_count = (n + STFT_HOP - 1) // STFT_HOP + 1
    padded_length = (frame_count - 1) * STFT_HOP + STFT_NFFT
    output = np.zeros(padded_length, dtype=np.float32)
    previous_gain = np.ones(STFT_NFFT // 2 + 1, dtype=np.float32)

    for first_frame in range(0, frame_count, STFT_BLOCK_FRAMES):
        block_frame_count = min(STFT_BLOCK_FRAMES, frame_count - first_frame)
        mic_frames = _stft_frames(
            mic_clean, first_frame, block_frame_count, n
        )
        echo_frames = _stft_frames(
            echo_est, first_frame, block_frame_count, n
        )

        mic_spectrum = fft.rfft(mic_frames * window, axis=1)
        echo_spectrum = fft.rfft(echo_frames * window, axis=1)
        mic_power = mic_spectrum.real**2 + mic_spectrum.imag**2
        echo_power = echo_spectrum.real**2 + echo_spectrum.imag**2

        mic_energy = mic_power.sum(axis=1)
        echo_energy = echo_power.sum(axis=1)
        log_ratio = np.log((mic_energy + 1e-12) / (echo_energy + 1e-12))
        blend = 1.0 / (1.0 + np.exp(-(log_ratio - 1.0) * 2.0))
        alpha_per_frame = (
            RES_ALPHA_ECHO_ONLY * (1 - blend)
            + RES_ALPHA_DOUBLETALK * blend
        )

        echo_power *= alpha_per_frame[:, np.newaxis]
        echo_power += mic_power
        echo_power += 1e-12
        np.divide(mic_power, echo_power, out=mic_power)

        for frame_index in range(block_frame_count):
            current_gain = mic_power[frame_index]
            smoothing = np.where(
                current_gain < previous_gain, RES_ATTACK, RES_RELEASE
            )
            previous_gain = (
                smoothing * previous_gain + (1 - smoothing) * current_gain
            )
            current_gain[:] = previous_gain

        np.maximum(mic_power, RES_FLOOR, out=mic_power)
        mic_spectrum *= mic_power
        cleaned_frames = fft.irfft(
            mic_spectrum, n=STFT_NFFT, axis=1
        ).astype(np.float32)
        cleaned_frames *= window

        _accumulate_overlap_add(output, cleaned_frames, first_frame)

    cleaned = _normalize_overlap_add(output, n, frame_count, window)
    return cleaned.astype(np.float32, copy=False)


def apply_makeup_gain(orig_mic, cleaned, ref_aligned, rate):
    """Restore user voice volume to original level, measured in echo-free segments."""
    frame_samples = int(rate * FRAME_MS / 1000)
    n_frames = min(len(orig_mic), len(cleaned)) // frame_samples

    orig_frames = orig_mic[:n_frames * frame_samples].reshape(n_frames, -1)
    clean_frames = cleaned[:n_frames * frame_samples].reshape(n_frames, -1)
    ref_frames = ref_aligned[:n_frames * frame_samples].reshape(n_frames, -1)

    orig_rms = np.sqrt(np.mean(orig_frames ** 2, axis=1))
    ref_rms = np.sqrt(np.mean(ref_frames ** 2, axis=1))
    clean_rms = np.sqrt(np.mean(clean_frames ** 2, axis=1))

    ref_floor = np.percentile(ref_rms, 20) + 1e-6
    orig_floor = np.percentile(orig_rms, 20) + 1e-6

    # User-only frames: mic has signal, ref is silent
    user_only = (ref_rms < 3 * ref_floor) & (orig_rms > 5 * orig_floor)
    if user_only.sum() < 5:
        return cleaned  # Not enough data for reliable gain estimate

    target_rms = np.sqrt(np.mean(orig_rms[user_only] ** 2))
    current_rms = np.sqrt(np.mean(clean_rms[user_only] ** 2))

    if current_rms < 1e-6:
        return cleaned

    gain = target_rms / current_rms
    gain = np.clip(gain, 0.5, 4.0)  # Safety clamp
    print(f"Voice makeup gain: {20 * np.log10(gain):+.1f} dB "
          f"(from {user_only.sum()} user-only frames)")
    return cleaned * gain


def clean_mic(mic_path, system_path, output_path):
    mic, mic_rate = load_mono(mic_path)
    ref, ref_rate = load_mono(system_path)

    if mic_rate != ref_rate:
        print(f"Resampling system audio {ref_rate}Hz -> {mic_rate}Hz")
        ref = signal.resample_poly(ref, mic_rate, ref_rate).astype(np.float32)
    rate = mic_rate

    n = min(len(mic), len(ref))
    mic = mic[:n]
    ref = ref[:n]

    if np.abs(ref).max() < 1e-4:
        print("System audio is silent; copying mic unchanged.")
        sf.write(output_path, mic, rate, subtype="PCM_16")
        return

    delay = find_delay(mic, ref, rate)
    print(f"Estimated delay: {delay} samples ({1000 * delay / rate:.1f} ms)")
    ref_aligned = align_ref(ref, delay, n)

    # Identify echo-only frames to train the Wiener filter on
    frame_samples = int(rate * FRAME_MS / 1000)
    mask = echo_only_mask(mic, ref_aligned, rate, frame_samples)
    coverage = mask.sum() / len(mask)
    print(f"Echo-only coverage for filter training: {100 * coverage:.1f}% of frames")

    if coverage < 0.05:
        print("Not enough echo-only frames; using full recording for filter.")
        train_mic, train_ref = mic, ref_aligned
    else:
        # Gather echo-only samples (keeps contiguity within selected frames)
        sample_mask = np.repeat(mask, frame_samples)
        sample_mask = np.pad(sample_mask, (0, n - len(sample_mask)), constant_values=False)
        train_mic = mic[sample_mask]
        train_ref = ref_aligned[sample_mask]

    max_train_samples = rate * FILTER_TRAIN_SEC
    if len(train_mic) > max_train_samples:
        print(
            f"Limiting Wiener filter training to {FILTER_TRAIN_SEC}s "
            "to bound memory use."
        )
        train_mic = train_mic[:max_train_samples]
        train_ref = train_ref[:max_train_samples]

    filter_len = int(rate * FILTER_MS / 1000)
    print(f"Computing {filter_len}-tap Wiener filter on {len(train_mic) / rate:.1f}s...")
    w = wiener_filter(train_mic, train_ref, filter_len)

    # Synthesize echo estimate over the full recording
    echo_est = signal.oaconvolve(ref_aligned, w)[:n].astype(np.float32)
    linear_clean = mic - echo_est

    before = 20 * np.log10(np.sqrt(np.mean(mic**2)) + 1e-12)
    after_lin = 20 * np.log10(np.sqrt(np.mean(linear_clean**2)) + 1e-12)
    print(f"Linear AEC: {before:.1f} dB -> {after_lin:.1f} dB ({before - after_lin:+.1f} dB)")

    # Residual echo suppression (time-varying, double-talk aware)
    print("Applying residual echo suppression...")
    final_clean = residual_suppression(linear_clean, echo_est, rate)

    # Restore voice volume using echo-free segments as reference
    final_clean = apply_makeup_gain(mic, final_clean, ref_aligned, rate)
    after_res = 20 * np.log10(np.sqrt(np.mean(final_clean**2)) + 1e-12)
    print(f"Final level: {after_res:.1f} dB ({before - after_res:+.1f} dB from original)")

    # Safety clipping
    peak = np.abs(final_clean).max()
    if peak > 0.99:
        final_clean = final_clean * (0.99 / peak)

    sf.write(output_path, final_clean, rate, subtype="PCM_16")
    print(f"Wrote: {output_path}")


def main():
    if len(sys.argv) < 2:
        print("Usage: clean.py <recording-directory>")
        sys.exit(1)

    rec_dir = sys.argv[1]
    mic_path = os.path.join(rec_dir, "mic.wav")
    system_path = os.path.join(rec_dir, "system.wav")
    output_path = os.path.join(rec_dir, "mic_cleaned.wav")

    if not os.path.exists(mic_path):
        print(f"Error: {mic_path} not found")
        sys.exit(1)
    if not os.path.exists(system_path):
        print(f"Error: {system_path} not found")
        sys.exit(1)

    clean_mic(mic_path, system_path, output_path)


if __name__ == "__main__":
    main()
