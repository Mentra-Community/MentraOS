export type SourceState = "ok" | "loading" | "error" | "disabled"

export interface SourceStatus {
  state: SourceState
  message: string | null
  updatedAt: number | null
}

export type CheckState = "success" | "pending" | "failure" | "unknown"
export type ReviewState = "approved" | "changes_requested" | "review_required" | "none" | "unknown"

export interface PullRequestCheckItem {
  name: string
  workflow: string | null
  state: CheckState
  url: string | null
}

export interface PullRequestReviewNote {
  id: string
  type: "review" | "inline"
  author: string
  body: string
  state: string | null
  path: string | null
  line: number | null
  url: string | null
  createdAt: string | null
}

export interface PullRequestSummary {
  id: string
  repo: string
  number: number
  title: string
  url: string
  isDraft: boolean
  updatedAt: string | null
  branch: string | null
  base: string | null
  mergeState: string | null
  reviewState: ReviewState
  requestedReviewers: string[]
  checks: {
    state: CheckState
    total: number
    success: number
    pending: number
    failure: number
    skipped: number
    items: PullRequestCheckItem[]
  }
  reviewComments: PullRequestReviewNote[]
}

export type CodexThreadState = "running" | "done" | "active" | "recent" | "stale"

export interface CodexThreadSummary {
  id: string
  title: string
  cwd: string
  branch: string | null
  updatedAt: number
  state: CodexThreadState
  runningCommands: string[]
}

export interface CodexTaskSummary {
  id: string
  threadId: string
  title: string
  cwd: string
  command: string
  startedAt: number
  updatedAt: number
  pid: number | null
  running: boolean
}

export interface CodexTurnSummary {
  id: string
  threadId: string
  title: string
  completedAt: number
}

export interface DevHudStatus {
  generatedAt: number
  endpoint: string
  github: {
    status: SourceStatus
    openPrs: PullRequestSummary[]
  }
  codex: {
    status: SourceStatus
    threads: CodexThreadSummary[]
    tasks: CodexTaskSummary[]
    turns: CodexTurnSummary[]
  }
  notifications: {
    status: SourceStatus
    events: DevHudNotification[]
  }
}

export interface DevHudSnapshot {
  endpoint: string
  status: DevHudStatus | null
  loading: boolean
  lastError: string | null
  selectedView: DevHudView
}

export type DevHudView = "summary" | "github" | "codex" | "notifications"

export type NotificationSource = "github" | "codex" | "system"
export type NotificationSeverity = "info" | "success" | "warning" | "critical"

export type NotificationKind =
  | "github_pr_opened"
  | "github_pr_removed"
  | "github_checks_failed"
  | "github_checks_recovered"
  | "github_checks_changed"
  | "github_changes_requested"
  | "github_approved"
  | "github_review_changed"
  | "github_merge_blocked"
  | "github_merge_recovered"
  | "codex_task_started"
  | "codex_task_finished"
  | "codex_turn_finished"
  | "codex_thread_finished"

export type NotificationTarget =
  | {
      type: "pr"
      id: string
    }
  | {
      type: "codexThread"
      id: string
    }

export interface DevHudNotification {
  id: string
  timestamp: number
  source: NotificationSource
  severity: NotificationSeverity
  kind: NotificationKind
  interrupt: boolean
  title: string
  message: string
  target: NotificationTarget
  before: string | null
  after: string | null
}
