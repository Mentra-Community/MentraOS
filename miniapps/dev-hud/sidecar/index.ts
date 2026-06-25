import {existsSync, mkdirSync, readFileSync, renameSync, writeFileSync} from "fs"
import {homedir, networkInterfaces} from "os"
import {dirname, join} from "path"
import {Database} from "bun:sqlite"

import type {
  CheckState,
  CodexTaskSummary,
  CodexThreadState,
  CodexThreadSummary,
  CodexTurnSummary,
  DevHudNotification,
  DevHudStatus,
  NotificationKind,
  NotificationSeverity,
  PullRequestSummary,
  PullRequestCheckItem,
  PullRequestReviewNote,
  ReviewState,
  SourceStatus,
} from "../src/shared/types"

const PORT = Number(process.env.DEV_HUD_PORT ?? 3147)
const CODEX_HOME = process.env.CODEX_HOME ?? join(homedir(), ".codex")
const GITHUB_LIMIT = Number(process.env.DEV_HUD_GITHUB_LIMIT ?? 8)
const THREAD_LIMIT = Number(process.env.DEV_HUD_CODEX_THREAD_LIMIT ?? 8)
const CODEX_TURN_LIMIT = Number(process.env.DEV_HUD_CODEX_TURN_LIMIT ?? 24)
const NOTIFICATION_STORE_PATH = process.env.DEV_HUD_NOTIFICATION_STORE_PATH ?? join(CODEX_HOME, "dev-hud-notifications.json")
const PUBLIC_ENDPOINT = process.env.DEV_HUD_PUBLIC_ENDPOINT ?? `http://${localIpAddress() ?? "127.0.0.1"}:${PORT}`
const RECENT_CODEX_FINISH_WINDOW_MS = Number(process.env.DEV_HUD_CODEX_FINISH_WINDOW_MS ?? 5 * 60 * 1000)

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,Accept",
}

const MAX_NOTIFICATIONS = 80

interface DiffBaseline {
  prs: Map<string, PullRequestSummary>
  tasks: Map<string, CodexTaskSummary>
  threads: Map<string, CodexThreadSummary>
  turns: Map<string, CodexTurnSummary>
}

let previousBaseline: DiffBaseline | null = null
let notificationEvents: DevHudNotification[] = loadNotificationEvents()

Bun.serve({
  hostname: "0.0.0.0",
  port: PORT,
  async fetch(request) {
    const url = new URL(request.url)
    if (request.method === "OPTIONS") return new Response(null, {headers: CORS_HEADERS})
    if (url.pathname === "/health") return json({ok: true, endpoint: PUBLIC_ENDPOINT})
    if (url.pathname === "/api/status") return json(await collectStatus())
    return json({
      name: "Dev HUD sidecar",
      endpoints: ["/health", "/api/status"],
      endpoint: PUBLIC_ENDPOINT,
    })
  },
})

console.log(`[dev-hud] sidecar listening on ${PUBLIC_ENDPOINT}`)
console.log(`[dev-hud] codex home: ${CODEX_HOME}`)
console.log(`[dev-hud] notifications: ${NOTIFICATION_STORE_PATH}`)

async function collectStatus(): Promise<DevHudStatus> {
  const [github, codex] = await Promise.all([collectGitHub(), collectCodex()])
  const events =
    github.status.state === "ok" && codex.status.state === "ok"
      ? diffStatus(github.openPrs, codex.tasks, codex.threads, codex.turns)
      : notificationEvents
  return {
    generatedAt: Date.now(),
    endpoint: PUBLIC_ENDPOINT,
    github,
    codex,
    notifications: {
      status: sourceStatus("ok", `${notificationEvents.length} event${notificationEvents.length === 1 ? "" : "s"}`),
      events,
    },
  }
}

