import {beforeEach, expect, test} from "bun:test"
import {readFileSync} from "node:fs"

import {onDeviceServes, type SpeechProcessing} from "../TranscriptionRouting"
import {TranscriptionSubscriptions} from "../TranscriptionSubscriptions"

// The real per-miniapp projection of the on-device model status, without the
// runtime's native imports.
const source = readFileSync(new URL("../LocalMiniappRuntime.ts", import.meta.url), "utf8")
const begin = source.indexOf("  private transcriptionModelStatusFor(")
const end = source.indexOf("  /** Bumped after each final local transcript", begin)
const cloudSpeechBegin = source.indexOf("  private cloudSpeechUp(")
const cloudSpeechUp = source.slice(cloudSpeechBegin, source.indexOf("\n  }\n", cloudSpeechBegin) + 5)
const code = new Bun.Transpiler({loader: "ts"}).transformSync(
  `class Host { ${cloudSpeechUp} ${source.slice(begin, end)} }`,
)

let coordinatorStatus: {code: string; language: string; state: string; progress?: number; reason?: string}
let cloudConnected = true
let onDeviceSpeech = true
const Host = new Function(
  "localSttFallbackCoordinator",
  "sttModelManager",
  "cloudClientService",
  "isFeatureEnabled",
  "MiniappStreamType",
  "MiniappResponseType",
  "onDeviceServes",
  `${code}; return Host`,
)(
  {getModelStatus: () => coordinatorStatus},
  {getBcp47ForLanguage: () => "en-US"},
  {isConnected: () => cloudConnected},
  () => onDeviceSpeech,
  {TRANSCRIPTION: "transcription", TRANSCRIPTION_MODEL_STATUS: "transcription_model_status"},
  {EVENT: "miniapp_event"},
  onDeviceServes,
)

type Listeners = Record<string, SpeechProcessing>

function host(apps: Record<string, Listeners>, hints: Record<string, string[]> = {}) {
  const runtime = new Host()
  runtime.connectedApps = new Map(
    Object.entries(apps).map(([name, listeners]) => {
      const transcriptionListeners = new TranscriptionSubscriptions()
      transcriptionListeners.replace(
        Object.entries(listeners).map(([stream, processing], index) => ({id: `${index}`, stream, processing})),
        null,
      )
      return [name, {transcriptionListeners}]
    }),
  )
  runtime.transcriptionHintsByApp = new Map(Object.entries(hints))
  runtime.streamSubscribers = new Map([["transcription_model_status", new Set(Object.keys(apps))]])
  const sent: Array<{owner: string; data: unknown}> = []
  runtime.sendToMiniapp = (owner: string, envelope: {data: unknown}) => sent.push({owner, data: envelope.data})
  return {runtime, sent}
}

beforeEach(() => {
  coordinatorStatus = {code: "en-kroko", language: "en-US", state: "ready"}
  cloudConnected = true
  onDeviceSpeech = true
})

test("an on-device subscriber sees the picked model's state, in any language it can serve", () => {
  const {runtime} = host({
    voice: {"transcription:auto": "localOnly"},
    english: {"transcription:en-US": "preferLocal"},
  })
  expect(runtime.transcriptionModelStatusFor("voice")).toEqual({language: "en-US", state: "ready"})
  expect(runtime.transcriptionModelStatusFor("english")).toEqual({language: "en-US", state: "ready"})
  coordinatorStatus = {code: "en-kroko", language: "en-US", state: "downloading", progress: 40}
  expect(runtime.transcriptionModelStatusFor("voice")).toEqual({language: "en-US", state: "downloading", progress: 40})
  coordinatorStatus = {code: "en-kroko", language: "en-US", state: "unavailable", reason: "Could not download"}
  expect(runtime.transcriptionModelStatusFor("voice")).toEqual({
    language: "en-US",
    state: "unavailable",
    reason: "Could not download",
  })
  coordinatorStatus = {code: "en-kroko", language: "en-US", state: "idle"}
  expect(runtime.transcriptionModelStatusFor("voice").state).toBe("loading")
})

test("a subscription in another language than the picked model's is unavailable, naming the picked one", () => {
  const {runtime} = host({
    captions: {"transcription:fr-FR": "localOnly"},
    merge: {"transcription:fr-FR": "preferLocal"},
  })
  for (const app of ["captions", "merge"]) {
    expect(runtime.transcriptionModelStatusFor(app)).toMatchObject({
      language: "en-US",
      state: "unavailable",
      reason: expect.stringContaining("en-US"),
    })
  }
})

test("a preferLocal auto-detect listener hinted at another language stays off the model", () => {
  const {runtime} = host({merge: {"transcription:auto": "preferLocal"}}, {merge: ["en", "ja"]})
  expect(runtime.transcriptionModelStatusFor("merge").state).toBe("unavailable")
  runtime.transcriptionHintsByApp.set("merge", ["en"])
  expect(runtime.transcriptionModelStatusFor("merge").state).toBe("ready")
})

test("cloud subscriptions count as on-device only while the cloud is down", () => {
  const {runtime} = host({captions: {"transcription:auto": "preferCloud"}})
  expect(runtime.transcriptionModelStatusFor("captions")).toMatchObject({
    state: "unavailable",
    reason: "No on-device transcription subscription",
  })
  cloudConnected = false
  expect(runtime.transcriptionModelStatusFor("captions")).toEqual({language: "en-US", state: "ready"})
})

test("a deployment without on-device speech reports it", () => {
  onDeviceSpeech = false
  const {runtime} = host({voice: {"transcription:auto": "localOnly"}})
  expect(runtime.transcriptionModelStatusFor("voice")).toMatchObject({state: "unavailable"})
})

test("broadcasts reach only status subscribers, skip repeats, and subscribe replays the current state", () => {
  const {runtime, sent} = host({voice: {"transcription:auto": "localOnly"}})
  runtime.broadcastTranscriptionModelStatus()
  runtime.broadcastTranscriptionModelStatus()
  expect(sent).toEqual([{owner: "voice", data: {language: "en-US", state: "ready"}}])
  runtime.sendTranscriptionModelStatus("voice", true)
  expect(sent).toHaveLength(2)
  coordinatorStatus = {code: "en-kroko", language: "en-US", state: "loading"}
  runtime.broadcastTranscriptionModelStatus()
  expect(sent.at(-1)).toEqual({owner: "voice", data: {language: "en-US", state: "loading"}})
})
