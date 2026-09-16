import * as ExpoCalendar from "expo-calendar"
import {Linking, PermissionsAndroid, Platform} from "react-native"
import {check, PERMISSIONS, request, RESULTS} from "react-native-permissions"

import showAlert from "@/utils/AlertUtils"
import {
  askPermissionsUI,
  checkPermissionsUI,
  PermissionFeatures,
  requestFeaturePermissions,
  requestPermissionsUI,
} from "@/utils/PermissionsUtils"

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

const mockStoredValues = new Map<string, unknown>()
const mockSave = jest.fn((key: string, value: unknown) => {
  mockStoredValues.set(key, value)
  return {is_error: () => false}
})
jest.mock("@/utils/storage/storage", () => ({
  storage: {
    load: jest.fn((key: string) => ({is_error: () => !mockStoredValues.has(key), value: mockStoredValues.get(key)})),
    remove: jest.fn((key: string) => {
      mockStoredValues.delete(key)
      return {is_error: () => false}
    }),
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
    mockStoredValues.clear()
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

describe("iOS miniapp microphone permission", () => {
  const originalPlatform = Platform.OS
  const app = {
    name: "Captions",
    permissions: [{type: "MICROPHONE", required: true}],
  } as Parameters<typeof askPermissionsUI>[0]
  const theme = {} as Parameters<typeof askPermissionsUI>[1]

  beforeEach(() => {
    jest.clearAllMocks()
    mockStoredValues.clear()
    Object.defineProperty(Platform, "OS", {configurable: true, value: "ios"})
    ;(check as jest.Mock).mockResolvedValue(RESULTS.DENIED)
    ;(request as jest.Mock).mockResolvedValue(RESULTS.BLOCKED)
  })

  afterEach(() => {
    Object.defineProperty(Platform, "OS", {configurable: true, value: originalPlatform})
    jest.restoreAllMocks()
  })

  it("does not ask for microphone access for a miniapp that does not require it", async () => {
    await expect(askPermissionsUI({...app, permissions: []}, theme)).resolves.toBe(1)
    expect(check).not.toHaveBeenCalled()
    expect(request).not.toHaveBeenCalled()
    expect(showAlert).not.toHaveBeenCalled()
  })

  it("allows Call to launch with optional calendar access denied", async () => {
    ;(check as jest.Mock).mockResolvedValue(RESULTS.GRANTED)
    ;(ExpoCalendar.getCalendarPermissionsAsync as jest.Mock).mockResolvedValue({
      canAskAgain: false,
      granted: false,
      status: "denied",
    })
    const call = {
      ...app,
      name: "Mentra Call",
      permissions: [
        {type: "PHONE_CAMERA", required: true},
        {type: "MICROPHONE", required: true},
        {type: "CALENDAR", required: false},
      ],
    } as typeof app

    await expect(askPermissionsUI(call, theme)).resolves.toBe(1)
    expect(ExpoCalendar.getCalendarPermissionsAsync).not.toHaveBeenCalled()
    expect(ExpoCalendar.requestCalendarPermissionsAsync).not.toHaveBeenCalled()
    expect(request).not.toHaveBeenCalled()
    expect(showAlert).not.toHaveBeenCalled()
  })

  it("allows cancelling miniapp startup before the system prompt", async () => {
    ;(showAlert as jest.Mock).mockImplementation((_title, _message, buttons) => buttons[0].onPress())
    await expect(askPermissionsUI(app, theme)).resolves.toBe(-1)
    expect(request).not.toHaveBeenCalled()
  })

  it.each([RESULTS.DENIED, RESULTS.BLOCKED])(
    "cancels launch without opening Settings after Don't Allow (%s)",
    async (result) => {
      ;(request as jest.Mock).mockResolvedValue(result)
      const openSettings = jest.spyOn(Linking, "openSettings").mockResolvedValue()
      ;(showAlert as jest.Mock).mockImplementation((_title, _message, buttons) => buttons[1].onPress())

      await expect(askPermissionsUI(app, theme)).resolves.toBe(-1)

      expect(request).toHaveBeenCalledWith(PERMISSIONS.IOS.MICROPHONE)
      expect(showAlert).toHaveBeenCalledTimes(1)
      expect(openSettings).not.toHaveBeenCalled()
    },
  )

  it("offers a cancellable feature-specific explanation when access was previously denied", async () => {
    const openSettings = jest.spyOn(Linking, "openSettings").mockResolvedValue()
    ;(check as jest.Mock).mockResolvedValue(RESULTS.BLOCKED)
    ;(showAlert as jest.Mock)
      .mockImplementationOnce((_title, _message, buttons) => buttons[1].onPress())
      .mockImplementationOnce((_title, _message, buttons) => buttons[0].onPress())

    await expect(askPermissionsUI(app, theme)).resolves.toBe(-1)

    expect(showAlert).toHaveBeenLastCalledWith(
      "permissions:permissionRequired",
      "permissions:phoneMicrophoneDeniedMessage",
      expect.arrayContaining([expect.objectContaining({text: "common:cancel"})]),
    )
    expect(request).not.toHaveBeenCalled()
    expect(openSettings).not.toHaveBeenCalled()
  })

  it("stops requesting other miniapp permissions after microphone denial", async () => {
    await expect(requestPermissionsUI([PermissionFeatures.MICROPHONE, PermissionFeatures.CALENDAR])).resolves.toBe(
      "cancelled",
    )
    expect(ExpoCalendar.requestCalendarPermissionsAsync).not.toHaveBeenCalled()
    expect(showAlert).not.toHaveBeenCalled()
  })

  it("opens Settings only when explicitly selected on a later feature attempt", async () => {
    const openSettings = jest.spyOn(Linking, "openSettings").mockResolvedValue()
    ;(check as jest.Mock).mockResolvedValue(RESULTS.BLOCKED)
    ;(showAlert as jest.Mock).mockImplementation((_title, _message, buttons) => buttons[1].onPress())

    await expect(askPermissionsUI(app, theme)).resolves.toBe(-1)
    expect(openSettings).toHaveBeenCalledTimes(1)
    expect(request).not.toHaveBeenCalled()
  })

  it("allows the miniapp to launch after microphone permission is granted", async () => {
    ;(showAlert as jest.Mock).mockImplementation((_title, _message, buttons) => buttons[1].onPress())
    ;(request as jest.Mock).mockImplementation(async () => {
      ;(check as jest.Mock).mockResolvedValue(RESULTS.GRANTED)
      return RESULTS.GRANTED
    })

    await expect(askPermissionsUI(app, theme)).resolves.toBe(1)
    await expect(checkPermissionsUI(app)).resolves.toEqual([])
  })
})

describe("Android miniapp microphone permission", () => {
  const originalPlatform = Platform.OS
  const app = {name: "Captions", permissions: [{type: "MICROPHONE", required: true}]} as Parameters<
    typeof askPermissionsUI
  >[0]
  const theme = {} as Parameters<typeof askPermissionsUI>[1]
  const mic = PermissionsAndroid.PERMISSIONS.RECORD_AUDIO

  beforeEach(() => {
    jest.clearAllMocks()
    mockStoredValues.clear()
    Object.defineProperty(Platform, "OS", {configurable: true, value: "android"})
    jest.spyOn(PermissionsAndroid, "check").mockResolvedValue(false)
    jest
      .spyOn(PermissionsAndroid, "requestMultiple")
      .mockResolvedValue({[mic]: PermissionsAndroid.RESULTS.DENIED} as Awaited<
        ReturnType<typeof PermissionsAndroid.requestMultiple>
      >)
    jest.spyOn(Linking, "openSettings").mockResolvedValue()
    ;(showAlert as jest.Mock).mockImplementation((_title, _message, buttons) => buttons[1].onPress())
  })

  afterEach(() => {
    jest.restoreAllMocks()
    Object.defineProperty(Platform, "OS", {configurable: true, value: originalPlatform})
  })

  it.each([PermissionsAndroid.RESULTS.DENIED, PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN])(
    "cancels launch without a Settings prompt after %s",
    async (result) => {
      ;(PermissionsAndroid.requestMultiple as jest.Mock).mockResolvedValue({[mic]: result})
      await expect(askPermissionsUI(app, theme)).resolves.toBe(-1)
      expect(showAlert).toHaveBeenCalledTimes(1)
      expect(Linking.openSettings).not.toHaveBeenCalled()
    },
  )

  it("lets users retry the native prompt after an ordinary denial", async () => {
    await expect(requestFeaturePermissions(PermissionFeatures.MICROPHONE)).resolves.toBe(false)
    await expect(requestFeaturePermissions(PermissionFeatures.MICROPHONE)).resolves.toBe(false)
    expect(PermissionsAndroid.requestMultiple).toHaveBeenCalledTimes(2)
    expect(showAlert).not.toHaveBeenCalled()
  })

  it("offers a cancellable explanation only on a later blocked feature attempt", async () => {
    ;(PermissionsAndroid.requestMultiple as jest.Mock).mockResolvedValue({
      [mic]: PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN,
    })
    await expect(requestFeaturePermissions(PermissionFeatures.MICROPHONE)).resolves.toBe(false)
    expect(showAlert).not.toHaveBeenCalled()
    ;(showAlert as jest.Mock).mockImplementation((_title, _message, buttons) => buttons[0].onPress())
    await expect(requestFeaturePermissions(PermissionFeatures.MICROPHONE)).resolves.toBe(false)
    expect(showAlert).toHaveBeenCalledWith(
      "permissions:permissionRequired",
      "permissions:phoneMicrophoneDeniedMessage",
      expect.any(Array),
    )
    expect(PermissionsAndroid.requestMultiple).toHaveBeenCalledTimes(1)
    expect(Linking.openSettings).not.toHaveBeenCalled()
  })

  it("opens Settings only after explicitly choosing it on a later attempt", async () => {
    ;(PermissionsAndroid.requestMultiple as jest.Mock).mockResolvedValue({
      [mic]: PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN,
    })
    await requestFeaturePermissions(PermissionFeatures.MICROPHONE)
    expect(Linking.openSettings).not.toHaveBeenCalled()
    await requestFeaturePermissions(PermissionFeatures.MICROPHONE)
    expect(Linking.openSettings).toHaveBeenCalledTimes(1)
  })

  it("launches after granting the native microphone prompt", async () => {
    ;(PermissionsAndroid.requestMultiple as jest.Mock).mockImplementation(async () => {
      ;(PermissionsAndroid.check as jest.Mock).mockResolvedValue(true)
      return {[mic]: PermissionsAndroid.RESULTS.GRANTED}
    })
    await expect(askPermissionsUI(app, theme)).resolves.toBe(1)
    expect(PermissionsAndroid.requestMultiple).toHaveBeenCalledWith([mic])
    expect(Linking.openSettings).not.toHaveBeenCalled()
  })

  it("allows a later grant and clears the remembered block", async () => {
    ;(PermissionsAndroid.requestMultiple as jest.Mock).mockResolvedValue({
      [mic]: PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN,
    })
    await requestFeaturePermissions(PermissionFeatures.MICROPHONE)
    ;(PermissionsAndroid.check as jest.Mock).mockResolvedValue(true)
    await expect(requestFeaturePermissions(PermissionFeatures.MICROPHONE)).resolves.toBe(true)
    await expect(askPermissionsUI(app, theme)).resolves.toBe(1)
    expect(mockStoredValues.has("PERMISSION_BLOCKED_microphone")).toBe(false)
    expect(showAlert).not.toHaveBeenCalled()
  })

  it("does not request other miniapp permissions after microphone denial", async () => {
    await expect(requestPermissionsUI([PermissionFeatures.MICROPHONE, PermissionFeatures.CALENDAR])).resolves.toBe(
      "cancelled",
    )
    expect(PermissionsAndroid.requestMultiple).toHaveBeenCalledTimes(1)
    expect(PermissionsAndroid.requestMultiple).toHaveBeenCalledWith([mic])
  })

  it("launches miniapps without microphone requirements while microphone is denied", async () => {
    await expect(askPermissionsUI({...app, permissions: []}, theme)).resolves.toBe(1)
    expect(PermissionsAndroid.requestMultiple).not.toHaveBeenCalled()
    expect(showAlert).not.toHaveBeenCalled()
  })
})
