import {engine, SETTINGS} from "@mentra/engine"
import {act, fireEvent, render, screen} from "@testing-library/react-native"
import * as Clipboard from "expo-clipboard"
import {Share} from "react-native"

import DataExportPage from "@/app/miniapps/settings/data-export"
import type {MentraAuthSession, MentraAuthUser} from "@/utils/auth/authProvider.types"

let mockNativeApplicationVersion: string | null = null
let mockAuth: {user: MentraAuthUser | null; session: MentraAuthSession | null} = {user: null, session: null}

jest.mock("expo-application", () => ({
  get nativeApplicationVersion() {
    return mockNativeApplicationVersion
  },
}))
jest.mock("expo-clipboard", () => ({setStringAsync: jest.fn(() => Promise.resolve(true))}))
jest.mock("@/utils/AlertUtils", () => ({showAlert: jest.fn()}))
jest.mock("@/contexts/AuthContext", () => ({useAuth: () => mockAuth}))
jest.mock("@/contexts/ThemeContext", () => ({
  useAppTheme: () => ({theme: {spacing: {s3: 12, s4: 16, s6: 24}, colors: {}}, themed: () => ({})}),
}))
jest.mock("@/stores/navigation", () => ({useNavigationStore: {getState: () => ({goBack: jest.fn()})}}))
jest.mock("@/i18n", () => ({translate: (key: string) => key}))
jest.mock("@/components/ui/Divider", () => ({Divider: () => null}))
jest.mock("@/components/ui/Spacer", () => ({Spacer: () => null}))
jest.mock("@/components/ui/Group", () => ({
  Group: ({children}: {children: React.ReactNode}) => children,
}))
jest.mock("@/components/ignite", () => {
  const {Pressable, Text, View} = require("react-native")
  return {
    Screen: View,
    Header: () => null,
    Icon: () => null,
    Text: ({text}: {text: string}) => <Text>{text}</Text>,
    Button: ({text, onPress, disabled}: {text: string; onPress: () => void; disabled?: boolean}) => (
      <Pressable accessibilityRole="button" onPress={onPress} disabled={disabled}>
        <Text>{text}</Text>
      </Pressable>
    ),
  }
})

async function sharedExport(): Promise<string> {
  const share = jest.spyOn(Share, "share").mockResolvedValue({action: Share.sharedAction})
  render(<DataExportPage />)
  await act(async () => {})
  await act(async () => fireEvent.press(screen.getByRole("button", {name: "profileSettings:dataExportShare"})))

  expect(share).toHaveBeenCalledTimes(1)
  return share.mock.calls[0][0].message ?? ""
}

async function sharedExportMetadata() {
  const message = await sharedExport()
  return JSON.parse(message.slice(message.indexOf("{"))).metadata
}

async function copiedExport(): Promise<string> {
  render(<DataExportPage />)
  await act(async () => {})
  await act(async () => fireEvent.press(screen.getByRole("button", {name: "profileSettings:dataExportCopy"})))

  expect(Clipboard.setStringAsync).toHaveBeenCalledTimes(1)
  return jest.mocked(Clipboard.setStringAsync).mock.calls[0][0]
}

afterEach(() => {
  jest.restoreAllMocks()
  jest.clearAllMocks()
  engine.settings.resetAllLocal()
  mockAuth = {user: null, session: null}
})

describe("copied export redacts the Cloud bearer held in settings", () => {
  // Synthetic sentinel only; never a real credential.
  const CORE_TOKEN_SENTINEL = "synthetic-core-token-sentinel-7f3a"

  beforeEach(async () => {
    mockNativeApplicationVersion = "3.3.0"
    // The same writes CloudClientService and the settings screens perform.
    await engine.settings.set(SETTINGS.core_token.key, CORE_TOKEN_SENTINEL, false)
    await engine.settings.set(SETTINGS.auth_email.key, "export-user@example.test", false)
    await engine.settings.set(SETTINGS.theme_preference.key, "dark", false)
    await engine.settings.set(SETTINGS.metric_system.key, true, false)
    await engine.settings.set(SETTINGS.head_up_angle.key, 27, false)
  })

  test("no credential value appears anywhere in the copied payload", async () => {
    const payload = await copiedExport()

    expect(payload).not.toContain(CORE_TOKEN_SENTINEL)
    expect(JSON.parse(payload).userSettings[SETTINGS.core_token.key]).toBe("[REDACTED]")
  })

  test("legitimate user settings are exported unchanged", async () => {
    const {userSettings} = JSON.parse(await copiedExport())

    expect(userSettings).toMatchObject({
      auth_email: "export-user@example.test",
      theme_preference: "dark",
      metric_system: true,
      head_up_angle: 27,
    })
    // Only the credential differs from what the engine reports.
    const {core_token: _exportedToken, ...exported} = userSettings
    const {core_token: _engineToken, ...engineSettings} = engine.settings.getAll()
    expect(exported).toEqual(JSON.parse(JSON.stringify(engineSettings)))
  })

  test("export does not mutate engine settings", async () => {
    const before = engine.settings.getAll()

    await copiedExport()

    expect(engine.settings.get(SETTINGS.core_token.key)).toBe(CORE_TOKEN_SENTINEL)
    expect(engine.settings.getAll()).toEqual(before)
  })

  test("an unset bearer stays empty rather than implying a credential", async () => {
    await engine.settings.set(SETTINGS.core_token.key, "", false)

    const {userSettings} = JSON.parse(await copiedExport())

    expect(userSettings[SETTINGS.core_token.key]).toBe("")
  })
})

