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
                        HELPER_TEST_DIRECTORY=str(self.path), TMPDIR=str(self.path))
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
elif url.endswith('.zip'):
 assert url==json.loads((p/'manifest.json').read_text())['miniapps']['managed'][0]['bundleUrl']
 Path(a[a.index('--output')+1]).write_bytes((p/'bundle.zip').read_bytes())
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

    def test_entra_profile_binds_directory_without_changing_callers_default(self):
        source = (ROOT / 'scripts/configure-entra.sh').read_text()
        binding = source[source.index('if [[ -n "${MENTRA_SUBSCRIPTION_ID:-}"'):source.index('find_or_create_app()')]
        original = self.path / 'original-profile'
        original.mkdir()
        (original / 'azureProfile.json').write_text('{"default":"original"}')
        (original / 'msal_token_cache.json').write_text('private-token-fixture')
        self.env.update(AZURE_CONFIG_DIR=str(original), MENTRA_SUBSCRIPTION_ID='qa-subscription',
                        MENTRA_EXPECTED_TENANT_ID='abcdef12-1234-1234-1234-abcdef123456',
                        HELPER_TEST_DIRECTORY=str(self.path), TMPDIR=str(self.path))
        self.executable('az', '''import json,os,sys
from pathlib import Path
p=Path(os.environ['AZURE_CONFIG_DIR']);a=sys.argv[1:]
assert '--subscription' not in a
if a[:2]==['account','set']:
 assert a==['account','set','--subscription','qa-subscription']
 assert p.name.startswith('mentra-entra-azure.')
 assert (p/'msal_token_cache.json').stat().st_mode&0o077==0
 (p/'azureProfile.json').write_text('{"default":"qa-subscription"}')
elif a[:2]==['account','show']:
 assert json.loads((p/'azureProfile.json').read_text())['default']=='qa-subscription'
 print('abcdef12-1234-1234-1234-abcdef123456')
elif a[:3]==['ad','app','list']: print('[]')
else:sys.exit(9)
'''.replace("assert '--subscription' not in a", "assert a[:2]==['account','set'] or '--subscription' not in a"))
        result = subprocess.run(['bash', '-c', 'set -euo pipefail\n' + binding + '\naz ad app list'],
                                env=self.env, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((original / 'azureProfile.json').read_text(), '{"default":"original"}')
        self.assertFalse(list(self.path.glob('mentra-entra-azure.*')))

    def test_acr_role_assignment_parameters_preserve_false_and_default_only_null(self):
        source = (ROOT / 'scripts/deploy.sh').read_text()
        expression = source.split('--arg cloudImage "$IMPORTED_IMAGE" \'\n', 1)[1].split("\n  ' > \"$PARAMETERS\"", 1)[0]
        for value, expected in ((False, False), (True, True), (None, True), ('missing', True)):
            with self.subTest(value=value):
                config = json.loads((ROOT / 'deployment.config.example.json').read_text())
                if value == 'missing':
                    config.pop('manageAcrPullRoleAssignment', None)
                else:
                    config['manageAcrPullRoleAssignment'] = value
                (self.path / 'config.json').write_text(json.dumps(config))
                (self.path / 'secrets.json').write_text('{}')
                result = subprocess.run(['jq', '-n', '--slurpfile', 'config', str(self.path / 'config.json'),
                                         '--slurpfile', 'secrets', str(self.path / 'secrets.json'),
                                         '--arg', 'cloudImage', 'test.azurecr.io/cloud@sha256:' + 'a' * 64,
                                         expression], capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIs(json.loads(result.stdout)['parameters']['manageAcrPullRoleAssignment']['value'], expected)

    def test_acr_role_assignment_validation_rejects_nonboolean_values(self):
        source = (ROOT / 'scripts/deploy.sh').read_text()
        expression = source.split("jq -e '\n", 1)[1].split("\n' \"$CONFIG\"", 1)[0]
        config = json.loads((ROOT / 'deployment.config.example.json').read_text())
        config['sourceImage'] = 'ghcr.io/mentra-community/mentra-cloud@sha256:' + 'a' * 64
        for key in ('tenantId', 'coreApiClientId', 'mobileClientId'):
            config[key] = '11111111-1111-1111-1111-111111111111'
        for value in (False, True, None, 'false', 0):
            with self.subTest(value=value):
                config['manageAcrPullRoleAssignment'] = value
                result = subprocess.run(['jq', '-e', expression], input=json.dumps(config),
                                         capture_output=True, text=True)
                self.assertEqual(result.returncode == 0, value is None or type(value) is bool, result.stderr)


if __name__ == '__main__':
    unittest.main()
