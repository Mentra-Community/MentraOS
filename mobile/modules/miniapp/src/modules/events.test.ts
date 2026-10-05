import {expect, test} from "bun:test"
import {EventManager} from "./events"
import type {MiniappSession} from "../session"

test("registers each transcription handler and dispatches only to the addressed live listener", () => {
  const updates: Array<Record<string, any>> = []
  const events = new EventManager({
    sendOneShot: (payload: Record<string, any>) => updates.push(payload),
  } as MiniappSession)
  const early: unknown[] = [],
    late: unknown[] = []
  const off = events.subscribe("transcription:auto", (data) => early.push(data))
  events.subscribe("transcription:en", (data) => late.push(data))
  const registrations = updates.at(-1)!.transcriptionListeners
  expect(registrations.length).toBe(2)
  events._forwardEvent("transcription:en", {text: "suffix"}, "default", registrations[1].id)
  expect(early).toEqual([])
  expect(late).toEqual([{text: "suffix"}])
  off()
  const count = updates.length
  off()
  expect(updates.length).toBe(count)
  events._forwardEvent("transcription:en", {text: "stale"}, "default", registrations[0].id)
  expect(early).toEqual([])
  events.unsubscribeAll()
  events.subscribe("transcription:auto", (data) => early.push(data))
  events._forwardEvent("transcription:en", {text: "retired"}, "default", registrations[1].id)
  expect(late).toHaveLength(1)
})

test("ordinary fanout cancellation and old closures cannot remove current demand", () => {
  const updates: Array<Record<string, any>> = []
  const events = new EventManager({
    sendOneShot: (payload: Record<string, any>) => updates.push(payload),
  } as MiniappSession)
  let calls = 0
  let offSecond = () => {}
  const offFirst = events.subscribe("location_update", () => offSecond())
  offSecond = events.subscribe("location_update", () => {
    calls += 1
  })
  events._forwardEvent("location_update", {})
  expect(calls).toBe(0)
  events.unsubscribeAll()
  events.subscribe("location_update", () => {})
  offFirst()
  expect(updates.at(-1)!.subscriptions).toEqual([{stream: "location_stream", rate: "realtime"}])
})

test("replacement sessions cannot reuse a retired listener's identity", () => {
  const updates: Array<Record<string, any>> = []
  const session = {sendOneShot: (payload: Record<string, any>) => updates.push(payload)} as MiniappSession
  const old = new EventManager(session), replacement = new EventManager(session)
  old.subscribe("transcription:auto", () => {})
  const oldId = updates.at(-1)!.transcriptionListeners[0].id
  let calls = 0
  replacement.subscribe("transcription:auto", () => {calls += 1})
  replacement._forwardEvent("transcription:en", {}, "default", oldId)
  expect(calls).toBe(0)
})

test("additional handlers update registration without adding upstream stream demand", () => {
  const updates: Array<Record<string, any>> = []
  const events = new EventManager({sendOneShot: (payload: Record<string, any>) => updates.push(payload)} as MiniappSession)
  const first = events.subscribe("transcription:auto", () => {})
  const initial = updates.at(-1)!
  const second = events.subscribe("transcription:auto", () => {})
  expect(updates.at(-1)!.subscriptions).toEqual(initial.subscriptions)
  expect(updates.at(-1)!.transcriptionListeners).toHaveLength(2)
  first()
  expect(updates.at(-1)!.subscriptions).toEqual(initial.subscriptions)
  expect(updates.at(-1)!.transcriptionListeners).toHaveLength(1)
  second()
  expect(updates.at(-1)!.subscriptions).toEqual([])
})
