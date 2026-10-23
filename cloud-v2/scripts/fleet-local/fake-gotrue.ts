/**
 * A local stand-in for Supabase GoTrue, the account directory behind Core's `/api/account/*`, for the local Fleet
 * stack only (`scripts/fleet-local-stack.ts`). It holds the stack's test accounts (email, password, name) in a JSON
 * file and answers the GoTrue calls Core makes (`services/account/gotrue.client.ts`): the password grant, the admin
 * user reads and writes, sign-up (confirmed at once), resend and logout. The sign-in site's supabase-js uses the
 * same password grant from the browser (CORS open). Access tokens are HS256, signed with the stack's throwaway
 * `SUPABASE_JWT_SECRET`.
 *
 * "Continue with Google" and "Continue with Apple" get a local stand-in for the provider: `GET /authorize` (PKCE
 * only, as the sign-in site uses it) shows a page that picks a test account or takes any email, then redirects to
 * `redirect_to` with a one-time `code`, which the site redeems with `POST /token?grant_type=pkce`. As in Supabase, a
 * provider sign-in with an existing account's email is that account; a new email gets a new, confirmed account.
 *
 * It never talks to a real Supabase project, Google or Apple, and the stack binds it to 127.0.0.1.
 */
import {createHash, randomUUID} from "node:crypto"
import {existsSync, readFileSync, writeFileSync} from "node:fs"
import * as jose from "jose"

export interface FakeAccount {
  id: string
  email: string
  password: string
  name: string | null
  createdAt: string
  /** Social providers this account has signed in with, besides email. */
  providers?: string[]
}

const SOCIAL = {google: "Google", apple: "Apple"} as const
type SocialProvider = keyof typeof SOCIAL
const CODE_TTL_MS = 5 * 60_000
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"])
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

export interface FakeGotrue {
  url: string
  issuer: string
  upsert(input: {id?: string; email: string; password: string; name?: string | null}): FakeAccount
  byEmail(email: string): FakeAccount | null
  stop(): void
}

