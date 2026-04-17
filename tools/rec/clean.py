#!/usr/bin/env python3
"""Remove speaker bleed from mic track using the system audio as reference.

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
from scipy import signal
from scipy.linalg import solve_toeplitz


FILTER_MS = 300         # Room impulse response length to model (ms)
MAX_DELAY_MS = 500      # Max speaker->mic delay to search (ms)
DELAY_PROBE_SEC = 30    # Seconds of audio to use for delay detection
FRAME_MS = 32           # VAD frame size
# Residual suppression
STFT_NFFT = 1024
STFT_HOP = 256
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
    n_fft = 1 << (2 * n - 1).bit_length()

    R = np.fft.rfft(ref, n=n_fft)
    M = np.fft.rfft(mic, n=n_fft)

    auto = np.fft.irfft(R * np.conj(R))[:filter_len].astype(np.float64)
    cross = np.fft.irfft(M * np.conj(R))[:filter_len].astype(np.float64)

    auto[0] += 1e-4 * auto[0]  # Regularize
    w = solve_toeplitz(auto, cross)
    return w.astype(np.float32)


def residual_suppression(mic_clean, echo_est, rate):
    """STFT-domain Wiener gain with double-talk-aware time-varying aggressiveness."""
    n = min(len(mic_clean), len(echo_est))
    mic_clean = mic_clean[:n]
    echo_est = echo_est[:n]

    f, t, Y = signal.stft(
        mic_clean, fs=rate, nperseg=STFT_NFFT, noverlap=STFT_NFFT - STFT_HOP
    )
    _, _, E = signal.stft(
        echo_est, fs=rate, nperseg=STFT_NFFT, noverlap=STFT_NFFT - STFT_HOP
    )

    Y_pow = np.abs(Y) ** 2
    E_pow = np.abs(E) ** 2

    # Per-frame signal-to-echo ratio (SER): if mic power clearly exceeds echo,
    # user is likely speaking — use gentle alpha. Otherwise, aggressive.
    Y_energy = Y_pow.sum(axis=0)
    E_energy = E_pow.sum(axis=0)
    # Sigmoid between aggressive and gentle alpha based on log SER
    log_ratio = np.log((Y_energy + 1e-12) / (E_energy + 1e-12))
    # Blend: 0 = full echo-only (aggressive), 1 = full double-talk (gentle)
    blend = 1.0 / (1.0 + np.exp(-(log_ratio - 1.0) * 2.0))
    alpha_per_frame = (
        RES_ALPHA_ECHO_ONLY * (1 - blend) + RES_ALPHA_DOUBLETALK * blend
    )

    raw_gain = Y_pow / (Y_pow + alpha_per_frame[np.newaxis, :] * E_pow + 1e-12)

    # Temporal smoothing: asymmetric attack/release
    smoothed = np.zeros_like(raw_gain)
    prev = np.ones(raw_gain.shape[0], dtype=raw_gain.dtype)
    for i in range(raw_gain.shape[1]):
        cur = raw_gain[:, i]
        alpha = np.where(cur < prev, RES_ATTACK, RES_RELEASE)
        prev = alpha * prev + (1 - alpha) * cur
        smoothed[:, i] = prev

    gain = np.maximum(smoothed, RES_FLOOR)

    Y_clean = Y * gain
    _, out = signal.istft(
        Y_clean, fs=rate, nperseg=STFT_NFFT, noverlap=STFT_NFFT - STFT_HOP
    )
    return out[:n].astype(np.float32)


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

    filter_len = int(rate * FILTER_MS / 1000)
    print(f"Computing {filter_len}-tap Wiener filter on {len(train_mic) / rate:.1f}s...")
    w = wiener_filter(train_mic, train_ref, filter_len)

    # Synthesize echo estimate over the full recording
    echo_est = signal.fftconvolve(ref_aligned, w)[:n].astype(np.float32)
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
