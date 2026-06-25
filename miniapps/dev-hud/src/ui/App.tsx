import {useEffect, useMemo, useState, type ReactNode} from "react"
import {useSafeArea} from "@mentra/miniapp/ui"
import {
  AlertCircle,
  Bell,
  CheckCircle2,
  ChevronLeft,
  CircleDashed,
  Clock3,
  ExternalLink,
  GitPullRequest,
  Loader2,
  MessageSquare,
  RadioTower,
  RefreshCw,
  TerminalSquare,
} from "lucide-react"

import type {
  CheckState,
  CodexTaskSummary,
  CodexThreadSummary,
  DevHudNotification,
  DevHudSnapshot,
  DevHudStatus,
  DevHudView,
  NotificationTarget,
  PullRequestCheckItem,
  PullRequestReviewNote,
  PullRequestSummary,
  ReviewState,
} from "../shared/types"

const EMPTY_SNAPSHOT: DevHudSnapshot = {
  endpoint: "",
  status: null,
  loading: true,
  lastError: null,
  selectedView: "summary",
}

type DetailTarget = NotificationTarget

export function App() {
  const {insets, capsuleMenu} = useSafeArea()
  const [snapshot, setSnapshot] = useState<DevHudSnapshot>(EMPTY_SNAPSHOT)
  const [endpointDraft, setEndpointDraft] = useState("")
  const [detailTarget, setDetailTarget] = useState<DetailTarget | null>(null)

  useEffect(() => {
    const unsubs = [
      mentra.on("devhud:snapshot", (next: DevHudSnapshot) => {
        setSnapshot(next)
        setEndpointDraft(next.endpoint)
      }),
      mentra.on("devhud:status", (status: DevHudStatus) => {
        setSnapshot((current) => ({...current, status, lastError: null}))
      }),
      mentra.on("devhud:notification", (event: DevHudNotification) => {
        setSnapshot((current) => {
          if (!current.status) return current
          const exists = current.status.notifications.events.some((item) => item.id === event.id)
          if (exists) return current
          return {
            ...current,
            status: {
              ...current.status,
              notifications: {
                ...current.status.notifications,
                events: [event, ...current.status.notifications.events],
              },
            },
          }
        })
      }),
      mentra.on("devhud:open-target", (target: DetailTarget) => {
        openTarget(target, {syncGlasses: false})
      }),
      mentra.on("devhud:close-detail", () => {
        closeDetail({syncGlasses: false})
      }),
      mentra.on("devhud:error", ({message}) => {
        setSnapshot((current) => ({...current, lastError: message}))
      }),
      mentra.on("devhud:loading", ({loading}) => {
        setSnapshot((current) => ({...current, loading}))
      }),
    ]
    mentra.send("devhud:request-snapshot", {})
    return () => {
      for (const unsub of unsubs) unsub()
    }
  }, [])

  const status = snapshot.status
  const counts = useMemo(() => summarize(status), [status])
  const headerPaddingRight = capsuleMenu ? Math.max(20, capsuleMenu.width + 20) : 20

  const openTarget = (target: DetailTarget, options: {syncGlasses?: boolean} = {}) => {
    setDetailTarget(target)
    const view: DevHudView = target.type === "pr" ? "github" : "codex"
    setSnapshot((current) => ({...current, selectedView: view}))
    if (options.syncGlasses !== false) {
      mentra.send("devhud:show-target", target)
    }
  }

  const closeDetail = (options: {syncGlasses?: boolean} = {}) => {
    const target = detailTarget
    setDetailTarget(null)
    if (options.syncGlasses === false || !target) return
    mentra.send("devhud:close-detail-on-glasses", {view: target.type === "pr" ? "github" : "codex"})
  }

  const selectView = (view: DevHudView) => {
    setDetailTarget(null)
    setSnapshot((current) => ({...current, selectedView: view}))
    mentra.send("devhud:set-view", {view})
  }

  return (
    <div
      className="h-screen w-screen overflow-hidden bg-[#f5f6f4] text-neutral-900"
      style={{
        paddingTop: insets.top,
        paddingBottom: insets.bottom,
        paddingLeft: insets.left,
        paddingRight: insets.right,
      }}>
      <div className="flex h-full min-h-0 flex-col">
        <header
          className="border-b border-neutral-200 bg-white px-4 pb-3 pt-3"
          style={{paddingRight: headerPaddingRight}}>
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <div className="flex h-9 w-9 items-center justify-center rounded-md bg-[#1f7a6d] text-white">
                  <RadioTower size={19} />
                </div>
                <div className="min-w-0">
                  <h1 className="m-0 truncate text-lg font-bold">Dev HUD</h1>
                  <p className="m-0 truncate text-xs text-neutral-500">
                    {status ? `Updated ${formatTime(status.generatedAt)}` : "Waiting for local sidecar"}
                  </p>
                </div>
              </div>
            </div>
            <button
              aria-label="Refresh"
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-neutral-200 bg-white text-neutral-700"
              onClick={() => mentra.send("devhud:refresh", {})}>
              <RefreshCw size={18} className={snapshot.loading ? "animate-spin" : ""} />
            </button>
          </div>
        </header>

        <ViewSwitch selectedView={snapshot.selectedView} onSelect={selectView} notificationCount={status?.notifications.events.length ?? 0} />

        <main className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
          {snapshot.lastError ? <ErrorBanner message={snapshot.lastError} endpoint={snapshot.endpoint} /> : null}
          {detailTarget && status ? (
            <DetailView status={status} target={detailTarget} onBack={closeDetail} />
          ) : (
            <>
              {snapshot.selectedView === "summary" ? <SummaryView status={status} counts={counts} onOpenTarget={openTarget} /> : null}
              {snapshot.selectedView === "github" ? <GitHubView prs={status?.github.openPrs ?? []} onOpenPr={(id) => openTarget({type: "pr", id})} /> : null}
              {snapshot.selectedView === "codex" ? (
                <CodexView
                  threads={status?.codex.threads ?? []}
                  tasks={status?.codex.tasks ?? []}
                  onOpenThread={(id) => openTarget({type: "codexThread", id})}
                />
              ) : null}
              {snapshot.selectedView === "notifications" ? (
                <NotificationsView events={status?.notifications.events ?? []} onOpenTarget={openTarget} />
              ) : null}
            </>
          )}
        </main>

        <footer className="border-t border-neutral-200 bg-white px-4 py-3">
          <form
            className="flex items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault()
              mentra.send("devhud:set-endpoint", {endpoint: endpointDraft})
            }}>
            <input
              aria-label="Sidecar endpoint"
              value={endpointDraft}
              onChange={(event) => setEndpointDraft(event.currentTarget.value)}
              className="h-10 min-w-0 flex-1 rounded-md border border-neutral-200 bg-neutral-50 px-3 text-sm text-neutral-900 outline-none focus:border-[#1f7a6d]"
              spellCheck={false}
            />
            <button className="h-10 rounded-md bg-neutral-900 px-3 text-sm font-semibold text-white" type="submit">
              Save
            </button>
          </form>
        </footer>
      </div>
    </div>
  )
}

