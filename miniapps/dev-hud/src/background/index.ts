import {registerMiniapp} from "@mentra/miniapp/background"
import type {MiniappSession, TouchData} from "@mentra/miniapp/background"

import type {Channels} from "../shared/channels"
import type {
  CodexTaskSummary,
  CodexThreadSummary,
  DevHudNotification,
  DevHudSnapshot,
  DevHudStatus,
  DevHudView,
  PullRequestSummary,
} from "../shared/types"

type Send = <C extends keyof Channels & string>(channel: C, payload: Channels[C]) => void
type On = <C extends keyof Channels & string>(channel: C, cb: (payload: Channels[C]) => void) => () => void

const SETTINGS_KEY = "dev-hud:settings"
const DEFAULT_ENDPOINT = process.env.MENTRA_PUBLIC_DEV_HUD_ENDPOINT?.trim() || "http://127.0.0.1:3147"
const POLL_MS = 10_000
const DISPLAY_MS = 28_000
const NOTIFICATION_DISPLAY_MS = 12_000
const MAIN_MENU_ROWS = ["Summary", "Pull Requests", "Codex Threads", "Notifications", "Refresh"] as const
const EMPTY_PR_ROWS = ["No open PRs", "Refresh"] as const
const EMPTY_CODEX_ROWS = ["No Codex threads", "Refresh"] as const
const EMPTY_NOTIFICATION_ROWS = ["No notifications", "Refresh"] as const
const LOADING_ROWS = ["Loading status", "Refresh"] as const
const LIST_OPTIONS = {
  x: 24,
  y: 16,
  width: 528,
  height: 256,
  borderWidth: 1,
  borderColor: 13,
  borderRadius: 8,
  paddingLength: 8,
  itemWidth: 500,
  showSelectionBorder: true,
} as const

type GlassScreen = "focus" | "main" | "summary" | "prList" | "codexList" | "prDetail" | "codexDetail" | "notifications"

interface StoredSettings {
  endpoint?: string
  selectedView?: DevHudView
}

class DevHudController {
  private readonly unsubs: Array<() => void> = []
  private endpoint = DEFAULT_ENDPOINT
  private selectedView: DevHudView = "summary"
  private screen: GlassScreen = "main"
  private status: DevHudStatus | null = null
  private loading = false
  private lastError: string | null = null
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private interruptTimer: ReturnType<typeof setTimeout> | null = null
  private activeInterrupt: DevHudNotification | null = null
  private interruptActiveUntil = 0
  private ignoreTouchUntil = 0
  private deliveredNotificationIds = new Set<string>()
  private selectedIndex = 0
  private activeRows: string[] = []
  private activePrs: PullRequestSummary[] = []
  private activeThreads: CodexThreadSummary[] = []
  private activeNotifications: DevHudNotification[] = []
  private selectedPr: PullRequestSummary | null = null
  private selectedThread: CodexThreadSummary | null = null
  private ui!: {
    send: Send
    on: On
    onOpen: (cb: () => void) => () => void
  }

  constructor(private readonly session: MiniappSession) {}

  async start(): Promise<void> {
    this.ui = this.session.ui as unknown as {
      send: Send
      on: On
      onOpen: (cb: () => void) => () => void
    }
    await this.loadSettings()
    this.screen = screenForView(this.selectedView)
    this.wireUI()
    this.unsubs.push(this.session.input.onTouch((event) => this.handleTouch(event)))
    this.session.display.showTextWall("Dev HUD\nLoading local status...", {durationMs: DISPLAY_MS})
    await this.refresh({forceRender: true})
    this.pollTimer = setInterval(() => {
      void this.refresh()
    }, POLL_MS)
  }

  stop(): void {
    if (this.pollTimer) clearInterval(this.pollTimer)
    this.pollTimer = null
    this.clearInterruptTimer()
    for (const unsub of this.unsubs) {
      try {
        unsub()
      } catch {
        /* ignore */
      }
    }
    this.unsubs.length = 0
  }

