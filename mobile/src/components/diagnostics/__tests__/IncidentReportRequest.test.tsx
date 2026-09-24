import {act, fireEvent, render} from "@testing-library/react-native"
import type {ReactNode} from "react"

import {useAuth} from "@/contexts/AuthContext"
import {submitIncidentReportOnce} from "@/services/bugReport/incidentReportAutomation"

import IncidentReportRequest from "../IncidentReportRequest"

const mockDismiss = jest.fn()
jest.mock("@mentra/engine", () => ({submitIncidentReport: jest.fn()}))
jest.mock("@/contexts/AuthContext", () => ({useAuth: jest.fn()}))
jest.mock("@/services/deployment", () => ({
  useDeployment: () => ({
    activeDeployment: {manifest: {deploymentId: "dev", services: {coreUrl: "https://core.example"}}},
  }),
}))
jest.mock("@/services/bugReport/incidentReportAutomation", () => ({
  ...jest.requireActual("@/services/bugReport/incidentReportAutomation"),
  submitIncidentReportOnce: jest.fn(),
}))
jest.mock("@/components/ignite", () => {
  const {Text, View, Pressable} = require("react-native")
  return {
    Screen: ({children}: {children: ReactNode}) => <View>{children}</View>,
    Header: () => null,
    Text: ({text, tx, ...props}: {text?: string; tx?: string}) => <Text {...props}>{text ?? tx}</Text>,
    Button: ({onPress, testID}: {onPress: () => void; testID: string}) => (
      <Pressable testID={testID} onPress={onPress} />
    ),
  }
})

const request = {alert_id: "screen-1", test_run_id: "run-1", failure_code: "call_failed", failure_message: "Call ended"}
const receipt = {
  alert_id: "screen-1",
  failure_code: "call_failed",
  status: "filed" as const,
  incident_id: "rep_screen",
  report_id: "rep_screen",
}
const auth = (signedIn: boolean) =>
  ({user: signedIn ? {id: "user-1"} : null, session: signedIn ? {token: "test-token"} : null} as ReturnType<
    typeof useAuth
  >)

beforeEach(() => {
  jest.clearAllMocks()
  jest.mocked(useAuth).mockReturnValue(auth(true))
  jest.mocked(submitIncidentReportOnce).mockResolvedValue(receipt)
})

it("does not file a report without authentication", () => {
  jest.mocked(useAuth).mockReturnValue(auth(false))
  const tree = render(<IncidentReportRequest params={request} onDismiss={mockDismiss} />)
  expect(JSON.parse(tree.getByTestId("incident-report-state").props.children)).toMatchObject({
    status: "authentication_required",
  })
  expect(submitIncidentReportOnce).not.toHaveBeenCalled()
})

it("shows the correlated incident ID and returns to the previous screen with Done", async () => {
  const tree = render(<IncidentReportRequest params={request} onDismiss={mockDismiss} />)
  await act(async () => {})
  expect(JSON.parse(tree.getByTestId("incident-report-result").props.children)).toEqual(receipt)
  expect(submitIncidentReportOnce).toHaveBeenCalledWith(expect.stringContaining("user-1"), request)
  fireEvent.press(tree.getByTestId("incident-report-done"))
  expect(mockDismiss).toHaveBeenCalledTimes(1)
})

it("lets cleanup return immediately while the report remains pending", () => {
  jest.mocked(submitIncidentReportOnce).mockReturnValue(new Promise(() => {}))
  const tree = render(<IncidentReportRequest params={request} onDismiss={mockDismiss} />)
  expect(tree.queryByTestId("incident-report-result")).toBeNull()
  expect(JSON.parse(tree.getByTestId("incident-report-state").props.children)).toEqual({
    alert_id: request.alert_id,
    test_run_id: request.test_run_id,
    status: "submitting",
  })
  fireEvent.press(tree.getByTestId("incident-report-done"))
  expect(mockDismiss).toHaveBeenCalledTimes(1)
})
