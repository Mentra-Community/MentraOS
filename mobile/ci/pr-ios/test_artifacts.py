import datetime as dt
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import subprocess
from artifacts import BUNDLE_ID, probe_framework_copy, probe_signing, validate_profile, verify_pr_ota, verify_private_signing


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


class SigningProbeTests(unittest.TestCase):
    certificate = "A" * 40

    def test_failed_private_signing_is_not_reported_as_success(self):
        with patch("artifacts.subprocess.run"), patch("artifacts.run", side_effect=subprocess.CalledProcessError(1, ["codesign"])):
            with self.assertRaises(subprocess.CalledProcessError):
                verify_private_signing("owned.keychain-db", self.certificate)

    def test_private_probe_uses_selected_identity_and_rejects_a_different_signer(self):
        with patch("artifacts.subprocess.run"), patch("artifacts.run") as run, patch("artifacts.signer_certificate", return_value="B" * 40):
            with self.assertRaisesRegex(ValueError, "different certificate"):
                verify_private_signing("owned.keychain-db", self.certificate)
            signing = run.call_args_list[0].args
            self.assertEqual(signing[signing.index("--sign") + 1], self.certificate)
            self.assertEqual(signing[signing.index("--keychain") + 1], "owned.keychain-db")

    def test_framework_signing_only_mutates_a_temporary_copy(self):
        with tempfile.TemporaryDirectory() as directory:
            framework = Path(directory) / "Turf.framework"
            framework.mkdir()
            (framework / "Turf").write_bytes(b"original failed build")
            targets = []

            def command(*args):
                if "--force" in args:
                    target = Path(args[-1])
                    targets.append(target)
                    self.assertNotEqual(target.resolve(), framework.resolve())
                    self.assertIn("--preserve-metadata=identifier,entitlements,flags", args)
                    (target / "Turf").write_bytes(b"diagnostic signature")
                return b""

            with patch("artifacts.subprocess.run"), patch("artifacts.run", side_effect=command), patch("artifacts.signer_certificate", return_value=self.certificate):
                probe_framework_copy(framework, "owned.keychain-db", self.certificate)
            self.assertEqual((framework / "Turf").read_bytes(), b"original failed build")
            self.assertEqual(len(targets), 1)
            self.assertFalse(targets[0].exists())

    def test_framework_symlinks_cannot_escape_to_other_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            framework = root / "Turf.framework"
            framework.mkdir()
            outside = root / "outside"
            outside.write_bytes(b"must not read or sign")
            (framework / "Turf").symlink_to("../outside")
            with patch("artifacts.run") as run, self.assertRaisesRegex(ValueError, "external symlink"):
                probe_framework_copy(framework, "owned.keychain-db", self.certificate)
            run.assert_not_called()

    def test_existing_signing_selection_does_not_need_profile_or_secret_import(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            (output / "signing.json").write_text(json.dumps({"certificate": self.certificate}))
            with patch("artifacts.verify_private_signing") as private, patch("artifacts.probe_framework_copy") as framework:
                probe_signing(output, "owned.keychain-db", Path("Turf.framework"))
            private.assert_called_once_with("owned.keychain-db", self.certificate)
            framework.assert_called_once_with(Path("Turf.framework"), "owned.keychain-db", self.certificate)


if __name__ == "__main__":
    unittest.main()
