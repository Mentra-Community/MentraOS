import {describe, expect, test} from "bun:test"
import {
  FLEET_CONNECTION_CATEGORIES,
  FLEET_CRASH_CATEGORIES,
  FLEET_INSTALL_FAILURE_REASONS,
  FLEET_LAUNCH_FAILURE_REASONS,
  FLEET_TELEMETRY_LIMITS,
  FleetRecordSchema,
} from "./fleet"

const T = "2026-10-29T09:30:00Z"

const base = {
  schemaVersion: 1,
  recordId: "rec_1",
  phoneDeviceId: "phone_1",
  collectorSessionId: "col_1",
  sequence: 4,
  observedAt: T,
  capabilities: ["miniapp_telemetry"],
}

const record = (kind: string, payload: Record<string, unknown>, overrides: Record<string, unknown> = {}) => ({
  ...base,
  kind,
  payload,
  ...overrides,
})
const parses = (value: unknown) => FleetRecordSchema.safeParse(value).success

const event = (payload: Record<string, unknown> = {}) =>
  record("telemetry_event", {
    packageName: "com.mentra.call",
    versionName: "2.1.73",
    executionSessionId: "01M64N9HGW4JQ7SPCRPZPATREM",
    event: "call_ended",
    properties: {platform: "teams", mode: "joined", duration_s: 312, outcome: "completed", recorded: false},
    droppedProperties: 0,
    cutValues: 0,
    ...payload,
  })

describe("miniapp_launch failure reasons", () => {
  const launch = (payload: Record<string, unknown>) =>
    record("miniapp_launch", {packageName: "com.mentra.call", start: "user", outcome: "failed", ...payload})

  test("a failed launch carries any reason, or none from an older Mentra App", () => {
    for (const failureReason of FLEET_LAUNCH_FAILURE_REASONS) expect(parses(launch({failureReason}))).toBe(true)
    expect(parses(launch({}))).toBe(true)
  })

  test("a started launch carries no reason, and an unknown reason is refused", () => {
    expect(parses(launch({outcome: "started", failureReason: "spawn_failed"}))).toBe(false)
    expect(parses(launch({failureReason: "it broke"}))).toBe(false)
  })
})

describe("telemetry_event", () => {
  test("parses its fixture", () => {
    expect(parses(event())).toBe(true)
  })

  test("names are lowercase letters, digits and underscores, starting with a letter, up to 64", () => {
    expect(parses(event({event: "a".repeat(64)}))).toBe(true)
    for (const name of ["", "Call_ended", "1call", "_call", "call-ended", "call ended", "a".repeat(65)])
      expect(parses(event({event: name}))).toBe(false)
    expect(parses(event({properties: {Platform: "teams"}}))).toBe(false)
    expect(parses(event({properties: {__proto__x: 1}}))).toBe(false)
  })

  test("values are flat: a string of at most 64 characters, a finite number or a boolean", () => {
    expect(parses(event({properties: {s: "x".repeat(FLEET_TELEMETRY_LIMITS.maxStringValueLength)}}))).toBe(true)
    expect(parses(event({properties: {s: "x".repeat(65)}}))).toBe(false)
    for (const bad of [null, {a: 1}, [1], Number.POSITIVE_INFINITY, Number.NaN])
      expect(parses(event({properties: {p: bad}}))).toBe(false)
  })

  test("at most 25 properties", () => {
    const props = (n: number) => Object.fromEntries(Array.from({length: n}, (_, i) => [`p${i}`, i]))
    expect(parses(event({properties: props(25)}))).toBe(true)
    expect(parses(event({properties: props(26)}))).toBe(false)
  })

  test("an event with no properties, version or session parses", () => {
    expect(parses(event({properties: {}, versionName: undefined, executionSessionId: undefined}))).toBe(true)
  })
})

