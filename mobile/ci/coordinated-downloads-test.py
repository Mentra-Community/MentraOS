import importlib.util
import json
from pathlib import Path
import plistlib
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('downloads', Path(__file__).with_name('coordinated-downloads.py'))
downloads = importlib.util.module_from_spec(spec)
spec.loader.exec_module(downloads)


class AppIdentity(unittest.TestCase):
    def test_ota_runtime_override_cannot_hide_behind_correct_bundle_strings(self):
        with tempfile.TemporaryDirectory() as temporary:
            app = Path(temporary)
            plan = {'native': {'buildNumber': 42, 'marketingVersion': '3.2.1'},
                    'releaseIdentity': '3.2.1-dev.42', 'sourceCommit': 'a' * 40}
            ota = 'https://example.com/this-release.json'
            (app / 'Info.plist').write_bytes(plistlib.dumps({'CFBundleIdentifier': downloads.BUNDLE_ID,
                'CFBundleExecutable': 'Mentra', 'CFBundleVersion': '42', 'CFBundleShortVersionString': '3.2.1',
                'CFBundleSupportedPlatforms': ['iPhoneOS']}))
            (app / 'main.jsbundle').write_text(' '.join([plan['releaseIdentity'], plan['sourceCommit'], ota]))
            (app / 'EXConstants.bundle').mkdir()
            config = app / 'EXConstants.bundle/app.config'
            config.write_text('{}')
            with patch.object(downloads, 'run') as run:
                downloads.validate_app(app, plan, ota)
                self.assertEqual(run.call_count, 2)
                config.write_text(json.dumps({'extra': {'mentraPrBuild': {'otaManifestUrl': ''}}}))
                with self.assertRaisesRegex(ValueError, 'PR runtime'):
                    downloads.validate_app(app, plan, ota)
                config.write_text('{}')
                with self.assertRaisesRegex(ValueError, 'OTA pin'):
                    downloads.validate_app(app, plan, 'https://example.com/other-release.json')
                with self.assertRaisesRegex(ValueError, 'identity'):
                    downloads.validate_app(app, {**plan, 'native': {**plan['native'], 'buildNumber': 43}}, ota)


if __name__ == '__main__':
    unittest.main()
