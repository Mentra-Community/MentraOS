#!/usr/bin/env node
/**
 * Set up Mentra Miniapp Store publishing for every first-party miniapp: the ones in MentraOS's `miniapps/`
 * and the ones in their own repositories (REPOSITORIES). Each repository's
 * `.github/workflows/miniapp-store-publish.yml` then publishes them.
 *
 *   doppler run --project cloud-v2 --config <dev_aws|staging|prod> -- \
 *     node .github/scripts/setup-store-publishing.mjs <dev|staging|prod> [--repo <name>]... [--publish] [--dry-run] [--reissue]
 *   node .github/scripts/setup-store-publishing.mjs <dev|staging|prod> --environments-only [--repo <name>]... [--dry-run]
 *
 * Each branch publishes to its own Store: `dev` to the dev Store, `staging` to the staging Store and `main` to
 * production. A repository without a `staging` branch publishes to the staging Store from `main`, and one
 * without a `dev` branch publishes to the dev Store from `main`.
 *
 * For each repository (every one in REPOSITORIES, or the ones named with `--repo`), as that Store's staff
 * account (the QA account's `+store-staff` plus-address, Store staff through `MENTRA_STORE_ADMIN_EMAILS` or
 * `MENTRA_STORE_ADMIN_EMAIL_DOMAINS` in the Store's Doppler config), it:
 *   1. signs in through that environment's Core sign-in server, as the `mentra` CLI does;
 *   2. finds the workspace holding the `com.mentra` package prefix, or the "Mentra" workspace, or creates
 *      it, and claims `com.mentra` for it;
 *   3. creates any of the repository's miniapps that the Store does not have yet;
 *   4. creates the repository's GitHub environment for the Store, which only the branch that publishes to
 *      the Store may deploy to, and, for each miniapp whose key is not there yet, issues an app-restricted
 *      publishing key and stores it as an environment secret. `--reissue` issues new keys for all of them
 *      and then revokes the keys it replaced;
 *   5. for a Store that is switched on by a repository variable (staging), sets that variable once every
 *      miniapp in the repository has its key;
 *   6. with `--publish`, runs the repository's publish workflow on that branch, so the current versions
 *      reach the Store without waiting for the next push.
 *
 * `--environments-only` does only the environment part of step 4: no sign-in and no keys. It reports any
 * key that is missing, or still a repository secret that any branch could read.
 *
 * Running it again changes nothing that is already in place. It never prints a key or a token.
 * `--dry-run` reports what it would do. Needs `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
 * `SUPABASE_ANON_KEY` and `QA_TEST_EMAIL` in the environment (except with `--environments-only`), and `gh`
 * signed in as an administrator of every repository it sets up.
 */
import {spawnSync} from "node:child_process"
import {createHash, randomBytes} from "node:crypto"
import {readFileSync} from "node:fs"
import path from "node:path"
import {fileURLToPath} from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const PACKAGE_PREFIX = "com.mentra"
const WORKSPACE_NAME = "Mentra"
const WORKSPACE_HEADER = "x-mentra-workspace-id"
/** A loopback redirect registered for every Core's `mentra` CLI client; nothing listens on it. */
const CLI_REDIRECT_URI = "http://127.0.0.1:53682/callback"
/** The publish workflow in every repository. */
export const PUBLISH_WORKFLOW = "miniapp-store-publish.yml"

/**
 * The Stores. Each keeps its publishing keys in the GitHub environment named after it, as `<secret>` in a
 * repository with one miniapp and `<secret>_<KEY>` in MentraOS. `switch` names the repository variable that
 * turns publishing to the Store on. Keep in step with each repository's publish workflow.
 */
export const STORES = {
  dev: {
    url: "https://api.apps.dev.mentraglass.com",
    environment: "miniapp-store-dev",
    secret: "MENTRA_DEV_STORE_PUBLISH_TOKEN",
  },
  staging: {
    url: "https://api.apps.staging.mentraglass.com",
    environment: "miniapp-store-staging",
    secret: "MENTRA_STAGING_STORE_PUBLISH_TOKEN",
    switch: "MENTRA_STAGING_STORE_PUBLISHING",
  },
  prod: {
    url: "https://api.apps.mentraglass.com",
    environment: "miniapp-store-production",
    secret: "MENTRA_STORE_PUBLISH_TOKEN",
  },
}

