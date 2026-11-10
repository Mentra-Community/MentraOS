import {act, render} from "@testing-library/react-native"
import CrustModule from "@mentra/crust"

import {showAlert} from "@/contexts/ModalContext"
import {
  FEEDBACK_ROUTE,
  SCREENSHOT_PROMPT_COOLDOWN_MS,
  ScreenshotFeedbackPrompt,
  shouldPromptForScreenshot,
  useFeedbackFormOpen,
} from "@/effects/ScreenshotFeedbackPrompt"

let mockScreenshotListener: (() => void) | null = null
// Hosted miniapps (Settings, Feedback) keep their screens off the root history: the route stays Home.
const mockRoute = "/home"
const mockPush = jest.fn()

jest.mock("expo-screen-capture", () => ({
  addScreenshotListener: jest.fn((listener: () => void) => {
    mockScreenshotListener = listener
    return {remove: jest.fn()}
  }),
}))
jest.mock("@mentra/crust", () => ({
  __esModule: true,
  default: {isBetaBuild: jest.fn(), isScreenCaptured: jest.fn()},
}))
jest.mock("@/contexts/ModalContext", () => ({showAlert: jest.fn()}))
jest.mock("@/stores/navigation", () => ({
  useNavigationStore: {getState: () => ({getCurrentRoute: () => mockRoute, push: mockPush})},
}))
jest.mock("@/i18n", () => ({translate: (key: string) => key}))

const NOW = 1_800_000_000_000

function FeedbackForm() {
  useFeedbackFormOpen()
  return null
}

describe("shouldPromptForScreenshot", () => {
  const idle = {open: false, lastShownAtMs: null}

  it("prompts on the first screenshot", () => {
    expect(shouldPromptForScreenshot(idle, false, NOW)).toBe(true)
  })

  it("stays quiet while the prompt is up or the feedback form is open", () => {
    expect(shouldPromptForScreenshot({open: true, lastShownAtMs: null}, false, NOW)).toBe(false)
    expect(shouldPromptForScreenshot(idle, true, NOW)).toBe(false)
  })

  it("shows at most once per cooldown", () => {
    const shown = {open: false, lastShownAtMs: NOW}
    expect(shouldPromptForScreenshot(shown, false, NOW + 3_000)).toBe(false)
    expect(shouldPromptForScreenshot(shown, false, NOW + SCREENSHOT_PROMPT_COOLDOWN_MS)).toBe(true)
  })
})

describe("ScreenshotFeedbackPrompt", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockScreenshotListener = null
    jest.spyOn(Date, "now").mockReturnValue(NOW)
    jest.mocked(CrustModule.isBetaBuild).mockResolvedValue(true)
    jest.mocked(CrustModule.isScreenCaptured).mockResolvedValue(false)
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  async function mount() {
    render(<ScreenshotFeedbackPrompt />)
    await act(async () => {})
    expect(mockScreenshotListener).not.toBeNull()
  }

  async function screenshot() {
    await act(async () => {
      mockScreenshotListener!()
    })
  }

  it("opens the feedback form once for repeated screenshots, never over the form", async () => {
    jest.mocked(showAlert).mockResolvedValue(1)
    await mount()

    await screenshot()
    expect(showAlert).toHaveBeenCalledTimes(1)
    expect(mockPush).toHaveBeenCalledWith(
      FEEDBACK_ROUTE,
      expect.objectContaining({triggerReason: "screenshot_detected"}),
    )

    // The form opens inside the hosted Feedback miniapp, with the root route still Home: screenshot events
    // every few seconds, even past the cooldown, don't bring the prompt back over it.
    const form = render(<FeedbackForm />)
    for (let i = 1; i <= 5; i++) {
      jest.mocked(Date.now).mockReturnValue(NOW + i * 3_000)
      await screenshot()
    }
    jest.mocked(Date.now).mockReturnValue(NOW + SCREENSHOT_PROMPT_COOLDOWN_MS + 1)
    await screenshot()
    expect(showAlert).toHaveBeenCalledTimes(1)

    // Back home, within the cooldown: still quiet. After it: one prompt again.
    form.unmount()
    jest.mocked(Date.now).mockReturnValue(NOW + 60_000)
    await screenshot()
    expect(showAlert).toHaveBeenCalledTimes(1)
    jest.mocked(Date.now).mockReturnValue(NOW + SCREENSHOT_PROMPT_COOLDOWN_MS + 1)
    await screenshot()
    expect(showAlert).toHaveBeenCalledTimes(2)
  })

  it("ignores screenshot events while the screen is mirrored or recorded", async () => {
    jest.mocked(CrustModule.isScreenCaptured).mockResolvedValue(true)
    await mount()

    await screenshot()
    await screenshot()
    expect(showAlert).not.toHaveBeenCalled()
  })

  it("shows one prompt for a burst of screenshot events", async () => {
    let answer: (index: number) => void = () => {}
    jest.mocked(showAlert).mockReturnValue(new Promise((resolve) => (answer = resolve)))
    await mount()

    await act(async () => {
      mockScreenshotListener!()
      mockScreenshotListener!()
      mockScreenshotListener!()
    })
    expect(showAlert).toHaveBeenCalledTimes(1)
    await act(async () => answer(0))
    expect(mockPush).not.toHaveBeenCalled()
  })
})
