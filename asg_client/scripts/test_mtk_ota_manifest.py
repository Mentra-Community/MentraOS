"""Offline metadata and fake-process tests; no ADB, HTTP server or firmware runs."""
import base64
from contextlib import redirect_stderr, redirect_stdout
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import signal
import struct
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
import zipfile

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("manifest", HERE / "mtk-ota-manifest.py")
manifest = importlib.util.module_from_spec(spec)
spec.loader.exec_module(manifest)
spec = importlib.util.spec_from_file_location("observer", HERE / "mtk-ota-observe.py")
observer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(observer)
SOURCE, TARGET = "MentraLive_20260921.0", "MentraLive_20260113"


def ota(path, *, metadata=None, properties=None, duplicate=None, signature=b"", header=None):
    # Deliberately opaque: native Update Engine owns payload manifest parsing.
    payload_manifest = b"synthetic manifest"
    header = header if header is not None else b"CrAU" + struct.pack(">QQI", 2, len(payload_manifest), len(signature))
    payload = header + payload_manifest + signature + b"synthetic replacement data"
    encoded = lambda value: base64.b64encode(hashlib.sha256(value).digest()).decode()
    meta = {"ota-type": "AB", "ota-wipe": "yes", "ota-downgrade": "yes"}
    meta.update(metadata or {})
    props = {"POWERWASH": "1", "FILE_SIZE": str(len(payload)), "FILE_HASH": encoded(payload),
             "METADATA_SIZE": str(len(header + payload_manifest)), "METADATA_HASH": encoded(header + payload_manifest)}
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
        self.path = self.root / "selected-january-full.zip"

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

    def test_metadata_hash_excludes_signature_bytes(self):
        ota(self.path, signature=b"synthetic metadata signature")
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

    def test_invalid_ab_header_is_rejected(self):
        for header in (b"bad", b"CrAU" + struct.pack(">QQI", 1, 17, 0),
                       b"CrAU" + struct.pack(">QQI", 2, 1024, 0)):
            with self.subTest(header=header):
                ota(self.path, header=header)
                with self.assertRaises(ValueError):
                    self.prepare()

    def test_metadata_hashes_sizes_duplicates_and_wipe_must_agree(self):
        variants = [{"metadata": {"ota-type": "BLOCK"}}, {"metadata": {"ota-wipe": "no"}},
                    {"properties": {"POWERWASH": "2"}}, {"duplicate": "key"}, {"duplicate": "entry"}]
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

    def fake_shell_run(self, target=TARGET, transient_cid=False, log_eof=False, postboot_delay=0, observation_timeout=None):
        ota(self.path)
        bin_dir = self.root / "bin"
        bin_dir.mkdir()
        calls = self.root / "calls.jsonl"
        state = self.root / "new-boot"
        fake_adb = f'''#!{sys.executable}
import json,sys,time
from pathlib import Path
a=sys.argv[1:]; state=Path({str(state)!r})
with open({str(calls)!r},'a') as out: out.write(json.dumps(a)+'\\n')
old='11111111-1111-1111-1111-111111111111'; new='22222222-2222-2222-2222-222222222222'
if state.exists() and a[:1]==['shell']: time.sleep({postboot_delay!r})
if a==['shell','getprop','ro.custom.ota.version']: print({target!r} if state.exists() else {SOURCE!r})
elif a==['shell','cat','/proc/sys/kernel/random/boot_id']: print(new if state.exists() else old)
elif a==['shell','getprop','ro.boot.slot_suffix']: print('_b' if state.exists() else '_a')
elif a==['shell','getprop','sys.boot_completed']: print('1')
elif a==['shell','cat','/sys/block/mmcblk0/device/cid']:
    missing=state.with_suffix('.missing-cid')
    if state.exists() and {transient_cid!r} and not missing.exists(): missing.write_text('once')
    else: print('a'*32)
elif a==['logcat','-v','time']:
    state.write_text('synthetic')
    if not {log_eof!r}: print('MTK OTA success: 0')
elif a[:2]==['shell','am'] or a[:2]==['shell','rm'] or a[:1]==['reverse'] or a==['logcat','-c']: pass
elif len(a)==2 and a[0]=='shell' and a[1].startswith('rm -f '): pass
else: raise SystemExit('Unexpected fake adb command '+repr(a))
'''
        fake_python = f'''#!{sys.executable}
import os,signal,sys
if sys.argv[1:3]==['-m','http.server']:
    signal.pause() # fake server: deliberately no socket/network
else:
    if {observation_timeout!r} is not None and sys.argv[1].endswith('mtk-ota-observe.py'):
        sys.argv[sys.argv.index('--timeout')+1]=str({observation_timeout!r})
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
        self.assertIn("expected " + TARGET, result.stdout + result.stderr)
        self.assertEqual(sum(a[:3] == ["shell", "am", "broadcast"] for a in calls), 1)
        self.assertNotIn(["reboot"], calls)

    def test_transient_postboot_read_is_observed_again_without_resending(self):
        result, calls = self.fake_shell_run(transient_cid=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(sum(a[:3] == ["shell", "am", "broadcast"] for a in calls), 1)
        self.assertNotIn(["reboot"], calls)

    def test_bash_logcat_eof_verifies_target_without_success_log_or_resend(self):
        result, calls = self.fake_shell_run(log_eof=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("Log stream closed", result.stdout)
        self.assertIn("Verified target MTK", result.stdout)
        self.assertEqual(sum(a[:3] == ["shell", "am", "broadcast"] for a in calls), 1)
        self.assertNotIn(["reboot"], calls)

    def test_script_cleans_up_after_postboot_deadline_without_resending(self):
        result, calls = self.fake_shell_run(postboot_delay=2, observation_timeout=0.5)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("deadline expired", result.stderr)
        self.assertNotIn("Verified target MTK", result.stdout)
        self.assertIn("Cleanup complete", result.stdout)
        self.assertIn(["reverse", "--remove", "tcp:9876"], calls)
        self.assertEqual(sum(a[:3] == ["shell", "am", "broadcast"] for a in calls), 1)
        self.assertNotIn(["reboot"], calls)


class ObserverTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.calls = self.root / "calls.jsonl"
        self.processes = []
        self.output = io.StringIO()

    def observe(self, *, mode="success", read_delay=0, log_delay=0, timeout=1.2, activity_timeout=15):
        # Every child is a local fake; none can reach a device or network.
        adb = self.root / "adb"
        adb.write_text(f'''#!{sys.executable}
