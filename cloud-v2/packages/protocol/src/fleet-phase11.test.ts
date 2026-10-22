import {describe, expect, test} from "bun:test"
import {
  FLEET_ASSIGNMENT_REASONS,
  FLEET_ASSIGNMENT_STATES,
  FleetDesiredStateSchema,
  FleetRecordSchema,
  FleetReportAckSchema,
} from "./fleet"

const T = "2026-10-21T09:30:00Z"

const base = {
  schemaVersion: 1,
  recordId: "rec_1",
  phoneDeviceId: "phone_1",
  collectorSessionId: "col_1",
  sequence: 4,
  observedAt: T,
  capabilities: ["miniapp_execution"],
}

const inventory = (overrides: Record<string, unknown> = {}) => ({
  ...base,
  kind: "miniapp_inventory",
  payload: {
    miniapps: [
      {packageName: "com.mentra.notes", versionName: "1.2.0", digest: "sha256:ab12", reasons: ["bundled", "assignment"]},
    ],
  },
  ...overrides,
})

const outcome = (payload: Record<string, unknown> = {}, overrides: Record<string, unknown> = {}) => ({
  ...base,
  kind: "assignment_outcome",
  payload: {
    assignmentId: "asg_1",
    assignmentRevision: 3,
    desiredRevision: 9,
    packageName: "com.example.private",
    state: "installed",
    selectedVersion: "2.0.0",
    installedVersion: "2.0.0",
    attempts: 1,
    attemptedAt: T,
    lastSuccessAt: T,
    ...payload,
  },
  ...overrides,
})

describe("miniapp_inventory", () => {
  test("parses its fixture", () => {
    expect(FleetRecordSchema.safeParse(inventory()).success).toBe(true)
  })

  test("an empty inventory parses (a phone with nothing installed)", () => {
    expect(FleetRecordSchema.safeParse(inventory({payload: {miniapps: []}})).success).toBe(true)
  })

  test("rejects an unknown install reason", () => {
    const record = inventory()
    ;(record.payload.miniapps[0] as any).reasons = ["store"]
    expect(FleetRecordSchema.safeParse(record).success).toBe(false)
  })

  test("rejects an entry with no reasons", () => {
    const record = inventory()
    ;(record.payload.miniapps[0] as any).reasons = []
    expect(FleetRecordSchema.safeParse(record).success).toBe(false)
  })

  test("rejects extra fields on the record, the payload and an entry (strict)", () => {
    expect(FleetRecordSchema.safeParse({...inventory(), extra: 1}).success).toBe(false)
    expect(FleetRecordSchema.safeParse(inventory({payload: {miniapps: [], extra: 1}})).success).toBe(false)
    const record = inventory()
    ;(record.payload.miniapps[0] as any).extra = 1
    expect(FleetRecordSchema.safeParse(record).success).toBe(false)
  })

  test("rejects an observedAt that is not UTC", () => {
    expect(FleetRecordSchema.safeParse(inventory({observedAt: "2026-10-21T17:30:00+08:00"})).success).toBe(false)
  })

  test("caps the inventory size", () => {
    const many = Array.from({length: 501}, (_, i) => ({
      packageName: `pkg.${i}`,
      versionName: "1",
      digest: "sha256:00",
      reasons: ["explicit"],
    }))
    expect(FleetRecordSchema.safeParse(inventory({payload: {miniapps: many}})).success).toBe(false)
  })
})

