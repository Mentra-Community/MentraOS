import {expect,test,spyOn} from 'bun:test'
import {RoutineFixProvenanceService} from './routine-fix-provenance.service'
import {TestRequestModel} from '../models/test-request.model'
import {requestInputDigest} from './test-request.service'
import {testRoutineSource,testFrameworkBinding} from '../testing/framework-fixtures'
const source={channel:'pr' as const,prNumber:23,buildRunId:10,publicationAttempt:1}
const selected={requestId:'original',routineId:'camera',platform:'android',routineRevision:'a'.repeat(40),routineSource:testRoutineSource(),source,build:{repository:'Mentra-Community/MentraOS',headSha:'b'.repeat(40),channel:'pr',prNumber:23,kind:'android-apk',source,archive:{name:'app.apk',url:'https://artifactscdn.mentraglass.com/app.apk',size:1,sha256:'c'.repeat(64)},receipt:{url:'https://artifactscdn.mentraglass.com/r',size:1,sha256:'d'.repeat(64)}}}
const occurrence={occurrenceId:'o',rootKey:'root',anchorRunId:'original',verificationRequestIds:[],original:{requestId:'original',memberId:'member',suiteId:'suite',environment:'dev'}} as any
const chain=(row:unknown)=>({read(){return this},readConcern(){return this},setOptions(){return this},async lean(){return row}})
test('bounded linked history compares accepted inputs and published framework binding without selecting a convenient pass',async()=>{
 const requests=new Map(['original','attempt'].map(requestId=>[requestId,{requestId,fleetSelection:{...selected,requestId},fleetSelectionSha256:requestInputDigest({...selected,requestId})}]))
 const mock=spyOn(TestRequestModel,'findOne').mockImplementation(({requestId}:any)=>chain(requests.get(requestId)) as any)
 try{
  const calls:any[]=[],service=new RoutineFixProvenanceService({async history(...args:any[]){calls.push(args);return{attempts:[{requestId:'attempt',status:'failed',attemptNumber:2}],nextBefore:2}}} as any,
   {async summary(id:string){return{routineId:'camera',platform:'android',definitionRevision:selected.routineRevision,routineSource:selected.routineSource,hostId:'air',laneId:'android',build:selected.build,frameworkBinding:testFrameworkBinding()}}} as any)
  const page=await service.history(occurrence,5)
  expect(calls[0]).toEqual([{suiteId:'suite'},'member',5,10]);expect(page.nextBefore).toBe(2);expect(page.attempts[0]).toMatchObject({status:'failed',attemptNumber:2,delta:{changes:[]}})
  requests.get('attempt')!.fleetSelectionSha256='f'.repeat(64)
  const invalid=await service.history(occurrence);expect(invalid.attempts[0]).toMatchObject({delta:null,provenanceUnavailable:'Verification input integrity unavailable'})
 }finally{mock.mockRestore()}
})