describe("telemetry_loss", () => {
  const loss = (payload: Record<string, unknown> = {}) =>
    record("telemetry_loss", {
      from: "2026-10-29T08:00:00Z",
      to: T,
      losses: [{packageName: "com.mentra.call", overLimit: 3, evicted: 0, expired: 0, rejected: 1}],
      ...payload,
    })

  test("parses its fixture", () => {
    expect(parses(loss())).toBe(true)
  })

  test("each package counts something, and the period runs forward", () => {
    expect(parses(loss({losses: [{packageName: "p", overLimit: 0, evicted: 0, expired: 0, rejected: 0}]}))).toBe(false)
    expect(parses(loss({losses: []}))).toBe(false)
    expect(parses(loss({from: T, to: "2026-10-29T08:00:00Z"}))).toBe(false)
  })
})

describe("miniapp_crash", () => {
  const crash = (payload: Record<string, unknown> = {}) =>
    record("miniapp_crash", {
      packageName: "com.mentra.call",
      versionName: "2.1.73",
      surface: "context",
      category: "unresponsive",
      outcome: "respawn_scheduled",
      crashesInWindow: 1,
      ...payload,
    })

  test("parses every category, both surfaces and both outcomes", () => {
    for (const category of FLEET_CRASH_CATEGORIES) expect(parses(crash({category}))).toBe(true)
    expect(parses(crash({surface: "webview", outcome: "crash_loop_stopped", crashesInWindow: 4}))).toBe(true)
    expect(parses(crash({surface: "webview", category: "content_process_terminated", outcome: "closed"}))).toBe(true)
    expect(parses(crash({outcome: "restarted_later"}))).toBe(false)
  })

  test("carries no reason text", () => {
    expect(parses(crash({reason: "TypeError: x is undefined"}))).toBe(false)
    expect(parses(crash({crashesInWindow: 0}))).toBe(false)
  })
})

describe("miniapp_install", () => {
  const install = (payload: Record<string, unknown> = {}) =>
    record("miniapp_install", {
      packageName: "com.mentra.notes",
      operation: "update",
      source: "assignment",
      fromVersion: "1.2.0",
      toVersion: "1.3.0",
      outcome: "failed",
      reason: "storage_full",
      ...payload,
    })

  test("a failed or deferred attempt carries a reason; a success carries none", () => {
    for (const reason of FLEET_INSTALL_FAILURE_REASONS) expect(parses(install({reason}))).toBe(true)
    expect(parses(install({outcome: "deferred", reason: "user_cancelled"}))).toBe(true)
    expect(parses(install({outcome: "succeeded", reason: undefined}))).toBe(true)
    expect(parses(install({outcome: "succeeded"}))).toBe(false)
    expect(parses(install({reason: undefined}))).toBe(false)
  })

  test("a removal names no new version", () => {
    expect(parses(install({operation: "remove", source: "url", toVersion: undefined, outcome: "succeeded", reason: undefined}))).toBe(true)
  })
})

describe("connection_event", () => {
  const binding = {kind: "provisional", bindingId: "7RZZT67TX9X46DX31KGETRTRT3", product: "Mentra Live"}
  const connection = (payload: Record<string, unknown> = {}, overrides: Record<string, unknown> = {}) =>
    record(
      "connection_event",
      {event: "disconnected", category: "link_lost", glassesModel: "Mentra Live", appVersion: "3.4.0", ...payload},
      {deviceBinding: binding, ...overrides},
    )

  test("parses every category, with or without the glasses", () => {
    for (const category of FLEET_CONNECTION_CATEGORIES) expect(parses(connection({category}))).toBe(true)
    expect(parses(connection({event: "pair_failed", category: "bond_failed", glassesModel: undefined}, {deviceBinding: undefined}))).toBe(true)
  })

  test("only a reconnect carries the time it took", () => {
    expect(parses(connection({event: "reconnected", reconnectMs: 9_000}))).toBe(true)
    expect(parses(connection({event: "reconnected"}))).toBe(false)
    expect(parses(connection({reconnectMs: 9_000}))).toBe(false)
  })
})

describe("Phase 12 records name no account, email or workspace", () => {
  test.each([
    ["accountId", "mu_1"],
    ["email", "a@b.co"],
    ["workspaceId", "ws_1"],
  ])("%s is refused", (field, value) => {
    expect(parses({...event(), [field]: value})).toBe(false)
    expect(parses(event({[field]: value}))).toBe(false)
  })
})
