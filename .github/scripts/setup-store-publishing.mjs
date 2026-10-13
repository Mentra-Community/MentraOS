#!/usr/bin/env node
/**
 * Set up a non-production Mentra Miniapp Store so `.github/workflows/miniapp-store-publish.yml` can
 * publish the first-party miniapps in `miniapps/` to it.
 *
 *   doppler run --project cloud-v2 --config <dev_aws|staging> -- \
 *     node .github/scripts/setup-store-publishing.mjs <dev|staging> [--dry-run] [--reissue]
 *
 * As that Store's staff account (the QA account's `+store-staff` plus-address, Store staff through
 * `MENTRA_STORE_ADMIN_EMAILS` or `MENTRA_STORE_ADMIN_EMAIL_DOMAINS` in the Store's Doppler config), it:
 *   1. signs in through that environment's Core sign-in server, as the `mentra` CLI does;
 *   2. finds the workspace holding the `com.mentra` package prefix, or the "Mentra" workspace, or
 *      creates it, and claims `com.mentra` for it;
 *   3. creates any of the miniapps that the Store does not have yet;
 *   4. creates the Store's GitHub environment (deployments from `dev` only) and, for each miniapp whose
 *      key is not there yet, issues an app-restricted publishing key and stores it as an environment
 *      secret. `--reissue` issues new keys for all of them and then revokes the keys it replaced.
 *
 * Running it again changes nothing that is already in place. It never prints a key or a token.
 * `--dry-run` signs in and reports what it would do. Needs `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
 * `SUPABASE_ANON_KEY` and `QA_TEST_EMAIL` in the environment, and `gh` signed in as a repository admin.
 */
import {spawnSync} from "node:child_process"
import {createHash, randomBytes} from "node:crypto"
import {readFileSync} from "node:fs"
import path from "node:path"
import {fileURLToPath} from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const REPOSITORY = process.env.GITHUB_REPOSITORY || "Mentra-Community/MentraOS"
const PACKAGE_PREFIX = "com.mentra"
const WORKSPACE_NAME = "Mentra"
const WORKSPACE_HEADER = "x-mentra-workspace-id"
/** A loopback redirect registered for every Core's `mentra` CLI client; nothing listens on it. */
const CLI_REDIRECT_URI = "http://127.0.0.1:53682/callback"

/**
 * The Stores this script sets up. Production's publishing keys are the original repository secrets
 * (`MENTRA_STORE_PUBLISH_TOKEN_<KEY>`); every other Store keeps its own under its own names, in the
 * GitHub environment named after it. Keep in step with the publish workflow's `store` matrix.
 */
export const STORES = {
  dev: {
    url: "https://api.apps.dev.mentraglass.com",
    environment: "miniapp-store-dev",
    secretPrefix: "MENTRA_DEV_STORE_PUBLISH_TOKEN_",
  },
  staging: {
    url: "https://api.apps.staging.mentraglass.com",
    environment: "miniapp-store-staging",
    secretPrefix: "MENTRA_STAGING_STORE_PUBLISH_TOKEN_",
  },
}

/** The miniapps the publish workflow publishes, by directory in `miniapps/`, with their key's name. */
export const MINIAPPS = [
  {directory: "captions", key: "CAPTIONS"},
  {directory: "translation", key: "TRANSLATION"},
  {directory: "teleprompter", key: "TELEPROMPTER"},
  {directory: "navigation", key: "MAPS"},
  {directory: "recorder", key: "RECORDER"},
]

/** The staff account: the QA account's `+store-staff` plus-address. */
export function staffEmail(qaEmail) {
  const [local, domain] = String(qaEmail ?? "")
    .trim()
    .toLowerCase()
    .split("@")
  if (!local || !domain) throw new Error("QA_TEST_EMAIL is not set")
  return `${local.split("+")[0]}+store-staff@${domain}`
}

/** Each miniapp's package, Store name and short description, from its `miniapp.json` and Store listing. */
export function loadMiniapps(root = ROOT) {
  return MINIAPPS.map(({directory, key}) => {
    const manifest = JSON.parse(readFileSync(path.join(root, "miniapps", directory, "miniapp.json"), "utf8"))
    const listing = JSON.parse(readFileSync(path.join(root, "miniapps", directory, "store", "listing.json"), "utf8"))
    if (!manifest.packageName?.startsWith(`${PACKAGE_PREFIX}.`)) {
      throw new Error(`miniapps/${directory} is not a ${PACKAGE_PREFIX} package`)
    }
    return {
      directory,
      key,
      packageName: manifest.packageName,
      name: manifest.name,
      description: listing.subtitle ?? null,
    }
  })
}