function ViewSwitch({
  selectedView,
  notificationCount,
  onSelect,
}: {
  selectedView: DevHudView
  notificationCount: number
  onSelect: (view: DevHudView) => void
}) {
  return (
    <nav className="grid grid-cols-4 gap-1 border-b border-neutral-200 bg-white px-4 py-2">
      <TabButton active={selectedView === "summary"} label="Home" onClick={() => onSelect("summary")}>
        <RadioTower size={15} />
      </TabButton>
      <TabButton active={selectedView === "github"} label="PRs" onClick={() => onSelect("github")}>
        <GitPullRequest size={15} />
      </TabButton>
      <TabButton active={selectedView === "codex"} label="Codex" onClick={() => onSelect("codex")}>
        <TerminalSquare size={15} />
      </TabButton>
      <TabButton active={selectedView === "notifications"} label={notificationCount > 0 ? String(notificationCount) : "Log"} onClick={() => onSelect("notifications")}>
        <Bell size={15} />
      </TabButton>
    </nav>
  )
}

function TabButton({active, label, onClick, children}: {active: boolean; label: string; onClick: () => void; children: ReactNode}) {
  return (
    <button
      className={`flex h-9 items-center justify-center gap-1 rounded-md text-xs font-semibold ${
        active ? "bg-[#1f7a6d] text-white" : "bg-neutral-100 text-neutral-600"
      }`}
      onClick={onClick}>
      {children}
      <span>{label}</span>
    </button>
  )
}