  private wireUI(): void {
    this.unsubs.push(this.ui.onOpen(() => this.sendSnapshot()))
    this.unsubs.push(this.ui.on("devhud:request-snapshot", () => this.sendSnapshot()))
    this.unsubs.push(this.ui.on("devhud:refresh", () => void this.refresh({forceRender: true})))
    this.unsubs.push(
      this.ui.on("devhud:set-endpoint", ({endpoint}) => {
        void this.setEndpoint(endpoint)
      }),
    )
    this.unsubs.push(
      this.ui.on("devhud:set-view", ({view}) => {
        void this.setView(view)
      }),
    )
    this.unsubs.push(this.ui.on("devhud:show-target", (target) => this.showTargetFromUI(target)))
    this.unsubs.push(this.ui.on("devhud:close-detail-on-glasses", ({view}) => this.closeDetailFromUI(view)))
  }

  private async loadSettings(): Promise<void> {
    try {
      const raw = await this.session.storage.get(SETTINGS_KEY)
      if (!raw) return
      const parsed = JSON.parse(raw) as StoredSettings
      if (typeof parsed.endpoint === "string" && parsed.endpoint.trim()) {
        this.endpoint = normalizeEndpoint(parsed.endpoint)
      }
      if (isDevHudView(parsed.selectedView)) this.selectedView = parsed.selectedView
    } catch (err) {
      console.log("DevHUD: failed to load settings", err)
    }
  }

  private async saveSettings(): Promise<void> {
    try {
      await this.session.storage.set(
        SETTINGS_KEY,
        JSON.stringify({endpoint: this.endpoint, selectedView: this.selectedView} satisfies StoredSettings),
      )
    } catch (err) {
      console.log("DevHUD: failed to save settings", err)
    }
  }

  private async setEndpoint(endpoint: string): Promise<void> {
    this.endpoint = normalizeEndpoint(endpoint)
    await this.saveSettings()
    this.sendSnapshot()
    await this.refresh({forceRender: true})
  }

  private async setView(view: DevHudView): Promise<void> {
    this.selectedView = view
    this.screen = screenForView(view)
    this.selectedPr = null
    this.selectedThread = null
    await this.saveSettings()
    this.sendSnapshot()
    this.renderDisplay()
  }

