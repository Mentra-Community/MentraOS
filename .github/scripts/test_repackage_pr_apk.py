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
    return {"android": {"versionCode": 12}, "extra": {"unrelated": "keep", "mentraBuild": {
        "schemaVersion": 2, "mobileFingerprint": FP, "mobileSourceCommit": SHA,
        "otaManifestUrl": "https://example.com/old.json"}}}


APK, AAB = apk.Layout(False), apk.Layout(True)


def proto_manifest(code=12):
    """aapt2's proto XmlNode for <manifest android:versionCode=code package="x">."""
    field = lambda number, payload: apk._message(number, payload)
    version = (field(1, apk.ANDROID_NAMESPACE) + field(2, b"versionCode") + field(3, str(code).encode())
               + field(6, field(7, apk._encode_varint(6 << 3) + apk._encode_varint(code))))
    package = field(2, b"package") + field(3, b"com.mentra.fixture")
    element = field(2, b"manifest") + field(4, package) + field(4, version) + field(5, field(1, field(2, b"application")))
    return field(1, element) + field(2, field(1, b"\x08\x01"))


def write_archive(path, files, config_data):
    with zipfile.ZipFile(path, "w") as output:
        output.writestr(files.config, json.dumps(config_data))
        output.writestr(files.manifest, proto_manifest() if files.bundle else manifest())
        prefix = "base/" if files.bundle else ""
        output.writestr(f"{prefix}assets/index.android.bundle", b"hermes payload")
        output.writestr(f"{prefix}lib/arm64-v8a/libtest.so", b"native payload")
        output.writestr("META-INF/CERT.RSA", b"signature")
        output.writestr("META-INF/services/keep", b"resource")


INPUTS = dict(fingerprint=FP, ota_url="https://example.com/new.json", build_number=999, identity=None,
              metadata={"commit": SHA, "branch": "feature", "user": "tester", "time": "now"})


