import {expect, test} from 'bun:test'
import {testRoutineSource} from "../testing/framework-fixtures"
import {CandidateVerificationService, type CandidateWorkRecord} from './candidate-verification.service'
import {authoringWorkSchema} from '../types/routine-work.types'
import {frameworkExecutableBuild} from '../types/framework-request.types'
import {requestInputDigest, TestRequestService, type StoredTestRequest, type TestRequestRepository} from './test-request.service'

const sourceRevision = 'c'.repeat(40)
const work = authoringWorkSchema.parse({schemaVersion: 1, workId: 'work:edit', kind: 'edit', routineId: 'notes',
  brief: {goal: 'Edit notes', stepsOrChanges: ['Open notes'], expected: ['Notes visible']},
  source: {repository: 'Mentra-Community/Mentra-Automated-Testing', revision: 'a'.repeat(40)},
  target: {hostId: 'mini', laneId: 'android'}, requirements: {platform: 'android', glasses: [], resources: [{kind: "app", capabilities: []}, {kind: "recorder", capabilities: []}, {kind: "phone", capabilities: []}], environment: []},
  build: {kind: 'android-apk', repository: 'Mentra-Community/MentraOS', headSha: 'b'.repeat(40), channel: 'pr', prNumber: 12,
    source: {channel: 'pr', prNumber: 12, buildRunId: 55, publicationAttempt: 1},
    archive: {name: 'app.apk', url: 'https://example.com/app.apk', size: 10, sha256: 'd'.repeat(64)},
    receipt: {url: 'https://example.com/receipt.json', size: 10, sha256: 'e'.repeat(64)}}})
const verification = {workId: work.workId, attemptId: 3, sourceRevision}
const selected = {
  routineId: work.routineId,
  platform: 'android',
  definitionRevision: sourceRevision,
  routineSource: testRoutineSource(sourceRevision),
  laneId: work.target.laneId,
  build: work.build,
  resources: [],
  verification,
}
function accepted(): CandidateWorkRecord {
  const inputSha256 = requestInputDigest(work)
  return {hostId: 'mini', inputSha256, work, acceptance: {hostId: 'mini', inputSha256},
    status: {details: {workId: work.workId, hostId: 'mini', inputSha256, work, acceptedAt: '2026-10-05T10:00:00Z',
      state: 'verifying', sequence: 4, attemptId: 3, events: [], details: {sourceRevision,
        prUrl: 'https://github.com/Mentra-Community/Mentra-Automated-Testing/pull/500',
        review: {sourceRevision, verdict: 'APPROVED', prUrl: 'https://github.com/Mentra-Community/Mentra-Automated-Testing/pull/500',
          reviewUrl: 'https://github.com/Mentra-Community/Mentra-Automated-Testing/pull/500#pullrequestreview-44'}}}}}
}

test('candidate permits bind accepted host, current attempt, exact reviewed source and original build', async () => {
  let row = accepted()
  const service = new CandidateVerificationService(async () => row)
  await service.authorize(verification, 'mini', selected)
  for (const change of [
    () => {row.acceptance = undefined},
    () => {row.fleetCancellation = {reason: "Cancelled current work"}},
    () => {row.hostId = 'other'},
    () => {
      ;(row.status!.details as any).attemptId = 2
    },
    () => {
      ;(row.status!.details as any).state = 'passed'
    },
    () => {
      ;(row.status!.details as any).details.review.sourceRevision = 'f'.repeat(40)
    },
    () => {
      ;(row.status!.details as any).details.review.reviewUrl = 'https://github.com/other/repo/pull/500#pullrequestreview-44'
    },
  ]) {
    row = accepted(); change()
    await expect(service.authorize(verification, 'mini', selected)).rejects.toThrow('Candidate verification requires')
  }
  row = accepted()
  await expect(service.authorize(verification, 'other', selected)).rejects.toThrow('accepted current host')
  await expect(service.authorize(verification, 'mini', {...selected, build: {...work.build, headSha: 'f'.repeat(40)}}))
    .rejects.toThrow('accepted current host')
})

