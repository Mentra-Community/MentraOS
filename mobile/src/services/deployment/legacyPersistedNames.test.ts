// The engine package cannot import app code, so it keeps its own copy of the names it persists.
// eslint-disable-next-line no-restricted-imports
import * as engineNames from "../../../modules/engine/src/services/legacyPersistedNames"
import * as names from "./legacyPersistedNames"

// These strings are on devices that installed a shipped build. Changing one orphans
// the user's saved selection, installed miniapps or local miniapp data.
it("keeps every persisted name at its shipped value", () => {
  expect({...names}).toEqual({
    PERSISTED_DEPLOYMENT_KIND: "workspace",
    PERSISTED_ORIGIN_FIELD: "workspaceOrigin",
    PERSISTED_USER_ID_PREFIX: "workspace:",
    PERSISTED_STORAGE_SCOPE: "workspace",
    PERSISTED_BUNDLE_DIR: "lmas-workspace",
    PERSISTED_DEBUG_SCOPE_PREFIX: "workspace:",
  })
})

it("matches the copy the engine keeps for AppRegistry", () => {
  expect({...engineNames}).toEqual({
    PERSISTED_STORAGE_SCOPE: names.PERSISTED_STORAGE_SCOPE,
    PERSISTED_BUNDLE_DIR: names.PERSISTED_BUNDLE_DIR,
    PERSISTED_JOURNAL_SELECTION_FIELD: "workspaceSelection",
  })
})
