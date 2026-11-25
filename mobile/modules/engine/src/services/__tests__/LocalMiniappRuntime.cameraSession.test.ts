import {expect, test} from "bun:test"
import {readFileSync} from "node:fs"

// The handlers that ship, pulled from the runtime's source as the SoftAP tests do, on a host whose
// camera sessions (the Bluetooth SDK's), photo coordinator and miniapp transport are fakes.
const source = readFileSync(new URL("../LocalMiniappRuntime.ts", import.meta.url), "utf8")
const methods = ["handleCameraSession", "photoOverrides", "closeCameraSessions"]
  .map((name) => {
    const start = source.search(new RegExp(`^  private (?:async )?${name}\\(`, "m"))
    if (start < 0) throw new Error(`Missing runtime method ${name}`)
    const rest = source.slice(start)
    return rest.slice(0, rest.search(/^  }$/m) + 3)
  })
  .join("\n")
const compiled = new Bun.Transpiler({loader: "ts"}).transformSync(`class Host { ${methods} }`)

const types = {
  CAMERA_OPEN: "open",
  CAMERA_SESSION_CAPTURE: "capture",
  CAMERA_CONTINUOUS_START: "start",
  CAMERA_CONTINUOUS_STOP: "stop",
  CAMERA_CLOSE: "close",
}

type Trigger = {
  options: Record<string, unknown>
  stopped: boolean
  emitPhoto: (photoId: string) => void
}

function fixture() {
  const sessions: Array<{
    consumer: string
    defaults: Record<string, unknown>
    closed: boolean
    asked: Array<Record<string, unknown>>
    triggers: Trigger[]
    take: (options: Record<string, unknown>) => unknown
    warm: () => Promise<{release(): Promise<void>}>
  }> = []
  const openCameraSession = (
    take: (options: Record<string, unknown>, released: () => void) => {photoId: string},
    defaults: Record<string, unknown>,
    consumer: string,
    warm: () => Promise<{release(): Promise<void>}>,
  ) => {
    const session = {
      consumer,
      defaults,
      closed: false,
      asked: [] as Array<Record<string, unknown>>,
      triggers: [] as Trigger[],
      take: (o: Record<string, unknown>) => take(o, () => {}),
      warm,
    }
    sessions.push(session)
    return {
      capture: async (o: Record<string, unknown>) => {
        session.asked.push(o)
        return take({...defaults, ...o}, () => {})
      },
      continuous: (options: Record<string, unknown>) => {
        let onPhoto: ((capture: {photoId: string}) => void) | undefined
        const trigger: Trigger = {
          options,
          stopped: false,
          emitPhoto: (photoId) => onPhoto?.({photoId}),
        }
        session.triggers.push(trigger)
        return {
          onPhoto: (handler: typeof onPhoto) => (onPhoto = handler),
          stop: () => {
            trigger.stopped = true
          },
        }
      },
      close: async () => {
        session.closed = true
      },
    }
  }
  const captured: Array<{packageName: string; photoId?: string; opts: Record<string, unknown>}> = []
  const warmUps: string[] = []
  const phonePhotoCoordinator = {
    capturePhoto: (packageName: string, opts: Record<string, unknown>, photoId?: string) => {
      captured.push({packageName, photoId, opts})
      return {photoId: photoId ?? "minted"}
    },
    holdWarmUp: async (packageName: string, warmUpId: string, opts: Record<string, unknown>) => {
      warmUps.push(`hold ${packageName} ${warmUpId} ${opts.size}`)
    },
    releaseWarmUp: async (packageName: string, warmUpId: string) => {
      warmUps.push(`release ${packageName} ${warmUpId}`)
    },
  }
  const Host = new Function(
    "openCameraSession",
    "phonePhotoCoordinator",
    "MiniappRequestType",
    "MiniappResponseType",
    `${compiled}; return Host`,
  )(openCameraSession, phonePhotoCoordinator, types, {
    CAMERA_CONTINUOUS_PHOTO: "photo",
  })
  const host = new Host()
  const results: unknown[] = []
  const pushes: unknown[] = []
  host.cameraSessions = new Map()
  host.cameraPermitted = () => true
  host.photoOpts = (payload: Record<string, unknown>) => ({
    size: payload.size,
    sound: payload.sound ?? true,
    preview: payload.preview === true,
  })
  host.sendResult = (_app: string, requestId: string, success: boolean) => results.push({requestId, success})
  host.sendPhotoError = (_app: string, requestId: string, err: Error) => results.push({requestId, error: err.message})
  host.sendToMiniapp = (_app: string, payload: unknown) => pushes.push(payload)
  return {host, sessions, captured, warmUps, results, pushes}
}

