import json
import shlex
import sys
import unittest

import support  # noqa: F401 - sets sys.path
from blespeed import adbio
from blespeed.adbio import (
    AdbDevice,
    AdbError,
    BleImgIdGenerator,
    ProcessResult,
    SubprocessRunner,
    broadcast_args,
    check_ok,
    parse_adb_devices,
    parse_battery_level,
    parse_package_versions,
    resolve_glasses_serial,
    take_photo_payload,
)


def remote_json(args):
    remote = shlex.split(args[4])
    return remote, json.loads(remote[remote.index("--es") + 2])


class BroadcastTest(unittest.TestCase):
    def test_directed_broadcast_shape(self):
        payload = take_photo_payload("bspd-a-Amed-001", "I000000001", "medium")
        args = broadcast_args("G1", payload)
        self.assertEqual(["adb", "-s", "G1", "shell"], args[:4])
        self.assertEqual(5, len(args))
        remote, body = remote_json(args)
        self.assertEqual(["am", "broadcast", "-a", adbio.SEND_COMMAND_ACTION,
                          "-p", adbio.ASG_PACKAGE, "--es", "json"], remote[:8])
        self.assertEqual(payload, body)

    def test_json_round_trips_hostile_strings(self):
        for rid in ["it's", 'q"uote', "sp ace", "semi;colon", "$(whoami)", "back\\slash", "ünï"]:
            with self.subTest(rid=rid):
                payload = take_photo_payload(rid, "I000000001", "max")
                _remote, body = remote_json(broadcast_args("G1", payload))
                self.assertEqual(rid, body["requestId"])

    def test_take_photo_payload_fields(self):
        payload = take_photo_payload("r", "I000000001", "max")
        self.assertEqual({
            "type": "take_photo", "requestId": "r", "bleImgId": "I000000001",
            "transferMethod": "ble", "size": "max", "mode": "photo", "compress": "none",
            "save": False, "sound": False, "flash": False,
        }, payload)

    def test_ble_img_id_length_guard(self):
        with self.assertRaises(ValueError):
            take_photo_payload("r", "I" + "0" * 11, "medium")
        with self.assertRaises(ValueError):
            take_photo_payload("r", "", "medium")

    def test_disconnect_wifi(self):
        _remote, body = remote_json(broadcast_args("G1", adbio.disconnect_wifi_payload()))
        self.assertEqual({"type": "disconnect_wifi"}, body)


class BleImgIdTest(unittest.TestCase):
    def test_unique_and_well_formed(self):
        gen = BleImgIdGenerator()
        ids = [gen() for _ in range(10_000)]
        self.assertEqual(10_000, len(set(ids)))
        for value in ids[:50] + ids[-50:]:
            self.assertRegex(value, r"^I\d{9}$")
            self.assertLessEqual(len(value), adbio.MAX_BLE_IMG_ID_LEN)

    def test_wraps_at_nine_digits(self):
        gen = BleImgIdGenerator(seed=999_999_999)
        self.assertEqual("I999999999", gen())
        self.assertEqual("I000000000", gen())


class DevicesTest(unittest.TestCase):
    def test_parse(self):
        out = ("* daemon started successfully\nList of devices attached\nG1\tdevice\n"
               "P1\tunauthorized\nemulator-5554\toffline\n\n")
        self.assertEqual([AdbDevice("G1", "device"), AdbDevice("P1", "unauthorized"),
                          AdbDevice("emulator-5554", "offline")], parse_adb_devices(out))

    def test_zero_devices(self):
        with self.assertRaisesRegex(AdbError, "found: none"):
            resolve_glasses_serial([], None)

    def test_one_device(self):
        self.assertEqual("G1", resolve_glasses_serial([AdbDevice("G1", "device")], None))

    def test_two_devices_need_serial(self):
        devices = [AdbDevice("G1", "device"), AdbDevice("P1", "device")]
        with self.assertRaisesRegex(AdbError, "exactly 1"):
            resolve_glasses_serial(devices, None)
        self.assertEqual("G1", resolve_glasses_serial(devices, "G1"))

    def test_unauthorized_or_offline_blocks_auto_pick(self):
        for state in ("unauthorized", "offline"):
            with self.subTest(state=state):
                devices = [AdbDevice("G1", "device"), AdbDevice("P1", state)]
                with self.assertRaises(AdbError):
                    resolve_glasses_serial(devices, None)

    def test_requested_serial_must_be_ready(self):
        with self.assertRaisesRegex(AdbError, "unauthorized"):
            resolve_glasses_serial([AdbDevice("G1", "unauthorized")], "G1")
        with self.assertRaisesRegex(AdbError, "not found"):
            resolve_glasses_serial([AdbDevice("G1", "device")], "G2")


class ProcessTest(unittest.TestCase):
    def test_check_ok_raises_with_detail(self):
        with self.assertRaisesRegex(AdbError, r"exit 1\): error: device offline"):
            check_ok(ProcessResult(1, "", "error: device offline\n"), "adb shell")
        self.assertEqual("ok", check_ok(ProcessResult(0, "ok"), "x"))

    def test_subprocess_runner_reports_nonzero_exit(self):
        result = SubprocessRunner().run([sys.executable, "-c", "import sys; sys.exit(3)"])
        self.assertEqual(3, result.returncode)
        with self.assertRaises(AdbError):
            check_ok(result, "python")

    def test_subprocess_runner_missing_binary(self):
        with self.assertRaisesRegex(AdbError, "command not found"):
            SubprocessRunner().run(["definitely-not-a-real-binary-bspd"])

    def test_subprocess_stream_filters_and_sinks(self):
        import io
        sink = io.StringIO()
        code = "print('keep 1'); print('drop'); print('keep 2')"
        source = SubprocessRunner().stream([sys.executable, "-c", code], sink=sink,
                                           keep=lambda line: line.startswith("keep"))
        lines = [source.get(5.0), source.get(5.0)]
        self.assertEqual(["keep 1", "keep 2"], lines)
        self.assertIsNone(source.get(0.2))
        source.close()
        self.assertEqual("keep 1\nkeep 2\n", sink.getvalue())


class ParsersTest(unittest.TestCase):
    def test_battery(self):
        self.assertEqual(87, parse_battery_level("Current Battery Service state:\n  AC powered: false\n  level: 87\n  scale: 100\n"))
        self.assertIsNone(parse_battery_level("nothing"))
        self.assertIsNone(parse_battery_level("  level: n/a"))

    def test_package_versions(self):
        text = ("    versionCode=1234 minSdk=28 targetSdk=34\n    versionName=3.1.0-dev.40\n"
                "    lastUpdateTime=2026-09-28 15:00:00\n")
        self.assertEqual({"versionCode": "1234", "versionName": "3.1.0-dev.40",
                          "lastUpdateTime": "2026-09-28 15:00:00"}, parse_package_versions(text))
        self.assertEqual({}, parse_package_versions(""))


if __name__ == "__main__":
    unittest.main()
