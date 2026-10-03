import {writeFile} from "node:fs/promises"
import {isDeepStrictEqual} from "node:util"
import {publishedCoordinatedBuild} from "./coordinated-routine-request.mjs"

export const ROUTINE_BLOCK = "mentra-release-routines"
export const REPOSITORY = "Mentra-Community/MentraOS"
export const sha = value => /^[a-f0-9]{40}$/.test(value ?? "")
export const hash = value => /^[a-f0-9]{64}$/.test(value ?? "")
export const positive = value => Number.isSafeInteger(value) && value > 0
export const requireThat = (condition, message) => {if (!condition) throw new Error(message)}
export const receiptName = (runId, attempt) => `release-slack-message-${runId}-${attempt}`
const id = value => /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,239}$/.test(value ?? "")
const routineId = value => /^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$/.test(value ?? "")
const platforms = ["ios-on-mac", "android"]
const statuses = ["passed", "failed", "setup-failed", "teardown-failed", "not-run", "cancelled", "unknown", "upload-incomplete"]
const escape = value => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
const displayTitle = title => escape(title.length > 240 ? `${title.slice(0, 239)}…` : title).replace(/[\r\n]/g, " ")

export function slackDestination(env) {
  const channel = env.BRANCH === "dev" ? env.SLACK_DEV_BUILDS_CHANNEL_ID
    : env.BRANCH === "staging" ? env.SLACK_STAGING_BUILDS_CHANNEL_ID : undefined
  return env.SLACK_BUILDS_BOT_TOKEN && /^C[A-Z0-9]+$/.test(channel ?? "") ? channel : null
}
export async function slackCall(method, token, body, fetchImpl = fetch) {
  let response, result
  try {
    response = await fetchImpl(`https://slack.com/api/${method}`, {method: "POST", redirect: "error", signal: AbortSignal.timeout(30_000),
      headers: {Authorization: `Bearer ${token}`, "Content-Type": "application/json"}, body: JSON.stringify(body)})
    result = await response.json()
  } catch {throw new Error(`Slack ${method} response unavailable; inspect this notification before retrying`)}
  requireThat(response.ok && result.ok === true, `Slack ${method} rejected the notification`)
  return result
}

