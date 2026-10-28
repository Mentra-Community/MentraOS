import {expect, mock, test} from "bun:test"
import {readFileSync} from "node:fs"

// Run the real TRANSCRIPTION_FINISH handler and its helpers without the
// runtime's WebView and media imports.
const source = readFileSync(new URL("../LocalMiniappRuntime.ts", import.meta.url), "utf8")
function slice(startMarker: string, endMarker: string): string {
  const begin = source.indexOf(startMarker)
  const end = source.indexOf(endMarker, begin + startMarker.length)
  if (begin < 0 || end < 0) throw new Error(`could not find ${startMarker}`)
  return source.slice(begin, end)
}
const handler = slice("      case MiniappRequestType.TRANSCRIPTION_FINISH: {", "\n      case ").replace(
  "case MiniappRequestType.TRANSCRIPTION_FINISH:",
  "case 1:",
)
const helpers = slice("  /** Bumped after each final local transcript", "  private currentCloudStatus()")
const code = new Bun.Transpiler({loader: "ts"}).transformSync(
  `class LocalMiniappRuntime {
    run(packageName: string, requestId: string) { switch (1) { ${handler} } }
    ${helpers}
  }`,
)

function host(platform: string, finish: () => Promise<unknown>, active = true) {
  const timers = new Map<number, () => void>()
  let nextTimer = 1
  const Host = new Function(
    "Platform",
    "BluetoothSdk",
    "MiniappErrorCode",
    "localSttFallbackCoordinator",
    "BgTimer",
    `${code}; return LocalMiniappRuntime`,
  )(
    {OS: platform},
    {finishTranscription: finish},
    {PERMISSION_DENIED: "PERMISSION_DENIED", INTERNAL: "INTERNAL"},
    {isActive: () => active},
    {
      setTimeout: (callback: () => void) => {
        timers.set(nextTimer, callback)
        return nextTimer++
      },
      clearTimeout: (id: number) => timers.delete(id),
    },
  )
  const runtime = new Host()
  runtime.connectedApps = new Map([
    [
      "com.example.voice",
      {
        forceLocalTranscriptionStreams: new Set(["transcription:auto"]),
        installedManifest: {permissions: [{type: "MICROPHONE"}]},
      },
    ],
  ])
  runtime.sendResult = mock(() => {})
  return {runtime, fireTimers: () => [...timers.values()].forEach((callback) => callback())}
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

for (const platform of ["ios", "android", "macos"]) {
  test(`finishUtterance resolves with the final text on ${platform}`, async () => {
    const finish = mock(async () => "what time is it")
    const {runtime} = host(platform, async () => {
      const text = await finish()
      runtime.noteLocalFinalDelivered()
      return text
    })
    runtime.run("com.example.voice", "flush")
    await settle()
    expect(finish.mock.calls.length).toBe(platform === "macos" ? 0 : 1)
    expect(runtime.sendResult).toHaveBeenCalledWith(
      "com.example.voice",
      "flush",
      true,
      platform === "macos" ? null : "what time is it",
    )
  })
}

test("the result waits until the final transcript has gone out to miniapps", async () => {
  const {runtime} = host("android", async () => "turn on the lights")
  runtime.run("com.example.voice", "flush")
  await settle()
  expect(runtime.sendResult).not.toHaveBeenCalled()
  runtime.noteLocalFinalDelivered()
  await settle()
  expect(runtime.sendResult).toHaveBeenCalledWith("com.example.voice", "flush", true, "turn on the lights")
})

test("a missing final event cannot hold the result forever", async () => {
  const {runtime, fireTimers} = host("ios", async () => "hello")
  runtime.run("com.example.voice", "flush")
  await settle()
  fireTimers()
  await settle()
  expect(runtime.sendResult).toHaveBeenCalledWith("com.example.voice", "flush", true, "hello")
})

test("nothing pending, a model that can't finish early, or no local recognizer", async () => {
  for (const [native, active, expected] of [
    ["", true, ""],
    [null, true, null],
    [false, true, null],
    ["text", false, null],
  ] as const) {
    const {runtime} = host("android", async () => native, active)
    runtime.run("com.example.voice", "flush")
    await settle()
    expect(runtime.sendResult).toHaveBeenCalledWith("com.example.voice", "flush", true, expected)
  }
})

test("requires an on-device subscription and the microphone permission", async () => {
  const finish = mock(async () => "x")
  const {runtime} = host("android", finish)
  runtime.connectedApps.get("com.example.voice").forceLocalTranscriptionStreams.clear()
  runtime.run("com.example.voice", "flush")
  await settle()
  expect(finish).not.toHaveBeenCalled()
  expect(runtime.sendResult).toHaveBeenCalledWith(
    "com.example.voice",
    "flush",
    false,
    undefined,
    expect.objectContaining({code: "PERMISSION_DENIED"}),
  )
})
