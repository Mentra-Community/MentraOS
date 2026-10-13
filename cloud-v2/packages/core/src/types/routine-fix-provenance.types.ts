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

export interface RoutineFixInclusion {repository:import('./routine-case.types').CasePr['repository'];number:number;component:'app artifact'|'routine bundle'|null;
 state:'included'|'not-yet-tested'|'unverified';reason:string}
/** Only exact packaged source identity is proof; merge state and version deltas are not. */
export function routineFixInclusions(input:RoutineFixInput,fixes:CaseFollowUpSummary['intendedFixes']):RoutineFixInclusion[] {
 return fixes.map(pr=>{
  if(!input.observed)return{...pr,component:null,state:'not-yet-tested',reason:'This attempt has no published observed result'}
  const observation=pr.observation
  if(pr.repository===input.app.repository&&input.app.producer?.prNumber===pr.number&&observation?.headSha===input.app.headSha&&input.app.artifactSha256)
   return{repository:pr.repository,number:pr.number,component:'app artifact',state:'included',reason:'Exact PR head and immutable app artifact match the published run; shared backend inclusion is unverified'}
  if(pr.repository==='Mentra-Community/Mentra-Automated-Testing'&&observation?.headSha===input.routine.revision&&input.routine.bundleSha256)
   return{repository:pr.repository,number:pr.number,component:'routine bundle',state:'included',reason:'Exact PR head and routine bundle match the published run'}
  return{repository:pr.repository,number:pr.number,component:null,state:'unverified',reason:'Available source and packaging evidence cannot establish PR inclusion'}
 })
}
