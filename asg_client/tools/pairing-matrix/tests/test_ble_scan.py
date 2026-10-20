"""ble_scan.decode_mentra: the v4 advertisement trailer (OWNER_CHANGED flag and window id), against the layout that
MentraLivePairingAdvertisement.kt parses. No radio is touched."""

import unittest

from tests import helpers  # noqa: F401  (puts the harness directory on sys.path)

import ble_scan


def trailer(*, pairing=False, version=4, flags=0x01, code=(0x34, 0x12), window_id=None, magic=(0x4D, 0x50)):
    """company-id-stripped payload: 5 id/state bytes, pairing flag, version, capability, code lo/hi, 'MP', window id."""
    data = bytearray([0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0x01 if pairing else 0x00, version, flags, code[0], code[1],
                      magic[0], magic[1]])
    if window_id is not None:
        data.append(window_id)
    return bytes(data)


class DecodeTests(unittest.TestCase):
    def test_v4_trailer_carries_the_window_id_and_a_clear_owner_changed_flag(self):
        m = ble_scan.decode_mentra(trailer(pairing=True, window_id=7))
        self.assertTrue(m["secure"])
        self.assertTrue(m["pairing"])
        self.assertEqual(m["version"], 4)
        self.assertEqual(m["code"], "1234")
        self.assertEqual(m["window_id"], 7)
        self.assertFalse(m["owner_changed"])

    def test_owner_changed_is_capability_bit_0x04(self):
        m = ble_scan.decode_mentra(trailer(flags=0x01 | 0x04, window_id=9))
        self.assertTrue(m["owner_changed"])
        self.assertEqual(m["window_id"], 9)
        self.assertFalse(ble_scan.decode_mentra(trailer(flags=0x01, window_id=9))["owner_changed"])

    def test_pre_v4_trailer_has_no_window_id(self):
        m = ble_scan.decode_mentra(trailer(version=2))
        self.assertTrue(m["secure"])
        self.assertIsNone(m["window_id"])
        self.assertFalse(m["owner_changed"])

    def test_not_a_secure_trailer_stays_undecoded(self):
        for bad in (trailer(magic=(0, 0)), trailer(version=1), trailer(flags=0x00)):
            m = ble_scan.decode_mentra(bad)
            self.assertFalse(m["secure"])
            self.assertNotIn("window_id", m)
        self.assertFalse(ble_scan.decode_mentra(b"\x00" * 5)["secure"])


if __name__ == "__main__":
    unittest.main()
