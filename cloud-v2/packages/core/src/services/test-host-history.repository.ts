import {createHash} from 'node:crypto'
import {TestHostSampleModel} from '../models/test-host-health.model'
import {frameworkHistoryEntrySchema, type FrameworkHistoryEntry} from '../types/lane-restoration.types'
import {HOST_HISTORY_DAYS} from '../types/test-host-health.types'

export type HostDebugObservation = {hostId: string; incarnationGeneration: number; sequence: number;
  receivedAt: Date; payload: Record<string, unknown>}
export interface TestHostHistoryRepository {
  debug(observation: HostDebugObservation): Promise<void>
  detail(hostId: string): Promise<Record<string, unknown> | null>
}
const key = (value: unknown) => createHash('sha256').update(JSON.stringify(value) ?? 'undefined').digest('hex')
export function mergeHostDebugHistory(prior: Record<string, unknown>, incoming: Record<string, unknown>) {
  const merge = (field: string, identity: (value: any) => unknown, limit: number) => {
    const rows = new Map<unknown, unknown>()
    for (const value of [...(Array.isArray(prior[field]) ? prior[field] : []),
      ...(Array.isArray(incoming[field]) ? incoming[field] : [])]) rows.set(identity(value), value)
    return [...rows.values()].slice(-limit)
  }
  return {...prior, ...incoming,
    frameworkHistory: merge('frameworkHistory', value => value?.incarnation ?? key(value), 100),
    frameworkStopReceipts: merge('frameworkStopReceipts', key, 100),
    resourceHistory: merge('resourceHistory', value => value?.id ?? key(value), 200)}
}
/** Reuse the existing host sample history and TTL. Identical diagnostic bytes
 * have one sample identity; retries do not refresh its original receipt time.
 * This path never writes the health latest row or current ownership. */
export const testHostHistoryRepository: TestHostHistoryRepository = {
  async debug(observation) {
    const digest=key(observation.payload),sampleId=`framework-debug:${digest}`;
    try {
      await TestHostSampleModel.collection.updateOne({hostId: observation.hostId,sampleId},{$setOnInsert:{
        hostId:observation.hostId,sampleId,kind:'framework-debug',digest,payload:observation.payload,
        sampledAt:observation.receivedAt,receivedAt:observation.receivedAt,
        expiresAt:new Date(observation.receivedAt.getTime()+HOST_HISTORY_DAYS*86_400_000),
      }},{upsert:true,writeConcern:{w:'majority',j:true},timeoutMS:5000});
    } catch(error) {if((error as {code?:number}).code!==11000) throw error}
  },
  async detail(hostId) {
    const rows=await TestHostSampleModel.collection.find<{payload:Record<string,unknown>}>({hostId,kind:'framework-debug'},
      {projection:{payload:1,_id:0},readPreference:'primary',readConcern:{level:'majority'},timeoutMS:5000})
      .sort({sampledAt:-1,sampleId:-1}).hint('host_sample_history').limit(100).maxTimeMS(5000).toArray();
    return rows.length?rows.reverse().reduce((prior,row)=>mergeHostDebugHistory(prior,row.payload),{} as Record<string,unknown>):null
  },
}

/** One accepted current process identity, rather than an installation-history replay. */
export function currentAcceptedFramework(snapshot: {frameworkBinding?: FrameworkHistoryEntry['binding'];
  frameworkProcess?: FrameworkHistoryEntry['process']; frameworkAcceptedAt?: string; incarnation: string;
  incarnationGeneration: number; observedAt: string}) {
  return snapshot.frameworkBinding ? frameworkHistoryEntrySchema.parse({binding: snapshot.frameworkBinding,
    process: snapshot.frameworkProcess, effectiveAt: snapshot.frameworkAcceptedAt,
    incarnation: snapshot.incarnation, incarnationGeneration: snapshot.incarnationGeneration, observedAt: snapshot.observedAt}) : undefined
}
