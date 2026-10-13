import {describe, expect, test} from "bun:test"
import {readdirSync, readFileSync} from "node:fs"
import {join} from "node:path"
import type {ZodIssue} from "zod"
import {
  FLEET_LIMITS,
  FLEET_NOT_INSTALLED,
  FLEET_UNAVAILABLE,
  FleetRecordResultSchema,
  FleetRecordSchema,
  FleetReportAckSchema,
  FleetReportSchema,
} from "./fleet"

// Resolved from the package root, so the tsc-emitted copy under dist/ finds the same fixtures.
const FIXTURE_DIR = join(import.meta.dir, "..", "src", "__fixtures__", "fleet")
const fixtureNames = readdirSync(FIXTURE_DIR)
  .filter((name) => name.endsWith(".json"))
  .sort()
const withPrefix = (prefix: string) => fixtureNames.filter((name) => name.startsWith(prefix))

type Json = Record<string, any>
const load = (name: string): Json => JSON.parse(readFileSync(join(FIXTURE_DIR, name), "utf8"))
const loadRecord = (name: string, index = 0): Json => structuredClone(load(name).records[index])

/** Where, and why, each invalid report fixture fails record validation. */
const INVALID_RECORDS: Record<string, {path: (string | number)[]; code: ZodIssue["code"]}> = {
  "report-invalid-battery-zero-when-unsupported.json": {
    path: ["payload", "glasses", "battery"],
    code: "unrecognized_keys",
  },
  "report-invalid-email-identity.json": {path: [], code: "unrecognized_keys"},
  "report-invalid-execution-without-package-name.json": {path: ["payload", "sessions", 0], code: "custom"},
  "report-invalid-missing-record-id.json": {path: ["recordId"], code: "invalid_type"},
  "report-invalid-negative-elapsed.json": {path: ["payload", "sessions", 0, "elapsedMs"], code: "too_small"},
  "report-invalid-offset-time.json": {path: ["observedAt"], code: "invalid_string"},
  "report-invalid-photo-without-operation-id.json": {path: ["operationId"], code: "invalid_type"},
}
const INVALID_ENVELOPES = ["report-invalid-empty-batch.json"]

const issuePaths = (issues: ZodIssue[]) => issues.map((issue) => issue.path.join("."))

describe("report fixtures", () => {
  test("every invalid fixture is accounted for", () => {
    expect(withPrefix("report-invalid-")).toEqual([...Object.keys(INVALID_RECORDS), ...INVALID_ENVELOPES].sort())
  })

  test("the directory holds report and ack fixtures only", () => {
    expect(fixtureNames.filter((name) => !/^(report|ack)-(valid|invalid)-/.test(name))).toEqual([])
  })

  for (const name of withPrefix("report-valid-")) {
    test(`${name} is a valid report whose every record parses`, () => {
      const report = load(name)
      expect(FleetReportSchema.safeParse(report).success).toBe(true)
      for (const record of report.records) {
        const parsed = FleetRecordSchema.safeParse(record)
        expect(parsed.success ? null : parsed.error.issues).toBeNull()
      }
    })
  }

  for (const [name, expected] of Object.entries(INVALID_RECORDS)) {
    test(`${name} passes the envelope and fails its record at ${expected.path.join(".") || "the record"}`, () => {
      const report = load(name)
      expect(FleetReportSchema.safeParse(report).success).toBe(true)
      const parsed = FleetRecordSchema.safeParse(report.records[0])
      expect(parsed.success).toBe(false)
      if (parsed.success) return
      expect(parsed.error.issues.map((issue) => ({path: issue.path, code: issue.code}))).toContainEqual(expected)
    })
  }

  for (const name of INVALID_ENVELOPES) {
    test(`${name} fails the envelope`, () => {
      const parsed = FleetReportSchema.safeParse(load(name))
      expect(parsed.success).toBe(false)
      if (!parsed.success) expect(issuePaths(parsed.error.issues)).toEqual(["records"])
    })
  }

  test("the email fixture is refused for its unknown key, which pins .strict()", () => {
    const parsed = FleetRecordSchema.safeParse(load("report-invalid-email-identity.json").records[0])
    expect(parsed.success).toBe(false)
    if (!parsed.success) expect(parsed.error.issues[0]).toMatchObject({code: "unrecognized_keys", keys: ["email"]})
  })
})

describe("envelope", () => {
  test("refuses an unknown top-level property", () => {
    const report = {...load("report-valid-snapshot.json"), email: "someone@example.com"}
    expect(FleetReportSchema.safeParse(report).success).toBe(false)
  })

  test("accepts exactly the per-batch record limit", () => {
    const record = loadRecord("report-valid-snapshot.json")
    const batch = (count: number) => ({schemaVersion: 1, records: Array.from({length: count}, () => record)})
    expect(FleetReportSchema.safeParse(batch(FLEET_LIMITS.maxRecordsPerBatch)).success).toBe(true)
    expect(FleetReportSchema.safeParse(batch(FLEET_LIMITS.maxRecordsPerBatch + 1)).success).toBe(false)
  })

  test("refuses an unsupported schema version at the envelope and the record", () => {
    expect(FleetReportSchema.safeParse({...load("report-valid-snapshot.json"), schemaVersion: 2}).success).toBe(false)
    expect(FleetRecordSchema.safeParse({...loadRecord("report-valid-snapshot.json"), schemaVersion: 2}).success).toBe(
      false,
    )
  })

  test("leaves records unvalidated so one bad record cannot strand a batch", () => {
    const good = loadRecord("report-valid-snapshot.json")
    const bad = load("report-invalid-offset-time.json").records[0]
    expect(FleetReportSchema.safeParse({schemaVersion: 1, records: [good, bad, "not even an object"]}).success).toBe(
      true,
    )
  })
})

