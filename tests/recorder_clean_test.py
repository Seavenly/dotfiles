#!/usr/bin/env python3
"""Behavioral tests for the recorder's echo-cancellation post-processing."""

import importlib.util
import resource
import sys
import unittest
from pathlib import Path

import numpy as np


MODULE_PATH = Path(__file__).parents[1] / "tools" / "recorder" / "clean.py"
SPEC = importlib.util.spec_from_file_location("recorder_clean", MODULE_PATH)
clean = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(clean)


def peak_rss_bytes():
    peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return peak if sys.platform == "darwin" else peak * 1024


class ResidualSuppressionTest(unittest.TestCase):
    def test_silent_echo_reference_preserves_the_mic_signal(self):
        rng = np.random.default_rng(2)
        mic = rng.normal(0, 0.01, 10_003).astype(np.float32)

        output = clean.residual_suppression(
            mic, np.zeros_like(mic), rate=8_000
        )

        np.testing.assert_allclose(output, mic, rtol=1e-5, atol=1e-7)

    def test_long_audio_uses_bounded_working_memory(self):
        rate = 8_000
        sample_count = rate * 120
        rng = np.random.default_rng(1)
        mic = rng.normal(0, 0.01, sample_count).astype(np.float32)
        echo = rng.normal(0, 0.005, sample_count).astype(np.float32)

        output = clean.residual_suppression(mic, echo, rate)

        self.assertEqual(len(output), sample_count)
        self.assertLess(
            peak_rss_bytes(),
            240 * 1024 * 1024,
            "residual suppression materialized a full-duration spectrogram",
        )


if __name__ == "__main__":
    unittest.main()
