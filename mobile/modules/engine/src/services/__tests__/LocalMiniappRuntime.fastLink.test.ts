import {expect, test} from "bun:test"
import {readFileSync} from "node:fs"

import type {GlassesWifiEvent} from "../GlassesWifi"

// The handlers that ship, pulled from the runtime's source as the SoftAP tests do, on a host whose
// glasses Wi-Fi service and miniapp transport are fakes.
const source = readFileSync(new URL("../LocalMiniappRuntime.ts", import.meta.url), "utf8")
const methods = ["openFastLink", "closeFastLink"]
  .map((name) => {
    const start = source.search(new RegExp(`^  private (?:async )?${name}\\(`, "m"))
    if (start < 0) throw new Error(`Missing runtime method ${name}`)
    const rest = source.slice(start)
    return rest.slice(0, rest.search(/^  }$/m) + 3)
  })
  .join("\n")
const compiled = new Bun.Transpiler({loader: "ts"}).transformSync(`class Host { ${methods} }`)
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

function fixture({failWith}: {failWith?: Error} = {}) {
  const holds: Array<{consumer: string; released: boolean; emit: (event: GlassesWifiEvent) => void}> = []
  const holdGlassesWifi = async ({consumer}: {consumer: string}) => {
    if (failWith) throw failWith
    let listener: ((event: GlassesWifiEvent) => void) | undefined
    const hold = {consumer, released: false, emit: (event: GlassesWifiEvent) => listener?.(event)}
    holds.push(hold)
    return {
      onChange: (next: typeof listener) => {
        listener = next
        return () => (listener = undefined)
      },
      ready: async () => ({ssid: "glasses", password: "", gateway: "192.168.49.1"}),
      release: async () => {
        hold.released = true
      },
    }
  }
  const Host = new Function(
    "holdGlassesWifi",
    "MiniappRequestType",
    "MiniappResponseType",
    "MiniappErrorCode",
    `${compiled}; return Host`,
  )(
    holdGlassesWifi,
    {CAMERA_FAST_LINK_OPEN: "miniapp_camera_fast_link_open"},
    {CAMERA_FAST_LINK: "miniapp_camera_fast_link"},
    {INTERNAL: "INTERNAL"},
  )
  const host = new Host()
  const results: unknown[] = []
  const pushes: unknown[] = []
  host.fastLinks = new Map()
  host.cameraPermitted = () => true
  host.sendResult = (_app: string, requestId: string, success: boolean, _data: unknown, error?: {message: string}) =>
    results.push({requestId, success, ...(error ? {error: error.message} : {})})
  host.sendToMiniapp = (_app: string, payload: unknown) => pushes.push(payload)
  return {host, holds, results, pushes}
}

test("a miniapp holds the link until it closes it, and asking twice holds it once", async () => {
  const {host, holds, results} = fixture()
  await host.openFastLink("com.mentra.documentation", "r1")
  await host.openFastLink("com.mentra.documentation", "r2")
  expect(holds.map((hold) => hold.consumer)).toEqual(["miniapp com.mentra.documentation"])
  expect(results).toEqual([
    {requestId: "r1", success: true},
    {requestId: "r2", success: true},
  ])
  host.closeFastLink("com.mentra.documentation")
  await tick()
  expect(holds[0].released).toBe(true)
  expect(host.fastLinks.size).toBe(0)
})

test("the miniapp hears the link go down and come back, and an ended link is given back", async () => {
  const {host, holds, pushes} = fixture()
  await host.openFastLink("com.mentra.documentation", "r1")
  holds[0].emit({type: "lost", reason: "glasses restarted"})
  holds[0].emit({type: "restored", binding: {ssid: "glasses", password: "", gateway: "192.168.49.1"}})
  holds[0].emit({type: "ended", reason: "glasses did not come back"})
  await tick()
  expect(pushes).toEqual([
    {type: "miniapp_camera_fast_link", state: "down"},
    {type: "miniapp_camera_fast_link", state: "up"},
    {type: "miniapp_camera_fast_link", state: "down"},
  ])
  expect(holds[0].released).toBe(true)
  expect(host.fastLinks.size).toBe(0)
})

test("a link that can't come up is refused, and nothing stays held", async () => {
  const {host, results} = fixture({failWith: new Error("The glasses did not enable their hotspot")})
  await host.openFastLink("com.mentra.documentation", "r1")
  expect(results).toEqual([{requestId: "r1", success: false, error: "The glasses did not enable their hotspot"}])
  expect(host.fastLinks.size).toBe(0)
})
