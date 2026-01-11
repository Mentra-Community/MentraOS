import {AsyncResult, result as Res} from "typesafe-ts"

import {storage} from "@/utils/storage"

interface Migration {
  version: number // the version this migration brings you TO
  run: () => Promise<void>
}

// this entire list will be run on a fresh install
// migrations must be idempotent and safe to run multiple times!!!
const migrations: Migration[] = [
  // {
  //   version: 1,
  //   run: async () => {
  //     // migrates from 0 → 1
  //   }
  // },
  // {
  //   version: 2,
  //   run: async () => {
  //     // migrates from 1 → 2
  //   }
  // },
]

const migration_version_key = "migration_version"
const current_version = migrations.length

const runMigrations = (fromVersion: number): AsyncResult<void, Error> => {
  return Res.try_async(async () => {
    const pendingMigrations = migrations.filter(m => m.version > fromVersion).sort((a, b) => a.version - b.version)

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
    console.error("Failed to set migration version", res.error)
    return
  }
}

export const migrate = async () => {
  const storedVersionRes = await storage.load<number>("migrationVersion")
  if (storedVersionRes.is_error()) {
    await init()
    return
  }

  const storedVersion = storedVersionRes.value

  if (storedVersion === current_version) {
    // we are up to date, no migrations needed
    return
  }

  if (storedVersion < current_version) {
    // we are behind, we need to migrate
    let res = await runMigrations(storedVersion)
    if (res.is_error()) {
      console.error("Failed to migrate", res.error)
      return
    }
    // we successfully migrated, so we need to set the new version
    res = await storage.save(migration_version_key, current_version)
    if (res.is_error()) {
      console.error("Failed to set migration version", res.error)
      return
    }
    return
  }
}
