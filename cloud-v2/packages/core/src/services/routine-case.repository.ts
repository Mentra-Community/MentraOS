import {RoutineCaseActivityModel, RoutineCaseModel, ensureRoutineCaseIndexes} from '../models/routine-case.model'
import {withTransaction} from '../connections/mongo.connection'
import {routineCaseSchema, type CaseActivity, type RoutineCase} from '../types/routine-case.types'
import {TestRunError} from './test-result-error'

export interface CaseWriteFence {owner: string; tokenSha256: string; generation: number; branchKey: string; anchorRunId: string; now: number; allowExpired?: boolean}
export interface RoutineCaseRepository {
  get(id: string): Promise<RoutineCase | null>
  byRoots(keys: string[], deadline?: number): Promise<RoutineCase[]>
  operation(id: string): Promise<CaseActivity | null>
  activity(id: string, before: number, limit: number): Promise<CaseActivity[]>
  commit(previous: RoutineCase | null, next: RoutineCase, event: CaseActivity, fence?: CaseWriteFence): Promise<boolean>
}
const read = (row: {payload?: unknown; revision?: unknown; generation?: unknown} | null) => {
  if (!row) return null
  const parsed = routineCaseSchema.safeParse(row.payload)
  if (!parsed.success || row.revision !== parsed.data.revision || row.generation !== parsed.data.generation)
    throw new TestRunError(503, 'Canonical case conversion is incomplete; no competing writer is enabled')
  return parsed.data
}
export const routineCaseRepository: RoutineCaseRepository = {
  async get(caseId) {return read(await RoutineCaseModel.findOne({caseId}).read('primary').readConcern('majority')
    .setOptions({maxTimeMS: 5000}).lean())},
  async byRoots(rootKeys, deadline = Date.now() + 5000) {
    if (rootKeys.length > 100) throw new TestRunError(400, 'Too many original occurrences')
    const timeoutMS = deadline - Date.now()
    if (timeoutMS <= 0) throw new TestRunError(503, 'Canonical case projection deadline elapsed')
    return (await RoutineCaseModel.find({rootKeys: {$in: rootKeys}}).limit(100).read('primary').readConcern('majority')
      .setOptions({timeoutMS, maxTimeMS: timeoutMS}).lean()).map(row => read(row)!)
  },
  async operation(mutationId) {return await RoutineCaseActivityModel.findOne({mutationId}).select({_id: 0})
    .read('primary').readConcern('majority').setOptions({maxTimeMS: 5000}).lean() as CaseActivity | null},
  async activity(caseId, before, limit) {return await RoutineCaseActivityModel.find({caseId, revision: {$lt: before}})
    .sort({revision: -1}).limit(limit).select({_id: 0}).read('primary').readConcern('majority')
    .setOptions({maxTimeMS: 5000}).lean() as CaseActivity[]},
  async commit(previous, next, event, fence) {
    try {await ensureRoutineCaseIndexes()} catch {throw new TestRunError(503, 'Canonical case authority indexes are not ready; no case write was accepted')}
    return withTransaction(async session => {
      if (await RoutineCaseActivityModel.findOne({mutationId: event.mutationId}).session(session).lean()) return false
      const values = {version: 2, generation: next.generation, rootKeys: next.occurrences.map(o => o.rootKey), payload: next}
      if (previous) {
        const update = await RoutineCaseModel.updateOne({caseId: previous.caseId, revision: previous.revision, generation: previous.generation, ...(fence ? {
            'payload.claim.owner': fence.owner, 'payload.claim.tokenSha256': fence.tokenSha256, 'payload.claim.generation': fence.generation,
            'payload.claim.branchKey': fence.branchKey, 'payload.claim.anchorRunId': fence.anchorRunId,
            ...(!fence.allowExpired ? {'payload.claim.state': 'running', 'payload.claim.expiresAt': {$gt: new Date(fence.now).toISOString()}} : {}),
          } : {})},
          {$set: {...values, revision: next.revision}}, {session, maxTimeMS: 5000})
        if (update.matchedCount !== 1) return false
      } else await RoutineCaseModel.create([{caseId: next.caseId, revision: next.revision, ...values}], {session})
      await RoutineCaseActivityModel.create([event], {session})
      return true
    })
  },
}