async function collectGitHub(): Promise<DevHudStatus["github"]> {
  try {
    const searchRaw = await runProcess("gh", [
      "search",
      "prs",
      "--author",
      "@me",
      "--state",
      "open",
      "--archived=false",
      "--sort",
      "updated",
      "--order",
      "desc",
      "--limit",
      String(GITHUB_LIMIT),
      "--json",
      "repository,number,title,url,isDraft,state,updatedAt",
    ])
    const searchResults = JSON.parse(searchRaw) as SearchPullRequest[]
    const enriched = await Promise.all(searchResults.map((pr) => enrichPullRequest(pr).catch(() => fromSearchPullRequest(pr))))
    return {
      status: sourceStatus("ok", `${enriched.length} open PR${enriched.length === 1 ? "" : "s"}`),
      openPrs: enriched,
    }
  } catch (err) {
    return {
      status: sourceStatus("error", errorMessage(err)),
      openPrs: [],
    }
  }
}

async function enrichPullRequest(pr: SearchPullRequest): Promise<PullRequestSummary> {
  const repo = pr.repository.nameWithOwner
  const raw = await runProcess("gh", [
    "pr",
    "view",
    String(pr.number),
    "--repo",
    repo,
    "--json",
    "number,title,url,isDraft,reviewDecision,mergeStateStatus,statusCheckRollup,headRefName,baseRefName,updatedAt,reviewRequests,latestReviews",
  ])
  const detail = JSON.parse(raw) as PullRequestDetail
  const requestedReviewers = normalizeReviewRequests(detail.reviewRequests)
  const reviewComments = await collectReviewComments(repo, pr.number, detail.latestReviews)
  return {
    id: `${repo}#${detail.number}`,
    repo,
    number: detail.number,
    title: sanitizeTitle(detail.title),
    url: detail.url,
    isDraft: Boolean(detail.isDraft),
    updatedAt: detail.updatedAt ?? pr.updatedAt ?? null,
    branch: detail.headRefName ?? null,
    base: detail.baseRefName ?? null,
    mergeState: detail.mergeStateStatus ?? null,
    reviewState: normalizeReviewState(detail.reviewDecision, requestedReviewers.length),
    requestedReviewers,
    checks: summarizeChecks(detail.statusCheckRollup ?? []),
    reviewComments,
  }
}

function fromSearchPullRequest(pr: SearchPullRequest): PullRequestSummary {
  const repo = pr.repository.nameWithOwner
  return {
    id: `${repo}#${pr.number}`,
    repo,
    number: pr.number,
    title: sanitizeTitle(pr.title),
    url: pr.url,
    isDraft: Boolean(pr.isDraft),
    updatedAt: pr.updatedAt ?? null,
    branch: null,
    base: null,
    mergeState: null,
    reviewState: "unknown",
    requestedReviewers: [],
    checks: {state: "unknown", total: 0, success: 0, pending: 0, failure: 0, skipped: 0, items: []},
    reviewComments: [],
  }
}

async function collectCodex(): Promise<DevHudStatus["codex"]> {
  try {
    const names = readSessionNames()
    const tasks = readCodexTasks(names)
    const commandsByThread = new Map<string, string[]>()
    for (const task of tasks) {
      if (!task.running) continue
      const current = commandsByThread.get(task.threadId) ?? []
      current.push(task.command)
      commandsByThread.set(task.threadId, current)
    }
    const threads = readCodexThreads(names, commandsByThread)
    const turns = readCompletedCodexTurns(names)
    const runningCount = tasks.filter((task) => task.running).length
    return {
      status: sourceStatus("ok", `${threads.length} threads, ${runningCount} running task${runningCount === 1 ? "" : "s"}`),
      threads,
      tasks,
      turns,
    }
  } catch (err) {
    return {
      status: sourceStatus("error", errorMessage(err)),
      threads: [],
      tasks: [],
      turns: [],
    }
  }
}

