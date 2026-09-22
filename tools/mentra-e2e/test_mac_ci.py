import argparse
import copy
import json
from pathlib import Path
import plistlib
import stat
import tempfile
import unittest
import zipfile

import mac_ci


class MacArtifactTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.selection = argparse.Namespace(pr=123, head="a" * 40, run=456, attempt=1)
        self.context = {"pr": 123, "headSha": "a" * 40, "runId": 456, "runAttempt": 1}
        self.app = {**self.context, "app": "Mentra.app", "bundleId": mac_ci.BUNDLE,
                    "teamId": mac_ci.TEAM, "launcherPath": "launch-ios-on-mac",
                    "executableSha256": "b" * 64, "javascriptSha256": "c" * 64,
                    "launcherSha256": "d" * 64, "version": "3.2.1", "build": "1234",
                    "otaManifestUrl": f"https://artifactscdn.mentraglass.com/{mac_ci.REPOSITORY}/releases/pr-builds/ota-pr-123-{'a' * 40}.json"}
        self.receipt = {"schemaVersion": 1, **self.context, "app": self.app,
                        "artifacts": {"mac": {"name": f"mentra-ios-mac-pr-123-{'a' * 40}-456-1.zip",
                                             "sha256": "e" * 64, "size": 1000}}}

    def test_receipt_binds_both_app_and_archive_to_exact_selection(self):
        mac_ci.validate_receipt(self.receipt, self.selection)
        for mutation in (lambda r: r.update(headSha="f" * 40),
                         lambda r: r["app"].update(pr=124),
                         lambda r: r["app"].update(otaManifestUrl="https://example.com/latest.json"),
                         lambda r: r["app"].update(archivePath="/tmp/other.zip"),
                         lambda r: r["app"].update(teamId="ANOTHERTEAM"),
                         lambda r: r["artifacts"]["mac"].update(name="../outside.zip")):
            receipt = copy.deepcopy(self.receipt)
            mutation(receipt)
            with self.assertRaises(ValueError):
                mac_ci.validate_receipt(receipt, self.selection)

    def test_producer_allows_selected_prior_artifact_attempt_but_not_wrong_run(self):
        run = {"id": 456, "repository": {"full_name": mac_ci.REPOSITORY},
               "path": mac_ci.WORKFLOW, "event": "pull_request", "status": "completed",
               "conclusion": "success", "head_sha": "a" * 40, "run_attempt": 2}
        mac_ci.validate_run(run, self.selection)
        for key, value in (("path", "another.yml"), ("head_sha", "f" * 40),
                           ("conclusion", "failure"), ("event", "workflow_dispatch"), ("id", 457)):
            with self.assertRaises(ValueError):
                mac_ci.validate_run({**run, key: value}, self.selection)

    def archive(self, names):
        archive = self.root / "build.zip"
        with zipfile.ZipFile(archive, "w") as output:
            for name in names:
                if isinstance(name, zipfile.ZipInfo):
                    output.writestr(name, "outside")
                else:
                    output.writestr(name, "fixture")
        return archive

    def test_extracts_regular_files_without_executing_downloaded_installer(self):
        archive = self.archive(["Mentra PR/install.mjs", "Mentra PR/Mentra.app/Info.plist",
                                "__MACOSX/._install.mjs"])
        package = mac_ci.extract_package(archive, self.root / "extracted")
        self.assertEqual((package / "install.mjs").read_text(), "fixture")
        self.assertFalse((self.root / "extracted/__MACOSX").exists())

    def test_rejects_traversal_and_case_collision_before_extraction(self):
        for names in (["Mentra PR/../outside"], ["/outside"], ["Mentra PR\\outside"],
                      ["Mentra PR/./file"], ["Mentra PR//file"], ["Other/file"],
                      ["Mentra PR/file", "Mentra PR/FILE"]):
            with self.subTest(names=names), self.assertRaises(ValueError):
                mac_ci.extract_package(self.archive(names), self.root / "rejected")
            self.assertFalse((self.root / "rejected").exists())

    def test_rejects_symlink_and_special_file(self):
        for kind in (stat.S_IFLNK, stat.S_IFIFO):
            entry = zipfile.ZipInfo("Mentra PR/link")
            entry.create_system = 3
            entry.external_attr = (kind | 0o777) << 16
            with self.assertRaisesRegex(ValueError, "link or special"):
                mac_ci.extract_package(self.archive([entry]), self.root / "rejected")

    def package(self):
        package = self.root / "package"
        bundle = package / "Mentra.app"
        (bundle / "EXConstants.bundle").mkdir(parents=True)
        info = {"CFBundleIdentifier": mac_ci.BUNDLE, "CFBundleExecutable": "Mentra",
                "CFBundleVersion": "1234", "CFBundleShortVersionString": "3.2.1"}
        (bundle / "Info.plist").write_bytes(plistlib.dumps(info))
        for file, key in ((bundle / "Mentra", "executableSha256"),
                          (bundle / "main.jsbundle", "javascriptSha256"),
                          (package / "launch-ios-on-mac", "launcherSha256")):
            file.write_text(file.name)
            self.app[key] = mac_ci.digest(file)
        (bundle / "EXConstants.bundle/app.config").write_text(json.dumps({"extra": {
            "mentraPrBuild": {"schemaVersion": 1, "otaManifestUrl": self.app["otaManifestUrl"]}}}))
        (package / "build.json").write_text(json.dumps(self.app))
        return package

    def test_verifies_bytes_pin_and_expected_apple_signer(self):
        package = self.package()
        commands = []
        mac_ci.verify_package(package, self.app, commands.append)
        self.assertEqual(len(commands), 2)
        self.assertIn("--strict", commands[0])
        self.assertIn(mac_ci.TEAM, commands[1][3])
        (package / "Mentra.app/Mentra").write_text("modified")
        with self.assertRaisesRegex(ValueError, "Hash mismatch"):
            mac_ci.verify_package(package, self.app, commands.append)
        self.assertEqual(len(commands), 2)

    def test_empty_packaged_pin_does_not_fall_back_to_compiled_javascript(self):
        package = self.package()
        bundle = package / "Mentra.app"
        (bundle / "main.jsbundle").write_text(self.app["otaManifestUrl"])
        self.app["javascriptSha256"] = mac_ci.digest(bundle / "main.jsbundle")
        (package / "build.json").write_text(json.dumps(self.app))
        (bundle / "EXConstants.bundle/app.config").write_text(json.dumps({"extra": {"mentraPrBuild": {}}}))
        with self.assertRaisesRegex(ValueError, "Packaged OTA pin"):
            mac_ci.verify_package(package, self.app, lambda _: None)


if __name__ == "__main__":
    unittest.main()
