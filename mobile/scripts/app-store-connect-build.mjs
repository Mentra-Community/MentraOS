#!/usr/bin/env node
import {readFileSync} from "node:fs"
import {createPrivateKey, sign} from "node:crypto"
import {spawnSync} from "node:child_process"
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

export async function findApp(client, bundleId, appId) {
  if (appId) {
    const response = await client.request(`/v1/apps/${encodeURIComponent(appId)}`)
    const app = response?.data
    if (!app || Array.isArray(app)) throw new Error(`App Store Connect returned no app ${appId}`)
    const actualBundleId = app.attributes?.bundleId
    if (actualBundleId !== bundleId) {
      throw new Error(
        `App Store Connect app ${appId} has bundle ID ${actualBundleId || "<missing>"}, expected ${bundleId}`,
      )
    }
    return app
  }
  return exactlyOne(
    await client.request(query("/v1/apps", {"filter[bundleId]": bundleId, "limit": "2"})),
    `app ${bundleId}`,
  )
}

export async function findBuild(client, {appId, buildNumber, marketingVersion}) {
  const filters = {"filter[app]": appId, "filter[version]": String(buildNumber), "limit": "2"}
  if (marketingVersion) filters["filter[preReleaseVersion.version]"] = marketingVersion
  const response = await client.request(query("/v1/builds", filters))
  if (!Array.isArray(response?.data) || response.data.length === 0) return null
  return exactlyOne(response, `build ${buildNumber}`)
}

export async function findBuildUpload(client, {appId, buildNumber, marketingVersion}) {
  const filters = {"filter[cfBundleVersion]": String(buildNumber), "sort": "-uploadedDate", "limit": "2"}
  if (marketingVersion) filters["filter[cfBundleShortVersionString]"] = marketingVersion
  const response = await client.request(query(`/v1/apps/${encodeURIComponent(appId)}/buildUploads`, filters))
  if (!Array.isArray(response?.data) || response.data.length === 0) return null
  return response.data[0]
}

function buildUploadState(upload) {
  return upload?.attributes?.state?.state || null
}

function buildUploadDetails(upload) {
  const state = upload?.attributes?.state
  return [...(state?.errors || []), ...(state?.warnings || []), ...(state?.infos || [])]
    .map((detail) => [detail.code, detail.description].filter(Boolean).join(": "))
    .filter(Boolean)
    .join("; ")
}

function assertBuildUploadDidNotFail(upload, buildNumber) {
  if (buildUploadState(upload) !== "FAILED") return
  const details = buildUploadDetails(upload)
  throw new Error(`App Store Connect build upload ${buildNumber} failed${details ? `: ${details}` : ""}`)
}

export async function findProcessedBuild(client, {appId, buildNumber, marketingVersion}) {
  const build = await findBuild(client, {appId, buildNumber, marketingVersion})
  if (!build) return null
  const state = build.attributes?.processingState
  if (state === "FAILED" || state === "INVALID") throw new Error(`App Store Connect build ${buildNumber} is ${state}`)
  return state === "VALID" ? build : null
}

export async function waitForProcessedBuild(
  client,
  {appId, buildNumber, marketingVersion, attempts = 360, delay = 10_000},
) {
  let lastUploadState = null
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const build = await findProcessedBuild(client, {appId, buildNumber, marketingVersion})
    if (build) return build
    const upload = await findBuildUpload(client, {appId, buildNumber, marketingVersion})
    assertBuildUploadDidNotFail(upload, buildNumber)
    const state = buildUploadState(upload)
    if (state && state !== lastUploadState) console.log(`App Store Connect build upload ${buildNumber} is ${state}`)
    lastUploadState = state || lastUploadState
    if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, delay))
  }
  throw new Error(
    `App Store Connect build ${buildNumber} did not finish processing${
      lastUploadState ? `; upload state is ${lastUploadState}` : ""
    }`,
  )
}

function uploadWithAltool({ipaPath, issuerId, keyId, keyPath}) {
  const result = spawnSync(
    "xcrun",
    ["altool", "--upload-app", "-f", ipaPath, "-t", "ios", "--apiKey", keyId, "--apiIssuer", issuerId],
    {
      stdio: "inherit",
      env: {...process.env, API_PRIVATE_KEYS_DIR: path.dirname(keyPath)},
    },
  )
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`altool exited with status ${result.status}`)
}

