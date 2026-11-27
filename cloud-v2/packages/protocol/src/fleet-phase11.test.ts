import {describe, expect, test} from "bun:test"
import {
  FLEET_ASSIGNMENT_REASONS,
  FLEET_ASSIGNMENT_STATES,
  FLEET_DESIRED_STATE_PINS_PARAM,
  FLEET_DESIRED_STATE_PINS_VALUE,
  FLEET_INSTALL_FAILURE_REASONS,
  FLEET_INSTALL_REASONS,
  FLEET_LIMITS,
  FleetAssignmentPinSchema,
  fleetDesiredStateAsksForPins,
  FleetDesiredStateSchema,
  FleetDesiredStateWithPinsSchema,
  fleetDesiredStateWithoutPins,
  FleetRecordSchema,
  FleetReportAckSchema,
} from "./fleet"
import {MINIAPP_PIN_UNMET_REASONS} from "./miniapp-url"

const T = "2026-10-21T09:30:00Z"
/** A pin: the version, and the hash it had when it was chosen. */
const PIN = {version: "0.3.4", sha256: "41ab77c3".padEnd(64, "0")}

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

const phoneSnapshot = (battery?: Record<string, unknown>, capabilities: string[] = ["phone_battery"]) => ({
  ...base,
  capabilities,
  kind: "snapshot",
  payload: {
    phone: {
      model: "Pixel 9",
      os: "android",
      osVersion: "15",
      appVersion: "3.5.0",
      appBuild: "3500",
      ...(battery === undefined ? {} : {battery}),
    },
  },
})