import json,os,sys,time
a=sys.argv[1:]
with open({str(self.calls)!r},'a') as out: out.write(json.dumps(a)+'\\n')
if a==['logcat','-v','time']:
    time.sleep({log_delay!r})
    if {mode!r}=='eof-live-process':
        os.close(1)
        time.sleep(60)
    elif {mode!r}=='silent': time.sleep(60)
    else:
        print('MTK OTA success: 0', flush=True)
        time.sleep(60)
else:
    time.sleep({read_delay!r})
    values={{'/proc/sys/kernel/random/boot_id':'new-boot', 'sys.boot_completed':'1',
            'ro.custom.ota.version':{TARGET!r}, 'ro.boot.slot_suffix':'_b',
            '/sys/block/mmcblk0/device/cid':'a'*32}}
    if len(a)!=3 or a[:2] not in (['shell','cat'],['shell','getprop']) or a[-1] not in values:
        raise SystemExit('Unexpected fake adb command '+repr(a))
    print(values[a[-1]])
''')
        adb.chmod(0o755)
        popen = subprocess.Popen

        def owned_process(*args, **kwargs):
            process = popen(*args, **kwargs)
            self.processes.append(process)
            return process

        with patch.dict(os.environ, {"PATH": f"{self.root}:{os.environ['PATH']}"}), \
                patch.object(observer.subprocess, "Popen", side_effect=owned_process), \
                redirect_stdout(self.output):
            return observer.observe("old-boot", "a" * 32, TARGET, "_b", timeout, activity_timeout)

    def assert_readers_reaped(self):
        self.assertTrue(self.processes)
        for process in self.processes:
            self.assertIsNotNone(process.returncode)
            with self.assertRaises(ChildProcessError):
                os.waitpid(process.pid, os.WNOHANG)
        calls = [json.loads(line) for line in self.calls.read_text().splitlines()] if self.calls.exists() else []
        self.assertTrue(all(a == ["logcat", "-v", "time"] or a[:2] in
                            (["shell", "cat"], ["shell", "getprop"]) for a in calls))

    def test_stalled_postboot_read_is_killed_and_reaped_at_deadline(self):
        started = time.monotonic()
        with self.assertRaisesRegex(TimeoutError, "deadline expired"):
            self.observe(read_delay=60)
        self.assertLess(time.monotonic() - started, 3)
        self.assertGreaterEqual(len(self.processes), 2)
        self.assertNotIn("Verified target MTK", self.output.getvalue())
        self.assert_readers_reaped()

    def test_logcat_and_postboot_share_the_same_deadline(self):
        started = time.monotonic()
        with self.assertRaisesRegex(TimeoutError, "deadline expired"):
            self.observe(log_delay=0.5, read_delay=3, timeout=2)
        self.assertLess(time.monotonic() - started, 3.5)
        calls = [json.loads(line) for line in self.calls.read_text().splitlines()]
        self.assertEqual(calls, [["logcat", "-v", "time"], ["shell", "cat", "/proc/sys/kernel/random/boot_id"]])
        self.assert_readers_reaped()

    def test_eof_with_a_still_alive_reader_verifies_then_reaps(self):
        self.assertEqual(self.observe(mode="eof-live-process", timeout=3), 0)
        self.assertIn("Verified target MTK", self.output.getvalue())
        self.assert_readers_reaped()

    def test_silent_logcat_is_killed_and_reaped_at_deadline(self):
        with self.assertRaisesRegex(TimeoutError, "deadline expired"):
            self.observe(mode="silent")
        self.assertEqual(len(self.processes), 1)
        self.assert_readers_reaped()

    def test_activity_timeout_cleans_up_without_starting_postboot_reads(self):
        self.assertEqual(self.observe(mode="silent", activity_timeout=0.4), 3)
        self.assertEqual(len(self.processes), 1)
        self.assert_readers_reaped()

    def test_terminal_hangup_stops_owned_logcat(self):
        pid_file = self.root / "reader.pid"
        adb = self.root / "adb"
        adb.write_text(f'''#!{sys.executable}
