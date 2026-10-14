"""Fake adb/curl coverage for the Mentra Live refurbishment command.

No test in this file contacts a glasses device or the network. OTA helper
scripts are replaced with recorders, and downloads are served from memory.
"""

import hashlib
import json
import os
from pathlib import Path
import shutil
import stat
import struct
import subprocess
import tempfile
import textwrap
import unittest
import zipfile


ROOT = Path(__file__).resolve().parents[3]
REFURB = ROOT / "asg_client/scripts/refurbish-mentra-live.sh"
DEV = ROOT / "asg_client/scripts/update-stock-for-dev.sh"
PLACEHOLDER = "0123456789ABCDEF"
APK = b"pinned-apk"
BRIDGE = b"bridge-apk"
BES = b"bes-bytes"
PATCH = b"patch-bytes"
PATCH2 = b"patch-two"


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def manifest(apk_sha, bes_sha, patches, full=None, apk_size=None, bes_size=None, bes_version="1.2.3.4"):
    body = {
        "releaseVersion": "9.9.9-dev.1",
        "apps": {"com.mentra.asg_client": {
            "versionCode": 10,
            "versionName": "10.0",
            "apkUrl": "https://downloads.example.test/asg.apk",
            "apkSize": apk_size if apk_size is not None else len(APK),
            "sha256": apk_sha,
        }},
        "mtk_patches": patches,
        "bes_firmware": {
            "version": bes_version,
            "url": "https://downloads.example.test/bes_firmware.bin",
            "sha256": bes_sha,
        },
    }
    if bes_size is not None:
        body["bes_firmware"]["size"] = bes_size
    if full:
        body["mtk_full_ota"] = full
    return json.dumps(body).encode() + b"\n"


def patch(start, end, data, url=None):
    start_suffix = start.split("_", 1)[1]
    end_suffix = end.split("_", 1)[1]
    return {
        "start_firmware": start,
        "end_firmware": end,
        "url": url or f"https://downloads.example.test/mtk_ota_update_{start_suffix}_{end_suffix}.zip",
        "sha256": sha256(data),
        "size": len(data),
    }


def ab_zip(path, wipe="no", downgrade="no", powerwash="0"):
    payload_manifest = b"synthetic manifest"
    header = b"CrAU" + struct.pack(">QQI", 2, len(payload_manifest), 0)
    payload = header + payload_manifest + b"synthetic replacement data"
    encoded = lambda value: __import__("base64").b64encode(hashlib.sha256(value).digest()).decode()
    meta = {"ota-type": "AB", "ota-wipe": wipe, "ota-downgrade": downgrade}
    props = {
        "POWERWASH": powerwash,
        "FILE_SIZE": str(len(payload)),
        "FILE_HASH": encoded(payload),
        "METADATA_SIZE": str(len(header + payload_manifest)),
        "METADATA_HASH": encoded(header + payload_manifest),
    }
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr("payload.bin", payload)
        archive.writestr("payload_properties.txt", "\n".join(f"{k}={v}" for k, v in props.items()))
        archive.writestr("META-INF/com/android/metadata", "\n".join(f"{k}={v}" for k, v in meta.items()))
    return path.read_bytes()