describe("record", () => {
  test("times must be UTC with a Z, a real date, and at most millisecond precision", () => {
    const record = loadRecord("report-valid-snapshot.json")
    const parse = (observedAt: string) => FleetRecordSchema.safeParse({...record, observedAt}).success
    expect(parse("2026-10-13T11:00:00Z")).toBe(true)
    expect(parse("2026-10-13T11:00:00.123Z")).toBe(true)
    expect(parse("2026-10-13T11:00:00.1234Z")).toBe(false)
    expect(parse("2026-10-13T11:00:00+00:00")).toBe(false)
    expect(parse("2026-13-45T11:00:00Z")).toBe(false)
    expect(parse("2026-10-13")).toBe(false)
  })

  test("identifiers are bounded and restricted to a safe alphabet", () => {
    const record = loadRecord("report-valid-snapshot.json")
    const parse = (recordId: string) => FleetRecordSchema.safeParse({...record, recordId}).success
    expect(parse("rec:abc_1.2-3")).toBe(true)
    expect(parse("someone@example.com")).toBe(false)
    expect(parse("has space")).toBe(false)
    expect(parse("")).toBe(false)
    expect(parse("r".repeat(129))).toBe(false)
  })

  test("a miniapp launch carries the display name and no visibility", () => {
    const record = loadRecord("report-valid-miniapp-launch.json")
    expect(record.payload.miniappName).toBe("Acme Inventory")
    expect(FleetRecordSchema.safeParse(record).success).toBe(true)
    record.payload.visibility = "private"
    expect(FleetRecordSchema.safeParse(record).success).toBe(false)
  })

  test("a miniapp launch carries no glasses identity", () => {
    const record = loadRecord("report-valid-miniapp-launch.json")
    record.deviceBinding = {kind: "provisional", bindingId: "bind-5c21e0", product: "mentra_live"}
    expect(FleetRecordSchema.safeParse(record).success).toBe(false)
  })

  test("a photo stage failed names the stage it failed at, and only then", () => {
    const record = loadRecord("report-valid-photo-operation.json")
    const parse = (payload: Json) => FleetRecordSchema.safeParse({...record, payload}).success
    expect(parse({stage: "failed", failedStage: "captured"})).toBe(true)
    expect(parse({stage: "failed"})).toBe(false)
    expect(parse({stage: "captured", failedStage: "captured"})).toBe(false)
  })

  test("a battery level goes with the measured state only", () => {
    const record = loadRecord("report-valid-snapshot.json")
    const parse = (battery: Json) => {
      const next = structuredClone(record)
      next.payload.glasses.battery = battery
      return FleetRecordSchema.safeParse(next).success
    }
    const observedAt = "2026-10-13T11:00:00Z"
    expect(parse({state: "measured", observedAt, level: 0})).toBe(true)
    expect(parse({state: "measured", observedAt, level: 101})).toBe(false)
    expect(parse({state: "unknown", observedAt})).toBe(true)
    expect(parse({state: "unknown", observedAt, level: 0})).toBe(false)
  })
})