import os,signal
from pathlib import Path
Path({str(pid_file)!r}).write_text(str(os.getpid()))
signal.pause()
''')
        adb.chmod(0o755)
        process = subprocess.Popen([sys.executable, str(HERE / "mtk-ota-observe.py"),
                                    "--source-boot", "old", "--source-cid", "a" * 32,
                                    "--target-version", TARGET, "--target-slot", "_b"],
                                   env={**os.environ, "PATH": f"{self.root}:{os.environ['PATH']}"},
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        reader_pid = None
        try:
            deadline = time.monotonic() + 5
            while not pid_file.exists() and process.poll() is None and time.monotonic() < deadline:
                time.sleep(0.02)
            self.assertTrue(pid_file.exists(), "Fake logcat did not start")
            reader_pid = int(pid_file.read_text())
            process.send_signal(signal.SIGHUP)
            _, error = process.communicate(timeout=3)
            self.assertEqual(process.returncode, 1, error)
            self.assertIn("observation interrupted", error)
            with self.assertRaises(ProcessLookupError):
                os.kill(reader_pid, 0)
            reader_pid = None
        finally:
            if process.poll() is None:
                process.kill()
            process.wait()
            process.stdout.close()
            process.stderr.close()
            if reader_pid is not None:
                try:
                    os.kill(reader_pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass


if __name__ == "__main__":
    unittest.main()