/** The retained post binds each published platform independently to its exact release artifact. */
export async function postReleaseMessage(env, payload, {fetchImpl = fetch, select = publishedCoordinatedBuild} = {}) {
  const channel = slackDestination(env)
  requireThat(channel && env.REPOSITORY === REPOSITORY && positive(Number(env.RUN_ID)) && positive(Number(env.RUN_ATTEMPT)) && sha(env.SHA),
    "Invalid release notification identity")
  const artifacts = {}
  if (env.FINALIZE_RESULT === "success") {
    for (const [platform, expected] of [["ios-on-mac", env.MAC_URL], ["android", env.MOBILE_APK_URL ||
      (env.MOBILE_ASSET_BASE_URL && env.APK_NAME ? `${env.MOBILE_ASSET_BASE_URL}/${env.APK_NAME}` : undefined)]]) {
      if (!expected) continue
      try {
        const selected = await select({identity: env.RELEASE_IDENTITY, channel: env.BRANCH, sourceCommit: env.SHA, platform, fetchImpl})
        requireThat(selected.archive.url === expected && hash(selected.archive.sha256), "Release notification refers to another archive")
        artifacts[platform] = selected.archive.sha256
      } catch { /* Preserve the release post; an unverified platform cannot receive test-result updates. */ }
    }
  }
  const build = Object.keys(artifacts).length ? {repository: REPOSITORY, channel: env.BRANCH, runId: Number(env.RUN_ID),
    headSha: env.SHA, release: env.RELEASE_IDENTITY, artifacts} : null
  const messagePayload = build ? payload : {...payload, blocks: payload.blocks.map(block => block.block_id === ROUTINE_BLOCK
    ? {...block, text: {...block.text, text: `${block.text.text}\nThis post has no verified published platform artifact to attach test results to.`}} : block)}
  const result = await slackCall("chat.postMessage", env.SLACK_BUILDS_BOT_TOKEN,
    {channel, text: `Mentra ${env.BRANCH} release ${env.RELEASE_IDENTITY}`, ...messagePayload, unfurl_links: false, unfurl_media: false}, fetchImpl)
  requireThat(result.channel === channel && /^\d+\.\d+$/.test(result.ts ?? "") && /^B[A-Z0-9]+$/.test(result.message?.bot_id ?? ""),
    "Slack did not return the posted message identity")
  return {schemaVersion: 2, kind: "mentra-release-slack-message", build,
    producer: {runId: Number(env.RUN_ID), runAttempt: Number(env.RUN_ATTEMPT), headSha: env.SHA},
    message: {channel, ts: result.ts, botId: result.message.bot_id}, payload: messagePayload, rows: {}}
}
export function assertNotification(value) {
  requireThat(value?.schemaVersion === 2 && value.kind === "mentra-release-slack-message" && value.build?.repository === REPOSITORY &&
    ["dev", "staging"].includes(value.build.channel) && positive(value.build.runId) && sha(value.build.headSha) &&
    /^\d+\.\d+\.\d+-(dev|beta)\.[1-9]\d*$/.test(value.build.release ?? "") &&
    value.build.artifacts && Object.keys(value.build.artifacts).length > 0 &&
    Object.entries(value.build.artifacts).every(([platform, digest]) => platforms.includes(platform) && hash(digest)) &&
    positive(value.producer?.runAttempt) && value.producer?.runId === value.build.runId && value.producer.headSha === value.build.headSha &&
    /^C[A-Z0-9]+$/.test(value.message?.channel ?? "") && /^\d+\.\d+$/.test(value.message?.ts ?? "") && /^B[A-Z0-9]+$/.test(value.message?.botId ?? "") &&
    Array.isArray(value.payload?.blocks) && value.payload.blocks.filter(block => block.block_id === ROUTINE_BLOCK).length === 1 &&
    value.rows && Object.entries(value.rows).every(([key, row]) => key === `${row.routineId}:${row.platform}` && validRow(value, row)),
    "Invalid retained release message")
  return value
}
const generation = row => [Date.parse(row.finishedAt), row.requestId]
const compare = (left, right) => left[0] - right[0] || (left[1] < right[1] ? -1 : left[1] > right[1] ? 1 : 0)
function validRow(notification, row) {
  return routineId(row?.routineId) && platforms.includes(row.platform) && Object.hasOwn(notification.build.artifacts, row.platform) &&
    typeof row.title === "string" && row.title.length > 0 && row.title.length <= 2000 && id(row.requestId) &&
    Number.isFinite(Date.parse(row.finishedAt)) && statuses.includes(row.status) &&
    (!row.resultRunId || id(row.resultRunId)) && row.source?.channel === notification.build.channel &&
    row.source.buildRunId === notification.build.runId && positive(row.source.publicationAttempt)
}
/** Preserve other release blocks verbatim; names and platforms come from the attested Core definition. */
export function applyRoutineResult(notification, row) {
  assertNotification(notification)
  requireThat(validRow(notification, row), "Invalid routine result row")
  const key = `${row.routineId}:${row.platform}`, previous = notification.rows[key]
  if (previous && compare(generation(previous), generation(row)) >= 0) {
    const {status: oldStatus, ...oldIdentity} = previous, {status: newStatus, ...newIdentity} = row
    if (oldStatus !== "upload-incomplete" || newStatus === "upload-incomplete" || !isDeepStrictEqual(oldIdentity, newIdentity)) return notification
  }
  const rows = {...notification.rows, [key]: row}
  const labels = {passed: "Passed", failed: "Failed", "setup-failed": "Setup failed", "teardown-failed": "Teardown failed", "not-run": "Not run", cancelled: "Cancelled", unknown: "Unknown", "upload-incomplete": "Result upload incomplete"}
  const lines = Object.keys(rows).sort().map(key => {
    const current = rows[key], result = current.resultRunId
      ? ` · <https://admin.dev.mentraglass.com/?testRun=${encodeURIComponent(current.resultRunId)}|Recording and result>` : ""
    return `${displayTitle(current.title)} · ${current.platform === "android" ? "Android" : "iOS on Mac"} — *${labels[current.status]}*${result}`
  })
  return {...notification, rows, payload: {...notification.payload, blocks: notification.payload.blocks.map(block => block.block_id === ROUTINE_BLOCK
    ? {...block, text: {type: "mrkdwn", text: `*Device test results*\n${lines.join("\n")}\nLatest completed request per routine and platform; build success is independent of these results.`}} : block)}}
}
export async function updateReleaseMessage(notification, env, fetchImpl = fetch) {
  assertNotification(notification)
  const channel = slackDestination({...env, BRANCH: notification.build.channel})
  requireThat(channel === notification.message.channel, "Configured Slack channel differs from the original release post")
  const auth = await slackCall("auth.test", env.SLACK_BUILDS_BOT_TOKEN, {}, fetchImpl)
  requireThat(auth.bot_id === notification.message.botId, "Configured bot does not own this release post")
  const result = await slackCall("chat.update", env.SLACK_BUILDS_BOT_TOKEN,
    {...notification.payload, channel, ts: notification.message.ts, text: `Mentra ${notification.build.release} device test results`}, fetchImpl)
  requireThat(result.channel === channel && result.ts === notification.message.ts, "Slack updated a different message")
}
if (process.argv[1]?.endsWith("/release-slack-message.mjs")) {
  let body = ""
  for await (const chunk of process.stdin) {body += chunk; requireThat(body.length <= 128 * 1024, "Slack payload too large")}
  await writeFile("slack-release-message.json", JSON.stringify(await postReleaseMessage(process.env, JSON.parse(body))) + "\n", {flag: "wx"})
}
