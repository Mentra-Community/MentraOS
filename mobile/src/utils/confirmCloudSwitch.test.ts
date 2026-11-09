/* eslint-disable import/first -- Register the alert boundary before the helper. */
const mockAlert = jest.fn()
jest.mock("@/utils/AlertUtils", () => ({__esModule: true, default: (...args: unknown[]) => mockAlert(...args)}))
jest.mock("@/i18n", () => ({translate: (key: string) => key}))

import {confirmCloudSwitch} from "./confirmCloudSwitch"

type Button = {text: string; style?: string; onPress: () => void}
const press = (text: string) => {
  const buttons = mockAlert.mock.calls[0][2] as Button[]
  buttons.find((button) => button.text === text)!.onPress()
}

beforeEach(() => {
  mockAlert.mockReset()
  mockAlert.mockResolvedValue(undefined)
})

it("asks before switching to another Core and goes ahead on confirm", async () => {
  const answer = confirmCloudSwitch("change")
  expect(mockAlert).toHaveBeenCalledWith("workspace:cloudSwitchTitle", "workspace:cloudSwitchMessage", [
    expect.objectContaining({text: "common:cancel", style: "cancel"}),
    expect.objectContaining({text: "workspace:cloudSwitchConfirm", style: "destructive"}),
  ])
  press("workspace:cloudSwitchConfirm")
  await expect(answer).resolves.toBe(true)
})

it("asks before returning to the default Core and stops on cancel", async () => {
  const answer = confirmCloudSwitch("reset")
  expect(mockAlert.mock.calls[0].slice(0, 2)).toEqual(["workspace:cloudResetTitle", "workspace:cloudResetMessage"])
  press("common:cancel")
  await expect(answer).resolves.toBe(false)
})
