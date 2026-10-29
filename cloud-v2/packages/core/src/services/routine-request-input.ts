import {recordedFrameworkRequestInputSchema} from '../types/framework-request.types'
import {routineDispatchIntentSchema, type RoutineDispatchIntent} from '../types/routine-dispatch.types'
import {portableRoutineSelectionSchema, type PortableRoutineSelection, type StoredRoutineJob} from '../types/routine-job.types'
import {requestInputDigest, type StoredRequest} from './test-request.service'
import {TestRunError} from './test-result-error'

type AcceptedInput = ReturnType<typeof recordedFrameworkRequestInputSchema.parse>
type ReadInput = {selection?: PortableRoutineSelection} & (
 {ready: false; input: PortableRoutineSelection | RoutineDispatchIntent} | {ready: true; input: AcceptedInput})

/** Recorded app-only projections may omit optional glasses software, never change app artifact identity. */
export function recordedBuildMatchesIntent(recorded: AcceptedInput['build'], selected: AcceptedInput['build']): boolean {
 const {manifest: recordedManifest, manifestSha256: recordedManifestSha256, ...recordedApp} = recorded
 const {manifest: selectedManifest, manifestSha256: selectedManifestSha256, ...selectedApp} = selected
 return requestInputDigest(recordedApp) === requestInputDigest(selectedApp)
  && (recordedManifest === undefined || requestInputDigest(recordedManifest) === requestInputDigest(selectedManifest ?? null))
  && (recordedManifestSha256 === undefined || recordedManifestSha256 === selectedManifestSha256)
}

/** Follow the retained selection → binding → executable input chain, including source prepared after submission. */
export function readAcceptedRoutineRequest(row: StoredRequest | StoredRoutineJob): ReadInput {
 const job = row as StoredRoutineJob, request = row as StoredRequest
 let selection: PortableRoutineSelection | undefined, intent: RoutineDispatchIntent | undefined
 if (job.fleetSelection !== undefined) {
  const parsed = portableRoutineSelectionSchema.safeParse(job.fleetSelection)
  if (!parsed.success || requestInputDigest(parsed.data) !== job.fleetSelectionSha256)
   throw new TestRunError(503, 'Rerun request differs from its frozen selection')
  selection = parsed.data
  if (!job.fleetBinding) {
   if (request.input !== undefined || request.inputSha256 !== undefined) throw new TestRunError(503, 'Rerun binding provenance is unavailable')
   return {ready: false, input: selection, selection}
  }
  const bound = routineDispatchIntentSchema.safeParse(job.dispatchIntent)
  if (!bound.success || requestInputDigest(bound.data) !== job.dispatchIntentSha256 || request.hostId !== job.fleetBinding.hostId || bound.data.laneId !== job.fleetBinding.laneId)
   throw new TestRunError(503, 'Rerun binding provenance is unavailable')
  const {laneId: _lane, routineSource: boundSource, ...boundSelection} = bound.data
  const {routineSource: frozenSource, ...expectedSelection} = selection
  if (requestInputDigest(boundSelection) !== requestInputDigest(expectedSelection) || frozenSource && requestInputDigest(boundSource ?? null) !== requestInputDigest(frozenSource)
   || job.fleetPreparation && requestInputDigest(boundSource ?? null) !== requestInputDigest(job.fleetPreparation.routineSource))
   throw new TestRunError(503, 'Rerun binding differs from its frozen selection')
  intent = bound.data
 } else if (request.dispatchIntent !== undefined) {
  const parsed = routineDispatchIntentSchema.safeParse(request.dispatchIntent)
  if (!parsed.success || requestInputDigest(parsed.data) !== request.dispatchIntentSha256)
   throw new TestRunError(503, 'Rerun preparation provenance is unavailable')
  intent = parsed.data
 }
 if (request.input === undefined || request.inputSha256 === undefined) {
  if (!intent || request.input !== undefined || request.inputSha256 !== undefined) throw new TestRunError(503, 'Rerun preparation provenance is unavailable')
  return {ready: false, input: intent, ...(selection ? {selection} : {})}
 }
 const parsed = recordedFrameworkRequestInputSchema.safeParse(request.input)
 if (!parsed.success || requestInputDigest(parsed.data) !== request.inputSha256 || intent &&
  (parsed.data.routineId !== intent.routineId || parsed.data.platform !== intent.platform || parsed.data.definitionRevision !== intent.routineRevision || parsed.data.laneId !== intent.laneId
   || parsed.data.minimumFrameworkVersion !== intent.minimumFrameworkVersion || intent.routineSource && requestInputDigest(parsed.data.routineSource ?? null) !== requestInputDigest(intent.routineSource)
   || !recordedBuildMatchesIntent(parsed.data.build, intent.build)))
  throw new TestRunError(503, 'Rerun request differs from its frozen input')
 return {ready: true, input: parsed.data, ...(selection ? {selection} : {})}
}
