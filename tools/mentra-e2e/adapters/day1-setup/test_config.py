import copy
from dataclasses import FrozenInstanceError
import hashlib
import json
import os
from pathlib import Path
import tempfile
import types
import unittest
from unittest.mock import patch

import config
import ble_support
import full_january as controller
from test_support import FIXTURE, make_config, put
from test_full_january import BOOT, MemoryAudit, identity


class ConfigTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)
        self.cfg = make_config(self.base)

    def changed(self, update):
        value = json.loads(self.cfg.path.read_bytes())
        update(value)
        ref = put(self.cfg.path, value)
        return config.load(self.cfg.path, ref['sha256'])

    def test_exact_configuration_is_immutable_and_safe_to_summarize(self):
        cfg = self.cfg
        self.assertEqual(cfg.fixture, FIXTURE)
        self.assertEqual(cfg.ble_name, 'mentra_live_ee01')
        self.assertEqual(cfg.stage_claims, self.base/'claims'/FIXTURE['cid']/'stage')
        with self.assertRaises(FrozenInstanceError): cfg.sha256 = 'a'*64
        with self.assertRaises(TypeError): cfg.fixture['cid'] = '0'*32
        with self.assertRaises(TypeError): cfg.definition['config.py'] = '0'*64
        summary = json.dumps(cfg.public_inputs())
        credential = json.loads(cfg.credential.path.read_text())
        for forbidden in (credential['ssid'], credential['password'], str(cfg.credential.path)):
            self.assertNotIn(forbidden, summary)
        self.assertEqual(cfg.public_inputs()['profileSha256'], config.PROFILE_SHA)
        self.assertEqual(cfg.public_inputs()['configSha256'], cfg.sha256)

    def test_config_bytes_and_private_file_mode_are_required(self):
        with self.assertRaisesRegex(config.Guard, 'hash_mismatch'):
            config.load(self.cfg.path, '0'*64)
        self.cfg.path.write_text(self.cfg.path.read_text()+' ')
        with self.assertRaisesRegex(config.Guard, 'config_changed'): self.cfg.verify_definition()
        self.cfg.path.chmod(0o644)
        with self.assertRaisesRegex(config.Guard, 'private_file_invalid'):
            config.load(self.cfg.path, config.digest(self.cfg.path))

    def test_symlink_and_hardlinked_configuration_are_rejected(self):
        link = self.base/'link.json'; link.symlink_to(self.cfg.path)
        with self.assertRaises(OSError): config.load(link, self.cfg.sha256)
        link.unlink(); os.link(self.cfg.path, link)
        with self.assertRaisesRegex(config.Guard, 'private_file_invalid'):
            config.load(self.cfg.path, self.cfg.sha256)

    def test_definition_and_qualified_profile_cannot_be_relaxed(self):
        changes = [lambda x:x.update(profileId='latest'), lambda x:x.update(profileSha256='0'*64),
                   lambda x:x['ota'].update(sha256='0'*64), lambda x:x['ota'].update(size=True),
                   lambda x:x['verification'].update(sha256='0'*64),
                   lambda x:x['stagingHelper'].update(sha256='0'*64),
                   lambda x:x['statusProbe'].update(size=2146),
                   lambda x:x['definition'].update({'config.py':'0'*64}),
                   lambda x:x['definition'].pop('ble_support.py'), lambda x:x.update(command='anything')]
        original = self.cfg.path.read_bytes()
        for update in changes:
            self.cfg.path.write_bytes(original)
            with self.subTest(update=changes.index(update)), self.assertRaises(config.Guard): self.changed(update)

    def test_only_explicit_serial_aliases_private_endpoint_and_normalized_paths(self):
        changes = [lambda x:x['fixture'].update(serialAliases=['OTHER']),
                   lambda x:x['fixture'].update(serialAliases=[FIXTURE['serial'],FIXTURE['serial']]),
                   lambda x:x['fixture'].update(serialAliases=[{}]),
                   lambda x:x['fixture'].update(mac='AA:BB:CC'),lambda x:x['fixture'].update(cid=None),
                   lambda x:x.update(sourceEndpoint='8.8.8.8:5555'),
                   lambda x:x.update(sourceEndpoint='127.0.0.1:5555'),
                   lambda x:x.update(sourceEndpoint='192.168.50.10:4444'),
                   lambda x:x.update(claimsRoot=str(self.base/'a/../claims'))]
        original=self.cfg.path.read_bytes()
        for update in changes:
            self.cfg.path.write_bytes(original)
            with self.subTest(update=changes.index(update)),self.assertRaises((config.Guard,ValueError)):
                self.changed(update)
        self.cfg.path.write_bytes(original)
        cfg=self.changed(lambda x:x['fixture'].update(serialAliases=[FIXTURE['serial'],'0123456789ABCDEF']))
        self.assertEqual(cfg.serial_aliases,(FIXTURE['serial'],'0123456789ABCDEF'))

    def test_changed_credentials_fail_before_any_transport_command(self):
        self.cfg.credential.path.write_text(self.cfg.credential.path.read_text()+' ')
        with self.assertRaisesRegex(config.Guard,'credential_hash_changed'):
            ble_support.load_credentials(self.cfg,self.cfg.credential.path)
        audit=MemoryAudit(self.base)
        operation={'configSha256':self.cfg.sha256,'profileSha256':config.PROFILE_SHA,'credentialFileSha256':self.cfg.credential.sha256}
        with patch.object(config.Config,'require_lease'),patch.object(controller,'app_absent'),patch.object(controller,'source_identity') as read:
            with self.assertRaisesRegex(config.Guard,'credential_hash_changed'):
                controller.before_write(self.cfg,audit,operation)
        read.assert_not_called();self.assertEqual(audit.commands,[])

    def test_exact_outer_lease_parent_is_required_for_controller_and_children(self):
        put(self.cfg.lease_path,{'pid':12345,'token':'synthetic-lock-token'})
        with patch.object(os,'kill') as alive,patch.object(os,'getppid',return_value=12345):
            controller.lease(self.cfg)
            alive.assert_called_once_with(12345,0)
        with patch.object(os,'kill'),patch.object(os,'getppid',return_value=22222):
            with self.assertRaisesRegex(config.Guard,'controller_lease_parent_mismatch'):controller.lease(self.cfg)
            with patch('subprocess.run',return_value=types.SimpleNamespace(returncode=0,stdout='12345\n')) as ps:
                self.cfg.require_lease(child=True)
                self.assertEqual(ps.call_args.args[0],['ps','-p','22222','-o','ppid='])
            with patch('subprocess.run',return_value=types.SimpleNamespace(returncode=0,stdout='777\n')):
                with self.assertRaisesRegex(config.Guard,'child_lease_parent_mismatch'):self.cfg.require_lease(child=True)
        put(self.cfg.lease_path,{'pid':22222,'token':'different-owner'})
        with patch.object(os,'kill'), patch.object(os,'getppid',return_value=12345), \
                self.assertRaisesRegex(config.Guard,'controller_lease_parent_mismatch'):self.cfg.require_lease()

    def test_new_live_parent_uses_identical_config_and_stale_or_malformed_lease_fails(self):
        original = self.cfg.path.read_bytes()
        for pid in (12345, 22222):
            put(self.cfg.lease_path, {'pid':pid, 'token':'newly-owned-private-lease'})
            with patch.object(os,'kill'), patch.object(os,'getppid',return_value=pid):
                self.assertEqual(self.cfg.require_lease(), pid)
            self.assertEqual(self.cfg.path.read_bytes(), original)
            self.assertEqual(config.digest(self.cfg.path), self.cfg.sha256)
        with patch.object(os,'kill',side_effect=ProcessLookupError), self.assertRaises(ProcessLookupError):
            self.cfg.require_lease()
        for owner in ({'pid':True,'token':'x'}, {'pid':1,'token':'x'}, {'pid':'22222','token':'x'}, {'pid':22222,'token':''}):
            put(self.cfg.lease_path, owner)
            with self.assertRaisesRegex(config.Guard,'root_fixture_lease_required'):self.cfg.require_lease()
        with self.assertRaisesRegex(config.Guard,'lease_schema'):
            self.changed(lambda value:value['lease'].update(ownerPid=12345))

    def test_child_cannot_adopt_a_reparented_controller(self):
        put(self.cfg.lease_path, {'pid':12345, 'token':'private-lease'})
        with patch.object(os,'kill'), patch.object(os,'getppid',side_effect=[22222,33333]), \
                patch('subprocess.run',return_value=types.SimpleNamespace(returncode=0,stdout='12345\n')), \
                self.assertRaisesRegex(config.Guard,'child_lease_parent_mismatch'):
            self.cfg.require_lease(child=True)

    def test_external_helper_mismatch_fails_before_import_or_commands(self):
        self.cfg.helper.path.write_text('raise RuntimeError("must never import")')
        with patch('importlib.util.spec_from_file_location') as importer,patch('subprocess.run') as command:
            with self.assertRaisesRegex(config.Guard,'reference_hash_changed'):controller.pin_tools(self.cfg)
        importer.assert_not_called();command.assert_not_called()

    def test_stable_claim_root_must_be_private_and_cannot_be_a_symlink(self):
        self.cfg.stage_claims.chmod(0o755)
        with self.assertRaisesRegex(config.Guard,'claim_directory_not_private'):self.cfg.prepare_claims()
        self.cfg.stage_claims.chmod(0o700);self.cfg.stage_claims.rmdir()
        elsewhere=self.base/'elsewhere';elsewhere.mkdir(mode=0o700)
        self.cfg.stage_claims.symlink_to(elsewhere)
        with self.assertRaisesRegex(config.Guard,'claim_directory_not_private'):self.cfg.prepare_claims()

    def test_child_failure_preserves_durable_claim_and_new_output_cannot_repeat(self):
        self.cfg.bes_install.path.write_text('{}');self.cfg.bes_install.path.chmod(0o600)
        first=controller.Audit(self.cfg,self.base/'first')
        args=types.SimpleNamespace(owner='3ca76bb6-815e-4c5a-9511-7dbce4a8c100')
        with patch.object(config.Config,'require_lease'),patch.object(controller,'app_absent'), \
             patch.object(controller,'artifact',return_value={'sha256':controller.ZIP_SHA}), \
             patch.object(controller,'source_identity',return_value=('17',identity())),patch.object(controller,'capacity'), \
             patch.object(config.Reference,'verify'),patch.object(controller.continuity,'validate_input'), \
             patch.object(controller,'stage_transfer',side_effect=config.Guard('synthetic_transfer_boundary_failure')) as transfer:
            with self.assertRaisesRegex(config.Guard,'synthetic_transfer_boundary_failure'):
                controller.stage(self.cfg,args,None,first)
            operation=controller.private(first.path/'operation.json')
            claim=Path(operation['claim']['path'])
            self.assertTrue(claim.exists());self.assertEqual(claim.parent,self.cfg.stage_claims)
            self.assertEqual(operation['owner'],args.owner)
            self.assertEqual(operation['configSha256'],self.cfg.sha256)
            second=controller.Audit(self.cfg,self.base/'second')
            args.owner='b8bf2658-e739-43f8-b1bd-55b60d1ef4c0'
            with self.assertRaises(FileExistsError):controller.stage(self.cfg,args,None,second)
            self.assertEqual(transfer.call_count,1)
            self.assertFalse((second.path/'operation.json').exists())
            self.assertFalse((first.path/'transfer-intent.json').exists())

    def test_recorded_command_uses_configured_adb_and_retains_exact_exit(self):
        audit=controller.Audit(self.cfg,self.base/'audit')
        with patch('subprocess.run',return_value=types.SimpleNamespace(returncode=7,stdout='read-value',stderr='diagnostic')) as run:
            result=audit.run(['adb','devices','-l'])
        self.assertEqual(run.call_args.args[0],[str(self.cfg.adb),'devices','-l'])
        row=controller.private(audit.path/'command-0001.json')
        self.assertEqual(row['argv'],run.call_args.args[0]);self.assertEqual(row['exitCode'],7)
        self.assertLessEqual(row['startedAt'],row['endedAt']);self.assertEqual(result.returncode,7)

    def test_command_timeout_is_preserved_without_retry(self):
        audit=controller.Audit(self.cfg,self.base/'audit')
        with patch('subprocess.run',side_effect=TimeoutError) as run:
            with self.assertRaises(TimeoutError):audit.run(['adb','devices','-l'])
        self.assertEqual(run.call_count,1)
        row=controller.private(audit.path/'command-0001.json')
        self.assertTrue(row['interrupted']);self.assertEqual(row['errorClass'],'TimeoutError')


if __name__=='__main__':unittest.main()
