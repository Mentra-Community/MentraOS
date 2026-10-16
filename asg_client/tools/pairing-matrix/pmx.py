#!/usr/bin/env python3
"""Mentra Live pairing test-matrix helpers.

Run with the bleak venv: ~/.venvs/mentra-ble/bin/python pmx.py <command> [...]

Button injection uses the release BesButtonInjectReceiver (DUMP), not the deleted
debug receiver DebugBesKeyReceiver (com.mentra.DEBUG_BES_KEY, seq/gap_ms/code/delay_ms):

  adb shell am broadcast -a com.mentra.BES_BUTTON -p com.mentra.asg_client --es gesture <single|double|triple|long>

inject() still accepts a legacy seq and maps it onto one of those gestures. gap_ms and code
are not forwarded (only the power key exists). delay_ms is slept on the host first. See README.md.

Device routing (see the GLASSES/PHONE block below): glasses = unit3 wrapper adb only
(opt-in: PMX_LANE=unit2 / run_case.py --lane unit2 swaps it for the unit2 wrapper and the unit2 guard),
phone = PMX_PHONE_ADB with -s <S22 serial>. Glasses name/code/MAC come from ident.py.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import threading
import time
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from pathlib import Path

import ident

APP_PKG = "com.mentra.mentra"
ASG_PKG = "com.mentra.asg_client"
HERE = Path(__file__).resolve().parent
# A harness snapshot sets PMX_RUNS_DIR so it still writes to the live runs/ tree.
RUNS = Path(os.environ.get("PMX_RUNS_DIR") or (HERE / "runs"))
RUN_NAME = ident.run_name()  # "x2" by default; "x2/lanes/unit2" only when PMX_LANE=unit2

# ------------------------------------------------------------------ device routing
#
# Two routes only, addressed by token, never by serial:
#   GLASSES: unit3 only. The unit3 wrapper `adb` selects the glasses by eMMC id. It is
#            called by its absolute wrapper path with the wrapper dir first on PATH,
#            ANDROID_SERIAL unset, and never with -s/-t. No other adb is ever used for glasses.
#   PHONE:   the S22. Needs PMX_PHONE_ADB (path to a plain adb binary) and is invoked as
#            [PMX_PHONE_ADB, "-s", PHONE_SERIAL, ...]. Refused when unset or when it points at
#            the shared system adb or any wrapper. The wrapper is never used for the phone.
GLASSES = "glasses"
PHONE = "phone"
PHONE_SERIAL = os.environ.get("PMX_PHONE", "RFCT31GXXQJ")
LAB_BIN = Path(os.environ.get("PMX_LAB_BIN", "/Users/mentra/Documents/MentraApps/os-1988/bin"))
UNIT3_DIR = Path(os.environ.get("PMX_UNIT3_BIN") or (LAB_BIN / "unit3"))
UNIT2_DIR = Path(os.environ.get("PMX_UNIT2_BIN") or (LAB_BIN / "unit2"))  # only used when PMX_LANE=unit2
LAB_UNITS = LAB_BIN / "lab-units"


class RouteError(RuntimeError):
    """A device command was refused because its route is not safe or not configured."""


class Unit3GuardError(RuntimeError):
    """lab-units did not show exactly one unit3 row: fail closed."""


class LaneGuardError(Unit3GuardError):
    """lab-units did not show exactly one row for the active lane's unit: fail closed (a Unit3GuardError so the
    existing case handlers still treat it as a blocked device guard)."""


def glasses_dir() -> Path:
    """Wrapper dir for the glasses route: the unit3 dir unless a lane (unit2) is active."""
    return UNIT2_DIR if ident.lane() == "unit2" else UNIT3_DIR


def _clean_env(route: str | None = None) -> dict:
    env = dict(os.environ)
    env.pop("ANDROID_SERIAL", None)
    if route == GLASSES:
        env["PATH"] = f"{glasses_dir()}{os.pathsep}{env.get('PATH', '')}"
    return env


def _is_shared_system_adb(path: str) -> bool:
    """The shared package-manager adb (any path under a homebrew prefix) is never a harness route."""
    return "homebrew" in Path(path).parts or "homebrew" in Path(os.path.realpath(path)).parts


def phone_adb_path() -> str:
    path = os.environ.get("PMX_PHONE_ADB", "").strip()
    if not path:
        raise RouteError("PMX_PHONE_ADB is not set: refusing to run phone commands (set it to the S22 adb binary)")
    p = Path(path)
    if not (p.is_file() and os.access(p, os.X_OK)):
        raise RouteError(f"PMX_PHONE_ADB is not an executable file: {path}")
    real = os.path.realpath(path)
    if _is_shared_system_adb(path):
        raise RouteError(f"PMX_PHONE_ADB must not be the shared system adb: {path}")
    lab = os.path.realpath(str(LAB_BIN))
    if real == lab or real.startswith(lab + os.sep) or str(p.parent).startswith(str(LAB_BIN)):
        raise RouteError(f"PMX_PHONE_ADB must not be a lab-unit wrapper: {path}")
    return path


def glasses_adb_path() -> str:
    wrapper = glasses_dir() / "adb"
    if not (wrapper.is_file() and os.access(wrapper, os.X_OK)):
        raise RouteError(f"{ident.lane() or 'unit3'} adb wrapper missing or not executable: {wrapper}")
    return str(wrapper)


def adb_argv(route: str, *args: str) -> list:
    if route == GLASSES:
        if args and args[0] in ("-s", "-t", "-d", "-e"):
            raise RouteError("glasses adb calls never take -s/-t/-d/-e (the unit3 wrapper selects the device)")
        return [glasses_adb_path(), *args]
    if route == PHONE:
        return [phone_adb_path(), "-s", PHONE_SERIAL, *args]
    raise RouteError(f"unknown adb route {route!r}: use pmx.GLASSES or pmx.PHONE, never a serial")


def adb(route: str, *args: str, timeout: float = 30, check: bool = False) -> str:
    proc = subprocess.run(
        adb_argv(route, *args),
        capture_output=True,
        text=True,
        timeout=timeout,
        env=_clean_env(route),
    )
    if check and proc.returncode != 0:
        raise RuntimeError(f"adb {' '.join(args)} failed: {proc.stderr.strip()}")
    return proc.stdout


def adb_popen(route: str, *args: str, **kwargs) -> subprocess.Popen:
    return subprocess.Popen(adb_argv(route, *args), env=_clean_env(route), **kwargs)


def parse_lab_units(text: str) -> list:
    """Rows of `lab-units`: transport usb role serial cid."""
    rows = []
    for line in text.splitlines():
        parts = line.split()
        if len(parts) < 3 or parts[0] == "transport":
            continue
        rows.append({
            "transport": parts[0], "usb": parts[1], "role": parts[2],
            "serial": parts[3] if len(parts) > 3 else "", "cid": (parts[4] if len(parts) > 4 else "").lower(),
        })
    return rows


LAST_UNIT3: dict = {}


def assert_lane_unit(role: str, run=subprocess.run) -> dict:
    """Lane gate: lab-units must show exactly one row whose role is `role` (e.g. unit2). Fail closed otherwise.

    A unit3 row is never accepted for another role: rows are matched on the role column only.
    """
    if not LAB_UNITS.is_file():
        raise LaneGuardError(f"lab-units not found at {LAB_UNITS}; refusing to touch glasses")
    try:
        proc = run([str(LAB_UNITS)], capture_output=True, text=True, timeout=120, env=_clean_env())
    except Exception as exc:  # noqa: BLE001
        raise LaneGuardError(f"lab-units failed to run: {exc!r}") from exc
    rows = parse_lab_units(proc.stdout or "")
    mine = [r for r in rows if r["role"] == role]
    if proc.returncode != 0 or len(mine) != 1:
        raise LaneGuardError(
            f"expected exactly one {role} row from lab-units, found {len(mine)} (rc={proc.returncode}); "
            f"not attached means the pair is down or rebooting, more than one means ambiguous. Output:\n"
            f"{(proc.stdout or '').strip()}\n{(proc.stderr or '').strip()}"
        )
    want = ident.lane_cid()
    if want and mine[0]["cid"] != want:
        raise LaneGuardError(f"{role} cid {mine[0]['cid']} does not match the recorded {role} cid {want}")
    LAST_UNIT3.clear()  # case records read LAST_UNIT3; in a lane it holds that lane's row
    LAST_UNIT3.update(mine[0])
    return mine[0]


def assert_unit3(run=subprocess.run) -> dict:
    """Gate: lab-units must show exactly one `unit3` row. Fail closed otherwise.

    Called at every case start and after every glasses reboot. Returns the unit3 row.
    With PMX_LANE=unit2 the same call (cases.py keeps calling it) is the unit2 guard instead, so the default
    path below is untouched and a lane can never be satisfied by a unit3 row.
    """
    if ident.lane() == "unit2":
        return assert_lane_unit("unit2", run)
    if not LAB_UNITS.is_file():
        raise Unit3GuardError(f"lab-units not found at {LAB_UNITS}; refusing to touch glasses")
    try:
        proc = run([str(LAB_UNITS)], capture_output=True, text=True, timeout=120, env=_clean_env())
    except Exception as exc:  # noqa: BLE001
        raise Unit3GuardError(f"lab-units failed to run: {exc!r}") from exc
    rows = parse_lab_units(proc.stdout or "")
    unit3 = [r for r in rows if r["role"] == "unit3"]
    if proc.returncode != 0 or len(unit3) != 1:
        raise Unit3GuardError(
            f"expected exactly one unit3 row from lab-units, found {len(unit3)} (rc={proc.returncode}); "
            f"not attached means the pair is down or rebooting, more than one means ambiguous. Output:\n"
            f"{(proc.stdout or '').strip()}\n{(proc.stderr or '').strip()}"
        )
    want = ident.unit3_cid()
    if want and unit3[0]["cid"] != want:
        raise Unit3GuardError(f"unit3 cid {unit3[0]['cid']} does not match the recorded unit3_cid {want}")
    LAST_UNIT3.clear()
    LAST_UNIT3.update(unit3[0])
    return unit3[0]


def gsh(cmd: str, timeout: float = 30) -> str:
    return adb(GLASSES, "shell", cmd, timeout=timeout)


def psh(cmd: str, timeout: float = 30) -> str:
    return adb(PHONE, "shell", cmd, timeout=timeout)


# --------------------------------------------------------------------------- logs

_TRACE_RE = re.compile(r'layer=bes_trace_log .*?"line":"(.*)"\}\s*$')


def _unescape(s: str) -> str:
    return s.replace("\\/", "/").replace('\\"', '"').replace("\\\\", "\\")


@dataclass
class LogTap:
    """Streams logcat from one device into memory and a file."""

    serial: str  # route token: pmx.GLASSES or pmx.PHONE (never a device serial)
    path: Path
    lines: list = field(default_factory=list)
    _proc: subprocess.Popen | None = None
    _lock: threading.Lock = field(default_factory=threading.Lock)

    def start(self, clear: bool = True) -> "LogTap":
        if clear:
            adb(self.serial, "logcat", "-c")
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._fh = open(self.path, "a", buffering=1)
        self._proc = adb_popen(
            self.serial,
            "logcat", "-v", "time",
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            errors="replace",
        )
        threading.Thread(target=self._pump, daemon=True).start()
        return self

    def _pump(self) -> None:
        assert self._proc and self._proc.stdout
        for raw in self._proc.stdout:
            stamp = time.time()
            with self._lock:
                self.lines.append((stamp, raw.rstrip("\n")))
            self._fh.write(raw)

    def stop(self) -> None:
        if self._proc:
            self._proc.terminate()
            self._proc = None

    def mark(self) -> int:
        with self._lock:
            return len(self.lines)

    def since(self, mark: int) -> list:
        with self._lock:
            return list(self.lines[mark:])

    def wait_for(self, pattern: str, mark: int, timeout: float, bes_only: bool = False):
        rx = re.compile(pattern)
        deadline = time.time() + timeout
        seen = mark
        while time.time() < deadline:
            chunk = self.since(seen)
            seen += len(chunk)
            for stamp, line in chunk:
                text = bes_line(line) if bes_only else line
                if text is not None and rx.search(text):
                    return stamp, text
            time.sleep(0.25)
        return None


def bes_line(logcat_line: str) -> str | None:
    m = _TRACE_RE.search(logcat_line)
    return _unescape(m.group(1)) if m else None


_CHUNK_RE = re.compile(r"layer=asg_uart_input .*type=k900:sr_log .*?payload=(\{.*\})\s*$")
_BES_LINE_RE = re.compile(r"^\s*(\d+)/[A-Z]/\S+\s+/\s+\d+ \| (.*)$")
_ECHO_MARKERS = ('cmd={"C":"sr_log"', "cmd=mh_logs", '"C":"sr_log"', "sr_log")


def bes_ring_lines(raw_lines: list) -> list:
    """Reassemble mh_logs ring dumps (raw sr_log chunks) into unique BES trace lines.

    The poller's own MentraBleTrace 'trace' lines drop data when the ring rotates,
    so this rebuilds every dump from the raw UART chunks instead. Returns
    (tick_ms, text) tuples in first-seen order, without the dump's own echo lines.
    """
    out, seen, buf = [], set(), []

    def flush():
        for piece in "".join(buf).split("\n"):
            m = _BES_LINE_RE.match(piece)
            if not m or any(k in m.group(2) for k in _ECHO_MARKERS):
                continue
            key = (m.group(1), m.group(2))
            if key not in seen:
                seen.add(key)
                out.append((int(m.group(1)), m.group(2)))
        buf.clear()

    for _, line in raw_lines:
        m = _CHUNK_RE.search(line)
        if not m:
            continue
        try:
            body = json.loads(m.group(1))["B"]
        except (ValueError, KeyError, TypeError):
            continue
        cur = body.get("cur")
        if cur == 0 and buf:
            flush()
        if cur == 255:
            flush()
            continue
        buf.append(body.get("body", ""))
    flush()
    return out


def bes_lines(tap: LogTap, mark: int, pattern: str = "") -> list:
    rx = re.compile(pattern) if pattern else None
    return [
        f"{tick} | {text}"
        for tick, text in bes_ring_lines(tap.since(mark))
        if rx is None or rx.search(text)
    ]


def bes_wait(tap: LogTap, pattern: str, mark: int, timeout: float):
    rx = re.compile(pattern)
    deadline = time.time() + timeout
    while True:
        for line in bes_lines(tap, mark):
            if rx.search(line):
                return time.time(), line
        if time.time() >= deadline:
            return None
        time.sleep(1.0)


# ---------------------------------------------------------------------- glasses


def bes_trace(enabled: bool = True, interval_ms: int = 3000) -> None:
    gsh(
        f"am broadcast -a com.mentra.DEBUG_BES_TRACE -p {ASG_PKG} "
        f"--ez enabled {'true' if enabled else 'false'} --ei interval_ms {interval_ms}"
    )


# Release receiver. DebugBesKeyReceiver (action com.mentra.DEBUG_BES_KEY) is gone.
BES_BUTTON_ACTION = "com.mentra.BES_BUTTON"
_GESTURES = ("single", "double", "triple", "long")


def gesture_for_seq(seq: str) -> str:
    """Map a legacy DEBUG_BES_KEY sequence onto single|double|triple|long.

    Back-compat for call sites that still pass ``presses()`` / ``C`` / ``DU`` strings.
    A ``DU`` pair or a ``C`` click is one press (``DUC`` is one click). 1 -> single,
    2 -> double, 3 or more -> triple. ``L`` or ``X`` -> long. Dots and gap timing are
    ignored: the release receiver has no sequence clock, only a gesture name.
    """
    raw = (seq or "").strip()
    low = raw.lower()
    if low in _GESTURES:
        return low
    if "L" in raw or "X" in raw:
        return "long"
    collapsed = raw.replace("DUC", "C")
    n = collapsed.count("C") + collapsed.count("DU")
    if n <= 1:
        return "single"
    if n == 2:
        return "double"
    return "triple"


def inject(seq: str, gap_ms: int = 150, code: str = "pwr", delay_ms: int = 0) -> None:
    """Broadcast one power-button gesture to the release receiver.

    ``adb shell am broadcast -a com.mentra.BES_BUTTON -p <asg> --es gesture <name>``.
    ``seq`` may already be single|double|triple|long, or a legacy debug sequence
    (see ``gesture_for_seq``). ``gap_ms`` is recorded and not sent. ``code`` other than
    ``pwr`` is refused: the release path cannot inject fn2/camera. ``delay_ms`` is slept
    here because the receiver has no delay extra.
    """
    import traceback

    gesture = gesture_for_seq(seq)
    audit = RUNS / RUN_NAME / "inject-audit.log"
    audit.parent.mkdir(parents=True, exist_ok=True)
    with open(audit, "a") as fh:
        caller = " <- ".join(f"{f.name}:{f.lineno}" for f in traceback.extract_stack()[-4:-1])
        fh.write(
            f"{time.strftime('%H:%M:%S')} pid={os.getpid()} seq={seq} gesture={gesture} "
            f"code={code} gap_ms={gap_ms} delay_ms={delay_ms} {caller}\n"
        )
    if code != "pwr":
        print(
            f"inject skipped: BES_BUTTON only injects the power key, not code={code!r} (seq={seq!r})",
            flush=True,
        )
        return
    if delay_ms:
        time.sleep(delay_ms / 1000)
    gsh(f"am broadcast -a {BES_BUTTON_ACTION} -p {ASG_PKG} --es gesture {gesture}")


def presses(n: int, gap_ms: int = 300) -> str:
    """n physical presses as D/U pairs; gap_ms between consecutive DOWNs."""
    ticks = max(2, gap_ms // 50)
    one = "DU" + "." * (ticks - 2)
    return one * (n - 1) + "DU"


def asg_command(payload: dict) -> str:
    return gsh(
        "am broadcast -a com.mentra.asg_client.ACTION_SEND_COMMAND "
        f"-p {ASG_PKG} --es json '{json.dumps(payload)}'"
    )


def media_count() -> int:
    out = gsh(
        'find /storage/emulated/0 \\( -iname "*.jpg" -o -iname "*.mp4" \\) 2>/dev/null | wc -l'
    )
    return int(out.strip() or 0)


def wait_glasses_boot(timeout: float = 240) -> bool:
    """Wait for unit3's Android to be back after a reboot, then re-run the unit3 guard."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            state = adb(GLASSES, "get-state", timeout=45).strip()
            if state == "device" and gsh("getprop sys.boot_completed").strip() == "1":
                if gsh(f"pidof {ASG_PKG}").strip():
                    assert_unit3()
                    return True
        except subprocess.TimeoutExpired:
            pass
        time.sleep(3)
    return False


