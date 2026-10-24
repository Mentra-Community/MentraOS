"""Follow device logcat, keep a full copy, and surface harness lines with host receive times."""

from __future__ import annotations

import json
import queue
import re
import subprocess
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Optional

PREFIX = "AUDIO_REPRO "
_KV_RE = re.compile(r"(\w+)=(\S*)")


@dataclass
class HarnessLine:
    host_ns: int
    kind: str
    fields: Dict[str, str]
    text: str


def parse_harness_line(text: str) -> Optional[HarnessLine]:
    """Parse ``AUDIO_REPRO [run=<id>] <kind> k=v ...``; returns None for other lines."""
    index = text.find(PREFIX)
    if index < 0:
        return None
    tokens = text[index + len(PREFIX):].split()
    kind = ""
    for token in tokens:
        if "=" not in token:
            kind = token
            break
    fields = dict(_KV_RE.findall(text[index + len(PREFIX):]))
    return HarnessLine(host_ns=0, kind=kind, fields=fields, text=text.rstrip("\n"))


class LogcatFollower:
    def __init__(self, base_cmd: List[str], out_path: Path, sync_path: Path):
        self.base_cmd = base_cmd
        self.out_path = out_path
        self.sync_path = sync_path
        self.lines: "queue.Queue[HarnessLine]" = queue.Queue()
        self.process: Optional[subprocess.Popen] = None
        self.thread: Optional[threading.Thread] = None

    def start(self) -> None:
        self.out_path.parent.mkdir(parents=True, exist_ok=True)
        self.process = subprocess.Popen(
            self.base_cmd + ["logcat", "-v", "monotonic", "-T", "1"],
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            errors="replace",
        )
        self.thread = threading.Thread(target=self._pump, daemon=True)
        self.thread.start()

    def _pump(self) -> None:
        assert self.process and self.process.stdout
        with self.out_path.open("a") as out, self.sync_path.open("a") as sync:
            for text in self.process.stdout:
                host_ns = time.monotonic_ns()
                out.write(text)
                parsed = parse_harness_line(text)
                if parsed is None:
                    continue
                parsed.host_ns = host_ns
                sync.write(json.dumps({"host_ns": host_ns, "kind": parsed.kind, "fields": parsed.fields, "text": parsed.text}) + "\n")
                sync.flush()
                self.lines.put(parsed)

    def stop(self) -> None:
        if self.process and self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.kill()
