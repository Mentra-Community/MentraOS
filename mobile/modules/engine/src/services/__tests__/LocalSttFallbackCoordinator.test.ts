import {afterEach, beforeEach, expect, mock, test} from "bun:test"

/** The Speech-page model, as native and the model manager see it. */
let picked = "fr"
const downloaded = new Set<string>(["fr", "de", "en-kroko"])
let loadedNativeModel: string | null = null
let nativeDemand = false
const events: string[] = []
const setSetting = mock((_key: string, value: boolean) => {
  events.push(`demand ${value}`)
})
const updateBluetoothSettings = mock(async (patch: Record<string, unknown>) => {
  nativeDemand = patch.local_stt_fallback_active === true
})
const restart = mock(async () => {
  events.push(`restart ${picked}`)
  // Native loads only while on-device transcription is in demand.
  if (nativeDemand) loadedNativeModel = `/models/${picked}`
})
mock.module("@mentra/bluetooth-sdk/internal", () => ({
  default: {
    restartTranscriber: restart,
    updateBluetoothSettings,
    isSttModelLoaded: async (path: string) => loadedNativeModel === path,
  },
}))
mock.module("../../runtime/config", () => ({
  ISLAND_SETTINGS_KEYS: {localSttFallbackActive: "local_stt_fallback_active"},
}))
mock.module("../../stores/settings", () => ({useSettingsStore: {getState: () => ({setSetting})}}))
const selectionListeners = new Set<() => void>()
const activate = mock(async (code: string) => {
  events.push(`activate ${code}`)
  const changed = picked !== code
  picked = code
  if (changed) for (const listener of selectionListeners) listener()
})
mock.module("../STTModelManager", () => ({
  default: {
    getCurrentLanguageFromPreferences: async () => picked,
    getCurrentLanguage: () => picked,
    getModelPath: (code?: string) => `/models/${code ?? picked}`,
    getBcp47ForLanguage: (code?: string) =>
      ({"fr": "fr-FR", "de": "de-DE", "en-kroko": "en-US"})[(code ?? picked) as "fr"] ?? "en-US",
    isModelAvailable: async (code?: string) => downloaded.has(code ?? picked),
    activateLanguage: activate,
    onSelectionChanged: (listener: () => void) => {
      selectionListeners.add(listener)
      return () => selectionListeners.delete(listener)
    },
  },
}))
let download: (code: string, onProgress?: (percent: number) => void) => Promise<void> = async (code) => {
  downloaded.add(code)
}
mock.module("../OfflineSpeechModelService", () => ({
  default: {downloadSttModel: (code: string, onProgress?: (percent: number) => void) => download(code, onProgress)},
}))
const retryTimers: Array<() => void> = []
mock.module("../../utils/timers", () => ({
  BgTimer: {
    setTimeout: (callback: () => void) => {
      retryTimers.push(callback)
      return retryTimers.length
    },
    clearTimeout: (id: number) => {
      retryTimers[id - 1] = () => {}
    },
  },
}))

const {default: coordinator} = await import("../LocalSttFallbackCoordinator")
type Status = ReturnType<typeof coordinator.getModelStatus>
const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}
let statuses: Status[] = []
let offStatus = () => {}

beforeEach(() => {
  picked = "fr"
  downloaded.clear()
  for (const code of ["fr", "de", "en-kroko"]) downloaded.add(code)
  loadedNativeModel = null
  nativeDemand = false
  events.length = 0
  retryTimers.length = 0
  download = async (code) => {
    downloaded.add(code)
  }
  restart.mockClear()
  activate.mockClear()
  statuses = []
  offStatus = coordinator.onModelStatusChanged((status) => statuses.push(status))
})

afterEach(async () => {
  offStatus()
  coordinator.setDemand(false)
  await settle()
})

test("on-device demand loads the picked model, after native sees the demand", async () => {
  coordinator.setDemand(true)
  await settle()
  expect(loadedNativeModel).toBe("/models/fr")
  expect(coordinator.isActive()).toBe(true)
  expect(coordinator.getActiveLanguage()).toBe("fr-FR")
  expect(updateBluetoothSettings).toHaveBeenCalledWith({local_stt_fallback_active: true})
  expect(events.indexOf("demand true")).toBeLessThan(events.indexOf("restart fr"))
  expect(activate).not.toHaveBeenCalled()
  expect(statuses.map((s) => s.state)).toEqual(["idle", "loading", "ready"])
  expect(statuses.at(-1)).toEqual({code: "fr", language: "fr-FR", state: "ready"})
})

