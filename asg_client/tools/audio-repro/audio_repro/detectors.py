"""Acoustic symptom detectors for one recorded cue.

Detectors report measured values with a confidence and do not presuppose a mechanism:

* pitch factor (dominant-frequency ratio) and a frequency trajectory that exposes mid-cue steps;
* time scale from the envelope decay slope and from envelope correlation over a scale grid;
* duration between level-relative onset and offset;
* discontinuities from a per-frame sinusoid fit (phase jumps, residual spikes, amplitude dips)
  and from impulsive energy in the residual after removing the fitted tone, compared with a
  local median, so steady distortion such as clipping harmonics is not counted as clicks;
* level, spectral tilt, harmonic distortion and recorder clipping, measured separately so they
  are never read as pitch.

The recording-start cue is a single decaying tone near 1.1 kHz, which makes the sinusoid model
exact; for a non-tonal reference the pitch confidence is reported as low.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Dict, List, Optional

import numpy as np


# The speaker attack is not steady-state; sinusoid and transient events start after it.
ATTACK_SKIP_S = 0.012


@dataclass
class Thresholds:
    pitch_deviation: float = 0.02
    duration_deviation: float = 0.03
    phase_jump_rad: float = 0.35
    residual_spike_db: float = 12.0
    dip_db: float = 6.0
    hf_transient_db: float = 12.0
    min_confidence: float = 0.5
    distortion_excess_db: float = 6.0

    @classmethod
    def from_dict(cls, data: Optional[Dict[str, float]]) -> "Thresholds":
        base = cls()
        for key, value in (data or {}).items():
            if hasattr(base, key):
                setattr(base, key, float(value))
        return base


@dataclass
class Reference:
    """Measured properties of the reference cue at the analysis rate."""

    rate: int
    samples: np.ndarray
    frequency: float
    tonal_fraction: float
    onset_s: float
    offset_s: float
    decay_db_per_s: float
    envelope: np.ndarray
    thd_db: float


@dataclass
class CueMetrics:
    found: bool
    onset_s: float = 0.0
    pitch_factor: float = float("nan")
    pitch_confidence: float = 0.0
    pitch_trajectory: List[float] = field(default_factory=list)
    pitch_step: float = 0.0
    time_scale_decay: float = float("nan")
    time_scale_corr: float = float("nan")
    duration_ratio: float = float("nan")
    duration_floor_db: float = float("nan")
    level_db: float = float("nan")
    recorder_clipped_fraction: float = 0.0
    thd_db: float = float("nan")
    thd_excess_db: float = float("nan")
    tilt_db: float = float("nan")
    phase_jumps: List[float] = field(default_factory=list)
    residual_spikes: List[float] = field(default_factory=list)
    dips: List[float] = field(default_factory=list)
    transients: List[float] = field(default_factory=list)
    symptoms: List[str] = field(default_factory=list)

    def to_dict(self) -> Dict[str, object]:
        out = asdict(self)
        for key, value in out.items():
            if isinstance(value, float) and not np.isfinite(value):
                out[key] = None
        return out


def rms_envelope(x: np.ndarray, rate: int, window_s: float = 0.002, hop_s: float = 0.001) -> np.ndarray:
    window = max(1, int(window_s * rate))
    hop = max(1, int(hop_s * rate))
    power = np.convolve(x * x, np.ones(window) / window, mode="same")
    return np.sqrt(power[::hop] + 1e-20)


def dominant_frequency(x: np.ndarray, rate: int, fmin: float = 100.0, fmax: float = 12000.0):
    """Interpolated strongest spectral peak and the fraction of band energy near it."""
    n = 1 << int(np.ceil(np.log2(max(len(x), 16)) + 3))
    spectrum = np.abs(np.fft.rfft(x * np.hanning(len(x)), n))
    freqs = np.fft.rfftfreq(n, 1.0 / rate)
    band = (freqs >= fmin) & (freqs <= fmax)
    if not band.any() or spectrum[band].max() <= 0:
        return float("nan"), 0.0
    index = np.flatnonzero(band)[np.argmax(spectrum[band])]
    if 0 < index < len(spectrum) - 1:
        a, b, c = np.log(spectrum[index - 1:index + 2] + 1e-20)
        delta = 0.5 * (a - c) / (a - 2 * b + c) if (a - 2 * b + c) != 0 else 0.0
    else:
        delta = 0.0
    peak = (index + delta) * rate / n
    power = spectrum ** 2
    near = band & (np.abs(freqs - peak) <= 0.03 * peak)
    fraction = float(power[near].sum() / max(power[band].sum(), 1e-30))
    return float(peak), fraction


def onset_offset(x: np.ndarray, rate: int, floor_db: float = -30.0, detail: bool = False):
    """Onset from a 2 ms envelope at -20 dB re its peak; offset where a 10 ms envelope falls
    ``floor_db`` below its own peak, raised when needed to stay 10 dB above the noise floor.
    Both are level-relative, so gain and EQ do not move them, and the smoothed peak is
    insensitive to the attack transient. With ``detail`` the effective floor is also returned so
    a reference can be measured at the same relative level."""
    fast = rms_envelope(x, rate, 0.002, 0.001)
    slow = rms_envelope(x, rate, 0.010, 0.001)
    if slow.max() <= 0:
        return None
    ordered = np.sort(slow)
    noise = float(np.median(ordered[: max(1, len(ordered) // 5)]))
    if slow.max() < noise * 10:
        return None
    onset_threshold = max(fast.max() * 0.1, noise * 3.0)
    rising = np.flatnonzero(fast > onset_threshold)
    if len(rising) == 0:
        return None
    onset_index = rising[0]
    peak_index = onset_index + int(np.argmax(slow[onset_index:onset_index + 200]))
    peak = slow[peak_index]
    effective_db = max(floor_db, 20 * np.log10(max(noise, 1e-20) * 10 ** (10 / 20.0) / peak))
    threshold = peak * 10 ** (effective_db / 20.0)
    falling = np.flatnonzero(slow[peak_index:] < threshold)
    offset_index = peak_index + (falling[0] if len(falling) else len(slow) - 1 - peak_index)
    if detail:
        return onset_index * 0.001, offset_index * 0.001, float(effective_db)
    return onset_index * 0.001, offset_index * 0.001


def decay_slope_db_per_s(x: np.ndarray, rate: int, onset_s: float, high_db: float = -3.0, low_db: float = -25.0) -> float:
    env_db = 20 * np.log10(rms_envelope(x, rate, 0.005, 0.001))
    start = int(onset_s / 0.001)
    env_db = env_db[start:]
    if len(env_db) < 20:
        return float("nan")
    peak_index = int(np.argmax(env_db[:200])) if len(env_db) > 0 else 0
    peak = env_db[peak_index]
    region = np.arange(peak_index, len(env_db))
    mask = (env_db[region] <= peak + high_db) & (env_db[region] >= peak + low_db)
    if mask.sum() < 10:
        return float("nan")
    t = region[mask] * 0.001
    slope, _ = np.polyfit(t, env_db[region][mask], 1)
    return float(slope)


def make_reference(samples: np.ndarray, rate: int) -> Reference:
    bounds = onset_offset(samples, rate) or (0.0, len(samples) / rate)
    start = int(bounds[0] * rate)
    head = samples[start:start + int(0.25 * rate)]
    frequency, tonal = dominant_frequency(head, rate)
    return Reference(
        rate=rate,
        samples=samples,
        frequency=frequency,
        tonal_fraction=tonal,
        onset_s=bounds[0],
        offset_s=bounds[1],
        decay_db_per_s=decay_slope_db_per_s(samples, rate, bounds[0]),
        envelope=rms_envelope(samples[start:], rate, 0.005, 0.001),
        thd_db=thd_db(head, rate, frequency) if np.isfinite(frequency) else float("nan"),
    )


def _wrap(phase: np.ndarray) -> np.ndarray:
    return (phase + np.pi) % (2 * np.pi) - np.pi


def sinusoid_track(x: np.ndarray, rate: int, frequency: float, frame_s: float = 0.005, hop_s: float = 0.0025):
    """Least-squares amplitude, phase and residual power of one sinusoid per frame."""
    frame = max(8, int(frame_s * rate))
    hop = max(1, int(hop_s * rate))
    t = np.arange(frame) / rate
    basis = np.stack([np.sin(2 * np.pi * frequency * t), np.cos(2 * np.pi * frequency * t), np.ones(frame)], axis=1)
    pinv = np.linalg.pinv(basis)
    starts = np.arange(0, max(0, len(x) - frame), hop)
    amps, phases, residual = [], [], []
    for s in starts:
        segment = x[s:s + frame]
        coeffs = pinv @ segment
        fit = basis @ coeffs
        amps.append(np.hypot(coeffs[0], coeffs[1]))
        phases.append(np.arctan2(coeffs[1], coeffs[0]) + 2 * np.pi * frequency * s / rate)
        residual.append(np.mean((segment - fit) ** 2))
    return starts / rate, np.array(amps), _wrap(np.array(phases)), np.array(residual)


def _events(times: np.ndarray, mask: np.ndarray, merge_s: float = 0.003) -> List[float]:
    out: List[float] = []
    for t in times[mask]:
        if not out or t - out[-1] > merge_s:
            out.append(float(round(t, 4)))
    return out


def residual_transients(residual: np.ndarray, rate: int, threshold_db: float = 12.0,
                        frame_s: float = 0.0005, local_s: float = 0.025) -> List[float]:
    """Impulsive energy in a residual (signal minus its steady model), relative to a local median,
    so steady content (harmonics, clipping distortion, noise) does not count as clicks."""
    frame = max(1, int(frame_s * rate))
    count = len(residual) // frame
    if count < 10:
        return []
    power = (residual[: count * frame].reshape(count, frame) ** 2).mean(axis=1)
    half = max(1, int(local_s / frame_s))
    padded = np.pad(power, half, mode="edge")
    windows = np.lib.stride_tricks.sliding_window_view(padded, 2 * half + 1)
    local = np.median(windows, axis=1)[:count]
    mask = power > np.maximum(local, 1e-20) * 10 ** (threshold_db / 10.0)
    return _events(np.arange(count) * frame_s, mask)


def high_band(x: np.ndarray, rate: int, cutoff_hz: float = 4000.0) -> np.ndarray:
    spectrum = np.fft.rfft(x)
    spectrum[np.fft.rfftfreq(len(x), 1.0 / rate) < cutoff_hz] = 0
    return np.fft.irfft(spectrum, len(x))


def tone_residual(x: np.ndarray, rate: int, frequency: float, frame_s: float = 0.005, harmonics: int = 4) -> np.ndarray:
    """Signal minus a per-frame least-squares fit of the tone, its harmonics, and DC."""
    frame = max(8, int(frame_s * rate))
    t = np.arange(frame) / rate
    orders = [k for k in range(1, harmonics + 1) if k * frequency < rate / 2]
    out = np.zeros_like(x)
    for s in range(0, len(x) - frame + 1, frame):
        tt = t + s / rate
        columns = [np.ones(frame)]
        for k in orders:
            columns += [np.sin(2 * np.pi * k * frequency * tt), np.cos(2 * np.pi * k * frequency * tt)]
        basis = np.stack(columns, axis=1)
        coeffs, *_ = np.linalg.lstsq(basis, x[s:s + frame], rcond=None)
        out[s:s + frame] = x[s:s + frame] - basis @ coeffs
    return out


def thd_db(x: np.ndarray, rate: int, frequency: float, harmonics: int = 5) -> float:
    """Harmonic distortion of the dominant tone; clipping raises it without moving the pitch."""
    n = 1 << int(np.ceil(np.log2(max(len(x), 16)) + 2))
    spectrum = np.abs(np.fft.rfft(x * np.hanning(len(x)), n)) ** 2
    freqs = np.fft.rfftfreq(n, 1.0 / rate)

    def band_power(f: float) -> float:
        near = np.abs(freqs - f) <= max(0.02 * f, 20.0)
        return float(spectrum[near].sum())

    fundamental = band_power(frequency)
    distortion = sum(band_power(k * frequency) for k in range(2, harmonics + 1) if k * frequency < rate / 2)
    return float(10 * np.log10((distortion + 1e-30) / (fundamental + 1e-30)))


def analyze_cue(segment: np.ndarray, rate: int, ref: Reference, thresholds: Thresholds) -> CueMetrics:
    """Measure one cue. ``segment`` should start a little before the expected onset."""
    bounds = onset_offset(segment, rate, detail=True)
    if bounds is None:
        return CueMetrics(found=False, symptoms=["missing_cue"])
    onset, offset, floor_db = bounds
    start = int(onset * rate)
    metrics = CueMetrics(found=True, onset_s=round(onset, 4))
    active = segment[start:int(offset * rate) + 1]
    metrics.level_db = float(20 * np.log10(np.sqrt(np.mean(active ** 2)) + 1e-12)) if len(active) else float("nan")
    metrics.recorder_clipped_fraction = float(np.mean(np.abs(active) >= 0.999)) if len(active) else 0.0

    head = segment[start:start + int(0.25 * rate)]
    frequency, tonal = dominant_frequency(head, rate)
    if np.isfinite(frequency) and np.isfinite(ref.frequency) and ref.frequency > 0:
        metrics.pitch_factor = frequency / ref.frequency
        metrics.pitch_confidence = float(min(tonal, ref.tonal_fraction))
        metrics.thd_db = thd_db(head, rate, frequency)
        metrics.thd_excess_db = metrics.thd_db - ref.thd_db
    trajectory = []
    window = int(0.05 * rate)
    env_peak = np.max(np.abs(head)) if len(head) else 0.0
    for s in range(start, start + int(0.4 * rate), int(0.025 * rate)):
        piece = segment[s:s + window]
        if len(piece) < window or np.max(np.abs(piece)) < env_peak * 0.03:
            break
        f, _ = dominant_frequency(piece, rate)
        trajectory.append(round(f / ref.frequency, 5))
    metrics.pitch_trajectory = trajectory
    if len(trajectory) >= 3:
        metrics.pitch_step = float(np.max(np.abs(np.array(trajectory) - np.median(trajectory))))

    seg_slope = decay_slope_db_per_s(segment, rate, onset)
    if np.isfinite(seg_slope) and np.isfinite(ref.decay_db_per_s) and seg_slope != 0:
        metrics.time_scale_decay = ref.decay_db_per_s / seg_slope
    metrics.time_scale_corr = _envelope_scale(segment[start:], rate, ref)
    ref_bounds = onset_offset(ref.samples, ref.rate, floor_db=floor_db)
    ref_duration = (ref_bounds[1] - ref_bounds[0]) if ref_bounds else ref.offset_s - ref.onset_s
    metrics.duration_floor_db = round(floor_db, 1)
    if ref_duration > 0:
        metrics.duration_ratio = (offset - onset) / ref_duration

    ref_tilt = _tilt_db(ref.samples, ref.rate)
    metrics.tilt_db = _tilt_db(active, rate) - ref_tilt if len(active) else float("nan")

    body_start = start + int(ATTACK_SKIP_S * rate)
    body_end = min(len(segment), int((offset + 0.02) * rate))
    body = segment[body_start:body_end]
    tonal_cue = np.isfinite(frequency) and ref.tonal_fraction >= thresholds.min_confidence
    if tonal_cue and len(body) > int(0.02 * rate):
        times, amps, phases, residual = sinusoid_track(body, rate, frequency)
        body_t0 = body_start / rate
        amp_peak = amps.max() if len(amps) else 0.0
        good = amps > amp_peak * 10 ** (-30 / 20.0)
        if good.sum() > 4:
            advance = _wrap(np.diff(phases))
            valid = good[1:] & good[:-1]
            bias = np.median(advance[valid])
            jumps = np.abs(_wrap(advance - bias)) > thresholds.phase_jump_rad
            metrics.phase_jumps = _events(times[1:] + body_t0, jumps & valid)
            ratio = residual / np.maximum(amps ** 2, 1e-20)
            strong = amps > amp_peak * 10 ** (-20 / 20.0)
            local = _running_median(ratio, 20)
            spikes = ratio > local * 10 ** (thresholds.residual_spike_db / 10.0)
            metrics.residual_spikes = _events(times + body_t0, spikes & strong)
            smooth = _decay_fit(times, amps, good)
            dips = (20 * np.log10(np.maximum(amps, 1e-12) / np.maximum(smooth, 1e-12)) < -thresholds.dip_db) & good
            metrics.dips = _events(times + body_t0, dips)
        steady = tone_residual(body, rate, frequency)
    else:
        steady = high_band(body, rate) if len(body) else body
    metrics.transients = [
        round(t + body_start / rate, 4)
        for t in residual_transients(steady, rate, threshold_db=thresholds.hf_transient_db)
    ]
    metrics.symptoms = classify(metrics, thresholds)
    return metrics


def _tilt_db(x: np.ndarray, rate: int) -> float:
    spectrum = np.abs(np.fft.rfft(x * np.hanning(len(x)))) ** 2
    freqs = np.fft.rfftfreq(len(x), 1.0 / rate)
    low = spectrum[(freqs >= 100) & (freqs < 800)].sum()
    high = spectrum[(freqs >= 2000) & (freqs < 8000)].sum()
    return float(10 * np.log10((high + 1e-20) / (low + 1e-20)))


def _running_median(values: np.ndarray, half: int) -> np.ndarray:
    if len(values) == 0:
        return values
    padded = np.pad(values, half, mode="edge")
    return np.median(np.lib.stride_tricks.sliding_window_view(padded, 2 * half + 1), axis=1)[: len(values)]


def _decay_fit(times: np.ndarray, amps: np.ndarray, good: np.ndarray) -> np.ndarray:
    """Smooth amplitude reference: a running median over 25 ms of good frames."""
    out = amps.copy()
    half = 5
    for i in range(len(amps)):
        lo, hi = max(0, i - half), min(len(amps), i + half + 1)
        window = amps[lo:hi][good[lo:hi]]
        out[i] = np.median(window) if len(window) else amps[i]
    return out


def _envelope_scale(x: np.ndarray, rate: int, ref: Reference) -> float:
    env = rms_envelope(x, rate, 0.005, 0.001)
    ref_env = ref.envelope
    length = min(len(env), int(len(ref_env) * 1.2))
    if length < 50:
        return float("nan")
    env = env[:length]
    best, best_scale = -np.inf, float("nan")
    ref_t = np.arange(len(ref_env))
    for scale in np.arange(0.85, 1.1501, 0.002):
        warped = np.interp(np.arange(length) / scale, ref_t, ref_env, right=0.0)
        denom = np.linalg.norm(warped) * np.linalg.norm(env)
        if denom <= 0:
            continue
        score = float(np.dot(warped, env) / denom)
        if score > best:
            best, best_scale = score, float(scale)
    return best_scale


def classify(metrics: CueMetrics, thresholds: Thresholds) -> List[str]:
    """Symptom labels from measured values; mechanism attribution happens elsewhere."""
    symptoms: List[str] = []
    if not metrics.found:
        return ["missing_cue"]
    if (np.isfinite(metrics.pitch_factor) and metrics.pitch_confidence >= thresholds.min_confidence
            and abs(metrics.pitch_factor - 1.0) > thresholds.pitch_deviation):
        symptoms.append("pitch_low" if metrics.pitch_factor < 1.0 else "pitch_high")
    if metrics.pitch_step > thresholds.pitch_deviation:
        symptoms.append("pitch_step")
    if np.isfinite(metrics.duration_ratio) and abs(metrics.duration_ratio - 1.0) > thresholds.duration_deviation:
        symptoms.append("duration_long" if metrics.duration_ratio > 1.0 else "duration_short")
    if metrics.phase_jumps or metrics.residual_spikes or metrics.transients:
        symptoms.append("discontinuity")
    if metrics.dips:
        symptoms.append("dip")
    if np.isfinite(metrics.thd_excess_db) and metrics.thd_excess_db > thresholds.distortion_excess_db:
        symptoms.append("distortion")
    return symptoms
