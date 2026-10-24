import {expect, test} from 'bun:test'
import {testBuildSourceSchema, selectedBuildInput, type TestBuild} from './test-build.types'
import {routinePreparedBuildSchema} from './routine-dispatch.types'
import {routineWorkBuildSchema} from './routine-work.types'

const headSha = 'a'.repeat(40), sha256 = 'b'.repeat(64)
const source = {channel: 'pr' as const, prNumber: 12, buildRunId: 44, publicationAttempt: 1}
const asset = {url: 'https://artifactscdn.mentraglass.com/app.apk', sha256, size: 10}
const build = {repository: 'Mentra-Community/MentraOS', kind: 'android-apk', channel: 'pr', prNumber: 12, headSha,
 source, archive: {...asset, name: 'app.apk'}, receipt: asset}

test('app source schemas preserve omitted legacy identities and require matching frozen build repositories', () => {
 expect(testBuildSourceSchema.parse(source)).toEqual(source)
 expect(routinePreparedBuildSchema.safeParse(build).success).toBe(true)
 expect(routineWorkBuildSchema.safeParse(build).success).toBe(true)
 const canonical = {...build, repository: 'Mentra-Community/Mentra', source: {...source, repository: 'Mentra-Community/Mentra'}}
 expect(routinePreparedBuildSchema.safeParse(canonical).success).toBe(true)
 expect(routineWorkBuildSchema.safeParse(canonical).success).toBe(true)
 for (const wrong of [{...canonical, source}, {...build, source: canonical.source}, {...canonical, repository: 'other/Mentra'}]) {
  expect(routinePreparedBuildSchema.safeParse(wrong).success).toBe(false)
  expect(routineWorkBuildSchema.safeParse(wrong).success).toBe(false)
 }
 const selected: TestBuild = {source: canonical.source as any, title: 'Current PR', headSha, buildUrl: 'https://github.com/Mentra-Community/Mentra/actions/runs/44',
  createdAt: '2026-10-24T00:00:00Z', availability: 'available', archive: build.archive, receipt: build.receipt}
 expect(selectedBuildInput(selected, 'android').repository).toBe('Mentra-Community/Mentra')
 expect(selectedBuildInput({...selected, source}, 'android').repository).toBe('Mentra-Community/MentraOS')
})