class Fixture:
    def __init__(self, test, devices, documents, pin, resolve="dev"):
        self.root = Path(test)
        self.root.mkdir(parents=True, exist_ok=True)
        self.call_log = self.root / "calls.jsonl"
        self.state_path = self.root / "state.json"
        self.documents = {url: data for url, data in documents.items()}
        self.state = {"devices": devices, "bes_log": False, "home": "com.mentra.asg_client/com.mentra.asg_client.MainActivity"}
        self.state_path.write_text(json.dumps(self.state))
        self.bin = self.root / "bin"
        self.bin.mkdir(exist_ok=True)
        self._write("adb", self._adb())
        self._write("curl", self._curl())
        self._write("sleep", "#!/bin/sh\nexit 0\n")
        self._write("node", self._node())
        self._write("mtk-helper", self._helper("mtk"))
        self._write("bes-helper", self._helper("bes"))
        pin_path = self.root / "pin.json"
        pin_path.write_text(json.dumps(pin))
        self.env = {
            **os.environ,
            "PATH": f"{self.bin}:{os.environ['PATH']}",
            "HOME": str(self.root / "home"),
            "REAL_NODE": shutil.which("node"),
            "FIXTURE_STATE": str(self.state_path),
            "FIXTURE_CALLS": str(self.call_log),
            "FIXTURE_DOCS": str(self.root / "docs.json"),
            "FIXTURE_PIN": pin_path.read_text(),
            "FIXTURE_RESOLVE": resolve,
            "STOCK_UPDATE_MTK_HELPER": str(self.bin / "mtk-helper"),
            "STOCK_UPDATE_BES_HELPER": str(self.bin / "bes-helper"),
            "STOCK_UPDATE_BES_WAIT_SECONDS": "8",
            "STOCK_UPDATE_VERSION_WAIT_SECONDS": "1",
            "STOCK_UPDATE_BRIDGE_SHA256": sha256(BRIDGE),
            "STOCK_UPDATE_BRIDGE_SIZE": str(len(BRIDGE)),
            "STOCK_UPDATE_KEEP_WORK": "1",
            "MENTRA_REFURB_REPORT_DIR": str(self.root / "reports"),
        }
        (self.root / "docs.json").write_text(json.dumps({url: data.decode("latin1") for url, data in self.documents.items()}))
        (self.root / "home").mkdir(exist_ok=True)
        (self.root / "reports").mkdir(exist_ok=True)

    def _write(self, name, body):
        path = self.bin / name
        path.write_text(textwrap.dedent(body).lstrip("\n"))
        path.chmod(path.stat().st_mode | stat.S_IEXEC)

    def run(self, script, args, check=False):
        result = subprocess.run(["/bin/bash", str(script), *args], env=self.env, text=True,
                                capture_output=True, timeout=60)
        if check:
            self_ = result
            if self_.returncode != 0:
                raise AssertionError(self_.stdout + self_.stderr)
        return result

    def calls(self):
        if not self.call_log.exists():
            return []
        return [json.loads(line) for line in self.call_log.read_text().splitlines() if line.strip()]

    def reports(self):
        return sorted((self.root / "reports").glob("*.json"))

    def _node(self):
        return textwrap.dedent(r'''
            #!/usr/bin/env python3
            import json, os, sys
            args = sys.argv[1:]
            if not any(arg.endswith("resolve-glasses-release.mjs") for arg in args):
                os.execv(os.environ["REAL_NODE"], [os.environ["REAL_NODE"], *args])
            track = args[args.index("--track") + 1] if "--track" in args else "production"
            mode = os.environ["FIXTURE_RESOLVE"]
            open(os.environ["FIXTURE_CALLS"], "a").write(json.dumps(["node", track]) + "\n")
            if mode == "exit10" or (track == "production" and mode != "production"):
                sys.stderr.write("No published production glasses release\n")
                raise SystemExit(10)
            pin = json.loads(os.environ["FIXTURE_PIN"])
            if pin.get("track") not in (track, None):
                sys.stderr.write("resolver track mismatch\n")
                raise SystemExit(1)
            print(json.dumps(pin))
        ''')

    def _curl(self):
        return textwrap.dedent(r'''
            #!/usr/bin/env python3
            import json, os, sys
            args = sys.argv[1:]
            docs = {url: data.encode("latin1") for url, data in json.load(open(os.environ["FIXTURE_DOCS"])).items()}
            open(os.environ["FIXTURE_CALLS"], "a").write(json.dumps(["curl", *args]) + "\n")
            url = args[-1]
            if url not in docs:
                sys.stderr.write("unexpected url " + url + "\n")
                raise SystemExit(22)
            if "--head" in args:
                print("HTTP/1.1 200 OK")
                print("content-length:", len(docs[url]))
                raise SystemExit(0)
            output = args[args.index("--output") + 1]
            open(output, "wb").write(docs[url])
        ''')

    def _helper(self, kind):
        return textwrap.dedent(f'''
            #!/usr/bin/env python3
            import json, os, sys
            args = sys.argv[1:]
            state_path = os.environ["FIXTURE_STATE"]
            state = json.load(open(state_path))
            open(os.environ["FIXTURE_CALLS"], "a").write(json.dumps(["{kind}", *args]) + "\\n")
            if os.environ.get("FIXTURE_{kind.upper()}_FAIL") == "1":
                raise SystemExit(1)
            device = state["devices"][state.get("active", 0)]
            if "{kind}" == "mtk":
                end = args[args.index("--end-firmware") + 1]
                device["mtk"] = end
                device["boot_n"] = int(device.get("boot_n", 1)) + 1
                device["boot"] = "boot-%s" % device["boot_n"]
            else:
                device["bes"] = args[1]
                device["bes_readable"] = True
                state["bes_log"] = os.environ.get("FIXTURE_BES_LOG", "1") == "1"
                if os.environ.get("FIXTURE_BES_VERSION"):
                    device["bes"] = os.environ["FIXTURE_BES_VERSION"]
            json.dump(state, open(state_path, "w"))
        ''')

    def _adb(self):
        return textwrap.dedent(r'''
            #!/usr/bin/env python3
            import json, os, sys
            args = sys.argv[1:]
            state_path = os.environ["FIXTURE_STATE"]
            state = json.load(open(state_path))
            open(os.environ["FIXTURE_CALLS"], "a").write(json.dumps(["adb", *args]) + "\n")
            transport = None
            serial = None
            rest = []
            skip = ""
            for arg in args:
                if skip:
                    if skip == "-t":
                        transport = arg
                    elif skip == "-s":
                        serial = arg
                    skip = ""
                    continue
                if arg in ("-t", "-s"):
                    skip = arg
                    continue
                rest.append(arg)
            if rest[:2] == ["devices", "-l"] or rest == ["devices"]:
                print("List of devices attached")
                for index, device in enumerate(state["devices"], start=1):
                    if device.get("offline"):
                        print(f"{device['serial']}\toffline transport_id:{index}")
                    else:
                        print(f"{device['serial']}\tdevice transport_id:{index} model:{device['model'].replace(' ', '_')}")
                raise SystemExit(0)
            if transport is None and serial is not None:
                matches = [i for i, device in enumerate(state["devices"]) if device["serial"] == serial and not device.get("offline")]
                if len(matches) != 1:
                    sys.stderr.write("more than one device\n")
                    raise SystemExit(1)
                index = matches[0]
            elif transport is not None:
                index = int(transport) - 1
            else:
                ready = [i for i, device in enumerate(state["devices"]) if not device.get("offline")]
                index = ready[0] if len(ready) == 1 else None
            if index is None:
                sys.stderr.write("no device\n")
                raise SystemExit(1)
            device = state["devices"][index]
            state["active"] = index
            text = " ".join(rest)
            if "ro.product.model" in text:
                print(device["model"])
            elif "persist.mentra.live.mac" in text:
                print(device.get("mac", ""))
            elif "ro.serialno" in text:
                print(device.get("serialno", device["serial"]))
            elif "ro.custom.ota.version" in text:
                print(device["mtk"])
            elif "mmcblk0/device/cid" in text:
                print(device["cid"])
            elif "boot_id" in text:
                print(device.get("boot", "boot-1"))
            elif "sys.boot_completed" in text:
                print("1")
            elif "dumpsys package" in text:
                print(f"versionCode={device['asg_code']} versionName={device['asg_name']}")
            elif "pm path" in text and "thirdparty" in text:
                if device.get("thirdparty"):
                    print("package:com.mentra.asg_client.thirdparty")
            elif "pm path" in text:
                print("package:com.mentra.asg_client")
            elif "pm list packages -e" in text:
                print("package:com.mentra.asg_client")
                if device.get("thirdparty_enabled"):
                    print("package:com.mentra.asg_client.thirdparty")
            elif "resolve-activity" in text:
                print(device.get("home", state["home"]))
            elif rest[:1] == ["install"]:
                blob = open(rest[-1], "rb").read()
                if blob.startswith(b"bridge-apk"):
                    device["asg_code"] = "99999999"
                    device["asg_name"] = "36-bridge"
                    device["bes_readable"] = True
                else:
                    device["asg_code"] = "10"
                    device["asg_name"] = "10.0"
                print("Success")
            elif rest[:1] == ["uninstall"]:
                device["asg_code"] = "1"
                device["asg_name"] = "1.0"
            elif "set-home-activity" in text and "thirdparty" in text:
                device["home"] = "com.mentra.asg_client.thirdparty/com.mentra.asg_client.MainActivity"
                device["thirdparty_enabled"] = True
            elif "logcat" in rest and "-d" in rest:
                if device.get("bes_readable", True):
                    line = 'version_info_3 {"bes_fw_version":"%s","mtk_fw_version":"%s"}' % (device["bes"], device["mtk"])
                    print(line)
                    if state.get("bes_log"):
                        print("BES firmware update SUCCESS! BES will reboot.")
            elif rest[:2] == ["get-state"]:
                print("device")
            elif "printf" in text and "-f " in text:
                print("00", end="")
            elif "wc -l" in text:
                print("0")
            elif len(rest) >= 2 and rest[0] == "shell" and rest[1] == "test":
                raise SystemExit(1)
            json.dump(state, open(state_path, "w"))
        ''')