export async function uploadExactBuild(
  client,
  {
    appId,
    buildNumber,
    marketingVersion,
    upload,
    attempts = 3,
    delay = 30_000,
    sleep = (duration) => new Promise((resolve) => setTimeout(resolve, duration)),
  },
) {
  let lastError
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const existing = await findBuild(client, {appId, buildNumber, marketingVersion})
    if (existing) return {build: existing, reused: true}
    const existingUpload = await findBuildUpload(client, {appId, buildNumber, marketingVersion})
    assertBuildUploadDidNotFail(existingUpload, buildNumber)
    if (existingUpload) return {build: null, upload: existingUpload, reused: true}
    try {
      await upload()
      return {build: null, reused: false}
    } catch (error) {
      lastError = error
      if (attempt < attempts) await sleep(delay)
    }
  }
  const existing = await findBuild(client, {appId, buildNumber, marketingVersion})
  if (existing) return {build: existing, reused: true}
  const existingUpload = await findBuildUpload(client, {appId, buildNumber, marketingVersion})
  assertBuildUploadDidNotFail(existingUpload, buildNumber)
  if (existingUpload) return {build: null, upload: existingUpload, reused: true}
  throw lastError
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

export async function setBetaBuildWhatsNew(client, {buildId, locale = "en-US", whatsNew}) {
  const response = await client.request(`/v1/builds/${buildId}/betaBuildLocalizations?limit=200`)
  if (!Array.isArray(response?.data)) throw new Error("TestFlight localization response has no data array")
  const matching = response.data.filter((localization) => localization.attributes?.locale === locale)
  if (matching.length > 1) throw new Error(`Expected at most one TestFlight ${locale} localization`)
  const existing = matching[0]
  if (existing?.attributes?.whatsNew === whatsNew) return {localization: existing, reused: true}
  if (existing) {
    const localization = await client.request(`/v1/betaBuildLocalizations/${existing.id}`, {
      method: "PATCH",
      body: JSON.stringify({data: {type: "betaBuildLocalizations", id: existing.id, attributes: {whatsNew}}}),
    })
    return {localization: localization.data, reused: false}
  }
  const localization = await client.request("/v1/betaBuildLocalizations", {
    method: "POST",
    body: JSON.stringify({
      data: {
        type: "betaBuildLocalizations",
        attributes: {locale, whatsNew},
        relationships: {build: {data: {type: "builds", id: buildId}}},
      },
    }),
  })
  return {localization: localization.data, reused: false}
}

export async function findAppStoreVersion(client, {appId, versionString}) {
  const response = await client.request(
    query("/v1/appStoreVersions", {
      "filter[app]": appId,
      "filter[platform]": "IOS",
      "filter[versionString]": versionString,
      "limit": "2",
    }),
  )
  if (!Array.isArray(response?.data) || response.data.length === 0) return null
  return exactlyOne(response, `iOS App Store version ${versionString}`)
}

const SUBMITTED_APP_STORE_STATES = new Set([
  "WAITING_FOR_REVIEW",
  "IN_REVIEW",
  "PENDING_DEVELOPER_RELEASE",
  "PROCESSING_FOR_APP_STORE",
  "PROCESSING_FOR_DISTRIBUTION",
  "PENDING_APPLE_RELEASE",
  "READY_FOR_DISTRIBUTION",
  "READY_FOR_SALE",
])

export async function productionSubmissionStatus(client, {appId, versionString, buildId}) {
  const version = await findAppStoreVersion(client, {appId, versionString})
  if (!version) return {version: null, state: "ABSENT", attachedBuildId: null, promoted: false}
  const relationship = await client.request(`/v1/appStoreVersions/${version.id}/relationships/build`)
  const attachedBuildId = relationship?.data?.id || null
  if (attachedBuildId && attachedBuildId !== buildId) {
    throw new Error(`App Store version ${versionString} is attached to unexpected build ${attachedBuildId}`)
  }
  const state = version.attributes?.appStoreState || version.attributes?.appVersionState
  if (!state) throw new Error(`App Store version ${versionString} has no state`)
  if (SUBMITTED_APP_STORE_STATES.has(state) && attachedBuildId !== buildId) {
    throw new Error(`Submitted App Store version ${versionString} is not attached to build ${buildId}`)
  }
  return {version, state, attachedBuildId, promoted: SUBMITTED_APP_STORE_STATES.has(state)}
}

