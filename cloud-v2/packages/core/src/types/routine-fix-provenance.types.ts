export interface RoutineFixInput {requestId:string;observed:boolean;app:{repository:string;headSha:string;artifactSha256?:string;producer?:{buildRunId:number;publicationAttempt:number;prNumber?:number}};routine:{revision:string;bundleSha256?:string};
  framework:{revision:string;version:number;runtimeSha256:string;apiVersion:number}|null;glasses:{manifestSha256:string}|null;
  execution:{hostId:string;laneId:string}|null;backend:null}
export interface RoutineFixDelta {requestId:string;changes:Array<{component:'app'|'routine'|'framework'|'glasses software'|'machine/lane';original:string;attempt:string}>;
  unknowns:string[];noInputChanges:boolean}
export function routineFixDelta(original:RoutineFixInput,attempt:RoutineFixInput):RoutineFixDelta {
 const changes:RoutineFixDelta['changes']=[],unknowns:string[]=[]
 const compare=(component:RoutineFixDelta['changes'][number]['component'],a:string|undefined,b:string|undefined)=>{
  if(a===undefined||b===undefined){unknowns.push(`${component} unavailable`);return}if(a!==b)changes.push({component,original:a,attempt:b})}
 compare('app',`${original.app.repository}@${original.app.headSha}`,`${attempt.app.repository}@${attempt.app.headSha}`)
 compare('app',original.app.artifactSha256,attempt.app.artifactSha256)
 compare('routine',original.routine.revision,attempt.routine.revision)
 compare('routine',original.routine.bundleSha256,attempt.routine.bundleSha256)
 compare('framework',original.framework?JSON.stringify(original.framework):undefined,attempt.framework?JSON.stringify(attempt.framework):undefined)
 if(original.glasses||attempt.glasses)compare('glasses software',original.glasses?.manifestSha256,attempt.glasses?.manifestSha256)
 compare('machine/lane',original.execution?`${original.execution.hostId}/${original.execution.laneId}`:undefined,attempt.execution?`${attempt.execution.hostId}/${attempt.execution.laneId}`:undefined)
 unknowns.push('Observed phone/glasses firmware identity unavailable','Shared backend deployment unverified')
 return {requestId:attempt.requestId,changes,unknowns:[...new Set(unknowns)],noInputChanges:changes.length===0&&unknowns.length===0}
}
export interface CaseFollowUpSummary {caseId:string;classification:import('./routine-case.types').RoutineCase['classification'];stage:import('./routine-case.types').RoutineCase['stage'];
 owner:string|null;displayStage:'closed'|import('./routine-case.types').RoutineCase['stage'];updatedAt:string;diagnosis:string;intendedFixes:Array<import('./routine-case.types').CasePr & {observation:import('./routine-case.types').RoutineCase['prObservations'][number]|null}>}

export type RoutineFixComponent = 'app artifact'|'routine bundle'|'framework'
export interface RoutineFixInclusion {repository:import('./routine-case.types').CasePr['repository'];number:number;component:RoutineFixComponent|null;
 state:'included'|'not-yet-tested'|'not-included'|'unverified';reason:string}
/** Components are admitted only from the exact published artifact, bundle or installed runtime. */
export function routineFixComponents(input:RoutineFixInput,repository:string):Array<{component:RoutineFixComponent;revision:string}> {
 if(!input.observed)return[]
 if(repository===input.app.repository)return input.app.artifactSha256?[{component:'app artifact',revision:input.app.headSha}]:[]
 if(repository!=='Mentra-Community/Mentra-Automated-Testing')return[]
 return[...(input.routine.bundleSha256?[{component:'routine bundle' as const,revision:input.routine.revision}]:[]),
  ...(input.framework?.runtimeSha256?[{component:'framework' as const,revision:input.framework.revision}]:[])]
}
/** A merge badge alone is not inclusion. Stored comparisons must match this immutable tested revision and PR source. */
export function routineFixInclusions(input:RoutineFixInput,fixes:CaseFollowUpSummary['intendedFixes']):RoutineFixInclusion[] {
 return fixes.flatMap((pr):RoutineFixInclusion[]=>{
  const identity={repository:pr.repository,number:pr.number},observation=pr.observation
  if(!input.observed)return[{...identity,component:null,state:'not-yet-tested' as const,reason:'This attempt has no published observed result'}]
  const components=routineFixComponents(input,pr.repository)
  if(!components.length)return[{...identity,component:null,state:'unverified' as const,reason:'Exact published component source or packaging evidence is unavailable'}]
  return components.map(({component,revision})=>{
   const scope=component==='app artifact'?'; shared backend inclusion is not established':''
   if(observation?.headSha===revision || observation?.state==='merged'&&observation.mergeCommitSha===revision)
    return{...identity,component,state:'included' as const,reason:`Exact PR source matches the published ${component} revision ${revision}${scope}`}
   const sourceSha=observation?.state==='merged'?observation.mergeCommitSha:observation?.headSha
   const proof=sourceSha?observation?.inclusions?.find(value=>value.component===component&&value.revision===revision&&value.sourceSha===sourceSha):undefined
   if(proof?.state==='included')return{...identity,component,state:'included' as const,
    reason:`GitHub ancestry confirms PR source ${sourceSha} is included in tested ${component} revision ${revision}; observed ${proof.observedAt}${scope}`}
   if(proof?.state==='not-included')return{...identity,component,state:'not-included' as const,
    reason:`GitHub ancestry shows PR source ${sourceSha} is not included in tested ${component} revision ${revision}; observed ${proof.observedAt}`}
   return{...identity,component,state:'unverified' as const,reason:'Source comparison is unavailable for this tested revision; refresh PR status to check it'}
  })
 })
}