function readCodexThreads(names: Map<string, string>, commandsByThread: Map<string, string[]>): CodexThreadSummary[] {
  const statePath = join(CODEX_HOME, "state_5.sqlite")
  if (!existsSync(statePath)) throw new Error(`Codex state not found at ${statePath}`)
  const db = new Database(statePath, {readonly: true})
  try {
    const rows = db
      .query(
        `select id, title, cwd, preview, git_branch, updated_at, updated_at_ms, recency_at_ms
         from threads
         where archived = 0
         order by recency_at_ms desc
         limit ?`,
      )
      .all(THREAD_LIMIT) as ThreadRow[]
    return rows.map((row) => {
      const updatedAt = Number(row.updated_at_ms || row.recency_at_ms || row.updated_at * 1000 || 0)
      const runningCommands = commandsByThread.get(row.id) ?? []
      return {
        id: row.id,
        title: sanitizeTitle(names.get(row.id) ?? row.title ?? row.preview ?? "Untitled thread"),
        cwd: row.cwd,
        branch: row.git_branch ? sanitizeTitle(row.git_branch) : null,
        updatedAt,
        state: threadState(updatedAt, runningCommands.length > 0),
        runningCommands,
      }
    })
  } finally {
    db.close()
  }
}

function readCodexTasks(names: Map<string, string>): CodexTaskSummary[] {
  const processPath = join(CODEX_HOME, "process_manager", "chat_processes.json")
  if (!existsSync(processPath)) return []
  const raw = JSON.parse(readFileSync(processPath, "utf8")) as ProcessRow[]
  const tasks = raw
    .filter((row) => !isDevHudSelfTask(row))
    .map((row) => {
      const pid = typeof row.osPid === "number" ? row.osPid : null
      const running = pid !== null && processAlive(pid)
      return {
        id: row.id,
        threadId: row.conversationId,
        title: sanitizeTitle(names.get(row.conversationId) ?? row.chatTitle ?? "Codex thread"),
        cwd: row.cwd,
        command: sanitizeCommand(row.command),
        startedAt: Number(row.startedAtMs ?? 0),
        updatedAt: Number(row.updatedAtMs ?? row.startedAtMs ?? 0),
        pid,
        running,
      } satisfies CodexTaskSummary
    })
    .filter((task) => task.running)
    .sort((a, b) => b.startedAt - a.startedAt)
  return tasks.slice(0, 8)
}

function readCompletedCodexTurns(names: Map<string, string>): CodexTurnSummary[] {
  const logsPath = join(CODEX_HOME, "logs_2.sqlite")
  if (!existsSync(logsPath)) return []
  const sinceSeconds = Math.floor((Date.now() - RECENT_CODEX_FINISH_WINDOW_MS) / 1000)
  const db = new Database(logsPath, {readonly: true})
  try {
    const rows = db
      .query(
        `select id, thread_id, ts, feedback_log_body
         from logs
         where ts >= ?
           and thread_id is not null
           and target = 'codex_core::session::turn'
           and feedback_log_body like '%post sampling token usage%'
           and feedback_log_body like '%needs_follow_up=false%'
         order by ts desc, ts_nanos desc, id desc
         limit ?`,
      )
      .all(sinceSeconds, CODEX_TURN_LIMIT) as CodexTurnRow[]

    const turns: CodexTurnSummary[] = []
    const seenTurnIds = new Set<string>()
    for (const row of rows) {
      const body = row.feedback_log_body ?? ""
      const turnId = body.match(/\bturn_id=([0-9a-f-]+)/)?.[1]
      const threadId = row.thread_id ?? body.match(/\bthread\.id=([0-9a-f-]+)/)?.[1]
      if (!turnId || !threadId || seenTurnIds.has(turnId)) continue
      seenTurnIds.add(turnId)
      turns.push({
        id: turnId,
        threadId,
        title: sanitizeTitle(names.get(threadId) ?? "Codex thread"),
        completedAt: Number(row.ts) * 1000,
      })
    }
    return turns
  } finally {
    db.close()
  }
}

function isDevHudSelfTask(row: ProcessRow): boolean {
  if (!row.cwd.endsWith("/miniapps/dev-hud")) return false
  return /(?:sidecar\/index\.ts|scripts\/dev\.ts|miniapp:dev|bun run dev)\b/.test(row.command)
}

