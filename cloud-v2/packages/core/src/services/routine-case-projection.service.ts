import {routineCaseRepository,type RoutineCaseRepository} from './routine-case.repository'
import type {RoutineCase} from '../types/routine-case.types'
import type {CaseFollowUpSummary} from '../types/routine-fix-provenance.types'
const compact=(row:RoutineCase):CaseFollowUpSummary=>({caseId:row.caseId,classification:row.classification,stage:row.stage,owner:row.owner,displayStage:row.stage==='verified'&&row.occurrences.some(occurrence=>occurrence.closure?.kind!=='verified')?'closed':row.stage,
 updatedAt:row.updatedAt,diagnosis:row.diagnosis,intendedFixes:row.intendedFixes.map(pr=>({...pr,observation:row.prObservations.find(o=>o.repository===pr.repository&&o.number===pr.number)??null}))})
/** Bounded Mongo-only projection. Result lists never open history archives or call GitHub. */
export async function readCaseFollowUpSummaries(rootKeys:string[],rows:Pick<RoutineCaseRepository,'byRoots'>=routineCaseRepository,enabled=process.env.ROUTINE_CASE_API_ENABLED==='true'):Promise<Map<string,CaseFollowUpSummary>> {
 const out=new Map<string,CaseFollowUpSummary>();rootKeys=[...new Set(rootKeys)]
 if(!enabled||!rootKeys.length)return out
 for(let start=0;start<rootKeys.length;start+=100){for(const row of await rows.byRoots(rootKeys.slice(start,start+100))){
  const summary=compact(row);for(const occurrence of row.occurrences)if(rootKeys.includes(occurrence.rootKey))out.set(occurrence.rootKey,summary)}}
 return out
}
