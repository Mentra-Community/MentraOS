"""Minimal WAV reading/writing with numpy (PCM 16/24/32-bit, float32, extensible).

Tolerates the placeholder chunk sizes written by recorders that were stopped abruptly or are
still writing, by reading to the end of the file.
"""

from __future__ import annotations

import struct
from pathlib import Path
from typing import Optional, Tuple

import numpy as np


def _parse_header(data: bytes) -> Tuple[int, int, int, int, int]:
    """Return (format_tag, channels, rate, bits, data_offset)."""
    if data[:4] != b"RIFF" or data[8:12] != b"WAVE":
        raise ValueError("not a RIFF/WAVE file")
    pos = 12
    fmt = None
    while pos + 8 <= len(data):
        chunk_id = data[pos:pos + 4]
        size = struct.unpack("<I", data[pos + 4:pos + 8])[0]
        body = pos + 8
        if chunk_id == b"fmt ":
            tag, channels, rate, _, _, bits = struct.unpack("<HHIIHH", data[body:body + 16])
            if tag == 0xFFFE and size >= 40:
                tag = struct.unpack("<H", data[body + 24:body + 26])[0]
            fmt = (tag, channels, rate, bits)
        elif chunk_id == b"data":
            if fmt is None:
                raise ValueError("data chunk before fmt chunk")
            return fmt[0], fmt[1], fmt[2], fmt[3], body
        pos = body + size + (size & 1)
    raise ValueError("no data chunk")


def read_wav(path: Path, mono: bool = True, max_seconds: Optional[float] = None) -> Tuple[np.ndarray, int]:
    raw = Path(path).read_bytes()
    tag, channels, rate, bits, offset = _parse_header(raw)
    payload = raw[offset:]
    width = bits // 8
    frame = width * channels
    usable = len(payload) - len(payload) % frame
    if max_seconds is not None:
        usable = min(usable, int(max_seconds * rate) * frame)
    payload = payload[:usable]
    if tag == 3 and bits == 32:
        samples = np.frombuffer(payload, dtype="<f4").astype(np.float64)
    elif tag == 1 and bits == 16:
        samples = np.frombuffer(payload, dtype="<i2").astype(np.float64) / 32768.0
    elif tag == 1 and bits == 24:
        b = np.frombuffer(payload, dtype=np.uint8).reshape(-1, 3).astype(np.int32)
        value = b[:, 0] | (b[:, 1] << 8) | (b[:, 2] << 16)
        value = np.where(value & 0x800000, value - 0x1000000, value)
        samples = value.astype(np.float64) / 8388608.0
    elif tag == 1 and bits == 32:
        samples = np.frombuffer(payload, dtype="<i4").astype(np.float64) / 2147483648.0
    else:
        raise ValueError(f"unsupported WAV format tag={tag} bits={bits}")
    samples = samples.reshape(-1, channels)
    if mono:
        return samples.mean(axis=1), rate
    return samples, rate


def write_wav(path: Path, samples: np.ndarray, rate: int) -> None:
    """Write mono or multichannel float samples as 16-bit PCM."""
    data = np.asarray(samples, dtype=np.float64)
    if data.ndim == 1:
        data = data[:, None]
    pcm = (np.clip(data, -1.0, 1.0) * 32767.0).round().astype("<i2")
    body = pcm.tobytes()
    channels = data.shape[1]
    header = b"RIFF" + struct.pack("<I", 36 + len(body)) + b"WAVE"
    header += b"fmt " + struct.pack("<IHHIIHH", 16, 1, channels, rate, rate * channels * 2, channels * 2, 16)
    header += b"data" + struct.pack("<I", len(body))
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Path(path).write_bytes(header + body)


def resample(x: np.ndarray, src_rate: float, dst_rate: float) -> np.ndarray:
    """Band-limited FFT resampling; ``dst_rate/src_rate`` need not be rational."""
    n_in = len(x)
    n_out = int(round(n_in * dst_rate / src_rate))
    if n_out == n_in:
        return x.copy()
    pad = 1 << int(np.ceil(np.log2(max(n_in, 2))))
    spectrum = np.fft.rfft(x, pad)
    pad_out = int(round(pad * dst_rate / src_rate))
    out_bins = pad_out // 2 + 1
    resized = np.zeros(out_bins, dtype=complex)
    keep = min(out_bins, len(spectrum))
    resized[:keep] = spectrum[:keep]
    y = np.fft.irfft(resized, pad_out) * (pad_out / pad)
    return y[:n_out]
