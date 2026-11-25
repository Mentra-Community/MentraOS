import {expect, test} from "bun:test"
import {readFileSync} from "node:fs"

// The handlers that ship, pulled from the runtime's source as the SoftAP tests do, on a host whose
// continuous captures (the Bluetooth SDK's), photo coordinator and miniapp transport are fakes.
const source = readFileSync(new URL("../LocalMiniappRuntime.ts", import.meta.url), "utf8")
const methods = ["handleContinuousCapture", "stopContinuous"]
  .map((name) => {
    const start = source.search(new RegExp(`^  private (?:async )?${name}\\(`, "m"))
    if (start < 0) throw new Error(`Missing runtime method ${name}`)
    const rest = source.slice(start)
    return rest.slice(0, rest.search(/^  }$/m) + 3)
  })
  .join("\n")
const compiled = new Bun.Transpiler({loader: "ts"}).transformSync(`class Host { ${methods} }`)

const types = {
  CAMERA_CONTINUOUS_START: "start",
  CAMERA_CONTINUOUS_CAPTURE: "capture",
  CAMERA_CONTINUOUS_STOP: "stop",
}

function fixture() {
  const runs: Array<{
    consumer: string
    options: Record<string, unknown>
    stopped: boolean
    asked: Array<Record<string, unknown>>
    emitPhoto: (photoId: string) => void
    emitState: (state: string) => void
    take: (options: Record<string, unknown>) => unknown
  }> = []
  const runContinuousCapture = (
    take: (options: Record<string, unknown>, released: () => void) => {photoId: string},
    options: Record<string, unknown>,
    consumer: string,
  ) => {
    let onPhoto: ((capture: {photoId: string}) => void) | undefined
    let onState: ((state: string) => void) | undefined
    const run = {
      consumer,
      options,
      stopped: false,
      asked: [] as Array<Record<string, unknown>>,
      emitPhoto: (photoId: string) => onPhoto?.({photoId}),
      emitState: (state: string) => onState?.(state),
      take: (o: Record<string, unknown>) => take(o, () => {}),
    }
    runs.push(run)
    return {
      state: "paused",
      onPhoto: (handler: typeof onPhoto) => (onPhoto = handler),
      onState: (handler: typeof onState) => (onState = handler),
      capture: async (o: Record<string, unknown>) => {
        run.asked.push(o)
        return take(o, () => {})
      },
      stop: async () => {
        run.stopped = true
      },
    }
  }
  const captured: Array<{packageName: string; photoId?: string}> = []
  const phonePhotoCoordinator = {
    capturePhoto: (packageName: string, _opts: unknown, photoId?: string) => {
      captured.push({packageName, photoId})
      return {photoId: photoId ?? "minted"}
    },
  }
  const Host = new Function(
    "runContinuousCapture",
    "phonePhotoCoordinator",
    "MiniappRequestType",
    "MiniappResponseType",
    `${compiled}; return Host`,
  )(runContinuousCapture, phonePhotoCoordinator, types, {
    CAMERA_CONTINUOUS_PHOTO: "photo",
    CAMERA_CONTINUOUS_STATE: "state",
  })
  const host = new Host()
  const results: unknown[] = []
  const pushes: unknown[] = []
  host.continuousRuns = new Map()
  host.cameraPermitted = () => true
  host.photoOpts = (payload: Record<string, unknown>) => ({size: payload.size})
  host.sendResult = (_app: string, requestId: string, success: boolean) => results.push({requestId, success})
  host.sendPhotoError = (_app: string, requestId: string, err: Error) => results.push({requestId, error: err.message})
  host.sendToMiniapp = (_app: string, payload: unknown) => pushes.push(payload)
  return {host, runs, captured, results, pushes}
}

const APP = "com.mentra.documentation"

test("a run starts once, reports its state and photos to its miniapp, and stops", async () => {
  const {host, runs, results, pushes} = fixture()
  await host.handleContinuousCapture(APP, "start", {runId: "r", size: "medium", maxPending: 4}, "q1")
  expect(runs.map((run) => [run.consumer, run.options.maxPending])).toEqual([[`miniapp ${APP}`, 4]])
  expect(pushes).toEqual([])
  runs[0].emitState("capturing")
  runs[0].emitPhoto("p1")
  expect(pushes).toEqual([
    {type: "state", runId: "r", state: "capturing"},
    {type: "photo", runId: "r", photoId: "p1"},
  ])
  await host.handleContinuousCapture(APP, "stop", {runId: "r"}, "q2")
  expect(runs[0].stopped).toBe(true)
  expect(results).toEqual([
    {requestId: "q1", success: true},
    {requestId: "q2", success: true},
  ])
})

test("a photo asked for is taken in the run's turn with the miniapp's photo ID", async () => {
  const {host, runs, captured, results} = fixture()
  await host.handleContinuousCapture(APP, "start", {runId: "r"}, "q1")
  await host.handleContinuousCapture(APP, "capture", {runId: "r", photoId: "asked-1", sound: true}, "q2")
  expect(runs[0].asked[0]).toMatchObject({photoId: "asked-1", sound: true})
  expect(captured).toEqual([{packageName: APP, photoId: "asked-1"}])
  expect(results[1]).toEqual({requestId: "q2", success: true})
  await host.handleContinuousCapture(APP, "capture", {runId: "other", photoId: "x"}, "q3")
  expect(results[2]).toEqual({requestId: "q3", error: "No continuous capture other"})
})

test("a miniapp closing stops its runs", async () => {
  const {host, runs} = fixture()
  await host.handleContinuousCapture(APP, "start", {runId: "a"}, "q1")
  await host.handleContinuousCapture(APP, "start", {runId: "b"}, "q2")
  host.stopContinuous(APP)
  expect(runs.map((run) => run.stopped)).toEqual([true, true])
  expect(host.continuousRuns.size).toBe(0)
})
