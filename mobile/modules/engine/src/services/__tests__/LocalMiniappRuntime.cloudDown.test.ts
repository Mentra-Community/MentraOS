import {expect, test} from "bun:test"
import {readFileSync} from "node:fs"

// The runtime's real wiring to the cloud client, without its native imports.
const source = readFileSync(new URL("../LocalMiniappRuntime.ts", import.meta.url), "utf8")
const start = source.search(/^ {2}private ensureCloudStatusWired\(/m)
const method = source.slice(start, start + source.slice(start).search(/^ {2}\}$/m) + 3)
const code = new Bun.Transpiler({loader: "ts"}).transformSync(`class Host {cloudStatusWired = false; ${method}}`)

/** The cloud client as it behaves: a closing socket reports its status first, then flips `isConnected`. */
const cloud = {
  connected: true,
  status: [] as Array<(snapshot: {status: string}) => void>,
  connection: [] as Array<(connected: boolean) => void>,
  isConnected: () => cloud.connected,
  getAudioPosition: () => null,
  onStatusChanged: (listener: (snapshot: {status: string}) => void) => cloud.status.push(listener),
  onConnectionChange: (listener: (connected: boolean) => void) => cloud.connection.push(listener),
}

test("a cloud disconnect reroutes transcription once the cloud reads as down", () => {
  const Host = new Function(
    "cloudClientService",
    "sttModelManager",
    "localSttFallbackCoordinator",
    "useSettingsStore",
    "ISLAND_SETTINGS_KEYS",
    `${code}; return Host`,
  )(
    cloud,
    {onSelectionChanged: () => {}, getCurrentLanguageFromPreferences: async () => "en"},
    {onModelStatusChanged: () => {}},
    {subscribe: () => () => {}},
    {},
  )
  const host = new Host()
  // What routing saw at each recompute: whether the cloud was up.
  const routed: boolean[] = []
  Object.assign(host, {
    connectedApps: new Map(),
    redriveMiniappAuthDelivery: () => {},
    broadcastCloudStatus: () => {},
    updateCloudSubscriptions: () => routed.push(cloud.isConnected()),
  })
  host.ensureCloudStatusWired()
  // The socket closes: the status comes while isConnected() still says up, then the connection flips.
  for (const listener of cloud.status) listener({status: "reconnecting"})
  cloud.connected = false
  for (const listener of cloud.connection) listener(false)
  // Each failing reconnect attempt keeps the same status, so nothing more is reported.
  expect(routed.at(-1)).toBe(false)
})
