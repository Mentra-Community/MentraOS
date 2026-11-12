import {describe, expect, test} from "bun:test"
import type {TranscriptionToken} from "@mentra/cloud-protocol"
import type {TranscriptionSource} from "../TranscriptionRouting"
import {
  addStreamProcessing,
  transcriptionRegistrations,
  TranscriptionSubscriptions,
  type TranscriptionListenerRegistration,
} from "../TranscriptionSubscriptions"

const cursor = (offsetMs: number, sessionTag = 1) => ({sessionTag, offsetMs})
const token = (text: string, offsetMs: number, sessionTag = 1): TranscriptionToken => ({
  text,
  startMs: offsetMs,
  endMs: offsetMs + 10,
  confidence: 1,
  isFinal: true,
  audioPosition: cursor(offsetMs, sessionTag),
})
const cloud = (id: string, stream = "transcription:auto"): TranscriptionListenerRegistration => ({
  id,
  stream,
  processing: "preferCloud",
})
/** Routes every listener to its target right away (nothing mid-utterance). */
const settle = (subscriptions: TranscriptionSubscriptions, target: (processing: string) => TranscriptionSource) =>
  subscriptions.route({
    target: (listener) => target(listener.processing),
    canDeliver: () => true,
    busy: () => false,
    drained: true,
    plannedWatermark: null,
    forcedWatermark: null,
  })
const project = (
  subscriptions: TranscriptionSubscriptions,
  stream: string,
  tokens: TranscriptionToken[],
  at: ReturnType<typeof cursor> | null,
) => subscriptions.deliveries(stream, "cloud", "", tokens, at).map(({listenerId, text}) => ({listenerId, text}))

describe("runtime transcription projection", () => {
  test("late listeners and resubscriptions receive their own suffix, including finals", () => {
    const subscriptions = new TranscriptionSubscriptions()
    const early = cloud("early")
    const late = cloud("late", "transcription:en")
    subscriptions.replace([early], cursor(0))
    subscriptions.replace([early, late], cursor(20))
    settle(subscriptions, () => "cloud")
    const tokens = [token("BEFORE ", 0), token("AFTER", 20)]
    expect(project(subscriptions, "transcription:en", tokens, cursor(30))).toEqual([
      {listenerId: "early", text: "BEFORE AFTER"},
      {listenerId: "late", text: "AFTER"},
    ])
    subscriptions.replace([early], cursor(30))
    subscriptions.replace([early, {...late, id: "resumed"}], cursor(40))
    settle(subscriptions, () => "cloud")
    tokens.push(token(" PAUSED", 30), token(" RESUMED", 40))
    expect(project(subscriptions, "transcription:en", tokens, cursor(50))).toEqual([
      {listenerId: "early", text: "BEFORE AFTER PAUSED RESUMED"},
      {listenerId: "resumed", text: "RESUMED"},
    ])
  })

  test("crossing tokens and missing timing are excluded; new sessions do not admit old audio", () => {
    const subscriptions = new TranscriptionSubscriptions()
    subscriptions.replace([cloud("one")], cursor(10))
    settle(subscriptions, () => "cloud")
    const tokens = [token("OLD", 9), {...token("UNKNOWN", 10), audioPosition: undefined}, token("NEW", 10)]
    expect(project(subscriptions, "transcription:en", tokens, cursor(20))).toEqual([{listenerId: "one", text: "NEW"}])
    tokens.push(token(" SESSION TWO", 0, 2))
    expect(project(subscriptions, "transcription:en", tokens, cursor(10, 2))).toEqual([
      {listenerId: "one", text: "NEW SESSION TWO"},
    ])
    subscriptions.observe(cursor(0, 3))
    tokens.push(token(" SESSION THREE", 0, 3))
    expect(project(subscriptions, "transcription:en", tokens, null)).toEqual([
      {listenerId: "one", text: "NEW SESSION TWO SESSION THREE"},
    ])
    subscriptions.replace([cloud("late")], cursor(5, 2))
    settle(subscriptions, () => "cloud")
    expect(project(subscriptions, "transcription:en", tokens, cursor(10, 2))).toEqual([])
  })

  test("a registration during disconnect does not inherit the previous audio session", () => {
    const subscriptions = new TranscriptionSubscriptions()
    subscriptions.replace([cloud("early")], cursor(0))
    subscriptions.replace([cloud("early"), cloud("late")], null)
    settle(subscriptions, () => "cloud")
    expect(project(subscriptions, "transcription:en", [token("OLD", 0)], null)).toEqual([
      {listenerId: "early", text: "OLD"},
    ])
    subscriptions.observe(cursor(0, 2))
    expect(project(subscriptions, "transcription:en", [token("OLD ", 0), token("NEW", 0, 2)], cursor(10, 2))).toEqual([
      {listenerId: "early", text: "OLD NEW"},
      {listenerId: "late", text: "NEW"},
    ])
  })
})

