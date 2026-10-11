import {engine, type PendingRunningUpdatePrompt} from "@mentra/engine"

import {initI18n} from "@/i18n"

import {
  installRunningUpdatePromptBridge,
  presentRunningUpdateFailure,
  presentRunningUpdatePrompt,
} from "./runningUpdatePromptBridge"

const mockShowAlert = jest.fn()
jest.mock("@/contexts/ModalContext", () => ({showAlert: (...args: unknown[]) => mockShowAlert(...args)}))

function pending(answer = jest.fn()): PendingRunningUpdatePrompt {
  return {packageName: "com.acme.notes", displayName: "Notes", version: "1.1.0", answer}
}

beforeAll(async () => {
  await initI18n()
})

beforeEach(() => mockShowAlert.mockReset())

describe("running update prompt bridge", () => {
  it("shows the update prompt with its copy and answers Update", async () => {
    mockShowAlert.mockResolvedValue(1)
    const prompt = pending()
    await presentRunningUpdatePrompt(prompt)
    expect(mockShowAlert).toHaveBeenCalledWith({
      title: "Update Notes?",
      message: "Version 1.1.0 is ready. Notes will close and reopen to update.",
      buttons: [{text: "Not now", style: "cancel"}, {text: "Update"}],
      options: {allowDismiss: true},
    })
    expect(prompt.answer).toHaveBeenCalledWith("update")
  })

  it.each([0, -1])("treats Not now and a dismissal (%i) as Not now", async (choice) => {
    mockShowAlert.mockResolvedValue(choice)
    const prompt = pending()
    await presentRunningUpdatePrompt(prompt)
    expect(prompt.answer).toHaveBeenCalledWith("not_now")
  })

  it("answers Not now if the alert cannot be shown", async () => {
    mockShowAlert.mockRejectedValue(new Error("modal unavailable"))
    const prompt = pending()
    await expect(presentRunningUpdatePrompt(prompt)).rejects.toThrow("modal unavailable")
    expect(prompt.answer).toHaveBeenCalledWith("not_now")
  })

  it("shows the failure message with the version the user keeps", () => {
    mockShowAlert.mockResolvedValue(0)
    presentRunningUpdateFailure({packageName: "com.acme.notes", displayName: "Notes", installedVersion: "1.0.0"})
    expect(mockShowAlert).toHaveBeenCalledWith({
      title: "Couldn't update Notes",
      message: "You're still on version 1.0.0.",
      buttons: [{text: "OK"}],
    })
  })

  it("subscribes to the engine's prompts and failures and unsubscribes both", () => {
    const offPrompt = jest.fn()
    const offFailure = jest.fn()
    jest.mocked(engine.miniapps.onUpdatePrompt).mockReturnValueOnce(offPrompt)
    jest.mocked(engine.miniapps.onUpdateFailed).mockReturnValueOnce(offFailure)
    const uninstall = installRunningUpdatePromptBridge()
    expect(engine.miniapps.onUpdatePrompt).toHaveBeenCalledTimes(1)
    expect(engine.miniapps.onUpdateFailed).toHaveBeenCalledWith(presentRunningUpdateFailure)
    uninstall()
    expect(offPrompt).toHaveBeenCalled()
    expect(offFailure).toHaveBeenCalled()
  })
})