function readSessionNames(): Map<string, string> {
  const indexPath = join(CODEX_HOME, "session_index.jsonl")
  const names = new Map<string, string>()
  if (!existsSync(indexPath)) return names
  for (const line of readFileSync(indexPath, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const row = JSON.parse(line) as {id?: string; thread_name?: string}
      if (row.id && row.thread_name) names.set(row.id, sanitizeTitle(row.thread_name))
    } catch {
      /* ignore malformed rows */
    }
  }
  return names
}

function diffStatus(
  prs: PullRequestSummary[],
  tasks: CodexTaskSummary[],
  threads: CodexThreadSummary[],
  turns: CodexTurnSummary[],
): DevHudNotification[] {
  const current: DiffBaseline = {
    prs: new Map(prs.map((pr) => [pr.id, pr])),
    tasks: new Map(tasks.filter((task) => task.running).map((task) => [task.id, task])),
    threads: new Map(threads.map((thread) => [thread.id, thread])),
    turns: new Map(turns.map((turn) => [turn.id, turn])),
  }

  if (!previousBaseline) {
    previousBaseline = current
    return notificationEvents
  }

  const newEvents: DevHudNotification[] = []
  const finishedTaskThreadIds = new Set<string>()

  for (const pr of current.prs.values()) {
    const before = previousBaseline.prs.get(pr.id)
    if (!before) {
      newEvents.push(
        notification({
          source: "github",
          kind: "github_pr_opened",
          severity: "info",
          interrupt: false,
          title: `PR #${pr.number} opened`,
          message: pr.title,
          target: {type: "pr", id: pr.id},
          before: null,
          after: "open",
        }),
      )
      continue
    }

    if (before.checks.state !== pr.checks.state) {
      if (pr.checks.state === "failure") {
        newEvents.push(
          notification({
            source: "github",
            kind: "github_checks_failed",
            severity: "critical",
            interrupt: true,
            title: `PR #${pr.number} checks failed`,
            message: pr.title,
            target: {type: "pr", id: pr.id},
            before: before.checks.state,
            after: pr.checks.state,
          }),
        )
      } else if (before.checks.state === "failure" && pr.checks.state === "success") {
        newEvents.push(
          notification({
            source: "github",
            kind: "github_checks_recovered",
            severity: "success",
            interrupt: true,
            title: `PR #${pr.number} checks recovered`,
            message: pr.title,
            target: {type: "pr", id: pr.id},
            before: before.checks.state,
            after: pr.checks.state,
          }),
        )
      } else {
        newEvents.push(
          notification({
            source: "github",
            kind: "github_checks_changed",
            severity: pr.checks.state === "pending" ? "warning" : "info",
            interrupt: false,
            title: `PR #${pr.number} checks ${pr.checks.state}`,
            message: pr.title,
            target: {type: "pr", id: pr.id},
            before: before.checks.state,
            after: pr.checks.state,
          }),
        )
      }
    }

    if (before.reviewState !== pr.reviewState) {
      if (pr.reviewState === "changes_requested") {
        newEvents.push(
          notification({
            source: "github",
            kind: "github_changes_requested",
            severity: "critical",
            interrupt: true,
            title: `Changes requested on #${pr.number}`,
            message: latestReviewMessage(pr) ?? pr.title,
            target: {type: "pr", id: pr.id},
            before: before.reviewState,
            after: pr.reviewState,
          }),
        )
      } else if (pr.reviewState === "approved") {
        newEvents.push(
          notification({
            source: "github",
            kind: "github_approved",
            severity: "success",
            interrupt: true,
            title: `PR #${pr.number} approved`,
            message: pr.title,
            target: {type: "pr", id: pr.id},
            before: before.reviewState,
            after: pr.reviewState,
          }),
        )
      } else {
        newEvents.push(
          notification({
            source: "github",
            kind: "github_review_changed",
            severity: "info",
            interrupt: false,
            title: `PR #${pr.number} review changed`,
            message: pr.title,
            target: {type: "pr", id: pr.id},
            before: before.reviewState,
            after: pr.reviewState,
          }),
        )
      }
    }

    const beforeMerge = normalizeMergeState(before.mergeState)
    const afterMerge = normalizeMergeState(pr.mergeState)
    if (beforeMerge !== afterMerge) {
      if (isBlockedMergeState(afterMerge)) {
        newEvents.push(
          notification({
            source: "github",
            kind: "github_merge_blocked",
            severity: "warning",
            interrupt: true,
            title: `PR #${pr.number} merge blocked`,
            message: pr.title,
            target: {type: "pr", id: pr.id},
            before: beforeMerge,
            after: afterMerge,
          }),
        )
      } else if (isBlockedMergeState(beforeMerge) && afterMerge === "CLEAN") {
        newEvents.push(
          notification({
            source: "github",
            kind: "github_merge_recovered",
            severity: "success",
            interrupt: true,
            title: `PR #${pr.number} mergeable again`,
            message: pr.title,
            target: {type: "pr", id: pr.id},
            before: beforeMerge,
            after: afterMerge,
          }),
        )
      }
    }
  }

  for (const pr of previousBaseline.prs.values()) {
    if (current.prs.has(pr.id)) continue
    newEvents.push(
      notification({
        source: "github",
        kind: "github_pr_removed",
        severity: "info",
        interrupt: false,
        title: `PR #${pr.number} left open list`,
        message: pr.title,
        target: {type: "pr", id: pr.id},
        before: "open",
        after: "removed",
      }),
    )
  }

  for (const task of previousBaseline.tasks.values()) {
    if (current.tasks.has(task.id)) continue
    finishedTaskThreadIds.add(task.threadId)
    newEvents.push(
      notification({
        source: "codex",
        kind: "codex_task_finished",
        severity: "success",
        interrupt: true,
        title: "Codex task finished",
        message: `${task.title}: ${task.command}`,
        target: {type: "codexThread", id: task.threadId},
        before: "running",
        after: "finished",
      }),
    )
  }

  for (const turn of current.turns.values()) {
    if (previousBaseline.turns.has(turn.id) || finishedTaskThreadIds.has(turn.threadId)) continue
    const thread = current.threads.get(turn.threadId)
    newEvents.push(
      notification({
        source: "codex",
        kind: "codex_turn_finished",
        severity: "success",
        interrupt: true,
        title: "Codex turn finished",
        message: thread?.title ?? turn.title,
        target: {type: "codexThread", id: turn.threadId},
        before: null,
        after: "finished",
      }),
    )
  }

  previousBaseline = current
  if (newEvents.length > 0) {
    notificationEvents = [...newEvents, ...notificationEvents].slice(0, MAX_NOTIFICATIONS)
    persistNotificationEvents(notificationEvents)
  }
  return notificationEvents
}

