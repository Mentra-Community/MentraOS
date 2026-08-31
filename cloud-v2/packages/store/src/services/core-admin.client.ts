import {createHmac} from "node:crypto"
import type {AppContext} from "../types/hono.types"

export async function proxyCoreAdmin(c: AppContext): Promise<Response> {
  const coreUrl = (process.env.MENTRA_CORE_INTERNAL_URL ?? process.env.MENTRA_CORE_URL)?.replace(/\/+$/, "")
  const secret = (process.env.MENTRA_SERVICE_AUTH_SECRET ?? process.env.WORKOS_API_KEY)?.trim()
  const developer = c.var.developer
  if (!coreUrl || !secret || !developer) return c.json({error: "service_unavailable"}, 503)
  const source = new URL(c.req.url)
  const suffix = source.pathname.replace(/^\/api\/admin/, "")
  const targetPath = `/api/internal/admin${suffix}${source.search}`
  const timestamp = String(Date.now())
  const principal = developer.email || developer.developerId
  const signature = createHmac("sha256", secret)
    .update(`${timestamp}\n${c.req.method}\n${targetPath}\n${principal}`)
    .digest("base64url")
  return fetch(`${coreUrl}${targetPath}`, {
    method: c.req.method,
    headers: {
      "accept": c.req.header("accept") ?? "application/json",
      "x-mentra-service-timestamp": timestamp,
      "x-mentra-service-signature": signature,
      "x-mentra-admin-principal": principal,
      ...(c.req.header("content-type") ? {"content-type": c.req.header("content-type")!} : {}),
    },
    body: c.req.method === "GET" || c.req.method === "HEAD" ? undefined : await c.req.arrayBuffer(),
    redirect: "manual",
  })
}
