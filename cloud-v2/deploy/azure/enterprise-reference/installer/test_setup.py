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

    @contextlib.contextmanager
    def upgrade_context(self, target=None):
        import types
        old = dict(RELEASE, releaseTag='3.3.0-dev.1')
        target = target or dict(old, releaseTag='3.3.0-dev.2', sourceImage='ghcr.io/mentra-community/mentra-cloud@sha256:' + 'c' * 64)
        self.config.update(sourceImage=old['sourceImage'], releaseTag=old['releaseTag'])
        self.state.update(phase='infrastructure_verified', secretsCreated=True)
        self.save()
        setup.write_json(self.directory / 'secrets.json', {'signing': 'original-private-key'})
        self.state['configHash'] = setup.digest(self.directory / 'deployment.config.json')
        self.save()
        self.args.previous_package = str(self.directory / 'previous-package')
        self.args.backup_confirmed = True
        def load_previous(directory):
            return setup.read_json(directory / 'deployment.config.json'), setup.read_json(directory / 'state.json'), old
        loader = types.SimpleNamespace(exec_module=lambda module: setattr(module, 'load', load_previous))
        spec = types.SimpleNamespace(loader=loader)
        actual_digest = setup.digest
        with patch('importlib.util.spec_from_file_location', return_value=spec), \
             patch('importlib.util.module_from_spec', return_value=types.SimpleNamespace()), \
             patch.object(setup, 'check_release', return_value=target), \
             patch.object(setup, 'digest', side_effect=lambda p: 'target-release' if Path(p) == setup.ROOT / 'release.json' else actual_digest(p)), \
             patch.object(setup, 'preflight') as preflight, patch.object(setup, 'emit'):
            yield preflight

    def test_upgrade_preserves_original_keys_bindings_and_exact_backup(self):
        with self.upgrade_context():
            before = (self.directory / 'deployment.config.json').read_bytes()
            key = (self.directory / 'secrets.json').read_bytes()
            setup.upgrade(self.args, self.directory)
            state = setup.read_json(self.directory / 'state.json')
            config = setup.read_json(self.directory / 'deployment.config.json')
            self.assertEqual(state['releaseHash'], 'target-release')
            self.assertEqual(config['releaseTag'], '3.3.0-dev.2')
            self.assertEqual(state['binding'], self.state['binding'])
            self.assertEqual((self.directory / 'secrets.json').read_bytes(), key)
            self.assertEqual((self.directory / 'upgrades/target-release/deployment.config.json').read_bytes(), before)
            self.assertFalse((self.directory / 'upgrade.pending.json').exists())

    def test_interrupted_upgrade_publishes_same_target_on_next_load(self):
        with self.upgrade_context():
            with patch.object(setup, 'checkpoint', side_effect=OSError('interrupted')):
                with self.assertRaises(OSError):
                    setup.upgrade(self.args, self.directory)
            self.assertTrue((self.directory / 'upgrade.pending.json').exists())
            config, state, release = setup.load(self.directory)
            self.assertEqual(state['releaseHash'], 'target-release')
            self.assertEqual(config['sourceImage'], release['sourceImage'])
            self.assertFalse((self.directory / 'upgrade.pending.json').exists())

    def test_upgrade_source_access_failure_does_not_change_saved_state(self):
        with self.upgrade_context() as preflight:
            before = (self.directory / 'state.json').read_bytes()
            preflight.side_effect = setup.SetupError('image inaccessible')
            with self.assertRaisesRegex(setup.SetupError, 'inaccessible'):
                setup.upgrade(self.args, self.directory)
            self.assertEqual((self.directory / 'state.json').read_bytes(), before)
            self.assertFalse((self.directory / 'upgrades').exists())

    def test_unsafe_release_downgrade_and_reused_identity_are_refused(self):
        for target in (dict(RELEASE, releaseTag='3.2.0'),
                       dict(RELEASE, releaseTag='3.3.0-dev.1', sourceImage='ghcr.io/mentra-community/mentra-cloud@sha256:' + 'c' * 64)):
            with self.upgrade_context(target):
                with self.assertRaisesRegex(setup.SetupError, 'downgrade|cannot change'):
                    setup.upgrade(self.args, self.directory)
                self.assertFalse((self.directory / 'upgrade.pending.json').exists())

    def test_upgrade_rejects_noncanonical_semantic_release_identities(self):
        for value in ('03.3.0', '3.03.0', '3.3.00', '3.3.0-dev.01', '3.3.0-dev..1', '3.3.0-.'):
            with self.subTest(value=value), self.assertRaisesRegex(setup.SetupError, 'semantic'):
                setup.release_version(dict(RELEASE, releaseTag=value))
        self.assertLess(setup.release_version(dict(RELEASE, releaseTag='3.3.0-dev.9')),
                        setup.release_version(dict(RELEASE, releaseTag='3.3.0-dev.10')))

    def test_upgrade_requires_backups_and_original_verified_package(self):
        with self.upgrade_context():
            self.args.backup_confirmed = False
            with self.assertRaisesRegex(setup.SetupError, 'backup-confirmed'):
                setup.upgrade(self.args, self.directory)
            self.args.backup_confirmed = True
            self.state['phase'] = 'deploying'
            self.save()
            with self.assertRaisesRegex(setup.SetupError, 'Verify the current'):
                setup.upgrade(self.args, self.directory)

    def test_pending_upgrade_cannot_adopt_foreign_resource_binding(self):
        with self.upgrade_context():
            with patch.object(setup, 'checkpoint', side_effect=OSError('interrupted')):
                with self.assertRaises(OSError):
                    setup.upgrade(self.args, self.directory)
            pending = setup.read_json(self.directory / 'upgrade.pending.json')
            pending['updatedConfig']['subscriptionId'] = 'foreign'
            setup.write_json(self.directory / 'upgrade.pending.json', pending)
            setup.write_json(self.directory / 'deployment.config.json', pending['updatedConfig'])
            with self.assertRaisesRegex(setup.SetupError, 'conflicts'):
                setup.load(self.directory)

    def test_verify_cannot_certify_selected_but_undeployed_upgrade(self):
        with self.upgrade_context():
            setup.upgrade(self.args, self.directory)
            state = setup.read_json(self.directory / 'state.json')
            with patch.object(setup, 'run') as run:
                for phase in ('upgrade_ready', 'deploying'):
                    state['phase'] = phase
                    with self.assertRaisesRegex(setup.SetupError, 'Run resume'):
                        setup.verify(self.args, self.directory, self.config, state)
                run.assert_not_called()

    def test_interrupted_backup_does_not_publish_partial_destination(self):
        destination = self.directory / 'backup.json'
        with patch.object(setup.os, 'fsync', side_effect=OSError('interrupted')):
            with self.assertRaises(OSError):
                setup.publish_backup(destination, b'complete original bytes')
        self.assertFalse(destination.exists())
        setup.publish_backup(destination, b'complete original bytes')
        self.assertEqual(destination.read_bytes(), b'complete original bytes')
        with self.assertRaises(FileExistsError):
            setup.publish_backup(destination, b'different')
        self.assertEqual(destination.read_bytes(), b'complete original bytes')

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

    def test_shared_setup_directory_stops_before_writing_state_or_secrets(self):
        self.directory.chmod(0o777)
        with self.assertRaisesRegex(setup.SetupError, 'clouddrive SMB share'):
            with setup.locked(self.directory):
                self.fail('Shared directory was accepted')
        self.assertFalse((self.directory / '.setup-lock').exists())
        self.directory.chmod(0o700)

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

    def test_mirror_can_be_corrected_before_deployment_but_not_after(self):
        self.config['sourceRegistryMirror'] = 'approved.azurecr.io/mentra-cloud'
        self.save()
        with self.load_context():
            setup.load(self.directory)
        self.state['configHash'] = 'config-hash'
        self.save()
        self.config['sourceRegistryMirror'] = 'replacement.azurecr.io/mentra-cloud'
        setup.write_json(self.directory / 'deployment.config.json', self.config)
        with patch.object(setup, 'check_release', return_value=RELEASE), \
             patch.object(setup, 'digest', side_effect=lambda p: 'release-hash' if Path(p).name == 'release.json' else 'changed-config-hash'), \
             self.assertRaisesRegex(setup.SetupError, 'Configuration changed'):
            setup.load(self.directory)

    def test_owned_group_still_checks_source_before_resume(self):
        self.config['registryName'] = 'qaapproved'
        def azure(config, *args):
            if args[:2] == ('account', 'show'):
                return {'id': SUB, 'tenantId': TENANT, 'state': 'Enabled'}
            if args[:2] == ('provider', 'show'):
                return {'registrationState': 'Registered'}
            if args[:2] == ('group', 'list'):
                return [{'name': 'rg-test', 'tags': {'mentraInstallerOwner': 'owner'}}]
            self.fail('resume wrote resources before confirming image access')
        with patch.object(setup.shutil, 'which', return_value='/tool'), \
             patch.object(setup, 'azure', side_effect=azure), \
             patch.object(setup.subprocess, 'run', return_value=setup.subprocess.CompletedProcess([], 1, '', '')) , \
             patch.object(setup, 'check_source_image', side_effect=setup.SetupError('image inaccessible')):
            with self.assertRaisesRegex(setup.SetupError, 'image inaccessible'):
                setup.install(self.args, self.directory, self.config, self.state)

    def test_staged_exact_digest_allows_resume_without_upstream(self):
        def azure(config, *args):
            if args[:2] == ('account', 'show'):
                return {'id': SUB, 'tenantId': TENANT, 'state': 'Enabled'}
            if args[:2] == ('provider', 'show'):
                return {'registrationState': 'Registered'}
            if args[:2] == ('group', 'list'):
                return [{'name': 'rg-test', 'tags': {'mentraInstallerOwner': 'owner'}}]
            self.fail('Unexpected Azure write')
        self.config['registryName'] = 'qaapproved'
        result = setup.subprocess.CompletedProcess([], 0, json.dumps({'digest': self.config['sourceImage'].split('@')[1]}), '')
        with patch.object(setup.shutil, 'which', return_value='/tool'), patch.object(setup, 'azure', side_effect=azure), \
             patch.object(setup.subprocess, 'run', return_value=result), patch.object(setup, 'check_source_image') as source:
            self.assertEqual(setup.preflight(self.config, require_identity=True)['sourceImageAccess'], 'verified in customer registry')
        source.assert_not_called()

    def test_mirror_recovery_changes_only_endpoint_after_failed_deployment(self):
        self.state['configHash'] = setup.digest(self.directory / 'deployment.config.json')
        self.state['phase'] = 'deploying'
        self.save()
        self.args.mirror = 'replacement.azurecr.io/mentra-cloud'
        with patch.object(setup, 'check_source_image') as check, patch.object(setup, 'emit'), \
             patch.object(setup, 'checkpoint', side_effect=OSError('interrupted')):
            with self.assertRaises(OSError):
                setup.configure_mirror(self.args, self.directory, self.config, self.state)
            self.assertEqual(check.call_args.args[0]['sourceImage'], RELEASE['sourceImage'])
        with patch.object(setup, 'check_release', return_value=RELEASE), \
             patch.object(setup, 'digest', side_effect=lambda p: 'release-hash' if Path(p).name == 'release.json' else setup.hashlib.sha256(Path(p).read_bytes()).hexdigest()):
            config, state, _ = setup.load(self.directory)
        self.assertEqual(config['sourceRegistryMirror'], self.args.mirror)
        self.assertEqual(config['sourceImage'], RELEASE['sourceImage'])
        self.assertEqual(state['phase'], 'deploying')
        self.assertEqual(state['configHash'], setup.digest(self.directory / 'deployment.config.json'))
        self.assertFalse((self.directory / 'configuration.pending.json').exists())

    def test_failed_mirror_check_preserves_config_and_state(self):
        original = {p.name: p.read_bytes() for p in self.directory.glob('*.json')}
        self.args.mirror = 'replacement.azurecr.io/mentra-cloud'
        with patch.object(setup, 'check_source_image', side_effect=setup.SetupError('access denied')):
            with self.assertRaises(setup.SetupError):
                setup.configure_mirror(self.args, self.directory, self.config, self.state)
        self.assertEqual(original, {p.name: p.read_bytes() for p in self.directory.glob('*.json')})

    def test_admin_bootstrap_retries_saved_credential_and_preserves_existing_allowlist(self):
        self.config['coreName'] = 'ca-test-core'
        self.state['binding']['coreName'] = 'ca-test-core'
        self.save()
        self.state['configHash'] = setup.digest(self.directory / 'deployment.config.json')
        self.state['outputs'] = {'coreOrigin': 'https://core.example'}
        setup.write_json(self.directory/'admin-key.json',dict(id='01M3ZG55PT8Z7J3HFVFZ49QWPR',value='msk_local_test.secret'))
        calls = []
        def azure(config,*args):
            calls.append(args)
            if args[:2]==('containerapp','show'):
                return {'properties':{'template':{'containers':[{'env':[{'name':'CLOUD_CORE_ADMIN_EMAILS','value':'existing@example.com'}]}]}}}
            return {}
        with patch.object(setup,'azure',side_effect=azure), patch.object(setup,'execute_admin_script',return_value=argparse.Namespace(stdout='MENTRA_ADMIN_END')) as cleanup, patch.object(setup,'emit'):
            setup.bootstrap_admin(self.args,self.directory,self.config,self.state)
        self.assertIn(b'fs.unlinkSync', cleanup.call_args.args[3])
        self.assertIn('existing@example.com',self.config['coreAdminEmails'])
        self.assertIn('api-key@01M3ZG55PT8Z7J3HFVFZ49QWPR.local',self.config['coreAdminEmails'])
        self.assertEqual(setup.digest(self.directory/'deployment.config.json'),self.state['configHash'])

    def test_admin_allowlist_update_recovers_interrupted_checkpoint(self):
        self.state['configHash'] = setup.digest(self.directory / 'deployment.config.json')
        self.save()
        with patch.object(setup, 'checkpoint', side_effect=OSError('interrupted')):
            with self.assertRaises(OSError):
                setup.update_configuration(self.directory, self.config, self.state, coreAdminEmails='admin@example.com')
        with patch.object(setup, 'check_release', return_value=RELEASE), \
             patch.object(setup, 'digest', side_effect=lambda p: 'release-hash' if Path(p).name == 'release.json' else setup.hashlib.sha256(Path(p).read_bytes()).hexdigest()):
            config, state, _ = setup.load(self.directory)
        self.assertEqual(config['coreAdminEmails'], 'admin@example.com')
        self.assertEqual(state['configHash'], setup.digest(self.directory / 'deployment.config.json'))

    def dns_fixture(self, records):
        self.config['workspaceHostname'] = 'mentra.qa.example.com'
        self.state['dns'] = [{'type': 'CNAME', 'name': 'mentra.qa.example.com', 'value': 'runtime.azure.example'},
                             {'type': 'TXT', 'name': 'asuid.mentra.qa.example.com', 'value': 'verification'}]
        self.args.dns_zone = 'qa.example.com'
        self.args.dns_resource_group = 'dns-group'
        self.args.dns_subscription = None
        def azure(config, *args):
            if args[:2] == ('account', 'show'):
                return {'tenantId': TENANT}
            if args[:4] == ('network', 'dns', 'zone', 'show'):
                return {'name': 'qa.example.com', 'id': '/subscriptions/' + SUB + '/resourceGroups/dns-group/providers/Microsoft.Network/dnsZones/qa.example.com'}
            if args[:4] == ('network', 'dns', 'record-set', 'list'):
                return records
            self.fail('Unexpected DNS operation')
        return azure

    def test_azure_dns_creates_only_missing_records_conditionally(self):
        azure = self.dns_fixture([{'name': '@', 'type': 'Microsoft.Network/dnsZones/MX', 'mxRecords': [{'exchange': 'mail.example'}]}])
        with patch.object(setup, 'azure', side_effect=azure), patch.object(setup, 'run') as run, patch.object(setup, 'emit'):
            setup.configure_azure_dns(self.args, self.directory, self.config, self.state)
        self.assertEqual(run.call_count, 2)
        for call in run.call_args_list:
            self.assertIn('If-None-Match=*', call.args[0])
            self.assertNotIn('/MX/', call.args[0][call.args[0].index('--url') + 1])

    def test_azure_dns_matching_records_are_idempotent(self):
        azure = self.dns_fixture([{'name': 'mentra', 'type': 'Microsoft.Network/dnsZones/CNAME', 'cnameRecord': {'cname': 'runtime.azure.example.'}},
                                  {'name': 'asuid.mentra', 'type': 'Microsoft.Network/dnsZones/TXT', 'txtRecords': [{'value': ['verification']}]}])
        with patch.object(setup, 'azure', side_effect=azure), patch.object(setup, 'run') as run, patch.object(setup, 'emit'):
            setup.configure_azure_dns(self.args, self.directory, self.config, self.state)
        run.assert_not_called()

    def test_azure_dns_conflict_checks_all_records_before_any_write(self):
        azure = self.dns_fixture([{'name': 'asuid.mentra', 'type': 'Microsoft.Network/dnsZones/TXT', 'txtRecords': [{'value': ['foreign-verification']}]}])
        with patch.object(setup, 'azure', side_effect=azure), patch.object(setup, 'run') as run:
            with self.assertRaisesRegex(setup.SetupError, 'different content'):
                setup.configure_azure_dns(self.args, self.directory, self.config, self.state)
        run.assert_not_called()

    def test_teams_check_explains_missing_subscription_without_granting_access(self):
        self.args.teams_user = None
        class Response:
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def read(self): return json.dumps({'value': []}).encode()
        with patch.object(setup, 'run', return_value=json.dumps({'accessToken': 'fixture'})) as run, \
             patch.object(setup.urllib.request, 'urlopen', return_value=Response()), patch.object(setup, 'emit') as emit:
            setup.check_teams(self.args, self.directory, self.config, self.state)
        result = emit.call_args.args[1]
        self.assertEqual(result['teamsSubscription'], 'missing')
        self.assertIn('Business Basic without Teams is insufficient', result['next'])
        self.assertNotIn('--subscription', run.call_args.args[0])
        self.assertFalse(result['verifiedMeetingCreation'])

    def test_teams_check_distinguishes_unlicensed_employee_and_licensed_organizer(self):
        self.args.teams_user = 'employee@example.com'
        self.config['teamsGraphOrganizerId'] = SUB
        class Response:
            def __init__(self, value): self.value = value
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def read(self): return json.dumps({'value': self.value}).encode()
        product = {'capabilityStatus': 'Enabled', 'servicePlans': [{'servicePlanName': 'TEAMS1'}]}
        license = {'servicePlans': [{'servicePlanName': 'TEAMS1', 'provisioningStatus': 'Success'}]}
        with patch.object(setup, 'run', return_value=json.dumps({'accessToken': 'fixture'})), \
             patch.object(setup.urllib.request, 'urlopen', side_effect=[Response([product]), Response([license]), Response([])]), \
             patch.object(setup, 'emit') as emit:
            setup.check_teams(self.args, self.directory, self.config, self.state)
        identities = emit.call_args.args[1]['identities']
        self.assertEqual(identities[0]['teamsLicense'], 'enabled')
        self.assertEqual(identities[1]['teamsLicense'], 'missing_or_provisioning')
        self.assertIn('Unlicensed employees may join as guests', identities[1]['next'])

    def test_teams_check_refuses_wrong_graph_tenant_instead_of_reading_wrong_inventory(self):
        self.config['teamsGraphTenantId'] = SUB
        with patch.object(setup, 'run') as run:
            with self.assertRaisesRegex(setup.SetupError, 'deployment Entra tenant'):
                setup.inspect_teams(self.args, self.config)
        run.assert_not_called()

    def test_provider_errors_do_not_print_secret_output(self):
        from subprocess import CompletedProcess
        with patch.object(setup.subprocess, 'run', return_value=CompletedProcess(['az'], 1, '', 'secret-token')):
            with self.assertRaises(setup.SetupError) as error:
                setup.run(['az', 'deployment'])
        self.assertNotIn('secret-token', str(error.exception))

    def test_verification_guides_azure_operator_without_license_read_permission(self):
        self.state['outputs'] = {'workspaceOrigin': 'https://azure.example.com'}
        with patch.object(setup, 'run'), \
             patch.object(setup, 'inspect_teams', side_effect=setup.SetupError('Ask an Entra administrator to run check-teams')), \
             patch.object(setup, 'emit') as emit:
            setup.verify(self.args, self.directory, self.config, self.state)
        result = emit.call_args.args[1]
        self.assertEqual(result['status'], 'infrastructure_verified')
        self.assertEqual(result['teamsSetup']['teamsSubscription'], 'unknown')
        self.assertIn('Entra administrator', result['teamsSetup']['next'])
        self.assertFalse(self.state['teamsSetupChecks']['verifiedMeetingCreation'])

    def test_license_read_failure_does_not_claim_missing_license_or_print_provider_body(self):
        import urllib.error
        with patch.object(setup, 'run', return_value=json.dumps({'accessToken': 'private-fixture'})), \
             patch.object(setup.urllib.request, 'urlopen', side_effect=urllib.error.HTTPError('url', 403, 'private-provider-body', {}, None)):
            with self.assertRaisesRegex(setup.SetupError, 'license-read permission') as error:
                setup.inspect_teams(self.args, self.config)
        self.assertNotIn('private', str(error.exception))
        self.assertNotIn('teamsSetupChecks', self.state)

    def test_graph_body_connection_loss_keeps_successful_infrastructure_verification(self):
        import http.client
        self.state['outputs'] = {'workspaceOrigin': 'https://azure.example.com'}
        for failure in (http.client.IncompleteRead(b'private-partial-body'), ConnectionResetError('private-provider-body')):
            with self.subTest(failure=type(failure).__name__), \
                 patch.object(setup, 'run', return_value=json.dumps({'accessToken': 'fixture'})), \
                 patch.object(setup.urllib.request, 'urlopen', side_effect=failure), patch.object(setup, 'emit') as emit:
                setup.verify(self.args, self.directory, self.config, self.state)
            result = emit.call_args.args[1]
            self.assertEqual(result['status'], 'infrastructure_verified')
            self.assertEqual(result['teamsSetup']['teamsSubscription'], 'unknown')
            self.assertNotIn('private', json.dumps(result))


if __name__ == '__main__':
    unittest.main()
