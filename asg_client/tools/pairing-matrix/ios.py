#!/usr/bin/env python3
"""iOS side of the pairing matrix: the Mentra App in the iOS Simulator.

The simulator's CoreBluetooth calls go to the Mac radio through the ImpossiBLE
passthrough helper, so the iOS bond is the Mac's bond with the glasses
(`blueutil --paired`). UI is driven through WebDriverAgent on 127.0.0.1:8100.

Run with the bleak venv: ~/.venvs/mentra-ble/bin/python ios.py <command> [...]
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import threading
import time
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path

SIM = os.environ.get("PMX_SIM", "FC25B30E-4AE6-4314-803E-65889C65653B")
APP = "com.mentra.mentra"
WDA = os.environ.get("PMX_WDA", "http://127.0.0.1:8100")
GLASSES_MAC = "cc-e7-de-e0-02-be"
HFP_FLAG = "/tmp/sim-hfp-02BE"
BRIDGE_APP = "/tmp/ImpossiBLE/ImpossiBLE-Mac.app"

_session: str | None = None


# ------------------------------------------------------------------ WebDriverAgent


def _http(method: str, path: str, body: dict | None = None, timeout: float = 30) -> dict:
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(f"{WDA}{path}", data=data, method=method)
    req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read() or b"{}")


def wda_ready() -> bool:
    try:
        return bool(_http("GET", "/status", timeout=5).get("value", {}).get("ready"))
    except Exception:  # noqa: BLE001
        return False


def session() -> str:
    global _session
    if _session:
        try:
            _http("GET", f"/session/{_session}", timeout=10)
            return _session
        except Exception:  # noqa: BLE001
            _session = None
    res = _http("POST", "/session", {"capabilities": {"alwaysMatch": {}}})
    _session = res.get("sessionId") or res.get("value", {}).get("sessionId")
    _http("POST", f"/session/{_session}/appium/settings",
          {"settings": {"snapshotMaxDepth": 60, "animationCoolOffTimeout": 0}})
    return _session


@dataclass
class El:
    eid: str
    label: str
    rect: dict

    @property
    def center(self):
        return int(self.rect["x"] + self.rect["width"] / 2), int(self.rect["y"] + self.rect["height"] / 2)


def _predicate_for(pattern: str) -> str:
    esc = pattern.replace("\\", "\\\\").replace("'", "\\'")
    return f"(label MATCHES[c] '{esc}' OR name MATCHES[c] '{esc}' OR value MATCHES[c] '{esc}') AND visible == 1"


def find_all(pattern: str) -> list:
    """Elements whose label/name/value matches the regex (whole-string, case-insensitive)."""
    sid = session()
    try:
        res = _http("POST", f"/session/{sid}/elements",
                    {"using": "predicate string", "value": _predicate_for(pattern)}, timeout=40)
    except Exception:  # noqa: BLE001
        return []
    out = []
    for v in res.get("value", []) or []:
        eid = v.get("ELEMENT") or v.get("element-6066-11e4-a52f-4f8ec6f45f2c")
        if not eid:
            continue
        try:
            rect = _http("GET", f"/session/{sid}/element/{eid}/rect")["value"]
            label = _http("GET", f"/session/{sid}/element/{eid}/attribute/label").get("value") or ""
        except Exception:  # noqa: BLE001
            continue
        if rect.get("width", 0) > 0 and rect.get("height", 0) > 0:
            out.append(El(eid, label, rect))
    return out


def find(pattern: str):
    els = find_all(pattern)
    # Prefer the smallest matching element: containers repeat their children's labels.
    els.sort(key=lambda e: e.rect["width"] * e.rect["height"])
    return els[0] if els else None


def tap_xy(x: int, y: int) -> None:
    sid = session()
    _http("POST", f"/session/{sid}/actions", {"actions": [{
        "type": "pointer", "id": "finger", "parameters": {"pointerType": "touch"},
        "actions": [
            {"type": "pointerMove", "duration": 0, "x": x, "y": y},
            {"type": "pointerDown", "button": 0},
            {"type": "pause", "duration": 80},
            {"type": "pointerUp", "button": 0},
        ]}]})


def tap(el: El) -> None:
    tap_xy(*el.center)


def tap_text(pattern: str, timeout: float = 10) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        el = find(pattern)
        if el:
            tap(el)
            return True
        time.sleep(1)
    return False


def type_into(pattern: str, text: str) -> bool:
    el = find(pattern)
    if not el:
        return False
    sid = session()
    _http("POST", f"/session/{sid}/element/{el.eid}/clear", {})
    _http("POST", f"/session/{sid}/element/{el.eid}/value", {"value": list(text)})
    return True


def visible_texts() -> list:
    """All visible static labels, top-to-bottom (cheap screen fingerprint for logs)."""
    sid = session()
    try:
        src = _http("GET", f"/session/{sid}/source?format=json", timeout=60)["value"]
    except Exception:  # noqa: BLE001
        return []
    out = []

    def walk(n):
        lab = n.get("label") or n.get("name")
        if lab and str(n.get("isVisible", "1")) in ("1", "True", "true") and n.get("type", "").replace(
            "XCUIElementType", "") in ("StaticText", "Button", "TextField", "SecureTextField"):
            r = n.get("rect", {})
            out.append((r.get("y", 0), r.get("x", 0), lab))
        for c in n.get("children", []) or []:
            walk(c)

    walk(src)
    seen, res = set(), []
    for _, _, lab in sorted(out):
        if lab not in seen:
            seen.add(lab)
            res.append(lab)
    return res


def alert_text() -> str | None:
    try:
        return _http("GET", f"/session/{session()}/alert/text", timeout=10).get("value")
    except Exception:  # noqa: BLE001
        return None


def alert_button(label: str) -> bool:
    try:
        res = _http("POST", f"/session/{session()}/alert/accept", {"name": label}, timeout=10)
        return not (isinstance(res.get("value"), dict) and res["value"].get("error"))
    except Exception:  # noqa: BLE001
        return False


ALERT_OK = ("Continue Anyway", "Pair", "Allow", "Allow While Using App", "OK", "Not Now")


def handle_alert(prefer: tuple = ALERT_OK) -> str | None:
    """Answer any visible alert with the first preferred button that exists. Returns the alert text."""
    a = alert_text()
    if not a:
        return None
    for name in prefer:
        el = find(rf"^{name}$")
        if el:
            tap(el)
            time.sleep(1)
            return a
    return a


# --------------------------------------------------------------------- simulator


def simctl(*args: str, timeout: float = 60) -> str:
    return subprocess.run(["xcrun", "simctl", *args], capture_output=True, text=True, timeout=timeout).stdout


def screenshot(path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    simctl("io", SIM, "screenshot", str(path))
    return path


def app_launch() -> None:
    simctl("launch", SIM, APP)
    time.sleep(3)


def app_terminate() -> None:
    simctl("terminate", SIM, APP)
    time.sleep(1)


def app_restart() -> None:
    app_terminate()
    app_launch()


# ------------------------------------------------------------------ "iOS radio"


def bridge_running() -> bool:
    return bool(subprocess.run(["pgrep", "-f", "ImpossiBLE-Mac.app/Contents/MacOS"],
                               capture_output=True, text=True).stdout.strip())


def bridge(enabled: bool) -> None:
    """Start/stop the passthrough provider: the simulator's Bluetooth on/off switch."""
    if enabled and not bridge_running():
        subprocess.run(["open", BRIDGE_APP])
        time.sleep(3)
    elif not enabled:
        subprocess.run(["pkill", "-f", "ImpossiBLE-Mac.app/Contents/MacOS"])
        time.sleep(2)