def wait_unit3_return(timeout: float = 1200, poll: float = 15, run=subprocess.run, clock=time) -> float | None:
    """After an Android reboot the USB adb can take 10+ minutes to reappear while BLE is back in under a minute.

    Informational wait: poll `lab-units` every `poll` s for up to `timeout` s until exactly one unit3 row shows.
    Returns the elapsed seconds, or None when it never returned. A row count above one is ambiguous and raises
    Unit3GuardError (never guess). Uses only lab-units, no glasses adb.
    """
    role = "unit2" if ident.lane() == "unit2" else "unit3"
    start = clock.time()
    while True:
        try:
            proc = run([str(LAB_UNITS)], capture_output=True, text=True, timeout=120, env=_clean_env())
            unit3 = [r for r in parse_lab_units(proc.stdout or "") if r["role"] == role]
        except Exception:  # noqa: BLE001
            unit3 = []
        if len(unit3) > 1:
            raise Unit3GuardError(f"lab-units shows {len(unit3)} {role} rows while waiting for adb: ambiguous")
        if len(unit3) == 1:
            return clock.time() - start
        if clock.time() - start >= timeout:
            return None
        clock.sleep(poll)


# ------------------------------------------------------------------------ phone


@dataclass
class Node:
    text: str
    desc: str
    rid: str
    bounds: tuple
    clickable: bool

    @property
    def center(self):
        x1, y1, x2, y2 = self.bounds
        return (x1 + x2) // 2, (y1 + y2) // 2

    @property
    def label(self) -> str:
        return self.text or self.desc


