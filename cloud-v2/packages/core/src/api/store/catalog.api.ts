import { Hono } from "hono";
import { z } from "zod";
import { StoreCatalogError, StoreCatalogService } from "../../services/miniapps/store-catalog.service";
import { createStorageService } from "../../services/storage/storage.service";
import type { AppContext, AppEnv } from "../../types/hono.types";
import { InvalidRequest } from "../../types/oauth.types";
import { optionalUserAuth, userAuth } from "../middleware/user-auth.middleware";

const app = new Hono<AppEnv>();
const catalog = new StoreCatalogService();
const storage = createStorageService();

app.get("/apps", optionalUserAuth, listApps);
app.get("/apps/:packageName", optionalUserAuth, getApp);
app.post("/apps/:packageName/track", userAuth, setTrack);
app.get("/assets/:assetId", getAsset);

const trackSchema = z.object({ track: z.enum(["stable", "beta"]) });

async function listApps(c: AppContext) {
  try {
    return c.json(
      await catalog.list({
        ...optionalIdentity(c),
        baseUrl: new URL(c.req.url).origin,
        query: c.req.query("q"),
        category: c.req.query("category"),
        page: parsePositiveInt(c.req.query("page")),
        limit: parsePositiveInt(c.req.query("limit")),
      }),
    );
  } catch (error) {
    return serviceError(error);
  }
}

async function getApp(c: AppContext) {
  const packageName = c.req.param("packageName");
  if (!packageName) return c.json({ error: "not_found" }, 404);
  try {
    return c.json({ app: await catalog.get(packageName, new URL(c.req.url).origin, optionalIdentity(c)) });
  } catch (error) {
    return serviceError(error);
  }
}

async function setTrack(c: AppContext) {
  const packageName = c.req.param("packageName");
  if (!packageName) throw new InvalidRequest("packageName is required");
  const parsed = trackSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new InvalidRequest(parsed.error.issues[0]?.message ?? "invalid track payload");
  try {
    return c.json({
      app: await catalog.setReleaseTrack(packageName, parsed.data.track, identity(c), new URL(c.req.url).origin),
    });
  } catch (error) {
    return serviceError(error);
  }
}

function identity(c: AppContext) {
  if (!c.var.user) throw new InvalidRequest("authenticated user missing");
  return { mentraUserId: c.var.user.mentraUserId, tenantId: c.var.user.tenantId };
}

function optionalIdentity(c: AppContext) {
  return c.var.user ? { mentraUserId: c.var.user.mentraUserId, tenantId: c.var.user.tenantId } : undefined;
}

async function getAsset(c: AppContext) {
  const assetId = c.req.param("assetId");
  if (!assetId) return c.json({ error: "not_found" }, 404);
  try {
    const asset = await catalog.getPublicAsset(assetId);
    const bytes = await storage.getObject(asset.storageKey);
    return new Response(bytes, {
      headers: {
        "content-type": asset.contentType,
        "content-length": String(asset.sizeBytes),
        "cache-control": "public, max-age=31536000, immutable",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) {
    return serviceError(error);
  }
}

function parsePositiveInt(value?: string): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function serviceError(error: unknown) {
  if (error instanceof StoreCatalogError) {
    return new Response(JSON.stringify({ error: error.code, error_description: error.message }), {
      status: error.status,
      headers: { "content-type": "application/json" },
    });
  }
  throw error;
}

export default app;
