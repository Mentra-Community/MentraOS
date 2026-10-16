import {fleetExclusiveReservationSchema, fleetExclusiveExecutionBindingSchema, type FleetExclusiveReservation} from '../types/resource-reservations.types'
import {frameworkRequestInputSchema} from '../types/framework-request.types'
import {requestInputDigest, TestRequestConflict} from './test-request.service'
import type {z} from 'zod'

/** Keep the portable claim immutable; its later executable identity is a separate guarded receipt. */
export function fleetResourceExecutionBinding(reservation: FleetExclusiveReservation, requestId: string, hostId: string,
  intentSha256: string, input: z.infer<typeof frameworkRequestInputSchema>, executionInputSha256: string) {
  const selected = fleetExclusiveReservationSchema.parse(reservation), intent = selected.intent
  if (intent.owner.id !== requestId || intent.hostId !== hostId || intent.laneId !== input.laneId ||
    intent.resources.length !== input.resources.length || intent.resources.some(required =>
      !input.resources.some(value => value.id === required.id)))
    throw new TestRequestConflict('Executable resources contradict the original portable resource selection')
  const dependencies = new Map<string, {resourceId: string; authorityHostId: string; capability: string}>()
  for (const required of intent.resources) for (const dependency of input.resources.find(value => value.id === required.id)!
    .exclusiveDependencies?.filter(value => required.capabilities.includes(value.capability)) ?? []) {
    const previous = dependencies.get(dependency.resourceId)
    if (previous && previous.authorityHostId !== dependency.authorityHostId)
      throw new TestRequestConflict('Executable dependency changed its canonical authority')
    dependencies.set(dependency.resourceId, dependency)
  }
  const exact = [...dependencies.values()].sort((a, b) => a.authorityHostId.localeCompare(b.authorityHostId) || a.resourceId.localeCompare(b.resourceId))
  if (selected.intentSha256 !== requestInputDigest({...intent, controller: {incarnation: intent.controller.incarnation,
    generation: intent.controller.generation}, origin: selected.origin, dependencies: exact}) || selected.claims.length !== exact.length ||
    exact.some(value => !selected.claims.some(claim => claim.resourceId === value.resourceId && claim.authorityHostId === value.authorityHostId)))
    throw new TestRequestConflict('Executable dependency differs from the retained portable claim')
  if (executionInputSha256 !== requestInputDigest(input))
    throw new TestRequestConflict('Executable digest differs from its frozen input')
  return fleetExclusiveExecutionBindingSchema.parse({reservationSha256: requestInputDigest(selected), dispatchIntentSha256: intentSha256,
    executionInputSha256})
}