test("without demand nothing loads, and demand going away unloads", async () => {
  coordinator.setDemand(false)
  await settle()
  expect(restart).not.toHaveBeenCalled()
  coordinator.setDemand(true)
  await settle()
  expect(coordinator.isActive()).toBe(true)
  coordinator.setDemand(false)
  await settle()
  expect(coordinator.isActive()).toBe(false)
  expect(statuses.at(-1)?.state).toBe("idle")
})

test("a missing picked model downloads through the Speech page with progress, then loads", async () => {
  picked = "de"
  downloaded.delete("de")
  let finish!: () => void
  download = (code, onProgress) =>
    new Promise<void>((resolve) => {
      onProgress?.(40)
      finish = () => {
        downloaded.add(code)
        resolve()
      }
    })
  coordinator.setDemand(true)
  await settle()
  expect(statuses.at(-1)).toEqual({code: "de", language: "de-DE", state: "downloading", progress: 40})
  expect(restart).not.toHaveBeenCalled()
  finish()
  await settle()
  expect(activate).toHaveBeenCalledWith("de")
  expect(loadedNativeModel).toBe("/models/de")
  expect(statuses.at(-1)?.state).toBe("ready")
})

test("a failed download reports unavailable and retries on the shared schedule", async () => {
  picked = "de"
  downloaded.delete("de")
  download = async () => {
    throw new Error("offline")
  }
  coordinator.setDemand(true)
  await settle()
  expect(statuses.at(-1)).toMatchObject({state: "unavailable", reason: expect.stringContaining("offline")})
  expect(retryTimers).toHaveLength(1)
  // The same demand waits for its retry instead of hammering the download.
  coordinator.setDemand(true)
  await settle()
  expect(retryTimers).toHaveLength(1)
  download = async (code) => {
    downloaded.add(code)
  }
  retryTimers[0]()
  await settle()
  expect(statuses.at(-1)?.state).toBe("ready")
})

test("a failed load is retried on the next load attempt and on schedule", async () => {
  restart.mockImplementationOnce(async () => {
    throw new Error("native model failed")
  })
  coordinator.setDemand(true)
  await settle()
  expect(coordinator.isActive()).toBe(false)
  expect(statuses.at(-1)).toMatchObject({state: "unavailable", reason: expect.stringContaining("native model failed")})
  expect(retryTimers).toHaveLength(1)
  retryTimers[0]()
  await settle()
  expect(coordinator.isActive()).toBe(true)

  // A restart that resolves without loading never reports ready either.
  coordinator.setDemand(false)
  await settle()
  loadedNativeModel = null // native releases the recognizer when demand ends
  restart.mockImplementationOnce(async () => {})
  coordinator.setDemand(true)
  await settle()
  expect(statuses.at(-1)?.state).toBe("unavailable")
  // New demand is a new load attempt: it retries without waiting.
  coordinator.setDemand(false)
  coordinator.setDemand(true)
  await settle()
  expect(statuses.at(-1)?.state).toBe("ready")
})

test("changing the Speech-page model reloads the recognizer while it is in use", async () => {
  coordinator.setDemand(true)
  await settle()
  expect(loadedNativeModel).toBe("/models/fr")
  picked = "de"
  for (const listener of selectionListeners) listener()
  expect(coordinator.isActive()).toBe(false)
  await settle()
  expect(loadedNativeModel).toBe("/models/de")
  expect(coordinator.getActiveLanguage()).toBe("de-DE")
  expect(statuses.at(-1)).toEqual({code: "de", language: "de-DE", state: "ready"})
})

test("a model change during a long download starts the new model without waiting", async () => {
  picked = "de"
  downloaded.delete("de")
  download = () => new Promise<void>(() => {})
  coordinator.setDemand(true)
  await settle()
  expect(statuses.at(-1)?.state).toBe("downloading")
  picked = "fr"
  for (const listener of selectionListeners) listener()
  await settle()
  expect(loadedNativeModel).toBe("/models/fr")
  expect(statuses.at(-1)).toEqual({code: "fr", language: "fr-FR", state: "ready"})
})

test("ending demand releases native demand and goes idle", async () => {
  coordinator.setDemand(true)
  await settle()
  coordinator.setDemand(false)
  expect(coordinator.isActive()).toBe(false)
  expect(coordinator.getActiveLanguage()).toBeNull()
  expect(setSetting).toHaveBeenLastCalledWith("local_stt_fallback_active", false)
  expect(statuses.at(-1)?.state).toBe("idle")
})

test("new listeners get the current status immediately", async () => {
  coordinator.setDemand(true)
  await settle()
  let latest: Status | undefined
  const off = coordinator.onModelStatusChanged((status) => {
    latest = status
  })
  expect(latest).toEqual({code: "fr", language: "fr-FR", state: "ready"})
  off()
})