export function startFakeGotrue(opts: {
  port: number
  hostname: string
  stateFile: string
  anonKey: string
  serviceKey: string
  jwtSecret: string
}): FakeGotrue {
  const accounts = new Map<string, FakeAccount>()
  if (existsSync(opts.stateFile)) {
    for (const account of JSON.parse(readFileSync(opts.stateFile, "utf8")) as FakeAccount[]) accounts.set(account.id, account)
  }
  const save = () => writeFileSync(opts.stateFile, JSON.stringify([...accounts.values()], null, 2))
  const url = `http://127.0.0.1:${opts.port}`
  const issuer = `${url}/auth/v1`
  const secret = new TextEncoder().encode(opts.jwtSecret)

  const byEmail = (email: string) => [...accounts.values()].find((a) => a.email.toLowerCase() === email.trim().toLowerCase()) ?? null
  const userJson = (a: FakeAccount) => ({
    id: a.id,
    aud: "authenticated",
    role: "authenticated",
    email: a.email,
    email_confirmed_at: a.createdAt,
    confirmed_at: a.createdAt,
    created_at: a.createdAt,
    identities: [{id: a.id, provider: "email"}, ...(a.providers ?? []).map((provider) => ({id: a.id, provider}))],
    user_metadata: a.name ? {full_name: a.name} : {},
    app_metadata: {provider: "email", providers: ["email", ...(a.providers ?? [])]},
  })
  const upsert: FakeGotrue["upsert"] = (input) => {
    const existing = input.id ? accounts.get(input.id) : byEmail(input.email)
    const account: FakeAccount = {
      id: existing?.id ?? input.id ?? randomUUID(),
      email: input.email.trim().toLowerCase(),
      password: input.password,
      name: input.name ?? existing?.name ?? null,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      ...(existing?.providers ? {providers: existing.providers} : {}),
    }
    accounts.set(account.id, account)
    save()
    return account
  }
  const accessToken = (a: FakeAccount, method: "password" | "oauth" = "password") =>
    new jose.SignJWT({
      email: a.email,
      role: "authenticated",
      aal: "aal1",
      // Core's sign-in hand-off needs the session's start, as Supabase states it ("oauth" for Google and Apple).
      amr: [{method, timestamp: Math.floor(Date.now() / 1000)}],
      session_id: randomUUID(),
    })
      .setProtectedHeader({alg: "HS256", typ: "JWT"})
      .setIssuer(issuer)
      .setAudience("authenticated")
      .setSubject(a.id)
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(secret)

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {status, headers: {"content-type": "application/json", "access-control-allow-origin": "*"}})
  const keyOf = (req: Request) => req.headers.get("apikey") ?? ""
  const session = async (a: FakeAccount, method?: "password" | "oauth") =>
    json({access_token: await accessToken(a, method), token_type: "bearer", expires_in: 3600, refresh_token: randomUUID(), user: userJson(a)})

  // The provider stand-in's one-time codes, redeemed by the PKCE grant.
  const codes = new Map<string, {accountId: string; provider: SocialProvider; challenge: string; method: string; expiresAt: number}>()

  /** A `redirect_to` the stand-in returns to: an http(s) URL on this machine, as an allow list would require. */
  const returnUrl = (raw: string | null): URL | null => {
    try {
      const url = new URL(raw ?? "")
      return ["http:", "https:"].includes(url.protocol) && LOOPBACK.has(url.hostname) ? url : null
    } catch {
      return null
    }
  }
  const html = (body: string, status = 200) =>
    new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${body}`, {
      status,
      headers: {"content-type": "text/html; charset=utf-8", "cache-control": "no-store"},
    })

  /** `GET /authorize`: the stand-in's account chooser, a browser navigation (no API key). */
  function authorizePage(u: URL): Response {
    const provider = u.searchParams.get("provider") ?? ""
    const back = returnUrl(u.searchParams.get("redirect_to"))
    const challenge = u.searchParams.get("code_challenge") ?? ""
    const method = (u.searchParams.get("code_challenge_method") ?? "").toLowerCase()
    if (!(provider in SOCIAL)) return html(`<title>Unsupported provider</title><p>The local stand-in signs in with google or apple only.</p>`, 400)
    if (!back) return html(`<title>Bad redirect</title><p>redirect_to must be an http(s) URL on this machine.</p>`, 400)
    if (!challenge || !["s256", "plain"].includes(method)) {
      return html(`<title>PKCE required</title><p>The local stand-in supports the PKCE flow only (code_challenge and code_challenge_method).</p>`, 400)
    }
    const name = SOCIAL[provider as SocialProvider]
    const hidden = Object.entries({provider, redirect_to: back.href, code_challenge: challenge, code_challenge_method: method, state: u.searchParams.get("state") ?? ""})
      .map(([k, v]) => `<input type="hidden" name="${k}" value="${escapeHtml(v)}">`)
      .join("")
    const rows = [...accounts.values()]
      .sort((a, b) => a.email.localeCompare(b.email))
      .map((a) => `<li><form method="post" action="/auth/v1/authorize">${hidden}<input type="hidden" name="email" value="${escapeHtml(a.email)}"><button type="submit">${escapeHtml(a.email)}</button> ${escapeHtml(a.name ?? "")}</form></li>`)
      .join("")
    const cancel = new URL(back)
    cancel.searchParams.set("error", "access_denied")
    cancel.searchParams.set("error_code", "access_denied")
    cancel.searchParams.set("error_description", `The ${name} sign-in was cancelled`)
    return html(
      `<title>Local stand-in for ${name} sign-in</title>
