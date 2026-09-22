import base64
import io
import json
from pathlib import Path
import plistlib
import subprocess
import tempfile
import traceback
import unittest
from unittest.mock import patch
from urllib.error import HTTPError, URLError

import mac_installer as installer


class SecretResponse(io.BytesIO):
    status = 200


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

    def pem(self, der):
        return b"-----BEGIN CERTIFICATE-----\n" + base64.b64encode(der) + b"\n-----END CERTIFICATE-----\n"

    def test_intermediate_match_requires_exact_der_bytes(self):
        expected = b"test-exact-public-certificate"
        other = b"test-other-public-certificate-with-same-subject"
        self.assertTrue(installer.contains_certificate(self.pem(other) + self.pem(expected), expected))
        self.assertFalse(installer.contains_certificate(self.pem(other), expected))
        self.assertFalse(installer.contains_certificate(b"", expected))
        for invalid in (b"-----BEGIN CERTIFICATE-----\n", b"-----BEGIN CERTIFICATE-----!bad!-----END CERTIFICATE-----"):
            with self.assertRaisesRegex(ValueError, "Malformed keychain certificate export"):
                installer.contains_certificate(invalid, expected)

    def test_existing_exact_intermediate_is_not_imported_again(self):
        expected = b"test-exact-public-certificate"
        keychain, certificate = self.root / "job.keychain", self.root / "DeveloperIDG2CA.cer"
        with patch.object(installer, "run", side_effect=[expected, self.pem(expected)]) as command:
            installer.ensure_intermediate(keychain, certificate)
        self.assertEqual(len(command.call_args_list), 2)
        self.assertEqual(command.call_args_list[1].args, ("security", "find-certificate", "-a", "-p", keychain))
        self.assertFalse(any("import" in call.args for call in command.call_args_list))

    def test_missing_intermediate_is_imported_and_verified_in_the_exact_job_keychain(self):
        expected, other = b"test-exact-public-certificate", b"test-other-public-certificate"
        keychain, certificate = self.root / "job.keychain", self.root / "DeveloperIDG2CA.cer"
        with patch.object(installer, "run", side_effect=[expected, self.pem(other), b"", self.pem(expected)]) as command:
            installer.ensure_intermediate(keychain, certificate)
        self.assertEqual(command.call_args_list[2].args,
                         ("security", "import", certificate, "-k", keychain, "-T", "/usr/bin/codesign"))
        self.assertEqual(command.call_args_list[3].args, ("security", "find-certificate", "-a", "-p", keychain))

    def test_intermediate_failures_are_not_treated_as_already_installed(self):
        expected = b"test-exact-public-certificate"
        for responses, message in (([RuntimeError("invalid DER")], "invalid DER"),
                                   ([expected, RuntimeError("keychain denied")], "keychain denied"),
                                   ([expected, b"", RuntimeError("import denied")], "import denied"),
                                   ([expected, b"", b"", self.pem(b"different")], "after import")):
            with self.subTest(message=message), patch.object(installer, "run", side_effect=responses):
                with self.assertRaisesRegex((ValueError, RuntimeError), message):
                    installer.ensure_intermediate(self.root / "job.keychain", self.root / "DeveloperIDG2CA.cer")

    def signing_environment(self):
        return {"ASC_API_KEY_P8_B64": base64.b64encode(b"test-notary-key").decode(),
                "ASC_API_KEY_ID": "KEY", "ASC_API_ISSUER_ID": "ISSUER",
                "PR_IOS_KEYCHAIN_PASSWORD": "test-keychain-password"}

    def test_doppler_fetches_only_the_certificate_pair_without_persisting_or_exporting_it(self):
        env = {**self.signing_environment(), "DOPPLER_TOKEN_MOBILE_PRD": "test-service-token"}
        expected = {"MAC_INSTALLER_P12_BASE64": base64.b64encode(b"test-p12").decode(),
                    "MAC_INSTALLER_P12_PASSWORD": " password with spaces "}
        requests = []
        def respond(request, timeout):
            requests.append(request)
            self.assertEqual(timeout, 20)
            name = request.full_url.split("?name=")[-1]
            self.assertIn(name, installer.CERTIFICATE_SECRETS)
            self.assertEqual(request.full_url, "https://api.doppler.com/v3/configs/config/secret?name=" + name)
            self.assertEqual(request.get_header("Authorization"),
                             "Basic " + base64.b64encode(b"test-service-token:").decode())
            return SecretResponse(json.dumps({"name": name, "value": {"computed": expected[name]}}).encode())
        before = dict(env)
        with patch.object(installer, "build_opener") as opener, patch("builtins.print") as printed:
            opener.return_value.open.side_effect = respond
            self.assertEqual(installer.required_environment(env), {**self.signing_environment(), **expected})
            self.assertEqual(len(requests), 2)
            self.assertTrue(all(isinstance(call.args[0], installer.NoSecretRedirects) for call in opener.call_args_list))
            printed.assert_not_called()
        self.assertEqual(env, before)
        self.assertEqual(list(self.root.iterdir()), [])

    def test_direct_credentials_override_doppler_only_as_a_complete_pair(self):
        pair = {"MAC_INSTALLER_P12_BASE64": base64.b64encode(b"test-p12").decode(),
                "MAC_INSTALLER_P12_PASSWORD": "test-p12-password"}
        env = {**self.signing_environment(), **pair, "DOPPLER_TOKEN_MOBILE_PRD": "unused-token"}
        with patch.object(installer, "build_opener") as opener:
            self.assertEqual(installer.required_environment(env), {**self.signing_environment(), **pair})
            for name in pair:
                for incomplete in ({key: value for key, value in env.items() if key != name},
                                   {**env, name: ""}):
                    with self.subTest(name=name, empty=name in incomplete):
                        with self.assertRaisesRegex(ValueError, name):
                            installer.required_environment(incomplete)
            opener.assert_not_called()

    def test_malformed_credentials_never_reach_the_keychain_or_fall_back_to_doppler(self):
        pair = {"MAC_INSTALLER_P12_BASE64": base64.b64encode(b"test-p12").decode(),
                "MAC_INSTALLER_P12_PASSWORD": "test-p12-password"}
        for changes in ({"MAC_INSTALLER_P12_BASE64": "not-base64-secret"},
                        {"MAC_INSTALLER_P12_BASE64": " \n"},
                        {"MAC_INSTALLER_P12_BASE64": "A" * (installer.DOPPLER_RESPONSE_LIMIT + 1)},
                        {"MAC_INSTALLER_P12_PASSWORD": "private\0password"}):
            with patch.object(installer, "build_opener") as opener, patch.object(installer, "run") as command:
                with self.assertRaisesRegex(ValueError, "credentials are malformed"):
                    installer.configure(self.root / "job.keychain", self.root / "out",
                                        {**self.signing_environment(), **pair, **changes})
                opener.assert_not_called()
                command.assert_not_called()
                self.assertFalse((self.root / "out").exists())

    def test_doppler_rejects_missing_wrong_or_oversized_secret_responses(self):
        name = installer.CERTIFICATE_SECRETS[0]
        responses = [b"not-json-private-value", b"\xff", b"{}", b"[]",
                     json.dumps({"name": "OTHER_SECRET", "value": {"computed": "private-value"}}).encode(),
                     json.dumps({"name": name, "value": {"raw": "private-value"}}).encode(),
                     json.dumps({"name": name, "value": {"computed": ""}}).encode(),
                     json.dumps({"name": name, "value": {"computed": 123}}).encode(),
                     json.dumps({"name": name, "value": {"computed": "private-value"}, "success": False}).encode(),
                     b"x" * (installer.DOPPLER_RESPONSE_LIMIT + 1)]
        for payload in responses:
            with self.subTest(size=len(payload)), patch.object(installer, "build_opener") as opener:
                opener.return_value.open.return_value = SecretResponse(payload)
                with self.assertRaisesRegex(ValueError, "Could not fetch valid") as error:
                    installer.doppler_secret("test-service-token", name)
                rendered = "".join(traceback.format_exception(error.exception))
                self.assertNotIn("private-value", rendered)
                self.assertNotIn("test-service-token", rendered)
                self.assertTrue(error.exception.__suppress_context__)

    def test_doppler_http_and_timeout_failures_do_not_echo_private_details(self):
        failures = [HTTPError("https://api.doppler.com/", 403, "private-value", {}, io.BytesIO(b"private-value")),
                    URLError("private-value"), TimeoutError("private-value")]
        for failure in failures:
            with patch.object(installer, "build_opener") as opener:
                opener.return_value.open.side_effect = failure
                with self.assertRaisesRegex(ValueError, "Could not fetch valid") as error:
                    installer.doppler_secret("test-service-token", installer.CERTIFICATE_SECRETS[0])
                rendered = "".join(traceback.format_exception(error.exception))
                self.assertNotIn("private-value", rendered)
                self.assertNotIn("test-service-token", rendered)
        self.assertIsNone(installer.NoSecretRedirects().redirect_request(None, None, 302, "", {}, "https://other.invalid"))

    def test_doppler_rejects_unrelated_secret_names_and_invalid_service_tokens_without_requests(self):
        with patch.object(installer, "build_opener") as opener:
            with self.assertRaisesRegex(ValueError, "Only the two"):
                installer.doppler_secret("test-service-token", "ASC_API_KEY_P8_B64")
            for token in ("", "token\n", "token:password", "non-ascii-\u2603"):
                with self.assertRaisesRegex(ValueError, "service token"):
                    installer.doppler_secret(token, installer.CERTIFICATE_SECRETS[0])
            opener.assert_not_called()

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
        info = plistlib.loads((app / "Contents/Info.plist").read_bytes())
        self.assertEqual(info["CFBundleURLTypes"][0]["CFBundleURLSchemes"], ["mentra-install"])
        self.assertTrue(info["LSFileQuarantineEnabled"])
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