describe("routing listeners between the cloud and on-device", () => {
  test("each listener gets only the source it is on, tagged with its class", () => {
    const subscriptions = new TranscriptionSubscriptions()
    subscriptions.replace(
      [
        cloud("cloud"),
        {id: "prefer-local", stream: "transcription:en-US", processing: "preferLocal"},
        {id: "local", stream: "transcription:auto", processing: "localOnly"},
      ],
      null,
    )
    settle(subscriptions, (processing) => (processing === "preferCloud" ? "cloud" : "local"))
    expect(subscriptions.deliveries("transcription:en-US", "local", "hi", undefined, null)).toEqual([
      {listenerId: "prefer-local", route: "default", text: "hi"},
      {listenerId: "local", route: "forceLocal", text: "hi"},
    ])
    expect(subscriptions.deliveries("transcription:en-US", "cloud", "hi", undefined, null)).toEqual([
      {listenerId: "cloud", route: "default", text: "hi"},
    ])
    expect(subscriptions.deliveries("transcription:fr-FR", "local", "salut", undefined, null)).toEqual([
      {listenerId: "local", route: "forceLocal", text: "salut"},
    ])
  })

  test("a listener switches only once both sources have settled", () => {
    const subscriptions = new TranscriptionSubscriptions()
    subscriptions.replace([{id: "merge", stream: "transcription:auto", processing: "preferLocal"}], null)
    settle(subscriptions, () => "cloud")
    const busy = new Set<TranscriptionSource>(["cloud"])
    const route = () =>
      subscriptions.route({
        target: () => "local",
        canDeliver: () => true,
        busy: (source) => busy.has(source),
        drained: true,
        plannedWatermark: null,
        forcedWatermark: null,
      })
    // The model became ready mid-sentence: the cloud finishes the sentence.
    expect(route().changed).toBe(true)
    expect(subscriptions.routes()[0]).toMatchObject({source: "cloud", target: "local"})
    expect(subscriptions.switching()).toBe(true)
    busy.add("local")
    busy.delete("cloud")
    route()
    expect(subscriptions.routes()[0].source).toBe("cloud")
    busy.delete("local")
    route()
    expect(subscriptions.routes()[0]).toMatchObject({source: "local", target: "local"})
    expect(subscriptions.switching()).toBe(false)
    // A source that stops is left right away, even mid-utterance.
    busy.add("local")
    subscriptions.route({
      target: () => "cloud",
      canDeliver: (source) => source === "cloud",
      busy: (source) => busy.has(source),
      drained: true,
      plannedWatermark: null,
      forcedWatermark: null,
    })
    expect(subscriptions.routes()[0].source).toBe("cloud")
  })

  test("a planned move waits for a drain and starts cloud text where the drain began", () => {
    const subscriptions = new TranscriptionSubscriptions()
    subscriptions.replace([{id: "captions", stream: "transcription:auto", processing: "preferCloud"}], cursor(0))
    settle(subscriptions, () => "local")
    const handoff = {
      target: () => "cloud" as const,
      canDeliver: () => true,
      busy: () => false,
      drained: false,
      plannedWatermark: cursor(20),
      forcedWatermark: cursor(5),
    }
    expect(subscriptions.route(handoff)).toEqual({changed: true, needsDrain: true})
    expect(subscriptions.routes()[0].source).toBe("local")
    expect(subscriptions.route({...handoff, drained: true})).toEqual({changed: true, needsDrain: false})
    expect(project(subscriptions, "transcription:en", [token("heard ", 10), token("new", 20)], cursor(30))).toEqual([
      {listenerId: "captions", text: "new"},
    ])
  })

  test("a forced move starts cloud text at the last on-device final, completing a cut-short utterance", () => {
    const subscriptions = new TranscriptionSubscriptions()
    subscriptions.replace([{id: "merge", stream: "transcription:auto", processing: "preferLocal"}], cursor(0))
    settle(subscriptions, () => "local")
    subscriptions.route({
      target: () => "cloud",
      canDeliver: (source) => source === "cloud",
      busy: () => true,
      drained: false,
      plannedWatermark: cursor(25),
      forcedWatermark: cursor(5),
    })
    expect(subscriptions.routes()[0].source).toBe("cloud")
    expect(
      project(
        subscriptions,
        "transcription:en",
        [token("finished ", 0), token("hello ", 10), token("world", 20)],
        cursor(30),
      ),
    ).toEqual([{listenerId: "merge", text: "hello world"}])
  })

  test("a watermark never moves a listener's cloud text back before it subscribed", () => {
    const subscriptions = new TranscriptionSubscriptions()
    // The listener subscribed at 200 ms; the last on-device final was at 100 ms.
    subscriptions.replace([{id: "late", stream: "transcription:auto", processing: "preferLocal"}], cursor(200))
    settle(subscriptions, () => "local")
    subscriptions.route({
      target: () => "cloud",
      canDeliver: (source) => source === "cloud",
      busy: () => false,
      drained: false,
      plannedWatermark: null,
      forcedWatermark: cursor(100),
    })
    expect(
      project(subscriptions, "transcription:en", [token("before ", 150), token("after", 250)], cursor(300)),
    ).toEqual([{listenerId: "late", text: "after"}])
    // Nor to a session from before it subscribed.
    subscriptions.replace([{id: "late", stream: "transcription:auto", processing: "preferLocal"}], cursor(0, 3))
    settle(subscriptions, () => "local")
    subscriptions.route({
      target: () => "cloud",
      canDeliver: (source) => source === "cloud",
      busy: () => false,
      drained: false,
      plannedWatermark: null,
      forcedWatermark: cursor(500, 2),
    })
    expect(project(subscriptions, "transcription:en", [token("now", 10, 3)], cursor(20, 3))).toEqual([
      {listenerId: "late", text: "now"},
    ])
  })

  test("legacy classes move together and get one un-addressed event per class", () => {
    const subscriptions = new TranscriptionSubscriptions()
    subscriptions.replace(
      [
        {
          id: "legacy:preferCloud:transcription:auto",
          stream: "transcription:auto",
          processing: "preferCloud",
          legacy: true,
        },
        {
          id: "legacy:preferCloud:transcription:en",
          stream: "transcription:en",
          processing: "preferCloud",
          legacy: true,
        },
        {id: "legacy:localOnly:transcription:en", stream: "transcription:en", processing: "localOnly", legacy: true},
      ],
      cursor(0),
    )
    // The cloud is down: every class is on-device.
    settle(subscriptions, () => "local")
    expect(subscriptions.deliveries("transcription:en", "local", "text", undefined, null)).toEqual([
      {route: "default", text: "text"},
      {route: "forceLocal", text: "text"},
    ])
    // The en stream is mid-utterance on-device: the whole preferCloud class waits, auto included.
    subscriptions.route({
      target: (listener) => (listener.processing === "localOnly" ? "local" : "cloud"),
      canDeliver: () => true,
      busy: (source, stream) => source === "local" && stream === "transcription:en",
      drained: true,
      plannedWatermark: null,
      forcedWatermark: null,
    })
    expect(subscriptions.routes().map((route) => route.source)).toEqual(["local", "local", "local"])
    settle(subscriptions, (processing) => (processing === "localOnly" ? "local" : "cloud"))
    expect(subscriptions.deliveries("transcription:en", "cloud", "", [token("text", 0)], cursor(10))).toEqual([
      {route: "default", text: "text"},
    ])
  })
})

