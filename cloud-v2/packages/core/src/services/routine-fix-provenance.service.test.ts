import {expect,test,spyOn} from 'bun:test'
import {RoutineFixProvenanceService} from './routine-fix-provenance.service'
import {TestRequestModel} from '../models/test-request.model'
import {requestInputDigest} from './test-request.service'
import {TestRunError} from './test-result-error'
import {testRoutineSource,testFrameworkBinding} from '../testing/framework-fixtures'
const source={channel:'pr' as const,prNumber:23,buildRunId:10,publicationAttempt:1}
const build={repository:'Mentra-Community/MentraOS',headSha:'b'.repeat(40),channel:'pr',prNumber:23,kind:'android-apk',source,archive:{name:'app.apk',url:'https://artifactscdn.mentraglass.com/app.apk',size:1,sha256:'c'.repeat(64)},receipt:{url:'https://artifactscdn.mentraglass.com/r',size:1,sha256:'d'.repeat(64)}}
const input={routineId:'camera',platform:'android',definitionRevision:'a'.repeat(40),routineSource:testRoutineSource(),laneId:'android',resources:[{id:'app',kind:'app'}],build}
const occurrence={occurrenceId:'o',rootKey:'root',anchorRunId:'original',verificationRequestIds:[],original:{requestId:'original',memberId:'member',suiteId:'suite',environment:'dev'}} as any
const chain=(row:unknown)=>({read(){return this},readConcern(){return this},setOptions(){return this},async lean(){return row}})
const observed=()=>({...input,hostId:'air',frameworkBinding:testFrameworkBinding()})
function fixture(fleet=false){
 const requests=new Map<string,any>(['original','attempt'].map(requestId=>{
  const row:any={requestId,hostId:'air',input:structuredClone(input),inputSha256:requestInputDigest(input),state:'terminal',createdAt:requestId==='original'?0:1}
  if(fleet){
   // Ordinary nightly intake freezes the commit first; source preparation fills its bundle before binding.
   const selection={requestId,routineId:input.routineId,platform:input.platform,routineRevision:input.definitionRevision,source,build}
   const intent={...selection,routineSource:input.routineSource,laneId:input.laneId}
   Object.assign(row,{fleetSelection:selection,fleetSelectionSha256:requestInputDigest(selection),fleetPreparation:{routineSource:input.routineSource},
    fleetBinding:{hostId:'air',laneId:input.laneId},dispatchIntent:intent,dispatchIntentSha256:requestInputDigest(intent)})
  }
  return[requestId,row]
 }))
 const mock=spyOn(TestRequestModel,'findOne').mockImplementation(({requestId}:any)=>chain(requests.get(requestId)) as any)
 const selections:any[]=[],inventory=spyOn(TestRequestModel,'find').mockImplementation(((filter:any)=>{
  selections.push(filter)
  return{...chain(null),select(){return this},sort(){return this},limit(){return this},async lean(){
   return filter.requestId.$in.map((id:string)=>requests.get(id)).filter(Boolean)
    .sort((a:any,b:any)=>b.createdAt-a.createdAt||b.requestId.localeCompare(a.requestId)).slice(0,10).map(({requestId}:any)=>({requestId}))
  }}as any
 })as any)
 const results=new Map(['original','attempt'].map(id=>[id,observed()]))
 const calls:any[]=[],service=new RoutineFixProvenanceService({async history(...args:any[]){calls.push(args);return{attempts:[{requestId:'attempt',status:'failed',attemptNumber:2}],nextBefore:2}}} as any,
  {async summary(id:string){if(!results.has(id))throw new TestRunError(404,'Not yet published');return results.get(id)}} as any)
 return{requests,results,calls,selections,service,restore:()=>{mock.mockRestore();inventory.mockRestore()}}
}
test('bounded linked history compares accepted inputs and published framework binding without selecting a convenient pass',async()=>{
 const f=fixture()
 try{
  const page=await f.service.history(occurrence,5)
  expect(f.calls[0]).toEqual([{suiteId:'suite'},'member',5,10]);expect(page.nextBefore).toBe(2);expect(page.attempts[0]).toMatchObject({status:'failed',attemptNumber:2,delta:{changes:[]}})
  f.requests.get('attempt').inputSha256='f'.repeat(64)
  const invalid=await f.service.history(occurrence);expect(invalid.attempts[0]).toMatchObject({delta:null,provenanceUnavailable:'Rerun request differs from its frozen input'})
 }finally{f.restore()}
})
test('ordinary nightly provenance follows the prepared bundle and bound executable input instead of the initial sourceless selection',async()=>{
 const f=fixture(true)
 try{
  const page=await f.service.history(occurrence)
  expect(page.original).toMatchObject({observed:true,routine:{revision:input.definitionRevision,bundleSha256:input.routineSource.bundle.sha256}})
  expect(page.attempts[0]).toMatchObject({delta:{changes:[]},status:'failed'})
  expect(f.requests.get('original').fleetSelection).not.toHaveProperty('routineSource')
  // A preparing successor has selected inputs but makes no execution/binding claim.
  const attempt=f.requests.get('attempt');delete attempt.input;delete attempt.inputSha256;attempt.state='preparing';f.results.delete('attempt')
  const preparing=await f.service.history(occurrence)
  expect(preparing.attempts[0].delta).not.toBeNull();expect('inclusions' in preparing.attempts[0] && preparing.attempts[0].inclusions).toEqual([])
 }finally{f.restore()}
})
test('intent-bound historical fix provenance preserves the recorded app-only projection without changing original rows',async()=>{
 const f=fixture(),manifest={url:'https://artifactscdn.mentraglass.com/live/manifest.json',sha256:'f'.repeat(64),size:100}
 try{
  for(const id of ['original','attempt']){
   const row=f.requests.get(id),recorded={...row.input,glassesModel:'nimo',resources:[{id:'old-glasses',kind:'glasses'}]}
   const intent={requestId:id,routineId:recorded.routineId,platform:recorded.platform,routineRevision:recorded.definitionRevision,
    routineSource:recorded.routineSource,laneId:recorded.laneId,source,build:{...recorded.build,manifest,manifestSha256:manifest.sha256}}
   Object.assign(row,{input:recorded,inputSha256:requestInputDigest(recorded),dispatchIntent:intent,dispatchIntentSha256:requestInputDigest(intent)})
   f.results.set(id,{...recorded,hostId:'air',frameworkBinding:testFrameworkBinding()})
  }
  const before=JSON.stringify([...f.requests.values()]),history=await f.service.history(occurrence)
  expect(history.original).toMatchObject({observed:true,app:{headSha:build.headSha,artifactSha256:build.archive.sha256},glasses:null})
  expect(history.attempts[0]).toMatchObject({delta:{changes:[]}})
  expect(JSON.stringify([...f.requests.values()])).toBe(before)
 }finally{f.restore()}
})
test('changed binding source or executable input fails closed even when the changed fields have internally valid digests',async()=>{
 for(const target of ['binding-source','executable-build','observed-lane'] as const){
  const f=fixture(true)
  try{
   const attempt=f.requests.get('attempt')
   if(target==='binding-source'){attempt.dispatchIntent.routineSource=testRoutineSource('9'.repeat(40));attempt.dispatchIntent.routineRevision='9'.repeat(40);attempt.dispatchIntentSha256=requestInputDigest(attempt.dispatchIntent)}
   if(target==='executable-build'){attempt.input.build={...attempt.input.build,headSha:'9'.repeat(40)};attempt.inputSha256=requestInputDigest(attempt.input)}
   if(target==='observed-lane')f.results.get('attempt')!.laneId='different'
   const page=await f.service.history(occurrence)
   expect(page.attempts[0].delta).toBeNull();expect('provenanceUnavailable' in page.attempts[0] && page.attempts[0].provenanceUnavailable).toMatch(/differs/)
  }finally{f.restore()}
 }
})

