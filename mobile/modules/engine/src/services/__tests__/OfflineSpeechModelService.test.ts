/// <reference types="bun-types" />

import {beforeEach, expect, mock, test} from "bun:test"

const events: string[] = []
let saved = "en"
const available = new Set<string>(["en"])
let failDownload = false
const stt = {
  getCurrentLanguageFromPreferences: mock(async () => saved),
  getCurrentLanguage: () => saved || "en-kroko",
  getLegacyReplacement: (code: string) => (code === "en" ? "en-kroko" : undefined),
  isModelAvailable: async (code: string) => available.has(code),
  downloadModel: mock(async (code: string, onProgress?: (p: {percentage: number}) => void) => {
    events.push(`download ${code}`)
    onProgress?.({percentage: 50})
    if (failDownload) throw new Error("offline")
    available.add(code)
  }),
  activateLanguage: mock(async (code: string) => {
    events.push(`activate ${code}`)
    saved = code
  }),
  deleteModel: mock(async (code: string) => {
    events.push(`delete ${code}`)
    available.delete(code)
  }),
}
mock.module("../STTModelManager", () => ({default: stt}))
mock.module("../TTSModelManager", () => ({
  default: {
    getCurrentLanguageFromPreferences: async () => "en",
    getCurrentLanguage: () => "en",
    isModelAvailable: async () => true,
    activateLanguage: async () => {},
  },
}))
const wakeWord = {
  code: "hey-mentra",
  isModelAvailable: mock(async () => true),
  downloadModel: mock(async () => {}),
}
mock.module("../WakeWordModelManager", () => ({default: wakeWord}))
const {OfflineSpeechModelService} = await import("../OfflineSpeechModelService")

function service() {
  return new (OfflineSpeechModelService as unknown as new () => InstanceType<typeof OfflineSpeechModelService>)()
}

beforeEach(() => {
  events.length = 0
  saved = "en"
  available.clear()
  available.add("en")
  failDownload = false
  wakeWord.isModelAvailable.mockImplementation(async () => true)
  wakeWord.downloadModel.mockClear()
})

test("an old English selection keeps working until Kroko is downloaded, then moves and frees it", async () => {
  const statuses: string[] = []
  const svc = service()
  svc.subscribe((status) => status && statuses.push(`${status.kind}:${status.languageCode}:${status.stage}`))
  await svc.ensureSttModel()
  expect(events).toEqual(["download en-kroko", "activate en-kroko", "delete en"])
  expect(saved).toBe("en-kroko")
  expect(available.has("en")).toBe(false)
  expect(statuses).toContain("stt:en-kroko:downloading")
  expect(statuses.at(-1)).toBe("stt:en-kroko:complete")
})

test("picking another language while Kroko downloads keeps that choice and still frees the old model", async () => {
  available.add("fr")
  stt.downloadModel.mockImplementationOnce(async (code: string) => {
    events.push(`download ${code}`)
    saved = "fr" // the user picks French on the Speech page mid-download
    available.add(code)
  })
  await service().ensureSttModel()
  expect(events).toEqual(["download en-kroko", "delete en"])
  expect(saved).toBe("fr")
})

test("picking another language while the default downloads does not switch back", async () => {
  saved = ""
  available.clear()
  available.add("fr")
  stt.downloadModel.mockImplementationOnce(async (code: string) => {
    events.push(`download ${code}`)
    saved = "fr"
    available.add(code)
  })
  await service().ensureSttModel()
  expect(events).toEqual(["download en-kroko"])
  expect(saved).toBe("fr")
})

test("a failed Kroko download leaves the old English model selected", async () => {
  failDownload = true
  await expect(service().ensureSttModel()).rejects.toThrow("offline")
  expect(saved).toBe("en")
  expect(available.has("en")).toBe(true)
  expect(events).toEqual(["download en-kroko"])
})

test("no saved model downloads the default; a current model is just activated", async () => {
  saved = ""
  available.clear()
  await service().ensureSttModel()
  expect(events).toEqual(["download en-kroko", "activate en-kroko"])
  events.length = 0
  saved = "fr"
  available.add("fr")
  await service().ensureSttModel()
  expect(events).toEqual(["activate fr"])
})

test("the startup download includes the wake-word model", async () => {
  saved = "fr"
  available.add("fr")
  wakeWord.isModelAvailable.mockImplementation(async () => false)
  const statuses: string[] = []
  const svc = service()
  svc.subscribe((status) => status && statuses.push(`${status.kind}:${status.stage}`))
  await svc.ensureDefaultModels()
  expect(wakeWord.downloadModel).toHaveBeenCalledTimes(1)
  expect(statuses).toContain("wakeword:downloading")
  expect(statuses.at(-1)).toBe("wakeword:complete")
})
