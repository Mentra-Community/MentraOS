"""Exercise the actual pre-checkout helper embedded in the iOS workflow."""
import errno
import os
from pathlib import Path
import runpy
import subprocess
import tempfile
import textwrap
import unittest
from unittest.mock import patch


WORKFLOW = Path(__file__).resolve().parents[3] / ".github/workflows/mentra-app-ios-build.yml"
SOURCE = WORKFLOW.read_text()
BOOTSTRAP = 'cat > "$RUNNER_TEMP/mentra-ios-cleanup.py" <<\'PY\'\n'
HELPER = textwrap.dedent(SOURCE.split(BOOTSTRAP, 1)[1].split("          PY\n", 1)[0])


class CleanupTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.script = self.root / "cleanup.py"
        self.script.write_text(HELPER)
        self.remove_output = runpy.run_path(str(self.script))["remove_output"]
        self.target = self.root / "mobile/ios/build-device"
        self.target.mkdir(parents=True)
        sleeper = patch("time.sleep")
        self.sleep = sleeper.start()
        self.addCleanup(sleeper.stop)

    def test_directory_not_empty_and_busy_races_recover(self):
        import shutil
        real_remove = shutil.rmtree
        errors = [errno.ENOTEMPTY, errno.EBUSY]

        def remove(target):
            if errors:
                raise OSError(errors.pop(0), "Concurrent build write", str(target))
            real_remove(target)

        with patch("shutil.rmtree", side_effect=remove) as mocked:
            self.remove_output(self.target)
        self.assertEqual(mocked.call_count, 3)
        self.assertEqual([call.args[0] for call in self.sleep.call_args_list], [1, 2])
        self.assertFalse(self.target.exists())

    def test_persistent_race_exhausts_bounded_retries_and_fails(self):
        with patch("shutil.rmtree", side_effect=OSError(errno.ENOTEMPTY, "Still writing")) as mocked:
            with self.assertRaises(OSError):
                self.remove_output(self.target)
        self.assertEqual(mocked.call_count, 6)
        self.assertEqual([call.args[0] for call in self.sleep.call_args_list], [1, 2, 4, 4, 4])
        self.assertTrue(self.target.exists())

    def test_permission_and_io_errors_fail_without_retry(self):
        for code in [errno.EACCES, errno.EPERM, errno.EIO]:
            with self.subTest(code=code), patch("shutil.rmtree", side_effect=OSError(code, "Permanent failure")):
                with self.assertRaises(OSError):
                    self.remove_output(self.target)
        self.sleep.assert_not_called()

    def test_missing_child_is_retried_but_missing_root_is_success(self):
        import shutil
        real_remove = shutil.rmtree
        with patch("shutil.rmtree") as mocked:
            # Second call really removes the root rather than leaving it behind.
            def remove(target):
                if mocked.call_count == 1:
                    raise FileNotFoundError(errno.ENOENT, "Child disappeared")
                real_remove(target)
            mocked.side_effect = remove
            self.remove_output(self.target)
        self.assertEqual(mocked.call_count, 2)
        self.remove_output(self.target)

    def test_root_recreated_after_deletion_is_retried(self):
        import shutil
        real_remove = shutil.rmtree
        with patch("shutil.rmtree") as mocked:
            def remove(target):
                real_remove(target)
                if mocked.call_count == 1:
                    target.mkdir()
            mocked.side_effect = remove
            self.remove_output(self.target)
        self.assertEqual(mocked.call_count, 2)
        self.assertFalse(self.target.exists())

    def test_cli_removes_only_requested_outputs_and_preserves_symlink_destination(self):
        pods = self.root / "mobile/ios/Pods/keep"
        pods.parent.mkdir()
        pods.write_text("cache")
        neighbor = self.root / "other-runner/keep"
        neighbor.parent.mkdir()
        neighbor.write_text("active build")
        build = self.root / "mobile/ios/build"
        build.symlink_to(neighbor.parent, target_is_directory=True)
        (self.target / "output").write_text("old")
        result = subprocess.run(
            ["python3", str(self.script), "mobile/ios/build", "mobile/ios/build-device"],
            env={**os.environ, "GITHUB_WORKSPACE": str(self.root)}, capture_output=True, text=True,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(os.path.lexists(build))
        self.assertFalse(self.target.exists())
        self.assertEqual(pods.read_text(), "cache")
        self.assertEqual(neighbor.read_text(), "active build")
        result = subprocess.run(
            ["python3", str(self.script), "../other-runner"],
            env={**os.environ, "GITHUB_WORKSPACE": str(self.root)}, capture_output=True, text=True,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue(neighbor.exists())

    def test_cli_refuses_a_symlinked_parent_directory(self):
        ios = self.root / "mobile/ios"
        other_runner = self.root / "other-runner"
        ios.rename(other_runner)
        ios.symlink_to(other_runner, target_is_directory=True)
        result = subprocess.run(
            ["python3", str(self.script), "mobile/ios/build-device"],
            env={**os.environ, "GITHUB_WORKSPACE": str(self.root)}, capture_output=True, text=True,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue((other_runner / "build-device").exists())

    def test_bootstrap_precedes_checkout_and_clean_retry_reuses_it(self):
        self.assertLess(SOURCE.index("mentra-ios-cleanup.py"), SOURCE.index("uses: actions/checkout@v4"))
        self.assertIn('python3 "$RUNNER_TEMP/mentra-ios-cleanup.py" mobile/ios/Pods mobile/ios/build-device', SOURCE)
        self.assertIn("python3 mobile/ci/pr-ios/test_cleanup_workflow.py", SOURCE)


if __name__ == "__main__":
    unittest.main()
