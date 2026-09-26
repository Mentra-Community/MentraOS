import json
from pathlib import Path
import plistlib
import shutil
import subprocess
import tempfile
import unittest

from repackage import CONFIG, read_app, rewrite_app, verify_payload, unpack

FP, SHA = 'a' * 64, 'b' * 40
URL = f'https://artifactscdn.mentraglass.com/Mentra-Community/MentraOS/releases/pr-builds/ota-pr-42-{SHA}.json'


class RepackageTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.before = self.root / 'before.app'
        self.after = self.root / 'after.app'
        (self.before / 'EXConstants.bundle').mkdir(parents=True)
        info = {'CFBundleIdentifier':'com.mentra.mentra', 'CFBundleExecutable':'Mentra',
                'CFBundleVersion':'7', 'CFBundleShortVersionString':'3.2.1',
                'CFBundlePackageType':'APPL', 'CFBundleSupportedPlatforms':['iPhoneOS']}
        (self.before / 'Info.plist').write_bytes(plistlib.dumps(info))
        (self.before / CONFIG).write_text(json.dumps({'ios':{'buildNumber':'7'},'extra':{'keep':'value',
            'mentraPrBuild':{'schemaVersion':1,'mobileFingerprint':FP,'mobileSourceCommit':'c'*40,'otaManifestUrl':''}}}))
        (self.before / 'main.jsbundle').write_bytes(b'original compiled JavaScript')
        subprocess.run(['xcrun','clang','-x','c','-','-o',str(self.before/'Mentra')],
                       input=b'int main(void) { return 0; }', check=True, capture_output=True)
        self.sign(self.before)
        shutil.copytree(self.before, self.after)
        self.inputs = dict(fingerprint=FP,ota_url=URL,head_sha=SHA,build_number=123,
                           metadata={'commit':SHA,'branch':'new-pr','time':'2026-09-21','user':'tester'})

    def sign(self, app):
        subprocess.run(['codesign','--force','--sign','-','--timestamp=none',str(app)], check=True, capture_output=True)

    def package(self):
        rewrite_app(self.after, **self.inputs)
        self.sign(self.after)

    def test_repackaging_updates_pr_identity_and_ota_without_changing_compiled_code(self):
        self.package()
        verify_payload(self.before, self.after, **self.inputs)
        info, config = read_app(self.after, FP)
        self.assertEqual(info['CFBundleVersion'], '123')
        build = config['extra']['mentraPrBuild']
        self.assertEqual(build['mobileSourceCommit'], 'c'*40)
        self.assertEqual(build['otaManifestUrl'], URL)
        self.assertEqual(build['buildInfo']['commit'], SHA)
        self.assertEqual(config['extra']['keep'], 'value')

    def test_rejects_mutated_javascript_or_resources(self):
        self.package()
        (self.after / 'main.jsbundle').write_bytes(b'different code')
        with self.assertRaisesRegex(ValueError, 'payload or resources changed'):
            verify_payload(self.before, self.after, **self.inputs)

    def test_rejects_mutated_native_code_even_after_valid_resigning(self):
        self.package()
        subprocess.run(['xcrun','clang','-x','c','-','-o',str(self.after/'Mentra')],
                       input=b'int main(void) { return 42; }', check=True, capture_output=True)
        self.sign(self.after)
        with self.assertRaisesRegex(ValueError, 'executable changed'):
            verify_payload(self.before, self.after, **self.inputs)

    def test_rejects_unrelated_info_plist_changes(self):
        self.package()
        file = self.after/'Info.plist'
        info=plistlib.loads(file.read_bytes()); info['UIBackgroundModes'] = []
        file.write_bytes(plistlib.dumps(info))
        with self.assertRaisesRegex(ValueError, 'configuration does not match'):
            verify_payload(self.before, self.after, **self.inputs)

    def test_legacy_or_different_source_artifacts_require_compilation(self):
        with self.assertRaisesRegex(ValueError, 'fingerprint mismatch'):
            read_app(self.before, 'd'*64)
        (self.before / CONFIG).write_text('{}')
        with self.assertRaisesRegex(ValueError, 'does not support PR repackaging'):
            read_app(self.before, FP)


if __name__ == '__main__':
    unittest.main()
