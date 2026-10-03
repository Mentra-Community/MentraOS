"""Verify portable releases against committed source and publication evidence."""
import importlib.util
import json
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('mentra_package', Path(__file__).with_name('package.py'))
package = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(package)
PREFIX = 'cloud-v2/deploy/azure/enterprise-reference/'


class PackageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.repo = Path(self.temp.name)
        self.git('init', '-q')
        self.git('config', 'user.email', 'test@example.invalid')
        self.git('config', 'user.name', 'Installer tests')
        for name in package.FILES:
            path = self.repo / PREFIX / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text('committed installer bytes\n')
        self.bundle = self.repo / PREFIX / 'miniapps/com.mentra.call-1.0.0.zip'
        self.bundle.parent.mkdir()
        self.bundle.write_bytes(b'release bundle')
        self.manifest = self.repo / PREFIX / 'mentra-deployment.json'
        self.app = dict(packageName='com.mentra.call', version='1.0.0', sha256=package.sha(self.bundle.read_bytes()))
        self.save_manifest([self.app])
        (self.repo / 'mobile').mkdir()
        (self.repo / 'mobile/package.json').write_text('{"version":"3.3.0"}')
        self.source = self.commit()
        self.publication = self.repo / 'publication.json'
        self.sbom = self.repo / 'image.spdx.json'
        self.sbom.write_bytes(b'{"spdxVersion":"SPDX-2.3"}')
        self.record = dict(schemaVersion=1, component='mentra-cloud-image', status='published',
                           image='ghcr.io/mentra-community/mentra-cloud', digest='sha256:' + 'a' * 64,
                           sourceCommit=self.source, releaseIdentity='3.3.0-test.1',
                           sbom=dict(format='spdx-json', size=self.sbom.stat().st_size,
                                     sha256=package.sha(self.sbom.read_bytes())))
        self.record['reference'] = self.record['image'] + '@' + self.record['digest']
        self.output = self.repo / 'release.tar.gz'

    def git(self, *args):
        return subprocess.check_output(['git', *args], cwd=self.repo, text=True).strip()

    def commit(self):
        self.git('add', PREFIX, 'mobile/package.json')
        self.git('commit', '-qm', 'Add release fixture')
        return self.git('rev-parse', 'HEAD')

    def save_manifest(self, apps):
        self.manifest.write_text(json.dumps({'miniapps': {'managed': apps}}))

    def build(self):
        self.publication.write_text(json.dumps(self.record))
        with patch.object(package, 'REPO', self.repo):
            return package.build(self.publication, self.sbom, self.output)

    def test_archive_uses_committed_bytes_and_separates_image_and_installer_revisions(self):
        script = self.repo / PREFIX / 'setup.sh'
        script.write_text('new installer revision\n')
        installer = self.commit()
        script.write_text('uncommitted change must not be shipped\n')
        release = self.build()
        self.assertEqual(release['clientMinVersion'], '3.3.0')
        self.assertEqual(release['imageSourceCommit'], self.source)
        self.assertEqual(release['installerSourceCommit'], installer)
        with tarfile.open(self.output) as archive:
            member = archive.getmember('mentra-private-cloud/setup.sh')
            self.assertEqual(member.mode, 0o755)
            data = archive.extractfile(member).read()
            self.assertEqual(data, b'new installer revision\n')
            self.assertEqual(release['files']['setup.sh'], package.sha(data))
        self.assertEqual(self.output.with_name('release.tar.gz.sha256').read_text().split()[0],
                         package.sha(self.output.read_bytes()))

    def test_same_committed_release_packages_identical_bytes_on_rerun(self):
        self.build()
        original = self.output.read_bytes()
        self.build()
        self.assertEqual(self.output.read_bytes(), original)

    def test_invalid_mobile_version_is_rejected(self):
        (self.repo / 'mobile/package.json').write_text('{"version":"unknown"}')
        self.record['sourceCommit'] = self.commit()
        with self.assertRaisesRegex(ValueError, 'marketing version'):
            self.build()

    def test_modified_sbom_is_rejected_before_archive_creation(self):
        self.sbom.write_bytes(b'tampered')
        with self.assertRaisesRegex(ValueError, 'SBOM bytes'):
            self.build()
        self.assertFalse(self.output.exists())

    def test_unpublished_or_mismatched_image_is_rejected(self):
        for field, value in [('status', 'pending'), ('digest', 'sha256:' + 'b' * 64)]:
            previous = self.record[field]
            self.record[field] = value
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, 'published coordinated'):
                self.build()
            self.record[field] = previous

    def test_modified_bundle_is_rejected(self):
        self.bundle.write_bytes(b'changed bundle')
        self.record['sourceCommit'] = self.commit()
        with self.assertRaisesRegex(ValueError, 'miniapp hash'):
            self.build()

    def test_path_traversal_in_managed_app_is_rejected(self):
        self.save_manifest([dict(self.app, packageName='../com.mentra.call')])
        self.record['sourceCommit'] = self.commit()
        with self.assertRaisesRegex(ValueError, 'package name'):
            self.build()

    def test_invalid_package_identifier_is_rejected_before_reading_bundle(self):
        self.save_manifest([dict(self.app, packageName='bad-name')])
        self.record['sourceCommit'] = self.commit()
        with self.assertRaisesRegex(ValueError, 'package name'):
            self.build()
        self.assertFalse(self.output.exists())

    def test_release_without_call_is_rejected(self):
        self.save_manifest([])
        self.record['sourceCommit'] = self.commit()
        with self.assertRaisesRegex(ValueError, 'include Mentra Call'):
            self.build()


if __name__ == '__main__':
    unittest.main()
