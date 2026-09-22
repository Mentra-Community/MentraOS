"""Exercise real process/file-lock contention without touching a user's keychains."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest

HELPER = Path(__file__).with_name('keychain-search.py')


class KeychainConcurrencyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.keys = [self.root / f'job-{i}.keychain-db' for i in range(3)]
        for key in self.keys:
            key.touch()
        self.original = [str(self.keys[0]), str(self.keys[1])]
        self.state = self.root / 'search.json'
        self.state.write_text(json.dumps(self.original))
        fake_security = self.root / 'security'
        fake_security.write_text(f'''#!{sys.executable}
import json, os, sys
from pathlib import Path
state = Path(os.environ['TEST_KEYCHAIN_STATE'])
assert sys.argv[1:4] == ['list-keychains', '-d', 'user'], sys.argv
if len(sys.argv) == 4:
    print('\\n'.join(json.dumps(p) for p in json.loads(state.read_text())))
else:
    assert sys.argv[4] == '-s'
    state.write_text(json.dumps(sys.argv[5:]))
''')
        fake_security.chmod(0o700)
        self.env = {**os.environ, 'PATH': f'{self.root}{os.pathsep}{os.environ["PATH"]}',
                    'TEST_KEYCHAIN_STATE': str(self.state)}

    def start(self, *args):
        program = '''import importlib.util, pathlib, sys
spec = importlib.util.spec_from_file_location('keychain_search', sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
module.LOCK = pathlib.Path(sys.argv[2])
sys.exit(module.main(sys.argv[3:]))
'''
        child = subprocess.Popen([sys.executable, '-c', program, str(HELPER), str(self.root / 'lock'),
                                  *map(str, args)], env=self.env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        def cleanup():
            if child.poll() is None:
                child.kill()
            child.communicate(timeout=5)
        self.addCleanup(cleanup)
        return child

    def wait_for(self, file):
        deadline = time.monotonic() + 5
        while not file.exists():
            if time.monotonic() > deadline:
                self.fail(f'Timed out waiting for {file.name}')
            time.sleep(.01)

    def test_nonfirst_job_is_selected_and_failure_restores_other_jobs(self):
        command = '''import json, os, sys
assert json.load(open(os.environ['TEST_KEYCHAIN_STATE']))[0] == sys.argv[1]
sys.exit(7)
'''
        child = self.start('run', self.keys[1], sys.executable, '-c', command, self.keys[1])
        _, errors = child.communicate(timeout=5)
        self.assertEqual(child.returncode, 7, errors.decode())
        self.assertEqual(json.loads(self.state.read_text()), self.original)

    def test_search_list_changes_wait_for_signer_and_preserve_other_jobs(self):
        ready, release = self.root / 'ready', self.root / 'release'
        command = '''import json, os, pathlib, sys, time
key, ready, release = sys.argv[1:]
assert json.load(open(os.environ['TEST_KEYCHAIN_STATE']))[0] == key
pathlib.Path(ready).touch()
deadline = time.monotonic() + 5
while not pathlib.Path(release).exists():
    assert time.monotonic() < deadline
    assert json.load(open(os.environ['TEST_KEYCHAIN_STATE']))[0] == key
    time.sleep(.01)
'''
        signer = self.start('run', self.keys[1], sys.executable, '-c', command, self.keys[1], ready, release)
        self.wait_for(ready)
        addition = self.start('add', self.keys[2])
        time.sleep(.15)
        self.assertIsNone(addition.poll(), 'Another job changed the list during signing')
        release.touch()
        for child in (signer, addition):
            _, errors = child.communicate(timeout=5)
            self.assertEqual(child.returncode, 0, errors.decode())
        self.assertEqual(json.loads(self.state.read_text()), [str(self.keys[2]), *self.original])

    def test_child_retains_lock_when_wrapper_is_terminated(self):
        ready, release = self.root / 'ready', self.root / 'release'
        command = '''import pathlib, sys, time
ready, release = map(pathlib.Path, sys.argv[1:])
ready.touch()
deadline = time.monotonic() + 5
while not release.exists():
    assert time.monotonic() < deadline
    time.sleep(.01)
'''
        signer = self.start('run', self.keys[1], sys.executable, '-c', command, ready, release)
        self.wait_for(ready)
        signer.terminate()
        signer.wait(timeout=5)
        addition = self.start('add', self.keys[2])
        time.sleep(.15)
        self.assertIsNone(addition.poll(), 'Lock was released while the signer was still running')
        release.touch()
        _, errors = addition.communicate(timeout=5)
        self.assertEqual(addition.returncode, 0, errors.decode())


if __name__ == '__main__':
    unittest.main()
