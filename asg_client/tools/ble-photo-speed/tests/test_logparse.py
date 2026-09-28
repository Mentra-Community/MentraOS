import unittest

import support  # noqa: F401 - sets sys.path
from blespeed import logparse
from blespeed.logparse import (
    BaudChange,
    BesFirmware,
    BlePhotoStep,
    PhotoAccepted,
    PhotoError,
    PhotoReceived,
    PipelineFinished,
    TransferGaveUp,
    TransferRetry,
    parse_line,
    parse_pipeline_finished,
    scan_glasses_log,
)

CURRENT = (
    "09-28 16:00:03.000  1310  1743 I BlePhotoTiming: ⏱️ [BLE PHOTO] PIPELINE FINISHED"
    " | requestId=bspd-abc-Amed-001 | bleImgId=I085113629 | success=true | total=4000ms"
    " | encode_calls=1 | encode_total_ms=80 | original=250000 bytes (244.1KB)"
    " | sensor_to_payload_saved=44.1KB | payload=204800 bytes (200.0KB) | uart_tx=2300ms"
    " | transfer_speed=87.0KB/s | phone_confirm=2500ms | phone_ack_wait=200ms"
    " | last_packet_to_phone_ack=150ms | camera=600ms, compress=250ms, ble_to_phone_confirm=2500ms"
)


class PipelineFinishedRealLinesTest(unittest.TestCase):
    def test_real_studio_lines_parse_with_exact_values(self):
        events = [parse_line(l) for l in support.fixture_lines("glasses_real.txt")]
        finished = [e for e in events if isinstance(e, PipelineFinished)]
        self.assertEqual(3, len(finished))
        first = finished[0]
        self.assertEqual("0015", first.request_id)
        self.assertEqual("I278395821", first.ble_img_id)
        self.assertTrue(first.success)
        self.assertEqual(3243, first.total_ms)
        self.assertEqual(213563, first.original_bytes)
        self.assertEqual(207377, first.payload_bytes)
        self.assertEqual(2299, first.uart_tx_ms)
        self.assertAlmostEqual(88.1, first.transfer_speed_kbps)
        self.assertEqual(2427, first.phone_confirm_ms)
        self.assertEqual(128, first.phone_ack_wait_ms)
        self.assertIsNone(first.last_packet_to_phone_ack_ms)
        self.assertEqual(552, first.camera_ms)
        self.assertEqual(230, first.compress_ms)
        # 207377 B / 1024 / 2.427 s
        self.assertAlmostEqual(83.44, first.e2e_kbps, places=2)
        self.assertEqual("2427ms", first.extra["ble_to_phone_confirm"])

    def test_every_real_fixture_line_is_recognised(self):
        kinds = [type(parse_line(l)).__name__ for l in support.fixture_lines("glasses_real.txt")]
        self.assertEqual([
            "BlePhotoStep", "NoneType", "PipelineFinished", "PipelineFinished", "PipelineFinished",
            "PhotoError", "PhotoError", "BaudChange", "BaudChange", "BesFirmware", "TransferRetry",
        ], kinds)


class PipelineFinishedSyntheticTest(unittest.TestCase):
    def test_current_format_with_drain_field(self):
        event = parse_pipeline_finished(CURRENT)
        self.assertEqual(150, event.last_packet_to_phone_ack_ms)
        self.assertEqual(200, event.phone_ack_wait_ms)
        self.assertEqual("44.1KB", event.extra["sensor_to_payload_saved"])
        self.assertAlmostEqual(80.0, event.e2e_kbps)

    def test_each_optional_field_can_be_missing(self):
        optional = {
            "total": "total_ms", "original": "original_bytes", "payload": "payload_bytes",
            "uart_tx": "uart_tx_ms", "transfer_speed": "transfer_speed_kbps",
            "phone_confirm": "phone_confirm_ms", "phone_ack_wait": "phone_ack_wait_ms",
            "last_packet_to_phone_ack": "last_packet_to_phone_ack_ms",
        }
        for key, attr in optional.items():
            segments = [s for s in CURRENT.split(" | ") if not s.startswith(key + "=")]
            with self.subTest(dropped=key):
                event = parse_pipeline_finished(" | ".join(segments))
                self.assertIsNotNone(event)
                self.assertIsNone(getattr(event, attr))
                self.assertEqual("bspd-abc-Amed-001", event.request_id)

    def test_e2e_is_none_without_payload_or_confirm(self):
        no_confirm = CURRENT.replace(" | phone_confirm=2500ms", "")
        self.assertIsNone(parse_pipeline_finished(no_confirm).e2e_kbps)
        zero_confirm = CURRENT.replace("phone_confirm=2500ms", "phone_confirm=0ms")
        self.assertIsNone(parse_pipeline_finished(zero_confirm).e2e_kbps)

    def test_success_false(self):
        event = parse_pipeline_finished(CURRENT.replace("success=true", "success=false"))
        self.assertFalse(event.success)

    def test_negative_one_becomes_none(self):
        line = CURRENT.replace("last_packet_to_phone_ack=150ms", "last_packet_to_phone_ack=-1ms")
        self.assertIsNone(parse_pipeline_finished(line).last_packet_to_phone_ack_ms)

    def test_brief_and_bare_formats(self):
        body = CURRENT.split("BlePhotoTiming: ", 1)[1]
        for line in ("I/BlePhotoTiming( 1310): " + body, body):
            with self.subTest(line=line[:30]):
                self.assertEqual(204800, parse_pipeline_finished(line).payload_bytes)

    def test_redundant_encode_marker_does_not_break_parsing(self):
        line = CURRENT.replace("encode_total_ms=80", "encode_total_ms=80 ⚠️REDUNDANT_ENCODE")
        self.assertEqual(204800, parse_pipeline_finished(line).payload_bytes)

    def test_truncated_and_garbled_lines_return_none(self):
        bad = [
            "", "   ", "⏱️ [BLE PHOTO] PIPELINE FINISHED",
            "⏱️ [BLE PHOTO] PIPELINE FINISHED | requestId=",
            "⏱️ [BLE PHOTO] PIPELINE FINISHED | requestId=x | success=maybe",
            "⏱️ [BLE PHOTO] PIPELINE FINISHED | success=true",
            "\x00\xff garbage PIPELINE FINISHED ||| ==== |",
            CURRENT[:60],
        ]
        for line in bad:
            with self.subTest(line=line[:40]):
                self.assertIsNone(parse_pipeline_finished(line))
                self.assertIsNone(parse_line(line))

    def test_garbled_numbers_become_none_not_errors(self):
        line = CURRENT.replace("payload=204800 bytes", "payload=abc bytes").replace(
            "transfer_speed=87.0KB/s", "transfer_speed=fastKB/s")
        event = parse_pipeline_finished(line)
        self.assertIsNone(event.payload_bytes)
        self.assertIsNone(event.transfer_speed_kbps)
        self.assertIsNone(event.e2e_kbps)


