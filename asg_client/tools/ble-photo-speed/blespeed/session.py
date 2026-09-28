"""Run one experiment cell: N sequential BLE photos for one phone/condition/size.

All I/O goes through an injected ``ProcessRunner`` and ``Clock`` so the whole
flow runs offline in tests against a fake adb.
"""

from __future__ import annotations

import datetime
import json
import platform
import shlex
import time
import uuid
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import IO, Callable, Dict, List, Optional

from . import adbio
from .adbio import AdbError, LineSource, ProcessRunner
from .logparse import BaudChange, GlassesState, parse_line, scan_glasses_log
from .outcome import DONE, RESEND, PhotoTracker, TrackerConfig
from .results import PhotoRow, row_from_tracker, write_rows
from .transport import TransportTracker, keep_phone_line

REQUIRED_BAUD = 1152000
CONDITIONS = ("A", "B", "C", "D")
SIZES = ("medium", "max")
PHONE_OSES = ("ios", "android")
POLL_S = 0.25


class SessionAborted(RuntimeError):
    pass


class Clock:
    def now(self) -> float:
        return time.monotonic()

    def sleep(self, seconds: float) -> None:
        if seconds > 0:
            time.sleep(seconds)

    def wall(self) -> datetime.datetime:
        return datetime.datetime.now(datetime.timezone.utc)


@dataclass
class CellConfig:
    phone: str
    phone_os: str
    condition: str
    size: str
    out_root: Path
    count: int = 10
    glasses_serial: Optional[str] = None
    phone_serial: Optional[str] = None
    phone_udid: Optional[str] = None
    warmup: bool = True
    disconnect_wifi: bool = True
    wait_transport_s: float = 0.0
    allow_unknown_baud: bool = False
    required_baud: int = REQUIRED_BAUD
    settle_s: float = 2.0
    tracker: TrackerConfig = field(default_factory=TrackerConfig)
    bes_fw: Optional[str] = None
    app_build: Optional[str] = None
    asg_commit: Optional[str] = None
    notes: str = ""
    run_id: Optional[str] = None

    def validate(self) -> None:
        if self.phone_os not in PHONE_OSES:
            raise ValueError("phone_os must be one of %s" % ", ".join(PHONE_OSES))
        if self.condition not in CONDITIONS:
            raise ValueError("condition must be one of %s" % ", ".join(CONDITIONS))
        if self.size not in SIZES:
            raise ValueError("size must be one of %s" % ", ".join(SIZES))
        if self.count < 1:
            raise ValueError("count must be at least 1")
        if not self.phone or any(c in self.phone for c in "/ \\"):
            raise ValueError("phone label must be non-empty without spaces or slashes")
        if self.phone_os == "ios" and self.phone_serial:
            raise ValueError("--phone-serial is for Android phones; use --phone-udid for iOS")
        if self.phone_os == "android" and self.phone_udid:
            raise ValueError("--phone-udid is for iOS phones; use --phone-serial for Android")


@dataclass
class CellResult:
    run_dir: Path
    rows: List[PhotoRow]
    provenance: Dict[str, object]
    aborted: Optional[str] = None


def _request_id(tag: str, config: CellConfig, index: int, warmup: bool) -> str:
    slot = "w%02d" % index if warmup else "%03d" % index
    return "bspd-%s-%s%s-%s" % (tag, config.condition, config.size[:3], slot)


def photo_plan(config: CellConfig, id_gen: Callable[[], str], tag: str):
    """Yield (index, warmup, request_id, ble_img_id) for every photo in the cell."""
    if config.warmup:
        yield 0, True, _request_id(tag, config, 0, True), id_gen()
    for index in range(1, config.count + 1):
        yield index, False, _request_id(tag, config, index, False), id_gen()


