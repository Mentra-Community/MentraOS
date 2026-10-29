import {describe, expect, test} from "bun:test"
import {
  SCHEMA_POLL_INTERVAL_MS,
  SCHEMA_WAIT_TIMEOUT_MS,
  waitForSchema,
  type RequiredSchema,
  type SchemaReader,
} from "./database-schema-wait"

const REQUIRED: RequiredSchema = {
  collections: ["workspace_audit_counters"],
  indexes: [{collection: "workspace_audit_events", key: {seq: 1}}],
}

/** A database whose state at each look (1st, 2nd, ...) is given by `stateAt`, and a clock that only sleeping moves. */
function fakeDatabase(
  stateAt: (look: number) => {collections: string[]; indexes: Array<{key: Record<string, unknown>; unique?: boolean}>},
) {
  let looks = 0
  let clock = 0
  const sleeps: number[] = []
  const reader: SchemaReader = {
    async collectionNames() {
      looks += 1
      return stateAt(looks).collections
    },
    async indexes() {
      return stateAt(looks).indexes
    },
  }
  const options = {
    label: "ci-fresh",
    sleep: async (ms: number) => {
      sleeps.push(ms)
      clock += ms
    },
    now: () => clock,
    log: () => {},
  }
  return {reader, options, sleeps, looks: () => looks}
}

const BUILT = {
  collections: ["workspace_audit_counters", "workspace_audit_events"],
  indexes: [{key: {_id: 1}}, {key: {seq: 1}}],
}
const BUILDING = {collections: ["workspace_audit_counters", "workspace_audit_events"], indexes: [{key: {_id: 1}}]}

describe("waitForSchema", () => {
  test("uses a two second interval and a two minute deadline", () => {
    expect(SCHEMA_POLL_INTERVAL_MS).toBe(2_000)
    expect(SCHEMA_WAIT_TIMEOUT_MS).toBe(120_000)
  })

  test("passes at once, without sleeping, when everything is already built", async () => {
    const db = fakeDatabase(() => BUILT)
    expect(await waitForSchema(db.reader, REQUIRED, db.options)).toEqual({waitedMs: 0})
    expect(db.looks()).toBe(1)
    expect(db.sleeps).toEqual([])
  })

  test("passes when an index that was missing is listed on the third look", async () => {
    const db = fakeDatabase((look) => (look < 3 ? BUILDING : BUILT))
    expect(await waitForSchema(db.reader, REQUIRED, db.options)).toEqual({waitedMs: 4_000})
    expect(db.looks()).toBe(3)
    expect(db.sleeps).toEqual([2_000, 2_000])
  })

  test("waits for a missing collection as well", async () => {
    const db = fakeDatabase((look) =>
      look < 2 ? {collections: ["workspace_audit_events"], indexes: BUILT.indexes} : BUILT,
    )
    await waitForSchema(db.reader, REQUIRED, db.options)
    expect(db.looks()).toBe(2)
  })

  test("fails on a missing index only at the deadline, and says how long it waited", async () => {
    const db = fakeDatabase(() => BUILDING)
    const error = await waitForSchema(db.reader, REQUIRED, db.options).then(
      () => null,
      (thrown: Error) => thrown,
    )
    expect(error).toBeInstanceOf(Error)
    expect(error!.message).toContain('workspace_audit_events has no index on {"seq":1}')
    expect(error!.message).toContain("after waiting 120 s")
    expect(error!.message).toContain("ci-fresh")
    expect(error!.message).toContain("failed to create workspace collection indexes")
    // A look at the start, then every two seconds up to and including the deadline.
    expect(db.looks()).toBe(61)
    expect(db.sleeps.reduce((sum, ms) => sum + ms, 0)).toBe(120_000)
    expect(db.sleeps.every((ms) => ms === 2_000)).toBe(true)
  })

  test("reports every problem still missing at the deadline", async () => {
    const db = fakeDatabase(() => ({collections: [], indexes: []}))
    const error = await waitForSchema(db.reader, REQUIRED, {...db.options, timeoutMs: 6_000}).catch(
      (thrown: Error) => thrown,
    )
    expect((error as Error).message).toContain("collection workspace_audit_counters does not exist")
    expect((error as Error).message).toContain('workspace_audit_events has no index on {"seq":1}')
    expect((error as Error).message).toContain("after waiting 6 s")
    expect(db.looks()).toBe(4)
  })

  test("does not sleep past the deadline when the interval does not divide it", async () => {
    const db = fakeDatabase(() => BUILDING)
    await waitForSchema(db.reader, REQUIRED, {...db.options, intervalMs: 4_000, timeoutMs: 10_000}).catch(() => {})
    expect(db.sleeps).toEqual([4_000, 4_000, 2_000])
    expect(db.looks()).toBe(4)
  })

  test("fails on a unique index at once instead of waiting out the deadline", async () => {
    const db = fakeDatabase(() => ({...BUILT, indexes: [{key: {seq: 1}, unique: true}]}))
    const error = await waitForSchema(db.reader, REQUIRED, db.options).catch((thrown: Error) => thrown)
    expect((error as Error).message).toContain('workspace_audit_events\'s index on {"seq":1} is unique')
    expect((error as Error).message).toContain("stopped after 0 s")
    expect(db.looks()).toBe(1)
    expect(db.sleeps).toEqual([])
  })

  test("fails on a unique index found while waiting for another, without waiting further", async () => {
    const db = fakeDatabase((look) => (look < 3 ? BUILDING : {...BUILT, indexes: [{key: {seq: 1}, unique: true}]}))
    const error = await waitForSchema(db.reader, REQUIRED, db.options).catch((thrown: Error) => thrown)
    expect((error as Error).message).toContain("is unique")
    expect((error as Error).message).toContain("stopped after 4 s")
    expect(db.looks()).toBe(3)
  })

  test("matches an index on exactly the required key", async () => {
    const db = fakeDatabase(() => ({...BUILT, indexes: [{key: {seq: 1, workspaceId: 1}}, {key: {seq: -1}}]}))
    const error = await waitForSchema(db.reader, REQUIRED, {...db.options, timeoutMs: 2_000}).catch(
      (thrown: Error) => thrown,
    )
    expect((error as Error).message).toContain('has no index on {"seq":1}')
  })

  test("logs once that it is waiting, and once that it is done", async () => {
    const messages: string[] = []
    const db = fakeDatabase((look) => (look < 3 ? BUILDING : BUILT))
    await waitForSchema(db.reader, REQUIRED, {...db.options, log: (message) => messages.push(message)})
    expect(messages).toHaveLength(2)
    expect(messages[0]).toContain("not fully built yet")
    expect(messages[1]).toContain("after 4 s")
  })
})
