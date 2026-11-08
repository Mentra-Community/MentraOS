import {engine, SETTINGS} from "@mentra/engine"

import {closeAccountSettings, openAccountSettings, settleSignedOutAccountSettings} from "./accountSettings"
import {migrate, MIGRATION_VERSION_KEY} from "@/services/Migrations"
import {getNextOnboardingRoute} from "@/utils/onboarding/getNextOnboardingRoute"
import {storage} from "@/utils/storage"

// MMKV with one store per instance id, as on a phone: the account sets live outside the default instance.
const mockMmkvInstances = new Map<string, Map<string, string>>()
jest.mock("react-native-mmkv", () => ({
  createMMKV: (config?: {id?: string}) => {
    const id = config?.id ?? "mmkv.default"
    if (!mockMmkvInstances.has(id)) mockMmkvInstances.set(id, new Map())
    const values = mockMmkvInstances.get(id)!
    return {
      getString: (key: string) => values.get(key),
      set: (key: string, value: unknown) => values.set(key, String(value)),
      remove: (key: string) => values.delete(key),
      contains: (key: string) => values.has(key),
      getAllKeys: () => [...values.keys()],
      clearAll: () => values.clear(),
      trim: () => undefined,
    }
  },
}))

/** What an older build left on a phone whose person is signed in. */
const OLDER_INSTALL: Record<string, unknown> = {
  // the account's
  "onboarding_completed": true,
  "onboarding_live_completed": true,
  "onboarding_os_completed": true,
  "default_wearable": "Mentra Live",
  "device_name": "MentraLive_ab12",
  "device_address": "AA:BB:CC:DD:EE:FF",
  "brightness": 80,
  "preferred_mic:Mentra Live": "glasses",
  "menu_apps": ["com.mentra.notes"],
  // the phone's
  "theme_preference": "dark",
  "cloud_core_url": "https://core.example.test",
  "time_zone_override": "Europe/Paris",
  // erased at sign-out
  "auth_email": "person@example.test",
  // not settings
  [MIGRATION_VERSION_KEY]: 5,
  "migration:vad_default_off_v2": true,
  "settings.lastBuildEnv": "prod",
  "mentra.deployment.active.v1": {kind: "consumer"},
}

const ACCOUNT_KEYS = [
  "onboarding_completed",
  "onboarding_live_completed",
  "onboarding_os_completed",
  "default_wearable",
  "device_name",
  "device_address",
  "brightness",
  "menu_apps",
]
const PHONE_KEYS = ["theme_preference", "cloud_core_url", "time_zone_override"]

const setting = (key: string) => engine.settings.get(key)
const stored = (key: string) => {
  const res = storage.load<unknown>(key)
  return res.is_ok() ? res.value : undefined
}

/** A start of the app: the settings store reads storage, then the migrations run. */
async function start() {
  engine.settings.reloadLocal()
  await migrate()
}

function guideAfterUpdate() {
  return getNextOnboardingRoute({
    includeMentraLive: true,
    onboardingLiveCompleted: setting(SETTINGS.onboarding_live_completed.key) as boolean,
    onboardingOsCompleted: setting(SETTINGS.onboarding_os_completed.key) as boolean,
  })
}

beforeEach(() => {
  for (const values of mockMmkvInstances.values()) values.clear()
  for (const [key, value] of Object.entries(OLDER_INSTALL)) storage.save(key, value)
})

describe("an update from an older build, signed in", () => {
  it("keeps every setting, before and after the account's id is known, and shows no guide", async () => {
    await start()
    // The first render, before the session (and its id) is restored.
    for (const key of [...ACCOUNT_KEYS, ...PHONE_KEYS]) expect(setting(key)).toEqual(OLDER_INSTALL[key])
    expect(guideAfterUpdate()).toBeNull()

    openAccountSettings("user-1")

    for (const key of [...ACCOUNT_KEYS, ...PHONE_KEYS]) expect(setting(key)).toEqual(OLDER_INSTALL[key])
    expect(stored("preferred_mic:Mentra Live")).toBe("glasses")
    expect(stored("auth_email")).toBe("person@example.test")
    expect(guideAfterUpdate()).toBeNull()
    // The migrations already ran on this phone and don't run again.
    expect(stored(MIGRATION_VERSION_KEY)).toBe(5)
  })

  it("keeps everything across later starts too", async () => {
    await start()
    openAccountSettings("user-1")
    await start()
    openAccountSettings("user-1")
    for (const key of [...ACCOUNT_KEYS, ...PHONE_KEYS]) expect(setting(key)).toEqual(OLDER_INSTALL[key])
  })
})

