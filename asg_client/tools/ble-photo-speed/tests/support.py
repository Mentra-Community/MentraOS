"""Shared test helpers: import path, fixtures, a fake clock, and a scriptable fake adb."""

from __future__ import annotations

import datetime
import json
import shlex
import sys
from pathlib import Path
from typing import Callable, Dict, IO, List, Optional, Sequence, Tuple

TOOL_DIR = Path(__file__).resolve().parents[1]
FIXTURES = Path(__file__).resolve().parent / "fixtures"
if str(TOOL_DIR) not in sys.path:
    sys.path.insert(0, str(TOOL_DIR))

from blespeed.adbio import LineSource, ProcessResult, ProcessRunner  # noqa: E402


def fixture_text(name: str) -> str:
    return (FIXTURES / name).read_text()


def fixture_lines(name: str) -> List[str]:
    return [line for line in fixture_text(name).splitlines() if line.strip()]


class FakeClock:
    def __init__(self, start: float = 1000.0):
        self.t = start
        self.sleeps: List[float] = []

    def now(self) -> float:
        return self.t

    def sleep(self, seconds: float) -> None:
        self.sleeps.append(seconds)
        if seconds > 0:
            self.t += seconds

    def advance(self, seconds: float) -> None:
        self.t += seconds

    def wall(self) -> datetime.datetime:
        return datetime.datetime(2026, 9, 28, 8, 0, 0, tzinfo=datetime.timezone.utc)


class _ScheduledQueue:
    def __init__(self, clock: FakeClock):
        self.clock = clock
        self.items: List[Tuple[float, int, str]] = []
        self._seq = 0

    def schedule(self, delay: float, line: str) -> None:
        self._seq += 1
        self.items.append((self.clock.now() + delay, self._seq, line))
        self.items.sort()

    def pop_due(self) -> Optional[str]:
        if self.items and self.items[0][0] <= self.clock.now():
            return self.items.pop(0)[2]
        return None


class FakeSource(LineSource):
    """Returns scheduled lines once due; an empty poll advances the fake clock by ``timeout``."""

    def __init__(self, queue: _ScheduledQueue, sink: Optional[IO[str]],
                 keep: Optional[Callable[[str], bool]]):
        self.queue = queue
        self.sink = sink
        self.keep = keep
        self.closed = False

    def get(self, timeout: float) -> Optional[str]:
        for attempt in range(2):
            while True:
                line = self.queue.pop_due()
                if line is None:
                    break
                if self.keep is not None and not self.keep(line):
                    continue
                if self.sink is not None:
                    self.sink.write(line + "\n")
                return line
            if attempt == 0 and timeout > 0:
                self.queue.clock.advance(timeout)
            else:
                break
        return None

    def close(self) -> None:
        self.closed = True


# A photo response: list of (delay_seconds, line template). Templates may use {rid} and {img}.
Response = List[Tuple[float, str]]

GLASSES_PREFIX = "09-28 16:00:00.000  1310  1743 I %s: "


def glasses_line(tag: str, message: str) -> str:
    return (GLASSES_PREFIX % tag) + message


def finished_response(payload: int = 204800, phone_confirm_ms: int = 2500, uart_tx_ms: int = 2300,
                      speed: float = 87.0, drain_ms: int = 150, extra: Sequence[str] = (),
                      success: bool = True) -> Response:
    lines: Response = [
        (0.1, glasses_line("PhotoCommandHandler",
                           "PHOTO PIPELINE [ASG 2/3] PhotoCommandHandler.handleTakePhoto requestId={rid}")),
        (0.2, glasses_line("PhotoCommandHandler", "PHOTO PIPELINE [ASG 3/3] Capture accepted requestId={rid}")),
    ]
    lines.extend((1.0, glasses_line("K900BluetoothManager", e)) for e in extra)
    lines.append((3.0, glasses_line(
        "BlePhotoTiming",
        "⏱️ [BLE PHOTO] PIPELINE FINISHED | requestId={rid} | bleImgId={img} | success=%s"
        " | total=4000ms | encode_calls=1 | encode_total_ms=80 | original=250000 bytes (244.1KB)"
        " | payload=%d bytes (%.1fKB) | uart_tx=%dms | transfer_speed=%.1fKB/s"
        " | phone_confirm=%dms | phone_ack_wait=%dms | last_packet_to_phone_ack=%dms"
        " | camera=600ms, compress=250ms, ble_to_phone_confirm=%dms"
        % ("true" if success else "false", payload, payload / 1024.0, uart_tx_ms, speed,
           phone_confirm_ms, phone_confirm_ms - uart_tx_ms, drain_ms, phone_confirm_ms))))
    return lines


