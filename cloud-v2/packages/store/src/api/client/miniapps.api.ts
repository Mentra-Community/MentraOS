import {Hono} from "hono"
import {
  PreinstalledRegistryService,
  PreinstalledRegistryServiceError,
} from "../../services/miniapps/preinstalled-registry.service"
import {createStorageService} from "../../services/storage/storage.service"
import type {AppContext, AppEnv} from "../../types/hono.types"
import {InvalidRequest} from "../../types/oauth.types"
import {optionalUserAuth, userAuth} from "../middleware/user-auth.middleware"

const app = new Hono<AppEnv>()
const registryService = new PreinstalledRegistryService()
const storage = createStorageService()

app.get("/", userAuth, listMiniapps)
app.get("/registry", userAuth, getRegistry)
app.get("/bundles/:assetId/download", optionalUserAuth, downloadBundle)

async function listMiniapps(c: AppContext) {
  const registry = await loadRegistry(c)
  return c.json(
    registry.entries.map((entry) => ({
      packageName: entry.packageName,
      name: entry.packageName,
      version: entry.version,
    })),
  )
}

async function getRegistry(c: AppContext) {
  return c.json(await loadRegistry(c))
}

async function loadRegistry(c: AppContext) {
  const user = c.var.user
  if (!user) throw new InvalidRequest("authenticated user missing")
  return registryService.clientRegistry({
    environment: c.req.query("environment"),
    tenantId: user.tenantId,
    baseUrl: new URL(c.req.url).origin,
  })
}

async function downloadBundle(c: AppContext) {
  const assetId = c.req.param("assetId")
  if (!assetId) throw new InvalidRequest("missing assetId")
  try {
    const identity = c.var.user
      ? {tenantId: c.var.user.tenantId}
      : registryService.authorizeBundleDownload(assetId, {
          tenantId: c.req.query("tenantId"),
          expiresAt: c.req.query("expiresAt"),
          signature: c.req.query("signature"),
        })
    const asset = await registryService.getBundleAsset(assetId, identity)
    const bytes = await storage.getObject(asset.storageKey)

    return new Response(bytes, {
      headers: {
        "content-type": asset.contentType || "application/zip",
        "content-length": String(asset.sizeBytes),
        "content-disposition": `attachment; filename="${asset.fileName.replace(/"/g, "")}"`,
        "cache-control": "private, no-store",
        "x-bundle-sha256": asset.sha256,
        "x-content-type-options": "nosniff",
      },
    })
  } catch (error) {
    return serviceError(error)
  }
}

function serviceError(error: unknown) {
  if (error instanceof PreinstalledRegistryServiceError) {
    return new Response(JSON.stringify({error: error.code, error_description: error.message}), {
      status: error.status,
      headers: {"content-type": "application/json"},
    })
  }
  throw error
}

export default app
