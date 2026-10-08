"""Guided setup, Key Vault, preview and one-command upgrade; no Azure resources are created."""
import argparse
import contextlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('mentra_setup_guided', Path(__file__).with_name('setup.py'))
setup = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(setup)
SUB = '11111111-1111-1111-1111-111111111111'
TENANT = '22222222-2222-2222-2222-222222222222'
RELEASE = dict(sourceImage='ghcr.io/mentra-community/mentra-cloud@sha256:' + 'a' * 64, releaseTag='3.3.0-dev.2',
               clientMinVersion='3.3.0', managedMiniapps=[])


def change(kind, name, change_type, delta=None):
    return {'resourceId': f'/subscriptions/{SUB}/resourceGroups/rg/providers/{kind}/{name}', 'changeType': change_type,
            'delta': delta or []}


class GuidedTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name) / 'mentra-install'
        self.directory = self.home / 'mentra-state'
        self.directory.mkdir(parents=True, mode=0o700)
        self.args = argparse.Namespace(json=False, config=None, dns_ready=False, grant_admin_consent=False, yes=True,
                                       employees='', previous_package=None, backup_confirmed=False,
                                       teams_client_id=None, teams_organizer=None, teams_secret_stdin=False)
        self.config = dict(subscriptionId=SUB, tenantId=TENANT, resourceGroup='rg-test', location='westus2',
                           workspaceHostname='', coreApiClientId=SUB, mobileClientId=TENANT, deploymentId='acme-mentra',
                           displayName='ACME', keyVaultName='kvacmementra12345678', coreName='ca-acme-core',
                           resourceTags={'mentraInstallerOwner': 'owner'}, **RELEASE)

    def write_state(self, phase, release_hash='this-release', **extra):
        setup.write_json(self.directory / 'deployment.config.json', self.config)
        state = dict(dict(schemaVersion=1, deploymentId='acme-mentra', releaseHash=release_hash, owner='owner',
                          binding={k: self.config.get(k) for k in setup.BINDING_KEYS}, phase=phase, outputs={}), **extra)
        setup.write_json(self.directory / 'state.json', state)
        return state

    @contextlib.contextmanager
    def steps(self, phase_after_install='infrastructure_verified'):
        """Replace every Azure-facing step; record the order guided setup calls them."""
        calls = []
        def record(name, result=None, effect=None):
            def step(*args, **kwargs):
                calls.append(name)
                if effect:
                    effect()
                return result
            return step
        def installed():
            state = setup.read_json(self.directory / 'state.json')
            state.update(phase=phase_after_install, outputs={'workspaceOrigin': 'https://acme.example', 'coreOrigin': 'https://core.example'})
            setup.write_json(self.directory / 'state.json', state)
        with patch.object(setup, 'check_release', return_value=RELEASE), \
             patch.object(setup, 'digest', side_effect=lambda p: 'this-release' if Path(p).name == 'release.json' else 'config-hash'), \
             patch.object(setup, 'ensure_providers', record('providers')), \
             patch.object(setup, 'preflight', record('preflight', {'resourceGroup': 'owned'})), \
             patch.object(setup, 'configure_entra', record('entra')), \
             patch.object(setup, 'entra_handoffs', record('handoffs', [])), \
             patch.object(setup, 'ensure_group', record('group')), \
             patch.object(setup, 'preview', record('preview', {'create': ['Key Vault kv'], 'change': [], 'unchanged': 0})), \
             patch.object(setup, 'install', record('install', {'status': phase_after_install}, installed)), \
             patch.object(setup, 'bootstrap_admin', record('admin', {'status': 'admin_key_ready'})), \
             patch.object(setup, 'upgrade_command', record('upgrade', {'status': 'upgraded'})):
            yield calls

    def test_fresh_install_runs_each_step_once_in_order(self):
        self.write_state('identity_configured')
        with self.steps() as calls:
            result = setup.guided(self.args, self.directory)
        self.assertEqual(calls, ['providers', 'preflight', 'handoffs', 'group', 'preview', 'install', 'admin'])
        self.assertEqual(result['workspace'], 'https://acme.example')

    def test_rerun_after_install_only_checks_and_reports(self):
        self.write_state('infrastructure_verified', outputs={'workspaceOrigin': 'https://acme.example'})
        with self.steps() as calls:
            setup.guided(self.args, self.directory)
        self.assertNotIn('install', calls)
        self.assertNotIn('preview', calls)

    def test_new_package_hands_over_to_upgrade(self):
        self.write_state('infrastructure_verified', release_hash='older-release')
        with self.steps() as calls:
            setup.guided(self.args, self.directory)
        self.assertEqual(calls, ['upgrade'])

    def test_dns_pause_continues_when_records_resolve(self):
        self.config['workspaceHostname'] = 'mentra.acme.example'
        self.write_state('awaiting_dns', dns=[{'type': 'CNAME', 'name': 'mentra.acme.example', 'value': 'app.azure'}])
        with self.steps() as calls, patch.object(setup, 'handle_dns', return_value=False):
            result = setup.guided(self.args, self.directory)
        self.assertEqual(result['status'], 'awaiting_dns')
        self.assertNotIn('install', calls)
        with self.steps() as calls, patch.object(setup, 'handle_dns', return_value=True) as dns:
            setup.guided(self.args, self.directory)
        self.assertIn('install', calls)
        dns.assert_called_once()

    def test_declining_the_preview_creates_nothing(self):
        self.write_state('identity_configured')
        with self.steps() as calls, patch.object(setup, 'confirm', return_value=False):
            result = setup.guided(self.args, self.directory)
        self.assertEqual(result['status'], 'stopped')
        self.assertNotIn('install', calls)

    def test_preview_summary_ignores_server_defaults_and_unresolved_references(self):
        preview = {'bootstrap': {'changes': [change('Microsoft.KeyVault/vaults', 'kvacme', 'Create')]},
                   'main': {'changes': [
                       change('Microsoft.App/containerApps', 'ca-acme-core', 'Modify', [
                           {'path': 'properties.runningStatus', 'propertyChangeType': 'Delete'},
                           {'path': 'properties.template.containers', 'propertyChangeType': 'Modify', 'children': [
                               {'path': '0.image', 'propertyChangeType': 'Modify', 'after': 'reg.azurecr.io/x@sha256:b'}]}]),
                       change('Microsoft.App/managedEnvironments', 'cae-acme', 'Modify', [
                           {'path': 'properties.peerAuthentication', 'propertyChangeType': 'Delete'}]),
                       change('Microsoft.Authorization/roleAssignments', 'guid', 'Modify', [
                           {'path': 'properties.principalId', 'propertyChangeType': 'Modify', 'after': "[reference('x')]"}]),
                       change('Microsoft.App/managedEnvironments/cae-acme/storages', 'core-attachments', 'NoChange')]}}
        preview['bootstrap']['changes'].append(dict(change('Microsoft.Authorization/roleAssignments', 'a1de', 'Create'), after={
            'properties': {'roleDefinitionId': '/subscriptions/s/providers/Microsoft.Authorization/roleDefinitions/4633458b-17de-408a-b874-0445c86b69e6'}}))
        summary = setup.summarize_preview(preview)
        self.assertEqual(summary['create'], ['Key Vault kvacme', 'Role assignment apps can read Key Vault'])
        self.assertEqual(summary['change'], ['Container App ca-acme-core: new software image'])
        self.assertEqual(summary['unchanged'], 3)

    def test_vault_writes_pass_values_by_private_file_and_wait_for_access(self):
        seen = []
        def run(argv, **kwargs):
            path = Path(argv[argv.index('--file') + 1])
            seen.append((argv, path.read_text(), path.stat().st_mode & 0o777))
            stderr = 'ERROR: (Forbidden) Caller is not authorized' if len(seen) < 3 else ''
            return setup.subprocess.CompletedProcess(argv, 1 if stderr else 0, '"id"', stderr)
        with patch.object(setup.subprocess, 'run', side_effect=run), patch.object(setup, 'RETRY_SECONDS', 0):
            setup.vault_set(self.config, 'teams-graph-client-secret', 'private-value', keyId='abc')
        self.assertEqual(len(seen), 3)
        argv, value, mode = seen[-1]
        self.assertEqual((value, mode), ('private-value', 0o600))
        self.assertNotIn('private-value', argv)
        self.assertEqual(argv[argv.index('--tags') + 1], 'keyId=abc')
        self.assertEqual(argv[argv.index('--vault-name') + 1], 'kvacmementra12345678')

    def test_vault_reports_missing_secret_without_retrying(self):
        result = setup.subprocess.CompletedProcess([], 1, '', 'ERROR: (SecretNotFound) A secret with (name/id) x was not found')
        with patch.object(setup.subprocess, 'run', return_value=result) as run:
            self.assertIsNone(setup.vault_get(self.config, 'x'))
        self.assertEqual(run.call_count, 1)

    def test_upgrade_finds_the_running_package_confirms_backups_and_relinks(self):
        packages = self.home / 'packages'
        old = packages / '3.3.0-dev.1/mentra-private-cloud'
        new = packages / '3.3.0-dev.2/mentra-private-cloud'
        for package, tag in ((old, '3.3.0-dev.1'), (new, '3.3.0-dev.2')):
            package.mkdir(parents=True)
            (package / 'release.json').write_text(json.dumps({'releaseTag': tag}))
        (self.home / 'mentra-private-cloud').symlink_to('packages/3.3.0-dev.1/mentra-private-cloud')
        self.write_state('infrastructure_verified', release_hash='old-release')
        hashes = {str(old / 'release.json'): 'old-release', str(new / 'release.json'): 'new-release'}
        selected = []
        def select(args, directory):
            selected.append(Path(args.previous_package))
            state = setup.read_json(directory / 'state.json')
            state.update(releaseHash='new-release', phase='upgrade_ready')
            setup.write_json(directory / 'state.json', state)
        with patch.object(setup, 'ROOT', new), patch.object(setup, 'digest', side_effect=lambda p: hashes.get(str(p), 'config-hash')), \
             patch.object(setup, 'check_release', return_value=RELEASE), \
             patch.object(setup, 'preview', return_value={'create': [], 'change': ['Container App ca: new software image'], 'unchanged': 9}), \
             patch.object(setup, 'select_upgrade', side_effect=select), \
             patch.object(setup, 'load', side_effect=lambda d: (self.config, setup.read_json(d / 'state.json'), RELEASE)), \
             patch.object(setup, 'install', return_value={'status': 'infrastructure_verified'}) as install:
            with self.assertRaisesRegex(setup.SetupError, 'after backing up'):
                setup.upgrade_command(self.args, self.directory, interactive=False)
            self.assertEqual(selected, [])
            self.args.backup_confirmed = True
            result = setup.upgrade_command(self.args, self.directory, interactive=False)
        self.assertEqual(selected, [old.resolve()])
        install.assert_called_once()
        self.assertEqual(result['status'], 'upgraded')
        self.assertEqual(setup.os.readlink(self.home / 'mentra-private-cloud'), 'packages/3.3.0-dev.2/mentra-private-cloud')

    def test_upgrade_refuses_an_unfinished_deployment(self):
        packages = self.home / 'packages'
        old = packages / '3.3.0-dev.1/mentra-private-cloud'
        new = packages / '3.3.0-dev.2/mentra-private-cloud'
        for package in (old, new):
            package.mkdir(parents=True)
            (package / 'release.json').write_text('{"releaseTag": "3.3.0-dev.1"}')
        self.write_state('deploying', release_hash='old-release')
        with patch.object(setup, 'ROOT', new), patch.object(setup, 'check_release', return_value=RELEASE), \
             patch.object(setup, 'digest', side_effect=lambda p: 'old-release' if Path(p) == old / 'release.json' else 'new'), \
             patch.object(setup, 'select_upgrade') as select:
            with self.assertRaisesRegex(setup.SetupError, 'not finished setup'):
                setup.upgrade_command(self.args, self.directory, interactive=False)
        select.assert_not_called()

    def test_teams_setup_keeps_the_secret_in_key_vault_and_rolls_out(self):
        state = self.write_state('infrastructure_verified', outputs={'keyVaultName': 'kvacmementra12345678'})
        with patch.object(setup, 'create_meetings_app', return_value=(SUB, 'graph-secret', True, '2028-10-08T00:00:00Z')), \
             patch.object(setup, 'confirm', return_value=True), patch.object(setup, 'vault_set') as vault_set, \
             patch.object(setup, 'resolve_principal', return_value={'id': TENANT}), \
             patch.object(setup, 'update_configuration') as update, \
             patch.object(setup, 'install', return_value={'status': 'infrastructure_verified'}) as install:
            self.args.teams_organizer = 'organizer@acme.example'
            result = setup.configure_teams(self.args, self.directory, self.config, state, interactive=False)
        vault_set.assert_called_once_with(self.config, 'teams-graph-client-secret', 'graph-secret')
        self.assertEqual(update.call_args.kwargs, {'teamsGraphTenantId': TENANT, 'teamsGraphClientId': SUB,
                                                   'teamsGraphOrganizerId': TENANT})
        install.assert_called_once()
        self.assertNotIn('graph-secret', json.dumps(result))
        self.assertIn(f'New-CsApplicationAccessPolicy -Identity MentraMeetings -AppIds {SUB}', result['teamsPolicy'])
        self.assertEqual(result['adminConsent'], 'granted')

    def test_teams_settings_are_the_only_new_post_install_changes(self):
        self.assertEqual(setup.UPDATABLE_KEYS, {'sourceRegistryMirror', 'coreAdminEmails', 'teamsGraphTenantId',
                                                'teamsGraphClientId', 'teamsGraphOrganizerId'})
        self.assertTrue(setup.UPDATABLE_KEYS.isdisjoint(setup.BINDING_KEYS))

    def test_entra_handoffs_link_consent_and_assignment_when_not_admin(self):
        with patch.object(setup, 'mobile_access', return_value={'servicePrincipalId': 'sp-id', 'consent': False, 'assigned': False}), \
             patch.object(setup, 'grant_admin_consent', side_effect=setup.SetupError('not an admin')):
            handoffs = setup.entra_handoffs(self.args, self.config, interactive=False)
        self.assertEqual([h['step'] for h in handoffs], ['Admin consent', 'Employee access'])
        self.assertIn(f'https://login.microsoftonline.com/{TENANT}/adminconsent?client_id={TENANT}', handoffs[0]['action'])
        self.assertIn('ManagedAppMenuBlade/~/Users/objectId/sp-id', handoffs[1]['action'])

    def test_granted_consent_is_trusted_before_graph_lists_it(self):
        with patch.object(setup, 'mobile_access', return_value={'servicePrincipalId': 'sp-id', 'consent': False, 'assigned': True}), \
             patch.object(setup, 'grant_admin_consent') as grant:
            self.assertEqual(setup.entra_handoffs(self.args, self.config, interactive=False), [])
        grant.assert_called_once()

    def test_employees_are_assigned_once_and_unknown_names_reported(self):
        posted = []
        def graph(config, method, path, body=None, missing_ok=False):
            if method == 'POST':
                posted.append(body['principalId'])
                if body['principalId'] == 'existing':
                    raise setup.GraphError(409)
                return {}
            if path.startswith('users/alice'):
                return {'id': 'alice-id', 'displayName': 'Alice'}
            if path.startswith('users/'):
                return None
            if 'groups' in path and 'Field' in path:
                return {'value': [{'id': 'existing', 'displayName': 'Field Techs'}]}
            return {'value': []}
        with patch.object(setup, 'graph', side_effect=graph):
            assigned, unknown = setup.assign_employees(self.config, 'sp', ['alice@acme.example', 'Field Techs', 'ghost@acme.example'])
        self.assertEqual(assigned, ['Alice', 'Field Techs'])
        self.assertEqual(unknown, ['ghost@acme.example'])
        self.assertEqual(posted, ['alice-id', 'existing'])

    def test_suggested_deployment_names_are_valid(self):
        for name, expected in (('ACME Lumber & Supply', 'acme-lumber-mentra'), ('', 'company-mentra'),
                               ('42 Industries', 'industries-mentra')):
            self.assertEqual(setup.suggested_deployment_id(name), expected)


if __name__ == '__main__':
    unittest.main()
