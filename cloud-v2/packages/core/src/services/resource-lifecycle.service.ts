import {createHash} from 'node:crypto';
import {z} from 'zod';
import {hostResourceReservationsSchema,isExclusiveHostReservation,resourceReservationObservationSchema} from '../types/resource-reservations.types';
import {frameworkIdentitySchema} from '../types/framework-request.types';
import {TestHostStateModel} from '../models/test-host-state.model';
import {resourceLifecycleHistorySchema,resourceLifecycleCurrentSchema,type ResourceLifecycleList,type ResourceLifecycleCurrentList} from '../types/resource-lifecycle.types';
import {TestRunError} from './test-result-error';
import {testHostHistoryRepository} from './test-host-history.repository';
const FRESH_MS=180_000;
const newestFirst=(a:{at:string;id:string},b:{at:string;id:string})=>Date.parse(b.at)-Date.parse(a.at)||a.id.localeCompare(b.id);
const fleetEnrollmentSchema=z.object({resources:z.array(z.object({id:frameworkIdentitySchema,capabilities:z.array(frameworkIdentitySchema).optional()})).optional(),lanes:z.array(z.object({id:z.string(),resources:z.array(z.object({exclusiveDependencies:z.array(z.object({resourceId:z.string(),authorityHostId:z.string(),capability:z.string()})).optional()}))})).optional()});
export interface ResourceLifecycleRow {hostId:string;receivedAt:Date;snapshot:unknown;resourceReservationVersion?:number;resourceReservations?:unknown;resourceLifecycleCursor?:unknown}
export function projectResourceLifecycle(rows:ResourceLifecycleRow[],now=Date.now(),resourceId?:string):ResourceLifecycleCurrentList {
  const subjects:ResourceLifecycleCurrentList['subjects']=[];
  for(const row of rows.slice(0,100)) {
    const snapshot=row.snapshot as {hostId?:string;observedAt?:string;resourceLifecycle?:unknown};
    const cursor=row.resourceLifecycleCursor===undefined?undefined:resourceLifecycleCurrentSchema.parse(row.resourceLifecycleCursor);
    if(!snapshot.resourceLifecycle && !cursor) continue;
    const currentEnvelope=snapshot.resourceLifecycle===undefined?undefined:resourceLifecycleCurrentSchema.parse(snapshot.resourceLifecycle);
    for(const value of currentEnvelope?.subjects??[]) {
      const prior=cursor?.subjects.find(retained=>retained.subject.id===value.subject.id);
      if(prior&&value.generation<prior.generation) throw new TestRunError(503,'Resource subject generation regressed');
    }
    const reported=new Set(currentEnvelope?.subjects.map(value=>value.subject.id)??[]);
    const retained=cursor?.subjects.filter(value=>!reported.has(value.subject.id)).map(value=>({...value,current:false,status:'unknown' as const,supportedActions:[],reason:{code:'observation-omitted',message:'Authority omitted this resource from its current observation.'}}))??[];
    const parsed=resourceLifecycleCurrentSchema.safeParse({schemaVersion:1,subjects:[...currentEnvelope?.subjects??[],...retained]});
    if(!parsed.success || snapshot.hostId!==row.hostId || parsed.data.subjects.some(v=>v.subject.authorityHostId!==row.hostId))
      throw new TestRunError(503,'Invalid resource lifecycle observation');
    const receivedAt=row.receivedAt.toISOString(),observedAt=Date.parse(snapshot.observedAt??''),
      fresh=[observedAt,row.receivedAt.getTime()].every(time=>Number.isFinite(time)&&time<=now+5000&&now-time<=FRESH_MS);
    for(const value of parsed.data.subjects) {
      if(subjects.some(v=>v.subject.id===value.subject.id)) throw new TestRunError(503,'Conflicting resource authority observations');
      const at=value.observedAt ? Date.parse(value.observedAt):NaN;
      const current=value.current && Number.isFinite(at) && at<=observedAt && fresh;
      subjects.push({...value,receivedAt,current,status:current?value.status:'unknown',supportedActions:current?value.supportedActions:[],
        reason:current?value.reason:value.reason?.code==='observation-omitted' && fresh?value.reason:{code:'stale-observation',message:'Current resource state is unknown; a fresh authority observation is required.'}});
    }
  }
  projectFleetResourceAuthorities(rows.slice(0,100),subjects);
  return {generatedAt:new Date(now).toISOString(),subjects:subjects.filter(value=>!resourceId||value.subject.id===resourceId).sort((a,b)=>a.subject.id.localeCompare(b.subject.id)),truncated:rows.length>100};
}
export function validateResourceLifecycleAdvance(previousInput:unknown,nextInput:unknown) {
  const previous=resourceLifecycleCurrentSchema.parse(previousInput),next=resourceLifecycleCurrentSchema.parse(nextInput);
  for(const subject of next.subjects) {
    const old=previous.subjects.find(value=>value.subject.id===subject.subject.id);
    if(old && subject.generation<old.generation) throw new TestRunError(409,'Resource subject generation regressed');
  }
}
/** Current subject high-water marks stay in the existing host CAS. Debug event
 * identity and retention are independent of accepting a valid current report. */