function loadNotificationEvents(): DevHudNotification[] {
  if (!existsSync(NOTIFICATION_STORE_PATH)) return []
  try {
    const parsed = JSON.parse(readFileSync(NOTIFICATION_STORE_PATH, "utf8")) as unknown
    const rawEvents = Array.isArray(parsed)
      ? parsed
      : isRecord(parsed) && Array.isArray(parsed.events)
        ? parsed.events
        : []
    return rawEvents
      .filter(isStoredNotification)
      .map((event) => ({
        ...event,
        title: sanitizeTitle(event.title),
        message: sanitizeBody(event.message),
        before: event.before ? sanitizeTitle(event.before) : null,
        after: event.after ? sanitizeTitle(event.after) : null,
      }))
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, MAX_NOTIFICATIONS)
  } catch (err) {
    console.log(`DevHUD: failed to load notifications: ${errorMessage(err)}`)
    return []
  }
}

function persistNotificationEvents(events: DevHudNotification[]): void {
  try {
    mkdirSync(dirname(NOTIFICATION_STORE_PATH), {recursive: true})
    const tmpPath = `${NOTIFICATION_STORE_PATH}.${process.pid}.tmp`
    writeFileSync(tmpPath, JSON.stringify({version: 1, events}, null, 2))
    renameSync(tmpPath, NOTIFICATION_STORE_PATH)
  } catch (err) {
    console.log(`DevHUD: failed to persist notifications: ${errorMessage(err)}`)
  }
}

