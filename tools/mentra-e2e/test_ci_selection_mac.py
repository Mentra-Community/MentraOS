import contextlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
import unittest
import zipfile
from unittest.mock import patch

import test_mac_ci as importer_tests
import mac_ci

spec = importlib.util.spec_from_file_location('selection_mac', Path(__file__).with_name('verify-ci-selection-mac.py'))
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)


class SelectionMacTests(unittest.TestCase):
    def setUp(self):
        self.fixture = importer_tests.MacArtifactTests()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.root, self.app = self.fixture.root, self.fixture.app

    # Use the same realistic generated package fixture as the canonical importer.
    def bridge_input(self):
        package = self.fixture.package(native=True)
        (package / 'Install.command').write_text('THIS DOWNLOADED FILE MUST NOT EXECUTE')
        archive = self.root / 'cached.zip'
        with zipfile.ZipFile(archive, 'w') as target:
            for path in package.rglob('*'):
                if path.is_file():
                    target.write(path, 'Mentra PR/' + path.relative_to(package).as_posix())
        receipt = self.root / 'receipt.json'
        receipt.write_text(json.dumps({'app': self.app}))
        output = self.root / 'fresh-extraction'
        argv = ['verifier', '--archive', str(archive), '--sha256', mac_ci.digest(archive),
                '--size', str(archive.stat().st_size), '--receipt', str(receipt), '--output', str(output)]
        return archive, output, argv

    def test_bridge_uses_real_safe_extraction_and_only_fixed_signature_commands(self):
        _, output, argv = self.bridge_input()
        stdout = io.StringIO()
        with patch.object(sys, 'argv', argv), patch.object(subprocess, 'run') as run, contextlib.redirect_stdout(stdout):
            run.return_value = subprocess.CompletedProcess([], 0, '', '')
            bridge.main()
        result = json.loads(stdout.getvalue())
        self.assertEqual(result['manifest'], str(output / 'Mentra PR/build.json'))
        self.assertEqual(result['observed']['executableSha256'], self.app['executableSha256'])
        self.assertEqual(run.call_count, 4)
        for call in run.call_args_list:
            self.assertEqual(call.args[0][0], '/usr/bin/codesign')
            self.assertIn('--verify', call.args[0])
        self.assertEqual(len(json.loads((output / 'verification-commands.json').read_text())), 4)

    def test_bridge_rejects_changed_archive_before_extraction_or_commands(self):
        archive, output, argv = self.bridge_input()
        archive.write_bytes(archive.read_bytes() + b'changed')
        with patch.object(sys, 'argv', argv), patch.object(subprocess, 'run') as run:
            with self.assertRaisesRegex(ValueError, 'Cached archive changed'):
                bridge.main()
        self.assertFalse(output.exists())
        run.assert_not_called()