def mac_bonded() -> bool:
    out = subprocess.run(["blueutil", "--paired"], capture_output=True, text=True).stdout
    return GLASSES_MAC in out


def escape_to_home(max_steps: int = 6) -> bool:
    """Leave any in-app flow (prep, scan, pair audio) through Back until the miniapp home shows."""
    for _ in range(max_steps):
        t = visible_texts()
        if "Open all miniapps" in t or "Captions" in t:
            return True
        if "Cancel pairing" in t:
            tap_text(r"^Cancel pairing$", 3)
        elif "Back" in t:
            tap_text(r"^Back$", 3)
        elif "Cancel" in t:
            tap_text(r"^Cancel$", 3)
        else:
            break
        time.sleep(1.5)
    return False


def dismiss_owner_lost_modal() -> bool:
    t = visible_texts()
    if "Paired to another phone" in t and "Cancel" in t and "Pair again" in t:
        return tap_text(r"^Cancel$", 3)
    return False


def reset_ios_side() -> bool:
    """Deterministic iOS-side reset: no sheet, no saved glasses in the app, no Mac bond."""
    if mac_sheet():
        mac_sheet_click("Cancel")
    unpair()
    mac_forget()
    return "Pair glasses" in visible_texts()


def mac_forget() -> None:
    """iOS 'Forget This Device': drop the Mac's bond (the simulator's bond) with the glasses."""
    subprocess.run(["blueutil", "--unpair", GLASSES_MAC], capture_output=True, text=True)
    Path(HFP_FLAG).unlink(missing_ok=True)
    time.sleep(1)


