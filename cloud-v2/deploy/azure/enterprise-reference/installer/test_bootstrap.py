"""Exercise the one-line download bootstrap against a local release origin."""
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest

BOOTSTRAP = Path(__file__).with_name('bootstrap.sh')


def archive(files):
    stream = io.BytesIO()
    with tarfile.open(fileobj=stream, mode='w:gz') as bundle:
        for name, data in files.items():
            info = tarfile.TarInfo(name)
            info.size = len(data)
            info.mode = 0o755 if name.endswith('.sh') else 0o644
            bundle.addfile(info, io.BytesIO(data))
    return stream.getvalue()


class BootstrapTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        self.origin = root / 'origin'
        self.home = root / 'home'
        self.home.mkdir()
        self.install = self.home / 'mentra-install'

    def publish(self, version, data=None, checksum=None, url=None):
        data = data or archive({'mentra-private-cloud/setup.sh': b'#!/bin/sh\necho ' + version.encode() + b'\n',
                                'mentra-private-cloud/release.json': json.dumps({'releaseTag': version}).encode()})
        release = self.origin / 'releases' / f'mentra-private-cloud-{version}'
        release.mkdir(parents=True, exist_ok=True)
        (release / 'mentra-private-cloud.tar.gz').write_bytes(data)
        archive_url = url or f'file://{release}/mentra-private-cloud.tar.gz'
        digest = checksum or hashlib.sha256(data).hexdigest()
        (release / '_assets.json').write_text(json.dumps({'assets': [
            {'name': 'mentra-private-cloud.tar.gz', 'browser_download_url': archive_url, 'digest': 'sha256:' + digest}]}))
        latest = self.origin / 'private-cloud/dev/latest.json'
        latest.parent.mkdir(parents=True, exist_ok=True)
        latest.write_text(json.dumps({'schemaVersion': 1, 'channel': 'dev', 'version': version,
                                      'archiveUrl': archive_url, 'sha256': digest}))

    def run_bootstrap(self, piped=False, **env):
        environment = {k: v for k, v in os.environ.items() if not k.startswith('MENTRA_')}
        environment.update(HOME=str(self.home), MENTRA_CHANNEL='dev', MENTRA_DOWNLOAD_ORIGIN=f'file://{self.origin}')
        environment.update(env)
        if piped:
            # The customer command is `curl ... | bash`: the script arrives on stdin.
            return subprocess.run(['bash'], input=BOOTSTRAP.read_text(), env=environment, text=True, capture_output=True)
        return subprocess.run(['bash', str(BOOTSTRAP)], env=environment, text=True, capture_output=True,
                              stdin=subprocess.DEVNULL)

    def active(self):
        return os.readlink(self.install / 'mentra-private-cloud')

    def test_piped_install_downloads_verifies_and_links_latest(self):
        self.publish('3.3.0-dev.711')
        result = self.run_bootstrap(piped=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.active(), 'packages/3.3.0-dev.711/mentra-private-cloud')
        package = self.install / 'packages/3.3.0-dev.711'
        self.assertTrue(os.access(package / 'mentra-private-cloud/setup.sh', os.X_OK))
        self.assertTrue((package / 'mentra-private-cloud.tar.gz').is_file())
        self.assertIn('mentra-private-cloud.tar.gz', (package / 'mentra-private-cloud.tar.gz.sha256').read_text())
        self.assertEqual(oct(self.install.stat().st_mode & 0o777), '0o700')
        self.assertIn('./mentra-private-cloud/setup.sh init --directory ./mentra-state', result.stdout)

    def test_pinned_version_uses_release_index(self):
        self.publish('3.3.0-dev.700')
        self.publish('3.3.0-dev.711')
        result = self.run_bootstrap(MENTRA_VERSION='3.3.0-dev.700')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.active(), 'packages/3.3.0-dev.700/mentra-private-cloud')

    def test_checksum_mismatch_installs_nothing(self):
        self.publish('3.3.0-dev.711', checksum='0' * 64)
        result = self.run_bootstrap()
        self.assertEqual(result.returncode, 1)
        self.assertIn('Checksum mismatch', result.stderr)
        self.assertFalse((self.install / 'mentra-private-cloud').exists())
        self.assertEqual(list((self.install / 'packages').iterdir()), [])

    def save_state(self, version, phase, pending_version=None):
        state = self.install / 'mentra-state'
        state.mkdir(exist_ok=True)
        (state / 'state.json').write_text(json.dumps({'phase': phase, 'releaseHash': self.release_hash(version)}))
        if pending_version:
            (state / 'upgrade.pending.json').write_text(json.dumps({'targetReleaseHash': self.release_hash(pending_version)}))

    def release_hash(self, version):
        return hashlib.sha256(json.dumps({'releaseTag': version}).encode()).hexdigest()

    def install_then_publish(self, deployed_version, phase, new_version='3.3.0-dev.711', **state):
        self.publish(deployed_version)
        self.assertEqual(self.run_bootstrap().returncode, 0)
        self.save_state(deployed_version, phase, **state)
        self.publish(new_version)
        result = self.run_bootstrap()
        self.assertEqual(result.returncode, 0, result.stderr)
        return result

    def test_verified_deployment_gets_upgrade_commands_not_a_switch(self):
        result = self.install_then_publish('3.3.0-dev.700', 'infrastructure_verified')
        self.assertEqual(self.active(), 'packages/3.3.0-dev.700/mentra-private-cloud')
        self.assertIn('./packages/3.3.0-dev.711/mentra-private-cloud/setup.sh upgrade --directory ./mentra-state '
                      '--previous-package ./packages/3.3.0-dev.700/mentra-private-cloud --backup-confirmed', result.stdout)

    def test_older_default_state_folder_is_detected(self):
        self.publish('3.3.0-dev.700')
        self.assertEqual(self.run_bootstrap().returncode, 0)
        state = self.install / 'mentra-setup'
        state.mkdir()
        (state / 'state.json').write_text(json.dumps({'phase': 'infrastructure_verified',
                                                      'releaseHash': self.release_hash('3.3.0-dev.700')}))
        self.publish('3.3.0-dev.711')
        result = self.run_bootstrap()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.active(), 'packages/3.3.0-dev.700/mentra-private-cloud')
        self.assertIn('setup.sh upgrade --directory ./mentra-setup', result.stdout)

    def test_setup_in_progress_finishes_on_its_own_release(self):
        # upgrade requires a verified deployment, so mid-setup must not print it.
        result = self.install_then_publish('3.3.0-dev.700', 'identity_configured')
        self.assertEqual(self.active(), 'packages/3.3.0-dev.700/mentra-private-cloud')
        self.assertIn('still in progress with 3.3.0-dev.700', result.stdout)
        self.assertNotIn('setup.sh upgrade', result.stdout)

    def test_interrupted_upgrade_relinks_and_resumes(self):
        self.publish('3.3.0-dev.700')
        self.publish('3.3.0-dev.711')
        self.assertEqual(self.run_bootstrap(MENTRA_VERSION='3.3.0-dev.700').returncode, 0)
        for state in ({'version': '3.3.0-dev.711', 'phase': 'upgrade_ready'},
                      {'version': '3.3.0-dev.700', 'phase': 'infrastructure_verified', 'pending_version': '3.3.0-dev.711'}):
            (self.install / 'mentra-private-cloud').unlink()
            (self.install / 'mentra-private-cloud').symlink_to('packages/3.3.0-dev.700/mentra-private-cloud')
            self.save_state(state['version'], state['phase'], state.get('pending_version'))
            result = self.run_bootstrap()
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(self.active(), 'packages/3.3.0-dev.711/mentra-private-cloud')
            self.assertIn('setup.sh resume --directory ./mentra-state', result.stdout)
            (self.install / 'mentra-state/upgrade.pending.json').unlink(missing_ok=True)

    def test_newer_release_replaces_link_before_deployment(self):
        self.publish('3.3.0-dev.700')
        self.assertEqual(self.run_bootstrap().returncode, 0)
        self.publish('3.3.0-dev.711')
        result = self.run_bootstrap()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.active(), 'packages/3.3.0-dev.711/mentra-private-cloud')

    def test_unsafe_archive_and_foreign_url_are_refused(self):
        self.publish('3.3.0-dev.711', data=archive({'mentra-private-cloud/setup.sh': b'',
                                                    'mentra-private-cloud/../../escape': b'x'}))
        result = self.run_bootstrap()
        self.assertEqual(result.returncode, 1)
        self.assertIn('unexpected files', result.stderr)
        self.assertFalse((self.home / 'escape').exists())

        self.publish('3.3.0-dev.712', url='https://example.invalid/mentra-private-cloud.tar.gz')
        result = self.run_bootstrap()
        self.assertEqual(result.returncode, 1)
        self.assertIn('outside Mentra downloads', result.stderr)

    def test_unpublished_template_requires_a_channel(self):
        self.publish('3.3.0-dev.711')
        result = self.run_bootstrap(MENTRA_CHANNEL='')
        self.assertEqual(result.returncode, 1)
        self.assertIn('Unknown release channel', result.stderr)


if __name__ == '__main__':
    unittest.main()
