import contextlib
import csv
import io
import json
import tempfile
import unittest
from pathlib import Path

import support
from support import FakeAdb, FakeClock, busy_response, finished_response, received_only_response

from blespeed.adbio import BleImgIdGenerator, ProcessRunner
from blespeed.outcome import TrackerConfig
from blespeed.results import COLUMNS, read_rows
from blespeed.session import CellConfig, CellSession

import run_cell

PHONE_LINES = [
    (1.0, "09-28 16:00:01.000 9001 9022 I ReactNativeJS: 'CORE:', 'LIVE: L2CAP: channel open (PSM 0xC9)'"),
    (2.0, "09-28 16:00:02.000 9001 9022 I ReactNativeJS: 'CORE:', 'LIVE: unrelated status'"),
    (3.0, "09-28 16:00:03.000 9001 9022 I chatty: noise that the keep filter drops"),
]


class ExplodingRunner(ProcessRunner):
    def run(self, args, timeout=30.0):
        raise AssertionError("dry run must not execute: %s" % args)

    def stream(self, args, sink=None, keep=None):
        raise AssertionError("dry run must not stream: %s" % args)


class RunCellEndToEndTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.out = Path(self.tmp.name)
        self.clock = FakeClock()

    def tearDown(self):
        self.tmp.cleanup()

    def config(self, **overrides):
        values = dict(phone="pixel8", phone_os="android", condition="A", size="medium",
                      out_root=self.out, count=5, glasses_serial="G1", phone_serial="P1",
                      wait_transport_s=5.0, run_id="run1", asg_commit="abc123",
                      app_build="3.1.0-dev.40", tracker=TrackerConfig())
        values.update(overrides)
        return CellConfig(**values)

    def run_session(self, fake, **overrides):
        session = CellSession(self.config(**overrides), fake, clock=self.clock,
                              id_gen=BleImgIdGenerator(seed=5), log=lambda _m: None)
        return session.run()

    def test_five_photo_cell_with_busy_retry_timeout_and_transfer_retry(self):
        fake = FakeAdb(self.clock, photo_responses=[
            finished_response(),                                        # warm-up
            finished_response(phone_confirm_ms=2500),                   # 1
            busy_response(), finished_response(phone_confirm_ms=2000),  # 2 (busy, resend)
            received_only_response(),                                   # 3 times out
            finished_response(phone_confirm_ms=3200, extra=[
                "❌ Phone reported failure - need to retry transfer"]),   # 4
            finished_response(payload=102400, phone_confirm_ms=1000),   # 5
        ], phone_lines=PHONE_LINES)
        result = self.run_session(fake)

        self.assertIsNone(result.aborted)
        run_dir = self.out / "run1"
        self.assertEqual(run_dir, result.run_dir)
        self.assertEqual(7, len(fake.photo_broadcasts))
        self.assertEqual(fake.photo_broadcasts[2]["requestId"], fake.photo_broadcasts[3]["requestId"])
        self.assertEqual("disconnect_wifi", fake.broadcasts[0]["type"])

        with (run_dir / "results.csv").open(newline="") as handle:
            reader = csv.DictReader(handle)
            self.assertEqual(COLUMNS, reader.fieldnames)
            raw = list(reader)
        self.assertEqual(6, len(raw))

        rows = read_rows(run_dir / "results.csv")
        self.assertEqual([True, False, False, False, False, False], [r.warmup for r in rows])
        self.assertEqual([0, 1, 2, 3, 4, 5], [r.index for r in rows])
        self.assertEqual(["finished", "finished", "finished", "timeout", "finished", "finished"],
                         [r.outcome for r in rows])
        self.assertEqual(1, rows[2].busy_retries)
        self.assertEqual(1, rows[4].transfer_retries)
        self.assertEqual("no_outcome_after_60s", rows[3].failure_reason)
        self.assertIsNone(rows[3].e2e_kbps)
        self.assertEqual(80.0, rows[1].e2e_kbps)    # 200 KB / 2.5 s
        self.assertEqual(100.0, rows[2].e2e_kbps)   # 200 KB / 2.0 s
        self.assertEqual(62.5, rows[4].e2e_kbps)    # 200 KB / 3.2 s
        self.assertEqual(100.0, rows[5].e2e_kbps)   # 100 KB / 1.0 s
        self.assertEqual(150, rows[1].last_packet_to_phone_ack_ms)
        self.assertEqual({"l2cap"}, {r.transport for r in rows})
        self.assertTrue(all(r.request_id.startswith("bspd-") and "-Amed-" in r.request_id
                            for r in rows))
        self.assertTrue(rows[0].request_id.endswith("-w00"))
        self.assertEqual(len(rows), len({r.ble_img_id for r in rows}))

        prov = json.loads((run_dir / "provenance.json").read_text())
        self.assertIsNone(prov["aborted"])
        self.assertEqual({"run_id", "created_at", "condition", "size", "count", "app_build",
                          "notes", "tracker", "required_baud", "tool", "aborted", "glasses",
                          "phone", "transport", "photos"}, set(prov))
        glasses = prov["glasses"]
        self.assertEqual("G1", glasses["serial"])
        self.assertEqual(1152000, glasses["uart_baud"])
        self.assertEqual("link_ready_fast", glasses["uart_baud_source"])
        self.assertEqual("17.26.7.5", glasses["bes_firmware"])
        self.assertEqual("3.1.0-dev.40", glasses["asg_version_name"])
        self.assertEqual("abc123", glasses["asg_commit"])
        self.assertEqual(87, glasses["battery_pct_start"])
        self.assertEqual(87, glasses["battery_pct_end"])
        self.assertTrue(glasses["timing_logs_observed"])
        self.assertEqual([], glasses["uart_baud_changes_during_session"])
        self.assertEqual({"label": "pixel8", "os": "android", "serial": "P1", "udid": None,
                          "model": "Pixel 8", "os_version": "16"}, prov["phone"])
        self.assertEqual("l2cap", prov["transport"]["session_label"])
        self.assertEqual({"recorded": 6, "finished": 5}, prov["photos"])

        glasses_log = (run_dir / "glasses-logcat.txt").read_text()
        self.assertIn("PIPELINE FINISHED", glasses_log)
        phone_log = (run_dir / "phone-log.txt").read_text()
        self.assertIn("L2CAP: channel open", phone_log)
        self.assertNotIn("chatty", phone_log)
        self.assertTrue(all(s.closed for s in fake.sources))

    def test_aborts_before_any_photo_when_baud_is_slow(self):
        dump = support.glasses_line("BAUD-SWITCH", "Serial port opened at 460800 baud") + "\n"
        fake = FakeAdb(self.clock, photo_responses=[finished_response()], dump=dump)
        result = self.run_session(fake)
        self.assertEqual("UART is at 460800 baud, need 1152000", result.aborted)
        self.assertEqual([], fake.photo_broadcasts)
        prov = json.loads((result.run_dir / "provenance.json").read_text())
        self.assertEqual(result.aborted, prov["aborted"])
        self.assertEqual(460800, prov["glasses"]["uart_baud"])
        self.assertEqual([], read_rows(result.run_dir / "results.csv"))

    def test_aborts_without_baud_line_unless_allowed(self):
        fake = FakeAdb(self.clock, dump="")
        result = self.run_session(fake)
        self.assertIn("no UART baud line", result.aborted)

        fake = FakeAdb(self.clock, dump="", photo_responses=[finished_response()] * 2)
        result = self.run_session(fake, run_id="run2", allow_unknown_baud=True, count=1)
        self.assertIsNone(result.aborted)
        self.assertEqual(2, len(result.rows))

    def test_aborts_when_baud_drops_mid_session(self):
        slow = support.glasses_line("BAUD-SWITCH", "Serial port opened at 460800 baud")
        fake = FakeAdb(self.clock, photo_responses=[
            finished_response(),
            [(0.5, slow)] + finished_response(),
            finished_response(),
        ])
        result = self.run_session(fake, count=3)
        self.assertEqual("UART baud changed to 460800 mid-session", result.aborted)
        self.assertEqual(1, len(result.rows))  # only the warm-up completed
        prov = json.loads((result.run_dir / "provenance.json").read_text())
        self.assertEqual([{"baud": 460800, "source": "serial_opened"}],
                         prov["glasses"]["uart_baud_changes_during_session"])

    def test_dropped_broadcast_is_reported_not_received(self):
        fake = FakeAdb(self.clock, photo_responses=[[], finished_response()])
        result = self.run_session(fake, count=1)
        self.assertEqual(["not_received", "finished"], [r.outcome for r in result.rows])

    def test_two_devices_without_serial_aborts_with_guidance(self):
        fake = FakeAdb(self.clock)
        result = self.run_session(fake, glasses_serial=None)
        self.assertIn("exactly 1 ready adb device", result.aborted)
        self.assertEqual([], fake.photo_broadcasts)

    def test_phone_serial_equal_to_glasses_is_rejected(self):
        result = self.run_session(FakeAdb(self.clock), phone_serial="G1")
        self.assertIn("must differ", result.aborted)

    def test_ios_uses_idevicesyslog_and_ideviceinfo(self):
        fake = FakeAdb(self.clock, photo_responses=[finished_response()] * 2,
                       phone_lines=[(0.5, "Sep 28 16:00 iPhone MentraOS[1] <Notice>: "
                                          "LIVE: L2CAP: channel open (PSM 0xC9)")])
        result = self.run_session(fake, phone="iphone15", phone_os="ios", phone_serial=None,
                                  phone_udid="UDID-1", count=1)
        self.assertIsNone(result.aborted)
        self.assertIn(["idevicesyslog", "-u", "UDID-1"], fake.calls)
        self.assertEqual("iPhone16,1", result.provenance["phone"]["model"])
        self.assertEqual("26.0", result.provenance["phone"]["os_version"])
        self.assertEqual("l2cap", result.rows[-1].transport)

    def test_no_warmup_no_disconnect(self):
        fake = FakeAdb(self.clock, photo_responses=[finished_response()])
        result = self.run_session(fake, count=1, warmup=False, disconnect_wifi=False,
                                  phone_serial=None, wait_transport_s=0)
        self.assertEqual([False], [r.warmup for r in result.rows])
        self.assertEqual([], [b for b in fake.broadcasts if b["type"] == "disconnect_wifi"])
        self.assertEqual("unknown", result.rows[0].transport)

    def test_existing_run_dir_is_not_overwritten(self):
        (self.out / "run1").mkdir()
        with self.assertRaises(FileExistsError):
            self.run_session(FakeAdb(self.clock))


