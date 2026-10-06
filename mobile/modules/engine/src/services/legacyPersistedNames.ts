/**
 * Names written to devices by Mentra App builds that already shipped.
 *
 * A separately deployed cloud was called a "workspace" when these builds were
 * released, so the strings below are persisted on disk and in MMKV and read
 * back by upgraded builds. THEY MUST NOT CHANGE: renaming one orphans the
 * installed organization miniapps, their provenance or their selected version.
 *
 * In memory the concept is an "organization" (the `"organization"` storage
 * scope). AppRegistry maps between that and these constants wherever it builds
 * a path or storage key, or reads or writes an install rollback journal.
 *
 * The Mentra App keeps the same values for its own persisted files in
 * mobile/src/services/deployment/legacyPersistedNames.ts; the engine package
 * cannot import app code.
 */

/** Persisted value of the miniapp storage scope (rollback journal `storageScope`). */
export const PERSISTED_STORAGE_SCOPE = "workspace"

/** On-disk directory for organization-owned miniapp bundles, next to the consumer `lmas`. */
export const PERSISTED_BUNDLE_DIR = "lmas-workspace"

/** Rollback journal boolean that selects the organization active-version key. */
export const PERSISTED_JOURNAL_SELECTION_FIELD = "workspaceSelection"
