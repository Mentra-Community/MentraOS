import {expect, test} from 'bun:test'
import {compactPrRerunLabel, parsePrRerunLabel, matchesLabelReference} from '../types/pr-rerun-label.types'
import {PrRerunReferenceService} from './pr-rerun-reference.service'

function fixture() {
  const suites = ['nightly-cabef2aaa', 'nightly-cabef2bbb'], requests = ['original', 'successor']
  const members = [{memberId: 'member', requestId: 'original', routineId: 'gallery-sync-android', platform: 'android', status: 'failed'}]
  const service = new PrRerunReferenceService({async suites(ref) {return suites.filter(id => matchesLabelReference(ref, id))},
    async requests(ref) {return requests.filter(id => matchesLabelReference(ref, id))}}, {
    async lineage(id) {return id === 'successor' ? {lineage: {parent: {suiteId: suites[0]!}, memberId: 'member', rerunId: 'batch', predecessorAttemptId: 'original'}} : {lineage: null, original: null}},
    async originalMembers() {return members},
  })
  return {service, members, suites, requests}
}
test('suite prefix must be unique and routine must identify one original occurrence', async () => {
  const f = fixture()
  await expect(f.service.resolve('rerun:gallery-sync-android:s:nightly-cabef2~')).rejects.toThrow('ambiguous')
  const resolved = await f.service.resolve('rerun:gallery-sync-android:s:nightly-cabef2aaa')
  expect(resolved.target).toMatchObject({parent: {suiteId: 'nightly-cabef2aaa'}, memberId: 'member', originalRequestId: 'original'})
  f.members.push({...f.members[0]!, memberId: 'second'})
  await expect(f.service.resolve('rerun:gallery-sync-android:s:nightly-cabef2aaa')).rejects.toThrow('several occurrences')
})
test('successor run reference preserves the suite lineage, without a standalone fork', async () => {
  const f = fixture(), resolved = await f.service.resolve('rerun:gallery-sync-android:r:successor')
  expect(resolved.target).toMatchObject({parent: {suiteId: 'nightly-cabef2aaa'}, memberId: 'member', requestedRunId: 'successor'})
  f.members[0]!.status = 'running'
  await expect(f.service.resolve('rerun:gallery-sync-android:r:successor')).rejects.toThrow('still active')
})
test('exact references never silently become prefixes and invalid labels fail visibly', () => {
  expect(matchesLabelReference(parsePrRerunLabel('rerun:gallery:r:original').target, 'original-extra')).toBe(false)
  for (const label of ['rerun:gallery', 'rerun:gallery:x:original', 'rerun:gallery:r:bad value', 'rerun:a:r:' + 'a'.repeat(45)])
    expect(() => parsePrRerunLabel(label)).toThrow()
})
test('all current and longest legal routine identities copy within GitHub label budget', () => {
  const target = 'nightly-cabef2aab12027cd84d666bf640281af-member-' + 'a'.repeat(40)
  for (const routine of ['ota-roundtrip-android', 'gallery-sync-android', 'a'.repeat(120)]) {
    const label = compactPrRerunLabel(routine, 'r', target)
    expect(label.length).toBeLessThanOrEqual(50)
    const parsed = parsePrRerunLabel(label)
    expect(matchesLabelReference(parsed.routine, routine)).toBe(true)
    expect(matchesLabelReference(parsed.target, target)).toBe(true)
    expect(parsed.target.prefix).toBe(true)
  }
})
test('copy lengthens existing ID prefix until it resolves uniquely', async () => {
  const f = fixture(), copied = await f.service.copy('gallery-sync-android', 's', f.suites[0]!)
  expect(copied.label.length).toBeLessThanOrEqual(50)
  expect((await f.service.resolve(copied.label)).target.parent).toEqual({suiteId: f.suites[0]!})
})

test('short original identities also copy and an unrepresentable ambiguity fails without guessing', async () => {
  const f = fixture();f.members[0]!.routineId='gallery';f.members[0]!.memberId='original'
  expect((await f.service.copy('gallery','r','original')).label).toBe('rerun:gallery:r:original')
})
