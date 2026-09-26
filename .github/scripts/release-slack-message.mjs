import {writeFile} from "node:fs/promises"
import {publishedCoordinatedBuild} from "./coordinated-routine-request.mjs"

export const ROUTINE_BLOCK = "mentra-release-routines"
export const REPOSITORY = "Mentra-Community/MentraOS"
export const sha = value => /^[a-f0-9]{40}$/.test(value ?? "")
export const hash = value => /^[a-f0-9]{64}$/.test(value ?? "")
export const positive = value => Number.isSafeInteger(value) && value > 0
export const requireThat = (condition, message) => { if (!condition) throw new Error(message) }
export const receiptName = (runId, attempt) => `release-slack-message-${runId}-${attempt}`
const routineNames = {"no-glasses": "No-glasses UI", "no-glasses-android": "Android no-glasses UI", "day1-ota": "Day-one OTA", "mentra-call": "Mentra Call"}

export function slackDestination(env) {
  const channel = env.BRANCH === "dev" ? env.SLACK_DEV_BUILDS_CHANNEL_ID
    : env.BRANCH === "staging" ? env.SLACK_STAGING_BUILDS_CHANNEL_ID : undefined
  return env.SLACK_BUILDS_BOT_TOKEN && /^C[A-Z0-9]+$/.test(channel ?? "") ? channel : null
}

export async function slackCall(method, token, body, fetchImpl = fetch) {
  // Do not include provider bodies/errors: they can echo tokens or message data.
  let response, result
  try {
    response = await fetchImpl(`https://slack.com/api/${method}`, {method: "POST", redirect: "error",
      signal: AbortSignal.timeout(30_000), headers: {Authorization: `Bearer ${token}`, "Content-Type": "application/json"},
      body: JSON.stringify(body)})
    result = await response.json()
  } catch { throw new Error(`Slack ${method} response unavailable; inspect this notification before retrying`) }
  requireThat(response.ok && result.ok === true, `Slack ${method} rejected the notification`)
  return result
}

/** Future posts are owned by this explicit bot. Webhook fallback stays in the caller. */
export async function postReleaseMessage(env, payload, {fetchImpl = fetch, select = publishedCoordinatedBuild} = {}) {
  const channel = slackDestination(env)
  requireThat(channel && env.REPOSITORY === REPOSITORY && positive(Number(env.RUN_ID)) &&
    positive(Number(env.RUN_ATTEMPT)) && sha(env.SHA), "Invalid release notification identity")
  let build = null
  if (env.FINALIZE_RESULT === "success" && env.MAC_URL) {
    try {
      const selection = await select({identity: env.RELEASE_IDENTITY, channel: env.BRANCH, sourceCommit: env.SHA, fetchImpl})
      requireThat(selection.archive.url === env.MAC_URL, "Release notification refers to another Mac archive")
      build = {repository: REPOSITORY, channel: env.BRANCH, runId: Number(env.RUN_ID), headSha: env.SHA,
        release: env.RELEASE_IDENTITY, archiveSha256: selection.archive.sha256}
    } catch { /* Keep the existing release notification; this post cannot receive device results. */ }
  }
  const messagePayload = build ? payload : {...payload, blocks: payload.blocks.map(block => block.block_id === ROUTINE_BLOCK
    ? {...block, text: {...block.text, text: `${block.text.text}\nTerminal Slack updates unavailable: no verified archive receipt for this post.`}} : block)}
  // No automatic POST retry and no webhook fallback after an attempted bot send.
  const result = await slackCall("chat.postMessage", env.SLACK_BUILDS_BOT_TOKEN,
    {channel, text: `Mentra ${env.BRANCH} release ${env.RELEASE_IDENTITY}`, ...messagePayload, unfurl_links: false, unfurl_media: false}, fetchImpl)
  requireThat(result.channel === channel && /^\d+\.\d+$/.test(result.ts ?? "") &&
    /^B[A-Z0-9]+$/.test(result.message?.bot_id ?? ""), "Slack did not return the posted message identity")
  return {schemaVersion: 1, kind: "mentra-release-slack-message", build,
    producer: {runId: Number(env.RUN_ID), runAttempt: Number(env.RUN_ATTEMPT), headSha: env.SHA},
    message: {channel, ts: result.ts, botId: result.message.bot_id}, payload: messagePayload, rows: {}}
}