def dry_run_commands(config: CellConfig, id_gen: Callable[[], str],
                     tag: str = "dryrun") -> List[List[str]]:
    """Every adb/idevicesyslog command a real run would issue, without executing any."""
    config.validate()
    glasses = config.glasses_serial or "<glasses-serial>"
    commands = [
        ["adb", "devices"],
        adbio.adb(glasses, "logcat", "-d", "-v", "threadtime"),
        adbio.adb(glasses, "shell", "dumpsys", "battery"),
        adbio.adb(glasses, "shell", "dumpsys", "package", adbio.ASG_PACKAGE),
        adbio.adb(glasses, "logcat", "-v", "threadtime", "-T", "1"),
    ]
    stream = _phone_stream_args(config)
    if stream:
        commands.append(stream)
    if config.disconnect_wifi:
        commands.append(adbio.broadcast_args(glasses, adbio.disconnect_wifi_payload()))
    for _index, _warmup, request_id, ble_img_id in photo_plan(config, id_gen, tag):
        payload = adbio.take_photo_payload(request_id, ble_img_id, config.size)
        commands.append(adbio.broadcast_args(glasses, payload))
    return commands


def _phone_stream_args(config: CellConfig) -> Optional[List[str]]:
    if config.phone_os == "android" and config.phone_serial:
        return adbio.adb(config.phone_serial, "logcat", "-v", "threadtime", "-T", "1")
    if config.phone_os == "ios" and config.phone_udid:
        return ["idevicesyslog", "-u", config.phone_udid]
    return None


class _NullSource(LineSource):
    def get(self, timeout: float) -> Optional[str]:
        return None


def _try_run(runner: ProcessRunner, args: List[str], timeout: float = 15.0) -> Optional[str]:
    try:
        result = runner.run(args, timeout=timeout)
    except AdbError:
        return None
    return result.stdout if result.returncode == 0 else None