describe("assignment_outcome", () => {
  test("parses every state", () => {
    for (const state of FLEET_ASSIGNMENT_STATES) {
      const payload: Record<string, unknown> = {state}
      if (state === "blocked") payload.reason = "storage_full"
      expect(FleetRecordSchema.safeParse(outcome(payload)).success).toBe(true)
    }
  })

  test("parses every reason on a blocked or retrying assignment", () => {
    for (const reason of FLEET_ASSIGNMENT_REASONS) {
      expect(FleetRecordSchema.safeParse(outcome({state: "blocked", reason})).success).toBe(true)
      expect(FleetRecordSchema.safeParse(outcome({state: "retrying", reason, attempts: 3})).success).toBe(true)
    }
  })

  test("a retrying assignment may omit its reason", () => {
    expect(FleetRecordSchema.safeParse(outcome({state: "retrying", attempts: 2})).success).toBe(true)
  })

  test("rejects an unknown state or reason", () => {
    expect(FleetRecordSchema.safeParse(outcome({state: "paused"})).success).toBe(false)
    expect(FleetRecordSchema.safeParse(outcome({state: "blocked", reason: "disk on fire"})).success).toBe(false)
  })

  test("a blocked assignment must carry a reason", () => {
    expect(FleetRecordSchema.safeParse(outcome({state: "blocked"})).success).toBe(false)
  })

  test("a reason on an installed, pending or withdrawn assignment is rejected", () => {
    for (const state of ["installed", "pending", "withdrawn", "deferred_running"]) {
      expect(FleetRecordSchema.safeParse(outcome({state, reason: "storage_full"})).success).toBe(false)
    }
  })

  test("rejects negative or fractional attempts", () => {
    expect(FleetRecordSchema.safeParse(outcome({attempts: -1})).success).toBe(false)
    expect(FleetRecordSchema.safeParse(outcome({attempts: 1.5})).success).toBe(false)
  })

  test("rejects a zero or negative revision", () => {
    expect(FleetRecordSchema.safeParse(outcome({assignmentRevision: 0})).success).toBe(false)
    expect(FleetRecordSchema.safeParse(outcome({desiredRevision: -2})).success).toBe(false)
  })

  test("rejects a non-UTC attemptedAt or lastSuccessAt", () => {
    expect(FleetRecordSchema.safeParse(outcome({attemptedAt: "2026-10-21T17:30:00+08:00"})).success).toBe(false)
    expect(FleetRecordSchema.safeParse(outcome({lastSuccessAt: "yesterday"})).success).toBe(false)
  })

  test("rejects extra fields (strict)", () => {
    expect(FleetRecordSchema.safeParse(outcome({extra: true})).success).toBe(false)
  })

  test("records name no account, email or workspace", () => {
    for (const forbidden of ["accountId", "mentraUserId", "email", "workspaceId", "organizationId"]) {
      expect(FleetRecordSchema.safeParse(outcome({}, {[forbidden]: "x"})).success).toBe(false)
      expect(FleetRecordSchema.safeParse(outcome({[forbidden]: "x"})).success).toBe(false)
      expect(FleetRecordSchema.safeParse(inventory({[forbidden]: "x"})).success).toBe(false)
    }
  })
})

describe("acknowledgement revision", () => {
  test("an older-shape ack with no revision still parses", () => {
    expect(FleetReportAckSchema.safeParse({schemaVersion: 1, results: []}).success).toBe(true)
  })

  test("an ack carries the account's desired-state revision", () => {
    const parsed = FleetReportAckSchema.safeParse({schemaVersion: 1, results: [], revision: 12})
    expect(parsed.success && parsed.data.revision).toBe(12)
  })

  test("rejects a zero, negative or fractional revision", () => {
    for (const revision of [0, -1, 1.5]) {
      expect(FleetReportAckSchema.safeParse({schemaVersion: 1, results: [], revision}).success).toBe(false)
    }
  })
})