describe("reading SUBSCRIBE", () => {
  const streams = ["transcription:auto", "transcription:en-US", "button_press"]

  test("registered listeners carry their processing; forceLocal from older SDKs means localOnly", () => {
    expect(
      transcriptionRegistrations(
        [
          {id: "a", stream: "transcription:auto", processing: "preferLocal"},
          {id: "b", stream: "transcription:en-US", processing: "localOnly", forceLocal: true},
          {id: "c", stream: "transcription:en-US", forceLocal: true},
          {id: "d", stream: "transcription:en-US"},
          {id: "e", stream: "transcription:fr-FR"},
          {stream: "transcription:auto"},
        ],
        streams,
        new Map(),
      ),
    ).toEqual([
      {id: "a", stream: "transcription:auto", processing: "preferLocal"},
      {id: "b", stream: "transcription:en-US", processing: "localOnly"},
      {id: "c", stream: "transcription:en-US", processing: "localOnly"},
      {id: "d", stream: "transcription:en-US", processing: "preferCloud"},
    ])
  })

  test("streams without registered listeners get one legacy registration per class", () => {
    const byStream = new Map()
    addStreamProcessing(byStream, {stream: "transcription:auto", forceLocal: true, includeCloud: true})
    addStreamProcessing(byStream, {stream: "transcription:en-US"})
    expect(transcriptionRegistrations(undefined, streams, byStream)).toEqual([
      {id: "legacy:localOnly:transcription:auto", stream: "transcription:auto", processing: "localOnly", legacy: true},
      {
        id: "legacy:preferCloud:transcription:auto",
        stream: "transcription:auto",
        processing: "preferCloud",
        legacy: true,
      },
      {
        id: "legacy:preferCloud:transcription:en-US",
        stream: "transcription:en-US",
        processing: "preferCloud",
        legacy: true,
      },
    ])
  })

  test("a processing entry wins over the forceLocal flag it carries for older hosts", () => {
    const byStream = new Map()
    addStreamProcessing(byStream, {stream: "transcription:auto", processing: "localOnly", forceLocal: true})
    addStreamProcessing(byStream, {stream: "transcription:auto", processing: "preferLocal"})
    expect([...byStream.get("transcription:auto")]).toEqual(["localOnly", "preferLocal"])
  })
})
