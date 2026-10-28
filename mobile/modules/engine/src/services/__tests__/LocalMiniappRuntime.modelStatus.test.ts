import {beforeEach, expect, test} from "bun:test"
import {readFileSync} from "node:fs"

// The real per-miniapp projection of the on-device model status, without the
// runtime's native imports.
const source = readFileSync(new URL("../LocalMiniappRuntime.ts", import.meta.url), "utf8")
const begin = source.indexOf("  private transcriptionModelStatusFor(")
const end = source.indexOf("  /** Bumped after each final local transcript", begin)
const code = new Bun.Transpiler({loader: "ts"}).transformSync(`class Host { ${source.slice(begin, end)} }`)

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
  `${code}; return Host`,
)(
  {getModelStatus: () => coordinatorStatus},
  {getBcp47ForLanguage: () => "en-US"},
  {isConnected: () => cloudConnected},
  () => onDeviceSpeech,
  {TRANSCRIPTION: "transcription", TRANSCRIPTION_MODEL_STATUS: "transcription_model_status"},
  {EVENT: "miniapp_event"},
)

function host(apps: Record<string, {subscriptions: string[]; forceLocal?: string[]}>) {
  const runtime = new Host()
  runtime.connectedApps = new Map(
    Object.entries(apps).map(([name, app]) => [
      name,
      {subscriptions: new Set(app.subscriptions), forceLocalTranscriptionStreams: new Set(app.forceLocal ?? [])},
    ]),
  )
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
    voice: {subscriptions: ["transcription:auto", "transcription_model_status"], forceLocal: ["transcription:auto"]},
    english: {subscriptions: ["transcription:en-US"], forceLocal: ["transcription:en-US"]},
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
  const {runtime} = host({captions: {subscriptions: ["transcription:fr-FR"], forceLocal: ["transcription:fr-FR"]}})
  expect(runtime.transcriptionModelStatusFor("captions")).toMatchObject({
    language: "en-US",
    state: "unavailable",
    reason: expect.stringContaining("en-US"),
  })
})

test("cloud subscriptions count as on-device only while the cloud is down", () => {
  const {runtime} = host({captions: {subscriptions: ["transcription:auto"]}})
  expect(runtime.transcriptionModelStatusFor("captions")).toMatchObject({
    state: "unavailable",
    reason: "No on-device transcription subscription",
  })
  cloudConnected = false
  expect(runtime.transcriptionModelStatusFor("captions")).toEqual({language: "en-US", state: "ready"})
})

test("a deployment without on-device speech reports it", () => {
  onDeviceSpeech = false
  const {runtime} = host({voice: {subscriptions: ["transcription:auto"], forceLocal: ["transcription:auto"]}})
  expect(runtime.transcriptionModelStatusFor("voice")).toMatchObject({state: "unavailable"})
})

test("broadcasts reach only status subscribers, skip repeats, and subscribe replays the current state", () => {
  const {runtime, sent} = host({voice: {subscriptions: ["transcription:auto"], forceLocal: ["transcription:auto"]}})
  runtime.broadcastTranscriptionModelStatus()
  runtime.broadcastTranscriptionModelStatus()
  expect(sent).toEqual([{owner: "voice", data: {language: "en-US", state: "ready"}}])
  runtime.sendTranscriptionModelStatus("voice", true)
  expect(sent).toHaveLength(2)
  coordinatorStatus = {code: "en-kroko", language: "en-US", state: "loading"}
  runtime.broadcastTranscriptionModelStatus()
  expect(sent.at(-1)).toEqual({owner: "voice", data: {language: "en-US", state: "loading"}})
})
