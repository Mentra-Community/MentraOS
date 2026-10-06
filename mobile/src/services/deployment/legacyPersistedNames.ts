/**
 * Names written to devices by Mentra App builds that already shipped.
 *
 * A separately deployed cloud was called a "workspace" when these builds were
 * released, so the strings below are persisted in MMKV, in JSON files and as
 * on-disk directories, and upgraded builds read them back. THEY MUST NOT
 * CHANGE: renaming one orphans the user's saved organization selection, its
 * installed miniapps or its local miniapp data.
 *
 * In memory the concept is an "organization" (`kind: "organization"`,
 * `organizationOrigin`, the `"organization"` storage scope). Each serialization
 * boundary maps between the in-memory names and these constants:
 * deployment/store.ts, deployment/debugOverrides.ts,
 * miniapps/deploymentManagedMiniappSync.ts and the user-id builders in
 * AuthContext.tsx and MantleManager.ts. The engine package cannot import app
 * code, so AppRegistry keeps its own copy of the storage scope and bundle
 * directory in modules/engine/src/services/legacyPersistedNames.ts.
 */

/** `kind` of the persisted selection stored under MMKV key `mentra.deployment.active.v1`. */
export const PERSISTED_DEPLOYMENT_KIND = "workspace"

/** JSON field holding the origin in the persisted selection and in `deployment-managed-miniapps.json`. */
export const PERSISTED_ORIGIN_FIELD = "workspaceOrigin"

/** Prefix of the local miniapp user id, which partitions local miniapp data. */
export const PERSISTED_USER_ID_PREFIX = "workspace:"

/** Persisted value of the miniapp storage scope (`storageScope` in `deployment-managed-miniapps.json`). */
export const PERSISTED_STORAGE_SCOPE = "workspace"

/** AppRegistry on-disk directory for organization-owned miniapp bundles. */
export const PERSISTED_BUNDLE_DIR = "lmas-workspace"

/** Prefix of the engine setting `cloud_url_deployment`, which scopes cloud URL debug overrides. */
export const PERSISTED_DEBUG_SCOPE_PREFIX = "workspace:"
