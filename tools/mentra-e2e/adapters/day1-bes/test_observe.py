import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

import bes_setup
import config
import reconcile
import run
from test_support import BOOT, NEW_BOOT, OWNER, FIXTURE, completion, make_config, source_observed


class CurrentObservationTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(); self.addCleanup(temp.cleanup)
        self.root = Path(temp.name); self.cfg = make_config(self, self.root/'inputs')

    def adapter(self, **changes):
        instance = bes_setup.Adapter(self.cfg, self.root/'observation', OWNER)
        actual = {**source_observed(), 'boot_id':NEW_BOOT, 'transport':'7', 'apk_path':'/data/app/test/base.apk'}
        actual.pop('pid'); actual.pop('device_epoch')
        instance.transport = Mock(return_value='7')
        instance.identity = Mock(return_value=actual)
        calls = []
        counts = {'pid':0, 'stat':0, 'boot':0}
        def shell(transport, *args):
            self.assertEqual(transport, '7'); calls.append(args)
            if args == ('cat', '/proc/sys/kernel/random/boot_id'):
                counts['boot'] += 1
                return BOOT if changes.get('boot') and counts['boot'] == 2 else NEW_BOOT
            if args == ('pidof', bes_setup.PACKAGE):
                counts['pid'] += 1
                return '1444 1555' if changes.get('multiple') else ('1555' if changes.get('pid') and counts['pid'] == 2 else '1444')
            if args[0] == 'cat' and args[1].endswith('/stat'):
                counts['stat'] += 1
                ticks = '999' if changes.get('ticks') and counts['stat'] == 2 else '123'
                return args[1].split('/')[2]+' (ASG test (process)) '+' '.join(['S']+['0']*18+[ticks]+['0']*3)
            if args == ('date', '+%s'): return '1011'
            raise AssertionError('Unexpected device command '+str(args))
        instance.shell = shell
        def adb(transport, *args):
            self.assertEqual(transport, '7'); self.assertEqual(args[:5], ('logcat', '-d', '-v', 'epoch', '-t'))
            self.assertEqual(args[-1], '*:S')
            return completion()
        instance.adb = Mock(side_effect=adb)
        return instance, calls

    def test_new_boot_is_read_without_mutation_and_matches_canonical_bracket(self):
        instance, calls = self.adapter()
        with patch.object(instance, 'write', side_effect=AssertionError('No device writes')), \
             patch.object(instance, 'install', side_effect=AssertionError('No install')), \
             patch.object(bes_setup.time, 'time', side_effect=[2000., 2001., 2002.]):
            value = instance.observe_current()
        self.assertEqual(instance.identity.call_args_list, [((NEW_BOOT,),), ((NEW_BOOT,),)])
        self.assertEqual(value['observationOwner'], OWNER)
        self.assertEqual(value['endpoint'], FIXTURE['transport']['address'])
        self.assertEqual(value['firmwareWrites'], 0)
        self.assertEqual(value['startTicksBefore'], '123')
        self.assertEqual(reconcile.current_identity(self.cfg, value, 2003.)[0]['boot_id'], NEW_BOOT)
        self.assertFalse(self.cfg.claim_path.exists())
        for name in ('current.log', 'current.json', 'owner.json'):
            self.assertEqual((instance.run_dir/name).stat().st_mode & 0o777, 0o600)
        self.assertEqual(json.loads((instance.run_dir/'current.json').read_text()), value)

    def test_boot_process_start_or_multiple_pid_change_never_yields_observation(self):
        for change in ('boot', 'pid', 'ticks', 'multiple'):
            with self.subTest(change=change):
                # Each attempted read uses a new immutable directory.
                if (self.root/'observation').exists():
                    (self.root/'observation').rename(self.root/change)
                instance, _ = self.adapter(**{change:True})
                with self.assertRaises(RuntimeError): instance.observe_current()
                self.assertFalse((instance.run_dir/'current.json').exists())
                self.assertFalse(self.cfg.claim_path.exists())

    def test_changed_second_identity_or_overlong_batch_is_rejected(self):
        instance, _ = self.adapter()
        actual = instance.identity.return_value
        instance.identity.side_effect = [actual, {**actual, 'cid':'0'*32}]
        with self.assertRaises(RuntimeError): instance.observe_current()
        instance.identity.side_effect = None
        with patch.object(bes_setup.time, 'time', side_effect=[2000., 2001., 2031.]), self.assertRaises(RuntimeError):
            instance.observe_current()
        self.assertFalse((instance.run_dir/'current.json').exists())

    def test_cli_observe_current_emits_hash_bound_reference_without_claim_or_installer(self):
        output = self.root/'observation'
        def observe(instance):
            bes_setup.durable_new(instance.run_dir/'current.json', {'synthetic':True})
        with patch.object(bes_setup.Adapter, 'observe_current', observe), patch('run_once.run') as installer:
            value = run.execute(self.cfg, 'observe-current', output, OWNER)
        installer.assert_not_called()
        self.assertEqual(value['current'], {'path':str(output/'current.json'), 'sha256':config.digest(output/'current.json')})
        self.assertEqual(value['observationOwner'], OWNER)
        self.assertFalse(self.cfg.claim_path.exists())
        with self.assertRaises(config.Guard): run.execute(self.cfg, 'observe-current', output, OWNER)


if __name__ == '__main__': unittest.main()
