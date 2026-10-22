/**
 * A local stand-in for Supabase GoTrue, the account directory behind Core's `/api/account/*`, for the local Fleet
 * stack only (`scripts/fleet-local-stack.ts`). It holds the stack's test accounts (email, password, name) in a JSON
 * file and answers the GoTrue calls Core makes (`services/account/gotrue.client.ts`): the password grant, the admin
 * user reads and writes, sign-up (confirmed at once), resend and logout. Access tokens are HS256, signed with the
 * stack's throwaway `SUPABASE_JWT_SECRET`.
 *
 * It never talks to a real Supabase project, and the stack binds it to 127.0.0.1.
 */
import {randomUUID} from "node:crypto"
import {existsSync, readFileSync, writeFileSync} from "node:fs"
import * as jose from "jose"

export interface FakeAccount {
  id: string
  email: string
  password: string
  name: string | null
  createdAt: string
}

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
    identities: [{id: a.id, provider: "email"}],
    user_metadata: a.name ? {full_name: a.name} : {},
    app_metadata: {provider: "email"},
  })
  const upsert: FakeGotrue["upsert"] = (input) => {
    const existing = input.id ? accounts.get(input.id) : byEmail(input.email)
    const account: FakeAccount = {
      id: existing?.id ?? input.id ?? randomUUID(),
      email: input.email.trim().toLowerCase(),
      password: input.password,
      name: input.name ?? existing?.name ?? null,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
    }
    accounts.set(account.id, account)
    save()
    return account
  }
  const accessToken = (a: FakeAccount) =>
    new jose.SignJWT({email: a.email, role: "authenticated", aal: "aal1", session_id: randomUUID()})
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
      const key = keyOf(req)
      const admin = path.startsWith("/admin/")
      if (admin ? key !== opts.serviceKey : key !== opts.anonKey && key !== opts.serviceKey) return json({msg: "Invalid API key"}, 401)
      const body = req.method === "GET" || req.method === "DELETE" ? null : ((await req.json().catch(() => null)) as Record<string, any> | null)

      if (path === "/token" && u.searchParams.get("grant_type") === "password") {
        const account = byEmail(String(body?.email ?? ""))
        if (!account || account.password !== body?.password) return json({error: "invalid_grant", error_code: "invalid_credentials"}, 400)
        return json({access_token: await accessToken(account), token_type: "bearer", expires_in: 3600, refresh_token: randomUUID(), user: userJson(account)})
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
