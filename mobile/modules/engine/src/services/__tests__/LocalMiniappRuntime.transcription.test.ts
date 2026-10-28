import {beforeEach, describe, expect, mock, test} from "bun:test"
import {readFileSync} from "node:fs"
import {
  SOURCE_QUIET_MS,
  targetSource,
  UTTERANCE_STALE_MS,
  UtteranceTracker,
  type TranscriptionSource,
} from "../TranscriptionRouting"
import {TranscriptionSubscriptions, type TranscriptionListenerRegistration} from "../TranscriptionSubscriptions"
import {UdpAudio} from "../../../../../../cloud-v2/packages/cloud-client/src/modules/runtime/audio-udp"
import {createSonioxProvider} from "../../../../../../cloud-v2/packages/runtime/src/services/audio/providers/soniox"

// The real fan-out and routing methods, without the runtime's native imports.
const source = readFileSync(new URL("../LocalMiniappRuntime.ts", import.meta.url), "utf8")
const methods = [
  "forwardEvent",
  "forwardTranscription",
  "refreshTranscriptionRouting",
  "drainLocalRecognizer",
  "scheduleHandoff",
  "cloudSpeechUp",
  "transcriptionRoutingState",
]
  .map((name) => {
    const start = source.search(new RegExp(`^  (?:public |private )${name}\\(`, "m"))
    if (start < 0) throw new Error(`Missing runtime method ${name}`)
    const rest = source.slice(start)
    return rest.slice(0, rest.search(/^ {2}\}$/m) + 3)
  })
  .join("\n")
const code = new Bun.Transpiler({loader: "ts"}).transformSync(`class Host {${methods}}`)
const cloud = {
  connected: true,
  isConnected: () => cloud.connected,
  getAudioPosition: (): {sessionTag: number; offsetMs: number} | null => ({sessionTag: 1, offsetMs: 30}),
}
const local = {
  language: null as string | null,
  isActive: () => local.language !== null,
  getActiveLanguage: () => local.language,
}
const features = {cloudSpeech: true}
/** The runtime's clock and background timers, advanced by hand. */
const clock = {now: 0}
const timers = new Map<number, {at: number; callback: () => void}>()
let nextTimer = 1
const BgTimer = {
  setTimeout: (callback: () => void, delay: number) => {
    timers.set(nextTimer, {at: clock.now + delay, callback})
    return nextTimer++
  },
  clearTimeout: (id: number) => timers.delete(id),
}
/** Lets `ms` pass, firing each timer at its own time (timers may arm new ones). */
function advance(ms: number) {
  const end = clock.now + ms
  for (;;) {
    const due = [...timers].filter(([, timer]) => timer.at <= end).sort(([, a], [, b]) => a.at - b.at)[0]
    if (!due) break
    timers.delete(due[0])
    clock.now = Math.max(clock.now, due[1].at)
    due[1].callback()
  }
  clock.now = end
}
const Host = new Function(
  "MiniappStreamType",
  "MiniappResponseType",
  "cloudClientService",
  "localSttFallbackCoordinator",
  "sttModelManager",
  "isFeatureEnabled",
  "targetSource",
  "TRANSCRIPT_TIMING_TELEMETRY",
  "LOG_TAG",
  "BgTimer",
  "Date",
  `${code}; return Host`,
)(
  {},
  {EVENT: "miniapp_event"},
  cloud,
  local,
  {getBcp47ForLanguage: () => "en-US"},
  (name: string) => name !== "cloudSpeech" || features.cloudSpeech,
  targetSource,
  false,
  "TEST",
  BgTimer,
  {now: () => clock.now},
)

type Sent = {owner: string; payload: any}

