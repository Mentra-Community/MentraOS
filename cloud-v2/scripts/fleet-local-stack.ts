#!/usr/bin/env bun
/**
 * The Core half of the local Fleet stack (Fleet Phase 11), for walking the workspace portal's Fleet pages in a browser
 * and pointing a phone at a local Core. Local development only: it refuses a deployed environment, a Doppler-injected
 * environment and any Mongo that is not on this machine, and every secret it uses is generated here.
 *
 *   bun scripts/fleet-local-stack.ts [--lan] [--state /tmp/fleet-e2e/state]
 *
 * It runs, in this process:
 *   - Core on :3000, with Fleet installed (`CLOUD_CORE_FLEET_URL` = MFM on :3004) and a 120-day interval history;
 *   - a stand-in account directory (`fleet-local/fake-gotrue.ts`) on :3190, so `/api/account/login` works with the
 *     stack's test accounts, from a phone too;
 *   - the workspace portal's built site on :5175 and the admin portal's on :5174, served as Cloudflare Pages serves
 *     them (their `_headers`, `/api/*` to Core), each with a local sign-in page at `/__dev/login`;
 *   - a local control API on :3199 for the seed (`miniapp-store/fleet/scripts/seed.ts`): create test accounts, mint
 *     portal sessions, backdate a membership, expire an invitation.
 *
 * MFM is started separately from the miniapp-store repository (`fleet/scripts/dev-stack.ts`); this script writes
 * the settings it needs to `<state>/mfm.env`. Everything binds 127.0.0.1 unless `--lan` is given, which binds Core,
 * the account directory and the portals to every interface so a phone on the same network can reach Core.
 *
 * The routine and report workers `startCore` runs are not started: they deliver to Slack and are not Fleet's.
 */
import {randomBytes, generateKeyPairSync} from "node:crypto"
import {existsSync, mkdirSync, readFileSync, writeFileSync} from "node:fs"
import {networkInterfaces} from "node:os"
import {resolve} from "node:path"

const args = process.argv.slice(2)
const flag = (name: string) => args.includes(name)
const option = (name: string, fallback: string) => {
  const at = args.indexOf(name)
  return at >= 0 && args[at + 1] ? args[at + 1]! : fallback
}

const LAN = flag("--lan")
const HOST = LAN ? "0.0.0.0" : "127.0.0.1"
const STATE = resolve(option("--state", "/tmp/fleet-e2e/state"))
const PORTS = {core: 3000, gotrue: 3190, control: 3199, portal: 5175, admin: 5174, mfm: 3004}
const MONGO_URL = process.env.FLEET_LOCAL_CORE_MONGO_URL ?? "mongodb://127.0.0.1:27017/fleet-e2e-core?replicaSet=rs0&directConnection=true"
const MFM_MONGO_URL = process.env.FLEET_LOCAL_MFM_MONGO_URL ?? "mongodb://127.0.0.1:27017/fleet-e2e-mfm?replicaSet=rs0&directConnection=true"
const ROOT = resolve(import.meta.dir, "..")

function refuse(message: string): never {
  console.error(`[fleet-local] refusing to start: ${message}`)
  process.exit(1)
}

function assertLocal(url: string, label: string) {
  const parsed = new URL(url)
  if (parsed.protocol !== "mongodb:" || !["127.0.0.1", "localhost"].includes(parsed.hostname) || parsed.username) {
    refuse(`${label} must be a mongodb:// URL on 127.0.0.1 or localhost without credentials`)
  }
}

if (process.env.NODE_ENV === "production") refuse("NODE_ENV is production")
if (["dev", "staging", "prod", "production"].includes((process.env.CLOUD_CORE_ENVIRONMENT ?? "").trim().toLowerCase())) {
  refuse("CLOUD_CORE_ENVIRONMENT names a deployed environment")
}
if (process.env.DOPPLER_PROJECT || process.env.DOPPLER_CONFIG) refuse("run it without Doppler: it generates its own throwaway secrets")
assertLocal(MONGO_URL, "FLEET_LOCAL_CORE_MONGO_URL")
assertLocal(MFM_MONGO_URL, "FLEET_LOCAL_MFM_MONGO_URL")

