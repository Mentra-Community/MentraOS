import {expect, test} from 'bun:test'
import {testRoutineSource} from '../testing/framework-fixtures'
import {frameworkRequestInputSchema} from '../types/framework-request.types'
import {nightlyPreparedInput} from './nightly-routine.service'
import {readAcceptedRoutineRequest} from './routine-request-input'
import {requestInputDigest, type StoredTestRequest} from './test-request.service'

function recorded() {
 const source = {channel: 'dev' as const, buildRunId: 123, publicationAttempt: 1}
 const manifest = {url: 'https://artifactscdn.mentraglass.com/live/manifest.json', sha256: 'f'.repeat(64), size: 100}
 const build = {repository: 'Mentra-Community/MentraOS' as const, channel: 'dev' as const, headSha: 'b'.repeat(40), kind: 'android-apk' as const, source,
  archive: {name: 'app.apk', url: 'https://artifactscdn.mentraglass.com/app.apk', size: 100, sha256: 'c'.repeat(64)},
  receipt: {url: 'https://artifactscdn.mentraglass.com/receipt', size: 10, sha256: 'd'.repeat(64)}}
 const routineSource = {...testRoutineSource(), minimumRoutineApiVersion: 43}
 const input = {routineId: 'retired-connection', platform: 'android' as const, routineSource, definitionRevision: routineSource.commit,
  laneId: 'original-android', resources: [{id: 'original-glasses', kind: 'glasses' as const}], glassesModel: 'nimo', build}
 const intent = {requestId: 'recorded-request', routineId: input.routineId, platform: input.platform, routineRevision: input.definitionRevision,
  routineSource, laneId: input.laneId, source, build: structuredClone({...build, manifest, manifestSha256: manifest.sha256})}
 const row: StoredTestRequest = {requestId: intent.requestId, hostId: 'original-host', state: 'terminal', terminalStatus: 'not-run',
  dispatchIntent: intent, dispatchIntentSha256: requestInputDigest(intent), input, inputSha256: requestInputDigest(input)}
 const member = {memberId: 'recorded-member', requestId: row.requestId, routineId: input.routineId, platform: input.platform,
  routineRevision: input.definitionRevision, definitionRevision: input.definitionRevision, hostId: row.hostId,
  build: structuredClone(intent.build), dispatchIntent: structuredClone(intent)}
 return {row, input, intent, member}
}

test('intent-bound historical readers preserve both immutable digests and the original app-only projection', () => {
 const {row, input, member} = recorded(), before = JSON.stringify(row)
 expect(readAcceptedRoutineRequest(row)).toEqual({ready: true, input})
 expect(nightlyPreparedInput(member, row.input, row.inputSha256)).toEqual(input)
 expect(JSON.stringify(row)).toBe(before)
 expect(requestInputDigest(row.input)).toBe(row.inputSha256)
 expect(row.dispatchIntentSha256).toBe(requestInputDigest(row.dispatchIntent))
 expect(frameworkRequestInputSchema.safeParse(input).success).toBe(false)
})

test('recorded readers refuse changed digests, app fields, source and malformed known fields', () => {
 for (const change of ['input-digest', 'intent-digest', 'input-archive', 'missing-receipt', 'intent-archive', 'source', 'platform', 'manifest'] as const) {
  const {row, input, intent, member} = recorded()
  if (change === 'input-digest') row.inputSha256 = '0'.repeat(64)
  if (change === 'intent-digest') row.dispatchIntentSha256 = '0'.repeat(64)
  if (change === 'input-archive') input.build.archive.sha256 = '9'.repeat(64)
  if (change === 'missing-receipt') delete (input.build as {receipt?: unknown}).receipt
  if (change === 'intent-archive') intent.build = {...intent.build, archive: {...intent.build.archive, sha256: '9'.repeat(64)}}
  if (change === 'source') input.routineSource = {...input.routineSource, commit: '9'.repeat(40)}
  if (change === 'platform') (input as {platform: string}).platform = 'unknown'
  if (change === 'manifest') row.input = {...input, build: {...input.build, manifest: {...intent.build.manifest, sha256: '9'.repeat(64)}}}
  if (change !== 'input-digest') row.inputSha256 = requestInputDigest(row.input)
  if (change !== 'intent-digest') row.dispatchIntentSha256 = requestInputDigest(row.dispatchIntent)
  expect(() => readAcceptedRoutineRequest(row)).toThrow(/provenance|frozen input/)
  // Request-level intent changes are checked above; the nightly projection receives its separate frozen member intent.
  if (change !== 'intent-digest' && change !== 'intent-archive')
   expect(() => nightlyPreparedInput(member, row.input, row.inputSha256)).toThrow('frozen input')
 }
})

test('new admission still requires exact Live software while recorded full-build projections remain truthful', () => {
 const {row, input, intent, member} = recorded(), {glassesModel: _retired, ...current} = input
 const software = {model: 'mentra-live' as const, manifest: intent.build.manifest}
 const live = {...current, build: intent.build, glassesStart: software, glassesReturn: software}
 expect(frameworkRequestInputSchema.safeParse(live).success).toBe(true)
 expect(frameworkRequestInputSchema.safeParse(current).success).toBe(false)
 expect(frameworkRequestInputSchema.safeParse({...live, glassesModel: 'nimo'}).success).toBe(false)
 row.input = live; row.inputSha256 = requestInputDigest(live)
 expect(readAcceptedRoutineRequest(row)).toEqual({ready: true, input: live})
 expect(nightlyPreparedInput(member, live, row.inputSha256)).toEqual(live)
})