export function advanceResourceLifecycleCursor(previousInput:unknown,nextInput:unknown) {
  const previous=previousInput===undefined?undefined:resourceLifecycleCurrentSchema.parse(previousInput);
  if(nextInput===undefined) return previous;
  const next=resourceLifecycleCurrentSchema.parse(nextInput);
  if(previous) validateResourceLifecycleAdvance(previous,next);
  const subjects=new Map(previous?.subjects.map(value=>[value.subject.id,value])??[]);
  for(const value of next.subjects) subjects.set(value.subject.id,value);
  if(subjects.size>200) throw new TestRunError(409,'Resource lifecycle cursor exceeds 200 retained subjects; explicit retirement is required');
  return resourceLifecycleCurrentSchema.parse({schemaVersion:1,subjects:[...subjects.values()]});
}
export class ResourceLifecycleService {
  async detail(resourceId:string) {
    if(!frameworkIdentitySchema.safeParse(resourceId).success) throw new TestRunError(400,'Invalid resource identity');
    const result=await this.list(resourceId),subject=result.subjects.find(value=>value.subject.id===resourceId);
    if(!subject) throw new TestRunError(404,'Resource observation not found');
    return {generatedAt:result.generatedAt,subject,coverage:'latest authority observation'};
  }
  async history(resourceId:string,cursor?:string) {
    if(!frameworkIdentitySchema.safeParse(resourceId).success || cursor!==undefined && !frameworkIdentitySchema.safeParse(cursor).success) throw new TestRunError(400,'Invalid resource history cursor');
    const rows=await this.readRows(resourceId),result=projectResourceLifecycle(rows,Date.now(),resourceId);
    const subject=result.subjects.find(value=>value.subject.id===resourceId);
    if(!subject) throw new TestRunError(404,'Resource observation not found');
    const debug=await testHostHistoryRepository.detail(subject.subject.authorityHostId);
    const history=new Map<string,ResourceLifecycleList['history'][number]>();
    for(const value of Array.isArray(debug?.resourceHistory)?debug.resourceHistory:[]) {
      const event=resourceLifecycleHistorySchema.safeParse(value);
      if(event.success&&event.data.resourceId===resourceId) history.set(event.data.id,event.data);
    }
    projectFleetResourceAuthorities(rows,result.subjects,history);
    const events=[...history.values()].filter(event=>event.resourceId===resourceId).sort(newestFirst);
    const index=cursor===undefined?-1:events.findIndex(event=>event.id===cursor);
    if(cursor!==undefined && index<0) throw new TestRunError(409,'Resource history cursor left the retained window');
    const offset=index+1,page=events.slice(offset,offset+50);
    return {resourceId,generatedAt:result.generatedAt,events:page,nextCursor:offset+50<events.length?page.at(-1)!.id:null,
      coverage:'separate diagnostic journal window; at most 200 events per host',truncated:result.truncated};
  }
  async list(resourceId?:string) {
    return projectResourceLifecycle(await this.readRows(resourceId),Date.now(),resourceId);
  }
  private async readRows(resourceId?:string) {
    const filter=resourceId?{$or:[
      {'snapshot.resourceLifecycle.subjects.subject.id':resourceId},
      {'snapshot.resources.id':resourceId},
      {'resourceLifecycleCursor.subjects.subject.id':resourceId},
      {'resourceReservations.resourceId':resourceId},
      {'snapshot.lanes.resources.exclusiveDependencies.resourceId':resourceId},
      {'snapshot.resourceReservations.returns.resourceId':resourceId},
    ]}:{};
    const projection={hostId:1,receivedAt:1,'snapshot.hostId':1,'snapshot.observedAt':1,
      'snapshot.resourceLifecycle.schemaVersion':1,'snapshot.resourceLifecycle.subjects':1,
      'resourceLifecycleCursor.schemaVersion':1,'resourceLifecycleCursor.subjects':1,
      'snapshot.resources':1,'snapshot.lanes.id':1,'snapshot.lanes.resources':1,
      ...(resourceId?{'snapshot.resourceReservations.claims':1,'snapshot.resourceReservations.returns':1}:{}),
      resourceReservationVersion:1,resourceReservations:1,_id:0};
    const rows=await TestHostStateModel.find(filter).select(projection)
      .sort({hostId:1}).limit(101).maxTimeMS(5000).read('primary').readConcern('majority').lean();
    if(resourceId && rows.length>100) throw new TestRunError(503,'Resource authority/history scope exceeds the bounded 100-host observation');
    const scopedRows=rows as ResourceLifecycleRow[];
    if(resourceId) {
      const authorities=new Set<string>();
      for(const row of scopedRows) {
        const enrollment=fleetEnrollmentSchema.parse(row.snapshot);
        for(const lane of enrollment.lanes??[]) for(const resource of lane.resources) for(const dependency of resource.exclusiveDependencies??[])
          if(dependency.resourceId===resourceId) authorities.add(frameworkIdentitySchema.parse(dependency.authorityHostId));
        for(const claim of hostResourceReservationsSchema.parse(row.resourceReservations??[]).filter(isExclusiveHostReservation))
          if(claim.resourceId===resourceId) authorities.add(claim.authorityHostId);
        const observation=(row.snapshot as {resourceReservations?:unknown}).resourceReservations;
        if(observation) for(const receipt of [...resourceReservationObservationSchema.parse(observation).claims,...resourceReservationObservationSchema.parse(observation).returns])
          if(receipt.resourceId===resourceId) authorities.add(receipt.authorityHostId);
      }
      const missing=[...authorities].filter(hostId=>!scopedRows.some(row=>row.hostId===hostId));
      if(scopedRows.length+missing.length>100) throw new TestRunError(503,'Resource authority/history scope exceeds the bounded 100-host observation');
      if(missing.length) {
        const anchors=await TestHostStateModel.find({hostId:{$in:missing}}).select(projection)
          .sort({hostId:1}).limit(101).maxTimeMS(5000).read('primary').readConcern('majority').lean();
        scopedRows.push(...anchors as ResourceLifecycleRow[]);
        if(scopedRows.length>100) throw new TestRunError(503,'Resource authority/history scope exceeds the bounded 100-host observation');
      }
    }
    return scopedRows;
  }
}