/** What a run does, from what the Store and GitHub already have. */
export function planSetup({miniapps, storeApps, secretNames, secretPrefix, reissue = false}) {
  const existing = new Set(storeApps.map((app) => app.packageName))
  const secrets = new Set(secretNames)
  return miniapps.map((miniapp) => {
    const secret = `${secretPrefix}${miniapp.key}`
    return {...miniapp, secret, create: !existing.has(miniapp.packageName), issueKey: reissue || !secrets.has(secret)}
  })
}

/** A minimal cookie jar for one sign-in: cookies by host, names and values only. */
export class CookieJar {
  #cookies = new Map()

  header(url) {
    const cookies = this.#cookies.get(new URL(url).host)
    return cookies && cookies.size ? [...cookies].map(([name, value]) => `${name}=${value}`).join("; ") : null
  }

  store(url, setCookieHeaders) {
    const host = new URL(url).host
    const cookies = this.#cookies.get(host) ?? new Map()
    for (const header of setCookieHeaders) {
      const [pair, ...attributes] = header.split(";")
      const separator = pair.indexOf("=")
      if (separator <= 0) continue
      const name = pair.slice(0, separator).trim()
      const expired = attributes.some((attribute) => {
        const [key, value = ""] = attribute.trim().split("=")
        if (key.toLowerCase() === "max-age") return Number(value) <= 0
        if (key.toLowerCase() === "expires") return Date.parse(value) <= Date.now()
        return false
      })
      if (expired) cookies.delete(name)
      else cookies.set(name, pair.slice(separator + 1).trim())
    }
    this.#cookies.set(host, cookies)
  }

  async fetch(url, init = {}) {
    const headers = new Headers(init.headers)
    const cookie = this.header(url)
    if (cookie) headers.set("cookie", cookie)
    const response = await fetch(url, {...init, headers, redirect: "manual"})
    this.store(url, response.headers.getSetCookie())
    return response
  }
}

const base64url = (bytes) => Buffer.from(bytes).toString("base64url")

function supabaseHeaders(key) {
  const headers = {"apikey": key, "content-type": "application/json"}
  if (!key.startsWith("sb_")) headers.authorization = `Bearer ${key}`
  return headers
}

