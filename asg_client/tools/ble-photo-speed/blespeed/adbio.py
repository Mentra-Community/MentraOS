"""adb command construction and an injectable process runner.

Broadcasts must be directed with ``-p com.mentra.asg_client``: Android's
background broadcast limits silently drop undirected ones on Mentra Live
(see asg_client/scripts/fps-thermal-test.sh).
"""

from __future__ import annotations

import json
import queue
import re
import shlex
import subprocess
import threading
import time
from dataclasses import dataclass
from typing import Callable, Dict, IO, List, Optional, Sequence

ASG_PACKAGE = "com.mentra.asg_client"
SEND_COMMAND_ACTION = "com.mentra.asg_client.ACTION_SEND_COMMAND"

# The K900 file packet header holds at most 16 characters of file name, extension included.
MAX_BLE_IMG_ID_LEN = 11


class AdbError(RuntimeError):
    pass


@dataclass(frozen=True)
class ProcessResult:
    returncode: int
    stdout: str
    stderr: str = ""


class LineSource:
    """A stream of text lines that can be polled with a timeout."""

    def get(self, timeout: float) -> Optional[str]:
        raise NotImplementedError

    def close(self) -> None:
        pass


class ProcessRunner:
    """Runs one-shot commands and opens streaming commands."""

    def run(self, args: Sequence[str], timeout: float = 30.0) -> ProcessResult:
        raise NotImplementedError

    def stream(self, args: Sequence[str], sink: Optional[IO[str]] = None,
               keep: Optional[Callable[[str], bool]] = None) -> LineSource:
        raise NotImplementedError


class _PopenLineSource(LineSource):
    def __init__(self, proc: "subprocess.Popen[str]", sink: Optional[IO[str]],
                 keep: Optional[Callable[[str], bool]]):
        self._proc = proc
        self._queue: "queue.Queue[str]" = queue.Queue()
        self._sink = sink
        self._keep = keep
        self._thread = threading.Thread(target=self._pump, daemon=True)
        self._thread.start()

    def _pump(self) -> None:
        assert self._proc.stdout is not None
        for raw in self._proc.stdout:
            line = raw.rstrip("\r\n")
            if self._keep is not None and not self._keep(line):
                continue
            if self._sink is not None:
                self._sink.write(line + "\n")
                self._sink.flush()
            self._queue.put(line)

    def get(self, timeout: float) -> Optional[str]:
        try:
            return self._queue.get(timeout=max(0.0, timeout))
        except queue.Empty:
            return None

    def close(self) -> None:
        if self._proc.poll() is None:
            self._proc.terminate()
            try:
                self._proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self._proc.kill()
                self._proc.wait(timeout=5)
        self._thread.join(timeout=5)
        if self._proc.stdout is not None:
            self._proc.stdout.close()


class SubprocessRunner(ProcessRunner):
    def run(self, args: Sequence[str], timeout: float = 30.0) -> ProcessResult:
        try:
            done = subprocess.run(list(args), capture_output=True, text=True, timeout=timeout,
                                  errors="replace")
        except FileNotFoundError as e:
            raise AdbError("command not found: %s" % args[0]) from e
        except subprocess.TimeoutExpired as e:
            raise AdbError("command timed out after %ss: %s" % (timeout, " ".join(args))) from e
        return ProcessResult(done.returncode, done.stdout, done.stderr)

    def stream(self, args: Sequence[str], sink: Optional[IO[str]] = None,
               keep: Optional[Callable[[str], bool]] = None) -> LineSource:
        try:
            proc = subprocess.Popen(list(args), stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                    text=True, errors="replace", bufsize=1)
        except FileNotFoundError as e:
            raise AdbError("command not found: %s" % args[0]) from e
        return _PopenLineSource(proc, sink, keep)


def check_ok(result: ProcessResult, what: str) -> str:
    if result.returncode != 0:
        detail = (result.stderr or result.stdout).strip()
        raise AdbError("%s failed (exit %d): %s" % (what, result.returncode, detail))
    return result.stdout


