// Mock the in-island model managers (they pull native deps) so the real speech
// facade's forwarding can be exercised under the mobile jest runner.
jest.mock("../../modules/engine/src/services/STTModelManager", () => ({
  __esModule: true,
  default: {
    getCurrentLanguage: jest.fn(() => "en"),
    getAvailableLanguages: jest.fn(() => [{code: "en"}]),
    getAllLanguageInfo: jest.fn(() => Promise.resolve([])),
    downloadModel: jest.fn(() => Promise.resolve()),
    activateLanguage: jest.fn(() => Promise.resolve()),
    cancelDownload: jest.fn(() => Promise.resolve()),
    deleteModel: jest.fn(() => Promise.resolve()),
  },
}))
jest.mock("../../modules/engine/src/services/TTSModelManager", () => ({
  __esModule: true,
  default: {
    getCurrentLanguage: jest.fn(() => "en"),
    getAvailableLanguages: jest.fn(() => []),
    getAllLanguageInfo: jest.fn(() => Promise.resolve([])),
    downloadModel: jest.fn(() => Promise.resolve()),
    setCurrentLanguage: jest.fn(),
    cancelDownload: jest.fn(() => Promise.resolve()),
    deleteModel: jest.fn(() => Promise.resolve()),
  },
}))
jest.mock("../../modules/engine/src/services/OfflineSpeechModelService", () => ({
  __esModule: true,
  default: {getStatus: jest.fn(() => null), subscribe: jest.fn(() => () => {})},
}))

import sttModelManager from "../../modules/engine/src/services/STTModelManager"
import ttsModelManager from "../../modules/engine/src/services/TTSModelManager"
import {speech} from "../../modules/engine/src/facades/speech"

describe("speech facade", () => {
  beforeEach(() => jest.clearAllMocks())

  it("stt.activate persists the native model path through activateLanguage", async () => {
    await speech.stt.activate("fr")
    expect(sttModelManager.activateLanguage).toHaveBeenCalledWith("fr")
  })

  it("stt.cancelDownload cancels the named download", async () => {
    await speech.stt.cancelDownload("de")
    expect(sttModelManager.cancelDownload).toHaveBeenCalledWith("de")
  })

  it("stt.download forwards its args to downloadModel", async () => {
    const onProgress = jest.fn()
    await speech.stt.download("de", onProgress)
    expect(sttModelManager.downloadModel).toHaveBeenCalledWith("de", onProgress)
  })

  it("tts methods delegate to the TTS manager", () => {
    expect(speech.tts.currentLanguage()).toBe("en")
    speech.tts.activate("es")
    expect(ttsModelManager.setCurrentLanguage).toHaveBeenCalledWith("es")
  })
})
