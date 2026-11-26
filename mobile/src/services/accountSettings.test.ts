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
  "brightness": 80,
  "preferred_mic:Mentra Live": "glasses",
  "menu_apps": ["com.mentra.notes"],
  // the phone's
  "default_wearable": "Mentra Live",
  "device_name": "MentraLive_ab12",
  "device_address": "AA:BB:CC:DD:EE:FF",
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
  "brightness",
  "menu_apps",
]
const PAIRING_KEYS = ["default_wearable", "device_name", "device_address"]
const PHONE_KEYS = [...PAIRING_KEYS, "theme_preference", "cloud_core_url", "time_zone_override"]

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

  it("keeps the paired glasses for whoever signs in next", async () => {
    closeAccountSettings()
    for (const key of PAIRING_KEYS) expect(setting(key)).toEqual(OLDER_INSTALL[key])
    openAccountSettings("user-2")
    for (const key of PAIRING_KEYS) expect(setting(key)).toEqual(OLDER_INSTALL[key])
  })

  it("never restores a pairing an older build saved in an account's set", async () => {
    mockMmkvInstances.get("mentra-account-settings")!.set(`account:user-2\ndefault_wearable`, JSON.stringify("Even G1"))
    closeAccountSettings()
    openAccountSettings("user-2")
    expect(setting("default_wearable")).toBe("Mentra Live")
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

describe("an account's data beyond its settings", () => {
  const {partitionIdOf} = jest.requireActual("../../modules/engine/src/services/miniappDataPartition")
  const CORE = "https://core.example.test"
  const partitionOf = (mentraUserId: string) => partitionIdOf({coreUrl: CORE, mentraUserId, workspaceId: null})
  const pkg = "com.mentra.documentation"
  /** What a user's miniapps keep in their account's partition: reports, a saved file's record, a screen's copy. */
  const miniappData = (mentraUserId: string): Record<string, unknown> => ({
    [`mentraos_miniappdata/${partitionOf(mentraUserId)}/${pkg}/reports`]: `[${mentraUserId}'s reports]`,
    [`mentraos_miniappdata/${partitionOf(mentraUserId)}/${pkg}/auth_token_of_a_miniapp`]: "the miniapp's own",
    [`mentraos_blobmeta/${partitionOf(mentraUserId)}/${pkg}/r1-pdf`]: {key: "r1-pdf", fileName: "r1.pdf", bytes: 3},
    [`mentraos_miniappwebstorage/${partitionOf(mentraUserId)}/${pkg}`]: {id: "copy-1", origin: null, removed: []},
  })
  /** What the app's own stores keep for the account signed in, outside the settings. */
  const APP_STATE: Record<string, unknown> = {
    "foreground_apps_order": ["com.mentra.documentation", "com.mentra.notes"],
    "com.mentra.notes_hidden": true,
    "com.mentra.documentation_running": true,
    "asg_downloaded_files": {"IMG_1.jpg": {name: "IMG_1.jpg"}},
    "wifi_credentials": [{ssid: "Home", password: "secret"}],
    "miniapp_update_declined:com.mentra.notes": "1.2.0",
  }
  /** Kept with the phone, whoever is signed in. */
  const PHONE_STATE: Record<string, unknown> = {
    "com.mentra.notes_active_version": "1.1.0",
    "com.mentra.notes_dev_url": "http://192.168.1.4:8081",
    "dev_apps_index": JSON.stringify(["com.mentra.notes"]),
    "deployment_default_miniapps:v1": {coreUrl: CORE, defaults: ["com.mentra.notes"]},
  }
  /** The session's own, gone at sign-out. */
  const SESSION_STATE: Record<string, unknown> = {
    "mentra.account.userProfile": {id: "user-1"},
    "mentra.localMiniapp.userId": "mu_1",
    "supabase.auth.token": "old",
    "auth_email": "person@example.test",
    "mentra.deployment.active.v1": {kind: "consumer"},
  }
  const save = (values: Record<string, unknown>) => {
    for (const [key, value] of Object.entries(values)) storage.save(key, value)
  }
  const expectStored = (values: Record<string, unknown>) => {
    for (const [key, value] of Object.entries(values)) expect([key, stored(key)]).toEqual([key, value])
  }
  const expectAbsent = (values: Record<string, unknown>) => {
    for (const key of Object.keys(values)) expect([key, stored(key)]).toEqual([key, undefined])
  }

  beforeEach(async () => {
    await start()
    openAccountSettings("user-1")
    save({...miniappData("mu_1"), ...APP_STATE, ...PHONE_STATE, ...SESSION_STATE})
  })

  it("is all back exactly when the same account signs back in, and its miniapps' data never moves", async () => {
    const before = Object.fromEntries(storage.getAllKeys().map((key) => [key, stored(key)]))
    closeAccountSettings()
    expectStored(miniappData("mu_1"))
    expectStored(PHONE_STATE)
    expectAbsent(APP_STATE)
    expectAbsent(SESSION_STATE)

    await start()
    openAccountSettings("user-1")
    // The session's own come back from the sign-in itself.
    save(SESSION_STATE)
    expect(Object.fromEntries(storage.getAllKeys().map((key) => [key, stored(key)]))).toEqual(before)
  })

  it("is not seen by another account, whose own data is kept apart, and is still there for its own", async () => {
    closeAccountSettings()
    openAccountSettings("user-2")
    expectAbsent(APP_STATE)
    expectStored(PHONE_STATE)
    // Its miniapps read only its own partitions.
    save({...miniappData("mu_2"), foreground_apps_order: ["com.mentra.notes"]})

    closeAccountSettings()
    openAccountSettings("user-1")
    expectStored({...APP_STATE, ...miniappData("mu_1"), ...miniappData("mu_2")})

    closeAccountSettings()
    openAccountSettings("user-2")
    expectStored({foreground_apps_order: ["com.mentra.notes"]})
    expect(stored("asg_downloaded_files")).toBeUndefined()
  })

  it("is erased with the account, its miniapps' partitions included, and another account's stays", async () => {
    save(miniappData("mu_2"))
    // The account whose miniapp data was in use last: the one deleted, once its session is gone.
    mockMmkvInstances
      .get("mentra-miniapp-partitions")!
      .set("session.last", JSON.stringify({coreUrl: CORE, mentraUserId: "mu_1"}))

    closeAccountSettings({deleteAccount: true})

    expectAbsent(miniappData("mu_1"))
    expectStored(miniappData("mu_2"))
    expectStored(PHONE_STATE)
    openAccountSettings("user-1")
    expectAbsent(APP_STATE)
  })
})