test('recorded verification refresh ignores unavailable/changed inputs and never selects unrecorded latest passes',async()=>{
 const f=fixture()
 try{
  expect(await f.service.recordedInputs([{...occurrence,verificationRequestIds:['attempt','attempt','unavailable']}])).toHaveLength(1)
  f.requests.get('attempt').inputSha256='0'.repeat(64)
  expect(await f.service.recordedInputs([{...occurrence,verificationRequestIds:['attempt']}])).toEqual([])
 }finally{f.restore()}
})

test('recorded refresh selects case-wide request recency rather than occurrence storage order',async()=>{
 const f=fixture()
 try{
  const older=Array.from({length:10},(_,i)=>`older-${i}`)
  for(const [i,id]of older.entries()){
   f.requests.set(id,{...structuredClone(f.requests.get('attempt')),requestId:id,createdAt:i+10});f.results.set(id,observed())
  }
  f.requests.get('attempt').createdAt=100
  const inputs=await f.service.recordedInputs([{...occurrence,verificationRequestIds:['attempt']},{...occurrence,verificationRequestIds:older}])
  expect(inputs.map(input=>input.requestId)).toEqual(['attempt',...older.slice(1).reverse()])
  expect(f.selections[0]).toEqual({requestId:{$in:['attempt',...older]}})
  expect(f.calls).toEqual([])
 }finally{f.restore()}
})