describe("phone battery", () => {
  const parses = (battery?: Record<string, unknown>) => FleetRecordSchema.safeParse(phoneSnapshot(battery)).success

  test("a phone snapshot without a battery still parses (an older app)", () => {
    expect(FleetRecordSchema.safeParse(phoneSnapshot(undefined, [])).success).toBe(true)
  })

  test("measured carries a level of 0 to 100 and whether it is charging", () => {
    expect(parses({state: "measured", observedAt: T, level: 0})).toBe(true)
    expect(parses({state: "measured", observedAt: T, level: 100, charging: true})).toBe(true)
    expect(parses({state: "measured", observedAt: T, level: 101})).toBe(false)
    expect(parses({state: "measured", observedAt: T, level: -1})).toBe(false)
    expect(parses({state: "measured", observedAt: T, level: 42.5})).toBe(false)
    expect(parses({state: "measured", observedAt: T})).toBe(false)
  })

  test("unsupported and unknown carry no level, so neither can be read as 0", () => {
    expect(parses({state: "unsupported", observedAt: T})).toBe(true)
    expect(parses({state: "unknown", observedAt: T})).toBe(true)
    expect(parses({state: "unknown", observedAt: T, level: 0})).toBe(false)
    expect(parses({state: "unsupported", observedAt: T, level: 0})).toBe(false)
    expect(parses({state: "unknown", observedAt: T, charging: false})).toBe(false)
  })

  test("carries no other battery detail or identifier", () => {
    for (const extra of [{health: "good"}, {temperature: 31}, {serial: "R3CN70"}, {deviceName: "Maya's Pixel"}, {lowPowerMode: true}]) {
      expect(parses({state: "measured", observedAt: T, level: 50, ...extra})).toBe(false)
    }
  })

  test("phone_battery is a capability a record may declare", () => {
    expect(FleetRecordSchema.safeParse(phoneSnapshot({state: "measured", observedAt: T, level: 50})).success).toBe(true)
    expect(FleetRecordSchema.safeParse(phoneSnapshot(undefined, ["phone_charge"])).success).toBe(false)
  })
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

  // What a phone that did not ask for pins parses with, and what every released Mentra App parses with.
  test("the answer to a phone that did not ask for pins has only latest entries: a pinned one, with or without its pin, is rejected", () => {
    const entry = {assignmentId: "asg_1", revision: 2, url: "https://example.com/p", packageName: "p", selection: "pinned"}
    expect(FleetDesiredStateSchema.safeParse(managed({entries: [entry]})).success).toBe(false)
    expect(FleetDesiredStateSchema.safeParse(managed({entries: [{...entry, pin: PIN}]})).success).toBe(false)
    // A latest entry may not carry a pin either: an unknown key stops a released phone.
    expect(FleetDesiredStateSchema.safeParse(managed({entries: [{...entry, selection: "latest", pin: PIN}]})).success).toBe(false)
    expect(FleetDesiredStateSchema.safeParse(managed({entries: [{...entry, selection: "latest"}]})).success).toBe(true)
  })

  test("rejects an entry revision of 0", () => {
    const entry = {assignmentId: "asg_1", revision: 0, url: "https://example.com/p", packageName: "p", selection: "latest"}
    expect(FleetDesiredStateSchema.safeParse(managed({entries: [entry]})).success).toBe(false)
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

describe("desired state with pins (a phone that asked with ?pins=1)", () => {
  const latest = {assignmentId: "asg_1", revision: 2, url: "https://private.example.com/miniapp", packageName: "com.example.private", selection: "latest"}
  const pinned = {assignmentId: "asg_2", revision: 4, url: "https://notes.example.com/", packageName: "com.example.notes", selection: "pinned", pin: PIN}
  const managed = (entries: unknown[], overrides: Record<string, unknown> = {}) => ({
    status: "managed",
    revision: 5,
    generatedAt: T,
    workspace: {workspaceId: "ws_1", name: "Ridgeline Field Services"},
    entries,
    ...overrides,
  })

  test("the request parameter is pins=1, and nothing else asks", () => {
    expect(`${FLEET_DESIRED_STATE_PINS_PARAM}=${FLEET_DESIRED_STATE_PINS_VALUE}`).toBe("pins=1")
    expect(fleetDesiredStateAsksForPins("1")).toBe(true)
    for (const value of [undefined, null, "", "0", "true", "yes", "2", "1 ", "01"]) expect(fleetDesiredStateAsksForPins(value)).toBe(false)
  })

  test("latest and pinned entries parse side by side, and so does everything the plain schema takes", () => {
    const parsed = FleetDesiredStateWithPinsSchema.safeParse(managed([latest, pinned]))
    expect(parsed.success).toBe(true)
    expect(parsed.success && parsed.data.status === "managed" && parsed.data.entries[1]).toEqual(pinned as never)
    expect(FleetDesiredStateWithPinsSchema.safeParse(managed([])).success).toBe(true)
    expect(FleetDesiredStateWithPinsSchema.safeParse({status: "unmanaged", revision: 6, generatedAt: T}).success).toBe(true)
  })

  test("a pin goes with a pinned entry, and only with it", () => {
    const {pin: _pin, ...pinnedWithoutPin} = pinned
    expect(FleetDesiredStateWithPinsSchema.safeParse(managed([pinnedWithoutPin])).success).toBe(false)
    expect(FleetDesiredStateWithPinsSchema.safeParse(managed([{...latest, pin: PIN}])).success).toBe(false)
    expect(FleetDesiredStateWithPinsSchema.safeParse(managed([{...pinned, selection: "exact"}])).success).toBe(false)
  })

  test("a pin is a SemVer version and a lowercase SHA-256, and nothing more", () => {
    expect(FleetAssignmentPinSchema.safeParse(PIN).success).toBe(true)
    for (const pin of [
      {version: "0.3", sha256: PIN.sha256},
      {version: "latest", sha256: PIN.sha256},
      {version: "", sha256: PIN.sha256},
      {version: PIN.version},
      {sha256: PIN.sha256},
      {version: PIN.version, sha256: "abc"},
      {version: PIN.version, sha256: PIN.sha256.toUpperCase()},
      {version: PIN.version, sha256: "z".repeat(64)},
      {...PIN, url: "https://notes.example.com/notes-0.3.4.zip"},
      null,
    ]) {
      expect(FleetAssignmentPinSchema.safeParse(pin).success).toBe(false)
      expect(FleetDesiredStateWithPinsSchema.safeParse(managed([{...pinned, pin}])).success).toBe(false)
    }
  })

  test("the rest is as strict as the plain schema: extra fields, statuses, URLs and limits", () => {
    expect(FleetDesiredStateWithPinsSchema.safeParse(managed([pinned], {extra: 1})).success).toBe(false)
    expect(FleetDesiredStateWithPinsSchema.safeParse(managed([{...pinned, extra: 1}])).success).toBe(false)
    expect(FleetDesiredStateWithPinsSchema.safeParse(managed([pinned], {status: "paused"})).success).toBe(false)
    expect(FleetDesiredStateWithPinsSchema.safeParse(managed([{...pinned, url: "http://notes.example.com/"}])).success).toBe(false)
    expect(FleetDesiredStateWithPinsSchema.safeParse(managed([{...pinned, revision: 0}])).success).toBe(false)
    const many = Array.from({length: FLEET_LIMITS.maxAssignmentEntries + 1}, (_, index) => ({...pinned, assignmentId: `asg_${index}`}))
    expect(FleetDesiredStateWithPinsSchema.safeParse(managed(many)).success).toBe(false)
  })

  test("without pins, a pinned entry is the same entry as latest and the answer parses on a phone that did not ask", () => {
    const withPins = FleetDesiredStateWithPinsSchema.parse(managed([latest, pinned]))
    const plain = fleetDesiredStateWithoutPins(withPins)
    expect(plain).toEqual({
      ...managed([latest, {assignmentId: "asg_2", revision: 4, url: "https://notes.example.com/", packageName: "com.example.notes", selection: "latest"}]),
    } as never)
    expect(FleetDesiredStateSchema.safeParse(plain).success).toBe(true)
    expect(JSON.stringify(plain)).not.toContain("pin")
    // Nothing to change: an answer with no pinned entry, and an unmanaged one.
    expect(fleetDesiredStateWithoutPins(FleetDesiredStateWithPinsSchema.parse(managed([latest])))).toEqual(managed([latest]) as never)
    const unmanaged = {status: "unmanaged" as const, revision: 6, generatedAt: T}
    expect(fleetDesiredStateWithoutPins(unmanaged)).toEqual(unmanaged)
  })
})

describe("the spec's lists, exactly", () => {
  test("install reasons, outcome states and reasons are the provisioning and Fleet specs' sets", () => {
    expect([...FLEET_INSTALL_REASONS]).toEqual(["bundled", "explicit", "manifest", "assignment"])
    expect<string[]>([...FLEET_ASSIGNMENT_STATES].sort()).toEqual(
      ["blocked", "deferred_running", "downloading", "installed", "installing", "pending", "retrying", "withdrawn"].sort(),
    )
    expect<string[]>([...FLEET_ASSIGNMENT_REASONS].sort()).toEqual(
      [
        "access_denied",
        "archived",
        "development_build",
        "download_failed",
        "incompatible_host",
        "manifest_conflict",
        "newer_version_installed",
        "not_a_miniapp",
        "pin_hash_changed",
        "pin_unlisted",
        "signature_invalid",
        "storage_full",
      ].sort(),
    )
  })

  test("the two reasons a pin can't be met are assignment reasons, and install-failure reasons with them", () => {
    for (const reason of MINIAPP_PIN_UNMET_REASONS) {
      expect<readonly string[]>(FLEET_ASSIGNMENT_REASONS).toContain(reason)
      expect<readonly string[]>(FLEET_INSTALL_FAILURE_REASONS).toContain(reason)
      expect(FleetRecordSchema.safeParse(outcome({state: "blocked", reason, selectedVersion: "0.3.4", installedVersion: "0.3.5"})).success).toBe(true)
    }
  })

  test("the record kinds are Phase 10's five, Phase 11's two and Phase 12's five, and nothing else parses", () => {
    const kinds = [...FleetRecordSchema.innerType().optionsMap.keys()].map(String).sort()
    expect(kinds).toEqual(
      [
        "assignment_outcome",
        "coverage_gap",
        "miniapp_inventory",
        "miniapp_launch",
        "photo_operation",
        "snapshot",
        "usage_checkpoint",
        "telemetry_event",
        "telemetry_loss",
        "miniapp_crash",
        "miniapp_install",
        "connection_event",
      ].sort(),
    )
    expect(FleetRecordSchema.safeParse({...inventory(), kind: "miniapp_restart"}).success).toBe(false)
  })

  test("a record carries no management association: membership is management, with no enrollment", () => {
    const management = {associationId: "assoc_1", generation: 1}
    expect(FleetRecordSchema.safeParse(inventory({management})).success).toBe(false)
    expect(FleetRecordSchema.safeParse(outcome({}, {management})).success).toBe(false)
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
