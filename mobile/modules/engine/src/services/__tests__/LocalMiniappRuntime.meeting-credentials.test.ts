import {expect, test} from "bun:test"
import {readFileSync} from "node:fs"

// Run the real host boundary without initializing the Expo/hardware singleton.
const source = readFileSync(new URL("../LocalMiniappRuntime.ts", import.meta.url), "utf8")
const methods = ["handleMeetingJoin", "leaveMeetingForApp"].map((name) => {
  const start = source.search(new RegExp(`^  private async ${name}\\(`, "m"))
  if (start < 0) throw new Error(`Missing ${name}`)
  const rest = source.slice(start)
  return rest.slice(0, rest.search(/^  }$/m) + 3)
}).join("\n")
const compiled = new Bun.Transpiler({loader: "ts"}).transformSync(`class Host { ${methods} }`)

function fixture() {
  const finish: Array<(value: unknown) => void> = []
  const joined: unknown[] = []
  const results: unknown[][] = []
  const scope = {
    meetingConfiguration: () => ({enabled: true, externalBackendAllowed: false}),
    meetingCredential: () => new Promise((resolve) => finish.push(resolve)),
    PermissionFeatures: {CAMERA: "camera", MICROPHONE: "microphone"},
    MiniappRequestType: {MEETING_JOIN: "meeting_join"},
    MiniappErrorCode: {INTERNAL: "INTERNAL"},
    VOICE_CALL_PACKAGES: ["com.mentra.call"],
    micSessionManager: {hasGlassesSession: () => true},
    parseAcsCallOrigin: () => "pasted",
    parseAcsVideoSource: (value: unknown) => value,
    parseAcsOutgoingVideo: () => undefined,
    softapTrace: () => {},
    softapTraceFailure: () => {},
    SoftapCallError: class extends Error {},
    acsMeetingService: {leaveIfOwner: async () => {}},
  }
  const Host = new Function(...Object.keys(scope), `${compiled}; return Host`)(...Object.values(scope))
  const host = new Host()
  Object.assign(host, {
    meetingCredentialRequests: new Map(),
    ensureMeetingStateBridge: () => {},
    requireManifestPermission: () => true,
    requireOsPermission: async () => true,
    sendResult: (...args: unknown[]) => results.push(args),
    joinSoftapMeeting: async (_pkg: string, args: unknown) => {
      joined.push(args)
      return {state: "connected"}
    },
  })
  const join = (id: string) => host.handleMeetingJoin("com.mentra.call", {
    meetingUrl: "https://teams.microsoft.com/l/meetup-join/test",
    videoSource: {type: "softap"},
  }, id) as Promise<void>
  return {host, join, finish, joined, results}
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
const credential = {token: "host-only", identityMode: "guest", guestReason: "no-entra-identity"}

test("closing a miniapp while obtaining credentials cannot start a late call", async () => {
  const f = fixture()
  const pending = f.join("old")
  await tick()
  await f.host.leaveMeetingForApp("com.mentra.call")
  f.finish[0](credential)
  await pending
  expect(f.joined).toEqual([])
  expect(f.results[0]).toMatchObject({1: "old", 2: false, 4: {message: "Meeting join was cancelled"}})
})

test("a newer join owns the credential response even if the previous request finishes last", async () => {
  const f = fixture()
  const old = f.join("old")
  await tick()
  const current = f.join("current")
  await tick()
  f.finish[1](credential)
  await current
  f.finish[0](credential)
  await old
  expect(f.joined).toHaveLength(1)
  expect(f.joined[0]).toMatchObject({identity: {identityMode: "guest", guestReason: "no-entra-identity"}})
  expect(f.results.map((result) => [result[1], result[2]])).toEqual([["current", true], ["old", false]])
})