function SummaryView({
  status,
  counts,
  onOpenTarget,
}: {
  status: DevHudStatus | null
  counts: SummaryCounts
  onOpenTarget: (target: DetailTarget) => void
}) {
  if (!status) return <EmptyState title="No status yet" detail="The local sidecar has not answered." />
  const runningTasks = status.codex.tasks.filter((task) => task.running)
  const latestThread = status.codex.threads[0]
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2">
        <Metric label="Open PRs" value={counts.openPrs} tone={counts.failedPrs > 0 ? "bad" : "good"} />
        <Metric label="Codex Tasks" value={runningTasks.length} tone={runningTasks.length > 0 ? "warn" : "quiet"} />
        <Metric label="Failing Checks" value={counts.failedPrs} tone={counts.failedPrs > 0 ? "bad" : "quiet"} />
        <Metric label="Events" value={status.notifications.events.length} tone={status.notifications.events.some((event) => event.severity === "critical") ? "bad" : "quiet"} />
      </div>

      {status.notifications.events[0] ? <NotificationRow event={status.notifications.events[0]} onOpenTarget={onOpenTarget} /> : null}
      {status.github.openPrs[0] ? <PullRequestRow pr={status.github.openPrs[0]} compact onOpen={() => onOpenTarget({type: "pr", id: status.github.openPrs[0].id})} /> : null}
      {latestThread ? <ThreadRow thread={latestThread} compact onOpen={() => onOpenTarget({type: "codexThread", id: latestThread.id})} /> : null}
      {runningTasks.length > 0 ? <TaskRow task={runningTasks[0]} onOpen={() => onOpenTarget({type: "codexThread", id: runningTasks[0].threadId})} /> : null}
    </div>
  )
}

function GitHubView({prs, onOpenPr}: {prs: PullRequestSummary[]; onOpenPr: (id: string) => void}) {
  if (prs.length === 0) return <EmptyState title="No open PRs" detail="GitHub did not return open authored PRs." />
  return (
    <div className="space-y-2">
      {prs.map((pr) => (
        <PullRequestRow key={pr.id} pr={pr} onOpen={() => onOpenPr(pr.id)} />
      ))}
    </div>
  )
}

function CodexView({
  threads,
  tasks,
  onOpenThread,
}: {
  threads: CodexThreadSummary[]
  tasks: CodexTaskSummary[]
  onOpenThread: (id: string) => void
}) {
  const runningTasks = tasks.filter((task) => task.running)
  return (
    <div className="space-y-4">
      <section className="space-y-2">
        <SectionTitle icon={<TerminalSquare size={16} />} label="Running Tasks" />
        {runningTasks.length === 0 ? (
          <EmptyState title="No running tasks" detail="Visible PTY tasks will appear here." compact />
        ) : (
          runningTasks.map((task) => <TaskRow key={task.id} task={task} onOpen={() => onOpenThread(task.threadId)} />)
        )}
      </section>
      <section className="space-y-2">
        <SectionTitle icon={<Clock3 size={16} />} label="Recent Threads" />
        {threads.map((thread) => (
          <ThreadRow key={thread.id} thread={thread} onOpen={() => onOpenThread(thread.id)} />
        ))}
      </section>
    </div>
  )
}

function NotificationsView({events, onOpenTarget}: {events: DevHudNotification[]; onOpenTarget: (target: DetailTarget) => void}) {
  if (events.length === 0) return <EmptyState title="No notifications yet" detail="The first poll is a baseline; future changes will appear here." />
  return (
    <div className="space-y-2">
      {events.map((event) => (
        <NotificationRow key={event.id} event={event} onOpenTarget={onOpenTarget} />
      ))}
    </div>
  )
}

function DetailView({status, target, onBack}: {status: DevHudStatus; target: DetailTarget; onBack: () => void}) {
  if (target.type === "pr") {
    const pr = status.github.openPrs.find((item) => item.id === target.id)
    return <PullRequestDetail pr={pr} onBack={onBack} />
  }
  const thread = status.codex.threads.find((item) => item.id === target.id)
  const tasks = status.codex.tasks.filter((task) => task.threadId === target.id)
  return <CodexThreadDetail thread={thread} tasks={tasks} onBack={onBack} />
}