mkdirSync(STATE, {recursive: true})

/** Throwaway secrets, kept across restarts so a phone's session survives one. */
interface LocalSecrets {
  keys: Record<string, string>
  fleetSecret: string
  fleetServiceSecret: string
  supabaseJwtSecret: string
  anonKey: string
  serviceKey: string
  refreshPepper: string
}

function loadSecrets(): LocalSecrets {
  const file = resolve(STATE, "secrets.json")
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8")) as LocalSecrets
  const strip = (p: string) => p.replace(/-----(BEGIN|END) [A-Z ]+-----/g, "").replace(/\s+/g, "")
  const keys: Record<string, string> = {}
  for (const name of ["MENTRA_JWT", "MENTRA_MINIAPP_JWT", "MENTRA_ACCOUNT_JWT"]) {
    const pair = generateKeyPairSync("ed25519")
    keys[`${name}_PRIVATE_KEY`] = strip(pair.privateKey.export({type: "pkcs8", format: "pem"}).toString())
    keys[`${name}_PUBLIC_KEY`] = strip(pair.publicKey.export({type: "spki", format: "pem"}).toString())
  }
  const random = () => randomBytes(32).toString("base64url")
  const secrets: LocalSecrets = {
    keys,
    fleetSecret: random(),
    fleetServiceSecret: random(),
    supabaseJwtSecret: random(),
    anonKey: `local-anon-${random()}`,
    serviceKey: `local-service-${random()}`,
    refreshPepper: random(),
  }
  writeFileSync(file, JSON.stringify(secrets, null, 2), {mode: 0o600})
  return secrets
}

const secrets = loadSecrets()
const PORTAL_URL = `http://localhost:${PORTS.portal}`
const ADMIN_URL = `http://localhost:${PORTS.admin}`
const ORG_ADMIN_EMAIL = "ops@mentra-fleet.test"

// Everything Core reads, set here and nowhere else (an inherited value never wins).
Object.assign(process.env, {
  ...secrets.keys,
  NODE_ENV: "development",
  CLOUD_CORE_ENVIRONMENT: "local",
  MONGO_URL,
  REDIS_URL: "redis://127.0.0.1:6379/9",
  REFRESH_TOKEN_PEPPER: secrets.refreshPepper,
  SUPABASE_URL: `http://127.0.0.1:${PORTS.gotrue}`,
  SUPABASE_ANON_KEY: secrets.anonKey,
  SUPABASE_SERVICE_ROLE_KEY: secrets.serviceKey,
  SUPABASE_JWT_SECRET: secrets.supabaseJwtSecret,
  CLOUD_CORE_SUPABASE_ISSUER: `http://127.0.0.1:${PORTS.gotrue}/auth/v1`,
  CLOUD_CORE_ENTERPRISE_PORTAL_URL: PORTAL_URL,
  CLOUD_CORE_ADMIN_PORTAL_URL: ADMIN_URL,
  CLOUD_CORE_WORKSPACE_INVITE_URL_TEMPLATE: `${PORTAL_URL}/invite/{token}`,
  CLOUD_CORE_ADMIN_EMAILS: ORG_ADMIN_EMAIL,
  CLOUD_CORE_ADMIN_EMAIL_DOMAINS: "",
  CLOUD_CORE_FLEET_URL: `http://127.0.0.1:${PORTS.mfm}`,
  CLOUD_CORE_FLEET_SECRET: secrets.fleetSecret,
  CLOUD_CORE_SERVICE_SECRETS: JSON.stringify({fleet: [secrets.fleetServiceSecret]}),
  CLOUD_CORE_FLEET_HISTORY_MAX_DAYS: "120",
})
for (const name of Object.keys(process.env)) {
  if (/SLACK|S3_|STORAGE_|SONIOX|REPORT_AGENT|OIDC/.test(name)) delete process.env[name]
}