function requireEnv(name) {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is not set; run this through doppler run (see the header)`)
  return value
}

/** A Supabase access token for `email` from an admin magic link: no password, and no email is sent. */
async function supabaseAccessToken(email) {
  const supabase = requireEnv("SUPABASE_URL").replace(/\/+$/, "")
  const service = requireEnv("SUPABASE_SERVICE_ROLE_KEY")
  const created = await fetch(`${supabase}/auth/v1/admin/users`, {
    method: "POST",
    headers: supabaseHeaders(service),
    body: JSON.stringify({email, email_confirm: true}),
  })
  if (!created.ok && created.status !== 422) {
    const body = await created.json().catch(() => ({}))
    if (!/already/i.test(`${body.msg ?? body.message ?? body.error_code ?? ""}`)) {
      throw new Error(`could not ensure the staff account exists (HTTP ${created.status})`)
    }
  }
  const link = await fetch(`${supabase}/auth/v1/admin/generate_link`, {
    method: "POST",
    headers: supabaseHeaders(service),
    body: JSON.stringify({type: "magiclink", email}),
  })
  const linkBody = await link.json().catch(() => ({}))
  const hashedToken = linkBody.hashed_token ?? linkBody.properties?.hashed_token
  if (!hashedToken) throw new Error(`could not create a sign-in link for the staff account (HTTP ${link.status})`)
  const verified = await fetch(`${supabase}/auth/v1/verify`, {
    method: "POST",
    headers: supabaseHeaders(requireEnv("SUPABASE_ANON_KEY")),
    body: JSON.stringify({type: "magiclink", token_hash: hashedToken}),
  })
  const verifiedBody = await verified.json().catch(() => ({}))
  if (!verifiedBody.access_token) throw new Error(`could not sign the staff account in (HTTP ${verified.status})`)
  return verifiedBody.access_token
}

async function json(response, what) {
  const body = await response.json().catch(() => null)
  if (!response.ok) {
    const reason = body?.error_description ?? body?.error ?? body?.message ?? ""
    throw new Error(`${what} failed: HTTP ${response.status}${reason ? ` (${reason})` : ""}`)
  }
  return body
}

/**
 * A Core access token for `email`, from the Store's Core sign-in server: the `mentra` CLI's authorization
 * code flow with PKCE, with the sign-in page's Supabase hand-off done directly.
 */
export async function signIn(storeUrl, email) {
  const {issuer, clientId} = await json(
    await fetch(`${storeUrl}/api/console/auth/cli-config`),
    "reading the Store's sign-in settings",
  )
  const discovery = await json(await fetch(`${issuer}/.well-known/openid-configuration`), "reading the sign-in server")
  const verifier = base64url(randomBytes(32))
  const state = base64url(randomBytes(16))
  const authorization = new URL(discovery.authorization_endpoint)
  for (const [key, value] of Object.entries({
    client_id: clientId,
    redirect_uri: CLI_REDIRECT_URI,
    response_type: "code",
    scope: "openid email profile",
    code_challenge: base64url(createHash("sha256").update(verifier).digest()),
    code_challenge_method: "S256",
    state,
    nonce: base64url(randomBytes(16)),
  })) {
    authorization.searchParams.set(key, value)
  }

  const jar = new CookieJar()
  let url = authorization.toString()
  let handedOff = false
  for (let step = 0; step < 12; step += 1) {
    const response = await jar.fetch(url)
    const location = response.headers.get("location")
    if (!location) throw new Error(`sign-in stopped at HTTP ${response.status} without finishing`)
    const next = new URL(location, url)
    if (`${next.origin}${next.pathname}` === CLI_REDIRECT_URI) {
      if (next.searchParams.get("state") !== state) throw new Error("sign-in returned a different state")
      const code = next.searchParams.get("code")
      if (!code) throw new Error(`sign-in was refused (${next.searchParams.get("error") ?? "no code"})`)
      const tokens = await json(
        await fetch(discovery.token_endpoint, {
          method: "POST",
          headers: {"content-type": "application/x-www-form-urlencoded"},
          body: new URLSearchParams({
            grant_type: "authorization_code",
            code,
            redirect_uri: CLI_REDIRECT_URI,
            client_id: clientId,
            code_verifier: verifier,
          }),
        }),
        "redeeming the sign-in",
      )
      if (!tokens.access_token) throw new Error("the sign-in server issued no access token")
      return tokens.access_token
    }
    const interaction = next.searchParams.get("interaction")
    if (next.pathname === "/login" && interaction && !handedOff) {
      handedOff = true
      const handOff = await jar.fetch(`${next.origin}/interaction/${encodeURIComponent(interaction)}/supabase`, {
        method: "POST",
        headers: {"content-type": "application/json", "origin": next.origin},
        body: JSON.stringify({access_token: await supabaseAccessToken(email)}),
      })
      const {redirectTo} = await json(handOff, "signing in")
      if (!redirectTo) throw new Error("the sign-in page gave no next step")
      url = new URL(redirectTo, next).toString()
      continue
    }
    url = next.toString()
  }
  throw new Error("sign-in did not finish")
}

/** Calls to one Store backend as the signed-in person. */
export function storeClient(storeUrl, accessToken) {
  return async (method, route, {body, workspaceId} = {}) => {
    const headers = {accept: "application/json", authorization: `Bearer ${accessToken}`}
    if (workspaceId) headers[WORKSPACE_HEADER] = workspaceId
    if (body !== undefined) headers["content-type"] = "application/json"
    return fetch(`${storeUrl}${route}`, {method, headers, body: body === undefined ? undefined : JSON.stringify(body)})
  }
}

/** The workspace that holds `com.mentra`, else the person's "Mentra" workspace, else null. */
async function findWorkspace(store, workspaces) {
  for (const workspace of workspaces) {
    const profile = await store("GET", "/api/console/publishing-profile", {workspaceId: workspace.workspaceId})
    if (profile.ok && (await profile.json()).packagePrefix === PACKAGE_PREFIX) return workspace
  }
  return workspaces.find((workspace) => workspace.name === WORKSPACE_NAME) ?? null
}

/** An app-restricted publishing key for `packageName`, issued by Store staff. Returns `{id, value}`. */
export async function issuePublishingKey(store, packageName, name) {
  const issued = await json(
    await store("POST", `/api/admin/apps/${encodeURIComponent(packageName)}/publishing-tokens`, {body: {name}}),
    `issuing ${packageName}'s publishing key`,
  )
  if (!issued?.token?.id || !issued.token.value)
    throw new Error(`issuing ${packageName}'s publishing key returned no key`)
  return {id: issued.token.id, value: issued.token.value}
}