describe("desired state", () => {
  const managed = (overrides: Record<string, unknown> = {}) => ({
    status: "managed",
    revision: 5,
    generatedAt: T,
    workspace: {workspaceId: "ws_1", name: "Ridgeline Field Services"},
    entries: [{assignmentId: "asg_1", revision: 2, url: "https://private.example.com/miniapp", packageName: "com.example.private", selection: "latest"}],
    ...overrides,
  })

  test("managed with entries parses", () => {
    expect(FleetDesiredStateSchema.safeParse(managed()).success).toBe(true)
  })

  test("managed with an empty entry list parses: a member with nothing assigned is still managed", () => {
    expect(FleetDesiredStateSchema.safeParse(managed({entries: []})).success).toBe(true)
  })

  test("managed requires its workspace and an entries array", () => {
    const {workspace, ...noWorkspace} = managed()
    expect(workspace).toBeDefined()
    expect(FleetDesiredStateSchema.safeParse(noWorkspace).success).toBe(false)
    const {entries, ...noEntries} = managed()
    expect(entries).toBeDefined()
    expect(FleetDesiredStateSchema.safeParse(noEntries).success).toBe(false)
  })

  test("unmanaged has a revision and no workspace or entries", () => {
    expect(FleetDesiredStateSchema.safeParse({status: "unmanaged", revision: 6, generatedAt: T}).success).toBe(true)
    expect(
      FleetDesiredStateSchema.safeParse({status: "unmanaged", revision: 6, generatedAt: T, entries: []}).success,
    ).toBe(false)
    expect(
      FleetDesiredStateSchema.safeParse({
        status: "unmanaged",
        revision: 6,
        generatedAt: T,
        workspace: {workspaceId: "ws_1", name: "x"},
      }).success,
    ).toBe(false)
  })

  test("paused and unknown statuses are not part of the Phase 11 schema", () => {
    for (const status of ["paused", "suspended", ""]) {
      expect(FleetDesiredStateSchema.safeParse({...managed(), status}).success).toBe(false)
    }
  })

  test("rejects a revision of 0 or less on either shape", () => {
    expect(FleetDesiredStateSchema.safeParse(managed({revision: 0})).success).toBe(false)
    expect(FleetDesiredStateSchema.safeParse({status: "unmanaged", revision: -3, generatedAt: T}).success).toBe(false)
  })

  test("rejects a selection other than latest and an entry revision of 0", () => {
    const entry = {assignmentId: "asg_1", revision: 2, url: "https://example.com/p", packageName: "p", selection: "pinned"}
    expect(FleetDesiredStateSchema.safeParse(managed({entries: [entry]})).success).toBe(false)
    expect(
      FleetDesiredStateSchema.safeParse(managed({entries: [{...entry, selection: "latest", revision: 0}]})).success,
    ).toBe(false)
  })

  test("an entry names a miniapp by an https URL: no other scheme, no credentials, no blank, no missing URL", () => {
    const entry = {assignmentId: "asg_1", revision: 2, url: "https://example.com/p", packageName: "p", selection: "latest"}
    expect(FleetDesiredStateSchema.safeParse(managed({entries: [entry]})).success).toBe(true)
    for (const url of ["http://example.com/p", "ftp://example.com/p", "javascript:alert(1)", "https://user:pw@example.com/p", "", "not a url", `https://example.com/${"a".repeat(2100)}`]) {
      expect(FleetDesiredStateSchema.safeParse(managed({entries: [{...entry, url}]})).success).toBe(false)
    }
    const {url: _url, ...withoutUrl} = entry
    expect(FleetDesiredStateSchema.safeParse(managed({entries: [withoutUrl]})).success).toBe(false)
  })

  test("rejects extra fields (strict)", () => {
    expect(FleetDesiredStateSchema.safeParse(managed({extra: 1})).success).toBe(false)
  })

  test("rejects a non-UTC generatedAt", () => {
    expect(FleetDesiredStateSchema.safeParse(managed({generatedAt: "2026-10-21T17:30:00+08:00"})).success).toBe(false)
  })
})

describe("assignment reasons (Mentra-Specs #140)", () => {
  test("archived, access_denied and not_a_miniapp are reasons; the Store-era ones are gone", () => {
    for (const reason of ["archived", "access_denied", "not_a_miniapp", "download_failed", "storage_full"]) {
      expect(FleetRecordSchema.safeParse(outcome({state: "blocked", reason})).success).toBe(true)
    }
    for (const reason of ["not_eligible", "sharing_revoked", "not_published"]) {
      expect(FleetRecordSchema.safeParse(outcome({state: "blocked", reason})).success).toBe(false)
    }
  })
})