<style>body{font:15px system-ui,sans-serif;max-width:560px;margin:40px auto;padding:0 16px}.warn{background:#fff4d6;border:1px solid #e0b84a;padding:10px 12px;border-radius:8px}ul{padding:0;list-style:none}li{margin:6px 0}button{font:inherit;padding:6px 10px;cursor:pointer}input[type=email]{font:inherit;padding:6px;width:260px}</style>
</head><body>
<h1>Local stand-in for ${name} sign-in: not a real ${name} account</h1>
<p class="warn">Local Fleet stack only. Nothing is sent to ${name}. Choose who you are; you return to the sign-in page as if ${name} had signed you in with that email (verified).</p>
<h2>Test accounts</h2><ul>${rows || "<li>No accounts yet.</li>"}</ul>
<h2>Another email</h2><form method="post" action="/auth/v1/authorize">${hidden}<input type="email" name="email" required placeholder="someone@example.com"> <button type="submit">Continue as this email</button></form>
<p><a href="${escapeHtml(cancel.href)}">Cancel</a></p>
</body></html>`,
    )
  }

  /** `POST /authorize`: the choice; a new email gets a confirmed account, then back to the site with a code. */
  async function authorizeChoice(req: Request): Promise<Response> {
    const form = await req.formData().catch(() => null)
    const field = (name: string) => String(form?.get(name) ?? "").trim()
    const provider = field("provider")
    const back = returnUrl(field("redirect_to"))
    const email = field("email").toLowerCase()
    if (!(provider in SOCIAL) || !back || !field("code_challenge") || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return html(`<title>Sign-in did not complete</title><p>Start again from the sign-in page.</p>`, 400)
    }
    const account = byEmail(email) ?? upsert({email, password: randomUUID(), name: null})
    if (!account.providers?.includes(provider)) {
      account.providers = [...(account.providers ?? []), provider]
      save()
    }
    const code = randomUUID()
    codes.set(code, {accountId: account.id, provider: provider as SocialProvider, challenge: field("code_challenge"), method: field("code_challenge_method"), expiresAt: Date.now() + CODE_TTL_MS})
    back.searchParams.set("code", code)
    if (field("state")) back.searchParams.set("state", field("state"))
    return new Response(null, {status: 303, headers: {location: back.href, "cache-control": "no-store"}})
  }

  const server = Bun.serve({
    hostname: opts.hostname,
    port: opts.port,
    async fetch(req) {
      const u = new URL(req.url)
      const path = u.pathname.replace(/^\/auth\/v1/, "")
      if (req.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: {"access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "GET,POST,PUT,DELETE"},
        })
      }
      if (path === "/.well-known/jwks.json") return json({keys: []})
      if (path === "/authorize" && req.method === "GET") return authorizePage(u)
      if (path === "/authorize" && req.method === "POST") return authorizeChoice(req)
      const key = keyOf(req)
      const admin = path.startsWith("/admin/")
      if (admin ? key !== opts.serviceKey : key !== opts.anonKey && key !== opts.serviceKey) return json({msg: "Invalid API key"}, 401)
      const body = req.method === "GET" || req.method === "DELETE" ? null : ((await req.json().catch(() => null)) as Record<string, any> | null)

      if (path === "/token" && u.searchParams.get("grant_type") === "password") {
        const account = byEmail(String(body?.email ?? ""))
        if (!account || account.password !== body?.password) return json({error: "invalid_grant", error_code: "invalid_credentials"}, 400)
        return session(account)
      }
      if (path === "/token" && u.searchParams.get("grant_type") === "pkce") {
        const code = String(body?.auth_code ?? "")
        const grant = codes.get(code)
        codes.delete(code)
        const verifier = String(body?.code_verifier ?? "")
        const expected = grant?.method === "plain" ? verifier : createHash("sha256").update(verifier).digest("base64url")
        const account = grant ? accounts.get(grant.accountId) : undefined
        if (!grant || grant.expiresAt < Date.now() || !verifier || expected !== grant.challenge || !account) {
          return json({error: "invalid_grant", error_code: "flow_state_not_found", error_description: "invalid flow state, no valid flow state found"}, 400)
        }
        return session(account, "oauth")
      }
      if (path === "/signup" && req.method === "POST") {
        const email = String(body?.email ?? "")
        if (byEmail(email)) return json({...userJson(byEmail(email)!), identities: []})
        if (String(body?.password ?? "").length < 6) return json({msg: "Password should be at least 6 characters"}, 422)
        return json(userJson(upsert({email, password: String(body!.password)})))
      }
      if (path === "/resend" || path === "/logout") return new Response(null, {status: 204})
      if (path === "/user" && req.method === "GET") {
        const token = (req.headers.get("authorization") ?? "").replace(/^Bearer /, "")
        try {
          const {payload} = await jose.jwtVerify(token, secret, {issuer})
          const account = accounts.get(String(payload.sub))
          return account ? json(userJson(account)) : json({msg: "User not found"}, 404)
        } catch {
          return json({msg: "invalid JWT"}, 401)
        }
      }
      if (path === "/admin/users" && req.method === "GET") {
        const filter = (u.searchParams.get("filter") ?? "").toLowerCase()
        const page = Math.max(1, Number(u.searchParams.get("page") ?? 1))
        const perPage = Math.max(1, Number(u.searchParams.get("per_page") ?? 50))
        const all = [...accounts.values()].filter((a) => filter === "" || a.email.includes(filter))
        return json({users: all.slice((page - 1) * perPage, page * perPage).map(userJson), aud: "authenticated"})
      }
      const one = /^\/admin\/users\/([^/]+)$/.exec(path)
      if (one) {
        const account = accounts.get(decodeURIComponent(one[1]!))
        if (!account) return json({msg: "User not found"}, 404)
        if (req.method === "GET") return json(userJson(account))
        if (req.method === "PUT") {
          return json(userJson(upsert({id: account.id, email: String(body?.email ?? account.email), password: String(body?.password ?? account.password)})))
        }
        if (req.method === "DELETE") {
          accounts.delete(account.id)
          save()
          return json({})
        }
      }
      return json({msg: `fake GoTrue does not implement ${req.method} ${path}`}, 404)
    },
  })

  return {url, issuer, upsert, byEmail, stop: () => server.stop(true)}
}
