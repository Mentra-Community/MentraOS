import {expect, test} from 'bun:test'
import {LaneControlsService, type LaneControlHost, type LaneControlRepository} from '../services/lane-controls.service'
import {requestInputDigest} from '../services/test-request.service'
import {resourceCandidateBlocker} from '../services/resource-readiness'
import {resourceControlRecordSchema} from './lane-control.types'
import {resourceLifecycleSubjectSchema} from './resource-lifecycle.types'
import {acceptedManualRestoration, manualWithdrawalNeedsRestoration} from './resource-control-authority'

// Redacted original Mini report: restoration1950 passed after withdrawal1944,
// while the same job's new preflight projects UNKNOWN without changing that proof.
const originalSubject = {
  "subject": {
    "kind": "resource",
    "id": "mini-mac-app",
    "authorityHostId": "mini-controller"
  },
  "generation": 1950,
  "status": "unknown",
  "observedAt": "2026-10-26T23:58:48.210Z",
  "receivedAt": null,
  "current": true,
  "reason": {
    "code": "idle-check-required",
    "message": "A fresh accepted return is required before allocation"
  },
  "owner": null,
  "idle": {
    "contractVersion": "installed-resource-baseline-v1",
    "outcome": "unknown",
    "checkedAt": "2026-10-26T22:20:15.212Z",
    "acceptedCheck": {
      "operationId": "idle-check:16b94ab3-27c8-4069-8696-b2a62cd885c9",
      "subjectGeneration": 1950,
      "resultSha256": "1b478166449311f95c4e9628d26b37a6b58b2ae34a068997d0252fe946de35ab",
      "acceptedAt": "2026-10-26T22:20:31.631Z"
    },
    "qualifiedScope": {
      "kind": "same-controller",
      "controllerId": "mini-controller"
    },
    "evidenceRefs": [
      "idle-reader:b58934ce45ae0cdc1ccb5d45c0b02f8e191f3946823710918d6c4aa6b90e335f",
      "idle-reader:df425b07d3d9dfa5c764eff3f1d9a9a362b6d4774096630ec20058d65f45ccd4"
    ],
    "report": {
      "resourceId": "mini-mac-app",
      "authorityHostId": "mini-controller",
      "contractVersion": "installed-resource-baseline-v1",
      "operationId": "idle-check:16b94ab3-27c8-4069-8696-b2a62cd885c9",
      "checkedAt": "2026-10-26T22:20:15.212Z",
      "resultSha256": "1b478166449311f95c4e9628d26b37a6b58b2ae34a068997d0252fe946de35ab",
      "outcome": "passed",
      "reportedOutcome": "passed",
      "conditions": [
        {
          "id": "app-managed-processes-absent",
          "label": "app managed processes absent",
          "status": "passed",
          "reportedStatus": "passed",
          "observed": "No managed Mentra App process remains",
          "expected": "No managed Mentra App process remains after teardown",
          "explanation": "The original check established the expected condition",
          "repairAction": null,
          "evidenceRefs": [
            "idle-reader:b58934ce45ae0cdc1ccb5d45c0b02f8e191f3946823710918d6c4aa6b90e335f",
            "idle-reader:df425b07d3d9dfa5c764eff3f1d9a9a362b6d4774096630ec20058d65f45ccd4"
          ],
          "source": null
        },
        {
          "id": "app-managed-storage-absent",
          "label": "app managed storage absent",
          "status": "passed",
          "reportedStatus": "passed",
          "observed": "No managed Mentra App container or app wrapper remains",
          "expected": "No managed Mentra App container or app wrapper remains after teardown",
          "explanation": "The original check established the expected condition",
          "repairAction": null,
          "evidenceRefs": [
            "idle-reader:b58934ce45ae0cdc1ccb5d45c0b02f8e191f3946823710918d6c4aa6b90e335f",
            "idle-reader:df425b07d3d9dfa5c764eff3f1d9a9a362b6d4774096630ec20058d65f45ccd4"
          ],
          "source": null
        }
      ],
      "evidenceRefs": [
        "idle-reader:b58934ce45ae0cdc1ccb5d45c0b02f8e191f3946823710918d6c4aa6b90e335f",
        "idle-reader:df425b07d3d9dfa5c764eff3f1d9a9a362b6d4774096630ec20058d65f45ccd4"
      ]
    }
  },
  "repair": {
    "configured": true,
    "state": "none"
  },
  "supportedActions": [],
  "resource": {
    "kind": "app",
    "capabilities": [
      "relaunch"
    ],
    "memberships": [
      {
        "hostId": "mini-controller",
        "laneId": "mini-mac"
      }
    ],
    "dependencies": [],
    "placement": "installed"
  }
}
const originalWithdrawal = {
  "command": {
    "operationId": "c3e49607-c4a9-4ee1-b5e9-4382367c9892",
    "hostId": "mini-controller",
    "subject": {
      "resourceId": "mini-mac-app",
      "subjectGeneration": 1943
    },
    "expiresAt": 1792743619685,
    "action": "mark-out-of-service",
    "reason": "Pause automatic app readiness retries while checking the original setup; restore through the same resource readiness check.",
    "operatorId": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  },
  "receipt": {
    "operationId": "c3e49607-c4a9-4ee1-b5e9-4382367c9892",
    "inputSha256": "885cd9510d39b1e6ac548206e40a6e068f023fe8fc17a8955371abef100a6a21",
    "hostId": "mini-controller",
    "subject": {
      "resourceId": "mini-mac-app",
      "subjectGeneration": 1943
    },
    "completedAt": "2026-10-23T08:18:21.469Z",
    "result": {
      "status": "accepted",
      "resource": {
        "resourceId": "mini-mac-app",
        "generation": 1944,
        "status": "out-of-service"
      }
    }
  }
}

