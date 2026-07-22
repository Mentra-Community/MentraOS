import {AsyncResult, result as Res} from "typesafe-ts"

import {storage} from "@/utils/storage"
import {SETTINGS, engine} from "@mentra/engine"

interface Migration {
  version: number // the version this migration brings you TO
  run: () => Promise<void>
}

// this entire list will be run on a fresh install
// migrations must be idempotent and safe to run multiple times!!!
const migrations: Migration[] = [
  {
    version: 1,
    run: async () => {
      // migrates from 0 → 1 turns on the new app switcher ui!
      // engine.settings.set("app_switcher_ui", true)
    },
  },
  {
    version: 2,
    run: async () => {
      // migrates from 1 → 2
      const dashboardDepthRes = storage.load<number>(SETTINGS.dashboard_depth.key)
      if (dashboardDepthRes.is_error()) {
        return
      }
      if (Number(dashboardDepthRes.value) > 3) {
        const res = await engine.settings.set(SETTINGS.dashboard_depth.key, 3, false)
        if (res.is_error()) {
          throw res.error
        }
      }
    },
  },
  {
    version: 3,
    run: async () => {
      // migrates from 2 → 3: the hardcoded Offline Captions built-in
      // (com.mentra.offline_captions) was removed — the SDK Captions miniapp
      // auto-switches between online and offline transcription now. Clear its
      // persisted state: the offline_captions_running setting (BLE-synced into
      // the native mic gate on older builds) and the app-tray running flag
      // that would otherwise resurrect a now-nonexistent app on boot.
      storage.remove("offline_captions_running")
      storage.remove("com.mentra.offline_captions_running")
      storage.remove("com.mentra.offline_captions_screenshot")
    },
  },
  {
    version: 4,
    run: async () => {
      // MentraOS onboarding was disabled while its content was out of date.
      // Reset completion once so every user sees the replacement flow after
      // their next pairing, including users who completed the old version.
      const res = await engine.settings.set(SETTINGS.onboarding_os_completed.key, false, false)
      if (res.is_error()) {
        throw res.error
      }
    },
  },
]

const migration_version_key = "migration_version"
const current_version = migrations.length

const runMigrations = (fromVersion: number): AsyncResult<void, Error> => {
  return Res.try_async(async () => {
    const pendingMigrations = migrations.filter((m) => m.version > fromVersion).sort((a, b) => a.version - b.version)

    for (const migration of pendingMigrations) {
      const res = await Res.try_async(migration.run)
      if (res.is_error()) {
        throw res.error
      }
      // save version after each successful migration (safer for crashes)
      await storage.save(migration_version_key, migration.version)
    }
  })
}

// code to run when the app has no version set / fresh install only:
const init = async () => {
  // no version is set, so we need to set it
  let res = await storage.save(migration_version_key, 0)
  if (res.is_error()) {
    console.error("MIGRATE: Failed to set migration version", res.error)
    return
  }
}

export const migrate = async () => {
  const storedVersionRes = await storage.load<number>(migration_version_key)
  let storedVersion: number

  if (storedVersionRes.is_error()) {
    // fresh install — initialize at version 0 and run all migrations
    await init()
    storedVersion = 0
  } else {
    storedVersion = storedVersionRes.value
  }

  if (storedVersion === current_version) {
    // we are up to date, no migrations needed
    return
  }

  if (storedVersion < current_version) {
    // we are behind, we need to migrate
    let res = await runMigrations(storedVersion)
    if (res.is_error()) {
      console.error("MIGRATE: Failed to migrate", res.error)
      return
    }
    // we successfully migrated, so we need to set the new version
    res = await storage.save(migration_version_key, current_version)
    if (res.is_error()) {
      console.error("MIGRATE: Failed to set migration version", res.error)
      return
    }
    return
  }
}