/** Derives fleet dependency visibility from the existing CAS authority; never grants capacity. */
function projectFleetResourceAuthorities(rows:ResourceLifecycleRow[],subjects:ResourceLifecycleList['subjects'],history?:Map<string,ResourceLifecycleList['history'][number]>) {
  const enrolled=new Map<string,{authorityHostId:string;capabilities:Set<string>}>();
  for(const row of rows) {
    const parsed=fleetEnrollmentSchema.safeParse(row.snapshot);if(!parsed.success) throw new TestRunError(503,'Invalid resource dependency observation');
    for(const resource of parsed.data.resources??[]) {
      const previous=enrolled.get(resource.id);
      if(previous&&previous.authorityHostId!==row.hostId) throw new TestRunError(503,'Conflicting canonical resource authority');
      const value=previous??{authorityHostId:row.hostId,capabilities:new Set<string>()};
      for(const capability of resource.capabilities??[])value.capabilities.add(capability);enrolled.set(resource.id,value);
    }
    for(const lane of parsed.data.lanes??[]) for(const resource of lane.resources) for(const dependency of resource.exclusiveDependencies??[]) {
      if(!frameworkIdentitySchema.safeParse(dependency.resourceId).success || !frameworkIdentitySchema.safeParse(dependency.authorityHostId).success) throw new TestRunError(503,'Unsafe canonical resource identity');
      const previous=enrolled.get(dependency.resourceId);
      if(previous && previous.authorityHostId!==dependency.authorityHostId) throw new TestRunError(503,'Conflicting canonical resource authority');
      const value=previous??{authorityHostId:dependency.authorityHostId,capabilities:new Set<string>()};value.capabilities.add(dependency.capability);enrolled.set(dependency.resourceId,value);
    }
  }
  for(const row of rows) for(const claim of hostResourceReservationsSchema.parse(row.resourceReservations??[]).filter(isExclusiveHostReservation)) {
    if(claim.authorityHostId!==row.hostId) throw new TestRunError(503,'Exclusive claim differs from canonical authority');
    const previous=enrolled.get(claim.resourceId);
    if(previous && previous.authorityHostId!==row.hostId) throw new TestRunError(503,'Conflicting canonical resource authority');
    if(!previous) enrolled.set(claim.resourceId,{authorityHostId:row.hostId,capabilities:new Set()});
  }
  for(const [resourceId,offer] of enrolled) {
    const authority=rows.find(row=>row.hostId===offer.authorityHostId);
    const claims=authority?hostResourceReservationsSchema.parse(authority.resourceReservations??[]).filter(isExclusiveHostReservation).filter(claim=>claim.resourceId===resourceId):[];
    if(claims.length>1) throw new TestRunError(503,'Conflicting canonical resource claims');
    const claim=claims[0],generation=authority?.resourceReservationVersion??0;
    const existing=subjects.findIndex(subject=>subject.subject.id===resourceId);
    if(existing>=0 && subjects[existing]!.subject.authorityHostId!==offer.authorityHostId) throw new TestRunError(503,'Conflicting canonical resource authority');
    if(claim || existing<0) {
      // A retained grant remains reserved even with a stale borrower. Freshness cannot release it.
      const value:ResourceLifecycleList['subjects'][number]={subject:{kind:'resource',id:resourceId,authorityHostId:offer.authorityHostId},generation,
        status:claim?'reserved':'unknown',current:!!claim,observedAt:claim?.reservedAt??null,receivedAt:authority?.receivedAt.toISOString()??null,
        reason:{code:claim?'retained-exclusive-claim':'not-commissioned',message:claim?'Exclusive custody is retained by the recorded borrower; execution activity and idle are not established.':'No commissioned idle check was reported for this fleet resource.'},
        owner:claim?{...claim.owner,generation:null,hostId:claim.borrowerHostId,laneId:claim.laneId}:null,
        idle:{contractVersion:'not-commissioned',outcome:'not-checked',checkedAt:null,acceptedCheck:null,qualifiedScope:{kind:'unqualified'},evidenceRefs:[]},
        repair:{configured:false,state:'none'},supportedActions:[],resource:{kind:'exclusive-dependency',capabilities:[...offer.capabilities],memberships:[],dependencies:[],placement:'fleet'}};
      if (existing >= 0 && subjects[existing]!.idle.report) value.idle.report = subjects[existing]!.idle.report;
      if ((claim?.prerequisite || claim?.resourceCheck) && existing >= 0) {
        const phone = subjects[existing]!;
        // The raw claim fences this installed phone. Preserve its real local generation and idle/repair semantics.
        Object.assign(value, {...phone, status: 'reserved', supportedActions: [],
          owner: phone.owner?.id === claim.owner.id && phone.owner.kind === claim.owner.kind ? phone.owner :
            {...claim.owner, generation: null, hostId: claim.borrowerHostId, laneId: claim.laneId},
          reason: claim.prerequisite ? {code: 'retained-backend-prerequisite', message: 'The original phone prerequisite claim remains retained until its resource-check return is accepted.'} :
            {code: 'retained-resource-check', message: 'The original resource check remains held until its return is accepted.'}});
      }
      if(existing>=0) subjects[existing]=value;else subjects.push(value);
    }
    if(claim && history) {
      const id=`claim:${claim.id}`;
      history.set(`${offer.authorityHostId}:${resourceId}:${id}`,{id,resourceId,subjectGeneration:null,at:claim.reservedAt,event:'reserved',ownerId:claim.owner.id,hostId:claim.borrowerHostId,laneId:claim.laneId});
    }
    if(history) for(const borrower of rows) {
      const snapshot=borrower.snapshot as {resourceReservations?:unknown};
      if(!snapshot.resourceReservations) continue;
      const observation=resourceReservationObservationSchema.parse(snapshot.resourceReservations);
      for(const receipt of observation.returns.filter(receipt=>receipt.resourceId===resourceId && receipt.authorityHostId===offer.authorityHostId)) {
        const id=`return:${createHash('sha256').update(`${receipt.claimId}:${receipt.release.eventId}`).digest('hex')}`;
        const original='kind' in receipt.release ? undefined : receipt.release.lineage.find(owner=>owner.id===receipt.originalOwner.id && owner.kind===receipt.originalOwner.kind);
        history.set(`${offer.authorityHostId}:${resourceId}:${id}`,{id,resourceId,subjectGeneration:'kind' in receipt.release?receipt.release.subjectGeneration:null,at:receipt.release.releasedAt,event:'return-reported',ownerId:receipt.originalOwner.id,...(original?{ownerGeneration:original.generation}:{}),...('kind' in receipt.release?{checkOperationId:receipt.release.operationId}:{}),hostId:borrower.hostId,laneId:receipt.laneId});
      }
    }
  }
}
