import {z} from 'zod';
import {frameworkIdentitySchema as id} from './framework-request.types';
const timestamp = z.string().datetime({offset:true});
const generation = z.number().int().nonnegative().safe();
export const qualifiedScopeSchema = z.discriminatedUnion('kind', [
  z.object({kind:z.literal('unqualified')}).strict(),
  z.object({kind:z.literal('same-controller'),controllerId:id}).strict(),
  z.object({kind:z.literal('controllers'),controllerIds:z.array(id).min(1).max(30)}).strict(),
  z.object({kind:z.literal('fleet')}).strict(),
]);
export const resourceIdleContractSchema=z.object({version:id,maximumAgeMs:z.number().int().positive().safe().max(86_400_000),
  qualifiedScope:qualifiedScopeSchema,conditions:z.array(id).min(1).max(50),repairConfigured:z.boolean(),dependencies:z.array(id).max(8).optional()})
  .strict().refine(value=>new Set(value.conditions).size===value.conditions.length,'Idle conditions must be unique');
export const resourceLifecycleSubjectSchema = z.object({
  subject:z.object({kind:z.literal('resource'),id,authorityHostId:id}).strict(),
  generation,
  status:z.enum(['idle','reserved','active','returning','checking','in-repair','out-of-service','offline','unknown']),
  observedAt:timestamp.nullable(),receivedAt:timestamp.nullable(),current:z.boolean(),
  reason:z.object({code:id,message:z.string().min(1).max(2000)}).strict().nullable(),
  owner:z.object({id,kind:z.enum(['run','authoring','boundary-cleanup','fixer']),generation:generation.nullable(),hostId:id,laneId:id.optional(),requestId:id.optional()}).strict().nullable(),
  idle:z.object({contractVersion:id,outcome:z.enum(['passed','failed','unknown','not-checked']),checkedAt:timestamp.nullable(),
    acceptedCheck:z.object({operationId:id,subjectGeneration:generation,resultSha256:z.string().regex(/^[a-f0-9]{64}$/),acceptedAt:timestamp}).strict().nullable(),
    qualifiedScope:qualifiedScopeSchema,evidenceRefs:z.array(id).max(100)}).strict(),
  repair:z.object({configured:z.boolean(),state:z.enum(['none','queued','running','needs-input','halted']),interruptionId:id.optional(),executionId:id.optional()}).strict(),
  supportedActions:z.array(z.enum(['check','repair','retry-repair','stop-repair','mark-out-of-service'])).max(5),
  resource:z.object({kind:id,capabilities:z.array(id).max(30),memberships:z.array(z.object({hostId:id,laneId:id}).strict()).max(100),dependencies:z.array(id).max(100),placement:z.enum(['installed','fleet'])}).strict(),
}).strict().superRefine((value,ctx)=>{
  if(value.owner?.generation===null && value.supportedActions.length) ctx.addIssue({code:'custom',message:'Unknown owner generation cannot enable actions'});
  if(value.status==='idle' && (value.owner!==null || value.idle.outcome!=='passed' || value.idle.acceptedCheck?.subjectGeneration!==value.generation || value.idle.qualifiedScope.kind==='unqualified'))
    ctx.addIssue({code:'custom',message:'Idle requires unowned accepted generation-bound qualification'});
});
export const resourceLifecycleHistorySchema=z.object({id,resourceId:id,subjectGeneration:generation.nullable(),at:timestamp,event:id,ownerId:id.optional(),ownerGeneration:generation.optional(),hostId:id.optional(),laneId:id.optional(),reasonCode:id.optional()}).strict();
export const resourceLifecycleSchema=z.object({schemaVersion:z.literal(1),subjects:z.array(resourceLifecycleSubjectSchema).max(200),history:z.array(resourceLifecycleHistorySchema).max(200)}).strict().superRefine((value,ctx)=>{
  if(new Set(value.subjects.map(v=>v.subject.id)).size!==value.subjects.length || new Set(value.history.map(v=>v.id)).size!==value.history.length)
    ctx.addIssue({code:'custom',message:'Duplicate resource lifecycle identity'});
  for(const event of value.history) {
    const subject=value.subjects.find(subject=>subject.subject.id===event.resourceId);
    if(!subject || event.subjectGeneration!==null && event.subjectGeneration>subject.generation)
      ctx.addIssue({code:'custom',message:'History must identify an enrolled resource and accepted generation'});
  }
});
export type ResourceLifecycleSubject=z.infer<typeof resourceLifecycleSubjectSchema>;
export type ResourceLifecycleHistory=z.infer<typeof resourceLifecycleHistorySchema>;
export interface ResourceLifecycleList {generatedAt:string;subjects:ResourceLifecycleSubject[];history:ResourceLifecycleHistory[];truncated:boolean}
