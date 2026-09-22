import importlib.util
import asyncio
import json
import os
from pathlib import Path
import tempfile
import types
import unittest
from unittest.mock import AsyncMock, patch

import ble_support as r
from test_support import FIXTURE


def credentials():
    return {"schemaVersion": 1, "fixture": {"cid": FIXTURE["cid"], "serial": "TEST012345", "mac": FIXTURE["mac"],
            "mtk": "MentraLive_20260113", "slot": "_a", "boot": "9ad31c85-1a26-49fc-b8b1-6e28b01fb931"},
            "endpoint": "192.168.50.10:5555", "ssid": "fixture-network", "password": "test-only-not-a-real-secret"}


class BleProtocolTests(unittest.TestCase):
    def test_app_request_uses_json_string_inside_c_and_wake_flag(self):
        command = {"type": "set_wifi_credentials", "ssid": "fixture", "password": "test-only"}
        wire = r.app_frame(command)
        self.assertEqual(wire[:3], b"##0")
        self.assertEqual(int.from_bytes(wire[3:5], "big"), len(wire)-7)
        wrapper = json.loads(wire[5:-2])
        self.assertEqual(wrapper["W"], 1)
        self.assertEqual(json.loads(wrapper["C"]), command)
        self.assertNotIn("B", wrapper)

    def test_fragmented_and_combined_notifications(self):
        status = {"type": "wifi_status", "connected": True, "ssid": "fixture", "local_ip": "192.168.50.10"}
        identity = {"C": "sr_btaddr", "S": 0, "B": {"btaddr": FIXTURE["mac"].lower()}}
        one, two = r.frame(status), r.frame(identity)
        decoder = r.Decoder()
        self.assertEqual(decoder.add(one[:3]), [])
        self.assertEqual(decoder.add(one[3:21]), [])
        self.assertEqual(decoder.add(one[21:] + two), [status, identity])

    def test_little_endian_and_wrapped_response(self):
        message = {"type": "wifi_status", "connected": False}
        wire = bytearray(r.frame({"C": json.dumps(message)}))
        wire[3:5] = wire[3:5][::-1]
        self.assertEqual(r.Decoder().add(wire), [message])

    def test_invalid_frame_and_oversized_request_fail(self):
        with self.assertRaises(r.Guard):
            r.Decoder().add(b"broken-notification")
        with self.assertRaises(r.Guard):
            r.app_frame({"type": "set_wifi_credentials", "ssid": "a"*300})

    def test_exact_current_ssid_and_ip_required_before_provisioning(self):
        c = credentials()
        good = {"type": "wifi_status", "connected": True, "ssid": c["ssid"], "local_ip": "192.168.50.10"}
        proof, endpoint = r.status_proof(good, c)
        self.assertTrue(proof["ssidMatches"])
        self.assertEqual(endpoint, c["endpoint"])
        self.assertNotIn(c["ssid"], json.dumps(proof))
        for patch in [{"ssid": c["ssid"].upper()}, {"ssid": '"'+c["ssid"]+'"'}, {"connected": False},
                      {"connected": 1}, {"local_ip": "192.168.50.11"}]:
            with self.assertRaises(r.Guard):
                r.status_proof({**good, **patch}, c)

    def test_new_post_wipe_dhcp_ip_is_scoped_by_same_ssid(self):
        c = credentials()
        good = {"type": "wifi_status", "connected": True, "ssid": c["ssid"], "local_ip": "192.168.50.20"}
        proof, endpoint = r.status_proof(good, c, allow_new_ip=True)
        self.assertFalse(proof["endpointUnchanged"])
        self.assertEqual(endpoint, "192.168.50.20:5555")
        for address in ["127.0.0.1", "0.0.0.0", "8.8.8.8", "169.254.1.1", "224.0.0.1"]:
            with self.assertRaises(r.Guard):
                r.status_proof({**good, "local_ip": address}, c, allow_new_ip=True)