function PullRequestDetail({pr, onBack}: {pr?: PullRequestSummary; onBack: () => void}) {
  if (!pr) return <MissingDetail title="PR not in current open list" onBack={onBack} />
  const checkPresentation = checkStatePresentation(pr.checks.state)
  const reviewPresentation = reviewStatePresentation(pr.reviewState, pr.requestedReviewers.length)
  return (
    <div className="space-y-3">
      <DetailHeader label={`#${pr.number}`} title={pr.title} onBack={onBack} />
      <InfoCard>
        <InfoRow label="Repo" value={pr.repo} />
        <InfoRow label="Branch" value={pr.branch ? `${pr.branch} -> ${pr.base ?? "base"}` : "Unknown"} />
        <InfoRow label="Updated" value={pr.updatedAt ? formatDateTime(pr.updatedAt) : "Unknown"} />
        <div className="mt-3 flex flex-wrap gap-1.5">
          <StatusChip label={checkPresentation.label} tone={checkPresentation.tone} />
          <StatusChip label={reviewPresentation} tone={pr.reviewState === "changes_requested" ? "bad" : "quiet"} />
          {pr.isDraft ? <StatusChip label="Draft" tone="warn" /> : null}
          {pr.mergeState ? <StatusChip label={pr.mergeState.toLowerCase()} tone={isBadMergeState(pr.mergeState) ? "warn" : "quiet"} /> : null}
        </div>
        <a className="mt-3 inline-flex items-center gap-1 text-xs font-bold text-[#1f7a6d]" href={pr.url} target="_blank" rel="noreferrer">
          Open on GitHub <ExternalLink size={13} />
        </a>
      </InfoCard>

      <section className="space-y-2">
        <SectionTitle icon={<CircleDashed size={16} />} label="Checks" />
        {pr.checks.items.length === 0 ? <EmptyState title="No check details" detail="GitHub returned no check rollup items." compact /> : null}
        {pr.checks.items.map((item) => (
          <CheckRow key={`${item.name}-${item.url ?? ""}`} item={item} />
        ))}
      </section>

      <section className="space-y-2">
        <SectionTitle icon={<MessageSquare size={16} />} label="Review Comments" />
        {pr.reviewComments.length === 0 ? <EmptyState title="No review comments" detail="No review bodies or inline comments returned." compact /> : null}
        {pr.reviewComments.map((comment) => (
          <ReviewComment key={comment.id} comment={comment} />
        ))}
      </section>
    </div>
  )
}

function CodexThreadDetail({thread, tasks, onBack}: {thread?: CodexThreadSummary; tasks: CodexTaskSummary[]; onBack: () => void}) {
  if (!thread) return <MissingDetail title="Thread not in current list" onBack={onBack} />
  return (
    <div className="space-y-3">
      <DetailHeader label={threadStateText(thread.state)} title={thread.title} onBack={onBack} />
      <InfoCard>
        <InfoRow label="Directory" value={thread.cwd} />
        <InfoRow label="Branch" value={thread.branch ?? "Unknown"} />
        <InfoRow label="Updated" value={formatTime(thread.updatedAt)} />
      </InfoCard>

      <section className="space-y-2">
        <SectionTitle icon={<TerminalSquare size={16} />} label="Running Commands" />
        {tasks.length === 0 ? <EmptyState title="No running command" detail="This thread is not currently represented by a visible PTY task." compact /> : null}
        {tasks.map((task) => (
          <TaskRow key={task.id} task={task} />
        ))}
      </section>
    </div>
  )
}

