import {expect, test} from 'bun:test'
import {randomUUID} from 'node:crypto'
import {fleetResourceExecutionBinding} from './fleet-resource-binding'
import {requestInputDigest} from './test-request.service'
import {frameworkRequestInputSchema} from '../types/framework-request.types'
import {fleetExclusiveReservationSchema} from '../types/resource-reservations.types'
import {testRoutineSource} from '../testing/framework-fixtures'

function fixture() {
  const dependency = {resourceId: 'conference-account', authorityHostId: 'mini', capability: 'google-authentication'},
    origin = {kind: 'fleet' as const, fleetInputSha256: 'f'.repeat(64)}, intent = {operationId: 'run:google', hostId: 'air1', laneId: 'mac',
      inputSha256: origin.fleetInputSha256, owner: {id: 'google', kind: 'run' as const}, controller: {incarnation: 'original', generation: 1, sequence: 7},
      resources: [{id: 'app', capabilities: []}, {id: 'fixture', capabilities: ['google-authentication']}]},
    intentSha256 = requestInputDigest({...intent, controller: {incarnation: 'original', generation: 1}, origin, dependencies: [dependency]}),
    reservation = fleetExclusiveReservationSchema.parse({origin, intent, intentSha256, claims: [{kind: 'exclusive', id: randomUUID(),
      resourceId: dependency.resourceId, authorityHostId: dependency.authorityHostId, borrowerHostId: 'air1', laneId: 'mac',
      inputSha256: origin.fleetInputSha256, intentSha256, owner: intent.owner, operationId: intent.operationId, origin,
      controllerIncarnation: 'original', controllerGeneration: 1, borrowerSequence: 7, reservedAt: new Date().toISOString()}]}),
    input = frameworkRequestInputSchema.parse({routineId: 'account-google', definitionRevision: 'a'.repeat(40), routineSource: testRoutineSource(),
      platform: 'ios-on-mac', laneId: 'mac', build: {repository: 'Mentra-Community/MentraOS', channel: 'dev', headSha: 'b'.repeat(40)},
      resources: [{id: 'app', kind: 'app'}, {id: 'fixture', kind: 'fixture-data', exclusiveDependencies: [dependency]}]})
  return {reservation, input, dependency}
}
test('executable mapping preserves the portable claim hash without inserting itself into executable input', () => {
  const {reservation, input} = fixture(), original = structuredClone(reservation), digest = requestInputDigest(input),
    binding = fleetResourceExecutionBinding(reservation, 'google', 'air1', 'd'.repeat(64), input, digest)
  expect(binding).toEqual({reservationSha256: requestInputDigest(reservation), executionInputSha256: digest, dispatchIntentSha256: 'd'.repeat(64)})
  expect(digest).not.toBe(reservation.origin.fleetInputSha256); expect(reservation).toEqual(original)
  expect(input).not.toHaveProperty('fleetExclusiveExecutionBinding')
})
test('different borrower, lane, selected fixture or authority cannot bind another portable winner', () => {
  const {reservation, input} = fixture(), digest = requestInputDigest(input)
  expect(() => fleetResourceExecutionBinding(reservation, 'google', 'air2', 'd'.repeat(64), input, digest)).toThrow('original portable')
  expect(() => fleetResourceExecutionBinding(reservation, 'google', 'air1', 'd'.repeat(64), {...input, laneId: 'other'}, digest)).toThrow('original portable')
  expect(() => fleetResourceExecutionBinding(reservation, 'google', 'air1', 'd'.repeat(64), {...input,
    resources: [{id: 'app', kind: 'app'}, {id: 'other-fixture', kind: 'fixture-data'}]}, digest)).toThrow('original portable')
  expect(() => fleetResourceExecutionBinding(reservation, 'google', 'air1', 'd'.repeat(64), {...input,
    resources: input.resources.map(resource => ({...resource, exclusiveDependencies: resource.exclusiveDependencies?.map(value => ({...value, authorityHostId: 'air2'}))}))}, digest))
    .toThrow('retained portable claim')
})
test('an executable mapping refuses an unrelated digest even when the original resource selection matches', () => {
  const {reservation, input} = fixture()
  expect(() => fleetResourceExecutionBinding(reservation, 'google', 'air1', 'd'.repeat(64), input, 'e'.repeat(64)))
    .toThrow('Executable digest differs from its frozen input')
})
