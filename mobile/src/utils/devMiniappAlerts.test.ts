import {SignedMiniappDevBuildError} from "@mentra/engine-host-internal"

import {devBuildErrorAlert} from "@/utils/devMiniappAlerts"

// Render the English source strings so the test reads the copy users see.
jest.mock("@/i18n", () => {
  const en = jest.requireActual("@/i18n/en").default as Record<string, Record<string, string>>
  return {
    translate: (key: string, params: Record<string, string> = {}) => {
      const [scope, name] = key.split(":")
      return Object.entries(params).reduce(
        (text, [param, value]) => text.replace(`{{${param}}}`, value),
        en[scope][name],
      )
    },
  }
})

describe("dev build alerts", () => {
  test("names the signed package and the fix", () => {
    expect(devBuildErrorAlert(new SignedMiniappDevBuildError("com.example.app"))).toEqual({
      title: "Uninstall required",
      message:
        "com.example.app is installed with a publisher signature. Uninstall it before running a development build.",
    })
  })

  test("keeps other registration failures readable", () => {
    expect(devBuildErrorAlert(new Error("Dev miniapp manifest is missing packageName"))).toEqual({
      title: "Could not load dev miniapp",
      message: "Dev miniapp manifest is missing packageName",
    })
  })
})