function PullRequestRow({pr, compact = false, onOpen}: {pr: PullRequestSummary; compact?: boolean; onOpen: () => void}) {
  const checkPresentation = checkStatePresentation(pr.checks.state)
  const reviewPresentation = reviewStatePresentation(pr.reviewState, pr.requestedReviewers.length)
  return (
    <button className="block w-full rounded-md border border-neutral-200 bg-white p-3 text-left" onClick={onOpen}>
      <div className="flex items-start gap-2">
        <div className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md ${checkPresentation.bg}`}>
          {checkPresentation.icon}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="shrink-0 text-xs font-bold text-neutral-500">#{pr.number}</span>
            <span className="truncate text-xs font-semibold text-neutral-500">{pr.repo}</span>
          </div>
          <h2 className="m-0 mt-1 text-sm font-bold leading-5 text-neutral-900">{pr.title}</h2>
          {!compact ? (
            <div className="mt-2 flex flex-wrap gap-1.5">
              <StatusChip label={checkPresentation.label} tone={checkPresentation.tone} />
              <StatusChip label={reviewPresentation} tone={pr.reviewState === "changes_requested" ? "bad" : "quiet"} />
              {pr.reviewComments.length > 0 ? <StatusChip label={`${pr.reviewComments.length} comments`} tone="quiet" /> : null}
              {pr.isDraft ? <StatusChip label="Draft" tone="warn" /> : null}
            </div>
          ) : null}
        </div>
      </div>
    </button>
  )
}

function ThreadRow({thread, compact = false, onOpen}: {thread: CodexThreadSummary; compact?: boolean; onOpen: () => void}) {
  return (
    <button className="block w-full rounded-md border border-neutral-200 bg-white p-3 text-left" onClick={onOpen}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="m-0 text-sm font-bold leading-5 text-neutral-900">{thread.title}</h2>
          <p className="m-0 mt-1 truncate text-xs text-neutral-500">{basename(thread.cwd)}</p>
        </div>
        <StatusChip label={threadStateText(thread.state)} tone={threadStateTone(thread.state)} />
      </div>
      {!compact && thread.branch ? <p className="m-0 mt-2 truncate text-xs text-neutral-500">{thread.branch}</p> : null}
    </button>
  )
}

function TaskRow({task, onOpen}: {task: CodexTaskSummary; onOpen?: () => void}) {
  const content = (
    <div className="flex items-start gap-2">
      <Loader2 size={17} className="mt-0.5 shrink-0 animate-spin text-[#9a6a00]" />
      <div className="min-w-0 flex-1">
        <h2 className="m-0 text-sm font-bold leading-5 text-neutral-900">{task.title}</h2>
        <p className="m-0 mt-1 truncate font-mono text-xs text-neutral-700">{task.command}</p>
        <p className="m-0 mt-1 text-xs text-neutral-500">{basename(task.cwd)}</p>
      </div>
    </div>
  )
  if (!onOpen) return <article className="rounded-md border border-[#ead79b] bg-[#fff8df] p-3">{content}</article>
  return (
    <button className="block w-full rounded-md border border-[#ead79b] bg-[#fff8df] p-3 text-left" onClick={onOpen}>
      {content}
    </button>
  )
}

function NotificationRow({event, onOpenTarget}: {event: DevHudNotification; onOpenTarget: (target: DetailTarget) => void}) {
  const tone = event.severity === "critical" ? "bad" : event.severity === "warning" ? "warn" : event.severity === "success" ? "good" : "quiet"
  return (
    <button className="block w-full rounded-md border border-neutral-200 bg-white p-3 text-left" onClick={() => onOpenTarget(event.target)}>
      <div className="flex items-start gap-2">
        <div className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md ${toneBg(tone)}`}>
          {event.source === "github" ? <GitPullRequest size={16} /> : <TerminalSquare size={16} />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <h2 className="m-0 min-w-0 truncate text-sm font-bold text-neutral-900">{event.title}</h2>
            <span className="shrink-0 text-[11px] font-semibold text-neutral-500">{formatTime(event.timestamp)}</span>
          </div>
          <p className="m-0 mt-1 line-clamp-2 text-xs leading-4 text-neutral-600">{event.message}</p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <StatusChip label={event.source} tone="quiet" />
            <StatusChip label={event.severity} tone={tone} />
            {event.interrupt ? <StatusChip label="glasses" tone="warn" /> : null}
          </div>
        </div>
      </div>
    </button>
  )
}