def busy_response(code: str = "BLE_TRANSFER_BUSY") -> Response:
    return [
        (0.1, glasses_line("PhotoCommandHandler",
                           "PHOTO PIPELINE [ASG 2/3] PhotoCommandHandler.handleTakePhoto requestId={rid}")),
        (0.2, glasses_line("MediaCaptureService",
                           "📸 SENDING PHOTO ERROR: %s - BLE transfer in progress - request rejected"
                           " for requestId: {rid}" % code)),
    ]


def received_only_response() -> Response:
    return [(0.1, glasses_line(
        "PhotoCommandHandler",
        "PHOTO PIPELINE [ASG 2/3] PhotoCommandHandler.handleTakePhoto requestId={rid}"))]


DEFAULT_DEVICES = "List of devices attached\nG1\tdevice\nP1\tdevice\n\n"
DEFAULT_DUMP = "\n".join([
    glasses_line("K900BluetoothManager", "✅ BES firmware version cached successfully: 17.26.7.5"),
    glasses_line("BAUD-SWITCH", "Serial port opened at 1152000 baud"),
    glasses_line("BES-UART", "UART link ready at fast baud 1152000"),
]) + "\n"


class FakeAdb(ProcessRunner):
    """Scriptable stand-in for adb and idevicesyslog.

    Each take_photo broadcast (including busy resends) consumes the next response
    from ``photo_responses``. Phone log lines in ``phone_lines`` are released
    when the phone stream opens.
    """

    def __init__(self, clock: FakeClock, photo_responses: Sequence[Response] = (),
                 devices: str = DEFAULT_DEVICES, dump: str = DEFAULT_DUMP,
                 battery: str = "Current Battery Service state:\n  level: 87\n",
                 package: str = "    versionCode=1234 minSdk=28\n    versionName=3.1.0-dev.40\n"
                                "    lastUpdateTime=2026-09-28 15:00:00\n",
                 phone_lines: Sequence[Tuple[float, str]] = (),
                 getprop: Optional[Dict[str, str]] = None):
        self.clock = clock
        self.responses = list(photo_responses)
        self.devices = devices
        self.dump = dump
        self.battery = battery
        self.package = package
        self.phone_lines = list(phone_lines)
        self.getprop = getprop or {"ro.product.model": "Pixel 8", "ro.build.version.release": "16"}
        self.calls: List[List[str]] = []
        self.broadcasts: List[Dict[str, object]] = []
        self.glasses_queue = _ScheduledQueue(clock)
        self.phone_queue = _ScheduledQueue(clock)
        self.sources: List[FakeSource] = []

    def run(self, args: Sequence[str], timeout: float = 30.0) -> ProcessResult:
        args = list(args)
        self.calls.append(args)
        if args == ["adb", "devices"]:
            return ProcessResult(0, self.devices)
        if args[:1] == ["ideviceinfo"]:
            key = args[-1]
            return ProcessResult(0, {"ProductType": "iPhone16,1", "ProductVersion": "26.0"}[key] + "\n")
        if args[:1] != ["adb"] or len(args) < 4:
            return ProcessResult(1, "", "unexpected command")
        rest = args[3:]
        if rest[:3] == ["logcat", "-d", "-v"]:
            return ProcessResult(0, self.dump)
        if rest == ["shell", "dumpsys", "battery"]:
            return ProcessResult(0, self.battery)
        if rest[:3] == ["shell", "dumpsys", "package"]:
            return ProcessResult(0, self.package)
        if rest[:2] == ["shell", "getprop"]:
            return ProcessResult(0, self.getprop.get(rest[2], "") + "\n")
        if rest[0] == "shell" and rest[1].startswith("am broadcast"):
            remote = shlex.split(rest[1])
            payload = json.loads(remote[remote.index("--es") + 2])
            self.broadcasts.append(payload)
            if payload.get("type") == "take_photo":
                response = self.responses.pop(0) if self.responses else []
                for delay, template in response:
                    self.glasses_queue.schedule(delay, template.format(
                        rid=payload["requestId"], img=payload["bleImgId"]))
            return ProcessResult(0, "Broadcasting: Intent\nBroadcast completed: result=0\n")
        return ProcessResult(1, "", "unexpected adb command: %s" % " ".join(args))

    def stream(self, args, sink=None, keep=None) -> LineSource:
        args = list(args)
        self.calls.append(args)
        is_glasses = args[:3] == ["adb", "-s", "G1"]
        queue = self.glasses_queue if is_glasses else self.phone_queue
        if not is_glasses:
            for delay, line in self.phone_lines:
                queue.schedule(delay, line)
        source = FakeSource(queue, sink, keep)
        self.sources.append(source)
        return source

    @property
    def photo_broadcasts(self) -> List[Dict[str, object]]:
        return [b for b in self.broadcasts if b.get("type") == "take_photo"]
