import {storage} from "@/utils/storage/storage"

import WifiCredentialsService from "./WifiCredentialsService"

jest.mock("@/utils/storage/storage", () => ({storage: {load: jest.fn(), save: jest.fn()}}))

afterEach(() => jest.restoreAllMocks())

test("forgetting one network preserves the other credentials without logging them", () => {
  const credentials = ["removed-fixture", "retained-fixture"].map((ssid) => ({
    ssid,
    password: `${Math.random()}-${Math.random()}`,
    autoConnect: true,
  }))
  ;(storage.load as jest.Mock).mockReturnValue({is_error: () => false, value: {version: "1.0", credentials}})
  ;(storage.save as jest.Mock).mockReturnValue({is_error: () => false})
  const logged = jest.spyOn(console, "log").mockImplementation(() => {})

  expect(WifiCredentialsService.removeCredentials("removed-fixture")).toBe(true)
  expect(storage.save).toHaveBeenCalledWith("wifi_credentials", {version: "1.0", credentials: [credentials[1]]})
  for (const credential of credentials) {
    expect(JSON.stringify(logged.mock.calls)).not.toContain(credential.password)
  }
})
