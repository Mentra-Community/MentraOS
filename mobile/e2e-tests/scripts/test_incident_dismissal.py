import importlib.util
import json
import subprocess
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from xml.etree import ElementTree as ET

spec = importlib.util.spec_from_file_location("live_word_monitor", Path(__file__).with_name("live_word_monitor.py"))
monitor = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = monitor
spec.loader.exec_module(monitor)


def modal(owner="own"):
    root = ET.Element("hierarchy")
    ET.SubElement(root, "node", {"resource-id": "incident-report-state", "text": json.dumps({"alert_id": owner, "test_run_id": owner})})
    ET.SubElement(root, "node", {"resource-id": "incident-report-done", "bounds": "[10,20][30,40]"})
    return ET.tostring(root, encoding="unicode")


class IncidentDismissal(unittest.TestCase):
    def exercise(self, snapshots, error=None):
        worker = object.__new__(monitor.MonitorWorker)
        worker.adb_prefix_for = lambda _: ["adb", "-s", "phone"]
        taps = []
        clock = [0]
        observations = iter(snapshots)
        last = "<hierarchy/>"

        def run(command, **kwargs):
            nonlocal last
            if "dump" in command and error:
                raise error
            if "cat" in command:
                last = next(observations, last)
            if "tap" in command:
                taps.append(command)
            return SimpleNamespace(stdout=last)

        def sleep(seconds):
            clock[0] += seconds

        with patch.object(monitor.subprocess, "run", side_effect=run), patch.object(monitor.time, "monotonic", side_effect=lambda: clock[0]), patch.object(monitor.time, "sleep", side_effect=sleep):
            try:
                worker.dismiss_incident_modal("phone", "own")
                return taps, None
            except RuntimeError as exc:
                return taps, str(exc)

    def test_delayed_mount_and_verified_dismissal(self):
        taps, error = self.exercise(["<hierarchy/>", modal(), "<hierarchy/>"])
        self.assertIsNone(error)
        self.assertEqual(len(taps), 1)
        self.assertEqual(taps[0][-2:], ["20", "30"])

    def test_unrelated_modal_never_tapped(self):
        taps, error = self.exercise([modal("other")] * 50)
        self.assertEqual(taps, [])
        self.assertIn("did not appear", error)

    def test_stuck_modal_is_failure_without_repeated_input(self):
        taps, error = self.exercise([modal()] * 50)
        self.assertEqual(len(taps), 1)
        self.assertIn("remained", error)

    def test_dump_failure_is_reported(self):
        taps, error = self.exercise([], subprocess.TimeoutExpired("uiautomator", 4))
        self.assertEqual(taps, [])
        self.assertIn("timed out", error)


if __name__ == "__main__":
    unittest.main()
