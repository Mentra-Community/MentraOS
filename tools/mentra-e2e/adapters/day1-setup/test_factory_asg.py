import unittest
import factory_asg as f
from test_support import ASG_SHA

DATA = '/data/app/~~abc_123==/com.mentra.asg_client-AbC_123==/base.apk'


class FactoryAsgTests(unittest.TestCase):
    def verify(self, path=DATA, changes=None):
        values = {'read_asg_path': 'package:'+path, 'read_asg_path_after': 'package:'+path,
                  'hash_asg_active': ASG_SHA+'  '+path, 'hash_asg_system': ASG_SHA+'  '+f.SYSTEM,
                  'hash_asg_backup': ASG_SHA+'  '+f.BACKUP, 'read_asg_package': 'versionCode=27\nversionCode=27'}
        values.update(changes or {})
        return f.verify(None, lambda label, *args: values[label])

    def test_system_and_first_boot_installed_copy_require_three_matching_hashes(self):
        self.assertTrue(self.verify(f.SYSTEM)['activeIsSystemPath'])
        actual = self.verify()
        self.assertFalse(actual['activeIsSystemPath'])
        self.assertEqual(actual['versionCode'], 27)
        self.assertEqual(set(actual['hashes'].values()), {ASG_SHA})

    def test_wrong_active_system_or_backup_hash_is_never_accepted(self):
        for label in ('hash_asg_active', 'hash_asg_system', 'hash_asg_backup'):
            with self.subTest(label=label), self.assertRaises(f.r.Guard): self.verify(changes={label: '0'*64+' /file'})

    def test_wrong_or_absent_version_and_changing_path_fail(self):
        for changes in ({'read_asg_package': 'versionCode=303006291'}, {'read_asg_package': 'versionCode=27\nversionCode=39'},
                        {'read_asg_package': ''}, {'read_asg_path_after': 'package:'+f.SYSTEM}):
            with self.subTest(changes=changes), self.assertRaises(f.r.Guard): self.verify(changes=changes)

    def test_other_data_paths_other_packages_and_multiple_apks_fail(self):
        for path in ('/data/app/asg.apk', '/data/local/tmp/base.apk', '/data/app/~~one/another.package-id/base.apk',
                     DATA+'\npackage:/another.apk', '/system/app/another/base.apk', '/data/app/../com.mentra.asg_client-x/base.apk'):
            with self.subTest(path=path), self.assertRaises(f.r.Guard): self.verify(path)


if __name__ == '__main__': unittest.main()