/** The miniapps MentraOS's publish workflow publishes, by directory in `miniapps/`, with their key's name. */
export const MINIAPPS = [
  {directory: "captions", key: "CAPTIONS"},
  {directory: "translation", key: "TRANSLATION"},
  {directory: "teleprompter", key: "TELEPROMPTER"},
  {directory: "navigation", key: "MAPS"},
  {directory: "recorder", key: "RECORDER"},
]

export const MENTRAOS = "Mentra-Community/MentraOS"

/**
 * Every repository that publishes first-party miniapps, with the branches it has. A repository outside
 * MentraOS has one miniapp, in `miniapp/`, with its Store listing in `store/listing.json`.
 */
export const REPOSITORIES = [
  {repository: MENTRAOS, branches: ["dev", "staging", "main"]},
  {repository: "Mentra-Community/Mentra-Call", branches: ["dev", "main"], packageName: "com.mentra.call"},
  {repository: "Mentra-Community/Mentra-Notes-Miniapp", branches: ["dev", "main"], packageName: "com.mentra.notes"},
  {repository: "Mentra-Community/Mentra-AI-Miniapp", branches: ["dev", "main"], packageName: "com.mentra.ai"},
  {
    repository: "Mentra-Community/Livestreamer-Miniapp",
    branches: ["dev", "main"],
    packageName: "com.mentra.livestreamer",
  },
  {repository: "Mentra-Community/Merge-Miniapp", branches: ["dev", "main"], packageName: "com.mentra.merge"},
]

/** The branch that publishes to `storeName`: its own branch when the repository has one, else `main`. */
export function publishBranch(storeName, branches) {
  if (storeName === "prod") return "main"
  return branches.includes(storeName) ? storeName : "main"
}

/** A miniapp's key name in a Store's environment. */
export const secretName = (store, key) => (key ? `${store.secret}_${key}` : store.secret)

/** The repositories `--repo` names, by full or short name; all of them when it names none. */
export function selectRepositories(names) {
  if (!names.length) return REPOSITORIES
  return names.map((name) => {
    const wanted = name.toLowerCase()
    const found = REPOSITORIES.find(
      ({repository}) => repository.toLowerCase() === wanted || repository.split("/")[1].toLowerCase() === wanted,
    )
    if (!found) throw new Error(`${name} is not in REPOSITORIES`)
    return found
  })
}

/** The staff account: the QA account's `+store-staff` plus-address. */
export function staffEmail(qaEmail) {
  const [local, domain] = String(qaEmail ?? "")
    .trim()
    .toLowerCase()
    .split("@")
  if (!local || !domain) throw new Error("QA_TEST_EMAIL is not set")
  return `${local.split("+")[0]}+store-staff@${domain}`
}

/** MentraOS's miniapps: package, Store name and short description, from each `miniapp.json` and Store listing. */
export function loadMiniapps(root = ROOT) {
  return MINIAPPS.map(({directory, key}) => {
    const manifest = JSON.parse(readFileSync(path.join(root, "miniapps", directory, "miniapp.json"), "utf8"))
    const listing = JSON.parse(readFileSync(path.join(root, "miniapps", directory, "store", "listing.json"), "utf8"))
    return describeMiniapp({manifest, listing, key, where: `miniapps/${directory}`})
  })
}

export function describeMiniapp({manifest, listing, key, where, packageName}) {
  if (!manifest.packageName?.startsWith(`${PACKAGE_PREFIX}.`))
    throw new Error(`${where} is not a ${PACKAGE_PREFIX} package`)
  if (packageName && manifest.packageName !== packageName) {
    throw new Error(`${where} is ${manifest.packageName}, not ${packageName}`)
  }
  return {key, packageName: manifest.packageName, name: manifest.name, description: listing.subtitle ?? null}
}

