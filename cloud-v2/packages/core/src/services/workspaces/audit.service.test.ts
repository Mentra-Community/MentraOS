/**
 * The audit writers' writes, without a database: how many go to the feed's counter and to the events
 * collection, with what, and in which session. That the events land and read back as the feed's, one at
 * a time or in a batch, is in `cloud-v2/tests/licenses.integration.test.ts`, against a local replica set.
 */
import {afterEach, describe, expect, spyOn, test} from "bun:test"
import type {ClientSession} from "mongoose"
import {WORKSPACE_AUDIT_COUNTER_ID, WorkspaceAuditCounterModel} from "../../models/workspace-audit-counter.model"
import {WorkspaceAuditEventModel} from "../../models/workspace-audit-event.model"
import {recordWorkspaceEvent, recordWorkspaceEvents, type WorkspaceAuditEventInput} from "./audit.service"

type Document = Record<string, unknown>

const session = {fake: "session"} as unknown as ClientSession
const restores: Array<() => void> = []

afterEach(() => {
  for (const restore of restores.splice(0)) restore()
})

/** The feed's counter, at `seq` so far: each increment adds to it and answers the new value. */
function counterAt(seq: number) {
  let value = seq
  const spy = spyOn(WorkspaceAuditCounterModel, "findOneAndUpdate").mockImplementation(((
    _filter: unknown,
    update: {$inc: {seq: number}},
  ) => {
    value += update.$inc.seq
    const answer = {_id: WORKSPACE_AUDIT_COUNTER_ID, seq: value}
    return {lean: () => Promise.resolve(answer)}
  }) as never)
  restores.push(() => spy.mockRestore())
  return spy
}

/** The events collection's writes: what each `create` and `insertMany` was given, and with which options. */
function eventWrites() {
  const create = spyOn(WorkspaceAuditEventModel, "create").mockImplementation((async () => []) as never)
  const insertMany = spyOn(WorkspaceAuditEventModel, "insertMany").mockImplementation((async () => []) as never)
  restores.push(
    () => create.mockRestore(),
    () => insertMany.mockRestore(),
  )
  const calls = (spy: {mock: {calls: unknown[][]}}) => spy.mock.calls as unknown as Array<[Document[], unknown]>
  return {create: () => calls(create), insertMany: () => calls(insertMany)}
}

const event = (n: number): WorkspaceAuditEventInput => ({
  workspaceId: "ws_1",
  action: "seat.assigned",
  actor: {kind: "user", mentraUserId: "mu_admin", email: "admin@example.test"},
  target: {licenseId: "lic_1", membershipId: `wm_${n}`},
  before: null,
  after: {seatsUsed: n},
})

/** A stored event without what is minted for it (its id, time and `seq`). */
const comparable = ({eventId, occurredAt, seq, ...rest}: Document) => rest

describe("recordWorkspaceEvents", () => {
  test("takes its numbers in one increment and writes its events in one insert, in the caller's session", async () => {
    const counter = counterAt(41)
    const writes = eventWrites()
    const events = [event(1), event(2), event(3)]

    const eventIds = await recordWorkspaceEvents(session, events)

    expect(counter.mock.calls).toEqual([
      [
        {_id: WORKSPACE_AUDIT_COUNTER_ID},
        {$inc: {seq: 3}},
        {upsert: true, new: true, setDefaultsOnInsert: false, session},
      ],
    ])
    expect(writes.create()).toEqual([])
    expect(writes.insertMany()).toHaveLength(1)
    const [documents, options] = writes.insertMany()[0]!
    expect(options).toEqual({session})
    // In order, numbered from the first taken up to the counter's new value, with ids minted in that order.
    expect(documents.map((document) => document.seq)).toEqual([42, 43, 44])
    expect(documents.map((document) => document.eventId)).toEqual(eventIds)
    expect(new Set(eventIds).size).toBe(3)
    expect([...eventIds].sort()).toEqual(eventIds)
    expect(documents.map(comparable)).toEqual(events.map((input) => ({...input, requestId: null})))
    for (const document of documents) expect(document.occurredAt).toBeInstanceOf(Date)
  })

  test("its events are the documents one write per event would store, numbered on from them", async () => {
    const counter = counterAt(41)
    const writes = eventWrites()
    const events = [event(1), event(2), event(3)]

    for (const input of events) await recordWorkspaceEvent(session, input)
    await recordWorkspaceEvents(session, events)

    // One at a time takes a number and makes an insert per event; the batch takes its three in one each.
    expect(counter.mock.calls.map(([, update]) => update)).toEqual([
      {$inc: {seq: 1}},
      {$inc: {seq: 1}},
      {$inc: {seq: 1}},
      {$inc: {seq: 3}},
    ])
    const oneByOne = writes.create().map(([documents, options]) => {
      expect(options).toEqual({session})
      expect(documents).toHaveLength(1)
      return documents[0]!
    })
    const [batch] = writes.insertMany()[0]!
    expect(batch.map(comparable)).toEqual(oneByOne.map(comparable))
    expect([...oneByOne, ...batch].map((document) => document.seq)).toEqual([42, 43, 44, 45, 46, 47])
    const eventIds = [...oneByOne, ...batch].map((document) => document.eventId as string)
    expect([...eventIds].sort()).toEqual(eventIds)
  })

  test("an empty batch writes nothing and takes no number", async () => {
    const counter = counterAt(41)
    const writes = eventWrites()

    expect(await recordWorkspaceEvents(session, [])).toEqual([])

    expect(counter).not.toHaveBeenCalled()
    expect(writes.insertMany()).toEqual([])
    expect(writes.create()).toEqual([])
  })
})
