import {Platform} from "react-native"
import CrustModule from "@mentra/crust"

import showAlert from "@/utils/AlertUtils"

import {checkAndRequestNotificationAccessSpecialPermission} from "./NotificationServiceUtils"
import {checkPermissionAfterSettingsReturn} from "./notificationPermissionFlow"

jest.mock("@mentra/crust", () => ({
  __esModule: true,
  default: {
    hasNotificationListenerPermission: jest.fn(),
    openNotificationListenerSettings: jest.fn(),
  },
}))

jest.mock("@/utils/AlertUtils", () => ({
  __esModule: true,
  default: jest.fn(),
}))

jest.mock("./notificationPermissionFlow", () => ({
  checkPermissionAfterSettingsReturn: jest.fn(),
}))

const mockCrust = CrustModule as jest.Mocked<typeof CrustModule>
const mockShowAlert = showAlert as jest.MockedFunction<typeof showAlert>
const mockCheckPermissionAfterSettingsReturn = checkPermissionAfterSettingsReturn as jest.MockedFunction<
  typeof checkPermissionAfterSettingsReturn
>

describe("checkAndRequestNotificationAccessSpecialPermission", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    Object.defineProperty(Platform, "OS", {value: "android", configurable: true, writable: true})
    mockCrust.hasNotificationListenerPermission.mockResolvedValue(false)
  })

  it("distinguishes postponing the prompt from denying in Settings", async () => {
    const result = checkAndRequestNotificationAccessSpecialPermission()
    await Promise.resolve()

    const buttons = mockShowAlert.mock.calls[0][2]
    buttons?.[0].onPress?.()

    await expect(result).resolves.toBe("cancelled")
  })

  it("reports denial after returning from Settings without access", async () => {
    mockCheckPermissionAfterSettingsReturn.mockResolvedValue(false)
    const result = checkAndRequestNotificationAccessSpecialPermission()
    await Promise.resolve()

    const buttons = mockShowAlert.mock.calls[0][2]
    await buttons?.[1].onPress?.()

    await expect(result).resolves.toBe("denied")
  })

  it("reports granted access after the Settings round-trip", async () => {
    mockCheckPermissionAfterSettingsReturn.mockResolvedValue(true)
    const result = checkAndRequestNotificationAccessSpecialPermission()
    await Promise.resolve()

    const buttons = mockShowAlert.mock.calls[0][2]
    await buttons?.[1].onPress?.()

    await expect(result).resolves.toBe("granted")
  })
})
