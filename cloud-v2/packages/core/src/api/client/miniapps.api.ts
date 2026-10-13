/**
 * @fileoverview `/api/client/miniapps`: the frozen preinstalled catalog, for released Mentra App versions.
 *
 * LEGACY. Mentra App versions released before the Store's headless updates
 * install and update their preinstalled miniapps from here:
 *
 *   GET /                              the catalog's packages and versions
 *   GET /registry                      the catalog, with each bundle's URL and digest
 *   GET /bundles/:assetId/download     a bundle (unauthenticated; ids come from the registry)
 *
 * Core's built-in Store, which published this catalog, is gone, so it no longer
 * changes. Remove these routes, `services/miniapps/legacy-registry.service.ts` and
 * `models/legacy-miniapp-catalog.model.ts` once supported Mentra App versions
 * install only from the Store's backend.
 */

import {Hono} from "hono"
import {
  legacyBundleAsset,
  legacyClientRegistry,
  LegacyRegistryError,
} from "../../services/miniapps/legacy-registry.service"
import {createStorageService, type StorageService} from "../../services/storage/storage.service"
import type {AppContext, AppEnv} from "../../types/hono.types"
import {InvalidRequest} from "../../types/oauth.types"
import {userAuth} from "../middleware/user-auth.middleware"

const app = new Hono<AppEnv>()
let storage: StorageService | undefined
/** Made at the first download, so Core builds no storage client for a route few phones still call. */
const bundleStorage = () => (storage ??= createStorageService())

app.get("/", userAuth, async c => {
  const registry = await loadRegistry(c)
  return c.json(
    registry.entries.map(entry => ({packageName: entry.packageName, name: entry.packageName, version: entry.version})),
  )
})
app.get("/registry", userAuth, async c => c.json(await loadRegistry(c)))
app.get("/bundles/:assetId/download", downloadBundle)

function loadRegistry(c: AppContext) {
  const user = c.var.user
  if (!user) throw new InvalidRequest("authenticated user missing")
  return legacyClientRegistry({
    environment: c.req.query("environment"),
    tenantId: user.tenantId,
    baseUrl: new URL(c.req.url).origin,
  })
}

async function downloadBundle(c: AppContext) {
  const assetId = c.req.param("assetId")
  if (!assetId) throw new InvalidRequest("missing assetId")
  try {
    const asset = await legacyBundleAsset(assetId)
    const bytes = await bundleStorage().getObject(asset.storageKey)
    return new Response(bytes, {
      headers: {
        "content-type": asset.contentType || "application/zip",
        "content-length": String(asset.sizeBytes),
        "content-disposition": `attachment; filename="${asset.fileName.replace(/"/g, "")}"`,
        "cache-control": "public, max-age=31536000, immutable",
        "x-bundle-sha256": asset.sha256,
      },
    })
  } catch (error) {
    if (error instanceof LegacyRegistryError) {
      return c.json({error: error.code, error_description: error.message}, error.status as 404)
    }
    throw error
  }
}

export default app