/** The workspace's live keys named `name` that publish only `packageName`. */
export async function publishingKeyIds(store, workspaceId, packageName, name) {
  const {items = []} = await json(
    await store("GET", `/api/console/workspaces/${encodeURIComponent(workspaceId)}/credentials`),
    "listing the workspace's keys",
  )
  return items
    .filter((key) => key.name === name && key.packageNames?.length === 1 && key.packageNames[0] === packageName)
    .map((key) => key.credentialId)
}

export async function revokePublishingKey(store, workspaceId, credentialId) {
  const response = await store(
    "DELETE",
    `/api/console/workspaces/${encodeURIComponent(workspaceId)}/credentials/${encodeURIComponent(credentialId)}`,
  )
  if (!response.ok && response.status !== 404)
    throw new Error(`revoking a replaced key failed: HTTP ${response.status}`)
}

function gh(args, {input} = {}) {
  const result = spawnSync("gh", args, {encoding: "utf8", input, stdio: ["pipe", "pipe", "pipe"]})
  if (result.status !== 0) throw new Error(`gh ${args.slice(0, 2).join(" ")} failed: ${(result.stderr || "").trim()}`)
  return result.stdout
}

/** The environment's secret names, or none when the environment does not exist yet. Any other failure stops the run. */
function environmentSecretNames(environment) {
  const probe = spawnSync("gh", ["api", `repos/${REPOSITORY}/environments/${environment}`], {encoding: "utf8"})
  if (probe.status !== 0) {
    if (/HTTP 404/.test(probe.stderr ?? "")) return []
    throw new Error(`gh api environments/${environment} failed: ${(probe.stderr ?? "").trim()}`)
  }
  return gh(["api", "--paginate", `repos/${REPOSITORY}/environments/${environment}/secrets`, "--jq", ".secrets[].name"])
    .split("\n")
    .filter(Boolean)
}

/** Whether a deployment policy is the one this environment allows: the `dev` branch. */
export const isDevBranchPolicy = (policy) => policy.name === "dev" && (policy.type ?? "branch") === "branch"

/**
 * The Store's GitHub environment, which only `dev` (the branch the workflow publishes from) may deploy to.
 * Any other deployment policy would let that ref read the Store's keys, so it is removed.
 */
function ensureEnvironment(environment) {
  gh(["api", "-X", "PUT", `repos/${REPOSITORY}/environments/${environment}`, "--input", "-"], {
    input: JSON.stringify({deployment_branch_policy: {protected_branches: false, custom_branch_policies: true}}),
  })
  const route = `repos/${REPOSITORY}/environments/${environment}/deployment-branch-policies`
  const policies = gh([
    "api",
    "--paginate",
    route,
    "--jq",
    '.branch_policies[] | [.id, .name, (.type // "branch")] | @tsv',
  ])
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [id, name, type] = line.split("\t")
      return {id, name, type}
    })
  for (const policy of policies.filter((candidate) => !isDevBranchPolicy(candidate))) {
    gh(["api", "-X", "DELETE", `${route}/${policy.id}`])
    console.log(
      `Removed the ${policy.type} deployment policy "${policy.name}" from ${environment}: only dev may deploy there.`,
    )
  }
  if (!policies.some(isDevBranchPolicy)) gh(["api", "-X", "POST", route, "-f", "name=dev", "-f", "type=branch"])
}

