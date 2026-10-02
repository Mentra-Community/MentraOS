"""Exercise standalone helper compatibility with local provider fakes."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
import zipfile

ROOT = Path(__file__).resolve().parents[1]


class HelperTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name)
        self.env = dict(os.environ, PATH=str(self.path) + ':' + os.environ['PATH'])

    def executable(self, name, body):
        path = self.path / name
        path.write_text('#!/usr/bin/env python3\n' + body)
        path.chmod(0o755)

    def test_mirror_import_keeps_credentials_out_of_arguments_and_checks_digest(self):
        self.env.update(SOURCE_REGISTRY_USERNAME='reader', SOURCE_REGISTRY_PASSWORD='private-value',
                        HELPER_TEST_DIRECTORY=str(self.path))
        self.executable('az', '''import json,os,sys
from pathlib import Path
p=Path(os.environ['HELPER_TEST_DIRECTORY']);a=sys.argv[1:]
assert 'private-value' not in a
if a[:3]==['acr','repository','list']: print('[]')
elif a[:2]==['acr','show']: print('/subscriptions/test/registries/test')
elif a[:1]==['rest']:
 d=json.loads(Path(a[a.index('--body')+1][1:]).read_text())
 assert d['source']['registryUri']=='mirror.example.com'
 assert d['source']['sourceImage']=='team/cloud@sha256:'+'a'*64
 assert d['source']['credentials']['password']=='private-value'
 assert d['mode']=='NoForce'
 (p/'imported').touch()
elif a[:3]==['acr','repository','show']:
 assert (p/'imported').exists();print('sha256:'+'a'*64)
else: sys.exit(9)
''')
        result = subprocess.run(['bash', str(ROOT / 'scripts/import-runtime-image.sh'), 'testregistry',
                                 'mirror.example.com/team/cloud@sha256:' + 'a' * 64, 'release-1'],
                                env=self.env, text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn('private-value', result.stdout + result.stderr)
        self.assertFalse(list(self.path.glob('mentra-acr-import.*')))

    def smoke(self, with_call):
        import hashlib
        bundle = self.path / 'bundle.zip'
        with zipfile.ZipFile(bundle, 'w') as archive:
            archive.writestr('miniapp.json', '{}')
        origin = 'https://workspace.example'
        managed = ([dict(packageName='com.mentra.call', version='1.0.0',
                         bundleUrl=origin + '/miniapps/custom-call-build.zip',
                         sha256=hashlib.sha256(bundle.read_bytes()).hexdigest().upper())] if with_call else [])
        manifest = dict(schemaVersion=1, services=dict(coreUrl=origin, runtimeUrl=origin),
                        auth=dict(mode='microsoft-entra', authorityUrl='https://login.microsoftonline.com/' +
                                  '22222222-2222-2222-2222-222222222222', sessionScopes=['api://core/mentra.session']),
                        features=dict(managedStreams=False, nativeMeetings=True), telemetry=False,
                        miniapps=dict(managed=managed), branding=dict(logoUrls=dict(light=origin+'/logo', dark=origin+'/logo')),
                        links=dict(privacyPolicyUrl=origin+'/privacy', termsOfServiceUrl=origin+'/terms'))
        (self.path / 'manifest.json').write_text(json.dumps(manifest))
        self.env['HELPER_TEST_DIRECTORY'] = str(self.path)
        self.executable('curl', '''import json,os,sys
from pathlib import Path
p=Path(os.environ['HELPER_TEST_DIRECTORY']);a=sys.argv[1:];url=a[-1]
with (p/'requests').open('a') as f:f.write(url+'\\n')
if url.endswith('/ready') and not (p/'ready').exists(): (p/'ready').touch();sys.exit(22)
if url.endswith('/mentra-deployment.json'): print((p/'manifest.json').read_text())
elif url.endswith('/min-version'): print('{"data":{"required":"3.3.0","recommended":"3.3.0"}}')
elif url.endswith('/healthz'): print('{"package":"core"}')
elif url.endswith('/jwks.json'): print('{"keys":[{},{}]}')
elif url.endswith('/acs/token'): print('401',end='')
elif url.endswith('.zip'): Path(a[a.index('--output')+1]).write_bytes((p/'bundle.zip').read_bytes())
''')
        self.executable('sleep', 'pass\n')
        result = subprocess.run(['bash', str(ROOT / 'scripts/smoke-test.sh'), origin],
                                env=self.env, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.path / 'requests').read_text().splitlines()[:2], [origin+'/ready']*2)

    def test_standalone_smoke_accepts_empty_managed_apps_and_waits_for_ready(self):
        self.smoke(False)

    def test_smoke_accepts_custom_bundle_filename_and_uppercase_hash(self):
        self.env['MENTRA_REQUIRE_CALL'] = 'true'
        self.smoke(True)

    def test_zip_verification_bounds_actual_expansion(self):
        import hashlib
        source = (ROOT / 'scripts/smoke-test.sh').read_text()
        verifier = source.split("<<'PYVERIFY'\n", 1)[1].split('\nPYVERIFY', 1)[0]
        bundle = self.path / 'large.zip'
        with zipfile.ZipFile(bundle, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
            archive.writestr('too-large', bytes(33 * 1024 * 1024))
        result = subprocess.run(['python3', '-c', verifier, str(bundle),
                                 hashlib.sha256(bundle.read_bytes()).hexdigest()],
                                env=self.env, capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('expansion limit', result.stderr)

    def test_tenant_guard_accepts_uuid_casing_before_directory_writes(self):
        source = (ROOT / 'scripts/configure-entra.sh').read_text()
        guard = source[source.index('TENANT_ID='):source.index('find_or_create_app()')]
        tenant = 'abcdef12-1234-1234-1234-abcdef123456'
        result = subprocess.run(['bash', '-c', 'set -euo pipefail\naz() { printf "%s" "$TEST_TENANT"; }\n' + guard],
                                env=dict(self.env, TEST_TENANT=tenant, MENTRA_EXPECTED_TENANT_ID=tenant.upper()),
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == '__main__':
    unittest.main()