def device(**kwargs):
    value = {
        "serial": "ABC123",
        "model": "Mentra Live",
        "mac": "2C:BA:CA:25:D6:B8",
        "cid": "90014a68423861503e0300c12f4d5747",
        "asg_code": "10",
        "asg_name": "10.0",
        "mtk": "MentraLive_20260202",
        "bes": "1.2.3.4",
        "bes_readable": True,
        "serialno": "ABC123",
    }
    value.update(kwargs)
    return value


def pin_for(body, track="dev", identity="9.9.9-dev.1", url="https://downloads.example.test/manifest.json"):
    return {
        "track": track,
        "channel": "dev" if track == "dev" else track,
        "releaseIdentity": identity,
        "otaUrl": url,
        "otaSha256": sha256(body),
    }


class RefurbFixtureTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)

    def documents_for(self, body, extra=None):
        docs = {
            "https://downloads.example.test/manifest.json": body,
            "https://downloads.example.test/asg.apk": APK,
            "https://downloads.example.test/bes_firmware.bin": BES,
            "https://drive.usercontent.google.com/download?id=165WODzaMXkvpL5V3PQ28391wQQietxSQ&export=download&confirm=t": BRIDGE,
        }
        if extra:
            docs.update(extra)
        return docs

    def current_body(self):
        return manifest(sha256(APK), sha256(BES), [patch("MentraLive_20260101", "MentraLive_20260202", PATCH)], bes_size=len(BES))

    def test_no_device_offline_and_wrong_model_fail_before_mutation(self):
        body = self.current_body()
        for devices, args in (
            ([], []),
            ([device(offline=True)], []),
            ([device(model="Samsung")], ["--serial", "ABC123"]),
        ):
            with self.subTest(devices=devices, args=args):
                fix = Fixture(self.temp.name + "/case", devices, self.documents_for(body), pin_for(body))
                result = fix.run(REFURB, ["--track", "dev", *args])
                self.assertEqual(result.returncode, 11, result.stdout + result.stderr)
                self.assertFalse(any(call[0] == "adb" and "install" in call for call in fix.calls()))
                report = json.loads(fix.reports()[0].read_text())
                self.assertEqual(report["result"], "FAIL")

    def test_placeholder_serials_require_cid_and_only_that_transport_is_updated(self):
        body = self.current_body()
        e511 = device(serial=PLACEHOLDER, cid="1501003458364b4d4203b71dcc5eb7b3", mac="2C:BA:CA:25:E5:11",
                      asg_code="1", asg_name="1.0")
        target = device(serial=PLACEHOLDER, asg_code="9", asg_name="9.0")
        fix = Fixture(self.temp.name, [e511, target], self.documents_for(body), pin_for(body))
        refused = fix.run(REFURB, ["--track", "dev"])
        self.assertEqual(refused.returncode, 11, refused.stdout + refused.stderr)
        self.assertIn("1501003458364b4d4203b71dcc5eb7b3", refused.stderr + refused.stdout)
        (fix.root / "calls.jsonl").write_text("")
        result = fix.run(REFURB, ["--track", "dev", "--cid", target["cid"]])
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        installs = [call for call in fix.calls() if call[:2] == ["adb", "-t"] and "install" in call]
        self.assertTrue(installs)
        self.assertTrue(all(call[2] == "2" for call in installs))
        self.assertNotIn("1", [call[2] for call in installs])

    def test_duplicate_real_serial_selected_by_cid_pins_transport(self):
        body = self.current_body()
        other = device(serial="DUP123", cid="1501003458364b4d4203b71dcc5eb7b3",
                       mac="2C:BA:CA:25:E5:11", asg_code="1", asg_name="1.0")
        target = device(serial="DUP123", asg_code="9", asg_name="9.0")
        fix = Fixture(self.temp.name, [other, target], self.documents_for(body), pin_for(body))
        result = fix.run(REFURB, ["--track", "dev", "--cid", target["cid"]])
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        # The shared real serial is ambiguous, so it must never become the -s
        # selector; every pinned call targets the CID-selected unit's transport.
        self.assertFalse(any(call[:2] == ["adb", "-s"] for call in fix.calls()))
        installs = [call for call in fix.calls() if call[:2] == ["adb", "-t"] and "install" in call]
        self.assertTrue(installs)
        self.assertTrue(all(call[2] == "2" for call in installs))
        self.assertNotIn("1", [call[2] for call in installs])

    def test_recovery_and_legacy_updater_are_re_enabled_after_success(self):
        body = self.current_body()
        fix = Fixture(self.temp.name, [device(asg_code="9", asg_name="9.0")], self.documents_for(body), pin_for(body))
        result = fix.run(REFURB, ["--track", "dev", "--serial", "ABC123"])
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        text = [" ".join(call) for call in fix.calls() if call[0] == "adb"]
        for package in ("com.mentra.recovery", "com.augmentos.otaupdater"):
            disabled = max(i for i, line in enumerate(text) if "disable-user" in line and package in line)
            enabled = max(i for i, line in enumerate(text) if " pm enable " in line and package in line)
            self.assertGreater(enabled, disabled, package)

    def test_unique_real_serial_works_without_cid(self):
        body = self.current_body()
        fix = Fixture(self.temp.name, [device()], self.documents_for(body), pin_for(body))
        result = fix.run(REFURB, ["--track", "dev", "--serial", "ABC123"])
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        report = json.loads(fix.reports()[0].read_text())
        self.assertEqual(report["device"]["cid"], device()["cid"])
        self.assertEqual(report["device"]["mac"], device()["mac"])
        self.assertNotEqual(report["device"]["adbSerial"], PLACEHOLDER)
        self.assertEqual(report["result"], "PASS")
        self.assertGreaterEqual(report["elapsedSeconds"], 0)
        # A successful stock refurb must re-enable the recovery heartbeat and
        # legacy OTA updater it disabled before mutation; stock is the launcher.
        enabled = {call[-1] for call in fix.calls()
                   if call[0] == "adb" and "pm" in call and "enable" in call}
        self.assertIn("com.mentra.recovery", enabled)
        self.assertIn("com.augmentos.otaupdater", enabled)

    def test_current_glasses_do_not_flash(self):
        body = self.current_body()
        fix = Fixture(self.temp.name, [device()], self.documents_for(body), pin_for(body))
        result = fix.run(REFURB, ["--track", "dev", "--serial", "ABC123"])
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertFalse(any(call[0] in ("mtk", "bes") for call in fix.calls()))
        self.assertNotIn("install", " ".join(" ".join(call) for call in fix.calls() if call[0] == "adb"))

    def test_older_stock_asg_is_installed_and_reread(self):
        body = self.current_body()
        fix = Fixture(self.temp.name, [device(asg_code="9", asg_name="9.0")], self.documents_for(body), pin_for(body))
        result = fix.run(REFURB, ["--track", "dev", "--serial", "ABC123"])
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("10.0", result.stdout)
        report = json.loads(fix.reports()[0].read_text())
        self.assertEqual(report["versions"]["final"]["asgVersionName"], "10.0")
        self.assertEqual(report["versions"]["before"]["asgVersionCode"], "9")

    def test_prerelease_asg_is_replaced_and_announced(self):
        body = self.current_body()
        fix = Fixture(self.temp.name, [device(asg_code="303007082", asg_name="303007082-dev")],
                      self.documents_for(body), pin_for(body))
        result = fix.run(REFURB, ["--track", "dev", "--serial", "ABC123"])
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("prerelease", result.stdout)
        self.assertIn("10.0", result.stdout)

    def test_newer_stock_asg_is_retained_and_newer_mtk_or_bes_exits_14(self):
        body = self.current_body()
        retained = Fixture(self.temp.name + "/keep", [device(asg_code="11", asg_name="11.0")],
                           self.documents_for(body), pin_for(body))
        kept = retained.run(REFURB, ["--track", "dev", "--serial", "ABC123"])
        self.assertEqual(kept.returncode, 0, kept.stdout + kept.stderr)
        self.assertIn("Retaining", kept.stdout)
        self.assertFalse(any("install" in call for call in retained.calls() if call[0] == "adb"))
        newer_mtk = Fixture(self.temp.name + "/mtk", [device(mtk="MentraLive_20270101")],
                            self.documents_for(body), pin_for(body))
        result = newer_mtk.run(REFURB, ["--track", "dev", "--serial", "ABC123"])
        self.assertEqual(result.returncode, 14, result.stdout + result.stderr)
        self.assertFalse(any("install" in call for call in newer_mtk.calls() if call[0] == "adb"))
        newer_bes = Fixture(self.temp.name + "/bes", [device(bes="9.9.9.9")],
                            self.documents_for(body), pin_for(body))
        result = newer_bes.run(REFURB, ["--track", "dev", "--serial", "ABC123"])
        self.assertEqual(result.returncode, 14, result.stdout + result.stderr)

    def test_patch_chain_and_failed_patch_does_not_start_full(self):
        first = patch("MentraLive_20260101", "MentraLive_20260102", PATCH)
        second = patch("MentraLive_20260102", "MentraLive_20260202", PATCH2)
        body = manifest(sha256(APK), sha256(BES), [first, second], bes_size=len(BES))
        docs = self.documents_for(body, {first["url"]: PATCH, second["url"]: PATCH2})
        fix = Fixture(self.temp.name + "/chain", [device(mtk="MentraLive_20260101")], docs, pin_for(body))
        result = fix.run(REFURB, ["--track", "dev", "--serial", "ABC123"])
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        mtk_calls = [call for call in fix.calls() if call[0] == "mtk"]
        self.assertEqual(len(mtk_calls), 2)
        self.assertTrue(all("--full" not in call for call in mtk_calls))
        failed = Fixture(self.temp.name + "/fail", [device(mtk="MentraLive_20260101")], docs, pin_for(body))
        failed.env["FIXTURE_MTK_FAIL"] = "1"
        result = failed.run(REFURB, ["--track", "dev", "--serial", "ABC123"])
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(len([call for call in failed.calls() if call[0] == "mtk"]), 1)
        self.assertNotIn("--full", " ".join(" ".join(call) for call in failed.calls()))

    def test_full_image_is_used_only_when_no_patch_exists_and_wipe_is_rejected(self):
        full_path = Path(self.temp.name) / "full.zip"
        blob = ab_zip(full_path)
        full = {
            "end_firmware": "MentraLive_20260404",
            "url": "https://downloads.example.test/full.zip",
            "sha256": sha256(blob),
            "size": len(blob),
        }
        body = manifest(sha256(APK), sha256(BES), [patch("MentraLive_20260101", "MentraLive_20260202", PATCH)],
                        full=full, bes_size=len(BES))
        docs = self.documents_for(body, {full["url"]: blob, patch("MentraLive_20260101", "MentraLive_20260202", PATCH)["url"]: PATCH})
        fix = Fixture(self.temp.name + "/full", [device(mtk="MentraLive_20260303")], docs, pin_for(body))
        result = fix.run(REFURB, ["--track", "dev", "--serial", "ABC123"])
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        mtk_calls = [call for call in fix.calls() if call[0] == "mtk"]
        self.assertEqual(len(mtk_calls), 1)
        self.assertIn("--full", mtk_calls[0])
        wipe_path = Path(self.temp.name) / "wipe.zip"
        wipe_blob = ab_zip(wipe_path, wipe="yes", downgrade="yes", powerwash="1")
        wipe_full = {**full, "sha256": sha256(wipe_blob), "size": len(wipe_blob)}
        wipe_body = manifest(sha256(APK), sha256(BES), [patch("MentraLive_20260101", "MentraLive_20260202", PATCH)],
                             full=wipe_full, bes_size=len(BES))
        wipe_docs = self.documents_for(wipe_body, {wipe_full["url"]: wipe_blob})
        rejected = Fixture(self.temp.name + "/wipe", [device(mtk="MentraLive_20260303")], wipe_docs, pin_for(wipe_body))
        result = rejected.run(REFURB, ["--track", "dev", "--serial", "ABC123"])
        self.assertEqual(result.returncode, 12, result.stdout + result.stderr)
        self.assertFalse(any(call[0] == "mtk" for call in rejected.calls()))

    def test_bad_hash_fails_before_install(self):
        body = manifest("a" * 64, sha256(BES), [patch("MentraLive_20260101", "MentraLive_20260202", PATCH)], bes_size=len(BES))
        fix = Fixture(self.temp.name, [device(asg_code="9", asg_name="9.0")], self.documents_for(body), pin_for(body))
        result = fix.run(REFURB, ["--track", "dev", "--serial", "ABC123"])
        self.assertEqual(result.returncode, 12, result.stdout + result.stderr)
        self.assertFalse(any("install" in call for call in fix.calls() if call[0] == "adb"))

    def test_bes_without_fresh_version_fails_and_bridge_runs_only_after_mtk(self):
        body = self.current_body()
        stale = Fixture(self.temp.name + "/stale", [device(bes="1.0.0.0")], self.documents_for(body), pin_for(body))
        stale.env["FIXTURE_BES_VERSION"] = "1.2.3.5"
        result = stale.run(REFURB, ["--track", "dev", "--serial", "ABC123"])
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("not pinned", result.stdout + result.stderr)
        first = patch("MentraLive_20260101", "MentraLive_20260202", PATCH)
        docs = self.documents_for(body, {first["url"]: PATCH})
        day_one = Fixture(self.temp.name + "/day1", [device(mtk="MentraLive_20260101", bes_readable=False, bes="0.0.0.0")],
                          docs, pin_for(body))
        result = day_one.run(REFURB, ["--track", "dev", "--serial", "ABC123"])
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        names = [call[0] for call in day_one.calls()]
        self.assertLess(names.index("mtk"), names.index("bes"))
        install_blobs = []
        for call in day_one.calls():
            if call[0] == "adb" and "install" in call:
                install_blobs.append(Path(call[-1]).read_bytes()[:6] if Path(call[-1]).exists() else b"")
        self.assertIn(b"bridge", install_blobs)
        self.assertGreater(install_blobs.index(b"bridge"), -1)
        self.assertIn("compatibility bridge", result.stdout)

    def test_third_party_refurb_is_refused_and_developer_wrapper_restores_it(self):
        body = self.current_body()
        refused = Fixture(self.temp.name + "/refuse", [device(thirdparty_enabled=True)], self.documents_for(body), pin_for(body))
        result = refused.run(REFURB, ["--track", "dev", "--serial", "ABC123"])
        self.assertEqual(result.returncode, 11, result.stdout + result.stderr)
        self.assertIn("update-mentra-live.sh", result.stdout + result.stderr)
        self.assertFalse(any(call[0] == "curl" for call in refused.calls()))
        restored = Fixture(self.temp.name + "/dev", [device(asg_code="99999999", asg_name="36-bridge", thirdparty=True)],
                           self.documents_for(body), pin_for(body))
        result = restored.run(DEV, ["--manifest-url", "https://downloads.example.test/manifest.json", "--resume-thirdparty"])
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("third-party", result.stdout)
        self.assertTrue(any("thirdparty" in " ".join(call) for call in restored.calls()))

    def test_production_resolution_failure_and_synthetic_url_and_two_units(self):
        body = self.current_body()
        exact = "https://downloads.example.test/promoted/mentra-live-ota-9.9.9-beta.1.json"
        docs = self.documents_for(body)
        docs[exact] = body
        closed = Fixture(self.temp.name + "/closed", [device(), device(serial=PLACEHOLDER, cid="abc")], docs, pin_for(body), resolve="exit10")
        result = closed.run(REFURB, ["--track", "production", "--serial", "ABC123"])
        self.assertEqual(result.returncode, 10, result.stdout + result.stderr)
        report = json.loads(closed.reports()[0].read_text())
        self.assertEqual(report["result"], "FAIL")
        self.assertFalse(any(call[0] == "curl" and any(arg.endswith("asg.apk") for arg in call) for call in closed.calls()))
        both = Fixture(self.temp.name + "/both", [
            device(serial=PLACEHOLDER, cid="1501003458364b4d4203b71dcc5eb7b3", mac="2C:BA:CA:25:E5:11"),
            device(serial=PLACEHOLDER),
        ], docs, pin_for(body), resolve="exit10")
        result = both.run(REFURB, ["--track", "production"])
        self.assertEqual(result.returncode, 10, result.stdout + result.stderr)
        self.assertIn("1501003458364b4d4203b71dcc5eb7b3", result.stdout + result.stderr)
        self.assertFalse(any(call[0] == "curl" for call in both.calls()))
        self.assertFalse(any("install" in call for call in both.calls() if call[0] == "adb"))
        published = pin_for(body, track="production", identity="9.9.9", url=exact)
        opened = Fixture(self.temp.name + "/open", [device()], docs, published, resolve="production")
        result = opened.run(REFURB, ["--track", "production", "--serial", "ABC123"])
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertTrue(any(exact in call for call in opened.calls() if call[0] == "curl"))
        first = Fixture(self.temp.name + "/u1", [device(serial="UNIT1", serialno="UNIT1")], docs, pin_for(body))
        second = Fixture(self.temp.name + "/u2", [device(serial="UNIT2", serialno="UNIT2", cid="cid-unit-2", mac="AA:BB:CC:DD:EE:02")],
                         docs, pin_for(body))
        self.assertEqual(first.run(REFURB, ["--track", "dev", "--serial", "UNIT1"]).returncode, 0)
        self.assertEqual(second.run(REFURB, ["--track", "dev", "--serial", "UNIT2"]).returncode, 0)
        self.assertEqual(len(first.reports()), 1)
        self.assertEqual(len(second.reports()), 1)


if __name__ == "__main__":
    unittest.main()
