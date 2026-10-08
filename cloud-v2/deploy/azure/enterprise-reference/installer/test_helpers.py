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

    def test_admin_key_lives_only_in_the_encrypted_journal(self):
        # The credential is never written to the report share or any other file.
        code = (ROOT / 'installer/admin-key.ts').read_text()
        self.assertNotIn('node:fs', code)
        self.assertNotIn('/mnt/', code)

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

    def test_first_standalone_custom_domain_deploy_pauses_before_hostname_binding(self):
        script = (ROOT / 'scripts/deploy.sh').read_text()
        block = script[script.index('WORKSPACE_HOSTNAME='):script.index('# Provider validation')]
        (self.path / 'config.json').write_text(json.dumps({'workspaceHostname': 'mentra.example.com', 'runtimeName': 'new-app'}))
        (self.path / 'params.json').write_text('{}')
        self.env.update(CONFIG=str(self.path / 'config.json'), PARAMETERS=str(self.path / 'params.json'),
                        RESOURCE_GROUP='qa', DEPLOYMENT_NAME='qa', TEMPLATE_DIR=str(ROOT), HELPER_TEST_DIRECTORY=str(self.path))
        self.executable('az', """import json,os,sys
from pathlib import Path
p=Path(os.environ['HELPER_TEST_DIRECTORY']);a=sys.argv[1:]
with (p/'calls').open('a') as f:f.write(json.dumps(a)+'\\n')
if a[:2]==['containerapp','list']:print('[]')
elif a[:3] in (['deployment','group','validate'],['deployment','group','create']):
 assert 'workspaceHostname=' in a
elif a[:3]==['deployment','group','show']:print('{}')
else:sys.exit(9)
""")
        result = subprocess.run(['bash', '-c', 'set -euo pipefail\naz() { command az "$@"; }\n' + block],
                                env=self.env, text=True, capture_output=True)
        self.assertEqual(result.returncode, 3, result.stderr)
        self.assertIn('Configure DNS', result.stderr)
        calls = [json.loads(line) for line in (self.path / 'calls').read_text().splitlines()]
        self.assertFalse(any('hostname' in call for call in calls))

    def parameters(self, config):
        source = (ROOT / 'scripts/deploy.sh').read_text()
        expression = source.split('--arg cloudImage "$1" \'\n', 1)[1].split("\n  ' > \"$PARAMETERS\"", 1)[0]
        (self.path / 'config.json').write_text(json.dumps(config))
        result = subprocess.run(['jq', '-n', '--slurpfile', 'config', str(self.path / 'config.json'),
                                 '--arg', 'cloudImage', 'test.azurecr.io/cloud@sha256:' + 'a' * 64, expression],
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)['parameters']

    def test_parameters_reference_key_vault_and_carry_no_secrets(self):
        config = json.loads((ROOT / 'deployment.config.example.json').read_text())
        parameters = self.parameters(config)
        self.assertEqual(parameters['keyVaultName']['value'], 'kvacmementra')
        for name in ('refreshTokenPepper', 'mentraJwtPrivateKey', 'miniappJwtPrivateKey', 'teamsGraphClientSecret',
                     'manageAcrPullRoleAssignment'):
            self.assertNotIn(name, parameters)
        template = (ROOT / 'main.bicep').read_text()
        self.assertNotIn('@secure()', template)
        self.assertEqual(template.count("keyVaultUrl: '${vaultUri}secrets/"), 6)
        # Each app reads only its own secrets with its own identity; nothing reads the admin key.
        core = template[template.index("resource core '"):template.index("resource runtime '")]
        runtime = template[template.index("resource runtime '"):]
        self.assertNotIn('runtimeIdentity.id', core)
        self.assertNotIn('coreIdentity.id', runtime)
        # Each Graph app has its own secret, so a new app ID and its secret switch together.
        self.assertIn("secrets/teams-graph-client-secret-${teamsGraphClientId}'", runtime)
        self.assertIn("'teams-graph-client-secret-${teamsGraphClientId}'", (ROOT / 'access.bicep').read_text())
        self.assertNotIn('Microsoft.Authorization/roleAssignments', template)
        bootstrap = (ROOT / 'bootstrap.bicep').read_text()
        self.assertNotIn('4633458b-17de-408a-b874-0445c86b69e6', bootstrap)
        access = (ROOT / 'access.bicep').read_text()
        self.assertIn('scope: coreSecret[i]', access)
        self.assertIn('scope: runtimeSecret[i]', access)
        # The admin key appears only in the comment saying no app can read it.
        self.assertEqual(access.count('mentra-admin-key'), 1)

    def test_configuration_requires_a_valid_key_vault_name(self):
        source = (ROOT / 'scripts/deploy.sh').read_text()
        expression = source.split("jq -e '\n", 1)[1].split("\n' \"$CONFIG\"", 1)[0]
        config = json.loads((ROOT / 'deployment.config.example.json').read_text())
        config['sourceImage'] = 'ghcr.io/mentra-community/mentra-cloud@sha256:' + 'a' * 64
        for key in ('tenantId', 'coreApiClientId', 'mobileClientId'):
            config[key] = '11111111-1111-1111-1111-111111111111'
        for value, expected in (('kvacme1234', True), (None, False), ('9starts-with-digit', False), ('k' * 25, False)):
            with self.subTest(value=value):
                config['keyVaultName'] = value
                result = subprocess.run(['jq', '-e', expression], input=json.dumps(config), capture_output=True, text=True)
                self.assertEqual(result.returncode == 0, expected, result.stderr)

    def test_configuration_requires_separate_app_identities(self):
        source = (ROOT / 'scripts/deploy.sh').read_text()
        expression = source.split("jq -e '\n", 1)[1].split("\n' \"$CONFIG\"", 1)[0]
        config = json.loads((ROOT / 'deployment.config.example.json').read_text())
        config['sourceImage'] = 'ghcr.io/mentra-community/mentra-cloud@sha256:' + 'a' * 64
        for key in ('tenantId', 'coreApiClientId', 'mobileClientId'):
            config[key] = '11111111-1111-1111-1111-111111111111'
        for runtime, expected in (('id-acme-mentra-runtime', True), (config['coreIdentityName'], False)):
            with self.subTest(runtime=runtime):
                config['runtimeIdentityName'] = runtime
                result = subprocess.run(['jq', '-e', expression], input=json.dumps(config), capture_output=True, text=True)
                self.assertEqual(result.returncode == 0, expected, result.stderr)

    def fake_vault(self, core_exists=False, list_failures=0):
        # A Key Vault and Container Apps stand-in that records every call.
        store = self.path / 'vault'
        store.mkdir(exist_ok=True)
        self.env.update(HELPER_TEST_DIRECTORY=str(self.path), MENTRA_VAULT_RETRY_SECONDS='0',
                        CORE_EXISTS={True: '1', False: '0'}.get(core_exists, core_exists), LIST_FAILURES=str(list_failures))
        self.executable('az', '''import json,os,sys
from pathlib import Path
p=Path(os.environ['HELPER_TEST_DIRECTORY']);a=sys.argv[1:];store=p/'vault'
with (p/'calls').open('a') as f:f.write(json.dumps(a)+'\\n')
if a[:3]==['keyvault','secret','list']:
 failures=p/'list-failures';n=int(failures.read_text()) if failures.exists() else 0
 if n<int(os.environ['LIST_FAILURES']):failures.write_text(str(n+1));sys.exit(1)
 print(json.dumps(sorted(x.name for x in store.iterdir())))
elif a[:3]==['keyvault','secret','set']:
 (store/a[a.index('--name')+1]).write_bytes(Path(a[a.index('--file')+1]).read_bytes())
elif a[:2]==['containerapp','list']:
 if os.environ['CORE_EXISTS']=='error':print('ERROR: (AuthorizationFailed) transient',file=sys.stderr);sys.exit(1)
 print(os.environ['CORE_EXISTS'])
else:sys.exit(9)
''')
        return store

    def ensure(self):
        return subprocess.run(['bash', str(ROOT / 'scripts/ensure-vault-secrets.sh'), 'kvtest1234', 'rg-test', 'ca-test-core'],
                              env=self.env, capture_output=True, text=True)

    def test_vault_keys_are_created_once_from_private_files(self):
        store = self.fake_vault(list_failures=2)
        result = self.ensure()
        self.assertEqual(result.returncode, 0, result.stderr)
        names = {'refresh-token-pepper', 'mentra-jwt-private-key', 'mentra-jwt-public-key',
                 'miniapp-jwt-private-key', 'miniapp-jwt-public-key'}
        self.assertEqual({x.name for x in store.iterdir()}, names)
        original = {x.name: x.read_bytes() for x in store.iterdir()}
        calls = (self.path / 'calls').read_text()
        for value in original.values():
            self.assertNotIn(value.decode(), calls)
            self.assertNotIn(value.decode(), result.stdout + result.stderr)
        # Each private key pairs with its stored public key.
        for prefix in ('mentra', 'miniapp'):
            pem = self.path / f'{prefix}.pem'
            body = original[f'{prefix}-jwt-private-key'].decode()
            pem.write_text('-----BEGIN PRIVATE KEY-----\n' + body + '\n-----END PRIVATE KEY-----\n')
            public = subprocess.run(['openssl', 'pkey', '-in', str(pem), '-pubout'], capture_output=True, text=True, check=True).stdout
            self.assertEqual(''.join(public.splitlines()[1:-1]), original[f'{prefix}-jwt-public-key'].decode())
        self.assertEqual(self.ensure().returncode, 0)
        self.assertEqual({x.name: x.read_bytes() for x in store.iterdir()}, original)

    def test_running_core_never_gets_new_keys(self):
        store = self.fake_vault(core_exists=True)
        (store / 'mentra-jwt-public-key').write_text('original-public')
        result = self.ensure()
        self.assertEqual(result.returncode, 1)
        self.assertIn('never replaces the keys of a running deployment', result.stderr)
        self.assertEqual([x.name for x in store.iterdir()], ['mentra-jwt-public-key'])

    def test_failed_core_lookup_never_reads_as_no_core(self):
        store = self.fake_vault(core_exists='error')
        (store / 'mentra-jwt-public-key').write_text('original-public')
        result = self.ensure()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('AuthorizationFailed', result.stderr)
        self.assertEqual((store / 'mentra-jwt-public-key').read_text(), 'original-public')
        self.assertEqual(len(list(store.iterdir())), 1)

    def test_interrupted_first_run_writes_one_matching_set(self):
        store = self.fake_vault()
        (store / 'mentra-jwt-public-key').write_text('from-an-interrupted-run')
        self.assertEqual(self.ensure().returncode, 0)
        self.assertNotEqual((store / 'mentra-jwt-public-key').read_text(), 'from-an-interrupted-run')
        self.assertEqual(len(list(store.iterdir())), 5)

    def test_image_import_waits_for_a_new_registry_to_resolve(self):
        self.env.update(HELPER_TEST_DIRECTORY=str(self.path), MENTRA_ACR_DNS_RETRY_SECONDS='0', TMPDIR=str(self.path))
        self.executable('az', '''import json,os,sys
from pathlib import Path
p=Path(os.environ['HELPER_TEST_DIRECTORY']);a=sys.argv[1:]
if a[:3]==['acr','repository','list']:
 n=p/'lookups';count=int(n.read_text()) if n.exists() else 0;n.write_text(str(count+1))
 if count<2:print("ERROR: Could not connect to the registry login server 'x.azurecr.io'.",file=sys.stderr);sys.exit(1)
 print('[]')
elif a[:2]==['acr','import']:(p/'imported').touch()
elif a[:3]==['acr','repository','show']:print('sha256:'+'a'*64)
else:sys.exit(9)
''')
        result = subprocess.run(['bash', str(ROOT / 'scripts/import-runtime-image.sh'), 'testregistry',
                                 'ghcr.io/mentra-community/mentra-cloud@sha256:' + 'a' * 64, 'release-1'],
                                env=self.env, text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.path / 'lookups').read_text(), '3')
        self.assertTrue((self.path / 'imported').exists())
        self.assertFalse(list(self.path.glob('mentra-acr-list.*')))

    def test_image_import_stops_on_other_registry_errors(self):
        self.env.update(HELPER_TEST_DIRECTORY=str(self.path), MENTRA_ACR_DNS_RETRY_SECONDS='0', TMPDIR=str(self.path))
        self.executable('az', '''import sys
print('ERROR: (AuthorizationFailed) no access', file=sys.stderr); sys.exit(1)
''')
        result = subprocess.run(['bash', str(ROOT / 'scripts/import-runtime-image.sh'), 'testregistry',
                                 'ghcr.io/mentra-community/mentra-cloud@sha256:' + 'a' * 64, 'release-1'],
                                env=self.env, text=True, capture_output=True)
        self.assertEqual(result.returncode, 1)
        self.assertIn('AuthorizationFailed', result.stderr)

    def fake_deploy(self, group_exists=True):
        # deploy.sh against a recording az stand-in.
        import base64
        claims = base64.urlsafe_b64encode(json.dumps({'oid': 'abcdef12-1234-1234-1234-abcdef123456', 'idtyp': 'user'}).encode()).decode().rstrip('=')
        config = json.loads((ROOT / 'deployment.config.example.json').read_text())
        config.update(sourceImage='ghcr.io/mentra-community/mentra-cloud@sha256:' + 'a' * 64,
                      tenantId='11111111-1111-1111-1111-111111111111', coreApiClientId='11111111-1111-1111-1111-111111111112',
                      mobileClientId='11111111-1111-1111-1111-111111111113')
        (self.path / 'config.json').write_text(json.dumps(config))
        self.env.update(HELPER_TEST_DIRECTORY=str(self.path), TOKEN='header.' + claims + '.signature',
                        GROUP_EXISTS='true' if group_exists else 'false')
        self.executable('az', '''import json,os,sys
from pathlib import Path
p=Path(os.environ['HELPER_TEST_DIRECTORY']);a=sys.argv[1:]
with (p/'calls').open('a') as f:f.write(json.dumps(a)+'\\n')
if a[:2]==['account','show']:pass
elif a[:2]==['group','exists']:print(os.environ['GROUP_EXISTS'])
elif a[:2]==['group','create']:pass
elif a[:3]==['deployment','group','create']:print('Succeeded')
elif a[:2]==['account','get-access-token']:print(os.environ['TOKEN'])
elif a[:3]==['deployment','group','what-if']:
 if 'access.bicep' in a[a.index('--template-file')+1] and os.environ.get('ACCESS_ERROR'):
  print('ERROR: '+os.environ['ACCESS_ERROR'],file=sys.stderr);sys.exit(1)
 if '@' in ' '.join(a): (p/'main-parameters.json').write_text(Path(a[a.index('--parameters')+1][1:]).read_text())
 print(json.dumps({'status':'Succeeded','changes':[{'changeType':'Create','resourceId':'/subscriptions/s/resourceGroups/rg/providers/Microsoft.KeyVault/vaults/kv'}]}))
else:sys.exit(9)
''')

    def deploy(self, *flags):
        result = subprocess.run(['bash', str(ROOT / 'scripts/deploy.sh'), *flags, str(self.path / 'config.json')],
                                env=self.env, capture_output=True, text=True)
        calls = [json.loads(line) for line in (self.path / 'calls').read_text().splitlines()]
        return result, calls

    def test_what_if_needs_the_resource_group(self):
        self.fake_deploy(group_exists=False)
        result, calls = self.deploy('--what-if')
        self.assertEqual(result.returncode, 1)
        self.assertIn('az group create --name rg-acme-mentra', result.stderr)
        self.assertFalse(any(c[:3] == ['deployment', 'group', 'what-if'] for c in calls))

    def test_access_preview_is_empty_only_before_the_secrets_exist(self):
        self.fake_deploy()
        self.env['ACCESS_ERROR'] = '(ParentResourceNotFound) The parent vault was not found.'
        result, _ = self.deploy('--what-if')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIsNone(json.loads(result.stdout)['access'])
        self.env['ACCESS_ERROR'] = '(AuthorizationFailed) The client does not have authorization.'
        result, _ = self.deploy('--what-if')
        self.assertEqual(result.returncode, 1)
        self.assertIn('AuthorizationFailed', result.stderr)

    def test_bootstrap_only_runs_just_the_ownership_template(self):
        self.fake_deploy()
        result, calls = self.deploy('--bootstrap-only')
        self.assertEqual(result.returncode, 0, result.stderr)
        created = [c for c in calls if c[:3] == ['deployment', 'group', 'create']]
        self.assertEqual(len(created), 1)
        self.assertTrue(created[0][created[0].index('--template-file') + 1].endswith('bootstrap.bicep'))
        self.assertIn('operatorPrincipalId=abcdef12-1234-1234-1234-abcdef123456', created[0])
        self.assertFalse(any(c[:2] in (['keyvault', 'secret'], ['acr', 'import']) for c in calls))

    def test_what_if_previews_both_templates_with_the_callers_identity(self):
        self.fake_deploy()
        result, calls = self.deploy('--what-if')
        self.assertEqual(result.returncode, 0, result.stderr)
        preview = json.loads(result.stdout)
        self.assertEqual(set(preview), {'bootstrap', 'access', 'main'})
        bootstrap = next(c for c in calls if c[:3] == ['deployment', 'group', 'what-if'] and 'bootstrap' in c[c.index('--template-file') + 1])
        self.assertIn('operatorPrincipalId=abcdef12-1234-1234-1234-abcdef123456', bootstrap)
        self.assertIn('keyVaultName=kvacmementra', bootstrap)
        self.assertFalse(any(c[:3] in (['deployment', 'group', 'create'], ['acr', 'import']) for c in calls))
        parameters = json.loads((self.path / 'main-parameters.json').read_text())['parameters']
        self.assertEqual(parameters['cloudImage']['value'], 'acmementraregistry.azurecr.io/mentra-cloud-enterprise@sha256:' + 'a' * 64)

    def test_custom_hostname_added_before_certificate_without_resetting_existing_binding(self):
        source = (ROOT / 'scripts/deploy.sh').read_text()
        block = source.split('WORKSPACE_HOSTNAME="', 1)[1].split('# Provider validation', 1)[0]
        block = 'WORKSPACE_HOSTNAME="' + block
        self.assertLess(source.index(block), source.index('az deployment group validate'))
        self.env['HELPER_TEST_DIRECTORY'] = str(self.path)
        self.executable('az', '''import json,os,sys
from pathlib import Path
p=Path(os.environ['HELPER_TEST_DIRECTORY']);a=sys.argv[1:]
if a[:2]==['containerapp','list']: print('[{\"name\":\"ca-test\"}]')
elif a[:3]==['containerapp','hostname','list']: print((p/'hostnames.json').read_text())
elif a[:3]==['containerapp','hostname','add']:
 assert a[a.index('--hostname')+1]=='mentra.example.com'
 (p/'added').touch()
else: sys.exit(9)
''')
        (self.path/'config.json').write_text(json.dumps(dict(workspaceHostname='mentra.example.com',runtimeName='ca-test')))
        for hostnames, expected in (([], True), ([dict(name='mentra.example.com',bindingType='SniEnabled')], False)):
            (self.path/'hostnames.json').write_text(json.dumps(hostnames))
            (self.path/'added').unlink(missing_ok=True)
            script = 'set -euo pipefail\nCONFIG="$1"\nRESOURCE_GROUP=rg-test\n' + block
            r = subprocess.run(['bash','-c',script,'test',str(self.path/'config.json')], env=self.env, text=True,capture_output=True)
            self.assertEqual(r.returncode,0,r.stderr)
            self.assertEqual((self.path/'added').exists(),expected)

    def test_switching_graph_apps_revokes_runtime_access_to_the_previous_secret(self):
        source = (ROOT / 'scripts/deploy.sh').read_text()
        block = source[source.index('# Revoke earlier Graph apps'):source.index('# End of Graph grant cleanup.')]
        self.assertGreater(source.index(block), source.index('did not become ready'))
        vault = '/subscriptions/s/resourceGroups/rg/providers/Microsoft.KeyVault/vaults/kv'
        grants = [dict(id='old', principalId='runtime', scope=vault + '/secrets/teams-graph-client-secret-aaaa'),
                  dict(id='current', principalId='runtime', scope=vault.lower() + '/secrets/teams-graph-client-secret-BBBB'),
                  dict(id='core', principalId='core', scope=vault + '/secrets/teams-graph-client-secret-aaaa'),
                  dict(id='pepper', principalId='runtime', scope=vault + '/secrets/refresh-token-pepper')]
        (self.path / 'grants.json').write_text(json.dumps(grants))
        self.env.update(HELPER_TEST_DIRECTORY=str(self.path), FAKE_VAULT_ID=vault)
        self.executable('az', '''import json,os,sys
from pathlib import Path
p=Path(os.environ['HELPER_TEST_DIRECTORY']);a=sys.argv[1:]
if a[:2]==['identity','show']:print('runtime')
elif a[:2]==['keyvault','show']:print(os.environ['FAKE_VAULT_ID'])
elif a[:3]==['role','assignment','list']:print((p/'grants.json').read_text())
elif a[:3]==['role','assignment','delete']:(p/'deleted').write_text(json.dumps(a[a.index('--ids')+1:a.index('--output')]))
else:sys.exit(9)
''')
        for current, expected in (('bbbb', ['old']), ('', ['old', 'current'])):
            (self.path / 'deleted').unlink(missing_ok=True)
            script = ('set -euo pipefail\nRUNTIME_IDENTITY=id-rt\nRESOURCE_GROUP=rg\nKEY_VAULT=kv\n'
                      f'TEAMS_CLIENT_ID={current}\n' + block)
            result = subprocess.run(['bash', '-c', script], env=self.env, text=True, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads((self.path / 'deleted').read_text()), expected)

    def test_source_mirror_validation_rejects_boolean_and_nonregistry_values(self):
        source = (ROOT / 'scripts/deploy.sh').read_text()
        expression = source.split("jq -e '\n", 1)[1].split("\n' \"$CONFIG\"", 1)[0]
        config = json.loads((ROOT / 'deployment.config.example.json').read_text())
        config['sourceImage'] = 'ghcr.io/mentra-community/mentra-cloud@sha256:' + 'a'*64
        for key in ('tenantId','coreApiClientId','mobileClientId'):
            config[key] = '11111111-1111-1111-1111-111111111111'
        for value, expected in ((None,True),('',True),('approved.azurecr.io/cloud',True),(False,False),(0,False),('other.example/cloud',False)):
            config['sourceRegistryMirror'] = value
            r = subprocess.run(['jq','-e',expression],input=json.dumps(config),capture_output=True,text=True)
            self.assertEqual(r.returncode==0,expected,r.stderr)


if __name__ == '__main__':
    unittest.main()