const observedAt = '2026-10-26T23:58:50.390Z'
function fixture() {
  const now = Date.parse(observedAt), subject = resourceLifecycleSubjectSchema.parse(structuredClone(originalSubject)),
    row = resourceControlRecordSchema.parse(structuredClone(originalWithdrawal))
  let host: LaneControlHost = {hostId: 'mini-controller', laneControlVersion: 1, laneControls: [row],
    observedAt: new Date(now), receivedAt: new Date(now), snapshot: {lanes: [],
      laneControls: {schemaVersion: 1, resourceControls: true, receipts: []},
      resourceLifecycle: {schemaVersion: 1, subjects: [subject], history: []}}}
  const writes: boolean[] = [], repository: LaneControlRepository = {
    async get() {return structuredClone(host)},
    async replace(_id, version, records, authority) {
      expect(version).toBe(host.laneControlVersion!); writes.push(Boolean(authority))
      host = {...host, laneControlVersion: version + 1, laneControls: structuredClone(records)}; return true
    },
  }, service = new LaneControlsService(repository, () => now)
  return {now, subject, row, service, writes, host: () => host,
    saved: () => resourceControlRecordSchema.parse((host.laneControls as unknown[])[0])}
}

test('the exact accepted report completes the old withdrawal during normal exchange despite UNKNOWN preflight', async () => {
  const f = fixture()
  expect(manualWithdrawalNeedsRestoration(f.row, f.subject, 'mini-controller', true, f.now)).toBe(false)
  await f.service.exchange('mini-controller', {schemaVersion: 1, receipts: []})
  expect(f.saved().restoredBy).toEqual({hostId: 'mini-controller', resourceId: 'mini-mac-app', ...f.subject.idle.acceptedCheck!})
  expect(f.saved().command).toEqual(f.row.command); expect(f.saved().receipt).toEqual(f.row.receipt)
  expect(f.writes).toEqual([true])
  await f.service.exchange('mini-controller', {schemaVersion: 1, receipts: []})
  expect(f.writes).toEqual([true])
})

