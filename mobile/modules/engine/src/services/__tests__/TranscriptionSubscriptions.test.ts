import {describe, expect, test} from "bun:test"
import type {TranscriptionToken} from "@mentra/cloud-protocol"
import {TranscriptionSubscriptions} from "../TranscriptionSubscriptions"

const cursor = (offsetMs: number, sessionTag = 1) => ({sessionTag, offsetMs})
const token = (text: string, offsetMs: number, sessionTag = 1): TranscriptionToken => ({
  text,
  startMs: offsetMs,
  endMs: offsetMs + 10,
  confidence: 1,
  isFinal: true,
  audioPosition: cursor(offsetMs, sessionTag),
})

describe("runtime transcription projection", () => {
  test("late listeners and resubscriptions receive their own suffix, including finals", () => {
    const subscriptions = new TranscriptionSubscriptions()
    const early = {id: "early", stream: "transcription:auto"}
    const late = {id: "late", stream: "transcription:en"}
    subscriptions.replace([early], cursor(0))
    subscriptions.replace([early, late], cursor(20))
    const tokens = [token("BEFORE ", 0), token("AFTER", 20)]
    expect(subscriptions.project("transcription:en", tokens, cursor(30), "default")).toEqual([
      {listenerId: "early", text: "BEFORE AFTER"},
      {listenerId: "late", text: "AFTER"},
    ])
    subscriptions.replace([early], cursor(30))
    subscriptions.replace([early, {...late, id: "resumed"}], cursor(40))
    tokens.push(token(" PAUSED", 30), token(" RESUMED", 40))
    expect(subscriptions.project("transcription:en", tokens, cursor(50), "default")).toEqual([
      {listenerId: "early", text: "BEFORE AFTER PAUSED RESUMED"},
      {listenerId: "resumed", text: "RESUMED"},
    ])
  })

  test("crossing tokens and missing timing are excluded; new sessions do not admit old audio", () => {
    const subscriptions = new TranscriptionSubscriptions()
    subscriptions.replace([{id: "one", stream: "transcription:auto"}], cursor(10))
    const tokens = [token("OLD", 9), {...token("UNKNOWN", 10), audioPosition: undefined}, token("NEW", 10)]
    expect(subscriptions.project("transcription:en", tokens, cursor(20), "default")).toEqual([
      {listenerId: "one", text: "NEW"},
    ])
    tokens.push(token(" SESSION TWO", 0, 2))
    expect(subscriptions.project("transcription:en", tokens, cursor(10, 2), "default")).toEqual([
      {listenerId: "one", text: "NEW SESSION TWO"},
    ])
    subscriptions.observe(cursor(0, 3))
    tokens.push(token(" SESSION THREE", 0, 3))
    expect(subscriptions.project("transcription:en", tokens, null, "default")).toEqual([
      {listenerId: "one", text: "NEW SESSION TWO SESSION THREE"},
    ])
    subscriptions.replace([{id: "late", stream: "transcription:auto"}], cursor(5, 2))
    expect(subscriptions.project("transcription:en", tokens, cursor(10, 2), "default")).toEqual([])
  })

  test("a registration during disconnect does not inherit the previous audio session", () => {
    const subscriptions = new TranscriptionSubscriptions()
    subscriptions.replace([{id: "early", stream: "transcription:auto"}], cursor(0))
    subscriptions.replace([
      {id: "early", stream: "transcription:auto"}, {id: "late", stream: "transcription:auto"},
    ], null)
    expect(subscriptions.project("transcription:en", [token("OLD", 0)], null, "default")).toEqual([
      {listenerId: "early", text: "OLD"},
    ])
    subscriptions.observe(cursor(0, 2))
    expect(subscriptions.project("transcription:en", [token("OLD ", 0), token("NEW", 0, 2)], cursor(10, 2), "default")).toEqual([
      {listenerId: "early", text: "OLD NEW"}, {listenerId: "late", text: "NEW"},
    ])
  })

  test("preserves route isolation and legacy stream dispatch", () => {
    const subscriptions = new TranscriptionSubscriptions()
    subscriptions.replace(
      [
        {id: "cloud", stream: "transcription:auto"},
        {id: "local", stream: "transcription:auto", forceLocal: true},
        {id: "legacy", stream: "transcription:en", legacy: true},
      ],
      cursor(0),
    )
    expect(subscriptions.project("transcription:en", [token("text", 0)], cursor(10), "default")).toEqual([
      {listenerId: "cloud", text: "text"},
      {listenerId: undefined, text: "text"},
    ])
    expect(subscriptions.project("transcription:fr", [], cursor(10), "default")).toEqual([])
  })
})