def ui_nodes() -> list:
    psh("uiautomator dump /sdcard/pmx_ui.xml", timeout=40)
    xml = psh("cat /sdcard/pmx_ui.xml")
    start = xml.find("<?xml")
    if start < 0:
        return []
    root = ET.fromstring(xml[start:])
    nodes = []
    for el in root.iter("node"):
        b = re.findall(r"\d+", el.get("bounds", ""))
        if len(b) != 4:
            continue
        nodes.append(
            Node(
                el.get("text", ""),
                el.get("content-desc", ""),
                el.get("resource-id", ""),
                tuple(int(v) for v in b),
                el.get("clickable") == "true",
            )
        )
    return nodes


def ui_find(pattern: str, nodes: list | None = None):
    rx = re.compile(pattern, re.I)
    for n in nodes if nodes is not None else ui_nodes():
        if n.label and rx.search(n.label):
            return n
    return None


def tap(x: int, y: int) -> None:
    psh(f"input tap {x} {y}")


def tap_text(pattern: str, timeout: float = 10) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        n = ui_find(pattern)
        if n:
            tap(*n.center)
            return True
        time.sleep(1)
    return False


def screenshot(path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    data = subprocess.run(
        adb_argv(PHONE, "exec-out", "screencap", "-p"), capture_output=True, env=_clean_env(PHONE)
    ).stdout
    path.write_bytes(data)
    return path


def phone_bt(enabled: bool) -> None:
    psh(f"svc bluetooth {'enable' if enabled else 'disable'}")


def phone_bonds() -> list:
    out = psh("dumpsys bluetooth_manager")
    bonds = []
    grab = False
    for line in out.splitlines():
        if "Bonded devices:" in line:
            grab = True
            continue
        if grab:
            m = re.search(r"([0-9A-F]{2}(?::[0-9A-F]{2}){5})\s+\[\s*(\w+)\s*\]\s+(\S+)", line)
            if m:
                bonds.append({"addr": m.group(1), "type": m.group(2), "name": m.group(3)})
            elif line.strip() == "" or not line.startswith("    "):
                if bonds:
                    break
    return bonds


def glasses_bonds() -> list:
    """Phone bonds that belong to the configured glasses (by code in the Bluetooth name)."""
    return [b for b in phone_bonds() if ident.is_glasses_name(b["name"])]


BT_DIALOG_ACCEPT = r"^(配对|Pair|PAIR|OK|确定|允许|Allow)$"


def app_home() -> None:
    psh(f"monkey -p {APP_PKG} -c android.intent.category.LAUNCHER 1")
    time.sleep(2)


def app_unpair() -> bool:
    """Settings -> Unpair glasses -> Unpair. Returns True when the home shows 'Pair glasses'."""
    app_home()
    for _ in range(10):
        nodes = ui_nodes()
        logbox = ui_find(r"Open debugger to view warnings", nodes)
        if logbox:
            # Dev-build LogBox toast covers the bottom button; its dismiss X sits at the right edge.
            tap(logbox.bounds[2] - 60, (logbox.bounds[1] + logbox.bounds[3]) // 2)
            time.sleep(1)
            continue
        if ui_find(r"^Pair glasses$", nodes):
            return True
        if ui_find(r"^Mentra Live$", nodes) and ui_find(r"^(Captions|Gallery)$", nodes):
            break
        blocker = ui_find(r"^(Stop trying|Cancel|取消|Continue setup|Continue|Skip|Done|Next|Got it)$", nodes)
        if not blocker:
            break
        tap(*blocker.center)
        time.sleep(2)
    owner_lost_card = ui_find(r"^In pairing mode$") is not None
    if not owner_lost_card:
        if not tap_text(r"^Mentra Live$", 8):
            return False
        time.sleep(2)
    if not tap_text(r"^Unpair glasses$", 8):
        return False
    time.sleep(1.5)
    if owner_lost_card:
        # The card's confirm modal is not in the uiautomator tree; its confirm button sits here.
        tap(769, 1363)
    else:
        tap_text(r"^Unpair$", 8)
    time.sleep(3)
    return ui_find(r"^Pair glasses$") is not None


def open_pairing_scan() -> None:
    """From home, reach the Mentra Live scan list (new pairing or a pending 'Finish pairing')."""
    app_home()
    nodes = ui_nodes()
    if ui_find(r"^Choose your glasses$", nodes):
        return
    if ui_find(r"^Pair glasses$", nodes):
        tap_text(r"^Pair glasses$", 8)
        time.sleep(2)
        tap_text(r"^Mentra Live$", 8)
    elif ui_find(r"^Finish pairing$", nodes):
        tap_text(r"^Finish pairing$", 8)
    for _ in range(4):
        time.sleep(2)
        nodes = ui_nodes()
        if ui_find(r"^Choose your glasses$", nodes):
            return
        if ui_find(r"Ready to pair", nodes):
            btn = ui_find(r"^Continue$", nodes)
            if btn:
                tap(*btn.center)


def app_pair(code: str | None = None, timeout: float = 60, accept_dialog: bool = True, pick_timeout: float | None = None) -> dict:
    """Drive Pair glasses -> Mentra Live -> <code>, accepting Android's pairing dialog."""
    code = re.escape(code or ident.code())
    out = {"dialog_seen": False, "dialog_accepted": False, "success_screen": False, "steps": []}
    open_pairing_scan()
    out["steps"].append("scan")
    deadline = time.time() + timeout
    picked = False
    last_retry = 0.0
    scan_seen = None
    while time.time() < deadline:
        nodes = ui_nodes()
        if scan_seen is None and ui_find(r"^Choose your glasses$", nodes):
            scan_seen = time.time()
        if pick_timeout and not picked and scan_seen and time.time() - scan_seen > pick_timeout:
            out["steps"].append("pick_timeout")
            out["labels"] = [n.label for n in nodes if n.label][:24]
            break
        dialog = ui_find(BT_DIALOG_ACCEPT, nodes)
        if dialog and (ui_find(r"配对|pair|Bluetooth|蓝牙", nodes)):
            out["dialog_seen"] = True
            if accept_dialog:
                tap(*dialog.center)
                out["dialog_accepted"] = True
                out["steps"].append(f"dialog:{dialog.label}")
                time.sleep(2)
                continue
        if ui_find(r"^Success$", nodes):
            out["success_screen"] = True
            out["steps"].append("success")
            break
        if ui_find(r"^Enter pairing mode$", nodes):
            ok = ui_find(r"^OK$", nodes)
            if ok:
                tap(*ok.center)
                out["steps"].append("dismiss_enter_pairing_modal")
                picked = False
                time.sleep(1)
                continue
        if not picked and scan_seen is None:
            # not on the scan list yet: clear whatever sits in the way
            for pat in (r"^Pair again$", r"^Continue$", r"^Finish pairing$"):
                b = ui_find(pat, nodes)
                if b:
                    tap(*b.center)
                    out["steps"].append(f"nav:{pat}")
                    time.sleep(2)
                    break
        if not picked:
            n = ui_find(rf"^(Mentra Live, )?{code}$", nodes)
            if n:
                tap(*n.center)
                picked = True
                out["steps"].append(f"picked:{code}")
            elif ui_find(r"Not in pairing mode", nodes):
                retry = ui_find(r"^Try Again$", nodes)
                if retry and time.time() - last_retry > 6:
                    tap(*retry.center)
                    last_retry = time.time()
                    out["steps"].append("try_again")
        time.sleep(1)
    return out


def app_restart() -> None:
    psh(f"am force-stop {APP_PKG}")
    time.sleep(1)
    psh(f"monkey -p {APP_PKG} -c android.intent.category.LAUNCHER 1")


# -------------------------------------------------------------------------- BLE


def ble_scan(seconds: float = 6.0) -> list:
    sys.path.insert(0, str(HERE))
    import asyncio

    from ble_scan import scan

    return asyncio.run(scan(seconds))


def glasses_adv(name_suffix: str | None = None, seconds: float = 6.0):
    name_suffix = name_suffix or ident.code()
    for r in ble_scan(seconds):
        if r.get("name", "").endswith(name_suffix):
            return r
    return None


# ---------------------------------------------------------------------- results


class Run:
    def __init__(self, name: str):
        stamp = time.strftime("%Y%m%dT%H%M%S")
        self.dir = RUNS / f"{stamp}-{name}"
        self.dir.mkdir(parents=True, exist_ok=True)
        self.results = self.dir / "results.jsonl"

    def record(self, case: str, status: str, summary: str, evidence: list | None = None) -> None:
        row = {
            "case": case,
            "status": status,
            "summary": summary,
            "evidence": evidence or [],
            "t": time.strftime("%H:%M:%S"),
        }
        with open(self.results, "a") as fh:
            fh.write(json.dumps(row) + "\n")
        print(f"[{status}] {case}: {summary}")


def main() -> None:
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("inject")
    p.add_argument("seq")
    p.add_argument("--gap", type=int, default=150)
    p.add_argument("--code", default="pwr")
    p.add_argument("--delay", type=int, default=0)
    p = sub.add_parser("press")
    p.add_argument("n", type=int)
    p.add_argument("--gap", type=int, default=300)
    sub.add_parser("ui")
    sub.add_parser("bonds")
    sub.add_parser("adv")
    p = sub.add_parser("tap")
    p.add_argument("pattern")
    args = ap.parse_args()

    if args.cmd == "inject":
        inject(args.seq, args.gap, args.code, args.delay)
    elif args.cmd == "press":
        inject(presses(args.n, args.gap), 50)
    elif args.cmd == "ui":
        for n in ui_nodes():
            if n.label:
                print(f"{n.center} click={n.clickable} {n.label!r}")
    elif args.cmd == "bonds":
        print(json.dumps(phone_bonds(), indent=2))
    elif args.cmd == "adv":
        print(json.dumps(glasses_adv(), indent=2))
    elif args.cmd == "tap":
        print(tap_text(args.pattern))


if __name__ == "__main__":
    main()