test.each(["3.3.0", "4.0.1", "3.2.0-beta.4"])(
  "shared export records installed Mentra App version %s",
  async (version) => {
    mockNativeApplicationVersion = version

    const metadata = await sharedExportMetadata()

    expect(metadata.appVersion).toBe(version)
    expect(metadata.exportVersion).toBe("2.0.0")
  },
)

test.each([null, "", "  "])(
  "unavailable native version %p is exported as null, not a guessed version",
  async (version) => {
    mockNativeApplicationVersion = version

    const metadata = await sharedExportMetadata()

    expect(metadata).toHaveProperty("appVersion", null)
  },
)

describe("authentication export follows the current auth session", () => {
  // Synthetic sentinel only; never a real credential.
  const ACCESS_TOKEN_SENTINEL = "synthetic-access-token-sentinel-4c1e"

  test.each([
    ["Copy", copiedExport],
    ["Share", sharedExport],
  ])("%s exports the signed-in profile without the access token", async (_path, exportPayload) => {
    // Shape produced by AuthContext.toMentraSession for a workspace account.
    const user: MentraAuthUser = {
      id: "workspace:synthetic-deployment:https%3A%2F%2Fissuer.example.test:subject-1",
      email: "export-user@example.test",
      name: "Export User",
      provider: "microsoft-entra",
    }
    mockAuth = {user, session: {token: ACCESS_TOKEN_SENTINEL, user}}

    const payload = await exportPayload()
    const data = JSON.parse(payload.slice(payload.indexOf("{")))

    expect(payload).not.toContain(ACCESS_TOKEN_SENTINEL)
    expect(data.authentication).toEqual({
      user: {
        id: user.id,
        email: "export-user@example.test",
        name: "Export User",
        avatarUrl: null,
        createdAt: null,
        provider: "microsoft-entra",
      },
      sessionInfo: {hasAccessToken: true},
    })
  })

  test("profile fields a provider reports are exported as-is", async () => {
    // Shape produced by the Authing (China) provider, which fills every field.
    const user: MentraAuthUser = {
      id: "authing-user-1",
      email: "export-user@example.test",
      name: "Export User",
      avatarUrl: "https://avatars.example.test/export-user.png",
      createdAt: "2025-02-03T04:05:06.000Z",
      provider: "wechat",
    }
    mockAuth = {user, session: {token: ACCESS_TOKEN_SENTINEL, user}}

    const {authentication} = JSON.parse(await copiedExport())

    expect(authentication.user).toEqual(user)
  })

  test("a token without a restored profile does not invent a user", async () => {
    // AccountAuthProvider.getSession offline with no cached profile.
    mockAuth = {user: null, session: {token: ACCESS_TOKEN_SENTINEL, user: undefined}}

    const payload = await copiedExport()

    expect(payload).not.toContain(ACCESS_TOKEN_SENTINEL)
    expect(JSON.parse(payload).authentication).toEqual({user: null, sessionInfo: {hasAccessToken: true}})
  })

  test.each<[string, MentraAuthSession | null]>([
    ["no session", null],
    // AccountAuthProvider.getSession and SIGNED_OUT report a signed-out user this way.
    ["signed-out session", {token: undefined}],
  ])("%s exports no user and no access token", async (_state, session) => {
    mockAuth = {user: null, session}

    const {authentication} = JSON.parse(await copiedExport())

    expect(authentication).toEqual({user: null, sessionInfo: {hasAccessToken: false}})
  })
})