class OtherEventsTest(unittest.TestCase):
    def test_every_rejection_code(self):
        codes = ["BATTERY_LOW", "VIDEO_RECORDING_ACTIVE", "BLE_TRANSFER_BUSY", "CAMERA_BUSY",
                 "INSUFFICIENT_STORAGE", "UPLOAD_SYSTEM_BUSY", "CAPTURE_TIMEOUT",
                 "CAMERA_CAPTURE_FAILED", "BLE_TRANSFER_FAILED", "BLE_TRANSFER_FAILED_TO_START",
                 "PHOTO_FILE_PATH_FAILED", "PHOTO_COMMAND_FAILED"]
        for code in codes:
            line = ("09-28 16:00:00.000  1  2 E MediaCaptureService: 📸 SENDING PHOTO ERROR: %s"
                    " - something - went wrong for requestId: bspd-x-Amed-003" % code)
            with self.subTest(code=code):
                self.assertEqual(PhotoError("bspd-x-Amed-003", code, "something - went wrong"),
                                 parse_line(line))

    def test_pipeline_progress_lines(self):
        self.assertEqual(PhotoReceived("r1"), parse_line(
            "PHOTO PIPELINE [ASG 2/3] PhotoCommandHandler.handleTakePhoto requestId=r1"))
        self.assertEqual(PhotoAccepted("r1"), parse_line(
            "PHOTO PIPELINE [ASG 3/3] Capture accepted requestId=r1"))

    def test_transfer_retry_and_give_up(self):
        self.assertEqual(TransferRetry(), parse_line("W K900: ❌ Phone reported failure - need to retry transfer"))
        self.assertEqual(TransferGaveUp(3), parse_line(
            "E K900: ❌ Max retries exceeded (3) - giving up on transfer"))

    def test_baud_lines(self):
        self.assertEqual(BaudChange(1152000, "link_ready_fast"),
                         parse_line("I BES-UART: UART link ready at fast baud 1152000"))
        self.assertEqual(BaudChange(460800, "link_ready_rendezvous"),
                         parse_line("I BES-UART: UART link ready at rendezvous baud 460800"))
        self.assertEqual(BaudChange(460800, "serial_opened"),
                         parse_line("I BAUD-SWITCH: Serial port opened at 460800 baud"))
        self.assertIsNone(parse_line("I BAUD-SWITCH: Serial port could not be opened at 1152000"))

    def test_bes_firmware_lines(self):
        self.assertEqual(BesFirmware("17.26.7.5"),
                         parse_line("I K900: ✅ BES firmware version cached successfully: 17.26.7.5"))
        self.assertEqual(BesFirmware("17.26.7.5"),
                         parse_line("I K900: 📋 Caching BES firmware version: 17.26.7.5"))

    def test_step_line(self):
        self.assertEqual(BlePhotoStep("TRANSFER", "phone reported transfer_complete failure"),
                         parse_line("⏱️ [BLE PHOTO] TRANSFER: phone reported transfer_complete failure"))

    def test_line_timestamp(self):
        self.assertEqual("09-28 16:00:03.000", logparse.line_timestamp(CURRENT))
        self.assertEqual("2026-07-17 16:53:16.321",
                         logparse.line_timestamp(support.fixture_lines("glasses_real.txt")[0]))
        self.assertIsNone(logparse.line_timestamp("no timestamp"))


class GlassesStateTest(unittest.TestCase):
    def test_latest_baud_wins_and_firmware_recorded(self):
        text = "\n".join([
            "I BAUD-SWITCH: Serial port opened at 1152000 baud",
            "W BES-UART: Suppressing optional fast baud after failed proof: timeout",
            "I BAUD-SWITCH: Serial port opened at 460800 baud",
            "I K900: ✅ BES firmware version cached successfully: 17.26.7.5",
        ])
        state = scan_glasses_log(text)
        self.assertEqual(460800, state.baud)
        self.assertEqual("serial_opened", state.baud_source)
        self.assertEqual("17.26.7.5", state.bes_firmware)
        self.assertFalse(state.timing_logs_observed)

    def test_real_fixture(self):
        state = scan_glasses_log(support.fixture_text("glasses_real.txt"))
        self.assertEqual(1152000, state.baud)
        self.assertEqual("17.26.5.22", state.bes_firmware)
        self.assertTrue(state.timing_logs_observed)

    def test_empty_log(self):
        state = scan_glasses_log("")
        self.assertIsNone(state.baud)
        self.assertIsNone(state.bes_firmware)


if __name__ == "__main__":
    unittest.main()