class CellSession:
    def __init__(self, config: CellConfig, runner: ProcessRunner, clock: Optional[Clock] = None,
                 id_gen: Optional[Callable[[], str]] = None, log: Callable[[str], None] = print):
        config.validate()
        self.config = config
        self.runner = runner
        self.clock = clock or Clock()
        self.id_gen = id_gen or adbio.BleImgIdGenerator()
        self.log = log
        self.glasses_state = GlassesState()
        self.transport = TransportTracker()
        self.baud_changes: List[Dict[str, object]] = []
        self.rows: List[PhotoRow] = []
        self._glasses: LineSource = _NullSource()
        self._phone: LineSource = _NullSource()
        self._open_files: List[IO[str]] = []
        self.glasses_serial = ""

    # ----- setup -------------------------------------------------------------------------

    def _resolve_devices(self) -> None:
        output = adbio.check_ok(self.runner.run(["adb", "devices"], timeout=15), "adb devices")
        devices = adbio.parse_adb_devices(output)
        self.glasses_serial = adbio.resolve_glasses_serial(devices, self.config.glasses_serial)
        if self.config.phone_os == "android" and self.config.phone_serial:
            if self.config.phone_serial == self.glasses_serial:
                raise AdbError("--phone-serial must differ from the glasses serial")
            adbio.resolve_glasses_serial(devices, self.config.phone_serial)

    def _probe(self) -> Dict[str, object]:
        g = self.glasses_serial
        dump = adbio.check_ok(
            self.runner.run(adbio.adb(g, "logcat", "-d", "-v", "threadtime"), timeout=60),
            "glasses logcat dump")
        self.glasses_state = scan_glasses_log(dump)
        battery = _try_run(self.runner, adbio.adb(g, "shell", "dumpsys", "battery"))
        package = _try_run(self.runner, adbio.adb(g, "shell", "dumpsys", "package",
                                                  adbio.ASG_PACKAGE))
        versions = adbio.parse_package_versions(package or "")
        return {
            "serial": g,
            "asg_version_name": versions.get("versionName"),
            "asg_version_code": versions.get("versionCode"),
            "asg_last_update": versions.get("lastUpdateTime"),
            "asg_commit": self.config.asg_commit,
            "battery_pct_start": adbio.parse_battery_level(battery or ""),
        }

    def _phone_info(self) -> Dict[str, object]:
        c = self.config
        info: Dict[str, object] = {"label": c.phone, "os": c.phone_os, "serial": c.phone_serial,
                                   "udid": c.phone_udid, "model": None, "os_version": None}
        if c.phone_os == "android" and c.phone_serial:
            info["model"] = (_try_run(self.runner, adbio.adb(
                c.phone_serial, "shell", "getprop", "ro.product.model")) or "").strip() or None
            info["os_version"] = (_try_run(self.runner, adbio.adb(
                c.phone_serial, "shell", "getprop", "ro.build.version.release")) or "").strip() or None
        elif c.phone_os == "ios" and c.phone_udid:
            info["model"] = (_try_run(self.runner, [
                "ideviceinfo", "-u", c.phone_udid, "-k", "ProductType"]) or "").strip() or None
            info["os_version"] = (_try_run(self.runner, [
                "ideviceinfo", "-u", c.phone_udid, "-k", "ProductVersion"]) or "").strip() or None
        return info

    def _check_baud(self) -> None:
        baud = self.glasses_state.baud
        if baud == self.config.required_baud:
            return
        if baud is None and self.config.allow_unknown_baud:
            self.log("WARNING: no UART baud line in the glasses log; continuing (--allow-unknown-baud)")
            return
        if baud is None:
            raise SessionAborted(
                "no UART baud line in the glasses log buffer; reconnect the glasses or rerun with"
                " --allow-unknown-baud")
        raise SessionAborted("UART is at %d baud, need %d" % (baud, self.config.required_baud))

    def _open_streams(self, run_dir: Path) -> None:
        glasses_log = (run_dir / "glasses-logcat.txt").open("w")
        self._open_files.append(glasses_log)
        self._glasses = self.runner.stream(
            adbio.adb(self.glasses_serial, "logcat", "-v", "threadtime", "-T", "1"),
            sink=glasses_log)
        args = _phone_stream_args(self.config)
        if args:
            phone_log = (run_dir / "phone-log.txt").open("w")
            self._open_files.append(phone_log)
            self._phone = self.runner.stream(args, sink=phone_log, keep=keep_phone_line)

    def _close_streams(self) -> None:
        for source in (self._glasses, self._phone):
            try:
                source.close()
            except Exception:  # noqa: BLE001 - teardown must not mask the real result
                pass
        for handle in self._open_files:
            handle.close()
        self._open_files = []

    # ----- photo loop --------------------------------------------------------------------

    def _broadcast(self, payload: Dict[str, object]) -> None:
        adbio.check_ok(self.runner.run(adbio.broadcast_args(self.glasses_serial, payload),
                                       timeout=15), "am broadcast %s" % payload.get("type"))

    def _drain_phone(self) -> None:
        while True:
            line = self._phone.get(0)
            if line is None:
                return
            self.transport.feed(line)

    def _feed_glasses_line(self, line: str):
        event = parse_line(line)
        self.glasses_state.feed(event)
        if isinstance(event, BaudChange):
            self.baud_changes.append({"baud": event.baud, "source": event.source})
            if event.baud != self.config.required_baud:
                raise SessionAborted("UART baud changed to %d mid-session" % event.baud)
        return event

    def _wait_for_transport(self) -> None:
        deadline = self.clock.now() + self.config.wait_transport_s
        if self.config.wait_transport_s > 0:
            self.log("Waiting up to %.0fs for the phone to open L2CAP (connect it now)..."
                     % self.config.wait_transport_s)
        while self.clock.now() < deadline and not self.transport.l2cap_ready_or_gatt:
            line = self._glasses.get(POLL_S)
            if line is not None:
                self._feed_glasses_line(line)
            self._drain_phone()
        self.log("Transport: %s" % self.transport.current)

    def _take_photo(self, request_id: str, ble_img_id: str) -> PhotoTracker:
        tracker = PhotoTracker(request_id, ble_img_id, self.config.tracker)
        payload = adbio.take_photo_payload(request_id, ble_img_id, self.config.size)
        self._broadcast(payload)
        tracker.on_sent(self.clock.now())
        while True:
            line = self._glasses.get(POLL_S)
            now = self.clock.now()
            if line is not None:
                action = tracker.feed(self._feed_glasses_line(line), now)
            else:
                action = tracker.poll(now)
            self._drain_phone()
            if action == RESEND:
                self._broadcast(payload)
                tracker.on_sent(self.clock.now())
            elif action == DONE:
                return tracker

    # ----- entry point -------------------------------------------------------------------

    def run(self) -> CellResult:
        c = self.config
        wall = self.clock.wall()
        tag = uuid.uuid4().hex[:6]
        run_id = c.run_id or "%s-%s-%s-%s" % (wall.strftime("%Y%m%dT%H%M%SZ"), c.phone,
                                               c.condition, c.size)
        run_dir = c.out_root / run_id
        run_dir.mkdir(parents=True, exist_ok=False)
        provenance: Dict[str, object] = {
            "run_id": run_id,
            "created_at": wall.isoformat(),
            "condition": c.condition,
            "size": c.size,
            "count": c.count,
            "app_build": c.app_build,
            "notes": c.notes,
            "tracker": asdict(c.tracker),
            "required_baud": c.required_baud,
            "tool": {"python": platform.python_version()},
            "aborted": None,
        }
        aborted: Optional[str] = None
        results_handle = (run_dir / "results.csv").open("w", newline="")
        write_rows(results_handle, [], header=True)
        try:
            self._resolve_devices()
            provenance["glasses"] = self._probe()
            provenance["phone"] = self._phone_info()
            self._check_baud()
            self._open_streams(run_dir)
            self._wait_for_transport()
            if c.disconnect_wifi:
                self._broadcast(adbio.disconnect_wifi_payload())
                self.clock.sleep(c.settle_s)
            for index, warmup, request_id, ble_img_id in photo_plan(c, self.id_gen, tag):
                tracker = self._take_photo(request_id, ble_img_id)
                row = row_from_tracker(
                    tracker, run_id=run_id, phone=c.phone, phone_os=c.phone_os,
                    condition=c.condition, size=c.size, index=index, warmup=warmup,
                    transport=self.transport.current)
                self.rows.append(row)
                write_rows(results_handle, [row], header=False)
                results_handle.flush()
                self.log("%s %s %s e2e=%s KB/s" % ("warmup" if warmup else "#%d" % index,
                                                   request_id, row.outcome, row.e2e_kbps))
                self.clock.sleep(c.settle_s)
        except (SessionAborted, AdbError) as e:
            aborted = str(e)
            self.log("ABORTED: %s" % aborted)
        finally:
            self._close_streams()
            results_handle.close()
            glasses = provenance.setdefault("glasses", {"serial": self.glasses_serial or None})
            assert isinstance(glasses, dict)
            glasses.update({
                "bes_firmware": c.bes_fw or self.glasses_state.bes_firmware,
                "uart_baud": self.glasses_state.baud,
                "uart_baud_source": self.glasses_state.baud_source,
                "uart_baud_changes_during_session": self.baud_changes,
                "timing_logs_observed": self.glasses_state.timing_logs_observed,
            })
            if self.glasses_serial and "battery_pct_start" in glasses:
                battery = _try_run(self.runner, adbio.adb(self.glasses_serial, "shell", "dumpsys",
                                                          "battery"))
                glasses["battery_pct_end"] = adbio.parse_battery_level(battery or "")
            provenance.setdefault("phone", {"label": c.phone, "os": c.phone_os})
            provenance["transport"] = {
                "session_label": self.transport.session_label,
                "opens": self.transport.opens,
                "closes": self.transport.closes,
                "gatt_fallbacks": self.transport.gatt_fallbacks,
                "first_open_line": self.transport.first_open_line,
                "files_completed": len(self.transport.files_completed),
                "phone_rates_bps": self.transport.phone_rates_bps,
            }
            provenance["aborted"] = aborted
            provenance["photos"] = {
                "recorded": len(self.rows),
                "finished": sum(1 for r in self.rows if r.outcome == "finished"),
            }
            (run_dir / "provenance.json").write_text(json.dumps(provenance, indent=2) + "\n")
        return CellResult(run_dir, self.rows, provenance, aborted)


def format_command(args: List[str]) -> str:
    return " ".join(shlex.quote(a) for a in args)