  private async refresh(options: {forceRender?: boolean} = {}): Promise<void> {
    if (this.loading) return
    this.setLoading(true)
    const hadStatus = this.status !== null
    try {
      const res = await fetch(`${this.endpoint}/api/status`, {headers: {"Accept": "application/json"}})
      if (!res.ok) throw new Error(`sidecar ${res.status}`)
      const status = (await res.json()) as DevHudStatus
      this.status = status
      this.lastError = null
      this.ui.send("devhud:status", status)
      const didInterrupt = hadStatus ? this.deliverNotifications(status) : this.rememberDeliveredNotifications(status)
      if (!didInterrupt && this.shouldRenderAfterRefresh(hadStatus, options.forceRender === true)) {
        this.renderDisplay()
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Status refresh failed"
      this.lastError = message
      this.ui.send("devhud:error", {message})
      this.session.display.showTextWall(`Dev HUD\nSidecar offline\n${this.endpoint}`, {durationMs: DISPLAY_MS})
      console.log(`DevHUD: refresh failed: ${message}`)
    } finally {
      this.setLoading(false)
      this.sendSnapshot()
    }
  }

  private shouldRenderAfterRefresh(hadStatus: boolean, forceRender: boolean): boolean {
    if (forceRender || !hadStatus) return true
    // Recreating a native list resets the visible G2 highlight. Keep list
    // screens stable during background polling; explicit refreshes redraw them.
    return this.screen !== "focus" && this.screen !== "prList" && this.screen !== "codexList"
  }

  private setLoading(loading: boolean): void {
    this.loading = loading
    this.ui.send("devhud:loading", {loading})
  }

  private sendSnapshot(): void {
    const snapshot: DevHudSnapshot = {
      endpoint: this.endpoint,
      status: this.status,
      loading: this.loading,
      lastError: this.lastError,
      selectedView: this.selectedView,
    }
    this.ui.send("devhud:snapshot", snapshot)
  }

  private renderDisplay(): void {
    if (Date.now() < this.interruptActiveUntil) return
    if (this.screen === "focus") {
      this.showFocus()
    } else if (this.screen === "main") {
      this.showMainMenu()
    } else if (this.screen === "summary") {
      this.showSummary()
    } else if (this.screen === "prList") {
      this.showPrList()
    } else if (this.screen === "codexList") {
      this.showCodexList()
    } else if (this.screen === "prDetail") {
      this.showSelectedPrDetail()
    } else if (this.screen === "codexDetail") {
      this.showSelectedThreadDetail()
    } else {
      this.showNotifications()
    }
  }

  private handleTouch(event: TouchData): void {
    if (Date.now() < this.ignoreTouchUntil) return

    if (Date.now() < this.interruptActiveUntil) {
      if (event.kind === "double_click") {
        this.dismissInterrupt()
        this.renderDisplay()
      } else if (event.kind === "click") {
        const interrupt = this.activeInterrupt
        this.dismissInterrupt()
        if (interrupt) this.openNotificationTarget(interrupt)
        else this.renderDisplay()
      }
      return
    }

    if (event.kind === "double_click") {
      this.handleDoubleClick()
      return
    }

    if (this.screen === "focus") {
      this.ignoreTouchUntil = Date.now() + 750
      this.openScreen("main", this.selectedView)
      return
    }

    if (event.kind !== "click") {
      this.updateSelectedIndex(event)
      return
    }

    this.updateSelectedIndex(event)
    if (this.screen === "main") {
      this.handleMainMenuClick()
    } else if (this.screen === "prList") {
      this.handlePrListClick()
    } else if (this.screen === "codexList") {
      this.handleCodexListClick()
    } else if (this.screen === "notifications") {
      this.handleNotificationsClick()
    }
  }

  private handleMainMenuClick(): void {
    const row = this.activeRows[this.selectedIndex]
    if (row === "Summary") {
      this.openScreen("summary", "summary")
    } else if (row === "Pull Requests") {
      this.openScreen("prList", "github")
    } else if (row === "Codex Threads") {
      this.openScreen("codexList", "codex")
    } else if (row === "Notifications") {
      this.openScreen("notifications", "notifications")
    } else if (row === "Refresh") {
      this.session.display.showTextWall("Dev HUD\nRefreshing...", {durationMs: 2_000})
      void this.refresh({forceRender: true})
    }
  }

  private handlePrListClick(): void {
    if (this.activePrs.length === 0) {
      const row = this.activeRows[this.selectedIndex]
      if (row === "Refresh") void this.refresh({forceRender: true})
      return
    }

    const pr = this.activePrs[this.selectedIndex] ?? this.activePrs[0]
    if (!pr) return
    this.selectedPr = pr
    this.screen = "prDetail"
    this.ui.send("devhud:open-target", {type: "pr", id: pr.id})
    this.showSelectedPrDetail()
  }

  private handleCodexListClick(): void {
    if (this.activeThreads.length === 0) {
      const row = this.activeRows[this.selectedIndex]
      if (row === "Refresh") void this.refresh({forceRender: true})
      return
    }

    const thread = this.activeThreads[this.selectedIndex] ?? this.activeThreads[0]
    if (!thread) return
    this.selectedThread = thread
    this.screen = "codexDetail"
    this.ui.send("devhud:open-target", {type: "codexThread", id: thread.id})
    this.showSelectedThreadDetail()
  }

  private handleNotificationsClick(): void {
    if (this.activeNotifications.length === 0) {
      const row = this.activeRows[this.selectedIndex]
      if (row === "Refresh") void this.refresh({forceRender: true})
      return
    }

    const event = this.activeNotifications[this.selectedIndex] ?? this.activeNotifications[0]
    if (!event) return
    this.openNotificationTarget(event)
  }

  private handleDoubleClick(): void {
    if (this.screen === "prDetail") {
      this.screen = "prList"
      this.selectedPr = null
      this.ui.send("devhud:close-detail", {})
      this.renderDisplay()
      return
    }
    if (this.screen === "codexDetail") {
      this.screen = "codexList"
      this.selectedThread = null
      this.ui.send("devhud:close-detail", {})
      this.renderDisplay()
      return
    }
    if (this.screen === "summary") {
      this.openScreen("main", "summary")
      return
    }
    if (this.screen === "prList" || this.screen === "codexList" || this.screen === "notifications") {
      this.openScreen("main", "summary")
      return
    }
    if (this.screen === "main") {
      this.openScreen("focus", this.selectedView)
    }
  }

  private updateSelectedIndex(event: TouchData): void {
    const rows = this.activeRows
    if (rows.length === 0) {
      this.selectedIndex = 0
      return
    }

    if (event.selectedItemName) {
      const fromName = rows.indexOf(event.selectedItemName)
      if (fromName >= 0) {
        this.selectedIndex = fromName
        return
      }
    }

    if (typeof event.selectedItemIndex === "number" && Number.isFinite(event.selectedItemIndex)) {
      this.selectedIndex = clampIndex(Math.trunc(event.selectedItemIndex), rows.length)
    }
  }

  private openScreen(screen: GlassScreen, view: DevHudView): void {
    this.screen = screen
    this.selectedView = view
    this.selectedPr = null
    this.selectedThread = null
    void this.saveSettings()
    this.sendSnapshot()
    this.renderDisplay()
  }

  private openNotificationTarget(event: DevHudNotification): void {
    if (event.target.type === "pr") {
      const pr = this.status?.github.openPrs.find((item) => item.id === event.target.id)
      this.selectedView = "github"
      this.screen = "prDetail"
      this.selectedPr = pr ?? null
      this.selectedThread = null
    } else {
      const thread = this.status?.codex.threads.find((item) => item.id === event.target.id)
      this.selectedView = "codex"
      this.screen = "codexDetail"
      this.selectedThread = thread ?? null
      this.selectedPr = null
    }
    this.ui.send("devhud:open-target", event.target)
    void this.saveSettings()
    this.sendSnapshot()
    this.renderDisplay()
  }

  private showTargetFromUI(target: {type: "pr"; id: string} | {type: "codexThread"; id: string}): void {
    if (target.type === "pr") {
      const pr = this.status?.github.openPrs.find((item) => item.id === target.id)
      this.selectedView = "github"
      this.screen = "prDetail"
      this.selectedPr = pr ?? null
      this.selectedThread = null
    } else {
      const thread = this.status?.codex.threads.find((item) => item.id === target.id)
      this.selectedView = "codex"
      this.screen = "codexDetail"
      this.selectedThread = thread ?? null
      this.selectedPr = null
    }
    void this.saveSettings()
    this.sendSnapshot()
    this.renderDisplay()
  }

  private closeDetailFromUI(view: "github" | "codex"): void {
    this.selectedView = view
    if (view === "github") {
      this.screen = "prList"
      this.selectedPr = null
    } else {
      this.screen = "codexList"
      this.selectedThread = null
    }
    void this.saveSettings()
    this.sendSnapshot()
    this.renderDisplay()
  }

  private showNativeList(rows: readonly string[]): void {
    this.selectedIndex = 0
    this.activeRows = [...rows]
    this.session.display.showSelectableList(this.activeRows, LIST_OPTIONS)
  }

  private showMainMenu(): void {
    this.activePrs = []
    this.activeThreads = []
    this.activeNotifications = []
    this.showNativeList(MAIN_MENU_ROWS)
  }

  private showFocus(): void {
    this.activePrs = []
    this.activeThreads = []
    this.activeNotifications = []
    this.activeRows = []
    this.selectedIndex = 0
    this.session.display.clear()
  }

  private showSummary(): void {
    this.activePrs = []
    this.activeThreads = []
    this.activeNotifications = []
    this.activeRows = []
    if (!this.status) {
      this.session.display.showTextWall("Summary\nLoading status...", {durationMs: DISPLAY_MS})
      return
    }
    this.session.display.showTextWall(formatSummaryDisplay(this.status), {
      durationMs: DISPLAY_MS,
      breakMode: "word",
    })
  }

  private showPrList(): void {
    this.activeThreads = []
    this.activeNotifications = []
    this.activePrs = this.status?.github.openPrs ?? []
    if (!this.status) {
      this.showNativeList(LOADING_ROWS)
      return
    }
    if (this.activePrs.length === 0) {
      this.showNativeList(EMPTY_PR_ROWS)
      return
    }
    this.showNativeList(this.activePrs.map(formatPrRow))
  }

  private showCodexList(): void {
    this.activePrs = []
    this.activeNotifications = []
    this.activeThreads = this.status?.codex.threads ?? []
    if (!this.status) {
      this.showNativeList(LOADING_ROWS)
      return
    }
    if (this.activeThreads.length === 0) {
      this.showNativeList(EMPTY_CODEX_ROWS)
      return
    }
    this.showNativeList(this.activeThreads.map(formatThreadRow))
  }

  private showSelectedPrDetail(): void {
    if (this.status && this.selectedPr) {
      this.selectedPr = this.status.github.openPrs.find((pr) => pr.id === this.selectedPr?.id) ?? this.selectedPr
    }
    if (!this.selectedPr) {
      this.screen = "prList"
      this.showPrList()
      return
    }
    this.session.display.showTextWall(formatPrDetail(this.selectedPr), {breakMode: "word"})
  }

  private showSelectedThreadDetail(): void {
    if (this.status && this.selectedThread) {
      this.selectedThread =
        this.status.codex.threads.find((thread) => thread.id === this.selectedThread?.id) ?? this.selectedThread
    }
    if (!this.selectedThread) {
      this.screen = "codexList"
      this.showCodexList()
      return
    }
    const tasks = this.status?.codex.tasks.filter((task) => task.threadId === this.selectedThread?.id) ?? []
    this.session.display.showTextWall(formatThreadDetail(this.selectedThread, tasks), {breakMode: "word"})
  }

  private showNotifications(): void {
    this.activePrs = []
    this.activeThreads = []
    this.activeNotifications = this.status?.notifications.events ?? []
    if (!this.status) {
      this.showNativeList(LOADING_ROWS)
      return
    }
    if (this.activeNotifications.length === 0) {
      this.showNativeList(EMPTY_NOTIFICATION_ROWS)
      return
    }
    this.showNativeList(this.activeNotifications.map(formatNotificationRow))
  }

  private deliverNotifications(status: DevHudStatus): boolean {
    let interrupt: DevHudNotification | null = null
    for (const event of status.notifications.events.slice().reverse()) {
      if (this.deliveredNotificationIds.has(event.id)) continue
      this.deliveredNotificationIds.add(event.id)
      this.ui.send("devhud:notification", event)
      if (event.interrupt) interrupt = event
    }
    if (this.deliveredNotificationIds.size > 300) {
      this.deliveredNotificationIds = new Set(Array.from(this.deliveredNotificationIds).slice(-150))
    }
    if (!interrupt) return false
    this.activeInterrupt = interrupt
    this.interruptActiveUntil = Date.now() + NOTIFICATION_DISPLAY_MS
    this.clearInterruptTimer()
    this.session.display.showTextWall(formatNotificationDisplay(interrupt), {
      durationMs: NOTIFICATION_DISPLAY_MS,
      breakMode: "word",
    })
    this.interruptTimer = setTimeout(() => {
      this.activeInterrupt = null
      this.interruptActiveUntil = 0
      this.interruptTimer = null
      this.renderDisplay()
    }, NOTIFICATION_DISPLAY_MS)
    return true
  }

  private rememberDeliveredNotifications(status: DevHudStatus): false {
    for (const event of status.notifications.events) {
      this.deliveredNotificationIds.add(event.id)
    }
    return false
  }

  private clearInterruptTimer(): void {
    if (!this.interruptTimer) return
    clearTimeout(this.interruptTimer)
    this.interruptTimer = null
  }

  private dismissInterrupt(): void {
    this.activeInterrupt = null
    this.interruptActiveUntil = 0
    this.clearInterruptTimer()
  }
}

function formatNotificationDisplay(event: DevHudNotification): string {
  return [`Dev HUD Alert`, event.title, truncate(event.message, 78)].join("\n")
}

function formatSummaryDisplay(status: DevHudStatus): string {
  const openPrs = status.github.openPrs.length
  const failingPrs = status.github.openPrs.filter((pr) => pr.checks.state === "failure").length
  const pendingPrs = status.github.openPrs.filter((pr) => pr.checks.state === "pending").length
  const runningTasks = status.codex.tasks.filter((task) => task.running)
  const latestEvent = status.notifications.events[0]
  const lines = [
    "Summary",
    `PRs: ${openPrs} open, ${failingPrs} failing, ${pendingPrs} pending`,
    `Codex: ${status.codex.threads.length} threads, ${runningTasks.length} running`,
  ]
  if (runningTasks[0]) {
    lines.push(`Task: ${truncate(oneLine(runningTasks[0].command), 82)}`)
  }
  if (latestEvent) {
    lines.push(`Latest: ${truncate(oneLine(latestEvent.title), 80)}`)
  } else {
    lines.push("Latest: no changes yet")
  }
  return lines.join("\n")
}

function formatPrRow(pr: PullRequestSummary): string {
  return `#${pr.number} ${statusEmoji(pr)} ${truncate(oneLine(pr.title), 42)}`
}

function formatThreadRow(thread: CodexThreadSummary): string {
  return `${threadStateLabel(thread.state)} ${truncate(oneLine(thread.title), 38)} [${shortId(thread.id)}]`
}

function formatNotificationRow(event: DevHudNotification): string {
  return `${eventLabel(event)} ${formatClock(event.timestamp)} ${truncate(oneLine(event.title), 34)} [${shortEventId(event.id)}]`
}

function formatPrDetail(pr: PullRequestSummary): string {
  const lines = [
    `PR #${pr.number} ${statusEmoji(pr)}`,
    truncate(oneLine(pr.title), 92),
    `${pr.repo} ${pr.branch ?? "unknown"} -> ${pr.base ?? "unknown"}`,
    `Checks: ${formatCheckState(pr.checks.state)} ${pr.checks.success}/${pr.checks.total} ok, ${pr.checks.failure} fail, ${pr.checks.pending} pending`,
    `Review: ${formatReviewState(pr.reviewState)}`,
  ]

  const failedOrPending = pr.checks.items
    .filter((item) => item.state === "failure" || item.state === "pending")
    .slice(0, 3)
  for (const item of failedOrPending) {
    lines.push(`${item.state.toUpperCase()}: ${truncate(oneLine(item.name), 72)}`)
  }

  const comments = pr.reviewComments.filter((comment) => oneLine(comment.body).length > 0)
  if (comments.length > 0) {
    lines.push("Review comments:")
    for (const comment of comments.slice(0, 3)) {
      const location = comment.path ? ` ${basename(comment.path)}${comment.line ? `:${comment.line}` : ""}` : ""
      lines.push(`${comment.author}${location}`)
      lines.push(truncate(oneLine(comment.body), 92))
    }
    if (comments.length > 3) lines.push(`+${comments.length - 3} more comments`)
  } else {
    lines.push("Review comments: none")
  }

  return lines.join("\n")
}

function formatThreadDetail(thread: CodexThreadSummary, tasks: CodexTaskSummary[]): string {
  const lines = [
    `Codex ${threadStateLabel(thread.state)}`,
    truncate(oneLine(thread.title), 92),
    `Branch: ${thread.branch ?? "unknown"}`,
    `CWD: ${basename(thread.cwd)}`,
    `Updated ${formatClock(thread.updatedAt)}`,
  ]

  const runningTasks = tasks.filter((task) => task.running)
  if (runningTasks.length > 0) {
    lines.push("Running:")
    for (const task of runningTasks.slice(0, 3)) {
      lines.push(truncate(oneLine(task.command), 96))
    }
  } else if (thread.runningCommands.length > 0) {
    lines.push("Recent commands:")
    for (const command of thread.runningCommands.slice(0, 3)) {
      lines.push(truncate(oneLine(command), 96))
    }
  } else {
    lines.push("No running tasks.")
  }

  return lines.join("\n")
}

function formatNotificationsDisplay(status: DevHudStatus): string {
  const lines = ["Notifications"]
  const events = status.notifications.events.slice(0, 4)
  if (events.length === 0) lines.push("No changes yet")
  for (const event of events) {
    lines.push(`${eventLabel(event)} ${truncate(event.title, 44)}`)
  }
  return lines.join("\n")
}

function statusEmoji(pr: PullRequestSummary): string {
  if (pr.isDraft) return "DRAFT"
  if (pr.checks.state === "failure") return "FAIL"
  if (pr.reviewState === "changes_requested") return "FIX"
  if (pr.checks.state === "pending") return "WAIT"
  if (pr.reviewState === "approved") return "OK"
  return "OPEN"
}

function screenForView(view: DevHudView): GlassScreen {
  if (view === "github") return "prList"
  if (view === "codex") return "codexList"
  if (view === "notifications") return "notifications"
  return "main"
}

function clampIndex(index: number, length: number): number {
  if (length <= 0) return 0
  return Math.max(0, Math.min(index, length - 1))
}

function formatCheckState(state: PullRequestSummary["checks"]["state"]): string {
  if (state === "success") return "passing"
  if (state === "failure") return "failing"
  if (state === "pending") return "pending"
  return "unknown"
}

function formatReviewState(state: PullRequestSummary["reviewState"]): string {
  if (state === "changes_requested") return "changes requested"
  if (state === "review_required") return "review required"
  if (state === "approved") return "approved"
  if (state === "none") return "none"
  return "unknown"
}

function threadStateLabel(state: CodexThreadSummary["state"]): string {
  if (state === "running") return "RUN"
  if (state === "done" || state === "active") return "DONE"
  if (state === "recent") return "RECENT"
  return "STALE"
}

function normalizeEndpoint(endpoint: string): string {
  const trimmed = endpoint.trim()
  if (!trimmed) return DEFAULT_ENDPOINT
  return trimmed.replace(/\/+$/, "")
}

function formatClock(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], {hour: "numeric", minute: "2-digit"})
}

function truncate(text: string, max: number): string {
  const compact = oneLine(text)
  if (compact.length <= max) return compact
  return `${compact.slice(0, Math.max(0, max - 1)).trimEnd()}...`
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim()
}

function basename(path: string): string {
  const parts = path.split("/").filter(Boolean)
  return parts[parts.length - 1] ?? path
}

function shortId(id: string): string {
  return id.replace(/-/g, "").slice(0, 6)
}

function shortEventId(id: string): string {
  return id.replace(/[^a-z0-9]/gi, "").slice(-5)
}

function isDevHudView(value: unknown): value is DevHudView {
  return value === "summary" || value === "github" || value === "codex" || value === "notifications"
}

function eventLabel(event: DevHudNotification): string {
  if (event.severity === "critical") return "!"
  if (event.severity === "warning") return "?"
  if (event.severity === "success") return "OK"
  return "-"
}

registerMiniapp((session) => {
  const controller = new DevHudController(session)
  void controller.start()
  session.onBeforeDisconnect(() => controller.stop())
})