def adb(serial: str, *args: str) -> List[str]:
    return ["adb", "-s", serial, *args]


def broadcast_args(serial: str, payload: Dict[str, object]) -> List[str]:
    """``adb -s <serial> shell "am broadcast ... -p <pkg> --es json '<json>'"``."""
    body = json.dumps(payload, separators=(",", ":"), ensure_ascii=True)
    remote = "am broadcast -a %s -p %s --es json %s" % (
        SEND_COMMAND_ACTION, ASG_PACKAGE, shlex.quote(body))
    return adb(serial, "shell", remote)


def take_photo_payload(request_id: str, ble_img_id: str, size: str, mode: str = "photo",
                       compress: str = "none") -> Dict[str, object]:
    if not ble_img_id or len(ble_img_id) > MAX_BLE_IMG_ID_LEN:
        raise ValueError("bleImgId must be 1-%d characters: %r" % (MAX_BLE_IMG_ID_LEN, ble_img_id))
    return {
        "type": "take_photo",
        "requestId": request_id,
        "bleImgId": ble_img_id,
        "transferMethod": "ble",
        "size": size,
        "mode": mode,
        "compress": compress,
        "save": False,
        "sound": False,
        "flash": False,
    }


def disconnect_wifi_payload() -> Dict[str, object]:
    return {"type": "disconnect_wifi"}


class BleImgIdGenerator:
    """Unique ``I`` + 9 digit ids, the same shape the Mentra App generates."""

    def __init__(self, seed: Optional[int] = None):
        if seed is None:
            seed = int(time.time() * 1000) % 100_000_000
        self._next = seed

    def __call__(self) -> str:
        value = self._next % 1_000_000_000
        self._next += 1
        return "I%09d" % value


@dataclass(frozen=True)
class AdbDevice:
    serial: str
    state: str


def parse_adb_devices(output: str) -> List[AdbDevice]:
    devices = []
    for line in output.splitlines():
        line = line.strip()
        if not line or line.startswith("List of devices") or line.startswith("*"):
            continue
        parts = line.split()
        if len(parts) >= 2:
            devices.append(AdbDevice(parts[0], parts[1]))
    return devices


def resolve_glasses_serial(devices: Sequence[AdbDevice], requested: Optional[str]) -> str:
    """Return the glasses serial, mirroring the thermal script's ``adb_one`` guard.

    Without ``requested`` exactly one attached device must be in ``device`` state.
    With it, that serial must be present and ready.
    """
    if requested:
        for device in devices:
            if device.serial == requested:
                if device.state != "device":
                    raise AdbError("adb device %s is %s, not ready" % (requested, device.state))
                return requested
        raise AdbError("adb device %s not found (attached: %s)" % (
            requested, ", ".join(d.serial for d in devices) or "none"))
    ready = [d for d in devices if d.state == "device"]
    not_ready = [d for d in devices if d.state != "device"]
    if len(ready) == 1 and not not_ready:
        return ready[0].serial
    listing = ", ".join("%s(%s)" % (d.serial, d.state) for d in devices) or "none"
    raise AdbError("need exactly 1 ready adb device or --glasses-serial; found: %s" % listing)


def parse_battery_level(dumpsys_battery: str) -> Optional[int]:
    for line in dumpsys_battery.splitlines():
        key, sep, value = line.strip().partition(":")
        if sep and key.strip() == "level":
            try:
                return int(value.strip())
            except ValueError:
                return None
    return None


_PACKAGE_FIELD_RES = {
    "versionName": re.compile(r"versionName=(\S+)"),
    "versionCode": re.compile(r"versionCode=(\d+)"),
    "lastUpdateTime": re.compile(r"lastUpdateTime=(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})"),
}


def parse_package_versions(dumpsys_package: str) -> Dict[str, str]:
    found: Dict[str, str] = {}
    for key, pattern in _PACKAGE_FIELD_RES.items():
        match = pattern.search(dumpsys_package)
        if match:
            found[key] = match.group(1)
    return found
