import datetime as dt
import json
from pathlib import Path
import tempfile
import unittest
from artifacts import BUNDLE_ID, validate_profile, verify_pr_ota


class ProvisioningTests(unittest.TestCase):
    def setUp(self):
        self.profile = {"TeamIdentifier": ["TEAM"], "ExpirationDate": dt.datetime(2027, 1, 1),
                        "ProvisionedDevices": ["iphone", "mac"],
                        "Entitlements": {"get-task-allow": False, "application-identifier": f"TEAM.{BUNDLE_ID}"}}
        self.now = dt.datetime(2026, 1, 1, tzinfo=dt.timezone.utc)

    def test_allows_one_profile_for_both_device_types(self):
        self.assertEqual(validate_profile(self.profile, self.now), "TEAM")

    def test_rejects_app_store_enterprise_development_and_expired_profiles(self):
        for change in [{"ProvisionedDevices": []}, {"ProvisionsAllDevices": True},
                       {"ExpirationDate": dt.datetime(2025, 1, 1)},
                       {"Entitlements": {**self.profile["Entitlements"], "get-task-allow": True}},
                       {"Entitlements": {**self.profile["Entitlements"], "application-identifier": "TEAM.other"}}]:
            with self.subTest(change=change), self.assertRaises(ValueError):
                validate_profile({**self.profile, **change}, self.now)


class OtaPinTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.app = Path(directory.name) / "Mentra.app"
        (self.app / "EXConstants.bundle").mkdir(parents=True)
        self.sha = "a" * 40
        self.url = f"https://artifactscdn.mentraglass.com/Mentra-Community/MentraOS/releases/pr-builds/ota-pr-42-{self.sha}.json"
        # Hermes stores this ASCII URL as a byte string, not executable JS text.
        (self.app / "main.jsbundle").write_bytes(b"\x00\xff" + self.url.encode() + b"\x00")
        self.config({"extra": {"unrelated": "keep"}})

    def config(self, value):
        (self.app / "EXConstants.bundle/app.config").write_text(json.dumps(value))

    def verify(self, **coordinates):
        return verify_pr_ota(self.app, "Mentra-Community/MentraOS", coordinates.get("pr", 42),
                             coordinates.get("sha", self.sha))

    def test_accepts_embedded_pin_for_both_iphone_and_mac(self):
        self.assertEqual(self.verify(), self.url)

    def test_rejects_disabled_ota_and_stale_head_or_pr(self):
        for coordinates in [{"pr": 43}, {"sha": "b" * 40}]:
            with self.subTest(coordinates=coordinates), self.assertRaisesRegex(ValueError, "OTA disabled or stale"):
                self.verify(**coordinates)
        (self.app / "main.jsbundle").write_bytes(b"bundle without OTA configuration")
        with self.assertRaisesRegex(ValueError, "OTA disabled or stale"):
            self.verify()

    def test_packaged_config_cannot_silently_disable_or_override_embedded_pin(self):
        for pin in [None, {}, {"schemaVersion": 2, "otaManifestUrl": self.url},
                    *[{"schemaVersion": 1, "otaManifestUrl": value} for value in [None, "", "https://old/pin.json"]]]:
            self.config({"extra": {"mentraPrBuild": pin}})
            with self.subTest(pin=pin), self.assertRaisesRegex(ValueError, "OTA disabled or stale"):
                self.verify()
        self.config({"extra": {"mentraPrBuild": {"schemaVersion": 1, "otaManifestUrl": self.url}}})
        self.assertEqual(self.verify(), self.url)

    def test_requires_exported_expo_config(self):
        (self.app / "EXConstants.bundle/app.config").unlink()
        with self.assertRaises(FileNotFoundError):
            self.verify()


if __name__ == "__main__":
    unittest.main()