/** A runtime whose apps have these listeners, routed once as the runtime does on SUBSCRIBE. */
function host(apps: Record<string, TranscriptionListenerRegistration[]>, cutoff = {sessionTag: 1, offsetMs: 0}) {
  const runtime = new Host()
  runtime.utterances = new UtteranceTracker()
  runtime.sourcesUp = {cloud: false, local: false}
  runtime.localFinalWatermark = null
  runtime.localGeneration = 0
  runtime.localDrain = null
  runtime.localDrainRunning = false
  runtime.handoffTimer = null
  // The on-device recognizer has nothing pending unless a test says otherwise.
  runtime.finishLocalUtterance = mock(async () => "")
  runtime.transcriptionHintsByApp = new Map()
  runtime.normalizeStreamType = (stream: string) => stream
  runtime.noteLocalFinalDelivered = mock(() => {})
  runtime.updateCloudSubscriptions = mock(() => {})
  runtime.connectedApps = new Map()
  runtime.streamSubscribers = new Map()
  for (const [owner, listeners] of Object.entries(apps)) {
    const transcriptionListeners = new TranscriptionSubscriptions()
    transcriptionListeners.replace(listeners, cutoff)
    runtime.connectedApps.set(owner, {transcriptionListeners})
    for (const {stream} of listeners) {
      if (!runtime.streamSubscribers.has(stream)) runtime.streamSubscribers.set(stream, new Set())
      runtime.streamSubscribers.get(stream).add(owner)
    }
  }
  runtime.refreshTranscriptionRouting()
  const sent: Sent[] = []
  runtime.sendToMiniapp = (owner: string, payload: any) => sent.push({owner, payload})
  return {runtime, sent}
}
const listener = (
  id: string,
  processing: TranscriptionListenerRegistration["processing"] = "preferCloud",
  stream = "transcription:auto",
): TranscriptionListenerRegistration => ({id, stream, processing})
const texts = (sent: Sent[]) =>
  sent.map(({owner, payload}) => [owner, payload.listenerId, payload.data.text, payload.data.source])
const sourceOf = (runtime: any, owner: string): TranscriptionSource | null =>
  runtime.connectedApps.get(owner).transcriptionListeners.routes()[0].source

/** Lets the drain's promise chain finish. */
const drained = () => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  features.cloudSpeech = true
  cloud.connected = true
  cloud.getAudioPosition = () => ({sessionTag: 1, offsetMs: 30})
  local.language = null
  clock.now = 0
  timers.clear()
})