function isStoredNotification(value: unknown): value is DevHudNotification {
  if (!isRecord(value) || !isRecord(value.target)) return false
  const targetType = value.target.type
  return (
    typeof value.id === "string" &&
    typeof value.timestamp === "number" &&
    typeof value.source === "string" &&
    typeof value.severity === "string" &&
    typeof value.kind === "string" &&
    typeof value.interrupt === "boolean" &&
    typeof value.title === "string" &&
    typeof value.message === "string" &&
    (targetType === "pr" || targetType === "codexThread") &&
    typeof value.target.id === "string" &&
    (typeof value.before === "string" || value.before === null) &&
    (typeof value.after === "string" || value.after === null)
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function notification(input: Omit<DevHudNotification, "id" | "timestamp">): DevHudNotification {
  const timestamp = Date.now()
  const idSource = [
    input.kind,
    input.target.type,
    input.target.id,
    input.before ?? "",
    input.after ?? "",
    timestamp,
  ].join(":")
  return {
    id: `${input.kind}-${hashString(idSource)}`,
    timestamp,
    ...input,
    message: sanitizeBody(input.message),
    title: sanitizeTitle(input.title),
    before: input.before ? sanitizeTitle(input.before) : null,
    after: input.after ? sanitizeTitle(input.after) : null,
  }
}

function latestReviewMessage(pr: PullRequestSummary): string | null {
  const latest = pr.reviewComments.find((comment) => comment.body.trim().length > 0)
  if (!latest) return null
  return `${latest.author}: ${latest.body}`
}

function normalizeMergeState(state: string | null): string {
  return sanitizeTitle((state ?? "UNKNOWN").toUpperCase())
}

function isBlockedMergeState(state: string): boolean {
  return state === "BLOCKED" || state === "DIRTY" || state === "UNKNOWN"
}

function hashString(input: string): string {
  let hash = 5381
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash * 33) ^ input.charCodeAt(i)
  }
  return (hash >>> 0).toString(36)
}

async function collectReviewComments(
  repo: string,
  prNumber: number,
  latestReviews: ReviewSummary[] | undefined,
): Promise<PullRequestReviewNote[]> {
  const notes: PullRequestReviewNote[] = []
  for (const review of latestReviews ?? []) {
    const body = sanitizeBody(review.body ?? "")
    if (!body) continue
    notes.push({
      id: `review-${review.id || review.submittedAt || notes.length}`,
      type: "review",
      author: sanitizeTitle(review.author?.login ?? "reviewer"),
      body,
      state: review.state ? sanitizeTitle(review.state.toLowerCase()) : null,
      path: null,
      line: null,
      url: null,
      createdAt: review.submittedAt ?? null,
    })
  }

  try {
    const raw = await runProcess("gh", ["api", `repos/${repo}/pulls/${prNumber}/comments`], 15_000)
    const inlineComments = JSON.parse(raw) as InlineReviewComment[]
    for (const comment of inlineComments.slice(-16).reverse()) {
      notes.push({
        id: `inline-${comment.id}`,
        type: "inline",
        author: sanitizeTitle(comment.user?.login ?? "reviewer"),
        body: sanitizeBody(comment.body ?? ""),
        state: null,
        path: comment.path ? sanitizeTitle(comment.path) : null,
        line: typeof comment.line === "number" ? comment.line : typeof comment.original_line === "number" ? comment.original_line : null,
        url: comment.html_url ?? null,
        createdAt: comment.created_at ?? null,
      })
    }
  } catch {
    /* Review comments are best-effort; PR state should still render. */
  }

  return notes.filter((note) => note.body.length > 0).slice(0, 20)
}

