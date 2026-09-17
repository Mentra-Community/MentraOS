import importlib.util
import json
import os
from pathlib import Path
import shutil
import struct
import subprocess
import tempfile
import unittest
import zipfile

SCRIPT = Path(__file__).with_name("repackage-pr-apk.py").resolve()
spec = importlib.util.spec_from_file_location("repackage", SCRIPT)
apk = importlib.util.module_from_spec(spec)
spec.loader.exec_module(apk)
FP = "a" * 64
SHA = "b" * 40


def manifest():
    # Minimal chunks for unit tests; integration below uses aapt2-generated XML.
    resources = struct.pack("<HHII", 0x180, 8, 12, 0x0101021B)
    root = struct.pack("<HHIII", 0x102, 16, 56, 1, 0xFFFFFFFF)
    root += struct.pack("<IIHHHHHH", 0xFFFFFFFF, 0, 20, 20, 1, 0, 0, 0)
    root += struct.pack("<IIIHBBI", 0, 0, 0xFFFFFFFF, 8, 0, 0x10, 12)
    return struct.pack("<HHI", 3, 8, 8 + len(resources) + len(root)) + resources + root


def config():
    return {"android": {"versionCode": 12}, "extra": {"unrelated": "keep", "mentraPrBuild": {
        "schemaVersion": 1, "mobileFingerprint": FP, "mobileSourceCommit": SHA,
        "otaManifestUrl": "https://example.com/old.json"}}}


class RepackagingTests(unittest.TestCase):
    def test_typed_version_code(self):
        xml = manifest()
        self.assertEqual(apk.version_code(xml), 12)
        updated = apk.version_code(xml, 999)
        self.assertEqual(apk.version_code(updated), 999)
        self.assertEqual(len(xml), len(updated))
        with self.assertRaises(ValueError): apk.version_code(xml, 2_100_000_001)
        with self.assertRaises(ValueError): apk.version_code(b"invalid")

    def test_preserves_payload_and_removes_old_signatures(self):
        with tempfile.TemporaryDirectory() as tmp:
            source, target = Path(tmp) / "source.apk", Path(tmp) / "target.apk"
            with zipfile.ZipFile(source, "w") as output:
                output.writestr(apk.CONFIG, json.dumps(config()))
                output.writestr(apk.MANIFEST, manifest())
                output.writestr("assets/index.android.bundle", b"hermes payload")
                output.writestr("lib/arm64-v8a/libtest.so", b"native payload")
                output.writestr("META-INF/CERT.RSA", b"signature")
                output.writestr("META-INF/services/keep", b"resource")
            inputs = dict(fingerprint=FP, ota_url="https://example.com/new.json", head_sha=SHA, build_number=999)
            apk.rewrite_apk(source, target, **inputs)
            apk.verify_payload(source, target, **inputs)
            with zipfile.ZipFile(target) as result:
                self.assertNotIn("META-INF/CERT.RSA", result.namelist())
                self.assertIn("META-INF/services/keep", result.namelist())
            with self.assertRaises(ValueError): apk.rewrite_apk(source, target, **dict(inputs, fingerprint="c" * 64))
            with self.assertRaises(ValueError): apk.rewrite_apk(source, target, **dict(inputs, ota_url="file:///tmp/x"))

    @unittest.skipUnless(os.environ.get("ANDROID_HOME"), "ANDROID_HOME needed for real aapt2/signing proof")
    def test_real_android_manifest_alignment_and_resigning(self):
        sdk = Path(os.environ["ANDROID_HOME"])
        tools = sdk / "build-tools/36.0.0"
        android_jar = sdk / "platforms/android-36/android.jar"
        self.assertTrue(android_jar.exists(), "Install platforms;android-36 for integration proof")
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            def run(*args):
                return subprocess.check_output(list(map(str, args)), cwd=root, stderr=subprocess.STDOUT)
            xml = root / "AndroidManifest.xml"
            xml.write_text('<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="com.mentra.fixture" android:versionCode="12" android:versionName="1.0"><uses-sdk android:minSdkVersion="26"/><application android:hasCode="false"/></manifest>')
            unsigned = root / "unsigned.apk"
            run(tools / "aapt2", "link", "--manifest", xml, "-I", android_jar, "-o", unsigned)
            with zipfile.ZipFile(unsigned, "a") as archive:
                archive.writestr(apk.CONFIG, json.dumps(config()))
                archive.writestr("assets/index.android.bundle", b"unchanged compiled JS")
            credentials = root / "mobile/credentials"
            credentials.mkdir(parents=True)
            keystore = credentials / "upload-keystore.jks"
            run("keytool", "-genkeypair", "-storetype", "JKS", "-keystore", keystore, "-alias", "upload", "-storepass", "fixturepass", "-keypass", "fixturepass", "-keyalg", "RSA", "-dname", "CN=Repackaging Test", "-validity", "1")
            source = root / "signed.apk"
            run(tools / "apksigner", "sign", "--ks", keystore, "--ks-pass", "pass:fixturepass", "--out", source, unsigned)
            env = dict(os.environ, PR_OTA_MANIFEST_URL="https://example.com/new.json", PR_HEAD_SHA=SHA,
                       MENTRAOS_PINNED_BUILD_NUMBER="12345", ORG_GRADLE_PROJECT_MENTRAOS_UPLOAD_KEY_ALIAS="upload",
                       ORG_GRADLE_PROJECT_MENTRAOS_UPLOAD_STORE_PASSWORD="fixturepass",
                       ORG_GRADLE_PROJECT_MENTRAOS_UPLOAD_KEY_PASSWORD="fixturepass")
            target = root / "repacked.apk"
            result = subprocess.run([shutil.which("python3"), str(SCRIPT), "package", str(source), FP, str(target)], cwd=root, env=env, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn("versionCode='12345'", run(tools / "aapt", "dump", "badging", target).decode())
            # A second reuse proves the new output remains a valid reusable base.
            env["PR_OTA_MANIFEST_URL"] = "https://example.com/another-pr.json"
            env["MENTRAOS_PINNED_BUILD_NUMBER"] = "12346"
            again = subprocess.run([shutil.which("python3"), str(SCRIPT), "package", str(target), FP, str(root / "again.apk")], cwd=root, env=env, capture_output=True, text=True)
            self.assertEqual(again.returncode, 0, again.stdout + again.stderr)


if __name__ == "__main__":
    unittest.main()
