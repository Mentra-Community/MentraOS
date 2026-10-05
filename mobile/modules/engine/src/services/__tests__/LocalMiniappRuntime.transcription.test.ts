import {expect, test} from "bun:test"
import {readFileSync} from "node:fs"
import {TranscriptionSubscriptions} from "../TranscriptionSubscriptions"
import {transcriptionDeliveryRoute} from "../TranscriptionRouting"

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
