"""Guided setup, Key Vault, preview and one-command upgrade; no Azure resources are created."""
import argparse
import contextlib
import io
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from urllib.parse import unquote as urllib_unquote

SPEC = importlib.util.spec_from_file_location('mentra_setup_guided', Path(__file__).with_name('setup.py'))
setup = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(setup)
SUB = '11111111-1111-1111-1111-111111111111'
# Stand-in for the text Graph returns from addPassword.
GRAPH_REPLY_TEXT = 'returned-by-graph'
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
                           coreIdentityName='id-acme-core', runtimeIdentityName='id-acme-runtime',
                           resourceTags={'mentraInstallerOwner': 'owner'}, **RELEASE)

    group = 'owned'

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
             patch.object(setup, 'ensure_group', record('group', {'resourceGroup': self.group})), \
             patch.object(setup, 'preview', record('preview', {'create': ['Key Vault kv'], 'change': [], 'unchanged': 0})), \
             patch.object(setup, 'run', record('run', '')), \
             patch.object(setup, 'install', record('install', {'status': phase_after_install}, installed)), \
             patch.object(setup, 'bootstrap_admin', record('admin', {'status': 'admin_key_ready'})), \
             patch.object(setup, 'upgrade_command', record('upgrade', {'status': 'upgraded'})):
            yield calls

    def test_fresh_install_runs_each_step_once_in_order(self):
        self.write_state('identity_configured')
        with self.steps() as calls:
            result = setup.guided(self.args, self.directory)
        self.assertEqual(calls, ['providers', 'preflight', 'group', 'preview', 'handoffs', 'install', 'admin'])
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
        # A first run: no sign-in apps yet, and the preview's resource group is new.
        self.config.update(coreApiClientId='', mobileClientId='')
        self.write_state('initialized')
        self.group = 'new'
        with self.steps() as calls, patch.object(setup, 'confirm', return_value=False):
            result = setup.guided(self.args, self.directory)
        self.assertEqual(result['status'], 'stopped')
        for step in ('entra', 'handoffs', 'install'):
            self.assertNotIn(step, calls)
        # The empty group made for the preview is removed again.
        self.assertEqual(calls[-1], 'run')

    def test_without_entra_rights_setup_hands_off_and_then_records_the_apps(self):
        self.config.update(coreApiClientId='', mobileClientId='')
        self.write_state('initialized')
        with self.steps() as calls, patch.object(setup, 'configure_entra', side_effect=setup.SetupError('Insufficient privileges')), \
             patch.object(setup, 'finish', side_effect=lambda d, r: r):
            result = setup.guided(self.args, self.directory)
        self.assertEqual(result['status'], 'awaiting_entra')
        handoff = setup.read_json(self.directory / 'state.json')['handoffs'][0]['action']
        self.assertIn('--installer-owner owner', handoff)
        self.assertIn('configure-entra --core-client-id CORE_ID --mobile-client-id MOBILE_ID', handoff)
        # The administrator's apps are recorded after a read-only check.
        state = setup.read_json(self.directory / 'state.json')
        args = argparse.Namespace(core_client_id=SUB.upper(), mobile_client_id=TENANT)
        with patch.object(setup, 'preflight'), \
             patch.object(setup, 'graph', return_value={'value': [{'signInAudience': 'AzureADMyOrg'}]}) as graph, \
             patch.object(setup, 'digest', return_value='config-hash'):
            setup.configure_entra(args, self.directory, self.config, state)
        self.assertTrue(all(call.args[1] == 'GET' for call in graph.call_args_list))
        config = setup.read_json(self.directory / 'deployment.config.json')
        self.assertEqual((config['coreApiClientId'], config['mobileClientId']), (SUB, TENANT))

    def test_a_deleted_deployment_says_how_to_start_over(self):
        self.write_state('infrastructure_verified', outputs={'workspaceOrigin': 'https://acme.example'})
        with self.steps() as calls, patch.object(setup, 'preflight', return_value={'resourceGroup': 'new'}):
            with self.assertRaisesRegex(setup.SetupError, 'no longer exists.*Start over'):
                setup.guided(self.args, self.directory)
        self.assertNotIn('install', calls)

    def test_app_names_name_the_deployment(self):
        self.assertEqual(setup.app_name(self.config, 'Mobile'), 'ACME Mentra Mobile (acme-mentra)')

    def test_sign_in_apps_are_created_only_after_confirmation(self):
        self.config.update(coreApiClientId='', mobileClientId='')
        self.write_state('initialized')
        previews = []
        with self.steps() as calls, patch.object(setup, 'preview', side_effect=lambda d, c, s: previews.append(c) or
                                                 {'create': [], 'change': [], 'unchanged': 0}):
            setup.guided(self.args, self.directory)
        self.assertLess(calls.index('group'), calls.index('entra'))
        self.assertEqual(previews[0]['mobileClientId'], setup.PLANNED_APP_ID)

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
        self.assertEqual(summary['create'], ['Key Vault kvacme', 'Role assignment an app can read one of its own secrets'])
        self.assertEqual(summary['change'], ['Container App ca-acme-core: new software image'])
        self.assertEqual(summary['unchanged'], 3)

    def test_vault_writes_pass_values_by_private_file_and_wait_for_access(self):
        seen = []
        def run(argv, **kwargs):
            path = Path(argv[argv.index('--file') + 1])
            seen.append((argv, path.read_text(), path.stat().st_mode & 0o777))
            stderr = 'ERROR: (Forbidden) Caller is not authorized' if len(seen) < 3 else ''
            return setup.subprocess.CompletedProcess(argv, 1 if stderr else 0, '"id"', stderr)
        with patch.object(setup.subprocess, 'run', side_effect=run), patch.object(setup, 'RETRY_SECONDS', 0), \
             patch.object(setup, 'grant_vault_access') as grant:
            setup.vault_set(self.config, 'teams-graph-client-secret', 'private-value', keyId='abc')
        self.assertEqual(len(seen), 3)
        # An administrator without access yet (say, resuming someone else's install) is given it once.
        grant.assert_called_once_with(self.config)
        argv, value, mode = seen[-1]
        self.assertEqual((value, mode), ('private-value', 0o600))
        self.assertNotIn('private-value', argv)
        self.assertEqual(argv[argv.index('--tags') + 1], 'keyId=abc')
        self.assertEqual(argv[argv.index('--vault-name') + 1], 'kvacmementra12345678')

    def test_vault_access_is_granted_by_the_ownership_template(self):
        with patch.object(setup, 'run') as run:
            setup.grant_vault_access(self.config)
        argv = run.call_args[0][0]
        self.assertEqual(argv[2:3], ['--bootstrap-only'])
        self.assertTrue(argv[1].endswith('scripts/deploy.sh'))
        self.assertFalse(Path(argv[3]).exists())

    def test_vault_errors_other_than_access_propagation_are_shown_at_once(self):
        result = setup.subprocess.CompletedProcess([], 1, '', 'ERROR: (Forbidden) Client address is not authorized\nInner error: {"code":"ForbiddenByFirewall"}')
        with patch.object(setup.subprocess, 'run', return_value=result) as run, patch.object(setup, 'grant_vault_access') as grant:
            with self.assertRaisesRegex(setup.SetupError, 'Client address is not authorized'):
                setup.vault_get(self.config, 'x')
        self.assertEqual(run.call_count, 1)
        grant.assert_not_called()

    def test_preview_counts_repeated_changes(self):
        grant = {'changeType': 'Create', 'resourceId': '/subscriptions/s/resourceGroups/rg/providers/Microsoft.KeyVault/vaults/kv/secrets/a/providers/Microsoft.Authorization/roleAssignments/g',
                 'after': {'properties': {'roleDefinitionId': '/x/4633458b-17de-408a-b874-0445c86b69e6'}}}
        summary = setup.summarize_preview({'access': {'changes': [dict(grant, resourceId=grant['resourceId'] + str(i)) for i in range(5)]}})
        self.assertEqual(summary['create'], ['Role assignment an app can read one of its own secrets (x5)'])

    def test_vault_reports_missing_secret_without_retrying(self):
        result = setup.subprocess.CompletedProcess([], 1, '', 'ERROR: (SecretNotFound) A secret with (name/id) x was not found')
        with patch.object(setup.subprocess, 'run', return_value=result) as run:
            self.assertIsNone(setup.vault_get(self.config, 'x'))
        self.assertEqual(run.call_count, 1)

    def test_pre_key_vault_deployments_are_refused_before_anything_changes(self):
        packages = self.home / 'packages'
        old = packages / '3.3.0-dev.1/mentra-private-cloud'
        new = packages / '3.3.0-dev.2/mentra-private-cloud'
        for package, tag in ((old, '3.3.0-dev.1'), (new, '3.3.0-dev.2')):
            package.mkdir(parents=True)
            (package / 'release.json').write_text(json.dumps({'releaseTag': tag}))
        (self.home / 'mentra-private-cloud').symlink_to('packages/3.3.0-dev.1/mentra-private-cloud')
        legacy = {k: v for k, v in self.config.items() if k not in ('keyVaultName', 'coreIdentityName', 'runtimeIdentityName')}
        self.config = dict(legacy, pullIdentityName='id-acme-pull')
        self.write_state('infrastructure_verified', release_hash='old-release')
        hashes = {str(old / 'release.json'): 'old-release', str(new / 'release.json'): 'new-release'}
        before = (self.directory / 'state.json').read_bytes()
        with patch.object(setup, 'ROOT', new), patch.object(setup, 'digest', side_effect=lambda p: hashes.get(str(p), 'config-hash')), \
             patch.object(setup, 'check_release', return_value=RELEASE), patch.object(setup, 'preview') as preview, \
             patch.object(setup, 'select_upgrade') as select:
            with self.assertRaisesRegex(setup.SetupError, 'pre-release installer'):
                setup.upgrade_command(self.args, self.directory, interactive=False)
        preview.assert_not_called()
        select.assert_not_called()
        self.assertEqual((self.directory / 'state.json').read_bytes(), before)
        self.assertFalse((self.directory / 'upgrade.pending.json').exists())

    def upgrade_packages(self, old_tag, new_tag):
        packages = self.home / 'packages'
        old = packages / f'{old_tag}/mentra-private-cloud'
        new = packages / f'{new_tag}/mentra-private-cloud'
        for package, tag in ((old, old_tag), (new, new_tag)):
            package.mkdir(parents=True)
            (package / 'release.json').write_text(json.dumps({'releaseTag': tag}))
        (self.home / 'mentra-private-cloud').symlink_to(f'packages/{old_tag}/mentra-private-cloud')
        hashes = {str(old / 'release.json'): 'old-release', str(new / 'release.json'): 'new-release'}
        return old, new, hashes

    def test_an_older_package_is_refused_before_the_preview(self):
        old, new, hashes = self.upgrade_packages('3.3.0-dev.5', '3.3.0-dev.2')
        self.write_state('infrastructure_verified', release_hash='old-release')
        with patch.object(setup, 'ROOT', new), patch.object(setup, 'digest', side_effect=lambda p: hashes.get(str(p), 'x')), \
             patch.object(setup, 'check_release', return_value=RELEASE), patch.object(setup, 'preview') as preview:
            with self.assertRaisesRegex(setup.SetupError, f'older than the deployment.*{old}'):
                setup.upgrade_command(self.args, self.directory, interactive=False)
        preview.assert_not_called()

    def test_a_deployment_failing_verification_can_still_be_upgraded(self):
        self.assertTrue(setup.upgradable_phase(self.config, {'phase': 'deployed'}))
        self.assertFalse(setup.upgradable_phase(dict(self.config, workspaceHostname='mentra.acme.example'), {'phase': 'deployed'}))
        self.assertFalse(setup.upgradable_phase(self.config, {'phase': 'deploying'}))

    def test_dns_that_setup_cannot_write_is_handed_off(self):
        state = self.write_state('awaiting_dns', dns=[{'type': 'CNAME', 'name': 'mentra.acme.example', 'value': 'app'},
                                                      {'type': 'TXT', 'name': 'asuid.mentra.acme.example', 'value': 'id'}])
        self.config['workspaceHostname'] = 'mentra.acme.example'
        with patch.object(setup, 'check_dns', side_effect=setup.SetupError('not yet')), \
             patch.object(setup, 'find_azure_dns_zone', return_value={'name': 'acme.example', 'resourceGroup': 'rg-dns'}), \
             patch.object(setup, 'configure_azure_dns', side_effect=setup.SetupError('AuthorizationFailed')), \
             patch.object(setup, 'confirm', return_value=True), \
             contextlib.redirect_stdout(io.StringIO()) as out:
            self.assertFalse(setup.handle_dns(self.args, self.directory, self.config, state, interactive=False))
        self.assertIn('could not add the records itself', out.getvalue())
        self.assertIn('CNAME mentra.acme.example', out.getvalue())

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

    def test_teams_setup_creates_the_app_and_rolls_out(self):
        state = self.write_state('infrastructure_verified', outputs={'keyVaultName': 'kvacmementra12345678'})
        with patch.object(setup, 'create_meetings_app', return_value=(SUB, True, '2028-10-08T00:00:00Z')), \
             patch.object(setup, 'confirm', return_value=True), patch.object(setup, 'vault_set') as vault_set, \
             patch.object(setup, 'vault_get', return_value={'value': 'stored-by-create'}), \
             patch.object(setup, 'resolve_principal', return_value={'id': TENANT, 'collection': 'users'}), \
             patch.object(setup, 'update_configuration') as update, \
             patch.object(setup, 'install', return_value={'status': 'infrastructure_verified'}) as install:
            self.args.teams_organizer = 'organizer@acme.example'
            result = setup.configure_teams(self.args, self.directory, self.config, state, interactive=False)
        # create_meetings_app stored the secret itself.
        vault_set.assert_not_called()
        self.assertEqual(update.call_args.kwargs, {'teamsGraphTenantId': TENANT, 'teamsGraphClientId': SUB,
                                                   'teamsGraphOrganizerId': TENANT})
        install.assert_called_once()
        policy = next(line for line in result['teamsPolicy'] if 'CsApplicationAccessPolicy -Identity MentraMeetings -AppIds' in line)
        # Works the first time and after switching apps, when the policy already exists.
        self.assertIn(f"Set-CsApplicationAccessPolicy -Identity MentraMeetings -AppIds @{{Add='{SUB}'}}", policy)
        self.assertIn(f'New-CsApplicationAccessPolicy -Identity MentraMeetings -AppIds {SUB}', policy)
        self.assertEqual(result['adminConsent'], 'granted')

    def meetings_graph(self, existing_names=(), recorded_app=None):
        calls = []
        role = {'value': 'OnlineMeetings.ReadWrite.All', 'id': 'role-id'}
        def graph(config, method, path, body=None, missing_ok=False):
            path = urllib_unquote(path)
            calls.append((method, path.split('?')[0]))
            if method == 'GET' and "appId eq '00000003" in path:
                return {'value': [{'id': 'graph-sp', 'appRoles': [role]}]}
            if method == 'GET' and path.startswith('applications?') and 'displayName' in path:
                return {'value': [{'id': 'someone-else'}] if existing_names else []}
            if method == 'GET' and path.startswith('applications?'):
                return {'value': [{'id': 'app-object', 'appId': recorded_app}] if recorded_app else []}
            if method == 'POST' and path == 'applications':
                return {'id': 'app-object', 'appId': SUB}
            if method == 'GET' and path.startswith('servicePrincipals?'):
                return {'value': [{'id': 'app-sp'}]}
            if method == 'POST' and path.endswith('/addPassword'):
                return {'secretText': GRAPH_REPLY_TEXT, 'keyId': 'key-1'}
            if method == 'POST' and path.endswith('/removePassword'):
                calls.append(('removed', body['keyId']))
            return {}
        return graph, calls

    def test_meetings_app_is_never_adopted_by_name(self):
        state = self.write_state('infrastructure_verified')
        graph, calls = self.meetings_graph(existing_names=True)
        with patch.object(setup, 'graph', side_effect=graph):
            with self.assertRaisesRegex(setup.SetupError, 'that setup did not create'):
                setup.create_meetings_app(self.directory, self.config, state)
        self.assertNotIn(('POST', 'applications'), calls)
        self.assertFalse(any(path.endswith('/appRoleAssignedTo') for method, path in calls if method == 'POST'))

    def test_new_meetings_app_is_recorded_granted_first_and_its_secret_stored_at_once(self):
        state = self.write_state('infrastructure_verified')
        graph, calls = self.meetings_graph()
        with patch.object(setup, 'graph', side_effect=graph), patch.object(setup, 'vault_get', return_value=None), \
             patch.object(setup, 'vault_set') as vault_set:
            client_id, consent, expires = setup.create_meetings_app(self.directory, self.config, state)
        self.assertEqual((client_id, consent), (SUB, True))
        self.assertEqual(json.loads((self.directory / 'state.json').read_text())['meetingsAppId'], SUB)
        posts = [path for method, path in calls if method == 'POST']
        self.assertLess(posts.index('servicePrincipals/graph-sp/appRoleAssignedTo'), posts.index('applications/app-object/addPassword'))
        vault_set.assert_called_once_with(self.config, 'teams-graph-client-secret-' + SUB, GRAPH_REPLY_TEXT)

    def test_a_password_that_cannot_be_stored_is_removed(self):
        state = self.write_state('infrastructure_verified')
        graph, calls = self.meetings_graph()
        with patch.object(setup, 'graph', side_effect=graph), patch.object(setup, 'vault_get', return_value=None), \
             patch.object(setup, 'vault_set', side_effect=setup.SetupError('Key Vault refused')):
            with self.assertRaisesRegex(setup.SetupError, 'Key Vault refused'):
                setup.create_meetings_app(self.directory, self.config, state)
        self.assertIn(('removed', 'key-1'), calls)

    def test_rerun_reuses_the_recorded_app_and_its_saved_secret(self):
        state = self.write_state('infrastructure_verified', meetingsAppId=SUB)
        graph, calls = self.meetings_graph(recorded_app=SUB)
        with patch.object(setup, 'graph', side_effect=graph), patch.object(setup, 'vault_get', return_value={'value': 'saved'}), \
             patch.object(setup, 'vault_set') as vault_set:
            self.assertEqual(setup.create_meetings_app(self.directory, self.config, state)[0], SUB)
        self.assertNotIn(('POST', 'applications'), calls)
        self.assertFalse(any(path.endswith('/addPassword') for method, path in calls))
        vault_set.assert_not_called()

    def test_a_rejected_secret_changes_nothing(self):
        state = self.write_state('infrastructure_verified', outputs={'keyVaultName': 'kvacmementra12345678'})
        self.args.teams_client_id = SUB
        self.args.teams_secret_stdin = True
        error = setup.urllib.error.HTTPError('url', 401, 'Unauthorized', {}, None)
        error.read = lambda: json.dumps({'error': 'invalid_client', 'error_codes': [7000215]}).encode()
        with patch('sys.stdin', io.StringIO('mistyped\n')), patch.object(setup, 'RETRY_SECONDS', 0), \
             patch.object(setup.urllib.request, 'urlopen', side_effect=error) as urlopen, \
             patch.object(setup, 'vault_set') as vault_set, patch.object(setup, 'update_configuration') as update:
            with self.assertRaisesRegex(setup.SetupError, 'rejected the client secret'):
                setup.configure_teams(self.args, self.directory, self.config, state, interactive=False)
        self.assertEqual(urlopen.call_count, 6)
        vault_set.assert_not_called()
        update.assert_not_called()

    def test_existing_meetings_app_consent_is_checked_not_assumed(self):
        role = 'b8bb2037-6e08-44ac-a4ea-4674e010e2a4'
        def graph(config, method, path, body=None, missing_ok=False):
            if "appId eq '00000003" in urllib_unquote(path):
                return {'value': [{'id': 'graph-sp', 'appRoles': [{'value': 'OnlineMeetings.ReadWrite.All', 'id': role}]}]}
            if 'servicePrincipals?' in path:
                return {'value': [{'id': 'app-sp'}]}
            return {'value': [{'appRoleId': role, 'resourceId': 'graph-sp'}] if self.granted else []}
        for self.granted in (True, False):
            with patch.object(setup, 'graph', side_effect=graph):
                self.assertIs(setup.meetings_consent(self.config, SUB), self.granted)
        with patch.object(setup, 'graph', side_effect=setup.GraphError(403)):
            self.assertIsNone(setup.meetings_consent(self.config, SUB))

    def test_switching_graph_apps_requires_that_apps_secret(self):
        state = self.write_state('infrastructure_verified', outputs={'keyVaultName': 'kvacmementra12345678'})
        self.config['teamsGraphClientId'] = SUB
        self.args.teams_client_id = TENANT
        saved = lambda config, name: {'value': 'old-secret'} if name == 'teams-graph-client-secret-' + SUB else None
        with patch.object(setup, 'vault_get', side_effect=saved), patch.object(setup, 'install') as install, \
             patch.object(setup, 'update_configuration') as update:
            with self.assertRaisesRegex(setup.SetupError, f'client secret for Graph app {TENANT}'):
                setup.configure_teams(self.args, self.directory, self.config, state, interactive=False)
        install.assert_not_called()
        update.assert_not_called()
        # The same app keeps its saved secret.
        self.args.teams_client_id = SUB
        with patch.object(setup, 'vault_get', side_effect=saved), patch.object(setup, 'meetings_consent', return_value=True), \
             patch.object(setup, 'install', return_value={'status': 'infrastructure_verified'}), patch.object(setup, 'update_configuration'):
            self.assertEqual(setup.configure_teams(self.args, self.directory, self.config, state, interactive=False)['adminConsent'], 'granted')

    def test_a_failed_teams_rollout_stays_pending_for_the_next_run(self):
        state = self.write_state('infrastructure_verified', outputs={'keyVaultName': 'kvacmementra12345678'})
        self.args.teams_client_id = SUB
        with patch.object(setup, 'vault_get', return_value={'value': 'saved'}), \
             patch.object(setup, 'update_configuration'), \
             patch.object(setup, 'meetings_consent', return_value=True), \
             patch.object(setup, 'install', side_effect=setup.SetupError('preflight failed')):
            with self.assertRaises(setup.SetupError):
                setup.configure_teams(self.args, self.directory, self.config, state, interactive=False)
        # Guided setup reruns install() for any phase but infrastructure_verified.
        self.assertEqual(json.loads((self.directory / 'state.json').read_text())['phase'], 'deploying')

    def test_teams_settings_are_the_only_new_post_install_changes(self):
        self.assertEqual(setup.UPDATABLE_KEYS, {'sourceRegistryMirror', 'coreAdminEmails', 'teamsGraphTenantId',
                                                'teamsGraphClientId', 'teamsGraphOrganizerId'})
        self.assertTrue(setup.UPDATABLE_KEYS.isdisjoint(setup.BINDING_KEYS))

    def test_entra_handoffs_link_consent_and_assignment_when_not_admin(self):
        with patch.object(setup, 'mobile_access', return_value={'servicePrincipalId': 'sp-id', 'consent': False, 'assigned': False}), \
             patch.object(setup, 'grant_admin_consent', side_effect=setup.SetupError('not an admin')):
            handoffs = setup.entra_handoffs(self.args, self.config, interactive=False)
        self.assertEqual([h['step'] for h in handoffs], ['Admin consent', 'Employee access'])
        self.assertIn(setup.permissions_page(TENANT), handoffs[0]['action'])
        self.assertIn('ManagedAppMenuBlade/~/Users/objectId/sp-id', handoffs[1]['action'])

    def test_granted_consent_is_trusted_before_graph_lists_it(self):
        with patch.object(setup, 'mobile_access', return_value={'servicePrincipalId': 'sp-id', 'consent': False, 'assigned': True}), \
             patch.object(setup, 'grant_admin_consent') as grant:
            self.assertEqual(setup.entra_handoffs(self.args, self.config, interactive=False), [])
        grant.assert_called_once()

    def test_employees_are_assigned_once_and_problems_reported_per_entry(self):
        posted = []
        def graph(config, method, path, body=None, missing_ok=False):
            if method == 'POST':
                posted.append(body['principalId'])
                if body['principalId'] in ('existing', 'mail-only'):
                    # Graph answers 400 for a duplicate and for an unassignable group alike.
                    raise setup.GraphError(400)
                if body['principalId'] == 'flaky':
                    raise setup.GraphError(503)
                return {}
            if '/members/microsoft.graph.group' in path:
                return {'value': [{'id': 'child'}] if path.startswith('groups/existing/') else []}
            if '/appRoleAssignments' in path:
                return {'value': [{'id': 'assignment'}] if path.startswith('groups/existing/') else []}
            if path.startswith('users/alice'):
                return {'id': 'alice-id', 'displayName': 'Alice'}
            if path.startswith('users/'):
                return None
            if 'mail eq' in urllib_unquote(path) and 'shared' in path:
                return {'value': [{'id': 'one'}, {'id': 'two'}]}
            if 'groups' in path and 'Field' in path:
                return {'value': [{'id': 'existing', 'displayName': 'Field Techs'}]}
            if 'groups' in path and 'Newsletter' in path:
                return {'value': [{'id': 'mail-only', 'displayName': 'Newsletter'}]}
            if 'groups' in path and 'Night' in path:
                return {'value': [{'id': 'flaky', 'displayName': 'Night Shift'}]}
            return {'value': []}
        with patch.object(setup, 'graph', side_effect=graph):
            assigned, problems = setup.assign_employees(
                self.config, 'sp', ['alice@acme.example', 'Field Techs', 'ghost@acme.example', 'Newsletter',
                                    'shared@acme.example', 'Night Shift'])
        self.assertEqual(assigned, ['Alice', 'Field Techs'])
        reasons = dict(problems)
        self.assertIn('not found', reasons['ghost@acme.example'])
        self.assertIn('Entra ID P1', reasons['Newsletter'])
        self.assertIn('more than one', reasons['shared@acme.example'])
        self.assertIn('groups inside it', reasons['Field Techs'])
        # One failing entry doesn't stop the others.
        self.assertIn('HTTP 503', reasons['Night Shift'])
        self.assertEqual(posted, ['alice-id', 'existing', 'mail-only', 'flaky'])

    def test_teams_policy_commands_target_the_tenant_and_keep_other_apps(self):
        commands = setup.teams_policy_commands(SUB, TENANT, TENANT, previous_client_id='99999999-9999-9999-9999-999999999999')
        text = '\n'.join(commands)
        self.assertIn(f'Connect-MicrosoftTeams -TenantId {TENANT}', text)
        self.assertIn(f"-AppIds @{{Add='{SUB}'}}", text)
        self.assertIn("-AppIds @{Remove='99999999-9999-9999-9999-999999999999'}", text)
        self.assertIn('30 minutes', text)
        self.assertNotIn('Remove', '\n'.join(setup.teams_policy_commands(SUB, '', TENANT)))

    def test_meetings_app_created_by_setup_is_recognized_by_its_tag(self):
        state = self.write_state('infrastructure_verified')
        graph, calls = self.meetings_graph()
        tagged = {'value': [{'id': 'app-object', 'appId': SUB, 'tags': ['mentraInstallerOwner:owner']}]}
        def lookup(config, method, path, body=None, missing_ok=False):
            if method == 'GET' and 'displayName' in urllib_unquote(path) and path.startswith('applications?'):
                return tagged
            return graph(config, method, path, body, missing_ok)
        with patch.object(setup, 'graph', side_effect=lookup), patch.object(setup, 'vault_get', return_value={'value': 'saved'}):
            self.assertEqual(setup.create_meetings_app(self.directory, self.config, state)[0], SUB)
        self.assertNotIn(('POST', 'applications'), calls)

    def test_a_failed_optional_teams_step_still_ends_with_the_summary(self):
        self.write_state('identity_configured')
        with self.steps() as calls, patch.object(setup.sys.stdin, 'isatty', return_value=True), \
             patch.object(setup, 'confirm', return_value=True), \
             patch.object(setup, 'configure_teams', side_effect=setup.SetupError('no Entra role')), \
             patch.object(setup, 'finish', side_effect=lambda d, r: dict(r, finished=True)) as finish:
            result = setup.guided(self.args, self.directory)
        self.assertTrue(result['finished'])
        self.assertNotIn('teams', result)

    def test_graph_lookups_quote_names_with_apostrophes(self):
        paths = []
        def graph(config, method, path, body=None, missing_ok=False):
            paths.append(path)
            return {'value': [{'id': 'group-id', 'displayName': "O'Reilly Field Techs"}]}
        with patch.object(setup, 'graph', side_effect=graph):
            self.assertEqual(setup.resolve_principal(self.config, "O'Reilly Field Techs")['id'], 'group-id')
        self.assertIn("displayName%20eq%20'O''Reilly%20Field%20Techs'", paths[0])

    def test_resume_after_a_finished_deployment_only_verifies(self):
        state = self.write_state('deployed', domainVerified=True)
        self.config['workspaceHostname'] = 'mentra.acme.example'
        with patch.object(setup, 'deploy') as deploy, patch.object(setup, 'preflight') as preflight, \
             patch.object(setup, 'verify', return_value={'status': 'infrastructure_verified'}) as verify:
            self.assertEqual(setup.install(self.args, self.directory, self.config, state)['status'], 'infrastructure_verified')
        deploy.assert_not_called()
        preflight.assert_not_called()
        verify.assert_called_once()

    def test_tenant_suggestion_follows_the_chosen_subscription(self):
        answers = iter(['33333333-3333-3333-3333-333333333333', '', 'ACME', '', '', ''])
        prompts = []
        def ask(label):
            prompts.append(label)
            return next(answers)
        chosen = setup.subprocess.CompletedProcess([], 0, '44444444-4444-4444-4444-444444444444\n', '')
        args = argparse.Namespace(config=None, json=False)
        with patch.object(setup.sys.stdin, 'isatty', return_value=True), patch('builtins.input', side_effect=ask), \
             patch.object(setup, 'signed_in_account', return_value={'id': SUB, 'tenantId': TENANT, 'name': 'Default', 'user': {'name': 'it@acme'}}), \
             patch.object(setup.subprocess, 'run', return_value=chosen), patch.object(setup, 'check_release', return_value=RELEASE), \
             patch.object(setup, 'digest', return_value='this-release'), \
             patch.object(setup, 'subscription_visible', return_value=True), \
             patch.object(setup, 'existing_deployment', return_value=None):
            setup.init(args, self.directory / 'fresh')
        config = setup.read_json(self.directory / 'fresh/deployment.config.json')
        self.assertIn('[44444444-4444-4444-4444-444444444444]', prompts[1])
        self.assertEqual((config['subscriptionId'], config['tenantId']), ('33333333-3333-3333-3333-333333333333', '44444444-4444-4444-4444-444444444444'))
        self.assertEqual(config['deploymentId'], 'acme-mentra')

    def init_with(self, answers, earlier=None, where='fresh'):
        path = self.directory / 'answers.json'
        setup.write_json(path, answers)
        args = argparse.Namespace(config=str(path), json=False, backup_confirmed=False)
        with patch.object(setup.sys.stdin, 'isatty', return_value=False), \
             patch.object(setup, 'check_release', return_value=RELEASE), patch.object(setup, 'digest', return_value='this-release'), \
             patch.object(setup, 'subscription_visible', return_value=True), \
             patch.object(setup, 'existing_deployment', return_value=earlier), \
             patch.object(setup, 'dns_records', return_value=[{'value': 'app.azurecontainerapps.io'}, {'value': 'id'}]):
            setup.init(args, self.directory / where)
        return setup.read_json(self.directory / where / 'deployment.config.json'), setup.read_json(self.directory / where / 'state.json')

    def test_answers_are_cleaned_and_the_data_location_follows_the_region(self):
        config, _ = self.init_with(dict(subscriptionId=SUB.upper(), tenantId=TENANT.upper(), displayName='ACME',
                                        deploymentId='acme-mentra', location='West Europe',
                                        workspaceHostname='https://mentra.acme.example/'))
        self.assertEqual((config['subscriptionId'], config['tenantId']), (SUB, TENANT))
        self.assertEqual((config['location'], config['workspaceHostname']), ('westeurope', 'mentra.acme.example'))
        self.assertEqual(config['communicationDataLocation'], 'Europe')
        with self.assertRaisesRegex(setup.SetupError, 'subdomain'):
            self.init_with(dict(subscriptionId=SUB, tenantId=TENANT, displayName='ACME', deploymentId='acme-mentra',
                                workspaceHostname='acme.example'), where='apex')

    def test_placeholders_from_the_example_are_refused(self):
        with self.assertRaisesRegex(setup.SetupError, 'placeholders.*coreApiClientId'):
            self.init_with(dict(subscriptionId=SUB, tenantId=TENANT, displayName='ACME', deploymentId='acme-mentra',
                                coreApiClientId='<core-api-client-id>'))

    def test_a_lost_setup_folder_continues_the_same_deployment(self):
        owner = '22222222-2222-2222-2222-222222222222'
        earlier = {'owner': owner, 'release': RELEASE['releaseTag'], 'group': 'rg-acme-mentra',
                   'settings': {'displayName': 'ACME Corp', 'coreApiClientId': SUB, 'mobileClientId': TENANT,
                                'workspaceHostname': 'mentra.acme.example', 'teamsGraphClientId': SUB}}
        config, state = self.init_with(dict(subscriptionId=SUB, tenantId=TENANT, displayName='Acme', deploymentId='acme-mentra',
                                            workspaceHostname='mentra.acme.example'), earlier)
        # Same owner, so the same derived names and the earlier Entra apps and resource group.
        self.assertEqual(state['owner'], owner)
        self.assertTrue(config['keyVaultName'].endswith('22222222'))
        self.assertEqual(config['resourceTags']['mentraInstallerOwner'], owner)
        # Settings come from Azure's record of the last deployment, not the retyped answers.
        self.assertEqual((config['displayName'], config['coreApiClientId'], config['teamsGraphClientId']), ('ACME Corp', SUB, SUB))
        # The live custom address stays bound through the next rollout.
        self.assertTrue(state['domainVerified'])

    def test_a_lost_folder_never_downgrades_its_deployment(self):
        earlier = {'owner': '22222222-2222-2222-2222-222222222222', 'release': '9.9.9', 'group': 'rg-acme-mentra', 'settings': {}}
        with self.assertRaisesRegex(setup.SetupError, 'newer than this package'):
            self.init_with(dict(subscriptionId=SUB, tenantId=TENANT, displayName='ACME', deploymentId='acme-mentra'), earlier)

    def test_an_interrupted_init_can_be_run_again(self):
        (self.directory / 'fresh').mkdir()
        setup.write_json(self.directory / 'fresh/deployment.config.json', {'left': 'over'})
        config, state = self.init_with(dict(subscriptionId=SUB, tenantId=TENANT, displayName='ACME', deploymentId='acme-mentra'))
        self.assertEqual(state['phase'], 'initialized')

    def test_suggested_deployment_names_are_valid(self):
        for name, expected in (('ACME Lumber & Supply', 'acme-lumber-mentra'), ('', 'company-mentra'),
                               ('42 Industries', 'industries-mentra')):
            self.assertEqual(setup.suggested_deployment_id(name), expected)


if __name__ == '__main__':
    unittest.main()