export async function waitForProductionSubmission(
  client,
  {appId, versionString, buildId, attempts = 30, delay = 10_000},
) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const status = await productionSubmissionStatus(client, {appId, versionString, buildId})
    if (status.promoted) return status
    if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, delay))
  }
  throw new Error(`App Store version ${versionString} did not enter the review or release flow`)
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
  const app = await findApp(client, args["bundle-id"], args["app-id"])
  if (command === "lookup") {
    const build = await findBuild(client, {
      appId: app.id,
      buildNumber: args["build-number"],
      marketingVersion: args["marketing-version"],
    })
    const upload = build
      ? null
      : await findBuildUpload(client, {
          appId: app.id,
          buildNumber: args["build-number"],
          marketingVersion: args["marketing-version"],
        })
    assertBuildUploadDidNotFail(upload, args["build-number"])
    const exists = Boolean(build || upload)
    const uploadState = buildUploadState(upload)
    if (process.env.GITHUB_OUTPUT) {
      const {appendFileSync} = await import("node:fs")
      appendFileSync(
        process.env.GITHUB_OUTPUT,
        `exists=${exists}\nprocessed=${build?.attributes?.processingState === "VALID"}\napp_id=${app.id}\nbuild_id=${
          build?.id || ""
        }\nupload_id=${upload?.id || ""}\nupload_state=${uploadState || ""}\n`,
      )
    }
    console.log(
      build
        ? `Found App Store Connect build ${args["build-number"]}`
        : upload
        ? `Found App Store Connect build upload ${args["build-number"]} in ${uploadState}`
        : "Build and build upload are absent",
    )
    return
  }
  if (command === "upload") {
    const keyPath = path.resolve(args["key-path"])
    const result = await uploadExactBuild(client, {
      appId: app.id,
      buildNumber: args["build-number"],
      marketingVersion: args["marketing-version"],
      upload: () =>
        uploadWithAltool({
          ipaPath: path.resolve(args.ipa),
          issuerId: args["issuer-id"],
          keyId: args["key-id"],
          keyPath,
        }),
    })
    console.log(
      result.reused
        ? `Verified App Store Connect already has build or upload ${args["build-number"]}`
        : `Uploaded App Store Connect build ${args["build-number"]}`,
    )
    return
  }
  if (command === "assign") {
    const build = await waitForProcessedBuild(client, {
      appId: app.id,
      buildNumber: args["build-number"],
      marketingVersion: args["marketing-version"],
    })
    if (args["whats-new"]) {
      await setBetaBuildWhatsNew(client, {buildId: build.id, whatsNew: args["whats-new"]})
    }
    const result = await assignBuildToGroup(client, {appId: app.id, buildId: build.id, groupName: args["group-name"]})
    if (process.env.GITHUB_OUTPUT) {
      const {appendFileSync} = await import("node:fs")
      appendFileSync(
        process.env.GITHUB_OUTPUT,
        `app_id=${app.id}\nbuild_id=${build.id}\nprocessing_state=${build.attributes?.processingState || ""}\ngroup_id=${result.group.id}\ngroup_name=${result.group.attributes?.name || args["group-name"]}\nreused=${result.reused}\n`,
      )
    }
    console.log(
      `${result.reused ? "Verified" : "Added"} build ${args["build-number"]} in TestFlight group ${result.group.attributes?.name || args["group-name"]}`,
    )
    return
  }
  if (command === "production-status" || command === "wait-production") {
    const build = await waitForProcessedBuild(client, {appId: app.id, buildNumber: args["build-number"]})
    const options = {appId: app.id, versionString: args["app-version"], buildId: build.id}
    const status =
      command === "wait-production"
        ? await waitForProductionSubmission(client, options)
        : await productionSubmissionStatus(client, options)
    if (process.env.GITHUB_OUTPUT) {
      const {appendFileSync} = await import("node:fs")
      appendFileSync(
        process.env.GITHUB_OUTPUT,
        `promoted=${status.promoted}\nstate=${status.state}\nversion_id=${status.version?.id || ""}\nbuild_id=${build.id}\n`,
      )
    }
    console.log(`App Store version ${args["app-version"]} is ${status.state} with build ${args["build-number"]}`)
    return
  }
  throw new Error(`Unknown command ${JSON.stringify(command)}`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