export function assertNotification(value) {
  requireThat(value?.schemaVersion === 1 && value.kind === "mentra-release-slack-message" &&
    value.build?.repository === REPOSITORY && ["dev", "staging"].includes(value.build.channel) &&
    positive(value.build.runId) && sha(value.build.headSha) && hash(value.build.archiveSha256) &&
    /^\d+\.\d+\.\d+-(dev|beta)\.[1-9]\d*$/.test(value.build.release ?? "") &&
    positive(value.producer?.runAttempt) && value.producer?.runId === value.build.runId &&
    value.producer.headSha === value.build.headSha && /^C[A-Z0-9]+$/.test(value.message?.channel ?? "") &&
    /^\d+\.\d+$/.test(value.message?.ts ?? "") && /^B[A-Z0-9]+$/.test(value.message?.botId ?? "") &&
    Array.isArray(value.payload?.blocks) && value.payload.blocks.filter(block => block.block_id === ROUTINE_BLOCK).length === 1 &&
    value.rows && Object.keys(value.rows).every(id => Object.hasOwn(routineNames, id)), "Invalid retained release message")
  return value
}

const generation = row => [row.requestRunId, row.requestAttempt, row.privateRunId, row.privateAttempt]
const compare = (a, b) => { for (let i = 0; i < a.length; i++) { if (a[i] !== b[i]) return a[i] - b[i] } return 0 }
// A request cancelled before any runner accepted it has no test result. It may
// only fill a pending row; any worker-attested result outranks it.
const CANCELLED = "cancelled"

/** All unaffected blocks are retained verbatim; a late older result cannot regress a row. */
export function applyRoutineResult(notification, row) {
  assertNotification(notification)
  requireThat(Object.hasOwn(routineNames, row?.routineId) && generation(row).every(positive) &&
    ["passed", "failed", "blocked", "aborted", "upload-incomplete", CANCELLED].includes(row.status) &&
    (row.status !== CANCELLED || row.resultRunId === undefined) &&
    (!row.resultRunId || /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(row.resultRunId)), "Invalid routine result row")
  const previous = notification.rows[row.routineId]
  if (previous && (row.status === CANCELLED ? previous.status !== CANCELLED || compare(generation(previous), generation(row)) >= 0
    : previous.status !== CANCELLED && compare(generation(previous), generation(row)) >= 0)) return notification
  const rows = {...notification.rows, [row.routineId]: row}
  const labels = {passed: "Passed", failed: "Failed", blocked: "Blocked", aborted: "Aborted", "upload-incomplete": "Result upload incomplete",
    [CANCELLED]: "Cancelled before execution; no test result"}
  const lines = Object.keys(routineNames).filter(id => rows[id]).map(id => {
    const result = rows[id]
    const resultLink = result.resultRunId
      ? ` · <https://admin.dev.mentraglass.com/?testRun=${encodeURIComponent(result.resultRunId)}|Recording and result>` : ""
    return `${routineNames[id]} — *${labels[result.status]}*${resultLink} · <https://github.com/${REPOSITORY}/actions/runs/${result.requestRunId}/attempts/${result.requestAttempt}|Request>`
  })
  return {...notification, rows, payload: {...notification.payload, blocks: notification.payload.blocks.map(block =>
    block.block_id === ROUTINE_BLOCK ? {...block, text: {type: "mrkdwn", text: `*Device test results*\n${lines.join("\n")}\nLatest completed request per routine; build success is independent of these results.`}} : block)}}
}

export async function updateReleaseMessage(notification, env, fetchImpl = fetch) {
  assertNotification(notification)
  const channel = slackDestination({...env, BRANCH: notification.build.channel})
  requireThat(channel === notification.message.channel, "Configured Slack channel differs from the original release post")
  const auth = await slackCall("auth.test", env.SLACK_BUILDS_BOT_TOKEN, {}, fetchImpl)
  requireThat(auth.bot_id === notification.message.botId, "Configured bot does not own this release post")
  const result = await slackCall("chat.update", env.SLACK_BUILDS_BOT_TOKEN,
    {...notification.payload, channel, ts: notification.message.ts,
      text: `Mentra ${notification.build.release} device test results`}, fetchImpl)
  requireThat(result.channel === channel && result.ts === notification.message.ts, "Slack updated a different message")
}

if (process.argv[1]?.endsWith("/release-slack-message.mjs")) {
  let body = ""
  for await (const chunk of process.stdin) { body += chunk; requireThat(body.length <= 128 * 1024, "Slack payload too large") }
  const receipt = await postReleaseMessage(process.env, JSON.parse(body))
  await writeFile("slack-release-message.json", JSON.stringify(receipt) + "\n", {flag: "wx"})
}
