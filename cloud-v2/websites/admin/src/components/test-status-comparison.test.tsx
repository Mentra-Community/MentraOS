import {expect,test} from 'bun:test'
import {renderToStaticMarkup} from 'react-dom/server'
import {OriginalLatestStatus,SuiteCountComparison} from './test-status-comparison'

test('one original badge without reruns; compact comparisons retain both outcomes',()=>{
 const original=renderToStaticMarkup(<OriginalLatestStatus original="failed"/>)
 expect(original.match(/Failed/g)).toHaveLength(1);expect(original).not.toContain('to latest')
 const comparison=renderToStaticMarkup(<OriginalLatestStatus original="failed" latest={{status:'pass',publicationComplete:true}}/>)
 expect(comparison).toContain('Failed');expect(comparison).toContain('Passed');expect(comparison).toContain('Original → Latest')
 const waiting=renderToStaticMarkup(<OriginalLatestStatus original="failed" latest={{status:'pass',publicationComplete:false}}/>)
 expect(waiting).toContain('Publishing');expect(waiting).not.toContain('Passed')
})
test('suite comparison excludes skips and zero known failures still shows unfinished coverage',()=>{
 const original={failed:1,total:26,skipped:1,pending:0,incomplete:0},latest={failed:0,total:26,skipped:1,pending:2,incomplete:1}
 const html=renderToStaticMarkup(<SuiteCountComparison original={original} latest={latest}/>)
 expect(html).toContain('1/26 failed, 1 skipped');expect(html).toContain('0/26 failed, 1 skipped, 2 pending, 1 incomplete')
 expect(html).toContain('Original → Latest');expect(html).not.toContain('3 passing')
})


test('failed evidence is red rather than a never-ending publishing state',()=>{
 const html=renderToStaticMarkup(<OriginalLatestStatus original="failed" latest={{status:'pass',publicationComplete:false,evidenceStatus:'failed'}}/>)
 expect(html).toContain('Evidence failed');expect(html).not.toContain('Publishing');expect(html).toContain('text-[#cf222e]')
})
