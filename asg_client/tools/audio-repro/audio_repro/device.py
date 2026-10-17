"""Targeted adb access, identity checks, provenance, and harness command delivery."""

from __future__ import annotations

import json
import re
import shlex
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional

PLACEHOLDER_SERIAL = "0123456789ABCDEF"
SEND_COMMAND_ACTION = "com.mentra.asg_client.ACTION_SEND_COMMAND"
DEFAULT_PACKAGE = "com.mentra.asg_client"


class DeviceError(RuntimeError):
    pass


@dataclass
class Device:
    """One adb target, always addressed explicitly (``-t`` transport or ``-s`` serial)."""

    serial: Optional[str] = None
    transport_id: Optional[str] = None
    adb: str = "adb"
    package: str = DEFAULT_PACKAGE
    extra: Dict[str, Any] = field(default_factory=dict)

    def base(self) -> List[str]:
        if self.transport_id:
            return [self.adb, "-t", self.transport_id]
        if self.serial:
            return [self.adb, "-s", self.serial]
        raise DeviceError("select the device explicitly with --transport-id or --serial")

    def run(self, args: List[str], timeout: float = 60.0, check: bool = True) -> subprocess.CompletedProcess:
        proc = subprocess.run(self.base() + args, capture_output=True, text=True, timeout=timeout)
        if check and proc.returncode != 0:
            raise DeviceError(f"adb {' '.join(args)} failed ({proc.returncode}): {proc.stderr.strip()}")
        return proc

    def shell(self, command: str, timeout: float = 60.0, check: bool = False) -> str:
        proc = self.run(["shell", command], timeout=timeout, check=check)
        return proc.stdout

    def getprop(self, name: str) -> str:
        return self.shell(f"getprop {shlex.quote(name)}").strip()

    def push(self, local: Path, remote: str) -> None:
        self.run(["push", str(local), remote], timeout=120.0)

    def pull(self, remote: str, local: Path) -> None:
        local.parent.mkdir(parents=True, exist_ok=True)
        self.run(["pull", remote, str(local)], timeout=600.0)

    @property
    def harness_root(self) -> str:
        return f"/sdcard/Android/data/{self.package}/files/audio-repro"

    def send_command(self, payload: Dict[str, Any]) -> str:
        """Deliver a JSON command through ASG's IntentCommandReceiver."""
        body = json.dumps(payload, separators=(",", ":"))
        command = (
            f"am broadcast -a {SEND_COMMAND_ACTION} -p {shlex.quote(self.package)} --es json {shlex.quote(body)}"
        )
        return self.shell(command, timeout=30.0)

    def enable_gate(self) -> None:
        self.shell(f"mkdir -p {self.harness_root}/sequences && touch {self.harness_root}/ENABLED", check=False)

    def disable_gate(self) -> None:
        self.shell(f"rm -f {self.harness_root}/ENABLED", check=False)


def _sha256_remote(device: Device, path: str) -> str:
    out = device.shell(f"sha256sum {shlex.quote(path)} 2>/dev/null").strip()
    return out.split()[0] if out else ""


def collect_provenance(device: Device) -> Dict[str, Any]:
    """Record every build and configuration identity the results depend on."""
    props = [
        "ro.serialno",
        "ro.custom.ota.version",
        "ro.build.fingerprint",
        "ro.build.type",
        "ro.build.version.release",
        "ro.product.device",
        "ro.boot.hwrev",
        "ro.boot.hardware.revision",
        "ro.boot.slot_suffix",
    ]
    info: Dict[str, Any] = {name: device.getprop(name) for name in props}
    info["uname"] = device.shell("uname -a").strip()
    cid = device.shell("cat /sys/block/mmcblk0/device/cid 2>/dev/null").strip()
    info["emmc_cid"] = cid or None
    package_dump = device.shell(f"dumpsys package {shlex.quote(device.package)}")
    version_name = re.search(r"versionName=(\S+)", package_dump)
    version_code = re.search(r"versionCode=(\d+)", package_dump)
    info["asg_package"] = device.package
    info["asg_version_name"] = version_name.group(1) if version_name else None
    info["asg_version_code"] = version_code.group(1) if version_code else None
    apk_paths = [line.split(":", 1)[1].strip() for line in device.shell(f"pm path {shlex.quote(device.package)}").splitlines() if ":" in line]
    info["asg_apks"] = {path: _sha256_remote(device, path) for path in apk_paths}
    policy = "/vendor/etc/audio_policy_configuration.xml"
    info["audio_policy_xml_sha256"] = _sha256_remote(device, policy) or None
    info["audio_props"] = [
        line.strip()
        for line in device.shell("getprop").splitlines()
        if re.search(r"audio|af\.|mentra|bes|i2s", line, re.IGNORECASE)
    ]
    info["uptime"] = device.shell("cat /proc/uptime").strip()
    return info


def check_identity(info: Dict[str, Any], expect_serial: Optional[str], expect_cid: Optional[str], expect_mtk: Optional[str]) -> List[str]:
    problems = []
    serial = info.get("ro.serialno", "")
    if expect_serial and serial != expect_serial:
        problems.append(f"serial {serial!r} != expected {expect_serial!r}")
    if serial == PLACEHOLDER_SERIAL and not expect_cid:
        problems.append("placeholder serial is not a unique identity; pass --expect-cid")
    if expect_cid and (info.get("emmc_cid") or "") != expect_cid:
        problems.append(f"eMMC CID {info.get('emmc_cid')!r} != expected {expect_cid!r} (adb root may be required)")
    if expect_mtk and info.get("ro.custom.ota.version") != expect_mtk:
        problems.append(f"MTK version {info.get('ro.custom.ota.version')!r} != expected {expect_mtk!r}")
    return problems


STANDBY_RE = re.compile(r"Standby:\s*(yes|no)", re.IGNORECASE)


def audio_flinger_standby(dump: str) -> Optional[bool]:
    """True when every output thread reports standby; None when the dump has no standby lines."""
    states = [match.group(1).lower() == "yes" for match in STANDBY_RE.finditer(dump)]
    if not states:
        return None
    return all(states)


def snapshot(device: Device, out_dir: Path, label: str, include_tinymix: bool = True) -> Dict[str, str]:
    """Save dumpsys (and optionally tinymix) text for later correlation."""
    out_dir.mkdir(parents=True, exist_ok=True)
    commands = {
        "audio_flinger": "dumpsys media.audio_flinger",
        "audio_policy": "dumpsys media.audio_policy",
    }
    if include_tinymix:
        commands["tinymix"] = "tinymix 2>&1"
    written = {}
    for name, command in commands.items():
        path = out_dir / f"{label}-{name}.txt"
        path.write_text(device.shell(command, timeout=60.0))
        written[name] = str(path)
    return written