describe("cloud transcript projection", () => {
  test("host fanout sends independent trimmed events and hides token timing from miniapps", () => {
    const {runtime, sent} = host({captions: [listener("1")], notes: []})
    // Notes subscribes later.
    runtime.connectedApps
      .get("notes")
      .transcriptionListeners.replace([listener("2", "preferCloud", "transcription:en")], {sessionTag: 1, offsetMs: 20})
    runtime.refreshTranscriptionRouting()
    runtime.streamSubscribers = new Map([
      ["transcription:auto", new Set(["captions"])],
      ["transcription:en", new Set(["notes"])],
    ])
    const tokens = [
      {
        text: "BEFORE ",
        startMs: 0,
        endMs: 10,
        confidence: 1,
        isFinal: true,
        audioPosition: {sessionTag: 1, offsetMs: 0},
      },
      {
        text: "AFTER",
        startMs: 10,
        endMs: 20,
        confidence: 1,
        isFinal: true,
        audioPosition: {sessionTag: 1, offsetMs: 20},
      },
    ]
    for (const isFinal of [false, true]) {
      cloud.getAudioPosition = () => (isFinal ? null : {sessionTag: 1, offsetMs: 30})
      runtime.forwardEvent("transcription:en", {text: "BEFORE AFTER", isFinal, utteranceId: "u"}, "cloud", tokens)
    }
    expect(sent.map(({owner, payload}) => [owner, payload.data.text, payload.data.isFinal])).toEqual([
      ["notes", "AFTER", false],
      ["captions", "BEFORE AFTER", false],
      ["notes", "AFTER", true],
      ["captions", "BEFORE AFTER", true],
    ])
    expect(sent.every(({payload}) => !payload.data.tokens && !payload.data.audioPosition)).toBe(true)
    expect(sent.every(({payload}) => payload.data.source === "cloud" && payload.transcriptionRoute === "default")).toBe(
      true,
    )
    runtime.connectedApps.get("notes").transcriptionListeners.replace([], {sessionTag: 1, offsetMs: 30})
    runtime.forwardEvent("transcription:en", {text: "BEFORE AFTER", isFinal: true}, "cloud", tokens)
    expect(sent.at(-1)?.owner).toBe("captions")
  })

  test("old SDK bundles get trimmed stream events and missing timing is withheld", () => {
    const {runtime, sent} = host(
      {notes: [{...listener("legacy:preferCloud:transcription:auto"), legacy: true}]},
      {sessionTag: 1, offsetMs: 10},
    )
    runtime.forwardEvent("transcription:en", {text: "OLD NEW"}, "cloud", [
      {text: "OLD ", startMs: 0, endMs: 10, confidence: 1, isFinal: true, audioPosition: {sessionTag: 1, offsetMs: 0}},
      {text: "NEW", startMs: 10, endMs: 20, confidence: 1, isFinal: true, audioPosition: {sessionTag: 1, offsetMs: 10}},
    ])
    expect(sent).toHaveLength(1)
    expect(sent[0].payload.data.text).toBe("NEW")
    expect(sent[0].payload.listenerId).toBeUndefined()
    expect(sent[0].payload.transcriptionRoute).toBe("default")
    runtime.forwardEvent("transcription:en", {text: "UNMAPPED"}, "cloud", [])
    expect(sent).toHaveLength(1)
  })

  test("new to legacy to new server reconnect keeps fallback and delayed positioned finals", () => {
    const audio = new UdpAudio({udp: () => ({send() {}, close() {}, onMessage() {}})})
    const config = {
      sessionTag: 1,
      udp: {host: "test", port: 1},
      encryption: {key: Buffer.alloc(32).toString("base64"), algorithm: "xsalsa20-poly1305" as const},
    }
    audio.configure({...config, frameTimelineVersion: 1})
    cloud.getAudioPosition = () => audio.audioPosition
    const {runtime, sent} = host({notes: []})
    const registry: TranscriptionSubscriptions = runtime.connectedApps.get("notes").transcriptionListeners
    registry.replace([listener("one")], audio.audioPosition)
    runtime.streamSubscribers = new Map([["transcription:auto", new Set(["notes"])]])
    runtime.refreshTranscriptionRouting()
    // Exercise the actual cloud result adapter as well as the host fanout.
    const wiring = source.slice(
      source.indexOf("  private ensureCloudResultsWired():"),
      source.indexOf("  private ensureCloudStatusWired():"),
    )
    const wireCode = new Bun.Transpiler({loader: "ts"}).transformSync(`class Wiring {${wiring}}`)
    let receive = (_data: any) => {}
    const Wiring = new Function("cloudClientService", "TRANSCRIPT_TIMING_TELEMETRY", `${wireCode}; return Wiring`)(
      {
        onTranscript: (fn: typeof receive) => {
          receive = fn
        },
        onTranslation() {},
      },
      false,
    )
    const wiringHost = new Wiring()
    wiringHost.forwardEvent = runtime.forwardEvent.bind(runtime)
    wiringHost.ensureCloudResultsWired()
    const token = {
      text: "positioned",
      startMs: 0,
      endMs: 10,
      confidence: 1,
      isFinal: true,
      audioPosition: {sessionTag: 1, offsetMs: 0},
    }
    const result = {
      provider: "soniox",
      text: "positioned",
      resolvedLanguage: "en",
      tokens: [token],
      frameTimelineVersion: 1,
    }
    try {
      receive(result)
      audio.configure({...config, sessionTag: 2})
      receive({...result, text: "legacy", tokens: [], frameTimelineVersion: undefined})
      receive({...result, isFinal: true})
      // A malformed result from a negotiated occurrence cannot use legacy fallback.
      receive({...result, text: "missing", tokens: []})
      audio.configure({...config, sessionTag: 3, frameTimelineVersion: 1})
      registry.observe(audio.audioPosition)
      receive({...result, tokens: [{...token, audioPosition: {sessionTag: 3, offsetMs: 0}}]})
      expect(sent.map(({payload}) => [payload.data.text, payload.listenerId])).toEqual([
        ["positioned", "one"],
        ["legacy", "one"],
        ["positioned", "one"],
        ["positioned", "one"],
      ])
    } finally {
      audio.close()
    }
  })

  test("endpoint word/whitespace overlap reaches early and late subscriptions through the host", async () => {
    const handlers = new Map<string, (data?: unknown) => void>()
    const {runtime, sent} = host({app: [listener("early")]})
    const registry: TranscriptionSubscriptions = runtime.connectedApps.get("app").transcriptionListeners
    registry.replace([listener("early"), listener("late")], {sessionTag: 1, offsetMs: 10})
    runtime.refreshTranscriptionRouting()
    const session = {
      on: (event: string, fn: (data?: unknown) => void) => {
        handlers.set(event, fn)
      },
      off() {},
      async connect() {},
      async close() {},
      async finish() {},
      sendAudio() {},
    }
    const provider = await createSonioxProvider({
      scope: "host-overlap",
      client: {realtime: {stt: () => session}} as never,
      onTranscript: (event) =>
        runtime.forwardEvent("transcription:en", {text: event.text, isFinal: event.isFinal}, "cloud", event.tokens),
    })
    const word = (text: string, start_ms: number) => ({
      text,
      start_ms,
      end_ms: start_ms + 5,
      is_final: false,
      confidence: 1,
    })
    try {
      provider.writeAudio(new Int16Array(480), {sessionTag: 1, offsetMs: 0})
      handlers.get("result")!({tokens: [word("hello ", 0), word("world", 5)]})
      handlers.get("endpoint")!()
      handlers.get("result")!({tokens: [word("world ", 10), word("again", 15)]})
      handlers.get("finalized")!()
      expect(sent.slice(-4).map(({payload}) => [payload.listenerId, payload.data.text, payload.data.isFinal])).toEqual([
        ["early", "hello world again", false],
        ["late", "again", false],
        ["early", "hello world again", true],
        ["late", "again", true],
      ])
    } finally {
      await provider.close()
    }
  })
})

