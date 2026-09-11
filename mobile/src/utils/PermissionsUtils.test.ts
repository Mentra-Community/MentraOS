import * as ExpoCalendar from "expo-calendar"
import {Platform} from "react-native"
import {request} from "react-native-permissions"

import {PermissionFeatures, requestFeaturePermissions} from "@/utils/PermissionsUtils"

jest.mock("@mentra/crust", () => ({
  __esModule: true,
  default: {hasNotificationListenerPermission: jest.fn()},
}))

jest.mock("expo-calendar", () => ({
  getCalendarPermissionsAsync: jest.fn(),
  requestCalendarPermissionsAsync: jest.fn(),
}))

jest.mock("@/i18n", () => ({
  translate: jest.fn((key: string) => key),
}))

jest.mock("@/utils/AlertUtils", () => ({
  __esModule: true,
  default: jest.fn(),
  showBluetoothAlert: jest.fn(),
  showLocationAlert: jest.fn(),
  showLocationServicesAlert: jest.fn(),
}))

jest.mock("@/utils/NotificationServiceUtils", () => ({
  checkAndRequestNotificationAccessSpecialPermission: jest.fn(),
}))

const mockSave = jest.fn((_key: string, _value: unknown) => ({is_error: () => false}))
jest.mock("@/utils/storage/storage", () => ({
  storage: {
    load: jest.fn(() => ({is_error: () => true})),
    remove: jest.fn(() => ({is_error: () => false})),
    save: (key: string, value: unknown) => mockSave(key, value),
  },
}))

describe("requestFeaturePermissions calendar access", () => {
  const originalPlatform = Platform.OS

  beforeAll(() => {
    Object.defineProperty(Platform, "OS", {configurable: true, value: "ios"})
  })

  afterAll(() => {
    Object.defineProperty(Platform, "OS", {configurable: true, value: originalPlatform})
  })

  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("uses expo-calendar's returned grant instead of cross-checking another permission bridge", async () => {
    ;(ExpoCalendar.getCalendarPermissionsAsync as jest.Mock).mockResolvedValue({
      canAskAgain: true,
      granted: false,
      status: "undetermined",
    })
    ;(ExpoCalendar.requestCalendarPermissionsAsync as jest.Mock).mockResolvedValue({
      canAskAgain: true,
      granted: true,
      status: "granted",
    })

    await expect(requestFeaturePermissions(PermissionFeatures.CALENDAR)).resolves.toBe(true)

    expect(ExpoCalendar.requestCalendarPermissionsAsync).toHaveBeenCalledTimes(1)
    expect(ExpoCalendar.getCalendarPermissionsAsync).toHaveBeenCalledTimes(1)
    expect(request).not.toHaveBeenCalled()
    expect(mockSave).toHaveBeenCalledWith("PERMISSION_GRANTED_calendar", true)
  })
})
