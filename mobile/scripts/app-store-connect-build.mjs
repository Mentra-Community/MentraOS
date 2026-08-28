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

export function createAppStoreConnectClient({
  issuerId,
  keyId,
  privateKey,
  fetchImpl = fetch,
  attempts = 3,
  delay = 2_000,
  sleep = (duration) => new Promise((resolve) => setTimeout(resolve, duration)),
}) {
  async function request(resource, options = {}) {
    let lastError
    const method = (options.method || "GET").toUpperCase()
    const canRetry = method === "GET" || method === "HEAD"
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const response = await fetchImpl(new URL(resource, API_ROOT), {
          ...options,
          headers: {
            "Authorization": `Bearer ${createAppStoreConnectToken({issuerId, keyId, privateKey})}`,
            "Content-Type": "application/json",
            ...options.headers,
          },
        })
        const body = await response.text()
        if (!response.ok) {
          const error = new Error(
            `App Store Connect ${options.method || "GET"} ${resource} failed with HTTP ${response.status}: ${body}`,
          )
          error.status = response.status
          throw error
        }
        return body ? JSON.parse(body) : null
      } catch (error) {
        lastError = error
        if (!canRetry || !isTransientAppStoreConnectError(error) || attempt === attempts) throw error
        console.warn(
          `App Store Connect temporarily failed ${method} ${resource} (${transientAppStoreConnectErrorLabel(error)}); retrying`,
        )
        await sleep(delay)
      }
    }
    throw lastError
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

function buildUploadDisposition(upload, buildNumber) {
  if (!upload) return "absent"
  const state = buildUploadState(upload)
  if (state === "AWAITING_UPLOAD") return "awaiting"
  if (state === "PROCESSING" || state === "COMPLETE") return "accepted"
  if (state === "FAILED") {
    const details = buildUploadDetails(upload)
    throw new Error(`App Store Connect build upload ${buildNumber} failed${details ? `: ${details}` : ""}`)
  }
  throw new Error(`App Store Connect build upload ${buildNumber} has unknown state ${state || "<missing>"}`)
}

const TRANSIENT_NETWORK_ERROR_CODES = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
])

function isTransientAppStoreConnectError(error) {
  return (
    error?.status === 429 ||
    (error?.status >= 500 && error.status <= 599) ||
    (error instanceof TypeError && (error.message === "fetch failed" || error.message === "terminated")) ||
    TRANSIENT_NETWORK_ERROR_CODES.has(error?.code) ||
    TRANSIENT_NETWORK_ERROR_CODES.has(error?.cause?.code)
  )
}

function transientAppStoreConnectErrorLabel(error) {
  if (error?.status) return `HTTP ${error.status}`
  return error?.cause?.code || error?.message || "network failure"
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
    try {
      const build = await findProcessedBuild(client, {appId, buildNumber, marketingVersion})
      if (build) return build
      const upload = await findBuildUpload(client, {appId, buildNumber, marketingVersion})
      buildUploadDisposition(upload, buildNumber)
      const state = buildUploadState(upload)
      if (state && state !== lastUploadState) console.log(`App Store Connect build upload ${buildNumber} is ${state}`)
      lastUploadState = state || lastUploadState
    } catch (error) {
      if (!isTransientAppStoreConnectError(error) || attempt === attempts) throw error
      console.warn(
        `App Store Connect temporarily failed while checking build ${buildNumber} (${transientAppStoreConnectErrorLabel(error)}); retrying`,
      )
    }
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
    if (buildUploadDisposition(existingUpload, buildNumber) === "accepted") {
      return {build: null, upload: existingUpload, reused: true}
    }
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
  if (buildUploadDisposition(existingUpload, buildNumber) === "accepted") {
    return {build: null, upload: existingUpload, reused: true}
  }
  throw lastError
}

export async function findBetaGroup(client, {appId, groupName}) {
  return exactlyOne(
    await client.request(query("/v1/betaGroups", {"filter[app]": appId, "filter[name]": groupName, "limit": "2"})),
    `TestFlight group ${groupName}`,
  )
}