describe("routing between the cloud and on-device", () => {
  test("each listener gets only its own source, tagged with it", () => {
    local.language = "en-US"
    const {runtime, sent} = host({
      merge: [listener("prefer-local", "preferLocal")],
      notes: [listener("cloud")],
      ai: [listener("local-only", "localOnly")],
    })
    runtime.forwardEvent(
      "transcription:en-US",
      {type: "local_transcription", text: "on device", isFinal: true},
      "local",
    )
    runtime.forwardEvent("transcription:en-US", {type: "transcription", text: "in the cloud", isFinal: true}, "cloud")
    expect(texts(sent)).toEqual([
      ["merge", "prefer-local", "on device", "local"],
      ["ai", "local-only", "on device", "local"],
      ["notes", "cloud", "in the cloud", "cloud"],
    ])
    expect(sent.map(({payload}) => payload.transcriptionRoute)).toEqual(["default", "forceLocal", "default"])
    expect(runtime.noteLocalFinalDelivered).toHaveBeenCalledTimes(1)
  })

  test("a preferLocal listener in another language than the model stays on the cloud", () => {
    local.language = "en-US"
    const {runtime, sent} = host({merge: [listener("fr", "preferLocal", "transcription:fr-FR")]})
    expect(sourceOf(runtime, "merge")).toBe("cloud")
    runtime.forwardEvent("transcription:fr-FR", {text: "bonjour", isFinal: true}, "cloud")
    expect(texts(sent)).toEqual([["merge", "fr", "bonjour", "cloud"]])
  })

  test("a preferLocal listener moves on-device in a settled pause, after a drain", async () => {
    const {runtime, sent} = host({merge: [listener("merge", "preferLocal")]})
    expect(sourceOf(runtime, "merge")).toBe("cloud")
    const event = (from: "cloud" | "local", text: string, isFinal: boolean) =>
      runtime.forwardEvent("transcription:en-US", {text, isFinal}, from)

    event("cloud", "hello", false)
    // The model finishes loading mid-sentence.
    local.language = "en-US"
    runtime.refreshTranscriptionRouting()
    advance(500)
    event("local", "hello", false)
    event("cloud", "hello world", true)
    advance(500)
    event("local", "hello world", true)
    // Neither source has been quiet for the whole window yet.
    advance(SOURCE_QUIET_MS - 1)
    expect(runtime.finishLocalUtterance).not.toHaveBeenCalled()
    // The pause outlasts the window: the timer drains the recognizer, then the switch completes.
    advance(1)
    expect(runtime.finishLocalUtterance).toHaveBeenCalledTimes(1)
    expect(sourceOf(runtime, "merge")).toBe("cloud")
    await drained()
    expect(sourceOf(runtime, "merge")).toBe("local")
    expect(runtime.updateCloudSubscriptions).toHaveBeenCalled()
    event("local", "next", false)
    event("cloud", "next", false)
    expect(texts(sent)).toEqual([
      ["merge", "merge", "hello", "cloud"],
      ["merge", "merge", "hello world", "cloud"],
      ["merge", "merge", "next", "local"],
    ])
  })

  test("on-device speech already heard in the cloud is drained, not repeated, however late", async () => {
    const {runtime, sent} = host({
      merge: [listener("merge", "preferLocal")],
      ai: [listener("voice", "localOnly")],
    })
    advance(SOURCE_QUIET_MS)
    runtime.forwardEvent("transcription:en-US", {text: "hello", isFinal: false}, "cloud")
    // The model becomes ready and is already working on the same speech.
    local.language = "en-US"
    runtime.refreshTranscriptionRouting()
    runtime.forwardEvent("transcription:en-US", {text: "hello world", isFinal: true}, "cloud")
    // The on-device recognizer is slower than the quiet window and has reported nothing yet.
    runtime.finishLocalUtterance = mock(async () => {
      runtime.forwardEvent("transcription:en-US", {text: "hello world", isFinal: true}, "local")
      return "hello world"
    })
    advance(SOURCE_QUIET_MS)
    await drained()
    expect(sourceOf(runtime, "merge")).toBe("local")
    expect(texts(sent).map(([owner, , text, from]) => `${owner} ${from}: ${text}`)).toEqual([
      "merge cloud: hello",
      "merge cloud: hello world",
      // Only the listener already on-device gets the drained text.
      "ai local: hello world",
    ])
  })

  test("a drain counts only for the recognizer run it drained", async () => {
    const {runtime} = host({merge: [listener("merge", "preferLocal")]})
    local.language = "en-US"
    runtime.refreshTranscriptionRouting()
    let finish = () => {}
    runtime.finishLocalUtterance = mock(
      () =>
        new Promise<string>((resolve) => {
          finish = () => resolve("")
        }),
    )
    advance(SOURCE_QUIET_MS)
    expect(runtime.finishLocalUtterance).toHaveBeenCalledTimes(1)
    // The model reloads while that drain runs, and the new run settles before it ends.
    local.language = null
    runtime.refreshTranscriptionRouting()
    local.language = "en-US"
    runtime.refreshTranscriptionRouting()
    advance(SOURCE_QUIET_MS)
    finish()
    await drained()
    // It drained a run that is gone, so the new run is drained before the switch.
    expect(runtime.finishLocalUtterance).toHaveBeenCalledTimes(2)
    expect(sourceOf(runtime, "merge")).toBe("cloud")
    finish()
    await drained()
    expect(sourceOf(runtime, "merge")).toBe("local")
  })

  test("every planned switch drains again, since the recognizer keeps hearing audio", async () => {
    local.language = "en-US"
    const {runtime, sent} = host({
      merge: [listener("merge", "preferLocal")],
      ai: [listener("voice", "localOnly")],
    })
    expect(sourceOf(runtime, "merge")).toBe("local")
    // Hints the model can't serve move the listener to the cloud.
    runtime.transcriptionHintsByApp.set("merge", ["en", "ja"])
    runtime.refreshTranscriptionRouting()
    advance(SOURCE_QUIET_MS)
    await drained()
    expect(sourceOf(runtime, "merge")).toBe("cloud")
    expect(runtime.finishLocalUtterance).toHaveBeenCalledTimes(1)
    runtime.forwardEvent("transcription:en-US", {text: "same speech", isFinal: true}, "cloud")
    // Back to the model's language. The recognizer still holds that speech, unreported.
    runtime.transcriptionHintsByApp.set("merge", ["en"])
    runtime.finishLocalUtterance = mock(async () => {
      runtime.forwardEvent("transcription:en-US", {text: "same speech", isFinal: true}, "local")
      return "same speech"
    })
    runtime.refreshTranscriptionRouting()
    advance(SOURCE_QUIET_MS)
    await drained()
    expect(runtime.finishLocalUtterance).toHaveBeenCalledTimes(1)
    expect(sourceOf(runtime, "merge")).toBe("local")
    expect(texts(sent).filter(([owner]) => owner === "merge")).toEqual([["merge", "merge", "same speech", "cloud"]])
  })

  test("a waiting switch completes during silence, with no transcript to trigger it", async () => {
    local.language = "en-US"
    const {runtime} = host({merge: [listener("merge", "preferLocal")]})
    local.language = null
    runtime.refreshTranscriptionRouting()
    expect(sourceOf(runtime, "merge")).toBe("cloud")
    runtime.forwardEvent("transcription:en-US", {text: "half a sentence", isFinal: false}, "cloud")
    local.language = "en-US"
    runtime.refreshTranscriptionRouting()
    expect(timers.size).toBe(1)
    // The final never comes; the stale utterance ends on its own.
    advance(UTTERANCE_STALE_MS - 1)
    await drained()
    expect(sourceOf(runtime, "merge")).toBe("cloud")
    advance(1)
    await drained()
    expect(sourceOf(runtime, "merge")).toBe("local")
    expect(runtime.updateCloudSubscriptions).toHaveBeenCalled()
    expect(timers.size).toBe(0)
  })

  test("a listener leaves a source that stops right away, and the cloud completes the cut-short utterance", () => {
    local.language = "en-US"
    const {runtime, sent} = host({merge: [listener("merge", "preferLocal")]})
    const position = (offsetMs: number) => ({sessionTag: 1, offsetMs})
    const token = (text: string, offsetMs: number) => ({
      text,
      startMs: 0,
      endMs: 0,
      confidence: 1,
      isFinal: true,
      audioPosition: position(offsetMs),
    })
    cloud.getAudioPosition = () => position(100)
    runtime.forwardEvent("transcription:en-US", {text: "earlier", isFinal: true}, "local")
    cloud.getAudioPosition = () => position(300)
    runtime.forwardEvent("transcription:en-US", {text: "half a", isFinal: false}, "local")
    // The model unloads mid-utterance.
    local.language = null
    runtime.refreshTranscriptionRouting()
    expect(sourceOf(runtime, "merge")).toBe("cloud")
    expect(runtime.finishLocalUtterance).not.toHaveBeenCalled()
    runtime.forwardEvent("transcription:en-US", {text: "earlier half a sentence", isFinal: true}, "cloud", [
      token("earlier ", 50),
      token("half a ", 200),
      token("sentence", 400),
    ])
    expect(texts(sent).map(([, , text]) => text)).toEqual(["earlier", "half a", "half a sentence"])
  })

  test("while the cloud is down, preferCloud listeners get on-device text until it returns", async () => {
    cloud.connected = false
    local.language = "en-US"
    const {runtime, sent} = host({captions: [listener("captions")]})
    cloud.getAudioPosition = () => ({sessionTag: 2, offsetMs: 100})
    runtime.forwardEvent("transcription:en-US", {text: "offline", isFinal: false}, "local")
    cloud.connected = true
    runtime.refreshTranscriptionRouting()
    // The on-device sentence finishes first.
    runtime.forwardEvent("transcription:en-US", {text: "offline words", isFinal: true}, "local")
    expect(sourceOf(runtime, "captions")).toBe("local")
    // The drain starts when the uplink is at 120 ms; cloud text starts there.
    cloud.getAudioPosition = () => ({sessionTag: 2, offsetMs: 120})
    advance(SOURCE_QUIET_MS)
    await drained()
    expect(sourceOf(runtime, "captions")).toBe("cloud")
    const token = (text: string, offsetMs: number) => ({
      text,
      startMs: 0,
      endMs: 0,
      confidence: 1,
      isFinal: true,
      audioPosition: {sessionTag: 2, offsetMs},
    })
    runtime.forwardEvent("transcription:en-US", {text: "offline words online", isFinal: true}, "cloud", [
      token("offline words ", 50),
      token("online", 150),
    ])
    expect(texts(sent)).toEqual([
      ["captions", "captions", "offline", "local"],
      ["captions", "captions", "offline words", "local"],
      ["captions", "captions", "online", "cloud"],
    ])
  })

  test("with cloud speech disabled, preferLocal never falls back to the cloud", () => {
    features.cloudSpeech = false
    const {runtime} = host({merge: [listener("merge", "preferLocal", "transcription:fr-FR")]})
    expect(runtime.connectedApps.get("merge").transcriptionListeners.routes()[0]).toMatchObject({
      source: "local",
      target: "local",
    })
  })

  test("SDKs before listener registration get one un-addressed event per class", () => {
    local.language = "en-US"
    const {runtime, sent} = host({
      captions: [
        {...listener("legacy:preferCloud:transcription:auto"), legacy: true},
        {...listener("legacy:localOnly:transcription:auto", "localOnly"), legacy: true},
      ],
    })
    runtime.forwardEvent("transcription:en-US", {type: "local_transcription", text: "local", isFinal: true}, "local")
    runtime.forwardEvent("transcription:en-US", {type: "transcription", text: "cloud", isFinal: true}, "cloud")
    expect(sent.map(({payload}) => [payload.listenerId, payload.transcriptionRoute, payload.data.text])).toEqual([
      [undefined, "forceLocal", "local"],
      [undefined, "default", "cloud"],
    ])
  })
})