test('canonical testing candidate follows its accepted work source and review rather than the app repository', async () => {
  const row = structuredClone(accepted()), repository = 'Mentra-Community/Mentra' as const;
  row.work.source.repository = repository;
  row.inputSha256 = requestInputDigest(row.work); row.acceptance!.inputSha256 = row.inputSha256;
  const details = row.status!.details as any;
  details.work = row.work; details.inputSha256 = row.inputSha256;
  details.details.prUrl = `https://github.com/${repository}/pull/500`;
  details.details.review.prUrl = details.details.prUrl;
  details.details.review.reviewUrl = `${details.details.prUrl}#pullrequestreview-44`;
  const service = new CandidateVerificationService(async () => row), canonical = {...selected, routineSource: {...selected.routineSource, repository}};
  await service.authorize(verification, 'mini', canonical);
  await expect(service.authorize(verification, 'mini', selected)).rejects.toThrow('accepted current host');
  details.details.prUrl = 'https://github.com/Mentra-Community/Mentra-Automated-Testing/pull/500';
  details.details.review.prUrl = details.details.prUrl;
  details.details.review.reviewUrl = `${details.details.prUrl}#pullrequestreview-44`;
  await expect(service.authorize(verification, 'mini', canonical)).rejects.toThrow('exact-source independent review');
});

test('only authenticated candidate intake is admitted; retained local receipt reconciles after restoration', async () => {
  const rows = new Map<string, StoredTestRequest>()
  const repository = {async insert(row: StoredTestRequest) {
    if (rows.has(row.requestId)) throw Object.assign(Error('duplicate'), {code: 11000})
    rows.set(row.requestId, row)
  }, async get(id: string) {return rows.get(id) ?? null}} as TestRequestRepository
  let permit = true, authorizations = 0
  const service = new TestRequestService(repository, {async authorize() {authorizations++; if (!permit) throw Error('permit retired')}},
    async input => {expect(input.verification).toEqual(verification)})
  await expect(service.submit('candidate', 'mini', selected)).rejects.toThrow('authenticated assigned host')
  const receipt = {requestId: 'local:candidate', hostId: 'mini', inputSha256: requestInputDigest(selected), acceptedAt: '2026-10-05T10:00:00Z'}
  const admitted = await service.registerLocal(selected, receipt, 'mini')
  expect(admitted.catalogEligible).toBe(false)
  permit = false
  expect(await service.registerLocal(selected, receipt, 'mini')).toEqual(admitted)
  await expect(service.registerLocal(selected, {...receipt, requestId: 'local:another'}, 'mini')).rejects.toThrow('permit retired')
  expect(authorizations).toBe(2)
})

