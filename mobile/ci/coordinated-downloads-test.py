import importlib.util
import base64
import hashlib
import json
from pathlib import Path
import plistlib
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('downloads', Path(__file__).with_name('coordinated-downloads.py'))
downloads = importlib.util.module_from_spec(spec)
spec.loader.exec_module(downloads)
import artifacts


class AppIdentity(unittest.TestCase):
    def test_registered_device_export_explicitly_preserves_swift_symbols(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            cert = b'signing-certificate'
            profile = {'Name': artifacts.PROFILE_NAME, 'UUID': 'profile', 'ExpirationDate': 'future',
                       'DeveloperCertificates': [cert], 'ProvisionedDevices': ['registered-device']}
            with patch.dict('os.environ', {'IOS_PR_PROFILE_BASE64': base64.b64encode(b'profile').decode()}), \
                 patch.object(artifacts, 'read_profile', return_value=profile), \
                 patch.object(artifacts, 'validate_profile', return_value='team'), \
                 patch.object(artifacts, 'run', return_value=hashlib.sha1(cert).hexdigest().upper().encode()), \
                 patch.object(artifacts, 'verify_private_signing'), patch.object(Path, 'home', return_value=root):
                downloads.configure(root / 'signing', 'keychain')
            options = plistlib.loads((root / 'signing/ExportOptions.plist').read_bytes())
            self.assertFalse(options['stripSwiftSymbols'])
            self.assertEqual(options['thinning'], '<none>')

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


@unittest.skipUnless(sys.platform == 'darwin', 'Needs native Mach-O signing tools')
class CompiledCode(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        base = Path(temporary.name)
        self.root = base / 'temporary-export'
        self.root.mkdir()
        self.source, self.exported = self.root / 'store', self.root / 'adhoc'
        self.source.mkdir(); self.exported.mkdir()
        (self.root / 'signing').mkdir()
        (self.root / 'signing/ExportOptions.plist').write_bytes(plistlib.dumps({'stripSwiftSymbols': False}))
        subprocess.run(['xcrun', 'clang', '-x', 'c', '-', '-o', str(self.source / 'Mentra')],
                       input=b'int main(void) { return 0; }', check=True, capture_output=True)
        subprocess.run(['codesign', '--force', '--sign', '-', str(self.source / 'Mentra')],
                       check=True, capture_output=True)
        shutil.copy2(self.source / 'Mentra', self.exported / 'Mentra')
        self.diagnostics = base / 'export-diagnostics'

    def verify(self):
        downloads.verify_compiled_code(self.source, self.exported, 'Mentra', self.root, self.diagnostics)

    def test_accepts_resigning_without_dropping_the_bytewise_guarantee(self):
        entitlements = self.root / 'entitlements.plist'
        entitlements.write_bytes(plistlib.dumps({'com.apple.security.get-task-allow': True}))
        subprocess.run(['codesign', '--force', '--sign', '-', '--entitlements', str(entitlements),
                        str(self.exported / 'Mentra')], check=True, capture_output=True)
        self.verify()
        self.assertFalse(self.diagnostics.exists())

    def test_accepts_changed_signature_allocation_without_touching_signed_exports(self):
        entitlements = self.root / 'large-entitlements.plist'
        entitlements.write_bytes(plistlib.dumps({'com.mentra.signature-probe': 'x' * 64000}))
        subprocess.run(['codesign', '--force', '--sign', '-', '--entitlements', str(entitlements),
                        str(self.exported / 'Mentra')], check=True, capture_output=True)
        before = [(app / 'Mentra').read_bytes() for app in [self.source, self.exported]]
        # Reproduce the false mismatch caused by removing two different-size signatures.
        removed = []
        for name, original in zip(['before-source', 'before-export'], before):
            path = self.root / name
            path.write_bytes(original)
            subprocess.run(['codesign', '--remove-signature', str(path)], check=True, capture_output=True)
            removed.append(path.read_bytes())
        self.assertNotEqual(*removed)
        self.verify()
        self.assertEqual(before, [(app / 'Mentra').read_bytes() for app in [self.source, self.exported]])
        self.assertFalse(self.diagnostics.exists())

    def test_changed_code_is_rejected_and_exact_pair_survives_temporary_cleanup(self):
        subprocess.run(['xcrun', 'clang', '-x', 'c', '-', '-o', str(self.exported / 'Mentra')],
                       input=b'int main(void) { return 42; }', check=True, capture_output=True)
        subprocess.run(['codesign', '--force', '--sign', '-', str(self.exported / 'Mentra')],
                       check=True, capture_output=True)
        with self.assertRaisesRegex(ValueError, 'changed compiled iOS code'):
            self.verify()
        expected = {name: (source / 'Mentra').read_bytes()
                    for name, source in [('store', self.source), ('adhoc', self.exported)]}
        shutil.rmtree(self.root)
        for name, binary in expected.items():
            self.assertEqual((self.diagnostics / f'{name}-executable').read_bytes(), binary)
        facts = json.loads((self.diagnostics / 'comparison.json').read_text())
        self.assertFalse(facts['compiledCodeAccepted'])
        self.assertEqual(facts['exportOptions'], {'stripSwiftSymbols': False})
        self.assertGreaterEqual(facts['firstDifferingOffset'], 0)
        self.assertNotEqual(facts['store']['unsignedSha256'], facts['adhoc']['unsignedSha256'])


if __name__ == '__main__':
    unittest.main()