/** A file from a repository's `main` branch. */
function repositoryJson(repository, file) {
  const content = gh(["api", `repos/${repository}/contents/${file}?ref=main`, "--jq", ".content"])
  return JSON.parse(Buffer.from(content, "base64").toString("utf8"))
}

/** A repository's miniapps. MentraOS's come from this checkout; another repository's from its `main`. */
function repositoryMiniapps(entry) {
  if (entry.repository === MENTRAOS) return loadMiniapps()
  return [
    describeMiniapp({
      manifest: repositoryJson(entry.repository, "miniapp/miniapp.json"),
      listing: repositoryJson(entry.repository, "store/listing.json"),
      key: "",
      where: `${entry.repository} miniapp/`,
      packageName: entry.packageName,
    }),
  ]
}

/** What a run does, from what the Store and GitHub already have. */
export function planSetup({miniapps, storeApps, secretNames, store, reissue = false}) {
  const existing = new Set(storeApps.map((app) => app.packageName))
  const secrets = new Set(secretNames)
  return miniapps.map((miniapp) => {
    const secret = secretName(store, miniapp.key)
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
  if (!issuer || !clientId) {
    throw new Error(
      "this Store does not sign in through Core yet, so Store staff issue its keys in its Console; --environments-only sets up its environments",
    )
  }
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

/** A `gh api` GET that answers null on a 404. Any other failure stops the run. */
function ghFind(route, jq) {
  const result = spawnSync("gh", ["api", "--paginate", route, ...(jq ? ["--jq", jq] : [])], {encoding: "utf8"})
  if (result.status === 0) return result.stdout
  if (/HTTP 404/.test(result.stderr ?? "")) return null
  throw new Error(`gh api ${route} failed: ${(result.stderr ?? "").trim()}`)
}

const lines = (output) => (output ?? "").split("\n").filter(Boolean)

/** The environment's secret names, or none when the environment does not exist yet. */
function environmentSecretNames(repository, environment) {
  if (ghFind(`repos/${repository}/environments/${environment}`) === null) return []
  return lines(ghFind(`repos/${repository}/environments/${environment}/secrets`, ".secrets[].name"))
}

/** The repository-level secret names, which every branch's workflows can read. */
function repositorySecretNames(repository) {
  return lines(ghFind(`repos/${repository}/actions/secrets`, ".secrets[].name"))
}

/** Whether a deployment policy is the one an environment allows: the branch that publishes to its Store. */
export const isBranchPolicy = (policy, branch) => policy.name === branch && (policy.type ?? "branch") === "branch"

/**
 * The Store's GitHub environment in `repository`, which only `branch` (the branch that publishes to the Store)
 * may deploy to. Any other deployment policy would let that ref read the Store's keys, so it is removed.
 */
function ensureEnvironment(repository, environment, branch) {
  gh(["api", "-X", "PUT", `repos/${repository}/environments/${environment}`, "--input", "-"], {
    input: JSON.stringify({deployment_branch_policy: {protected_branches: false, custom_branch_policies: true}}),
  })
  const route = `repos/${repository}/environments/${environment}/deployment-branch-policies`
  const policies = lines(
    gh(["api", "--paginate", route, "--jq", '.branch_policies[] | [.id, .name, (.type // "branch")] | @tsv']),
  ).map((line) => {
    const [id, name, type] = line.split("\t")
    return {id, name, type}
  })
  for (const policy of policies.filter((candidate) => !isBranchPolicy(candidate, branch))) {
    gh(["api", "-X", "DELETE", `${route}/${policy.id}`])
    console.log(`  Removed the ${policy.type} deployment policy "${policy.name}": only ${branch} may deploy there.`)
  }
  if (!policies.some((policy) => isBranchPolicy(policy, branch))) {
    gh(["api", "-X", "POST", route, "-f", `name=${branch}`, "-f", "type=branch"])
  }
}

/** Turns publishing to the Store on in `repository`, if the Store has a switch and it is off. */
function switchOn(repository, variable) {
  const current = ghFind(`repos/${repository}/actions/variables/${variable}`, ".value")
  if (current?.trim() === "true") return false
  gh(["variable", "set", variable, "--body", "true", "--repo", repository])
  return true
}

/** Options from the command line. */
export function parseArguments(argv) {
  const options = {repos: [], dryRun: false, reissue: false, publish: false, environmentsOnly: false}
  const flags = {
    "--dry-run": "dryRun",
    "--reissue": "reissue",
    "--publish": "publish",
    "--environments-only": "environmentsOnly",
  }
  const positional = []
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === "--repo") {
      if (!argv[index + 1] || argv[index + 1].startsWith("--")) throw new Error("--repo needs a repository name")
      options.repos.push(argv[(index += 1)])
    } else if (arg.startsWith("--repo=")) options.repos.push(arg.slice("--repo=".length))
    else if (flags[arg]) options[flags[arg]] = true
    else if (arg.startsWith("--")) throw new Error(`unknown option ${arg}`)
    else positional.push(arg)
  }
  if (positional.length !== 1 || !STORES[positional[0]])
    throw new Error(`name one Store: ${Object.keys(STORES).join(", ")}`)
  if (options.environmentsOnly && (options.reissue || options.publish)) {
    throw new Error("--environments-only issues no keys and publishes nothing")
  }
  return {...options, storeName: positional[0]}
}

/**
 * What is wrong with a Store's keys in one repository: a key missing from its environment, or a copy left as
 * a repository secret, which every branch's workflows can read, even when the environment has its own.
 */
export function keyFindings({keys, environment, inEnvironment, inRepository}) {
  const environmentKeys = new Set(inEnvironment)
  const repositoryKeys = new Set(inRepository)
  return keys.flatMap((key) => {
    if (repositoryKeys.has(key)) {
      return environmentKeys.has(key)
        ? [`${key} is also a repository secret, readable from every branch; delete that copy.`]
        : [`${key} is a repository secret, readable from every branch; move it into ${environment}.`]
    }
    return environmentKeys.has(key) ? [] : [`${key} is missing; Store staff issue it.`]
  })
}

/** Sets up only the Store's environments, and reports the keys they still need. */
function setUpEnvironments({store, storeName, repositories, dryRun}) {
  for (const entry of repositories) {
    const branch = publishBranch(storeName, entry.branches)
    console.log(`${entry.repository}: ${store.environment}, deployable from ${branch} only`)
    if (!dryRun) ensureEnvironment(entry.repository, store.environment, branch)
    const keys =
      entry.repository === MENTRAOS ? MINIAPPS.map(({key}) => secretName(store, key)) : [secretName(store, "")]
    const findings = keyFindings({
      keys,
      environment: store.environment,
      inEnvironment: environmentSecretNames(entry.repository, store.environment),
      inRepository: repositorySecretNames(entry.repository),
    })
    for (const finding of findings) console.log(`  ${finding}`)
  }
}

async function main(argv) {
  const options = parseArguments(argv)
  const {storeName, dryRun, reissue} = options
  const store = STORES[storeName]
  const repositories = selectRepositories(options.repos)
  console.log(`Store: ${store.url} (GitHub environment ${store.environment})${dryRun ? " — dry run" : ""}`)
  if (options.environmentsOnly) {
    setUpEnvironments({store, storeName, repositories, dryRun})
    return
  }

  const targets = repositories.map((entry) => ({...entry, miniapps: repositoryMiniapps(entry)}))
  const packages = targets.flatMap((target) => target.miniapps.map((miniapp) => miniapp.packageName))
  const email = staffEmail(process.env.QA_TEST_EMAIL)
  const client = storeClient(store.url, await signIn(store.url, email))
  const adminMe = await client("GET", "/api/admin/me")
  if (!adminMe.ok)
    throw new Error(
      `the staff account is not Store staff here (HTTP ${adminMe.status}); check MENTRA_STORE_ADMIN_EMAILS`,
    )
  const me = await json(await client("GET", "/api/console/auth/me"), "reading the staff account's workspaces")
  console.log("Signed in as the Store's staff account.")

  let workspace = await findWorkspace(client, me.workspaces ?? [])
  if (!workspace) {
    if (dryRun) {
      console.log(
        `Would create the "${WORKSPACE_NAME}" workspace, claim ${PACKAGE_PREFIX} and create ${packages.length} miniapps.`,
      )
      return
    }
    const created = await json(
      await client("POST", "/api/console/workspaces", {body: {name: WORKSPACE_NAME}}),
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
    const profile = await client("GET", "/api/console/publishing-profile", {workspaceId})
    const prefix = profile.ok ? (await profile.json()).packagePrefix : null
    if (prefix !== PACKAGE_PREFIX) console.log(`Would claim ${PACKAGE_PREFIX}.`)
  } else {
    const profile = await json(
      await client("PUT", "/api/console/publishing-profile", {workspaceId, body: {packagePrefix: PACKAGE_PREFIX}}),
      `claiming ${PACKAGE_PREFIX}`,
    )
    console.log(`Package prefix: ${profile.packagePrefix} (${profile.packagePrefixStatus}).`)
  }

  const storeApps =
    (await json(await client("GET", "/api/console/apps", {workspaceId}), "listing the workspace's miniapps")).apps ?? []
  for (const target of targets) {
    const {repository} = target
    const branch = publishBranch(storeName, target.branches)
    const plan = planSetup({
      miniapps: target.miniapps,
      storeApps,
      secretNames: environmentSecretNames(repository, store.environment),
      store,
      reissue,
    })
    console.log(`${repository}: publishes to this Store from ${branch}, with keys in ${store.environment}`)
    if (dryRun) {
      for (const step of plan) {
        const actions = [
          step.create && "create the miniapp",
          step.issueKey && `issue its key into ${step.secret}`,
        ].filter(Boolean)
        console.log(`  ${step.packageName}: ${actions.length ? `would ${actions.join(" and ")}` : "ready"}`)
      }
      if (store.switch) console.log(`  would set ${store.switch} once every key is stored`)
      if (options.publish) console.log(`  would run ${PUBLISH_WORKFLOW} on ${branch}`)
      continue
    }

    ensureEnvironment(repository, store.environment, branch)
    const keyName = `${repository.split("/")[1]} CI publishing to the ${storeName} Store`
    for (const step of plan) {
      if (step.create) {
        await json(
          await client("POST", "/api/console/apps", {
            workspaceId,
            body: {packageName: step.packageName, displayName: step.name, description: step.description},
          }),
          `creating ${step.packageName}`,
        )
      }
      let replaced = []
      if (step.issueKey) {
        const previous = await publishingKeyIds(client, workspaceId, step.packageName, keyName)
        const key = await issuePublishingKey(client, step.packageName, keyName)
        gh(["secret", "set", step.secret, "--env", store.environment, "--repo", repository], {input: key.value})
        // Only a key this script issued under the same name is replaced, and only once its successor is stored.
        replaced = previous.filter((id) => id !== key.id)
        for (const id of replaced) await revokePublishingKey(client, workspaceId, id)
      }
      const done = [
        step.create && "created",
        step.issueKey && `key stored in ${step.secret}`,
        replaced.length && `${replaced.length} replaced key(s) revoked`,
      ].filter(Boolean)
      console.log(`  ${step.packageName}: ${done.length ? done.join(", ") : "already set up"}`)
    }
    if (store.switch && switchOn(repository, store.switch)) console.log(`  Publishing on: ${store.switch}=true.`)
    if (options.publish) {
      gh(["workflow", "run", PUBLISH_WORKFLOW, "--ref", branch, "--repo", repository])
      console.log(`  Started ${PUBLISH_WORKFLOW} on ${branch}.`)
    }
  }
  console.log("Done. Each repository's publish workflow publishes to this Store from the branch shown.")
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`setup-store-publishing: ${error.message}`)
    process.exit(1)
  })
}
