import {expect,test} from 'bun:test'
import {comparedSuiteCounts,observedTestStatus,testStatusCounts,suiteDisplayStatus} from './test-status-comparison'
import type {RerunAttempt} from './test-rerun.types'

test('latest counts include every original member and keep skipped, pending and incomplete distinct',()=>{
 const members=[{memberId:'failed',status:'failed',publicationComplete:true},{memberId:'passed',status:'pass',publicationComplete:true},{memberId:'skip',status:'not-run',publicationComplete:false}]
 const latest=new Map([['failed',{status:'pass',publicationComplete:true} as RerunAttempt]])
 expect(comparedSuiteCounts(members,latest)).toEqual({hasReruns:true,original:{failed:1,total:2,skipped:1,pending:0,incomplete:0},latest:{failed:0,total:2,skipped:1,pending:0,incomplete:0}})
 latest.set('failed',{status:'pass',publicationComplete:false} as RerunAttempt)
 expect(comparedSuiteCounts(members,latest).latest).toMatchObject({failed:0,pending:1})
 latest.set('failed',{status:'failed',publicationComplete:true} as RerunAttempt)
 expect(comparedSuiteCounts(members,latest).latest.failed).toBe(1)
 expect(testStatusCounts([{status:'cancelled',publicationComplete:false},{status:'running',publicationComplete:false}])).toMatchObject({failed:0,incomplete:1,pending:1})
 expect(observedTestStatus({status:'pass',publicationComplete:false})).toBe('publishing')
})


test('terminal evidence failure and unfinished publication have distinct presentation',()=>{
 expect(observedTestStatus({status:'pass',publicationComplete:false,evidenceStatus:'failed'})).toBe('evidence-failed')
 expect(observedTestStatus({status:'pass',publicationComplete:false,evidenceStatus:'complete'})).toBe('publishing')
 expect(observedTestStatus({status:'pass',publicationComplete:false,publicationFailed:true})).toBe('evidence-failed')
 expect(testStatusCounts([{status:'pass',publicationComplete:false,evidenceStatus:'failed'}])).toMatchObject({failed:1,pending:0})
 expect(suiteDisplayStatus('failed',0)).toBe('incomplete');expect(suiteDisplayStatus('failed',1)).toBe('failed');expect(suiteDisplayStatus('running',0)).toBe('running')
})
