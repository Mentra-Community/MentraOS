import Constants from "expo-constants"

import {createOfficialManifest} from "./officialManifest"

jest.mock("expo-constants", () => ({__esModule: true, default: {expoConfig: {extra: {}}}}))

const originalCore = process.env.EXPO_PUBLIC_CLOUD_CORE_URL

afterEach(() => {
  if (originalCore === undefined) delete process.env.EXPO_PUBLIC_CLOUD_CORE_URL
  else process.env.EXPO_PUBLIC_CLOUD_CORE_URL = originalCore
})

it.each([undefined, "", "  ", "https://core.staging.us-west-2.mentraglass.com", "http://localhost:3000/core"])(
  "keeps the JS build baseline when native Expo metadata belongs to an older reload (%p)",
  (value) => {
    if (value === undefined) delete process.env.EXPO_PUBLIC_CLOUD_CORE_URL
    else process.env.EXPO_PUBLIC_CLOUD_CORE_URL = value
    Constants.expoConfig!.extra = {mentraBackendTarget: {schemaVersion: 1, coreUrl: "https://old-build.example"}}

    expect(createOfficialManifest().services.coreUrl).toBe(
      value?.trim() || "https://core.dev.us-west-2.mentraglass.com",
    )
  },
)