def mac_sheet() -> str | None:
    """Title of the macOS 'Connection Request from <glasses>' numeric-comparison sheet (the iOS pairing-sheet stand-in)."""
    r = subprocess.run(["osascript", "-e",
                        'tell application "System Events" to tell process "BluetoothUIServer" to '
                        'if (count of windows) > 0 then return name of window 1'],
                       capture_output=True, text=True, timeout=15)
    t = r.stdout.strip()
    return t or None


def mac_sheet_click(button: str) -> bool:
    r = subprocess.run(["osascript", "-e",
                        f'tell application "System Events" to tell process "BluetoothUIServer" to click button "{button}" of window 1'],
                       capture_output=True, text=True, timeout=15)
    return r.returncode == 0


def classic_audio_pair() -> dict:
    """Stand-in for 'pair the audio device in iOS Settings': Classic pair from the Mac radio (answering its
    pairing sheet like a user), then expose the HFP route to the simulator app."""
    out = {"sheets": 0}
    proc = subprocess.Popen(["blueutil", "--pair", GLASSES_MAC], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    deadline = time.time() + 60
    while time.time() < deadline and proc.poll() is None:
        if mac_sheet():
            out["sheets"] += 1
            mac_sheet_click("Connect")
            time.sleep(1)
        time.sleep(0.5)
    if proc.poll() is None:
        proc.kill()
    out["pair_rc"] = proc.returncode
    out["paired"] = mac_bonded()
    if out["paired"]:
        Path(HFP_FLAG).write_text("1")
    out["flag"] = Path(HFP_FLAG).exists()
    return out


# ----------------------------------------------------------------------- logs


@dataclass
class SimLogTap:
    """Streams the simulator app's unified log (Bridge.log/NSLog + RN logs)."""

    path: Path
    lines: list = field(default_factory=list)
    _proc: subprocess.Popen | None = None
    _lock: threading.Lock = field(default_factory=threading.Lock)

    def start(self) -> "SimLogTap":
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._fh = open(self.path, "a", buffering=1)
        self._proc = subprocess.Popen(
            ["xcrun", "simctl", "spawn", SIM, "log", "stream", "--style", "compact",
             "--level", "info", "--predicate", 'process == "Mentra" AND NOT subsystem BEGINSWITH "com.apple"'],
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, errors="replace",
        )
        threading.Thread(target=self._pump, daemon=True).start()
        return self

    def _pump(self) -> None:
        assert self._proc and self._proc.stdout
        for raw in self._proc.stdout:
            with self._lock:
                self.lines.append((time.time(), raw.rstrip("\n")))
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

    def wait_for(self, pattern: str, mark: int, timeout: float):
        rx = re.compile(pattern)
        deadline = time.time() + timeout
        seen = mark
        while time.time() < deadline:
            chunk = self.since(seen)
            seen += len(chunk)
            for stamp, line in chunk:
                if rx.search(line):
                    return stamp, line
            time.sleep(0.25)
        return None

    def grep(self, pattern: str, mark: int = 0) -> list:
        rx = re.compile(pattern)
        return [l for _, l in self.since(mark) if rx.search(l)]


# ------------------------------------------------------------------ app flows

BLOCKERS = r"^(Stop trying|Continue setup|Continue|Yes, skip|Skip|Done|Next|Got it|Not now|Maybe later|Allow|OK)$"


def dismiss_logbox() -> None:
    el = find(r"Open debugger to view warnings")
    if el:
        tap_xy(int(el.rect["x"] + el.rect["width"] - 25), el.center[1])
        time.sleep(1)


def home() -> list:
    """Bring the app to the foreground and return the visible labels."""
    simctl("launch", SIM, APP)
    time.sleep(2)
    dismiss_logbox()
    return visible_texts()


def clear_blockers(max_steps: int = 6) -> None:
    for _ in range(max_steps):
        dismiss_logbox()
        b = find(BLOCKERS)
        if not b:
            t = visible_texts()
            if "Success" in t and "Continue setup" not in t:
                # the dev-warning toast hides the Continue setup button and is absent from the a11y tree
                tap_xy(360, 793)
                time.sleep(1.5)
                b = find(BLOCKERS)
            if not b:
                return
        tap(b)
        time.sleep(2)


def open_pairing_scan() -> bool:
    """From wherever the app is (home, onboarding, owner-lost card, modals), reach the scan list.
    One screen snapshot per loop keeps this fast."""
    simctl("launch", SIM, APP)
    time.sleep(1)
    for _ in range(12):
        if handle_alert():
            time.sleep(1)
            continue
        t = visible_texts()
        has = lambda s: any(re.fullmatch(s, x) for x in t)  # noqa: E731
        if has(r"Choose your glasses") or has(r"Not showing up\?"):
            return True
        if has(r"Pair again") and has(r"Cancel") and has(r"Paired to another phone"):
            tap_text(r"^Pair again$", 3)
        elif has(r"Ignore"):
            tap_text(r"^Ignore$", 3)
        elif has(r"Continue Anyway"):
            tap_text(r"^Continue Anyway$", 3)
        elif has(r"Select Model"):
            tap_text(r"^Mentra Live$", 3)
        elif has(r"Turn On Bluetooth"):
            tap_text(r"^Cancel$", 3)
        elif has(r"Cancel pairing"):
            tap_text(r".*Finish pairing", 3)
        elif has(r"Pair glasses"):
            tap_text(r"^Pair glasses$", 3)
        elif has(r"Continue"):
            tap_text(r"^Continue$", 3)
        elif has(r"Set up\nwith glasses"):
            tap_text(r"^Set up\nwith glasses$", 3)
        else:
            dismiss_logbox()
        time.sleep(1.5)
    return False


def clean_pending() -> bool:
    """Drop a stale pending pairing (Finish pairing / Pair Audio) so each attempt starts at 'Pair glasses'."""
    simctl("launch", SIM, APP)
    time.sleep(1)
    escape_to_home()
    dropped = False
    for _ in range(4):
        handle_alert()
        t = visible_texts()
        if "Paired to another phone" in t and "Cancel" in t and "Pair again" in t:
            tap_text(r"^Cancel$", 3)
            continue
        if "Ignore" in t:
            tap_text(r"^Ignore$", 3)
            continue
        if "Cancel pairing" in t and tap_text(r"^Cancel pairing$", 3):
            dropped = True
            time.sleep(1.5)
            handle_alert(("Cancel pairing", "Yes", "Confirm", "OK"))
            continue
        break
    return dropped


def pair(code: str = "02BE", timeout: float = 75, abort_if=None, sheet: str | None = "Connect") -> dict:
    """Pair glasses -> Mentra Live -> <code>; waits for Success or Pairing Failed."""
    out = {"success_screen": False, "failed_screen": False, "steps": []}
    fresh = not bridge_running()
    bridge(True)
    if fresh:
        time.sleep(3)
        app_restart()
        time.sleep(6)
    t = visible_texts()
    if "Choose your glasses" in t or "Not showing up?" in t:
        out["steps"].append("scan_ready")  # prepared before the presses; do not navigate away from the open window
        out["steps"].append("scan:True")
    else:
        if clean_pending():
            out["steps"].append("cleared_pending")
        t = visible_texts()
        if "Success" in t:  # stale Success screen from an earlier pairing
            app_restart()
            time.sleep(6)
            t = visible_texts()
        if "Pair glasses" not in t and "Cancel pairing" not in t and "Choose your glasses" not in t \
                and "Not showing up?" not in t and "Pair Audio" not in t:
            out["steps"].append(f"unpair_saved:{unpair()}")
        out["steps"].append(f"scan:{open_pairing_scan()}")
    deadline = time.time() + timeout
    picked = False
    last_retry = 0.0
    while time.time() < deadline:
        a = handle_alert()
        if a:
            out["steps"].append(f"alert:{a[:60]}")
            continue
        if out.get("t_pick") and sheet is not None and time.time() - out.get("t_sheet", 0) > 4 and mac_sheet():
            out["sheet"] = f"{sheet}:{mac_sheet_click(sheet)}"
            out["steps"].append(f"sheet:{out['sheet']}")
            out["t_sheet"] = time.time()
        if abort_if:
            why = abort_if(out)
            if why:
                out["aborted"] = why
                break
        if out.get("t_pick") and find(r"^Success$"):
            out["success_screen"] = True
            out["steps"].append("success")
            break
        if find(r"^Pairing Failed$"):
            out["failed_screen"] = True
            out["steps"].append("failed")
            break
        if find(r"^Pair Audio$") and not out.get("audio"):
            out["audio"] = classic_audio_pair()
            out["steps"].append(f"audio:{out['audio']}")
            time.sleep(3)
            continue
        if find(r"^Enter pairing mode$"):
            if tap_text(r"^OK$", 2):
                out["steps"].append("dismiss_enter_pairing_modal")
                picked = False
                time.sleep(1)
                continue
        if not picked:
            el = find(rf"^(Mentra Live, )?{code}$")
            if el:
                tap(el)
                picked = True
                out["steps"].append(f"picked:{code}")
                out["t_pick"] = time.time()
            elif find(r".*Not in pairing mode.*") and time.time() - last_retry > 6:
                if tap_text(r"^Try Again$", 2):
                    last_retry = time.time()
                    out["steps"].append("try_again")
        time.sleep(1)
    if not (out["success_screen"] or out["failed_screen"]):
        out["last_texts"] = visible_texts()[:10]
    return out


def finish_setup() -> None:
    clear_blockers(8)


def unpair() -> bool:
    """Settings -> Unpair glasses -> Unpair. True when home shows 'Pair glasses'."""
    labels = home()
    escape_to_home()
    dismiss_owner_lost_modal()
    clear_blockers()
    if find(r"^Pair glasses$"):
        return True
    card = find(r"^Paired to another phone$") is not None
    if not card and not tap_text(r".*Mentra Live(, .*)?", 8):
        return False
    time.sleep(2)
    if not tap_text(r"^Unpair glasses.*", 8):
        return False
    time.sleep(1.5)
    if not handle_alert(("Unpair",)):
        els = find_all(r"^Unpair$")
        els.sort(key=lambda e: -e.rect["y"])
        if els:
            tap(els[0])
    time.sleep(3)
    return find(r"^Pair glasses$") is not None


def owner_lost_card() -> bool:
    home()
    return find(r".*Paired to another phone.*") is not None


def pair_again_from_card() -> bool:
    if not tap_text(r"^Pair again$", 8):
        return False
    time.sleep(1.5)
    if not handle_alert(("Pair again",)):
        els = find_all(r"^Pair again$")
        els.sort(key=lambda e: -e.rect["y"])
        if els:
            tap(els[0])
    time.sleep(2)
    return True


def main() -> None:
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("status")
    sub.add_parser("texts")
    p = sub.add_parser("tap")
    p.add_argument("pattern")
    p = sub.add_parser("shot")
    p.add_argument("path")
    args = ap.parse_args()
    if args.cmd == "status":
        print(json.dumps({"wda": wda_ready(), "bridge": bridge_running(), "mac_bonded": mac_bonded()}))
    elif args.cmd == "texts":
        print(json.dumps(visible_texts(), indent=1))
    elif args.cmd == "tap":
        print(tap_text(args.pattern))
    elif args.cmd == "shot":
        print(screenshot(Path(args.path)))


if __name__ == "__main__":
    main()