describe("usage checkpoint", () => {
  const sessions = () => loadRecord("report-valid-usage-packed.json").payload.sessions as Json[]
  const withSessions = (next: Json[]) => {
    const record = loadRecord("report-valid-usage-packed.json")
    record.payload.sessions = next
    return FleetRecordSchema.safeParse(record)
  }
  const sessionOf = (activity: string) => structuredClone(sessions().find((session) => session.activity === activity)!)

  test("packs every open activity session into one record", () => {
    const packed = sessions()
    expect(packed.map((session) => session.activity)).toEqual([
      "glasses_connection",
      "miniapp_execution",
      "miniapp_execution",
      "app_foreground",
      "engine_active",
    ])
    expect(withSessions(packed).success).toBe(true)
  })

  test("holds at most the per-checkpoint session limit", () => {
    const session = sessionOf("app_foreground")
    const many = (count: number) => Array.from({length: count}, (_, i) => ({...session, activitySessionId: `act-${i}`}))
    expect(withSessions(many(FLEET_LIMITS.maxSessionsPerCheckpoint)).success).toBe(true)
    const tooMany = withSessions(many(FLEET_LIMITS.maxSessionsPerCheckpoint + 1))
    expect(tooMany.success).toBe(false)
    if (!tooMany.success) expect(issuePaths(tooMany.error.issues)).toEqual(["payload.sessions"])
    expect(withSessions([]).success).toBe(false)
  })

  test("a miniapp_execution session needs a packageName, and only that activity may have one", () => {
    const execution = sessionOf("miniapp_execution")
    delete execution.packageName
    expect(withSessions([execution]).success).toBe(false)

    const foreground = {...sessionOf("app_foreground"), packageName: "com.mentra.notes"}
    expect(withSessions([foreground]).success).toBe(false)
  })

  test("a glasses_connection session needs a deviceBinding, and only that activity may have one", () => {
    const connection = sessionOf("glasses_connection")
    delete connection.deviceBinding
    expect(withSessions([connection]).success).toBe(false)

    const provisional = {
      ...sessionOf("glasses_connection"),
      deviceBinding: {kind: "provisional", bindingId: "bind-1", product: "mentra_live"},
    }
    expect(withSessions([provisional]).success).toBe(true)

    const execution = {...sessionOf("miniapp_execution"), deviceBinding: sessionOf("glasses_connection").deviceBinding}
    expect(withSessions([execution]).success).toBe(false)
  })

  test("elapsed time is a non-negative integer no longer than a week", () => {
    const base = sessionOf("app_foreground")
    const parse = (elapsedMs: number) => withSessions([{...base, elapsedMs}]).success
    expect(parse(0)).toBe(true)
    expect(parse(FLEET_LIMITS.maxSessionElapsedMs)).toBe(true)
    expect(parse(FLEET_LIMITS.maxSessionElapsedMs + 1)).toBe(false)
    expect(parse(-1)).toBe(false)
    expect(parse(1.5)).toBe(false)
  })

  test("a record carries no top-level deviceBinding", () => {
    const record = loadRecord("report-valid-usage-packed.json")
    record.deviceBinding = sessionOf("glasses_connection").deviceBinding
    expect(FleetRecordSchema.safeParse(record).success).toBe(false)
  })
})

describe("acknowledgement", () => {
  test("accepts a mixed result, each carrying the record's index", () => {
    const parsed = FleetReportAckSchema.safeParse(load("ack-valid-mixed.json"))
    expect(parsed.success).toBe(true)
    if (parsed.success) expect(parsed.data.results.map((result) => result.index)).toEqual([0, 1, 2, 3, 4])
  })

  for (const name of withPrefix("ack-invalid-")) {
    test(`${name} is refused`, () => {
      expect(FleetReportAckSchema.safeParse(load(name)).success).toBe(false)
    })
  }

  test("refuses a reasonCode on an accepted result and requires one on a rejected result", () => {
    const parsed = FleetReportAckSchema.safeParse(load("ack-invalid-reason-on-accepted.json"))
    expect(parsed.success).toBe(false)
    if (!parsed.success) expect(parsed.error.issues[0]?.path).toEqual(["results", 0])

    const rejected = FleetReportAckSchema.safeParse(load("ack-invalid-rejected-without-reason.json"))
    expect(rejected.success).toBe(false)
    if (!rejected.success) expect(rejected.error.issues[0]?.path).toEqual(["results", 0])
  })

  test("a reasonCode goes with the rejected status, and only with it", () => {
    const parse = (result: Json) => FleetRecordResultSchema.safeParse({index: 0, ...result}).success
    for (const status of ["accepted", "duplicate", "retryable"]) {
      expect(parse({status})).toBe(true)
      expect(parse({status, reasonCode: "schema_invalid"})).toBe(false)
    }
    expect(parse({status: "rejected", reasonCode: "account_deleted"})).toBe(true)
    expect(parse({status: "rejected"})).toBe(false)
    expect(parse({status: "rejected", reasonCode: "made_up"})).toBe(false)
  })

  test("a result can omit recordId, because the record's own ID may be what failed", () => {
    expect(
      FleetRecordResultSchema.safeParse({index: 3, status: "rejected", reasonCode: "schema_invalid"}).success,
    ).toBe(true)
    expect(FleetRecordResultSchema.safeParse({status: "accepted", recordId: "rec-1"}).success).toBe(false)
  })

  test("refuses an unknown property on a result and on the acknowledgement", () => {
    expect(FleetRecordResultSchema.safeParse({index: 0, status: "accepted", email: "a@b.c"}).success).toBe(false)
    expect(FleetReportAckSchema.safeParse({...load("ack-valid-mixed.json"), requestId: "req-1"}).success).toBe(false)
  })

  test("whole-response errors are the two codes the fixtures carry, and are not acknowledgements", () => {
    expect(load("ack-valid-not-installed.json").error).toBe(FLEET_NOT_INSTALLED)
    expect(load("ack-valid-unavailable.json").error).toBe(FLEET_UNAVAILABLE)
    expect([FLEET_NOT_INSTALLED, FLEET_UNAVAILABLE]).not.toContain(load("ack-invalid-unknown-error.json").error)
    for (const name of ["ack-valid-not-installed.json", "ack-valid-unavailable.json"])
      expect(FleetReportAckSchema.safeParse(load(name)).success).toBe(false)
  })
})
