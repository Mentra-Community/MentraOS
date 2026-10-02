"""Installer recovery and isolation checks; no Azure resources are created."""
import argparse
import contextlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('mentra_setup', Path(__file__).with_name('setup.py'))
setup = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(setup)
SUB = '11111111-1111-1111-1111-111111111111'
TENANT = '22222222-2222-2222-2222-222222222222'
RELEASE = dict(sourceImage='ghcr.io/mentra-community/mentra-cloud@sha256:' + 'a' * 64,
               releaseTag='mentra-test', clientMinVersion='0.0.0',
               managedMiniapps=[dict(packageName='com.mentra.call', version='2.1.44',
                                     sha256='b' * 64, bundlePath='/miniapps/com.mentra.call-2.1.44.zip')])


class InstallerTests(unittest.TestCase):
    def setUp(self):
        openssl = patch.object(setup, 'check_openssl')
        openssl.start()
        self.addCleanup(openssl.stop)
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name) / 'state'
        self.directory.mkdir(mode=0o700)
        self.args = argparse.Namespace(json=True, config=None, dns_ready=False, grant_admin_consent=False)
        self.config = dict(subscriptionId=SUB, tenantId=TENANT, resourceGroup='rg-test',
                           runtimeName='ca-test', workspaceHostname='', coreApiClientId=SUB,
                           mobileClientId=TENANT, deploymentId='test', resourceTags={'mentraInstallerOwner': 'owner'},
                           **RELEASE)
        self.state = dict(schemaVersion=1, deploymentId='test', releaseHash='release-hash',
                          binding={k: self.config.get(k) for k in setup.BINDING_KEYS}, owner='owner',
                          phase='initialized', secretsCreated=False, outputs={})
        self.save()

    def save(self):
        setup.write_json(self.directory / 'deployment.config.json', self.config)
        setup.write_json(self.directory / 'state.json', self.state)

    @contextlib.contextmanager
    def load_context(self):
        with patch.object(setup, 'check_release', return_value=RELEASE), \
             patch.object(setup, 'digest', side_effect=lambda p: 'release-hash' if Path(p).name == 'release.json' else 'config-hash'):
            yield

    def test_generated_global_names_differ_for_same_deployment_name(self):
        args = argparse.Namespace(config=str(self.directory / 'answers.json'), json=True)
        setup.write_json(args.config, dict(subscriptionId=SUB, tenantId=TENANT,
                         deploymentId='acme-mentra', displayName='ACME', location='westus2', workspaceHostname=''))
        names = []
        for name in ('one', 'two'):
            directory = self.directory / name
            with patch.object(setup, 'check_release', return_value=RELEASE), \
                 patch.object(setup, 'digest', return_value='release-hash'), patch.object(setup, 'emit'):
                setup.init(args, directory)
            value = setup.read_json(directory / 'deployment.config.json')
            names.append((value['registryName'], value['communicationName']))
        self.assertNotEqual(names[0][0], names[1][0])
        self.assertNotEqual(names[0][1], names[1][1])

    def test_interrupted_identity_update_recovers_without_new_registrations(self):
        self.config['displayName'] = 'Example'
        self.save()
        result = dict(tenantId=TENANT, coreApiClientId='33333333-3333-3333-3333-333333333333',
                      mobileClientId='44444444-4444-4444-4444-444444444444')
        with patch.object(setup, 'preflight'), patch.object(setup, 'run', return_value=json.dumps(result)), \
             patch.object(setup, 'checkpoint', side_effect=OSError('interrupted')):
            with self.assertRaises(OSError):
                setup.configure_entra(self.args, self.directory, self.config, self.state)
        with patch.object(setup, 'check_release', return_value=RELEASE), \
             patch.object(setup, 'digest', side_effect=lambda p: 'release-hash' if Path(p).name == 'release.json' else setup.hashlib.sha256(Path(p).read_bytes()).hexdigest()):
            config, state, _ = setup.load(self.directory)
        self.assertEqual(config['coreApiClientId'], result['coreApiClientId'])
        self.assertEqual(state['binding']['mobileClientId'], result['mobileClientId'])
        self.assertEqual(state['phase'], 'identity_configured')
        self.assertFalse((self.directory / 'identity.pending.json').exists())

    def test_state_cannot_move_subscription_or_tenant(self):
        for field in ('subscriptionId', 'tenantId', 'resourceGroup', 'coreApiClientId'):
            original = self.config[field]
            self.config[field] = 'changed'
            self.save()
            with self.subTest(field=field), self.load_context(), self.assertRaisesRegex(setup.SetupError, field):
                setup.load(self.directory)
            self.config[field] = original

    def test_release_cannot_change_during_resume(self):
        self.state['releaseHash'] = 'other-release'
        self.save()
        with self.load_context(), self.assertRaisesRegex(setup.SetupError, 'release differs'):
            setup.load(self.directory)

    def test_missing_original_keys_cannot_be_regenerated(self):
        self.state['secretsCreated'] = True
        self.save()
        with self.load_context(), self.assertRaisesRegex(setup.SetupError, 'Original secrets file is missing'):
            setup.load(self.directory)

    def test_shared_or_symlinked_secrets_are_rejected(self):
        secrets = self.directory / 'secrets.json'
        secrets.write_text('{}')
        secrets.chmod(0o644)
        with self.load_context(), self.assertRaisesRegex(setup.SetupError, 'accessible only'):
            setup.load(self.directory)
        secrets.unlink()
        target = self.directory / 'target'
        target.write_text('{}')
        target.chmod(0o600)
        secrets.symlink_to(target)
        with self.load_context(), self.assertRaisesRegex(setup.SetupError, 'regular file'):
            setup.load(self.directory)

    def test_config_is_frozen_after_first_azure_write(self):
        self.state['configHash'] = 'old-hash'
        self.save()
        with self.load_context(), self.assertRaisesRegex(setup.SetupError, 'Configuration changed'):
            setup.load(self.directory)

    def test_lock_conflict_and_release_after_failure(self):
        with setup.locked(self.directory):
            with self.assertRaisesRegex(setup.SetupError, 'Another setup'):
                with setup.locked(self.directory):
                    pass
        try:
            with setup.locked(self.directory):
                raise RuntimeError('interrupted')
        except RuntimeError:
            pass
        with setup.locked(self.directory):
            pass

    def test_json_writes_are_private_and_refuse_symlinks(self):
        output = self.directory / 'private.json'
        setup.write_json(output, {'example': 'value'})
        self.assertEqual(output.stat().st_mode & 0o777, 0o600)
        output.unlink()
        output.symlink_to(self.directory / 'other')
        with self.assertRaisesRegex(setup.SetupError, 'symlink'):
            setup.write_json(output, {})

    def test_consumer_credentials_do_not_leak_to_customer_setup(self):
        with patch.dict(os.environ, {'MENTRA_ADMIN_TOKEN_PROD': 'secret', 'MENTRA_CALL_CLIENT_SECRET': 'secret',
                                     'TEAMS_GRAPH_CLIENT_SECRET': 'secret', 'UNRELATED': 'retain'}):
            env = setup.environment(self.config)
        self.assertFalse(any(k.startswith(('MENTRA_ADMIN_TOKEN', 'MENTRA_CALL_', 'TEAMS_GRAPH_')) for k in env))
        self.assertEqual(env['MENTRA_SUBSCRIPTION_ID'], SUB)
        self.assertEqual(env['MENTRA_EXPECTED_TENANT_ID'], TENANT)
        self.assertEqual(env['UNRELATED'], 'retain')

    def test_wrong_tenant_and_foreign_resource_groups_block_writes(self):
        def azure(config, *args):
            if args[:2] == ('account', 'show'):
                return {'id': SUB, 'tenantId': TENANT, 'state': 'Enabled'}
            if args[:2] == ('provider', 'show'):
                return {'registrationState': 'Registered'}
            if args[:2] == ('group', 'list'):
                return [{'name': 'RG-TEST', 'tags': {'mentraInstallerOwner': 'someone-else'}}]
            self.fail('preflight attempted a write')
        with patch.object(setup.shutil, 'which', return_value='/tool'), patch.object(setup, 'azure', side_effect=azure):
            with self.assertRaisesRegex(setup.SetupError, 'not owned'):
                setup.preflight(self.config)
        with patch.object(setup.shutil, 'which', return_value='/tool'), \
             patch.object(setup, 'azure', return_value={'id': SUB, 'tenantId': SUB, 'state': 'Enabled'}):
            with self.assertRaisesRegex(setup.SetupError, 'does not match'):
                setup.preflight(self.config)

    def test_interrupted_deploy_preserves_secrets_and_can_resume(self):
        calls = []
        def run(argv, **kwargs):
            calls.append(argv)
            if 'generate-private-secrets.sh' in argv[1]:
                setup.write_json(self.directory / 'secrets.json', {'private': 'same-key'})
            return ''
        with patch.object(setup, 'preflight', return_value={'resourceGroup': 'owned'}), \
             patch.object(setup, 'run', side_effect=run), \
             patch.object(setup, 'deploy', side_effect=setup.SetupError('interrupted')), \
             patch.object(setup, 'emit'):
            with self.assertRaisesRegex(setup.SetupError, 'interrupted'):
                setup.install(self.args, self.directory, self.config, self.state)
        self.assertTrue(setup.read_json(self.directory / 'state.json')['secretsCreated'])
        with patch.object(setup, 'preflight', return_value={'resourceGroup': 'owned'}), \
             patch.object(setup, 'run', side_effect=run), patch.object(setup, 'deploy'), \
             patch.object(setup, 'verify'), patch.object(setup, 'emit'):
            setup.install(self.args, self.directory, self.config, self.state)
        self.assertEqual(sum('generate-private-secrets.sh' in argv[1] for argv in calls), 1)
        self.assertEqual(setup.read_json(self.directory / 'secrets.json')['private'], 'same-key')

    def test_dns_handoff_cannot_be_verified_as_final_customer_domain(self):
        self.config['workspaceHostname'] = 'mentra.example.com'
        self.state['outputs'] = {'workspaceOrigin': 'https://azure.example.com'}
        with self.assertRaisesRegex(setup.SetupError, 'domain is not deployed'):
            setup.verify(self.args, self.directory, self.config, self.state)
        self.state['dns'] = [{'value': 'azure.example.com'}, {'value': 'verification'}]
        with patch.object(setup.shutil, 'which', return_value='/dig'), \
             patch.object(setup, 'run', side_effect=['wrong.example.com.', '"verification"']):
            with self.assertRaisesRegex(setup.SetupError, 'do not match'):
                setup.check_dns(self.config, self.state)

    def test_private_image_failure_blocks_resource_creation(self):
        def azure(config, *args):
            if args[:2] == ('account', 'show'):
                return {'id': SUB, 'tenantId': TENANT, 'state': 'Enabled'}
            if args[:2] == ('provider', 'show'):
                return {'registrationState': 'Registered'}
            if args[:2] == ('group', 'list'):
                return []
            self.fail('resource creation before image access was confirmed')
        with patch.object(setup.shutil, 'which', return_value='/tool'), \
             patch.object(setup, 'azure', side_effect=azure), \
             patch.object(setup, 'check_source_image', side_effect=setup.SetupError('package read access')):
            with self.assertRaisesRegex(setup.SetupError, 'package read access'):
                setup.install(self.args, self.directory, self.config, self.state)
        self.assertFalse((self.directory / 'secrets.json').exists())

    def test_registry_auth_errors_withhold_credentials_and_server_body(self):
        import urllib.error
        from unittest.mock import Mock
        opener = Mock()
        opener.open.side_effect = urllib.error.URLError('private-secret-from-server')
        with patch.dict(os.environ, {'SOURCE_REGISTRY_USERNAME': 'user', 'SOURCE_REGISTRY_PASSWORD': 'password-secret'}), \
             patch.object(setup.urllib.request, 'build_opener', return_value=opener):
            with self.assertRaisesRegex(setup.SetupError, 'package read access') as error:
                setup.check_source_image(self.config)
        self.assertNotIn('password-secret', str(error.exception))
        self.assertNotIn('private-secret-from-server', str(error.exception))
        self.assertEqual(opener.open.call_args.args[0].host, 'ghcr.io')

    def test_registry_redirects_never_forward_auth(self):
        self.assertIsNone(setup.NoRegistryRedirects().redirect_request(None, None, 302, '', {}, 'https://elsewhere.example'))

    def test_acr_mirror_uses_scoped_token_and_preserves_release_digest(self):
        import io
        from unittest.mock import Mock
        self.config['sourceRegistryMirror'] = 'approved.azurecr.io/releases/mentra-cloud'
        pin = self.config['sourceImage'].split('@')[1]
        token_response = io.StringIO(json.dumps({'access_token': 'scoped-token'}))
        manifest_response = Mock()
        manifest_response.__enter__ = Mock(return_value=manifest_response)
        manifest_response.__exit__ = Mock(return_value=False)
        manifest_response.headers = {'Docker-Content-Digest': pin}
        opener = Mock()
        opener.open.side_effect = [token_response, manifest_response]
        with patch.dict(os.environ, {'SOURCE_REGISTRY_USERNAME': 'reader', 'SOURCE_REGISTRY_PASSWORD': 'secret'}), \
             patch.object(setup.urllib.request, 'build_opener', return_value=opener):
            self.assertEqual(setup.check_source_image(self.config), 'authenticated')
        token_request, image_request = [call.args[0] for call in opener.open.call_args_list]
        self.assertEqual(token_request.full_url, 'https://approved.azurecr.io/oauth2/token?service=approved.azurecr.io&scope=repository%3Areleases%2Fmentra-cloud%3Apull')
        self.assertEqual(image_request.full_url, 'https://approved.azurecr.io/v2/releases/mentra-cloud/manifests/' + pin)
        self.assertEqual(image_request.get_header('Authorization'), 'Bearer scoped-token')

    def test_invalid_mirror_never_transmits_credentials(self):
        from unittest.mock import Mock
        opener = Mock()
        with patch.object(setup.urllib.request, 'build_opener', return_value=opener):
            for mirror in ('https://evil.example/image', 'other.example/image', 'valid.azurecr.io/image:latest', 'user:secret@valid.azurecr.io/image'):
                self.config['sourceRegistryMirror'] = mirror
                with self.assertRaisesRegex(setup.SetupError, 'sourceRegistryMirror'):
                    setup.check_source_image(self.config)
        opener.open.assert_not_called()

    def test_provider_errors_do_not_print_secret_output(self):
        from subprocess import CompletedProcess
        with patch.object(setup.subprocess, 'run', return_value=CompletedProcess(['az'], 1, '', 'secret-token')):
            with self.assertRaises(setup.SetupError) as error:
                setup.run(['az', 'deployment'])
        self.assertNotIn('secret-token', str(error.exception))


if __name__ == '__main__':
    unittest.main()
