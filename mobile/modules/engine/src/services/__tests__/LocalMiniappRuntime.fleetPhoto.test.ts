/// <reference types="bun-types" />

import {afterEach, beforeEach, describe, expect, mock, test} from "bun:test"
import {readFileSync} from "node:fs"

import {fleetEvents, type FleetPhotoEvent} from "../fleet/fleetEvents"

// Same approach as LocalMiniappRuntime.softap.test.ts: run the shipped handlePhoto against faked I/O instead of
// loading the Expo app singleton and every hardware service behind it.
const source = readFileSync(new URL("../LocalMiniappRuntime.ts", import.meta.url), "utf8")
const start = source.search(/^ {2}private async handlePhoto\(/m)
if (start < 0) throw new Error("Missing runtime method handlePhoto")
const rest = source.slice(start)
const end = rest.search(/^ {2}}$/m)
if (end < 0) throw new Error("Missing end of runtime method handlePhoto")
const compiled = new Bun.Transpiler({loader: "ts"}).transformSync(`class Host { ${rest.slice(0, end + 3)} }`)

const PACKAGE = "com.mentra.camera"

interface Taken {
  photoUrl: string
  mimeType: string
  size: number
  requestId: string
}

/** Events and results in the order they happened, so a test can say which came first. */
const log: string[] = []

function fixture(opts: {camera?: boolean; takePhoto?: () => Promise<Taken>} = {}) {
  const takePhoto = mock(
    opts.takePhoto ??
      (async () => ({photoUrl: "https://r2.test/p.jpg", mimeType: "image/jpeg", size: -1, requestId: "rq-77"})),
  )
  const Host = new Function(
    "phonePhotoCoordinator",
    "fleetEvents",
    "parsePhotoCompression",
    "logPermissionNotDeclared",
    "MiniappRequestType",
    "MiniappErrorCode",
    `${compiled}; return Host`,
  )(
    {takePhoto},
    fleetEvents,
    (value: unknown) => value ?? "none",
    () => {},
    {PHOTO: "photo"},
    {PERMISSION_NOT_DECLARED: "PERMISSION_NOT_DECLARED", INTERNAL: "INTERNAL"},
  )
  const host = new Host()
  const results: Array<{requestId: string | undefined; ok: boolean; data?: unknown; error?: unknown}> = []
  host.connectedApps = new Map([
    [PACKAGE, {installedManifest: {permissions: opts.camera === false ? [] : [{type: "CAMERA"}]}}],
  ])
  host.sendResult = (_pkg: string, requestId: string | undefined, ok: boolean, data?: unknown, error?: unknown) => {
    log.push(`result:${ok}`)
    results.push({requestId, ok, data, error})
  }
  return {host, results, takePhoto}
}

const events: FleetPhotoEvent[] = []
let stopListening: () => void = () => {}

beforeEach(() => {
  events.length = 0
  log.length = 0
  stopListening = fleetEvents.subscribe({
    photo: (event) => {
      log.push(`fleet:${event.stage}`)
      events.push(event)
    },
  })
})

afterEach(() => stopListening())

describe("handlePhoto and Fleet", () => {
  test("a photo handed to the miniapp is delivered, under the managed request ID, after the result is sent", async () => {
    const f = fixture()
    await f.host.handlePhoto(PACKAGE, {}, "req-1")
    expect(f.results).toEqual([expect.objectContaining({requestId: "req-1", ok: true})])
    expect(events).toEqual([{operationId: "rq-77", stage: "delivered"}])
    // sendResult first, then the report: "delivered" only after the miniapp has been sent the photo.
    expect(log).toEqual(["result:true", "fleet:delivered"])
  })

  test("a photo that failed is not delivered, and the miniapp is told as before", async () => {
    const f = fixture({
      takePhoto: async () => {
        throw Object.assign(new Error("Battery too low"), {code: "BATTERY_LOW", stage: "capture"})
      },
    })
    await f.host.handlePhoto(PACKAGE, {}, "req-1")
    expect(f.results).toEqual([expect.objectContaining({ok: false})])
    expect(events).toEqual([])
  })

  test("a miniapp without the camera permission gets no photo and nothing is reported", async () => {
    const f = fixture({camera: false})
    await f.host.handlePhoto(PACKAGE, {}, "req-1")
    expect(f.takePhoto).not.toHaveBeenCalled()
    expect(events).toEqual([])
  })

  test("a request with no ID has nobody to deliver to, so nothing is delivered", async () => {
    const f = fixture()
    await f.host.handlePhoto(PACKAGE, {}, undefined)
    expect(events).toEqual([])
  })

  test("a reporter that fails does not turn a delivered photo into a failed one", async () => {
    stopListening()
    stopListening = fleetEvents.subscribe({
      photo: () => {
        throw new Error("fleet is broken")
      },
    })
    const warn = console.warn
    console.warn = () => {}
    try {
      const f = fixture()
      await f.host.handlePhoto(PACKAGE, {}, "req-1")
      expect(f.results.map((result) => result.ok)).toEqual([true])
    } finally {
      console.warn = warn
    }
  })
})