writeFileSync(
  resolve(STATE, "mfm.env"),
  [
    `PORT=${PORTS.mfm}`,
    `MONGO_URL=${MFM_MONGO_URL}`,
    `MFM_CORE_FORWARDING_SECRETS=${JSON.stringify([secrets.fleetSecret])}`,
    `MFM_CORE_URL=http://127.0.0.1:${PORTS.core}`,
    `MFM_CORE_SERVICE_SECRET=${secrets.fleetServiceSecret}`,
    "",
  ].join("\n"),
  {mode: 0o600},
)

// Core's modules read their keys when first used, so they are imported only now.
const {connectMongo, mongoReadinessCheck} = await import("../packages/core/src/connections/mongo.connection")
const {createApp} = await import("../packages/core/src/api/app")
const {runStartupMigrations} = await import("../packages/core/src/migrations/startup.migrations")
const {assertSupabaseApiKeys} = await import("../packages/core/src/services/account/gotrue.client")
const {assertSigninConfiguration} = await import("../packages/core/src/services/signin/config")
const {assertOrganizationConfiguration} = await import("../packages/core/src/services/workspaces/organization")
const {registerAfterSignInHook} = await import("../packages/core/src/services/oidc/interactions")
const {claimLegacyIdentitiesAfterSignIn} = await import("../packages/core/src/services/workspaces/membership-claim.service")
const {createPortalSession} = await import("../packages/core/src/services/signin/browser-session.service")
const {findOrCreateUser} = await import("../packages/core/src/services/user.service")
const {SigninIdentityModel} = await import("../packages/core/src/models/signin-identity.model")
const {WorkspaceMembershipModel} = await import("../packages/core/src/models/workspace-membership.model")
const {WorkspaceInvitationModel} = await import("../packages/core/src/models/workspace-invitation.model")
const {startFakeGotrue} = await import("./fleet-local/fake-gotrue")
const {startStaticSite} = await import("./fleet-local/static-site")

const gotrue = startFakeGotrue({
  hostname: HOST,
  port: PORTS.gotrue,
  stateFile: resolve(STATE, "accounts.json"),
  anonKey: secrets.anonKey,
  serviceKey: secrets.serviceKey,
  jwtSecret: secrets.supabaseJwtSecret,
})

assertSupabaseApiKeys()
assertOrganizationConfiguration()
await connectMongo(MONGO_URL)
await runStartupMigrations()
await assertSigninConfiguration()
registerAfterSignInHook(claimLegacyIdentitiesAfterSignIn)
const app = createApp({readinessChecks: [mongoReadinessCheck]})
Bun.serve({hostname: HOST, port: PORTS.core, idleTimeout: 60, maxRequestBodySize: 32 * 1024 * 1024, fetch: app.fetch})

/** A test account: in the account directory (password sign-in) and in Core (user and sign-in identity). */
async function ensurePerson(input: {email: string; password: string; name: string | null}) {
  const account = gotrue.upsert(input)
  const user = await findOrCreateUser({tenantId: "mentra", tenantUserId: account.id})
  await SigninIdentityModel.updateOne(
    {mentraUserId: user.mentraUserId},
    {$set: {tenantId: "mentra", sourceId: "mentra", subject: account.id, email: account.email, emailVerified: true, name: input.name, signedInAt: new Date()}},
    {upsert: true},
  )
  return {mentraUserId: user.mentraUserId, accountId: account.id, email: account.email}
}

async function mint(portal: "portal" | "admin", email: string): Promise<string | null> {
  const account = gotrue.byEmail(email)
  if (!account) return null
  const person = await ensurePerson({email: account.email, password: account.password, name: account.name})
  const {cookieValue} = await createPortalSession(portal, {
    mentraUserId: person.mentraUserId,
    tenantId: "mentra",
    sourceId: "mentra",
    subject: account.id,
    email: account.email,
    emailVerified: true,
    authTime: new Date(),
  })
  return cookieValue
}

const accounts = () => {
  const file = resolve(STATE, "accounts.json")
  if (!existsSync(file)) return []
  return (JSON.parse(readFileSync(file, "utf8")) as Array<{email: string; name: string | null}>).map((a) => ({
    email: a.email,
    label: a.email === ORG_ADMIN_EMAIL ? "(Organization Admin)" : (a.name ?? ""),
  }))
}

