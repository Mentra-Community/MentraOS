import {expect,test} from 'bun:test'
import {routineFixDelta,routineFixInclusions,type RoutineFixInput} from './routine-fix-provenance.types'
const input:RoutineFixInput={requestId:'attempt',observed:true,app:{repository:'Mentra-Community/MentraOS',headSha:'a'.repeat(40),artifactSha256:'b'.repeat(64),producer:{buildRunId:12,publicationAttempt:1,prNumber:23}},routine:{revision:'c'.repeat(40),bundleSha256:'d'.repeat(64)},framework:{revision:'e'.repeat(40),version:100,runtimeSha256:'f'.repeat(64),apiVersion:33},glasses:{manifestSha256:'0'.repeat(64)},execution:{hostId:'air',laneId:'android'},backend:null}
const fix={repository:'Mentra-Community/MentraOS' as const,number:23,observation:{repository:'Mentra-Community/MentraOS' as const,number:23,headSha:'a'.repeat(40),state:'merged' as const,review:'approved' as const,mergedAt:'2026-10-12T00:00:00Z',observedAt:'2026-10-12T00:00:00Z'}}
test('all selected changed components are reported; shared backend and hardware observations stay explicitly unknown',()=>{
 const next={...structuredClone(input),app:{...input.app,headSha:'1'.repeat(40),artifactSha256:'2'.repeat(64)},routine:{revision:'3'.repeat(40),bundleSha256:'4'.repeat(64)},framework:{...input.framework!,version:101},glasses:{manifestSha256:'5'.repeat(64)},execution:{hostId:'mini',laneId:'android'}}
 expect(new Set(routineFixDelta(input,next).changes.map(change=>change.component))).toEqual(new Set(['app','routine','framework','glasses software','machine/lane']))
 const unchanged=routineFixDelta(input,input);expect(unchanged.noInputChanges).toBe(false);expect(unchanged.unknowns).toContain('Shared backend deployment unverified')
})
test('merged PR is not proof: only observed exact PR source/artifact establishes app inclusion',()=>{
 expect(routineFixInclusions(input,[fix])[0]).toMatchObject({state:'included',component:'app artifact'})
 expect(routineFixInclusions({...input,observed:false},[fix])[0]!.state).toBe('not-yet-tested')
 expect(routineFixInclusions({...input,app:{...input.app,headSha:'1'.repeat(40)}},[fix])[0]!.state).toBe('unverified')
 expect(routineFixInclusions({...input,app:{repository:input.app.repository,headSha:input.app.headSha}},[fix])[0]!.state).toBe('unverified')
 expect(routineFixInclusions(input,[{...fix,repository:'Mentra-Community/Mentra-Automated-Testing',observation:{...fix.observation,repository:'Mentra-Community/Mentra-Automated-Testing',headSha:input.routine.revision}}])[0]).toMatchObject({state:'included',component:'routine bundle'})
})

test('published framework and routine receipts prove their own components, never the app or backend',()=>{
 const harness={...fix,repository:'Mentra-Community/Mentra-Automated-Testing' as const,observation:{...fix.observation,repository:'Mentra-Community/Mentra-Automated-Testing' as const,mergeCommitSha:'7'.repeat(40),
  inclusions:[{component:'routine bundle' as const,revision:input.routine.revision,sourceSha:'7'.repeat(40),state:'included' as const,observedAt:fix.observation.observedAt},
   {component:'framework' as const,revision:input.framework!.revision,sourceSha:'7'.repeat(40),state:'included' as const,observedAt:fix.observation.observedAt}]}}
 const inclusions=routineFixInclusions(input,[harness]);expect(inclusions.map(value=>[value.component,value.state])).toEqual([['routine bundle','included'],['framework','included']])
 expect(routineFixInclusions({...input,framework:null},[harness]).map(value=>value.component)).toEqual(['routine bundle'])
 expect(routineFixInclusions({...input,routine:{revision:input.routine.revision},framework:null},[harness])[0]?.state).toBe('unverified')
 expect(routineFixInclusions(input,[{...harness,observation:{...harness.observation,mergeCommitSha:'8'.repeat(40)}}]).every(value=>value.state==='unverified')).toBe(true)
})
test('a normal dev app artifact containing a merged fix is included without pretending it deployed the backend',()=>{
 const merged={...fix,observation:{...fix.observation,mergeCommitSha:input.app.headSha}}
 expect(routineFixInclusions({...input,app:{...input.app,producer:undefined}},[merged])[0]).toMatchObject({component:'app artifact',state:'included'})
 expect(routineFixInclusions(input,[merged])[0]!.reason).toContain('shared backend inclusion is not established')
})