function summarizeChecks(items: StatusCheckItem[]): PullRequestSummary["checks"] {
  let success = 0
  let pending = 0
  let failure = 0
  let skipped = 0
  const checkItems: PullRequestCheckItem[] = []

  for (const item of items) {
    const state = normalizeCheckItem(item)
    if (state === "success") success += 1
    else if (state === "pending") pending += 1
    else if (state === "failure") failure += 1
    else skipped += 1
    checkItems.push(checkItemSummary(item, state === "skipped" ? "unknown" : state))
  }

  const total = items.length
  const state: CheckState = total === 0 ? "unknown" : failure > 0 ? "failure" : pending > 0 ? "pending" : "success"
  return {state, total, success, pending, failure, skipped, items: checkItems}
}

function checkItemSummary(item: StatusCheckItem, state: CheckState): PullRequestCheckItem {
  if (item.__typename === "StatusContext") {
    return {
      name: sanitizeTitle(item.context ?? "status"),
      workflow: null,
      state,
      url: item.targetUrl ?? null,
    }
  }
  return {
    name: sanitizeTitle(item.name ?? "check"),
    workflow: item.workflowName ? sanitizeTitle(item.workflowName) : null,
    state,
    url: item.detailsUrl ?? null,
  }
}

function normalizeCheckItem(item: StatusCheckItem): "success" | "pending" | "failure" | "skipped" {
  if (item.__typename === "StatusContext") {
    const state = String(item.state ?? "").toUpperCase()
    if (state === "SUCCESS") return "success"
    if (state === "PENDING" || state === "EXPECTED") return "pending"
    if (state === "ERROR" || state === "FAILURE") return "failure"
    return "skipped"
  }
  const status = String(item.status ?? "").toUpperCase()
  const conclusion = String(item.conclusion ?? "").toUpperCase()
  if (status && status !== "COMPLETED") return "pending"
  if (conclusion === "SUCCESS" || conclusion === "NEUTRAL") return "success"
  if (conclusion === "SKIPPED") return "skipped"
  if (conclusion === "FAILURE" || conclusion === "CANCELLED" || conclusion === "TIMED_OUT" || conclusion === "ACTION_REQUIRED") {
    return "failure"
  }
  return "pending"
}

function normalizeReviewRequests(items: ReviewRequest[] | undefined): string[] {
  if (!Array.isArray(items)) return []
  return items
    .map((item) => ("login" in item ? item.login : "name" in item ? item.name : null))
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .map(sanitizeTitle)
}

function normalizeReviewState(decision: string | null | undefined, requestedCount: number): ReviewState {
  const normalized = String(decision ?? "").toUpperCase()
  if (normalized === "APPROVED") return "approved"
  if (normalized === "CHANGES_REQUESTED") return "changes_requested"
  if (normalized === "REVIEW_REQUIRED") return "review_required"
  if (requestedCount > 0) return "review_required"
  if (!normalized) return "none"
  return "unknown"
}

function threadState(updatedAt: number, running: boolean): CodexThreadState {
  if (running) return "running"
  const ageMs = Date.now() - updatedAt
  if (ageMs < 2 * 60 * 60 * 1000) return "done"
  if (ageMs < 48 * 60 * 60 * 1000) return "recent"
  return "stale"
}

async function runProcess(command: string, args: string[], timeoutMs = 15_000): Promise<string> {
  const proc = Bun.spawn([command, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  })
  const stdoutPromise = new Response(proc.stdout).text()
  const stderrPromise = new Response(proc.stderr).text()
  let timedOut = false
  const timeout = setTimeout(() => {
    timedOut = true
    proc.kill()
  }, timeoutMs)

  const exitCode = await proc.exited.finally(() => clearTimeout(timeout))
  const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise])
  if (timedOut) throw new Error(`${command} timed out`)
  if (exitCode !== 0) throw new Error(trimError(stderr) || `${command} exited ${exitCode}`)
  return stdout
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function sourceStatus(state: SourceStatus["state"], message: string | null): SourceStatus {
  return {state, message, updatedAt: Date.now()}
}