test('candidate authorization uses only the fresh accepted pre-admission retry of an unchanged failed attempt',async()=>{
 const row=accepted(),original=row.status!.details as any,now=Date.parse('2026-10-15T22:30:00Z')
 original.state='failed';original.details.reason='Original permission refusal'
 const requestId='local:1792177290232:same-candidate'
 row.verification={identity:{decisionId:'admission-retry',inputSha256:'d'.repeat(64),failureEventId:'permission-failed',failureSha256:'e'.repeat(64),
  acceptedAt:new Date(now).toISOString(),deadline:new Date(now+1800000).toISOString(),
  previousFailure:{code:'permission-required',reason:original.details.reason},admission:{requestId,originalAdmissionExpiresAt:1792177290232}},
  status:{details:{...structuredClone(original),state:'awaiting-installation',sequence:5,details:{...original.details,requestId}}}}
 const service=new CandidateVerificationService(async()=>row,()=>now)
 await service.authorize(verification,'mini',selected)
 const snapshot=structuredClone(row)
 for(const mutate of [()=>{(row.verification!.status.details as any).state='cancelled'},()=>{row.fleetCancellation={reason:'Cancel work'}},
  ()=>{(row.verification!.identity as any).deadline=new Date(now-1).toISOString()},
  ()=>{(row.verification!.identity as any).acceptedAt=new Date(now+1000).toISOString()},
  ()=>{(row.verification!.status.details as any).attemptId=4},()=>{(row.verification!.status.details as any).details.requestId='different'},
  ()=>{(row.verification!.status.details as any).details.review={...original.details.review,reviewUrl:original.details.review.reviewUrl+'different'}}]) {
  Object.assign(row,structuredClone(snapshot));delete row.fleetCancellation;mutate()
  await expect(service.authorize(verification,'mini',selected)).rejects.toThrow()
 }
 Object.assign(row,structuredClone(snapshot));delete row.fleetCancellation
 await service.authorize(verification,'mini',{...selected,requestId})
 await service.authorize(verification,'mini',{...selected,requestId,admissionExpiresAt:now+1800000})
 await expect(service.authorize(verification,'mini',{...selected,requestId,admissionExpiresAt:now+1800001})).rejects.toThrow('Local candidate deadline')
 await expect(service.authorize(verification,'mini',{...selected,requestId,admissionExpiresAt:1792177290232})).rejects.toThrow('Local candidate deadline')
 await expect(service.authorize(verification,'mini',{...selected,requestId:'different-request'})).rejects.toThrow('original source')
 const rows=new Map<string,StoredTestRequest>(),repository={async insert(value:StoredTestRequest){rows.set(value.requestId,value)},async get(id:string){return rows.get(id)??null}}as TestRequestRepository
 const intake=new TestRequestService(repository,service)
 await expect(intake.submit('different-request','mini',selected,'mini')).rejects.toThrow('original source')
 const receipt={requestId:'different-request',hostId:'mini',inputSha256:requestInputDigest(selected),acceptedAt:new Date(now).toISOString()}
 await expect(intake.registerLocal(selected,receipt,'mini')).rejects.toThrow('original source')
 const admitted=await intake.registerLocal(selected,{...receipt,requestId},'mini')
 row.verification!.status.details={...(row.verification!.status.details as any),state:'cancelled'}
 expect(await intake.registerLocal(selected,{...receipt,requestId},'mini')).toEqual(admitted)
})

test('NIMO candidate authority omits only Live manifest fields for the exact accepted connection job', async () => {
  const row = accepted(), manifest = {url: 'https://example.com/live.json', sha256: 'f'.repeat(64), size: 100};
  const original = authoringWorkSchema.parse({...row.work, requirements: {...row.work.requirements, glasses: ['nimo'],
    resources: [...row.work.requirements.resources, {kind: 'glasses', capabilities: ['connection']}]},
    build: {...row.work.build, manifest, manifestSha256: manifest.sha256}});
  const digest = requestInputDigest(original), status = row.status!.details as any;
  row.work = original; row.inputSha256 = digest; row.acceptance!.inputSha256 = digest; status.work = original; status.inputSha256 = digest;
  const input = {...selected, glassesModel: 'nimo' as const, build: frameworkExecutableBuild(original.build as any, 'nimo')};
  const service = new CandidateVerificationService(async () => row);
  await service.authorize(verification, 'mini', input);
  await expect(service.authorize(verification, 'mini', {...input, build: {...input.build, archive: {...input.build.archive as any, sha256: 'a'.repeat(64)}}})).rejects.toThrow('accepted current');
  await expect(service.authorize(verification, 'mini', {...input, glassesModel: undefined})).rejects.toThrow('accepted model and connection');
  await expect(service.authorize(verification, 'mini', {...input, glassesModel: undefined, build: original.build})).rejects.toThrow('accepted model and connection');
  row.work.requirements.resources.find(value => value.kind === 'glasses')!.capabilities = [];
  await expect(service.authorize(verification, 'mini', input)).rejects.toThrow('accepted model and connection');
});

 test('local candidate cannot extend an ordinary admission deadline or alter its recorded original retry epoch', async () => {
   const row = accepted(), service = new CandidateVerificationService(async () => row)
   const requestId = 'local:1792422600000:original'
   await service.authorize(verification, 'mini', {...selected, requestId, admissionExpiresAt: 1792422600000})
   await expect(service.authorize(verification, 'mini', {...selected, requestId, admissionExpiresAt: 1792422600001})).rejects.toThrow('Local candidate deadline')
   await expect(service.authorize(verification, 'mini', {...selected, requestId: 'cloud', admissionExpiresAt: 1792422600000})).rejects.toThrow('Local candidate deadline')
 })
