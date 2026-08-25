#!/usr/bin/env node
import {readFileSync} from "node:fs"
import {createPrivateKey, sign} from "node:crypto"
import path from "node:path"
import {fileURLToPath} from "node:url"

const API_ROOT = "https://api.appstoreconnect.apple.com"

function base64url(value) {
  return Buffer.from(value).toString("base64url")
}

export function createAppStoreConnectToken({issuerId, keyId, privateKey, now = Date.now()}) {
  const issuedAt = Math.floor(now / 1000)
  const header = base64url(JSON.stringify({alg: "ES256", kid: keyId, typ: "JWT"}))
  const payload = base64url(
    JSON.stringify({iss: issuerId, iat: issuedAt, exp: issuedAt + 19 * 60, aud: "appstoreconnect-v1"}),
  )
  const input = `${header}.${payload}`
  const signature = sign("sha256", Buffer.from(input), {
    key: createPrivateKey(privateKey),
    dsaEncoding: "ieee-p1363",
  }).toString("base64url")
  return `${input}.${signature}`
}

export function createAppStoreConnectClient({issuerId, keyId, privateKey, fetchImpl = fetch}) {
  async function request(resource, options = {}) {
    const response = await fetchImpl(new URL(resource, API_ROOT), {
      ...options,
      headers: {
        "Authorization": `Bearer ${createAppStoreConnectToken({issuerId, keyId, privateKey})}`,
        "Content-Type": "application/json",
        ...options.headers,
      },
    })
    const body = await response.text()
    if (!response.ok)
      throw new Error(
        `App Store Connect ${options.method || "GET"} ${resource} failed with HTTP ${response.status}: ${body}`,
      )
    return body ? JSON.parse(body) : null
  }
  return {request}
}

function query(pathname, parameters) {
  const url = new URL(pathname, API_ROOT)
  for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, value)
  return `${url.pathname}${url.search}`
}

function exactlyOne(response, label) {
  if (!Array.isArray(response?.data) || response.data.length !== 1) {
    throw new Error(`Expected exactly one ${label}, found ${response?.data?.length ?? 0}`)
  }
  return response.data[0]
}

export async function collectPaginatedData(client, resource) {
  const data = []
  const visited = new Set()
  let next = resource
  while (next) {
    if (visited.has(next)) throw new Error(`App Store Connect pagination loop at ${next}`)
    visited.add(next)
    const response = await client.request(next)
    if (!Array.isArray(response?.data)) throw new Error(`App Store Connect page ${next} has no data array`)
    data.push(...response.data)
    next = response.links?.next || null
  }
  return data
}

export async function findApp(client, bundleId) {
  return exactlyOne(
    await client.request(query("/v1/apps", {"filter[bundleId]": bundleId, "limit": "2"})),
    `app ${bundleId}`,
  )
}

export async function findBuild(client, {appId, buildNumber}) {
  const response = await client.request(
    query("/v1/builds", {"filter[app]": appId, "filter[version]": String(buildNumber), "limit": "2"}),
  )
  if (!Array.isArray(response?.data) || response.data.length === 0) return null
  return exactlyOne(response, `build ${buildNumber}`)
}

export async function findProcessedBuild(client, {appId, buildNumber}) {
  const build = await findBuild(client, {appId, buildNumber})
  if (!build) return null
  const state = build.attributes?.processingState
  if (state === "FAILED" || state === "INVALID") throw new Error(`App Store Connect build ${buildNumber} is ${state}`)
  return state === "VALID" ? build : null
}

export async function waitForProcessedBuild(client, {appId, buildNumber, attempts = 120, delay = 10_000}) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const build = await findProcessedBuild(client, {appId, buildNumber})
    if (build) return build
    if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, delay))
  }
  throw new Error(`App Store Connect build ${buildNumber} did not finish processing`)
}

export async function assignBuildToGroup(client, {appId, buildId, groupName}) {
  const group = exactlyOne(
    await client.request(query("/v1/betaGroups", {"filter[app]": appId, "filter[name]": groupName, "limit": "2"})),
    `TestFlight group ${groupName}`,
  )
  const relationship = `/v1/betaGroups/${group.id}/relationships/builds`
  const existing = await collectPaginatedData(client, query(relationship, {limit: "200"}))
  if (existing.some((build) => build.id === buildId)) return {group, reused: true}
  await client.request(relationship, {
    method: "POST",
    body: JSON.stringify({data: [{type: "builds", id: buildId}]}),
  })
  const confirmed = await collectPaginatedData(client, query(relationship, {limit: "200"}))
  if (!confirmed.some((build) => build.id === buildId)) {
    throw new Error(`App Store Connect did not retain build ${buildId} in TestFlight group ${groupName}`)
  }
  return {group, reused: false}
}

function parseArgs(args) {
  const values = {}
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index]
    const value = args[index + 1]
    if (!option?.startsWith("--") || value === undefined) throw new Error("Expected --name value pairs")
    values[option.slice(2)] = value
  }
  return values
}

async function main() {
  const command = process.argv[2]
  const args = parseArgs(process.argv.slice(3))
  const client = createAppStoreConnectClient({
    issuerId: args["issuer-id"],
    keyId: args["key-id"],
    privateKey: readFileSync(path.resolve(args["key-path"]), "utf8"),
  })
  const app = await findApp(client, args["bundle-id"])
  if (command === "lookup") {
    const build = await findBuild(client, {appId: app.id, buildNumber: args["build-number"]})
    if (process.env.GITHUB_OUTPUT) {
      const {appendFileSync} = await import("node:fs")
      appendFileSync(
        process.env.GITHUB_OUTPUT,
        `exists=${Boolean(build)}\nprocessed=${build?.attributes?.processingState === "VALID"}\nbuild_id=${build?.id || ""}\n`,
      )
    }
    console.log(build ? `Found App Store Connect build ${args["build-number"]}` : "Build is absent")
    return
  }
  if (command === "assign") {
    const build = await waitForProcessedBuild(client, {appId: app.id, buildNumber: args["build-number"]})
    const result = await assignBuildToGroup(client, {appId: app.id, buildId: build.id, groupName: args["group-name"]})
    console.log(
      `${result.reused ? "Verified" : "Added"} build ${args["build-number"]} in TestFlight group ${result.group.attributes?.name || args["group-name"]}`,
    )
    return
  }
  throw new Error(`Unknown command ${JSON.stringify(command)}`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