function json(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body, null, 2), {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...CORS_HEADERS,
      ...(init?.headers ?? {}),
    },
  })
}

function sanitizeTitle(value: string): string {
  return truncate(oneLine(redact(value)), 96)
}

function sanitizeCommand(value: string): string {
  return truncate(oneLine(redact(value)), 120)
}

function sanitizeBody(value: string): string {
  return truncate(redact(value).replace(/\r\n/g, "\n").trim(), 900)
}

function redact(value: string): string {
  return value
    .replace(/\b(?:gho|ghp|github_pat)_[A-Za-z0-9_]+/g, "[github-token]")
    .replace(/\blin_api_[A-Za-z0-9]+/g, "[linear-token]")
    .replace(/\bsk-[A-Za-z0-9_-]+/g, "[api-token]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[jwt]")
    .replace(/\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASS|API_KEY|ACCESS_KEY|PRIVATE_KEY)[A-Z0-9_]*)=(?:"[^"]*"|'[^']*'|[^\s]+)/gi, "$1=[redacted]")
    .replace(/([?&](?:token|key|secret|password)=)[^&\s]+/gi, "$1[redacted]")
    .replace(/\bBearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted]")
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim()
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value
  return `${value.slice(0, Math.max(0, max - 3)).trimEnd()}...`
}

function trimError(value: string): string {
  return truncate(oneLine(redact(value)), 220)
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? trimError(err.message) : trimError(String(err))
}

function localIpAddress(): string | null {
  const nets = networkInterfaces()
  for (const name of ["en0", "en1", "bridge100"]) {
    const found = nets[name]?.find((entry) => entry.family === "IPv4" && !entry.internal)
    if (found) return found.address
  }
  for (const entries of Object.values(nets)) {
    const found = entries?.find((entry) => entry.family === "IPv4" && !entry.internal)
    if (found) return found.address
  }
  return null
}

interface SearchPullRequest {
  repository: {nameWithOwner: string}
  number: number
  title: string
  url: string
  isDraft?: boolean
  updatedAt?: string
}

interface PullRequestDetail {
  number: number
  title: string
  url: string
  isDraft?: boolean
  reviewDecision?: string
  mergeStateStatus?: string
  statusCheckRollup?: StatusCheckItem[]
  headRefName?: string
  baseRefName?: string
  updatedAt?: string
  reviewRequests?: ReviewRequest[]
  latestReviews?: ReviewSummary[]
}

type StatusCheckItem =
  | {
      __typename: "CheckRun"
      name?: string
      workflowName?: string
      detailsUrl?: string
      status?: string
      conclusion?: string | null
    }
  | {
      __typename: "StatusContext"
      context?: string
      targetUrl?: string
      state?: string
    }

type ReviewRequest = {__typename?: string; login?: string; name?: string}

interface ReviewSummary {
  id?: string
  author?: {login?: string}
  body?: string
  submittedAt?: string
  state?: string
}

interface InlineReviewComment {
  id: number
  user?: {login?: string}
  body?: string
  path?: string
  line?: number | null
  original_line?: number | null
  html_url?: string
  created_at?: string
}

interface ThreadRow {
  id: string
  title: string
  cwd: string
  preview: string
  git_branch: string | null
  updated_at: number
  updated_at_ms: number | null
  recency_at_ms: number | null
}

interface ProcessRow {
  id: string
  conversationId: string
  chatTitle?: string | null
  cwd: string
  command: string
  osPid?: number | null
  startedAtMs?: number
  updatedAtMs?: number
}

interface CodexTurnRow {
  id: number
  thread_id: string | null
  ts: number
  feedback_log_body: string | null
}