test('later unrelated receipt exchange does not add the restoration snapshot CAS', async () => {
  const f = fixture()
  await f.service.exchange('mini-controller', {schemaVersion: 1, receipts: []})
  const command = {operationId: '00000000-0000-4000-8000-000000000003', hostId: 'mini-controller',
    subject: {resourceId: 'mini-mac-app', subjectGeneration: 1950}, action: 'check' as const,
    expiresAt: f.now + 120_000, operatorId: 'a'.repeat(64)}
  ;(f.host().laneControls as unknown[]).push({command})
  await f.service.exchange('mini-controller', {schemaVersion: 1, receipts: [{operationId: command.operationId,
    inputSha256: requestInputDigest(command), hostId: command.hostId, subject: command.subject, completedAt: observedAt,
    result: {status: 'accepted', check: {operationId: command.operationId, resourceId: 'mini-mac-app', generation: 1953, state: 'settled'}}}]})
  expect(f.writes).toEqual([true, false])
})

test('a completed withdrawal stays completed at later generations while another owner still blocks allocation', async () => {
  const f = fixture()
  await f.service.exchange('mini-controller', {schemaVersion: 1, receipts: []})
  const later = {...f.subject, generation: 1951, status: 'checking' as const,
    owner: {id: 'original-graph', kind: 'boundary-cleanup' as const, generation: 1951, hostId: 'mini-controller'},
    idle: {...f.subject.idle, acceptedCheck: null, report: undefined}}
  expect(manualWithdrawalNeedsRestoration(f.saved(), later, 'mini-controller', true, f.now + 180_000)).toBe(false)
  expect(resourceCandidateBlocker({hostId: 'mini-controller', receivedAt: observedAt,
    resourceControlRecords: [f.saved()], snapshot: {hostId: 'mini-controller', observedAt, lanes: [],
      resourceLifecycle: {schemaVersion: 1, subjects: [later], history: []}}}, 'mini-mac-app', f.now)?.code).toBe('resource-baseline-unavailable')
})

test('a newer withdrawal is not completed by the older accepted restoration', () => {
  const f = fixture(), newer = structuredClone(f.row)
  newer.command.operationId = '00000000-0000-4000-8000-000000000002'
  newer.command.subject.subjectGeneration = 1950
  if (newer.receipt?.result.status !== 'accepted' || !newer.receipt.result.resource) throw Error('fixture')
  newer.receipt.operationId = newer.command.operationId; newer.receipt.subject = newer.command.subject
  newer.receipt.completedAt = observedAt; newer.receipt.result.resource.generation = 1951
  expect(manualWithdrawalNeedsRestoration(newer, f.subject, 'mini-controller', true, f.now)).toBe(true)
  newer.restoredBy = acceptedManualRestoration(f.row, f.subject, 'mini-controller', true, f.now)
  expect(manualWithdrawalNeedsRestoration(newer, f.subject, 'mini-controller', true, f.now)).toBe(true)
})

test.each(['subject', 'report-resource', 'report-authority', 'report-operation', 'report-hash', 'report-contract', 'report-time', 'failed', 'owner'] as const)(
  'restoration rejects mismatched %s evidence', changed => {
    const f = fixture(), subject = structuredClone(f.subject), report = subject.idle.report!
    if (changed === 'subject') subject.subject.id = 'foreign-resource'
    if (changed === 'report-resource') report.resourceId = 'foreign-resource'
    if (changed === 'report-authority') report.authorityHostId = 'foreign-host'
    if (changed === 'report-operation') report.operationId = 'foreign-operation'
    if (changed === 'report-hash') report.resultSha256 = 'b'.repeat(64)
    if (changed === 'report-contract') report.contractVersion = 'foreign-contract'
    if (changed === 'report-time') report.checkedAt = observedAt
    if (changed === 'failed') report.reportedOutcome = 'failed'
    if (changed === 'owner') subject.owner = {id: 'another-owner', kind: 'run', generation: 2, hostId: 'mini-controller'}
    expect(manualWithdrawalNeedsRestoration(f.row, subject, 'mini-controller', true, f.now)).toBe(true)
  })