async function main(argv) {
  const environmentName = argv.find((arg) => !arg.startsWith("--"))
  const dryRun = argv.includes("--dry-run")
  const reissue = argv.includes("--reissue")
  const unknown = argv.filter((arg) => arg.startsWith("--") && !["--dry-run", "--reissue"].includes(arg))
  const target = STORES[environmentName]
  if (!target || unknown.length) {
    throw new Error(`usage: setup-store-publishing.mjs <${Object.keys(STORES).join("|")}> [--dry-run] [--reissue]`)
  }
  const miniapps = loadMiniapps()
  const email = staffEmail(process.env.QA_TEST_EMAIL)
  console.log(`Store: ${target.url} (GitHub environment ${target.environment})${dryRun ? " — dry run" : ""}`)

  const store = storeClient(target.url, await signIn(target.url, email))
  const adminMe = await store("GET", "/api/admin/me")
  if (!adminMe.ok)
    throw new Error(
      `the staff account is not Store staff here (HTTP ${adminMe.status}); check MENTRA_STORE_ADMIN_EMAILS`,
    )
  const me = await json(await store("GET", "/api/console/auth/me"), "reading the staff account's workspaces")
  console.log("Signed in as the Store's staff account.")

  let workspace = await findWorkspace(store, me.workspaces ?? [])
  if (!workspace) {
    if (dryRun) {
      console.log(
        `Would create the "${WORKSPACE_NAME}" workspace, claim ${PACKAGE_PREFIX} and create ${miniapps.length} miniapps.`,
      )
      return
    }
    const created = await json(
      await store("POST", "/api/console/workspaces", {body: {name: WORKSPACE_NAME}}),
      "creating the workspace",
    )
    workspace = {workspaceId: created.workspaceId ?? created.workspace?.workspaceId, name: WORKSPACE_NAME}
    if (!workspace.workspaceId) throw new Error("creating the workspace returned no workspace ID")
    console.log(`Created the "${WORKSPACE_NAME}" workspace (${workspace.workspaceId}).`)
  } else {
    console.log(`Workspace: "${workspace.name}" (${workspace.workspaceId}).`)
  }
  const workspaceId = workspace.workspaceId

  if (dryRun) {
    const profile = await store("GET", "/api/console/publishing-profile", {workspaceId})
    const prefix = profile.ok ? (await profile.json()).packagePrefix : null
    if (prefix !== PACKAGE_PREFIX) console.log(`Would claim ${PACKAGE_PREFIX}.`)
  } else {
    const profile = await json(
      await store("PUT", "/api/console/publishing-profile", {workspaceId, body: {packagePrefix: PACKAGE_PREFIX}}),
      `claiming ${PACKAGE_PREFIX}`,
    )
    console.log(`Package prefix: ${profile.packagePrefix} (${profile.packagePrefixStatus}).`)
  }

  const storeApps =
    (await json(await store("GET", "/api/console/apps", {workspaceId}), "listing the workspace's miniapps")).apps ?? []
  const plan = planSetup({
    miniapps,
    storeApps,
    secretNames: environmentSecretNames(target.environment),
    secretPrefix: target.secretPrefix,
    reissue,
  })
  if (dryRun) {
    for (const step of plan) {
      const actions = [
        step.create && "create the miniapp",
        step.issueKey && `issue its key into ${step.secret}`,
      ].filter(Boolean)
      console.log(`${step.packageName}: ${actions.length ? `would ${actions.join(" and ")}` : "ready"}`)
    }
    return
  }

  ensureEnvironment(target.environment)
  const keyName = `MentraOS CI publishing to the ${environmentName} Store`
  for (const step of plan) {
    if (step.create) {
      await json(
        await store("POST", "/api/console/apps", {
          workspaceId,
          body: {packageName: step.packageName, displayName: step.name, description: step.description},
        }),
        `creating ${step.packageName}`,
      )
    }
    let replaced = []
    if (step.issueKey) {
      const previous = await publishingKeyIds(store, workspaceId, step.packageName, keyName)
      const key = await issuePublishingKey(store, step.packageName, keyName)
      gh(["secret", "set", step.secret, "--env", target.environment, "--repo", REPOSITORY], {input: key.value})
      // Only a key this script issued under the same name is replaced, and only once its successor is stored.
      replaced = previous.filter((id) => id !== key.id)
      for (const id of replaced) await revokePublishingKey(store, workspaceId, id)
    }
    const done = [
      step.create && "created",
      step.issueKey && `key stored in ${step.secret}`,
      replaced.length && `${replaced.length} replaced key(s) revoked`,
    ].filter(Boolean)
    console.log(`${step.packageName}: ${done.length ? done.join(", ") : "already set up"}`)
  }
  console.log(
    `Done. The publish workflow publishes to this Store from dev while its entry in the workflow's store matrix is on.`,
  )
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`setup-store-publishing: ${error.message}`)
    process.exit(1)
  })
}
