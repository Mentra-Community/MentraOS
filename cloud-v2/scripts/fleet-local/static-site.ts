/**
 * Serves a built portal (`websites/<site>/dist`) the way Cloudflare Pages does in a deployment, for the local Fleet
 * stack only: static files with an SPA fallback, the response headers of `dist/_headers` (the portal's Content
 * Security Policy), and `/api/*` forwarded to Core as `functions/api/[[path]].ts` does.
 *
 * A portal also gets one local-only page, `/__dev/login`: pick a test account and get that portal's session cookie,
 * minted by the stack (`mint`), a shortcut past the real sign-in through Core's sign-in server. The sign-in site
 * (`websites/account`) is served the same way, with its Pages Function's relayed paths (`forward`) going to Core.
 */
import {existsSync, readFileSync} from "node:fs"
import {relative, resolve} from "node:path"

export interface DevAccount {
  email: string
  label: string
}

export interface StaticSiteOptions {
  name: string
  hostname: string
  port: number
  distDir: string
  coreUrl: string
  /** The paths sent to Core; by default `/api/*`, as a portal's `functions/api/[[path]].ts` does. */
  forward?: (pathname: string) => boolean
  /** The `/__dev/login` shortcut; a site without it has none. */
  devLogin?: {
    cookieName: string
    accounts: () => DevAccount[]
    mint: (email: string) => Promise<string | null>
  }
}

const isApiPath = (pathname: string) => pathname === "/api" || pathname.startsWith("/api/")

/** The `/*` block of a Pages `_headers` file. */
function readHeaders(distDir: string): Record<string, string> {
  const file = resolve(distDir, "_headers")
  if (!existsSync(file)) return {}
  const headers: Record<string, string> = {}
  let inAll = false
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue
    if (!/^\s/.test(line)) {
      inAll = line.trim() === "/*"
      continue
    }
    const at = line.indexOf(":")
    if (inAll && at > 0) headers[line.slice(0, at).trim()] = line.slice(at + 1).trim()
  }
  return headers
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

export function startStaticSite(opts: StaticSiteOptions) {
  const pageHeaders = readHeaders(opts.distDir)
  // Violations of the policy are reported here and logged, so a walkthrough sees them without the browser's console.
  const csp = pageHeaders["Content-Security-Policy"]
  if (csp) pageHeaders["Content-Security-Policy"] = `${csp}; report-uri /__dev/csp-report`
  const index = resolve(opts.distDir, "index.html")

  const withHeaders = (response: Response) => {
    const out = new Response(response.body, response)
    for (const [name, value] of Object.entries(pageHeaders)) out.headers.set(name, value)
    return out
  }

  async function proxy(req: Request, url: URL): Promise<Response> {
    const headers = new Headers(req.headers)
    headers.delete("host")
    const upstream = await fetch(new URL(url.pathname + url.search, opts.coreUrl), {
      method: req.method,
      headers,
      body: req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer(),
      redirect: "manual",
    })
    return new Response(upstream.body, upstream)
  }

  async function devLogin(dev: NonNullable<StaticSiteOptions["devLogin"]>, url: URL): Promise<Response> {
    const email = url.searchParams.get("email")
    const back = url.searchParams.get("return") ?? "/"
    const safeBack = back.startsWith("/") && !back.startsWith("//") ? back : "/"
    if (email) {
      const value = await dev.mint(email)
      if (!value) return new Response(`No test account ${email}`, {status: 404})
      return new Response(null, {
        status: 302,
        headers: {
          location: safeBack,
          "set-cookie": `${dev.cookieName}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`,
        },
      })
    }
    const rows = dev
      .accounts()
      .map(
        (a) =>
          `<li><a href="/__dev/login?email=${encodeURIComponent(a.email)}&return=${encodeURIComponent(safeBack)}">${escapeHtml(a.email)}</a> ${escapeHtml(a.label)}</li>`,
      )
      .join("")
    return new Response(
      `<!doctype html><meta charset="utf-8"><title>Local sign-in</title><h1>${escapeHtml(opts.name)}: local sign-in</h1>` +
        `<p>Local Fleet stack only. Pick a test account; you get its session cookie.</p><ul>${rows || "<li>No accounts yet: run the seed.</li>"}</ul>`,
      {headers: {"content-type": "text/html; charset=utf-8", "cache-control": "no-store"}},
    )
  }

  const server = Bun.serve({
    hostname: opts.hostname,
    port: opts.port,
    async fetch(req) {
      const url = new URL(req.url)
      if ((opts.forward ?? isApiPath)(url.pathname)) return proxy(req, url)
      const dev = opts.devLogin
      if (dev && url.pathname === "/__dev/login") return devLogin(dev, url)
      if (url.pathname === "/__dev/csp-report" && req.method === "POST") {
        const report = (await req.json().catch(() => null)) as {"csp-report"?: Record<string, unknown>} | null
        const r = report?.["csp-report"] ?? {}
        console.warn(`[${opts.name}] CSP violation: ${r["violated-directive"]} blocked ${r["blocked-uri"]} on ${r["document-uri"]}`)
        return new Response(null, {status: 204})
      }
      if (dev && url.pathname === "/__dev/logout") {
        return new Response(null, {status: 302, headers: {location: "/__dev/login", "set-cookie": `${dev.cookieName}=; Path=/; Max-Age=0`}})
      }
      if (url.pathname !== "/") {
        let decoded: string
        try {
          decoded = decodeURIComponent(url.pathname)
        } catch {
          return new Response("Bad Request", {status: 400})
        }
        const asset = resolve(opts.distDir, `.${decoded}`)
        const rel = relative(opts.distDir, asset)
        if (rel && !rel.startsWith("..") && !rel.startsWith("/") && !rel.startsWith("_")) {
          const file = Bun.file(asset)
          if (await file.exists()) return withHeaders(new Response(file, {headers: {"content-type": file.type}}))
        }
      }
      return withHeaders(new Response(Bun.file(index), {headers: {"content-type": "text/html; charset=utf-8"}}))
    },
  })
  return {url: `http://localhost:${server.port}`, stop: () => server.stop(true)}
}
