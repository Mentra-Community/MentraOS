import {SETTINGS} from "@mentra/engine"

it("keeps the mandatory version floor when upgrading an install without a build marker", async () => {
  const {storage} = jest.requireActual<typeof import("../../../modules/engine/src/utils/storage/storage")>(
    "../../../modules/engine/src/utils/storage/storage",
  )
  const {useSettingsStore} = jest.requireActual<typeof import("../../../modules/engine/src/stores/settings")>(
    "../../../modules/engine/src/stores/settings",
  )
  storage.remove("settings.lastBuildEnv")
  storage.save(SETTINGS.cached_required_version.key, "runtime:99.0.0")
  const loaded = await useSettingsStore.getState().loadAllSettings()
  if (loaded.is_error()) throw loaded.error
  expect(useSettingsStore.getState().getSetting(SETTINGS.cached_required_version.key)).toBe("runtime:99.0.0")
  const persisted = storage.load(SETTINGS.cached_required_version.key)
  if (persisted.is_error()) throw persisted.error
  expect(persisted.value).toBe("runtime:99.0.0")
})
