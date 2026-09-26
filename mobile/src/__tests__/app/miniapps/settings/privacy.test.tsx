import {SETTINGS, engine} from "@mentra/engine"
import {act, fireEvent, render, waitFor} from "@testing-library/react-native"

import PrivacySettingsScreen from "@/app/miniapps/settings/privacy"
import {FirebaseAnalyticsSetup} from "@/effects/FirebaseAnalyticsSetup"
import {createConsumerDeployment} from "@/services/deployment/officialManifest"
import {disableAnalytics, initAnalytics} from "@/utils/analytics"

const mockDeployment = createConsumerDeployment()
const originalRegion = process.env.EXPO_PUBLIC_DEPLOYMENT_REGION

jest.mock("@/utils/analytics", () => ({
  initAnalytics: jest.fn(() => Promise.resolve()),
  disableAnalytics: jest.fn(() => Promise.resolve()),
}))
jest.mock("@/services/deployment", () => ({
  useDeployment: () => ({activeDeployment: mockDeployment, selectionResolved: true}),
}))
jest.mock("@/contexts/ThemeContext", () => ({useAppTheme: () => ({theme: {spacing: {s4: 16}}})}))
jest.mock("@/stores/navigation", () => ({useNavigationStore: {getState: () => ({goBack: jest.fn()})}}))
jest.mock("@/i18n", () => ({translate: (key: string) => key}))
jest.mock("@/utils/AlertUtils", () => ({showLeaveAppAlert: jest.fn()}))
jest.mock("@/utils/NotificationServiceUtils", () => ({checkAndRequestNotificationAccessSpecialPermission: jest.fn()}))
jest.mock("@/utils/PermissionsUtils", () => ({
  PermissionFeatures: {CALENDAR: "calendar", BACKGROUND_LOCATION: "location"},
  checkFeaturePermissions: () => Promise.resolve(true),
  requestFeaturePermissions: () => Promise.resolve(true),
}))
jest.mock("@/components/ignite", () => {
  const {Text, View} = require("react-native")
  return {Screen: View, Header: () => null, Text: ({tx}: {tx: string}) => <Text>{tx}</Text>}
})
jest.mock("@/components/settings/PermButton", () => () => null)
jest.mock("@/components/ui/RouteButton", () => ({RouteButton: () => null}))
jest.mock("@/components/ui/Spacer", () => ({Spacer: () => null}))
jest.mock("@/components/settings/ToggleSetting", () => {
  const {Switch} = require("react-native")
  return {__esModule: true, default: (props: {label: string}) => <Switch {...props} accessibilityLabel={props.label} />}
})

beforeEach(async () => {
  delete process.env.EXPO_PUBLIC_DEPLOYMENT_REGION
  mockDeployment.manifest.telemetry = true
  await engine.settings.set(SETTINGS.telemetry_enabled.key, SETTINGS.telemetry_enabled.defaultValue())
  jest.clearAllMocks()
})

afterAll(() => {
  if (originalRegion === undefined) delete process.env.EXPO_PUBLIC_DEPLOYMENT_REGION
  else process.env.EXPO_PUBLIC_DEPLOYMENT_REGION = originalRegion
})

it("keeps basic reporting disclosed while the persistent toggle controls detailed telemetry", async () => {
  const screen = render(
    <>
      <FirebaseAnalyticsSetup />
      <PrivacySettingsScreen />
    </>,
  )
  await waitFor(() => expect(disableAnalytics).toHaveBeenCalled())
  expect(screen.getByTestId("privacy-telemetry").props.value).toBe(false)
  expect(screen.getByText("privacySettings:basicUsageNotice")).toBeTruthy()

  await act(async () => fireEvent(screen.getByTestId("privacy-telemetry"), "valueChange", true))
  expect(engine.settings.get(SETTINGS.telemetry_enabled.key)).toBe(true)
  expect(initAnalytics).toHaveBeenCalledTimes(1)
  expect(screen.getByTestId("privacy-telemetry").props.value).toBe(true)

  await act(async () => fireEvent(screen.getByTestId("privacy-telemetry"), "valueChange", false))
  expect(engine.settings.get(SETTINGS.telemetry_enabled.key)).toBe(false)
  expect(disableAnalytics).toHaveBeenCalledTimes(2)
  screen.unmount()
  const reopened = render(<PrivacySettingsScreen />)
  await act(async () => {})
  expect(reopened.getByTestId("privacy-telemetry").props.value).toBe(false)
})

it.each(["deployment", "china"])(
  "cannot opt into detailed telemetry when %s policy forbids it",
  async (restriction) => {
    await engine.settings.set(SETTINGS.telemetry_enabled.key, true)
    mockDeployment.manifest.telemetry = restriction !== "deployment"
    if (restriction === "china") process.env.EXPO_PUBLIC_DEPLOYMENT_REGION = "china"
    const screen = render(
      <>
        <FirebaseAnalyticsSetup />
        <PrivacySettingsScreen />
      </>,
    )
    await waitFor(() => expect(disableAnalytics).toHaveBeenCalled())
    expect(screen.getByTestId("privacy-telemetry").props).toMatchObject({value: false, disabled: true})
    expect(initAnalytics).not.toHaveBeenCalled()
    expect(engine.settings.get(SETTINGS.telemetry_enabled.key)).toBe(true)
  },
)
