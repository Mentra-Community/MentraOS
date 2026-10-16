import {frameworkIdentitySchema} from '../types/framework-request.types';
import {TestHostStateModel} from '../models/test-host-state.model';
import {resourceLifecycleSchema,type ResourceLifecycleList} from '../types/resource-lifecycle.types';
import {TestRunError} from './test-result-error';
const FRESH_MS=180_000;
export interface ResourceLifecycleRow {hostId:string;receivedAt:Date;snapshot:unknown}
export function projectResourceLifecycle(rows:ResourceLifecycleRow[],now=Date.now()):ResourceLifecycleList {
  const subjects:ResourceLifecycleList['subjects']=[],history=new Map<string,ResourceLifecycleList['history'][number]>();
  for(const row of rows.slice(0,100)) {
    const snapshot=row.snapshot as {hostId?:string;resourceLifecycle?:unknown};
    if(!snapshot.resourceLifecycle) continue;
    const parsed=resourceLifecycleSchema.safeParse(snapshot.resourceLifecycle);
    if(!parsed.success || snapshot.hostId!==row.hostId || parsed.data.subjects.some(v=>v.subject.authorityHostId!==row.hostId))
      throw new TestRunError(503,'Invalid resource lifecycle observation');
    const receivedAt=row.receivedAt.toISOString();
    for(const value of parsed.data.subjects) {
      if(subjects.some(v=>v.subject.id===value.subject.id)) throw new TestRunError(503,'Conflicting resource authority observations');
      const at=value.observedAt ? Date.parse(value.observedAt):NaN;
      const current=value.current && Number.isFinite(at) && at<=now+5000 && now-at<=FRESH_MS && row.receivedAt.getTime()<=now+5000 && now-row.receivedAt.getTime()<=FRESH_MS;
      subjects.push({...value,receivedAt,current,status:current?value.status:'unknown',supportedActions:current?value.supportedActions:[],
        reason:current?value.reason:{code:'stale-observation',message:'Current resource state is unknown; a fresh authority observation is required.'}});
    }
    for(const event of parsed.data.history) {
      const key=`${row.hostId}:${event.resourceId}:${event.id}`;
      const old=history.get(key);
      if(old && JSON.stringify(old)!==JSON.stringify(event)) throw new TestRunError(503,'Conflicting resource history identity');
      history.set(key,event);
    }
  }
  return {generatedAt:new Date(now).toISOString(),subjects:subjects.sort((a,b)=>a.subject.id.localeCompare(b.subject.id)),
    history:[...history.values()].sort((a,b)=>b.at.localeCompare(a.at)).slice(0,2000),truncated:rows.length>100 || history.size>2000};
}
export function validateResourceLifecycleAdvance(previousInput:unknown,nextInput:unknown) {
  const previous=resourceLifecycleSchema.parse(previousInput),next=resourceLifecycleSchema.parse(nextInput);
  for(const subject of next.subjects) {
    const old=previous.subjects.find(value=>value.subject.id===subject.subject.id);
    if(old && subject.generation<old.generation) throw new TestRunError(409,'Resource subject generation regressed');
  }
  for(const event of next.history) {
    const old=previous.history.find(value=>value.id===event.id);
    if(old && JSON.stringify(old)!==JSON.stringify(event)) throw new TestRunError(409,'Resource history identity is immutable');
  }
}
export class ResourceLifecycleService {
  async detail(resourceId:string) {
    if(!frameworkIdentitySchema.safeParse(resourceId).success) throw new TestRunError(400,'Invalid resource identity');
    const result=await this.list(),subject=result.subjects.find(value=>value.subject.id===resourceId);
    if(!subject) throw new TestRunError(404,'Resource observation not found');
    return {generatedAt:result.generatedAt,subject,coverage:'latest authority observation'};
  }
  async history(resourceId:string,cursor?:string) {
    if(!frameworkIdentitySchema.safeParse(resourceId).success || cursor!==undefined && !frameworkIdentitySchema.safeParse(cursor).success) throw new TestRunError(400,'Invalid resource history cursor');
    const result=await this.list();
    if(!result.subjects.some(value=>value.subject.id===resourceId)) throw new TestRunError(404,'Resource observation not found');
    const events=result.history.filter(value=>value.resourceId===resourceId);
    const index=cursor===undefined?-1:events.findIndex(event=>event.id===cursor);
    if(cursor!==undefined && index<0) throw new TestRunError(409,'Resource history cursor left the retained window');
    const offset=index+1,page=events.slice(offset,offset+50);
    return {resourceId,generatedAt:result.generatedAt,events:page,nextCursor:offset+50<events.length?page.at(-1)!.id:null,
      coverage:'retained authority journal window; at most 200 events per host',truncated:result.truncated};
  }
  async list() {
    const rows=await TestHostStateModel.find({}).select({hostId:1,receivedAt:1,'snapshot.hostId':1,'snapshot.resourceLifecycle':1,_id:0})
      .sort({hostId:1}).limit(101).maxTimeMS(5000).read('primary').readConcern('majority').lean();
    return projectResourceLifecycle(rows as ResourceLifecycleRow[]);
  }
}