export async function ensurePublicBetaGroup(client, {appId, groupName}) {
  const response = await client.request(
    query("/v1/betaGroups", {"filter[app]": appId, "filter[name]": groupName, "limit": "2"}),
  )
  if (!Array.isArray(response?.data)) throw new Error("TestFlight group response has no data array")
  if (response.data.length > 1) throw new Error(`Expected at most one TestFlight group ${groupName}`)
  let group = response.data[0]
  if (!group) {
    const created = await client.request("/v1/betaGroups", {
      method: "POST",
      body: JSON.stringify({
        data: {
          type: "betaGroups",
          attributes: {
            name: groupName,
            isInternalGroup: false,
            publicLinkEnabled: true,
            publicLinkLimitEnabled: false,
          },
          relationships: {app: {data: {type: "apps", id: appId}}},
        },
      }),
    })
    group = created?.data
  }
  if (!group?.id) throw new Error(`App Store Connect returned no TestFlight group ${groupName}`)
  if (group.attributes?.isInternalGroup !== false) {
    throw new Error(`TestFlight group ${groupName} must be external`)
  }
  if (group.attributes?.publicLinkEnabled !== true) {
    await client.request(`/v1/betaGroups/${group.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        data: {type: "betaGroups", id: group.id, attributes: {publicLinkEnabled: true}},
      }),
    })
    group = (await client.request(`/v1/betaGroups/${group.id}`))?.data
  } else if (!group.attributes?.publicLink) {
    group = (await client.request(`/v1/betaGroups/${group.id}`))?.data
  }
  if (!/^https:\/\/testflight\.apple\.com\/join\/[A-Za-z0-9]+$/.test(group?.attributes?.publicLink || "")) {
    throw new Error(`TestFlight group ${groupName} has no public invitation link`)
  }
  return group
}

export async function externalBetaReviewReadiness(client, {appId}) {
  const [reviewDetail, localizations] = await Promise.all([
    client.request(`/v1/apps/${appId}/betaAppReviewDetail`),
    client.request(`/v1/apps/${appId}/betaAppLocalizations?limit=200`),
  ])
  const attributes = reviewDetail?.data?.attributes || {}
  const missing = ["contactFirstName", "contactLastName", "contactPhone", "contactEmail"].filter(
    (name) => typeof attributes[name] !== "string" || attributes[name].trim().length === 0,
  )
  if (typeof attributes.demoAccountRequired !== "boolean") missing.push("demoAccountRequired")
  if (!Array.isArray(localizations?.data) || localizations.data.length === 0) {
    missing.push("betaAppLocalizations")
  } else {
    for (const localization of localizations.data) {
      if (typeof localization.attributes?.description !== "string" || !localization.attributes.description.trim()) {
        missing.push(`betaAppLocalizations.${localization.attributes?.locale || localization.id}.description`)
      }
      if (typeof localization.attributes?.feedbackEmail !== "string" || !localization.attributes.feedbackEmail.trim()) {
        missing.push(`betaAppLocalizations.${localization.attributes?.locale || localization.id}.feedbackEmail`)
      }
    }
  }
  return {ready: missing.length === 0, missing}
}

export async function findBlockingExternalBetaReview(client, {appId}) {
  const response = await client.request(
    query("/v1/builds", {
      "filter[app]": appId,
      "include": "betaAppReviewSubmission",
      "sort": "-uploadedDate",
      "limit": "200",
    }),
  )
  if (!Array.isArray(response?.data)) throw new Error("App Store Connect builds response has no data array")
  const submissions = new Map(
    (response.included || []).filter((item) => item.type === "betaAppReviewSubmissions").map((item) => [item.id, item]),
  )
  const reviewedBuilds = response.data.flatMap((build) => {
    const submissionId = build.relationships?.betaAppReviewSubmission?.data?.id
    const submission = submissions.get(submissionId)
    return submission ? [{build, submission}] : []
  })
  const pending = reviewedBuilds.find(({submission}) =>
    ["WAITING_FOR_REVIEW", "IN_REVIEW"].includes(submission.attributes?.betaReviewState),
  )
  if (pending) return pending
  const latest = reviewedBuilds[0]
  return latest?.submission.attributes?.betaReviewState === "REJECTED" ? latest : null
}

export async function prepareTestflightDistribution(
  client,
  {appId, groupName, audience, internalInstallUrl, allowRejectedOverride = false},
) {
  if (!["internal", "external"].includes(audience)) throw new Error(`Unknown TestFlight audience ${audience}`)
  if (audience === "internal") {
    const group = await findBetaGroup(client, {appId, groupName})
    if (group.attributes?.isInternalGroup !== true) throw new Error(`TestFlight group ${groupName} must be internal`)
    const installUrl = internalInstallUrl?.replace("{groupId}", group.id)
    if (!/^https:\/\//.test(installUrl || "")) throw new Error("Internal TestFlight URL must use HTTPS")
    return {audience, group, installUrl, skip: false}
  }

  const group = await ensurePublicBetaGroup(client, {appId, groupName})
  let readiness
  try {
    readiness = await externalBetaReviewReadiness(client, {appId})
  } catch (error) {
    if (error?.status !== 404) throw error
    readiness = {ready: false, missing: ["betaAppReviewDetail"]}
  }
  if (!readiness.ready) {
    return {
      audience,
      group,
      installUrl: group.attributes.publicLink,
      skip: true,
      skipReason: "external_review_setup_required",
      skipDetail: readiness.missing.join(","),
    }
  }
  const blocked = await findBlockingExternalBetaReview(client, {appId})
  if (!blocked) return {audience, group, installUrl: group.attributes.publicLink, skip: false}
  const reviewState = blocked.submission.attributes.betaReviewState
  if (reviewState === "REJECTED" && allowRejectedOverride) {
    return {audience, group, installUrl: group.attributes.publicLink, skip: false, overriddenReviewState: reviewState}
  }
  return {
    audience,
    group,
    installUrl: group.attributes.publicLink,
    skip: true,
    skipReason: `external_review_${reviewState.toLowerCase()}`,
    skipDetail: blocked.build.id,
    reviewState,
    reviewBuildId: blocked.build.id,
  }
}

export async function updateBetaAppReviewNotes(client, {appId, notes}) {
  const detail = await client.request(`/v1/apps/${appId}/betaAppReviewDetail`)
  const id = detail?.data?.id
  if (!id) throw new Error(`App Store Connect returned no beta app review detail for ${appId}`)
  const current = detail.data.attributes?.notes || ""
  if (current === notes) return {detail: detail.data, reused: true}
  const updated = await client.request(`/v1/betaAppReviewDetails/${id}`, {
    method: "PATCH",
    body: JSON.stringify({data: {type: "betaAppReviewDetails", id, attributes: {notes}}}),
  })
  return {detail: updated.data, reused: false}
}

export async function submitBuildForBetaReview(client, {buildId}) {
  const response = await client.request(query("/v1/betaAppReviewSubmissions", {"filter[build]": buildId, "limit": "2"}))
  if (!Array.isArray(response?.data)) throw new Error("Beta app review response has no data array")
  if (response.data.length > 1) throw new Error(`Expected at most one beta app review submission for ${buildId}`)
  const existing = response.data[0]
  if (existing) return {submission: existing, reused: true}
  const created = await client.request("/v1/betaAppReviewSubmissions", {
    method: "POST",
    body: JSON.stringify({
      data: {
        type: "betaAppReviewSubmissions",
        relationships: {build: {data: {type: "builds", id: buildId}}},
      },
    }),
  })
  if (!created?.data?.id) throw new Error(`App Store Connect returned no beta app review submission for ${buildId}`)
  return {submission: created.data, reused: false}
}

export async function promoteApprovedBuildToPublicGroup(client, {appId, buildId, groupName}) {
  const response = await client.request(query("/v1/betaAppReviewSubmissions", {"filter[build]": buildId, "limit": "2"}))
  const submission = exactlyOne(response, `beta app review submission for ${buildId}`)
  if (submission.attributes?.betaReviewState !== "APPROVED") {
    throw new Error(
      `TestFlight build ${buildId} is not approved for external testing (${submission.attributes?.betaReviewState || "unknown"})`,
    )
  }
  const group = await ensurePublicBetaGroup(client, {appId, groupName})
  const assignment = await assignBuildToGroup(client, {
    appId,
    buildId,
    groupName,
    expectedInternal: false,
  })
  return {group, submission, reused: assignment.reused}
}

export async function assignBuildToGroup(client, {appId, buildId, groupName, expectedInternal}) {
  const group = await findBetaGroup(client, {appId, groupName})
  if (group.attributes?.isInternalGroup !== expectedInternal) {
    throw new Error(`TestFlight group ${groupName} has the wrong audience`)
  }
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
    const uploadDisposition = buildUploadDisposition(upload, args["build-number"])
    const exists = Boolean(build) || uploadDisposition === "accepted"
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
  if (command === "wait") {
    const build = await waitForProcessedBuild(client, {
      appId: app.id,
      buildNumber: args["build-number"],
      marketingVersion: args["marketing-version"],
    })
    if (process.env.GITHUB_OUTPUT) {
      const {appendFileSync} = await import("node:fs")
      appendFileSync(
        process.env.GITHUB_OUTPUT,
        `app_id=${app.id}\nbuild_id=${build.id}\nprocessing_state=${build.attributes?.processingState || ""}\n`,
      )
    }
    console.log(`App Store Connect build ${args["build-number"]} finished processing`)
    return
  }
  if (command === "assign") {
    const build = await waitForProcessedBuild(client, {
      appId: app.id,
      buildNumber: args["build-number"],
      marketingVersion: args["marketing-version"],
    })
    if (args["build-id"] && build.id !== args["build-id"]) {
      throw new Error(`App Store Connect build ID ${build.id} does not match expected build ${args["build-id"]}`)
    }
    if (args["whats-new"]) {
      await setBetaBuildWhatsNew(client, {buildId: build.id, whatsNew: args["whats-new"]})
    }
    const audience = args.audience || "internal"
    if (!["internal", "external"].includes(audience)) throw new Error(`Unknown TestFlight audience ${audience}`)
    let installUrl = args["install-url"]
    if (audience === "external") {
      const readiness = await prepareTestflightDistribution(client, {
        appId: app.id,
        groupName: args["group-name"],
        audience,
        allowRejectedOverride: args["allow-rejected-override"] === "true",
      })
      if (readiness.skip) {
        throw new Error(
          `TestFlight submission is blocked by ${readiness.skipReason}${
            readiness.skipDetail ? ` (${readiness.skipDetail})` : ""
          }`,
        )
      }
      installUrl = readiness.installUrl
      if (args["review-notes"]) await updateBetaAppReviewNotes(client, {appId: app.id, notes: args["review-notes"]})
    }
    const result = await assignBuildToGroup(client, {
      appId: app.id,
      buildId: build.id,
      groupName: args["group-name"],
      expectedInternal: audience === "internal",
    })
    const review = audience === "external" ? await submitBuildForBetaReview(client, {buildId: build.id}) : null
    const reviewState = review?.submission.attributes?.betaReviewState || ""
    const distributionStatus = audience === "internal" || reviewState === "APPROVED" ? "available" : "submitted"
    if (!/^https:\/\//.test(installUrl || "")) throw new Error("TestFlight install URL must use HTTPS")
    if (process.env.GITHUB_OUTPUT) {
      const {appendFileSync} = await import("node:fs")
      appendFileSync(
        process.env.GITHUB_OUTPUT,
        `app_id=${app.id}\nbuild_id=${build.id}\nprocessing_state=${build.attributes?.processingState || ""}\ngroup_id=${result.group.id}\ngroup_name=${result.group.attributes?.name || args["group-name"]}\nreused=${result.reused}\naudience=${audience}\ndistribution_status=${distributionStatus}\nreview_state=${reviewState}\ninstall_url=${installUrl}\n`,
      )
    }
    console.log(
      `${result.reused ? "Verified" : "Added"} build ${args["build-number"]} in TestFlight group ${result.group.attributes?.name || args["group-name"]}`,
    )
    return
  }
  if (command === "testflight-preflight") {
    const result = await prepareTestflightDistribution(client, {
      appId: app.id,
      groupName: args["group-name"],
      audience: args.audience,
      internalInstallUrl: args["install-url"],
      allowRejectedOverride: args["allow-rejected-override"] === "true",
    })
    if (process.env.GITHUB_OUTPUT) {
      const {appendFileSync} = await import("node:fs")
      appendFileSync(
        process.env.GITHUB_OUTPUT,
        `skip=${result.skip}\nskip_reason=${result.skipReason || ""}\nskip_detail=${result.skipDetail || ""}\ngroup_id=${result.group.id}\ngroup_name=${result.group.attributes?.name || args["group-name"]}\naudience=${result.audience}\ninstall_url=${result.installUrl}\nreview_state=${result.reviewState || ""}\nreview_build_id=${result.reviewBuildId || ""}\n`,
      )
    }
    console.log(
      result.skip
        ? `Skipped TestFlight publication: ${result.skipReason}${result.skipDetail ? ` (${result.skipDetail})` : ""}`
        : `TestFlight ${result.audience} distribution is ready in ${result.group.attributes?.name || args["group-name"]}`,
    )
    return
  }
  if (command === "promote-approved") {
    const build = await waitForProcessedBuild(client, {
      appId: app.id,
      buildNumber: args["build-number"],
      marketingVersion: args["marketing-version"],
    })
    if (args["build-id"] && build.id !== args["build-id"]) {
      throw new Error(`App Store Connect build ID ${build.id} does not match selected beta build ${args["build-id"]}`)
    }
    const result = await promoteApprovedBuildToPublicGroup(client, {
      appId: app.id,
      buildId: build.id,
      groupName: args["group-name"],
    })
    const installUrl = result.group.attributes.publicLink
    if (process.env.GITHUB_OUTPUT) {
      const {appendFileSync} = await import("node:fs")
      appendFileSync(
        process.env.GITHUB_OUTPUT,
        `app_id=${app.id}\nbuild_id=${build.id}\nprocessing_state=${build.attributes?.processingState || ""}\ngroup_id=${result.group.id}\ngroup_name=${result.group.attributes?.name || args["group-name"]}\naudience=external\ndistribution_status=available\nreview_state=APPROVED\ninstall_url=${installUrl}\nreused=${result.reused}\n`,
      )
    }
    console.log(
      `${result.reused ? "Verified" : "Added"} approved build ${args["build-number"]} in public TestFlight group ${result.group.attributes?.name || args["group-name"]}`,
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
