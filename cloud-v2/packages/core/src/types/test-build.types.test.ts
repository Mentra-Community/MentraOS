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

test('canonical releases freeze producer and exported artifact identities separately', () => {
 const artifactSource = {repository: 'Mentra-Community/MentraOS' as const, headSha: 'c'.repeat(40)}
 const selected: TestBuild = {source: {channel: 'dev', repository: 'Mentra-Community/Mentra', buildRunId: 44, publicationAttempt: 1},
  title: 'Published release', headSha, artifactSource, buildUrl: 'https://github.com/Mentra-Community/Mentra/actions/runs/44',
  createdAt: '2026-10-24T00:00:00Z', availability: 'available', release: '3.4.0-dev.1097', archive: build.archive, receipt: build.receipt}
 const frozen = selectedBuildInput(selected, 'android')
 expect(frozen).toMatchObject({repository: 'Mentra-Community/Mentra', headSha, artifactSource, source: selected.source})
 expect(routinePreparedBuildSchema.safeParse(frozen).success).toBe(true)
 expect(() => selectedBuildInput({...selected, artifactSource: undefined}, 'android')).toThrow('verified exported artifact source')
 for (const source of [{...selected.source, repository: 'Mentra-Community/MentraOS' as const},
  {channel: 'pr' as const, repository: 'Mentra-Community/Mentra' as const, prNumber: 12, buildRunId: 44, publicationAttempt: 1}]) {
  expect(() => selectedBuildInput({...selected, source}, 'android')).toThrow('canonical coordinated release')
  expect(routinePreparedBuildSchema.safeParse({...frozen, repository: source.repository, channel: source.channel, source,
   ...(source.channel === 'pr' ? {prNumber: 12} : {})}).success).toBe(false)
 }
 for (const artifactSource of [{repository: 'other/repo', headSha}, {repository: 'Mentra-Community/MentraOS', headSha: 'wrong'},
  {repository: 'Mentra-Community/MentraOS', headSha, extra: true}]) {
  expect(() => selectedBuildInput({...selected, artifactSource: artifactSource as any}, 'android')).toThrow()
  expect(routinePreparedBuildSchema.safeParse({...frozen, artifactSource}).success).toBe(false)
 }
})