function CheckRow({item}: {item: PullRequestCheckItem}) {
  const presentation = checkStatePresentation(item.state)
  const content = (
    <div className="flex items-start gap-2">
      <div className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded ${presentation.bg}`}>
        {presentation.icon}
      </div>
      <div className="min-w-0 flex-1">
        <p className="m-0 text-sm font-bold text-neutral-900">{item.name}</p>
        <p className="m-0 mt-0.5 truncate text-xs text-neutral-500">{item.workflow ?? "status"}</p>
      </div>
    </div>
  )
  if (!item.url) return <article className="rounded-md border border-neutral-200 bg-white p-3">{content}</article>
  return (
    <a className="block rounded-md border border-neutral-200 bg-white p-3" href={item.url} target="_blank" rel="noreferrer">
      {content}
    </a>
  )
}

function ReviewComment({comment}: {comment: PullRequestReviewNote}) {
  const body = (
    <>
      <div className="flex items-center justify-between gap-2">
        <p className="m-0 min-w-0 truncate text-sm font-bold text-neutral-900">{comment.author}</p>
        <StatusChip label={comment.type} tone="quiet" />
      </div>
      {comment.path ? (
        <p className="m-0 mt-1 truncate font-mono text-[11px] text-neutral-500">
          {comment.path}
          {comment.line ? `:${comment.line}` : ""}
        </p>
      ) : null}
      <p className="selectable-text m-0 mt-2 whitespace-pre-wrap break-words text-sm leading-5 text-neutral-700">{comment.body}</p>
    </>
  )
  if (!comment.url) return <article className="rounded-md border border-neutral-200 bg-white p-3">{body}</article>
  return (
    <a className="block rounded-md border border-neutral-200 bg-white p-3" href={comment.url} target="_blank" rel="noreferrer">
      {body}
    </a>
  )
}

function DetailHeader({label, title, onBack}: {label: string; title: string; onBack: () => void}) {
  return (
    <div className="rounded-md border border-neutral-200 bg-white p-3">
      <button className="mb-3 flex h-8 items-center gap-1 rounded-md bg-neutral-100 px-2 text-xs font-bold text-neutral-700" onClick={onBack}>
        <ChevronLeft size={15} />
        Back
      </button>
      <p className="m-0 text-xs font-bold uppercase text-neutral-500">{label}</p>
      <h2 className="m-0 mt-1 text-lg font-bold leading-6 text-neutral-900">{title}</h2>
    </div>
  )
}

function MissingDetail({title, onBack}: {title: string; onBack: () => void}) {
  return (
    <div className="space-y-3">
      <button className="flex h-9 items-center gap-1 rounded-md bg-neutral-900 px-3 text-sm font-bold text-white" onClick={onBack}>
        <ChevronLeft size={15} />
        Back
      </button>
      <EmptyState title={title} detail="The notification still exists, but the item is not present in the latest state snapshot." />
    </div>
  )
}

function InfoCard({children}: {children: ReactNode}) {
  return <section className="rounded-md border border-neutral-200 bg-white p-3">{children}</section>
}

function InfoRow({label, value}: {label: string; value: string}) {
  return (
    <div className="flex items-start justify-between gap-3 py-1">
      <span className="shrink-0 text-xs font-semibold text-neutral-500">{label}</span>
      <span className="min-w-0 break-words text-right text-xs font-medium text-neutral-800">{value}</span>
    </div>
  )
}

function Metric({label, value, tone}: {label: string; value: number; tone: ChipTone}) {
  const color = tone === "bad" ? "#d73a31" : tone === "warn" ? "#9a6a00" : tone === "good" ? "#1f7a6d" : "#737373"
  return (
    <div className="rounded-md border border-neutral-200 bg-white p-3">
      <div className="text-xs font-semibold text-neutral-500">{label}</div>
      <div className="mt-1 text-2xl font-bold" style={{color}}>
        {value}
      </div>
    </div>
  )
}

function ErrorBanner({message, endpoint}: {message: string; endpoint: string}) {
  return (
    <div className="mb-3 rounded-md border border-[#f0b8b8] bg-[#fff0f0] p-3">
      <div className="flex items-start gap-2">
        <AlertCircle size={17} className="mt-0.5 shrink-0 text-[#c02727]" />
        <div className="min-w-0">
          <p className="m-0 text-sm font-bold text-[#901f1f]">Sidecar unavailable</p>
          <p className="m-0 mt-1 break-words text-xs text-[#7a3030]">{message}</p>
          <p className="m-0 mt-1 break-words font-mono text-[11px] text-[#7a3030]">{endpoint}</p>
        </div>
      </div>
    </div>
  )
}

function EmptyState({title, detail, compact = false}: {title: string; detail: string; compact?: boolean}) {
  return (
    <div className={`rounded-md border border-dashed border-neutral-300 bg-white text-center ${compact ? "p-3" : "p-6"}`}>
      <p className="m-0 text-sm font-bold text-neutral-800">{title}</p>
      <p className="m-0 mt-1 text-xs text-neutral-500">{detail}</p>
    </div>
  )
}

function SectionTitle({icon, label}: {icon: ReactNode; label: string}) {
  return (
    <div className="flex items-center gap-1.5 text-xs font-bold uppercase text-neutral-500">
      {icon}
      <span>{label}</span>
    </div>
  )
}

type ChipTone = "good" | "warn" | "bad" | "quiet"

function StatusChip({label, tone}: {label: string; tone: ChipTone}) {
  return <span className={`rounded px-1.5 py-1 text-[11px] font-bold capitalize ${toneClass(tone)}`}>{label}</span>
}

function toneClass(tone: ChipTone): string {
  if (tone === "good") return "bg-[#e6f3ef] text-[#126253]"
  if (tone === "warn") return "bg-[#fff3ca] text-[#815900]"
  if (tone === "bad") return "bg-[#ffe5e5] text-[#b92323]"
  return "bg-neutral-100 text-neutral-600"
}

function toneBg(tone: ChipTone): string {
  if (tone === "good") return "bg-[#e6f3ef] text-[#126253]"
  if (tone === "warn") return "bg-[#fff3ca] text-[#815900]"
  if (tone === "bad") return "bg-[#ffe5e5] text-[#b92323]"
  return "bg-neutral-100 text-neutral-600"
}

function checkStatePresentation(state: CheckState): {label: string; tone: ChipTone; bg: string; icon: ReactNode} {
  if (state === "success") {
    return {label: "checks ok", tone: "good", bg: "bg-[#e6f3ef]", icon: <CheckCircle2 size={17} className="text-[#126253]" />}
  }
  if (state === "failure") {
    return {label: "checks fail", tone: "bad", bg: "bg-[#ffe5e5]", icon: <AlertCircle size={17} className="text-[#b92323]" />}
  }
  if (state === "pending") {
    return {label: "checks pending", tone: "warn", bg: "bg-[#fff3ca]", icon: <CircleDashed size={17} className="text-[#815900]" />}
  }
  return {label: "checks unknown", tone: "quiet", bg: "bg-neutral-100", icon: <CircleDashed size={17} className="text-neutral-500" />}
}

function reviewStatePresentation(state: ReviewState, requestedCount: number): string {
  if (state === "approved") return "approved"
  if (state === "changes_requested") return "changes requested"
  if (state === "review_required") return requestedCount > 0 ? `${requestedCount} requested` : "review"
  if (state === "none") return "no review"
  return "review unknown"
}

function threadStateTone(state: CodexThreadSummary["state"]): ChipTone {
  if (state === "done" || state === "active") return "good"
  if (state === "running") return "warn"
  return "quiet"
}

function threadStateText(state: CodexThreadSummary["state"]): string {
  if (state === "active") return "done"
  return state
}

interface SummaryCounts {
  openPrs: number
  failedPrs: number
}

function summarize(status: DevHudStatus | null): SummaryCounts {
  const prs = status?.github.openPrs ?? []
  return {
    openPrs: prs.length,
    failedPrs: prs.filter((pr) => pr.checks.state === "failure").length,
  }
}

function isBadMergeState(state: string): boolean {
  const normalized = state.toUpperCase()
  return normalized === "BLOCKED" || normalized === "DIRTY" || normalized === "UNKNOWN"
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], {hour: "numeric", minute: "2-digit"})
}

function formatDateTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return `${date.toLocaleDateString([], {month: "short", day: "numeric"})} ${date.toLocaleTimeString([], {hour: "numeric", minute: "2-digit"})}`
}

function basename(path: string): string {
  const normalized = path.replace(/\/+$/, "")
  return normalized.slice(normalized.lastIndexOf("/") + 1) || normalized
}
