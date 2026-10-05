import {expect, test} from "bun:test"
import {readFileSync} from "node:fs"
import {TranscriptionSubscriptions} from "../TranscriptionSubscriptions"
import {transcriptionDeliveryRoute} from "../TranscriptionRouting"
import {UdpAudio} from "../../../../../../cloud-v2/packages/cloud-client/src/modules/runtime/audio-udp"
import {createSonioxProvider} from "../../../../../../cloud-v2/packages/runtime/src/services/audio/providers/soniox"

const source = readFileSync(new URL("../LocalMiniappRuntime.ts", import.meta.url), "utf8")
const start = source.indexOf("  public forwardEvent(")
const rest = source.slice(start)
const end = rest.search(/^  }$/m)
const code = new Bun.Transpiler({loader: "ts"}).transformSync(`class Host {${rest.slice(0, end + 3)}}`)
const cloud = {isConnected: () => true, getAudioPosition: (): {sessionTag: number; offsetMs: number} | null => ({sessionTag: 1, offsetMs: 30})}
const Host = new Function("MiniappStreamType", "MiniappResponseType", "cloudClientService", "transcriptionDeliveryRoute", "TRANSCRIPT_TIMING_TELEMETRY", `${code}; return Host`)(
  {}, {EVENT: "miniapp_event"}, cloud,
  transcriptionDeliveryRoute, false,
)

test("host fanout sends independent trimmed events and hides token timing from miniapps", () => {
  const host = new Host()
  const early = new TranscriptionSubscriptions(), late = new TranscriptionSubscriptions()
  early.replace([{id: "1", stream: "transcription:auto"}], {sessionTag: 1, offsetMs: 0})
  late.replace([{id: "2", stream: "transcription:en"}], {sessionTag: 1, offsetMs: 20})
  host.streamSubscribers = new Map([["transcription:auto", new Set(["captions"])], ["transcription:en", new Set(["notes"])]])
  host.connectedApps = new Map([["captions", {transcriptionListeners: early}], ["notes", {transcriptionListeners: late}]])
  host.normalizeStreamType = (stream: string) => stream
  host.appTranscriptionRoutesForEvent = () => ({cloud: true, forceLocal: false})
  const sent: Array<{owner: string; payload: any}> = []
  host.sendToMiniapp = (owner: string, payload: any) => sent.push({owner, payload})
  const tokens = [
    {text: "BEFORE ", startMs: 0, endMs: 10, confidence: 1, isFinal: true, audioPosition: {sessionTag: 1, offsetMs: 0}},
    {text: "AFTER", startMs: 10, endMs: 20, confidence: 1, isFinal: true, audioPosition: {sessionTag: 1, offsetMs: 20}},
  ]
  for (const isFinal of [false, true]) {
    cloud.getAudioPosition = () => isFinal ? null : {sessionTag: 1, offsetMs: 30}
    host.forwardEvent("transcription:en", {text: "BEFORE AFTER", isFinal, utteranceId: "u"}, "cloud", tokens)
  }
  expect(sent.map(({owner, payload}) => [owner, payload.data.text, payload.data.isFinal])).toEqual([
    ["notes", "AFTER", false], ["captions", "BEFORE AFTER", false],
    ["notes", "AFTER", true], ["captions", "BEFORE AFTER", true],
  ])
  expect(sent.every(({payload}) => !payload.data.tokens && !payload.data.audioPosition)).toBe(true)
  late.replace([], {sessionTag: 1, offsetMs: 30})
  host.forwardEvent("transcription:en", {text: "BEFORE AFTER", isFinal: true}, "cloud", tokens)
  expect(sent.at(-1)?.owner).toBe("captions")
})

test("old SDK bundles get trimmed stream events and missing timing is withheld", () => {
  const host = new Host(), registry = new TranscriptionSubscriptions()
  registry.replace([{id: "legacy:auto", stream: "transcription:auto", legacy: true}], {sessionTag: 1, offsetMs: 10})
  host.streamSubscribers = new Map([["transcription:auto", new Set(["notes"])]])
  host.connectedApps = new Map([["notes", {transcriptionListeners: registry}]])
  host.normalizeStreamType = (stream: string) => stream
  host.appTranscriptionRoutesForEvent = () => ({cloud: true, forceLocal: false})
  const sent: any[] = []
  host.sendToMiniapp = (_owner: string, event: any) => sent.push(event)
  host.forwardEvent("transcription:en", {text: "OLD NEW"}, "cloud", [
    {text: "OLD ", startMs: 0, endMs: 10, confidence: 1, isFinal: true, audioPosition: {sessionTag: 1, offsetMs: 0}},
    {text: "NEW", startMs: 10, endMs: 20, confidence: 1, isFinal: true, audioPosition: {sessionTag: 1, offsetMs: 10}},
  ])
  expect(sent).toHaveLength(1)
  expect(sent[0].data.text).toBe("NEW")
  expect(sent[0].listenerId).toBeUndefined()
  host.forwardEvent("transcription:en", {text: "UNMAPPED"}, "cloud", [])
  expect(sent).toHaveLength(1)
})

