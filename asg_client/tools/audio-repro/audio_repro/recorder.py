"""Continuous acoustic recording through an external command.

Use a measurement microphone with AGC, noise suppression and EQ disabled. The recorder only
starts and stops the process and records host CLOCK_MONOTONIC bounds around process start; the
analysis aligns audio to device events by onset cross-correlation, so these bounds are coarse.
"""

from __future__ import annotations

import shlex
import shutil
import signal
import subprocess
import sys
import time
from pathlib import Path
from typing import List, Optional


def default_command(rate: int, channels: int) -> Optional[str]:
    if shutil.which("arecord"):
        return "arecord -q -f S24_3LE -r {rate} -c {channels} -t wav {out}"
    if shutil.which("sox"):
        return "sox -q -d -r {rate} -c {channels} -b 24 {out}"
    if sys.platform == "darwin" and shutil.which("ffmpeg"):
        return "ffmpeg -loglevel error -f avfoundation -i :0 -ar {rate} -ac {channels} -c:a pcm_s24le {out}"
    return None


class Recorder:
    def __init__(self, out_path: Path, rate: int = 48000, channels: int = 1, command: Optional[str] = None):
        self.out_path = out_path
        self.rate = rate
        self.channels = channels
        template = command or default_command(rate, channels)
        if template is None:
            raise RuntimeError("no recorder found; install arecord/sox/ffmpeg or pass --record-cmd")
        self.template = template
        self.argv: List[str] = shlex.split(template.format(rate=rate, channels=channels, out=shlex.quote(str(out_path))))
        self.process: Optional[subprocess.Popen] = None
        self.start_before_ns = 0
        self.start_after_ns = 0
        self.stop_ns = 0

    def start(self) -> None:
        self.out_path.parent.mkdir(parents=True, exist_ok=True)
        self.start_before_ns = time.monotonic_ns()
        self.process = subprocess.Popen(self.argv, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        self.start_after_ns = time.monotonic_ns()
        time.sleep(0.5)
        if self.process.poll() is not None:
            err = self.process.stderr.read().decode(errors="replace") if self.process.stderr else ""
            raise RuntimeError(f"recorder exited immediately: {err.strip()}")

    def stop(self) -> None:
        if not self.process:
            return
        self.stop_ns = time.monotonic_ns()
        if self.process.poll() is None:
            if self.argv[0] == "ffmpeg" and self.process.stdin:
                try:
                    self.process.stdin.write(b"q")
                    self.process.stdin.flush()
                except OSError:
                    pass
            else:
                self.process.send_signal(signal.SIGINT)
            try:
                self.process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.process.terminate()
                self.process.wait(timeout=5)

    def describe(self) -> dict:
        return {
            "path": str(self.out_path),
            "rate": self.rate,
            "channels": self.channels,
            "command": self.template,
            "host_start_before_ns": self.start_before_ns,
            "host_start_after_ns": self.start_after_ns,
            "host_stop_ns": self.stop_ns,
        }
