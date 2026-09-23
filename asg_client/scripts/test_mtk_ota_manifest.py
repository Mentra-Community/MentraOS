"""Offline metadata and fake-process tests; no ADB, HTTP server or firmware runs."""
import base64
from contextlib import redirect_stderr
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import unittest
import zipfile

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("manifest", HERE / "mtk-ota-manifest.py")
manifest = importlib.util.module_from_spec(spec)
spec.loader.exec_module(manifest)
SOURCE, TARGET = "MentraLive_20260921.0", "MentraLive_20260113"


def varint(value):
    result = bytearray()
    while value >= 128:
        result.append((value & 127) | 128)
        value >>= 7
    return bytes(result + bytes([value]))


def scalar(number, value):
    return varint(number << 3) + varint(value)


def blob(number, value):
    return varint((number << 3) | 2) + varint(len(value)) + value


def partition(operation=None, extra=b"", name=b"system"):
    info = scalar(1, 4096) + blob(2, b"x" * 32)
    return blob(1, name) + blob(7, info) + blob(8, scalar(1, 0) if operation is None else operation) + extra


def ota(path, *, minor=0, partitions=None, metadata=None, properties=None, duplicate=None, signature=b""):
    partitions = [partition()] if partitions is None else partitions
    wire = scalar(12, minor) + b"".join(blob(13, item) for item in partitions)
    header = b"CrAU" + struct.pack(">QQI", 2, len(wire), len(signature))
    payload = header + wire + signature + b"synthetic replacement data"
    encoded = lambda value: base64.b64encode(hashlib.sha256(value).digest()).decode()
    meta = {"ota-type": "AB", "ota-wipe": "yes", "ota-downgrade": "yes"}
    meta.update(metadata or {})
    props = {"POWERWASH": "1", "FILE_SIZE": str(len(payload)), "FILE_HASH": encoded(payload),
             "METADATA_SIZE": str(len(header + wire)), "METADATA_HASH": encoded(header + wire)}
    props.update(properties or {})
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr("payload.bin", payload)
        archive.writestr("payload_properties.txt", "\n".join(f"{k}={v}" for k, v in props.items()))
        archive.writestr("META-INF/com/android/metadata", "\n".join(f"{k}={v}" for k, v in meta.items())
                         + ("\nota-type=AB" if duplicate == "key" else ""))
        if duplicate == "entry":
            archive.writestr("payload.bin", payload)


class ManifestTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.path = self.root / "signed-january-full.zip"

    def prepare(self, **kwargs):
        with redirect_stderr(io.StringIO()):
            return manifest.prepare(self.path, SOURCE, end=TARGET, full=True, **kwargs)

    def test_full_wipe_uses_actual_base_and_exact_target_without_renaming(self):
        ota(self.path)
        value = self.prepare(port=9877)
        self.assertEqual(value, {"apps": {}, "mtk_patches": [{"start_firmware": SOURCE,
                         "end_firmware": TARGET, "url": "http://localhost:9877/mtk_firmware.zip",
                         "sha256": hashlib.sha256(self.path.read_bytes()).hexdigest(),
                         "size": self.path.stat().st_size}]})

    def test_full_requires_real_target_and_never_overrides_observed_base(self):
        ota(self.path)
        for args in ({"end": None}, {"end": "current+1"}, {"end": "MentraLive_202609210"}, {"start": "MentraLive_20260709"}):
            with self.subTest(args=args), self.assertRaises(ValueError):
                manifest.prepare(self.path, SOURCE, full=True, **args)

    def test_full_nonwiping_upgrade_and_same_version_are_explicit(self):
        ota(self.path, metadata={"ota-wipe": "no", "ota-downgrade": "no"}, properties={"POWERWASH": "0"})
        for target in (SOURCE, "MentraLive_20260922.0"):
            with redirect_stderr(io.StringIO()):
                value = manifest.prepare(self.path, SOURCE, end=target, full=True)
            self.assertEqual(value["mtk_patches"][0]["end_firmware"], target)
        with self.assertRaisesRegex(ValueError, "ota-downgrade"):
            self.prepare()

    def test_metadata_signature_bytes_and_full_compressed_replacement_types(self):
        for kind in (0, 1, 8):
            with self.subTest(kind=kind):
                ota(self.path, signature=b"synthetic metadata signature", partitions=[partition(operation=scalar(1, kind))])
                self.assertEqual(self.prepare()["mtk_patches"][0]["end_firmware"], TARGET)

    def test_incremental_filename_and_target_contract_remains(self):
        path = self.root / "mtk_firmware_20260113_20260921.0.zip"
        path.write_bytes(b"unchanged incremental test input")
        value = manifest.prepare(path, TARGET)
        self.assertEqual(value["mtk_patches"][0]["end_firmware"], SOURCE)
        with self.assertRaisesRegex(ValueError, "start version"):
            manifest.prepare(path, SOURCE)
        with self.assertRaisesRegex(ValueError, "end version"):
            manifest.prepare(path, TARGET, end="MentraLive_20260922.0")

    def test_delta_or_source_dependent_payload_is_not_full(self):
        variants = [{"minor": 2}, {"partitions": []}, {"partitions": [partition(extra=blob(6, b""))]}]
        variants += [{"partitions": [partition(operation=scalar(1, kind))]} for kind in (2, 3, 4, 5, 6, 7)]
        variants += [{"partitions": [partition(operation=scalar(1, 0) + blob(field, b""))]} for field in (4, 5, 9)]
        for variant in variants:
            with self.subTest(variant=variant):
                ota(self.path, **variant)
                with self.assertRaises(ValueError):
                    self.prepare()

    def test_metadata_hashes_sizes_duplicates_and_wipe_must_agree(self):
        variants = [{"metadata": {"ota-type": "BLOCK"}}, {"metadata": {"ota-wipe": "no"}},
                    {"properties": {"POWERWASH": "2"}}, {"duplicate": "key"}, {"duplicate": "entry"},
                    {"partitions": [partition(), partition()]},
                    {"partitions": [partition(extra=blob(1, b"boot"))]},
                    {"partitions": [partition(operation=scalar(1, 0) + scalar(1, 1))]}]
        variants += [{"properties": {name: "wrong"}} for name in ("FILE_SIZE", "FILE_HASH", "METADATA_SIZE", "METADATA_HASH")]
        for variant in variants:
            with self.subTest(variant=variant):
                ota(self.path, **variant)
                with self.assertRaises(ValueError):
                    self.prepare()

    def test_offline_cli_outputs_only_manifest_json(self):
        ota(self.path)
        result = subprocess.run([sys.executable, str(HERE / "mtk-ota-manifest.py"), str(self.path),
                                 "--full", "--device-version", SOURCE, "--end-firmware", TARGET], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["mtk_patches"][0]["end_firmware"], TARGET)
        self.assertIn("POWERWASH=1", result.stderr)

    def fake_shell_run(self, target=TARGET, transient_cid=False):
        ota(self.path)
        bin_dir = self.root / "bin"
        bin_dir.mkdir()
        calls = self.root / "calls.jsonl"
        state = self.root / "new-boot"
        fake_adb = f'''#!{sys.executable}
import json,sys
from pathlib import Path
a=sys.argv[1:]; state=Path({str(state)!r})
with open({str(calls)!r},'a') as out: out.write(json.dumps(a)+'\\n')
old='11111111-1111-1111-1111-111111111111'; new='22222222-2222-2222-2222-222222222222'
if a==['shell','getprop','ro.custom.ota.version']: print({target!r} if state.exists() else {SOURCE!r})
elif a==['shell','cat','/proc/sys/kernel/random/boot_id']: print(new if state.exists() else old)
elif a==['shell','getprop','ro.boot.slot_suffix']: print('_b' if state.exists() else '_a')
elif a==['shell','getprop','sys.boot_completed']: print('1')
elif a==['shell','cat','/sys/block/mmcblk0/device/cid']:
    missing=state.with_suffix('.missing-cid')
    if state.exists() and {transient_cid!r} and not missing.exists(): missing.write_text('once')
    else: print('a'*32)
elif a==['logcat','-v','time']: state.write_text('synthetic'); print('MTK OTA success: 0')
elif a[:2]==['shell','am'] or a[:2]==['shell','rm'] or a[:1]==['reverse'] or a==['logcat','-c']: pass
elif len(a)==2 and a[0]=='shell' and a[1].startswith('rm -f '): pass
else: raise SystemExit('Unexpected fake adb command '+repr(a))
'''
        fake_python = f'''#!{sys.executable}
import os,signal,sys
if sys.argv[1:3]==['-m','http.server']:
    signal.pause() # fake server: deliberately no socket/network
else:
    os.execv({sys.executable!r},[{sys.executable!r}]+sys.argv[1:])
'''
        for name, body in {"adb": fake_adb, "python3": fake_python, "sleep": "#!/bin/sh\nexit 0\n"}.items():
            file = bin_dir / name
            file.write_text(body)
            file.chmod(0o755)
        env = {**os.environ, "PATH": f"{bin_dir}:{os.environ['PATH']}", "ANDROID_SERIAL": "synthetic-only"}
        result = subprocess.run(["/bin/bash", str(HERE / "test-mtk-ota.sh"), str(self.path),
                                 "--full", "--end-firmware", TARGET], env=env, capture_output=True, text=True, timeout=15)
        return result, [json.loads(line) for line in calls.read_text().splitlines()]

    def test_script_dispatches_once_waits_for_target_and_does_not_reboot_again(self):
        result, calls = self.fake_shell_run()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("Verified target MTK", result.stdout)
        self.assertEqual(sum(a[:3] == ["shell", "am", "broadcast"] for a in calls), 1)
        self.assertNotIn(["reboot"], calls)
        self.assertIn(["reverse", "--no-rebind", "tcp:9876", "tcp:9876"], calls)
        self.assertIn(["reverse", "--remove", "tcp:9876"], calls)

    def test_wrong_postboot_target_is_failure_without_a_second_dispatch(self):
        result, calls = self.fake_shell_run(target="MentraLive_20260114")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("expected " + TARGET, result.stdout)
        self.assertEqual(sum(a[:3] == ["shell", "am", "broadcast"] for a in calls), 1)
        self.assertNotIn(["reboot"], calls)

    def test_transient_postboot_read_is_observed_again_without_resending(self):
        result, calls = self.fake_shell_run(transient_cid=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(sum(a[:3] == ["shell", "am", "broadcast"] for a in calls), 1)
        self.assertNotIn(["reboot"], calls)


if __name__ == "__main__":
    unittest.main()
