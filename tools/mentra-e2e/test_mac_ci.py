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

    def test_trusted_installer_evidence_includes_the_shared_ownership_dependency(self):
        installer = self.root / "install-ios-mac.mjs"
        dependency = self.root / "app-ownership.mjs"
        installer.write_text("synthetic installer")
        dependency.write_text("synthetic ownership protocol")
        proof = mac_ci.installer_evidence(installer)
        self.assertEqual(proof["installerSha256"], mac_ci.digest(installer))
        self.assertEqual(proof["installerDependencies"],
                         [{"path": str(dependency), "sha256": mac_ci.digest(dependency)}])
        dependency.write_text("changed protocol")
        changed = mac_ci.installer_evidence(installer)
        self.assertEqual(changed["installerSha256"], proof["installerSha256"])
        self.assertNotEqual(changed["installerDependencies"], proof["installerDependencies"])
        dependency.unlink()
        with self.assertRaisesRegex(ValueError, "regular file"):
            mac_ci.installer_evidence(installer)
        dependency.symlink_to(installer)
        with self.assertRaisesRegex(ValueError, "regular file"):
            mac_ci.installer_evidence(installer)

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

    def use_native_package(self):
        self.app.pop("launcherPath")
        self.app.pop("launcherSha256")
        self.app.update(macPackageVersion=2, macInstaller=mac_ci.MAC_INSTALLER)

    def test_native_receipt_requires_the_known_layout_without_a_legacy_launcher(self):
        self.use_native_package()
        mac_ci.validate_receipt(self.receipt, self.selection)
        for mutation in (lambda a: a.update(macPackageVersion=3),
                         lambda a: a.update(macPackageVersion=True),
                         lambda a: a.pop("macPackageVersion"),
                         lambda a: a.update(macInstaller="../Install Mentra.app"),
                         lambda a: a.update(launcherPath="launch-ios-on-mac"),
                         lambda a: a.update(launcherSha256="d" * 64)):
            receipt = copy.deepcopy(self.receipt)
            mutation(receipt["app"])
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

    def package(self, native=False):
        if native:
            self.use_native_package()
        package = self.root / "package"
        bundle = package / "Mentra.app"
        (bundle / "EXConstants.bundle").mkdir(parents=True)
        info = {"CFBundleIdentifier": mac_ci.BUNDLE, "CFBundleExecutable": "Mentra",
                "CFBundleVersion": "1234", "CFBundleShortVersionString": "3.2.1"}
        (bundle / "Info.plist").write_bytes(plistlib.dumps(info))
        files = [(bundle / "Mentra", "executableSha256"),
                 (bundle / "main.jsbundle", "javascriptSha256")]
        if not native:
            files.append((package / "launch-ios-on-mac", "launcherSha256"))
        for file, key in files:
            file.write_text(file.name)
            self.app[key] = mac_ci.digest(file)
        (bundle / "EXConstants.bundle/app.config").write_text(json.dumps({"extra": {
            "mentraPrBuild": {"schemaVersion": 1, "otaManifestUrl": self.app["otaManifestUrl"]}}}))
        (package / "build.json").write_text(json.dumps(self.app))
        if native:
            resources = package / mac_ci.MAC_INSTALLER / "Contents/Resources"
            resources.mkdir(parents=True)
            (resources / "build.json").write_bytes((package / "build.json").read_bytes())
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

    def test_native_package_requires_matching_manifest_and_developer_id_signature(self):
        package = self.package(native=True)
        commands = []
        mac_ci.verify_package(package, self.app, commands.append)
        self.assertEqual(len(commands), 4)
        self.assertIn("--strict", commands[2])
        self.assertEqual(commands[3][-1], str(package / mac_ci.MAC_INSTALLER))
        self.assertIn(mac_ci.TEAM, commands[3][3])
        self.assertIn('identifier "com.mentra.mac-installer"', commands[3][3])
        self.assertIn("certificate 1[field.1.2.840.113635.100.6.2.6] exists", commands[3][3])
        self.assertIn("certificate leaf[field.1.2.840.113635.100.6.1.13] exists", commands[3][3])
        pinned = package / mac_ci.MAC_INSTALLER / "Contents/Resources/build.json"
        pinned.write_text(json.dumps({**self.app, "pr": 124}))
        with self.assertRaisesRegex(ValueError, "different manifest"):
            mac_ci.verify_package(package, self.app, commands.append)

    def test_native_installer_signature_failure_rejects_the_package(self):
        package = self.package(native=True)

        def reject_wrong_signer(argv):
            if "--strict" not in argv and argv[-1].endswith(mac_ci.MAC_INSTALLER):
                raise ValueError("Signature does not satisfy Developer ID requirement")

        with self.assertRaisesRegex(ValueError, "Developer ID"):
            mac_ci.verify_package(package, self.app, reject_wrong_signer)

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