const APP = "com.mentra.documentation"

test("a session opens with its settings, holds the warm camera, and closes", async () => {
  const {host, sessions, warmUps, results} = fixture()
  await host.handleCameraSession(APP, "open", {cameraId: "c", size: "medium", sound: false, preview: true}, "q1")
  expect(sessions.map((session) => [session.consumer, session.defaults])).toEqual([
    [`miniapp ${APP}`, {size: "medium", sound: false, preview: true}],
  ])
  const warm = await sessions[0].warm()
  await warm.release()
  expect(warmUps).toEqual([`hold ${APP} camera-c medium`, `release ${APP} camera-c`])
  await host.handleCameraSession(APP, "close", {cameraId: "c"}, "q2")
  expect(sessions[0].closed).toBe(true)
  expect(results).toEqual([
    {requestId: "q1", success: true},
    {requestId: "q2", success: true},
  ])
})

test("a tap is taken through the session with the miniapp's photo ID and only its own options", async () => {
  const {host, sessions, captured, results} = fixture()
  await host.handleCameraSession(APP, "open", {cameraId: "c", size: "medium", sound: false, preview: true}, "q1")
  await host.handleCameraSession(APP, "capture", {cameraId: "c", photoId: "tap-1", sound: true}, "q2")
  expect(sessions[0].asked).toEqual([{sound: true, photoId: "tap-1"}])
  expect(captured).toEqual([
    {packageName: APP, photoId: "tap-1", opts: {size: "medium", sound: true, preview: true, photoId: "tap-1"}},
  ])
  expect(results[1]).toEqual({requestId: "q2", success: true})
  await host.handleCameraSession(APP, "capture", {cameraId: "other", photoId: "x"}, "q3")
  expect(results[2]).toEqual({requestId: "q3", error: "No camera session other"})
})

test("the continuous trigger reports its photos, and stops while the session stays", async () => {
  const {host, sessions, pushes, results} = fixture()
  await host.handleCameraSession(APP, "open", {cameraId: "c", size: "medium"}, "q1")
  await host.handleCameraSession(APP, "start", {cameraId: "c", runId: "r", sound: false}, "q2")
  expect(sessions[0].triggers[0].options).toEqual({sound: false})
  sessions[0].triggers[0].emitPhoto("p1")
  expect(pushes).toEqual([{type: "photo", runId: "r", photoId: "p1"}])
  await host.handleCameraSession(APP, "stop", {cameraId: "c", runId: "r"}, "q3")
  expect(sessions[0].triggers[0].stopped).toBe(true)
  expect(sessions[0].closed).toBe(false)
  expect(results.slice(1)).toEqual([
    {requestId: "q2", success: true},
    {requestId: "q3", success: true},
  ])
})

test("a camera ID can't be opened twice", async () => {
  const {host, results} = fixture()
  await host.handleCameraSession(APP, "open", {cameraId: "c"}, "q1")
  await host.handleCameraSession(APP, "open", {cameraId: "c"}, "q2")
  expect(results[1]).toEqual({requestId: "q2", error: "A camera session needs a new cameraId"})
})

test("a miniapp closing closes its sessions", async () => {
  const {host, sessions} = fixture()
  await host.handleCameraSession(APP, "open", {cameraId: "a"}, "q1")
  await host.handleCameraSession(APP, "open", {cameraId: "b"}, "q2")
  host.closeCameraSessions(APP)
  expect(sessions.map((session) => session.closed)).toEqual([true, true])
  expect(host.cameraSessions.size).toBe(0)
})
