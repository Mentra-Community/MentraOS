"""Synthetic faults for detector validation only.

These transforms measure whether the detectors see what they claim to (and ignore what they
should ignore). They are never mixed into device results: a run is either a device run or a
synthetic validation run.
"""

from __future__ import annotations

from typing import Optional

import numpy as np

from .wavio import resample


def speaker(x: np.ndarray, rate: int, noise_db: float = -60.0, seed: int = 0) -> np.ndarray:
    """A crude acoustic path: band-limiting FIR plus room noise."""
    taps = 63
    n = np.arange(taps) - taps // 2
    cutoff = 9000.0 / rate
    h = np.sinc(2 * cutoff * n) * np.hanning(taps)
    h /= h.sum()
    y = np.convolve(x, h, mode="same")
    rng = np.random.default_rng(seed)
    return y + rng.normal(0.0, 10 ** (noise_db / 20.0), len(y))


def rate_mismatch_stretch(x: np.ndarray, played_rate: float, intended_rate: float) -> np.ndarray:
    """Content intended for ``intended_rate`` consumed at ``played_rate`` (pitch and time scale)."""
    return resample(x, played_rate, intended_rate)


def overflow_drops(x: np.ndarray, burst: int = 512, drop: int = 41, ramp: int = 64, jitter: int = 0,
                   seed: int = 0) -> np.ndarray:
    """Drop ``drop`` samples from every ``burst``, joined with a linear ramp like the BES queue."""
    rng = np.random.default_rng(seed)
    out = []
    pos = 0
    previous_tail = None
    while pos < len(x):
        size = burst + (int(rng.integers(-jitter, jitter + 1)) if jitter else 0)
        chunk = x[pos:pos + size]
        pos += size
        if len(chunk) > drop:
            chunk = chunk[drop:].copy()
            if previous_tail is not None:
                length = min(ramp, len(chunk))
                weights = np.linspace(0.0, 1.0, length)
                chunk[:length] = previous_tail * (1 - weights) + chunk[:length] * weights
        if len(chunk):
            previous_tail = chunk[-1]
            out.append(chunk)
    return np.concatenate(out) if out else x[:0]


def insert_click(x: np.ndarray, rate: int, at_s: float, amplitude: float = 0.2) -> np.ndarray:
    y = x.copy()
    index = int(at_s * rate)
    if 0 <= index < len(y):
        y[index] += amplitude
    return y


def remove_segment(x: np.ndarray, rate: int, at_s: float, length_s: float) -> np.ndarray:
    start = int(at_s * rate)
    return np.concatenate([x[:start], x[start + int(length_s * rate):]])


def repeat_segment(x: np.ndarray, rate: int, at_s: float, length_s: float) -> np.ndarray:
    start = int(at_s * rate)
    end = start + int(length_s * rate)
    return np.concatenate([x[:end], x[start:end], x[end:]])


def gain(x: np.ndarray, db: float) -> np.ndarray:
    return x * 10 ** (db / 20.0)


def low_shelf(x: np.ndarray, rate: int, db: float = 9.0, corner_hz: float = 300.0) -> np.ndarray:
    spectrum = np.fft.rfft(x)
    freqs = np.fft.rfftfreq(len(x), 1.0 / rate)
    boost = 1.0 + (10 ** (db / 20.0) - 1.0) / (1.0 + (freqs / corner_hz) ** 2)
    return np.fft.irfft(spectrum * boost, len(x))


def clip(x: np.ndarray, fraction_of_peak: float = 0.3) -> np.ndarray:
    limit = np.max(np.abs(x)) * fraction_of_peak
    return np.clip(x, -limit, limit)


def place(x: np.ndarray, rate: int, lead_s: float = 0.2, tail_s: float = 0.4, total_s: Optional[float] = None) -> np.ndarray:
    """Surround a cue with silence, as in a recording window."""
    lead = np.zeros(int(lead_s * rate))
    tail_len = int(tail_s * rate) if total_s is None else max(0, int(total_s * rate) - len(lead) - len(x))
    return np.concatenate([lead, x, np.zeros(tail_len)])
