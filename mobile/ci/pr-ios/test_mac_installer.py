import base64
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import mac_installer as installer


class MacInstallerPackagingTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)

    def test_missing_credentials_fail_before_importing_or_building(self):
        with patch.object(installer, "run") as command:
            with self.assertRaisesRegex(ValueError, "MAC_INSTALLER_P12_BASE64"):
                installer.configure(self.root / "job.keychain", self.root / "out", {})
            command.assert_not_called()

    def test_only_one_valid_mentra_developer_id_application_is_accepted(self):
        identity = "A" * 40
        valid = f'1) {identity} "Developer ID Application: Mentra Labs, Inc. ({installer.TEAM})"'
        self.assertEqual(installer.select_identity(valid), identity)
        for output in (valid.replace("Developer ID Application", "Apple Distribution"),
                       valid.replace(installer.TEAM, "OTHERTEAM1"), valid + "\n" + valid, "no identities"):
            with self.assertRaises(ValueError):
                installer.select_identity(output)

    def test_base64_whitespace_is_supported(self):
        self.assertEqual(installer.decode_secret("\n" + base64.b64encode(b"fixture").decode() + "\n"), b"fixture")

    def test_secret_failure_does_not_echo_password_or_command(self):
        failed = subprocess.CompletedProcess(["security", "-P", "secret-password"], 1, b"", b"secret-password")
        with patch.object(installer.subprocess, "run", return_value=failed):
            with self.assertRaises(RuntimeError) as error:
                installer.run("security", "import", "-P", "secret-password", private=True)
        self.assertNotIn("secret-password", str(error.exception))

    def test_secret_timeout_does_not_echo_password_or_command(self):
        timeout = subprocess.TimeoutExpired(["security", "-P", "secret-password"], 180)
        with patch.object(installer.subprocess, "run", side_effect=timeout):
            with self.assertRaisesRegex(RuntimeError, "security timed out") as error:
                installer.run("security", "import", "-P", "secret-password", private=True)
        self.assertNotIn("secret-password", str(error.exception))
        self.assertTrue(error.exception.__suppress_context__)

    def test_app_embeds_only_expected_manifest_not_ios_payload(self):
        package = self.root / "Mentra PR"
        package.mkdir()
        manifest = {"build": "302015703", "macPackageVersion": 2}
        (package / "build.json").write_text(json.dumps(manifest))
        (package / "Mentra.app").mkdir()
        (package / "Mentra.app/original").write_text("Apple-signed iOS payload")
        with patch.object(installer, "run") as command:
            app = installer.create_app(package, manifest)
        self.assertEqual((app / "Contents/Resources/build.json").read_bytes(), (package / "build.json").read_bytes())
        self.assertFalse((app / "Contents/Resources/Mentra.app").exists())
        self.assertEqual((package / "Mentra.app/original").read_text(), "Apple-signed iOS payload")
        self.assertFalse((package / "Install.command").exists())
        self.assertFalse((package / "launch-ios-on-mac").exists())
        self.assertTrue(any("swiftc" in call.args for call in command.call_args_list))

    def notarization(self, status):
        commands = []
        def command(*args, **kwargs):
            commands.append(args)
            return b"{}"
        settings = {"team": installer.TEAM, "identity": "A" * 40, "keychain": "job.keychain",
                    "key": "AuthKey.p8", "keyId": "KEY", "issuer": "ISSUER"}
        def submit(args, **kwargs):
            commands.append(tuple(args))
            return subprocess.CompletedProcess(args, 0, json.dumps({"status": status, "id": "submission-id"}), "")
        return settings, commands, command, submit

    def test_signs_notarizes_and_staples_only_native_app_before_accepting(self):
        settings, commands, command, submit = self.notarization("Accepted")
        app = self.root / "Install Mentra.app"
        with patch.object(installer, "run", side_effect=command), patch.object(installer.subprocess, "run", side_effect=submit):
            result = installer.notarize(app, settings, self.root / "diagnostics")
        self.assertEqual(result["notarizationStatus"], "Accepted")
        self.assertTrue(result["stapled"])
        self.assertIn("runtime", commands[0])
        self.assertIn("--timestamp", commands[0])
        archive = next(command for command in commands if command[0] == "ditto")
        self.assertEqual(archive[-2], app)
        submit = next(i for i, command in enumerate(commands) if "submit" in command)
        staple = next(i for i, command in enumerate(commands) if "staple" in command)
        self.assertLess(submit, staple)
        self.assertTrue(any(command[0] == "spctl" for command in commands))

    def test_rejected_notarization_keeps_diagnostics_and_never_staples(self):
        settings, commands, command, submit = self.notarization("Invalid")
        diagnostics = self.root / "diagnostics"
        with patch.object(installer, "run", side_effect=command), patch.object(installer.subprocess, "run", side_effect=submit):
            with self.assertRaisesRegex(ValueError, "not accepted"):
                installer.notarize(self.root / "Install Mentra.app", settings, diagnostics)
        self.assertEqual(json.loads((diagnostics / "notary-result.json").read_text())["status"], "Invalid")
        self.assertTrue((diagnostics / "notary-log.json").is_file())
        self.assertFalse(any("staple" in command for command in commands))

    def test_notary_network_failure_retains_diagnostics_and_cannot_publish(self):
        settings, commands, command, _ = self.notarization("Accepted")
        failed = subprocess.CompletedProcess([], 69, "", "Network unavailable")
        diagnostics = self.root / "diagnostics"
        with patch.object(installer, "run", side_effect=command), patch.object(installer.subprocess, "run", return_value=failed):
            with self.assertRaisesRegex(ValueError, "no JSON result"):
                installer.notarize(self.root / "Install Mentra.app", settings, diagnostics)
        self.assertEqual(json.loads((diagnostics / "notary-submit.json").read_text())["stderr"], "Network unavailable")
        self.assertFalse(any("staple" in command for command in commands))

    def test_notary_timeout_retains_partial_response_and_cannot_publish(self):
        settings, commands, command, _ = self.notarization("Accepted")
        timeout = subprocess.TimeoutExpired(["xcrun"], 1000, output=b'{"id":"pending"}', stderr=b"Still waiting")
        diagnostics = self.root / "diagnostics"
        with patch.object(installer, "run", side_effect=command), patch.object(installer.subprocess, "run", side_effect=timeout):
            with self.assertRaisesRegex(ValueError, "timed out"):
                installer.notarize(self.root / "Install Mentra.app", settings, diagnostics)
        self.assertTrue(json.loads((diagnostics / "notary-submit.json").read_text())["timeout"])
        self.assertFalse(any("staple" in command for command in commands))


if __name__ == "__main__":
    unittest.main()