class RepackagingTests(unittest.TestCase):
    def test_proto_version_code(self):
        xml = proto_manifest()
        self.assertEqual(apk.proto_version_code(xml), 12)
        updated = apk.proto_version_code(xml, 305000999)
        self.assertEqual(apk.proto_version_code(updated), 305000999)
        # Only the versionCode attribute changes; the rest of the tree is copied as is.
        self.assertEqual(updated, proto_manifest(305000999))
        with self.assertRaises(ValueError): apk.proto_version_code(xml, 0)

    def test_aab_preserves_payload_and_writes_a_release(self):
        with tempfile.TemporaryDirectory() as tmp:
            source, target = Path(tmp) / "source.aab", Path(tmp) / "target.aab"
            write_archive(source, AAB, config())
            inputs = dict(INPUTS, identity="3.5.0-beta.1351")
            apk.rewrite(source, target, **inputs)
            apk.verify_payload(source, target, **inputs)
            with zipfile.ZipFile(target) as result:
                self.assertNotIn("META-INF/CERT.RSA", result.namelist())
                build = json.loads(result.read(AAB.config))["extra"]["mentraBuild"]
                self.assertEqual(apk.proto_version_code(result.read(AAB.manifest)), 999)
            self.assertEqual((build["identity"], build["buildNumber"]), ("3.5.0-beta.1351", 999))
            with self.assertRaises(ValueError): apk.rewrite(source, target, **dict(inputs, identity="next"))

    def test_release_inputs_come_from_the_release_environment(self):
        env = {"MENTRAOS_PINNED_BUILD_NUMBER": "305000151", "MENTRA_APP_IDENTITY": "3.5.0-beta.1351",
               "MENTRA_OTA_MANIFEST_URL": "https://example.com/ota.json", "MENTRA_BUILD_COMMIT": SHA,
               "MENTRA_BUILD_BRANCH": "staging", "MENTRA_BUILD_USER": "release", "MENTRA_BUILD_TIME": "now"}
        self.assertEqual(apk.packaging_inputs(env), dict(
            ota_url="https://example.com/ota.json", build_number=305000151, identity="3.5.0-beta.1351",
            metadata={"commit": SHA, "branch": "staging", "user": "release", "time": "now"}))
        pr = {"MENTRAOS_PINNED_BUILD_NUMBER": "7", "PR_OTA_MANIFEST_URL": "https://example.com/pr.json",
              "PR_HEAD_SHA": SHA, "GITHUB_HEAD_REF": "feature", "GITHUB_ACTOR": "tester"}
        self.assertIsNone(apk.packaging_inputs(pr)["identity"])

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
            write_archive(source, APK, config())
            inputs = INPUTS
            apk.rewrite(source, target, **inputs)
            apk.verify_payload(source, target, **inputs)
            with zipfile.ZipFile(target) as result:
                self.assertNotIn("META-INF/CERT.RSA", result.namelist())
                self.assertIn("META-INF/services/keep", result.namelist())
            with self.assertRaises(ValueError): apk.rewrite(source, target, **dict(inputs, fingerprint="c" * 64))
            with self.assertRaises(ValueError): apk.rewrite(source, target, **dict(inputs, ota_url="file:///tmp/x"))

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
                archive.writestr(APK.config, json.dumps(config()))
                archive.writestr("assets/index.android.bundle", b"unchanged compiled JS")
            credentials = root / "mobile/credentials"
            credentials.mkdir(parents=True)
            keystore = credentials / "upload-keystore.jks"
            run("keytool", "-genkeypair", "-storetype", "JKS", "-keystore", keystore, "-alias", "upload", "-storepass", "fixturepass", "-keypass", "fixturepass", "-keyalg", "RSA", "-dname", "CN=Repackaging Test", "-validity", "1")
            source = root / "signed.apk"
            run(tools / "apksigner", "sign", "--ks", keystore, "--ks-pass", "pass:fixturepass", "--out", source, unsigned)
            env = dict(os.environ, GITHUB_HEAD_REF="fixture-pr", GITHUB_ACTOR="tester", PR_OTA_MANIFEST_URL="https://example.com/new.json", PR_HEAD_SHA=SHA,
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

            # An AAB: aapt2's proto manifest in a base module, signed with jarsigner as Gradle does.
            proto = root / "proto.zip"
            run(tools / "aapt2", "link", "--proto-format", "--manifest", xml, "-I", android_jar, "-o", proto)
            unsigned_aab = root / "unsigned.aab"
            with zipfile.ZipFile(proto) as linked, zipfile.ZipFile(unsigned_aab, "w") as bundle:
                bundle.writestr(AAB.manifest, linked.read("AndroidManifest.xml"))
                bundle.writestr("base/resources.pb", linked.read("resources.pb"))
                bundle.writestr(AAB.config, json.dumps(config()))
                bundle.writestr("base/assets/index.android.bundle", b"unchanged compiled JS")
            source_aab = root / "signed.aab"
            run("jarsigner", "-keystore", keystore, "-storepass", "fixturepass", "-signedjar", source_aab, unsigned_aab, "upload")
            env.update(MENTRA_APP_IDENTITY="3.5.0-beta.7", MENTRA_OTA_MANIFEST_URL="https://example.com/release.json",
                       MENTRA_BUILD_COMMIT=SHA, MENTRA_BUILD_BRANCH="staging", MENTRA_BUILD_USER="release", MENTRA_BUILD_TIME="now")
            target_aab = root / "release.aab"
            bundled = subprocess.run([shutil.which("python3"), str(SCRIPT), "package", str(source_aab), FP, str(target_aab)], cwd=root, env=env, capture_output=True, text=True)
            self.assertEqual(bundled.returncode, 0, bundled.stdout + bundled.stderr)
            with zipfile.ZipFile(target_aab) as result:
                self.assertEqual(apk.proto_version_code(result.read(AAB.manifest)), 12346)
                self.assertEqual(json.loads(result.read(AAB.config))["extra"]["mentraBuild"]["identity"], "3.5.0-beta.7")


if __name__ == "__main__":
    unittest.main()