class RunCellCliTest(unittest.TestCase):
    def test_dry_run_makes_no_adb_calls(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = run_cell.main(["--phone", "pixel8", "--phone-os", "android", "--phone-serial",
                                  "P1", "--glasses-serial", "G1", "--condition", "B", "--size",
                                  "max", "--count", "3", "--dry-run"],
                                 runner=ExplodingRunner(), id_gen=BleImgIdGenerator(seed=1))
        self.assertEqual(0, code)
        lines = out.getvalue().splitlines()
        photo_lines = [l for l in lines if "take_photo" in l]
        self.assertEqual(4, len(photo_lines))  # warm-up + 3
        self.assertTrue(all("-p com.mentra.asg_client" in l for l in photo_lines))
        self.assertIn('"size":"max"', photo_lines[0])
        self.assertTrue(any("disconnect_wifi" in l for l in lines))
        self.assertIn("adb -s P1 logcat -v threadtime -T 1", lines)

    def test_invalid_arguments(self):
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            code = run_cell.main(["--phone", "iphone", "--phone-os", "ios", "--phone-serial", "X",
                                  "--condition", "A", "--size", "medium", "--dry-run"],
                                 runner=ExplodingRunner())
        self.assertEqual(2, code)
        self.assertIn("--phone-udid", err.getvalue())
        with contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit):
                run_cell.main(["--phone", "p", "--phone-os", "android", "--condition", "Z",
                               "--size", "medium"])

    def test_main_returns_1_on_abort(self):
        clock = FakeClock()
        dump = support.glasses_line("BAUD-SWITCH", "Serial port opened at 460800 baud") + "\n"
        with tempfile.TemporaryDirectory() as tmp, contextlib.redirect_stdout(io.StringIO()):
            code = run_cell.main(["--phone", "pixel8", "--phone-os", "android", "--glasses-serial",
                                  "G1", "--condition", "A", "--size", "medium", "--out", tmp],
                                 runner=FakeAdb(clock, dump=dump), clock=clock)
        self.assertEqual(1, code)

    def test_main_success(self):
        clock = FakeClock()
        fake = FakeAdb(clock, photo_responses=[finished_response()] * 3)
        out = io.StringIO()
        with tempfile.TemporaryDirectory() as tmp, contextlib.redirect_stdout(out):
            code = run_cell.main(["--phone", "pixel8", "--phone-os", "android", "--glasses-serial",
                                  "G1", "--condition", "C", "--size", "medium", "--count", "2",
                                  "--out", tmp, "--run-id", "cli"],
                                 runner=fake, clock=clock, id_gen=BleImgIdGenerator(seed=9))
            self.assertTrue((Path(tmp) / "cli" / "results.csv").is_file())
        self.assertEqual(0, code)
        self.assertIn("Measured photos finished: 2/2", out.getvalue())


if __name__ == "__main__":
    unittest.main()
