import * as Application from "expo-application"
import {Platform} from "react-native"

import {captureMentraAppActive, MENTRA_APP_ACTIVE_EVENT} from "./mentraAppAnalytics"

jest.mock("expo-application", () => ({applicationId: "com.mentra.mentra"}))

describe("captureMentraAppActive", () => {
  it("captures the dedicated official-app activity event", () => {
    const capture = jest.fn()

    captureMentraAppActive({capture})

    expect(capture).toHaveBeenCalledWith(MENTRA_APP_ACTIVE_EVENT, {
      app_identifier: Application.applicationId,
      event_source: "mentra_app",
      os_platform: Platform.OS,
    })
  })
})
