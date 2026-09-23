const mockRegister = jest.fn()
const mockRecover = jest.fn().mockResolvedValue(undefined)
const mockOrder: string[] = []

jest.mock("react-native-get-random-values", () => {
  mockOrder.push("crypto")
  return {}
})

jest.mock("react-native", () => ({
  AppRegistry: {
    registerHeadlessTask: (...args: unknown[]) => {
      mockOrder.push("headless")
      mockRegister(...args)
    },
  },
}))
jest.mock("expo-router/entry", () => {
  mockOrder.push("router")
  return {}
})
jest.mock("./backgroundRecovery", () => ({recoverBackgroundRuntime: mockRecover}))

test("cold entry registers recovery before the UI and runs it without mounting an Activity", async () => {
  require("../../index.js")
  expect(mockOrder).toEqual(["crypto", "headless", "router"])
  expect(mockRegister).toHaveBeenCalledWith("MentraRuntimeRecovery", expect.any(Function))
  expect(mockRecover).not.toHaveBeenCalled()
  const task = mockRegister.mock.calls[0][1]()
  await task()
  expect(mockRecover).toHaveBeenCalledTimes(1)
})
