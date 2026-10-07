import {expect,test} from 'bun:test';
import {renderToStaticMarkup} from 'react-dom/server';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {readRerunId,AttemptLine,RerunForm,TestRerunPage} from './test-reruns';
import {TestSuitePage} from './test-suites';
const attempt={attemptId:'request',requestId:'request',attemptNumber:1,status:'pass',publicationComplete:false,parent:{suiteId:'nightly'},memberId:'item',rerunId:'repair',build:{headSha:'b'.repeat(40),channel:'dev' as const,repository:'Mentra-Community/MentraOS',source:{channel:'dev' as const,buildRunId:123,publicationAttempt:1}}};
const render=(element:any,client=new QueryClient())=>renderToStaticMarkup(<QueryClientProvider client={client}>{element}</QueryClientProvider>);
test('rerun URLs reject ambiguous IDs; attempts show exact artifact and incomplete evidence',()=>{
 expect(readRerunId('?testRerun=repair')).toBe('repair');expect(readRerunId('?testRerun=a&testRerun=b')).toBeNull();expect(readRerunId('?testRerun=../bad')).toBeNull();
 const html=render(<AttemptLine attempt={attempt}/>);expect(html).toContain('Evidence incomplete');expect(html).toContain('Build 123, publication 1');expect(html).toContain('?testRerun=repair');
});
test('form defaults to original artifact and exposes an optional override',()=>{
 const html=render(<RerunForm suiteId="nightly" memberIds={['item']} onClose={()=>{}}/>);expect(html).toContain('Use a different MentraOS artifact');expect(html).not.toContain('Build workflow ID');expect(html).toContain('Routine revision (optional)');expect(html).toContain('Reuse original exact source');
});
test('suite original verdict stays failed while latest attempt and inline history are visible',()=>{
 const client=new QueryClient();client.setQueryData(['test-suite','nightly'],{suiteId:'nightly',channel:'dev' as const,trigger:'nightly',startedAt:'2026-10-06T10:00:00Z',outcome:'failed',passed:1,failedRoutines:['captions'],build:{headSha:'a'.repeat(40)},members:[{memberId:'item',routineId:'captions',platform:'android',status:'failed'},{memberId:'passing',routineId:'long-test',platform:'android',status:'pass'}]});
 client.setQueryData(['rerun-progress','nightly'],{members:[{memberId:'item',latest:{...attempt,publicationComplete:true}}],children:[{rerunId:'repair',reason:'Fix'}]});
 const html=render(<TestSuitePage suiteId="nightly"/>,client);expect(html).toContain('1/2 passed');expect(html).toContain('1 passed on rerun');expect(html).toContain('Original verdict remains failed');expect(html).toContain('Attempt history');expect(html).toContain('Rerun failures');
});
test('one-member rerun links back to its original suite',()=>{
 const client=new QueryClient();client.setQueryData(['test-rerun','repair'],{parent:{suiteId:'nightly'},reason:'Fix',outcome:'failed',passed:0,attempts:[attempt],state:'accepted'});
 const html=render(<TestRerunPage rerunId="repair"/>,client);expect(html).toContain('?testSuite=nightly');expect(html).toContain('0/1');
});
