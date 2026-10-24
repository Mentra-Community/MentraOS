import {engine, type PendingRunningUpdatePrompt} from "@mentra/engine"

import {initI18n} from "@/i18n"

import {
  installRunningUpdatePromptBridge,
  presentRunningUpdateFailure,
  presentRunningUpdatePrompt,
} from "./runningUpdatePromptBridge"

const mockToast = jest.fn()
jest.mock("react-native-toast-message", () => ({
  __esModule: true,
  default: {show: (...args: unknown[]) => mockToast(...args)},
}))
jest.mock("@/components/home/AppIcon", () => ({__esModule: true, default: () => null}))
const mockShowAlert = jest.fn()
const mockWaitForAlertHost = jest.fn()
jest.mock("@/contexts/ModalContext", () => ({
  showAlert: (...args: unknown[]) => mockShowAlert(...args),
  waitForAlertHost: () => mockWaitForAlertHost(),
}))

function pending(answer = jest.fn()): PendingRunningUpdatePrompt {
  return {packageName: "com.acme.notes", displayName: "Notes", version: "1.1.0", answer}
}

beforeAll(async () => {
  await initI18n()
})

beforeEach(() => {
  mockShowAlert.mockReset()
  mockWaitForAlertHost.mockReset().mockResolvedValue(undefined)
})

describe("running update prompt bridge", () => {
  it("shows the update prompt with its copy and answers Update", async () => {
    mockShowAlert.mockResolvedValue(1)
    const prompt = pending()
    await presentRunningUpdatePrompt(prompt)
    expect(mockShowAlert).toHaveBeenCalledWith({
      title: "Update Notes?",
      message: "Notes will restart.",
      buttons: [{text: "Not now", style: "cancel"}, {text: "Update"}],
      options: {icon: undefined, allowDismiss: true},
    })
    expect(prompt.answer).toHaveBeenCalledWith("update")
  })

  it("reads the answer by the button's role: the top button of the sheet is Update, the bottom one Not now", async () => {
    const {sheetButtonOrder} = jest.requireActual("@/contexts/ModalContext") as typeof import("@/contexts/ModalContext")
    for (const [position, expected] of [
      [0, "update"],
      [1, "not_now"],
    ] as const) {
      mockShowAlert.mockReset().mockImplementation(async ({buttons}) => sheetButtonOrder(buttons)[position]!.index)
      const prompt = pending()
      await presentRunningUpdatePrompt(prompt)
      expect(sheetButtonOrder(mockShowAlert.mock.calls[0][0].buttons).map(({button}) => button.text)).toEqual([
        "Update",
        "Not now",
      ])
      expect(prompt.answer).toHaveBeenCalledWith(expected)
    }
  })

  it("does not show the sheet until the alert host is mounted", async () => {
    let mount!: () => void
    mockWaitForAlertHost.mockReturnValue(new Promise<void>((resolve) => (mount = resolve)))
    mockShowAlert.mockResolvedValue(1)
    const prompt = pending()
    const shown = presentRunningUpdatePrompt(prompt)
    await Promise.resolve()
    expect(mockShowAlert).not.toHaveBeenCalled()
    expect(prompt.answer).not.toHaveBeenCalled()
    mount()
    await shown
    expect(mockShowAlert).toHaveBeenCalledTimes(1)
    expect(prompt.answer).toHaveBeenCalledWith("update")
  })

  it.each([0, -1, 7])("treats Not now and a dismissal (%i) as Not now", async (choice) => {
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

  it("shows the failure as a toast with the version the user keeps", () => {
    presentRunningUpdateFailure({packageName: "com.acme.notes", displayName: "Notes", installedVersion: "1.0.0"})
    expect(mockToast).toHaveBeenCalledWith({
      type: "error",
      text1: "Couldn't update Notes. You're still on version 1.0.0.",
    })
    expect(mockShowAlert).not.toHaveBeenCalled()
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