for (const site of ["portal", "admin"] as const) {
  const dist = resolve(ROOT, "websites", site, "dist")
  if (!existsSync(resolve(dist, "index.html"))) refuse(`websites/${site}/dist is missing: build it first (see STACK.md)`)
}
const portal = startStaticSite({
  name: "Workspace portal",
  hostname: HOST,
  port: PORTS.portal,
  distDir: resolve(ROOT, "websites/portal/dist"),
  coreUrl: `http://127.0.0.1:${PORTS.core}`,
  cookieName: "mentra_portal_session",
  accounts,
  mint: (email) => mint("portal", email),
})
const admin = startStaticSite({
  name: "Admin portal",
  hostname: HOST,
  port: PORTS.admin,
  distDir: resolve(ROOT, "websites/admin/dist"),
  coreUrl: `http://127.0.0.1:${PORTS.core}`,
  cookieName: "mentra_admin_session",
  accounts,
  mint: (email) => mint("admin", email),
})

// The seed's control API: loopback only, whatever --lan says.
Bun.serve({
  hostname: "127.0.0.1",
  port: PORTS.control,
  async fetch(req) {
    const url = new URL(req.url)
    const body = req.method === "POST" ? ((await req.json().catch(() => ({}))) as Record<string, any>) : {}
    try {
      if (url.pathname === "/people" && req.method === "POST") {
        return Response.json(await ensurePerson({email: String(body.email), password: String(body.password ?? "fleet-local-pass"), name: body.name ?? null}))
      }
      if (url.pathname === "/sessions" && req.method === "POST") {
        const value = await mint(body.portal === "admin" ? "admin" : "portal", String(body.email))
        return value ? Response.json({cookie: `mentra_${body.portal === "admin" ? "admin" : "portal"}_session=${value}`}) : Response.json({error: "no_account"}, {status: 404})
      }
      if (url.pathname === "/memberships/backdate" && req.method === "POST") {
        const startedAt = new Date(String(body.startedAt))
        const result = await WorkspaceMembershipModel.updateOne(
          {workspaceId: String(body.workspaceId), mentraUserId: String(body.mentraUserId), status: "active"},
          {$set: {startedAt, createdAt: startedAt, "roleHistory.$[].from": startedAt}},
        )
        return Response.json({matched: result.matchedCount})
      }
      if (url.pathname === "/invitations/expire" && req.method === "POST") {
        const result = await WorkspaceInvitationModel.updateOne({invitationId: String(body.invitationId)}, {$set: {expiresAt: new Date(Date.now() - 86_400_000)}})
        return Response.json({matched: result.matchedCount})
      }
      if (url.pathname === "/health") return Response.json({ok: true})
      return Response.json({error: "not_found"}, {status: 404})
    } catch (error) {
      console.error("[fleet-local] control error", error)
      return Response.json({error: "server_error", message: String((error as Error)?.message ?? error)}, {status: 500})
    }
  },
})

await ensurePerson({email: ORG_ADMIN_EMAIL, password: "fleet-local-pass", name: "Org Admin"})

const lan = Object.values(networkInterfaces())
  .flat()
  .find((i) => i && i.family === "IPv4" && !i.internal)?.address
console.log(`
[fleet-local] Core half of the local Fleet stack is up (${LAN ? "all interfaces" : "127.0.0.1 only"})
  Core              http://127.0.0.1:${PORTS.core}${LAN && lan ? `  (LAN: http://${lan}:${PORTS.core})` : ""}
  Workspace portal  ${portal.url}   (sign in: ${portal.url}/__dev/login)
  Admin portal      ${admin.url}   (sign in: ${admin.url}/__dev/login)
  Account directory http://127.0.0.1:${PORTS.gotrue} (stand-in GoTrue)
  Control API       http://127.0.0.1:${PORTS.control} (seed only)
  MFM expected at   http://127.0.0.1:${PORTS.mfm}; its settings: ${resolve(STATE, "mfm.env")}
  Core database     ${MONGO_URL}
`)