test("new to legacy to new server reconnect keeps fallback and delayed positioned finals", () => {
  const audio = new UdpAudio({udp: () => ({send() {}, close() {}, onMessage() {}})})
  const config = {sessionTag: 1, udp: {host: "test", port: 1}, encryption: {key: Buffer.alloc(32).toString("base64"), algorithm: "xsalsa20-poly1305" as const}}
  const host = new Host(), registry = new TranscriptionSubscriptions()
  audio.configure({...config, frameTimelineVersion: 1})
  cloud.getAudioPosition = () => audio.audioPosition
  registry.replace([{id: "one", stream: "transcription:auto"}], audio.audioPosition)
  host.streamSubscribers = new Map([["transcription:auto", new Set(["notes"])]])
  host.connectedApps = new Map([["notes", {transcriptionListeners: registry}]])
  host.normalizeStreamType = (stream: string) => stream
  host.appTranscriptionRoutesForEvent = () => ({cloud: true, forceLocal: false})
  const sent: any[] = []
  host.sendToMiniapp = (_owner: string, event: any) => sent.push(event)
  // Exercise the actual cloud result adapter as well as the host fanout.
  const wiring = source.slice(source.indexOf("  private ensureCloudResultsWired():"), source.indexOf("  private ensureCloudStatusWired():"))
  const wireCode = new Bun.Transpiler({loader: "ts"}).transformSync(`class Wiring {${wiring}}`)
  let receive = (_data: any) => {}
  const Wiring = new Function("cloudClientService", "TRANSCRIPT_TIMING_TELEMETRY", `${wireCode}; return Wiring`)(
    {onTranscript: (fn: typeof receive) => {receive = fn}, onTranslation() {}}, false,
  )
  const wiringHost = new Wiring()
  wiringHost.forwardEvent = host.forwardEvent.bind(host)
  wiringHost.ensureCloudResultsWired()
  const token = {text: "positioned", startMs: 0, endMs: 10, confidence: 1, isFinal: true, audioPosition: {sessionTag: 1, offsetMs: 0}}
  const result = {provider: "soniox", text: "positioned", resolvedLanguage: "en", tokens: [token], frameTimelineVersion: 1}
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
    expect(sent.map((e) => [e.data.text, e.listenerId])).toEqual([
      ["positioned", "one"], ["legacy", undefined], ["positioned", "one"], ["positioned", "one"],
    ])
  } finally {audio.close(); cloud.getAudioPosition = () => null}
})

test("endpoint word/whitespace overlap reaches early and late subscriptions through the host", async () => {
  const handlers = new Map<string, (data?: unknown) => void>()
  const host = new Host(), registry = new TranscriptionSubscriptions()
  registry.replace([{id: "early", stream: "transcription:auto"}], {sessionTag: 1, offsetMs: 0})
  registry.replace([{id: "early", stream: "transcription:auto"}, {id: "late", stream: "transcription:auto"}], {sessionTag: 1, offsetMs: 10})
  cloud.getAudioPosition = () => ({sessionTag: 1, offsetMs: 30})
  host.streamSubscribers = new Map([["transcription:auto", new Set(["app"])]])
  host.connectedApps = new Map([["app", {transcriptionListeners: registry}]])
  host.normalizeStreamType = (stream: string) => stream
  host.appTranscriptionRoutesForEvent = () => ({cloud: true, forceLocal: false})
  const sent: any[] = []
  host.sendToMiniapp = (_owner: string, event: any) => sent.push(event)
  const session = {on: (event: string, fn: (data?: unknown) => void) => {handlers.set(event, fn)}, off() {},
    async connect() {}, async close() {}, async finish() {}, sendAudio() {}}
  const provider = await createSonioxProvider({scope: "host-overlap", client: {realtime: {stt: () => session}} as never,
    onTranscript: (event) => host.forwardEvent("transcription:en", {text: event.text, isFinal: event.isFinal}, "cloud", event.tokens)})
  const word = (text: string, start_ms: number) => ({text, start_ms, end_ms: start_ms + 5, is_final: false, confidence: 1})
  try {
    provider.writeAudio(new Int16Array(480), {sessionTag: 1, offsetMs: 0})
    handlers.get("result")!({tokens: [word("hello ", 0), word("world", 5)]})
    handlers.get("endpoint")!()
    handlers.get("result")!({tokens: [word("world ", 10), word("again", 15)]})
    handlers.get("finalized")!()
    expect(sent.slice(-4).map((event) => [event.listenerId, event.data.text, event.data.isFinal])).toEqual([
      ["early", "hello world again", false], ["late", "again", false],
      ["early", "hello world again", true], ["late", "again", true],
    ])
  } finally {await provider.close(); cloud.getAudioPosition = () => null}
})