describe("signing out and in", () => {
  beforeEach(async () => {
    await start()
    openAccountSettings("user-1")
  })

  it("keeps the phone's settings and the migration markers, and clears the rest", async () => {
    closeAccountSettings()

    for (const key of ACCOUNT_KEYS) expect(setting(key)).toEqual(SETTINGS[key].defaultValue())
    for (const key of PHONE_KEYS) expect(setting(key)).toEqual(OLDER_INSTALL[key])
    expect(stored("auth_email")).toBeUndefined()
    expect(stored("mentra.deployment.active.v1")).toBeUndefined()
    expect(stored("preferred_mic:Mentra Live")).toBeUndefined()
    expect(stored(MIGRATION_VERSION_KEY)).toBe(5)
    expect(stored("migration:vad_default_off_v2")).toBe(true)
    expect(stored("settings.lastBuildEnv")).toBe("prod")
  })

  it("gives the same account its settings back exactly, and the migrations don't rerun", async () => {
    closeAccountSettings()
    await start()
    openAccountSettings("user-1")

    for (const key of [...ACCOUNT_KEYS, ...PHONE_KEYS]) expect(setting(key)).toEqual(OLDER_INSTALL[key])
    expect(stored("preferred_mic:Mentra Live")).toBe("glasses")
    expect(guideAfterUpdate()).toBeNull()
  })

  it("starts another account from the defaults, and keeps the first one's set", async () => {
    closeAccountSettings()
    await start()
    openAccountSettings("user-2")

    for (const key of ACCOUNT_KEYS) expect(setting(key)).toEqual(SETTINGS[key].defaultValue())
    for (const key of PHONE_KEYS) expect(setting(key)).toEqual(OLDER_INSTALL[key])
    expect(guideAfterUpdate()).toBe("/onboarding/live")

    await engine.settings.set(SETTINGS.brightness.key, 30)
    closeAccountSettings()
    openAccountSettings("user-1")
    expect(setting("brightness")).toBe(80)
    closeAccountSettings()
    openAccountSettings("user-2")
    expect(setting("brightness")).toBe(30)
    expect(setting("onboarding_live_completed")).toBe(false)
  })

  it("closes a set a sign-out left open before opening another account's", async () => {
    openAccountSettings("user-2")
    for (const key of ACCOUNT_KEYS) expect(setting(key)).toEqual(SETTINGS[key].defaultValue())
    closeAccountSettings()
    openAccountSettings("user-1")
    for (const key of ACCOUNT_KEYS) expect(setting(key)).toEqual(OLDER_INSTALL[key])
  })

  it("deletes the account's set with the account", async () => {
    closeAccountSettings({deleteAccount: true})
    openAccountSettings("user-1")
    for (const key of ACCOUNT_KEYS) expect(setting(key)).toEqual(SETTINGS[key].defaultValue())
    for (const key of PHONE_KEYS) expect(setting(key)).toEqual(OLDER_INSTALL[key])
  })
})

describe("an update from an older build, signed out", () => {
  it("drops the account settings nobody owns, and keeps the rest of the phone's storage", async () => {
    await start()
    settleSignedOutAccountSettings()

    for (const key of ACCOUNT_KEYS) expect(setting(key)).toEqual(SETTINGS[key].defaultValue())
    for (const key of PHONE_KEYS) expect(setting(key)).toEqual(OLDER_INSTALL[key])
    expect(stored("mentra.deployment.active.v1")).toEqual({kind: "consumer"})
    expect(stored(MIGRATION_VERSION_KEY)).toBe(5)

    openAccountSettings("user-1")
    expect(setting("onboarding_live_completed")).toBe(false)
  })

  it("does nothing once an account's set is open", async () => {
    await start()
    openAccountSettings("user-1")
    settleSignedOutAccountSettings()
    for (const key of ACCOUNT_KEYS) expect(setting(key)).toEqual(OLDER_INSTALL[key])
  })
})
