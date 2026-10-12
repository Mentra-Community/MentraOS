/**
 * @fileoverview The admin portal, served by Core itself (a Mentra Private
 * Cloud), when `CLOUD_CORE_ADMIN_STATIC_DIR` points at its build.
 *
 * GET and HEAD requests outside `/api` and `/.well-known` serve files from that
 * directory, with a single-page-app fallback to `index.html`. Unknown `/api`
 * paths are never answered with the app. `index.html` is `no-cache`; hashed
 * build assets are `immutable`. Every response carries the admin portal's CSP.
 */

import {stat} from "node:fs/promises"
import {isAbsolute, relative, resolve} from "node:path"

import {Hono} from "hono"

import type {AppEnv} from "../types/hono.types"

export const ADMIN_CONTENT_SECURITY_POLICY =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'"

// Bun's bundler names hashed outputs like `chunk-1a2b3c4d.js` or `logo-1a2b3c4d.svg`.
const HASHED_ASSET = /-[a-z0-9]{8,}\.[a-z0-9]+$/

function isApiPath(path: string): boolean {
  return path === "/api" || path.startsWith("/api/") || path === "/.well-known" || path.startsWith("/.well-known/")
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

function fileResponse(path: string, cacheControl: string, method: string): Response {
  const file = Bun.file(path)
  return new Response(method === "HEAD" ? null : file, {
    headers: {
      "content-type": file.type,
      "cache-control": cacheControl,
      "content-security-policy": ADMIN_CONTENT_SECURITY_POLICY,
      "x-content-type-options": "nosniff",
      "referrer-policy": "same-origin",
    },
  })
}

export function createAdminStaticApp(directory: string): Hono<AppEnv> {
  const root = resolve(directory)
  const index = resolve(root, "index.html")
  const app = new Hono<AppEnv>()
  app.on(["GET", "HEAD"], "*", async c => {
    const path = c.req.path
    if (isApiPath(path)) return c.notFound()
    let decoded: string
    try {
      decoded = decodeURIComponent(path)
    } catch {
      return c.text("Bad Request", 400)
    }
    if (decoded !== "/") {
      const candidate = resolve(root, `.${decoded}`)
      const inside = relative(root, candidate)
      if (inside && !inside.startsWith("..") && !isAbsolute(inside) && (await isFile(candidate))) {
        const cache = candidate !== index && HASHED_ASSET.test(candidate) ? "public, max-age=31536000, immutable" : "no-cache"
        return fileResponse(candidate, cache, c.req.method)
      }
    }
    if (!(await isFile(index))) return c.notFound()
    return fileResponse(index, "no-cache", c.req.method)
  })
  return app
}
