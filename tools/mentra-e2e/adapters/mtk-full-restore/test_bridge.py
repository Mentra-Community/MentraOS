import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('mtk_restore_bridge', Path(__file__).with_name('bridge.py'))
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)


class BridgeTests(unittest.TestCase):
    def fixture(self, approval=True, twice=False):
        temporary = tempfile.TemporaryDirectory(); self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        def save(path, value):
            path.write_text(json.dumps(value)); path.chmod(0o600)
        def ref(path): return {'path': str(path), 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()}
        owner = 'abcdefab-1111-2222-3333-444444444444'
        remote = '/storage/emulated/0/asg/mentra-restore-'+owner+'.zip'
        source = {'transport':'7','usb':'1-2','firmware':'source','cid':'a'*32}
        intent = root/'intent.json'
        save(intent, {'operationID':owner,'source':source,'remote':remote,'runDirectory':str(root),'target':{'sha256':'b'*64,'size':12}})
        lease = root/'lease.json'; save(lease, {'pid':os.getppid(),'token':'private-fixture'})
        adb = root/'adb'; adb.write_text('not executed'); adb.chmod(0o700)
        probe = root/'probe.jar'; probe.write_bytes(b'pinned test probe')
        broadcast = ['adb','-t','7','shell','am','broadcast','-a','com.xy.updateota','-p','com.android.systemui','--es','cmd','start','--es','pkname','com.mentra.asg_client','--es','path',remote]
        helper = root/'helper.py'
        helper.write_text('def main():\n    run('+repr(broadcast)+')\n'+('    run('+repr(broadcast)+')\n' if twice else ''))
        names = ('__init__.py config.py ble_support.py factory_asg.py recover_wiped.py bes_continuity.py observe_power.py query_bes_version.py full_january.py reconcile.py observe.py').split()
        definition = {}
        for name in names:
            path=root/name;path.write_text('# inert source for offline test\n');definition[name]=ref(path)['sha256']
        calls=[]
        class Audit:
            def __init__(self,cfg,path): self.path=path;path.mkdir(mode=0o700)
            def run(self,argv,timeout=30): calls.append(argv);return SimpleNamespace(returncode=0,stdout='Broadcast completed')
        f = SimpleNamespace(Audit=Audit,save=save,UUID=r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}',HELPER_SHA=ref(helper)['sha256'],PROBE_SHA=ref(probe)['sha256'],status_probe_command=lambda argv:argv)
        python = Path(sys.executable).resolve()
        argv=[str(python),str(helper),'--transport','7','--usb-path','1-2','--expected-version','source','--expected-emmc-cid','a'*32,'--remote',remote,'--size','12','--sha256','b'*64,'--output',str(root/('mtk-full-'+owner)),'--update-engine-status-jar',str(probe)]
        request={'mode':'stage','leasePath':str(lease),'parentPid':os.getppid(),'adb':ref(adb),'python':ref(python),'january':{'directory':str(root),'definition':definition},'fixture':{'bluetooth':'AA:BB:CC:DD:EE:01'},'auditDirectory':str(root/'audit'),'helper':ref(helper),'probe':ref(probe),'sourceIntent':ref(intent),'argv':argv}
        requestPath=root/'request.json';save(requestPath,request)
        output=io.StringIO()
        def run():
            with patch.object(sys,'argv',['bridge','--request',str(requestPath),'--sha256',ref(requestPath)['sha256']]), patch.object(sys,'stdin',io.StringIO(json.dumps({'owner':owner,'approved':True})+'\n' if approval else '')), patch.dict(sys.modules,{'full_january':f}), patch.object(bridge.shutil,'which',return_value=str(adb)), contextlib.redirect_stdout(output): bridge.main()
        return run,calls,output,request,requestPath,save

    def test_one_gate_precedes_exact_broadcast(self):
        run,calls,output,*_=self.fixture();run()
        messages=[json.loads(line) for line in output.getvalue().splitlines()]
        self.assertEqual([m['type'] for m in messages],['before-apply','finished'])
        self.assertEqual(calls,[messages[0]['argv']])

    def test_missing_approval_sends_no_broadcast(self):
        run,calls,*_=self.fixture(approval=False)
        with self.assertRaises(Exception): run()
        self.assertEqual(calls,[])

    def test_second_broadcast_is_rejected(self):
        run,calls,*_=self.fixture(twice=True)
        with self.assertRaisesRegex(RuntimeError,'second broadcast'): run()
        self.assertEqual(len(calls),1)

    def test_source_argv_mismatch_cannot_request_approval(self):
        run,calls,output,request,path,save=self.fixture()
        request['argv'][request['argv'].index('--remote')+1]='/another/owner.zip';save(path,request)
        with self.assertRaisesRegex(RuntimeError,'argv differs'): run()
        self.assertEqual(calls,[]);self.assertEqual(output.getvalue(),'')


if __name__ == '__main__': unittest.main()
