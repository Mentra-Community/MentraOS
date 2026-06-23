import {useEffect, useMemo, useState, type CSSProperties, type ReactNode} from "react"
import {useSafeArea} from "@mentra/miniapp/ui"

import MergeLogo from "./assets/merge_logo.png"
import {useDeveloperMode, type HoldHandlers} from "./useDeveloperMode"

import type {
  AnswerLanguage,
  CloudClientStatus,
  FrequencyMode,
  MergeBackendStatus,
  MergeDecision,
  MergeInsight,
  MergeSnapshot,
  MergeSettings,
  MergeTranscript,
} from "../shared/types"

const DEFAULT_STATUS: CloudClientStatus = {status: "disconnected", audioTransport: "none"}
const DEFAULT_SETTINGS: MergeSettings = {frequency: "medium", answerLanguage: "English"}
const ANSWER_LANGUAGES: AnswerLanguage[] = [
  "English",
  "Spanish",
  "French",
  "German",
  "Italian",
  "Portuguese",
  "Japanese",
  "Korean",
  "Chinese",
  "Auto",
]

const MERGE_COLORS = {
  ink: "#202431",
  muted: "#747889",
  pink: "#F45D8B",
  coral: "#FF6F7D",
  sky: "#39BFE9",
  violet: "#8D7BF7",
  peach: "#FF9B62",
  offline: "#4B4B5A",
  surface: "#FFFFFF",
  surfaceTint: "#FFF6F9",
  border: "#F1DCE5",
}

const MERGE_ACTIVE_STYLE: CSSProperties = {
  backgroundColor: MERGE_COLORS.pink,
  color: "#FFFFFF",
  boxShadow: "0 8px 20px rgba(244, 93, 139, 0.24)",
}

// Flat white so the safe-area insets match the white app bar below them
// instead of showing a blue→violet→pink gradient behind the status bar.
const MERGE_SHELL_STYLE: CSSProperties = {
  background: MERGE_COLORS.surface,
}

type MergeTab = "insights" | "settings"
type InsightsMode = "insights" | "activity"
type ActivityFilter = "all" | "shown" | "quiet"

export function App() {
  const {insets, capsuleMenu} = useSafeArea()
  const [activeTab, setActiveTab] = useState<MergeTab>("insights")
  const [showDeveloperInfo, setShowDeveloperInfo] = useState(false)
  const {developerMode, holdHandlers} = useDeveloperMode()
  const [transcripts, setTranscripts] = useState<MergeTranscript[]>([])
  const [insights, setInsights] = useState<MergeInsight[]>([])
  const [decisions, setDecisions] = useState<MergeDecision[]>([])
  const [finalCount, setFinalCount] = useState(0)
  const [interimCount, setInterimCount] = useState(0)
  const [cloudStatus, setCloudStatus] = useState<CloudClientStatus>(DEFAULT_STATUS)
  const [settings, setSettings] = useState<MergeSettings>(DEFAULT_SETTINGS)
  const [backendUrl, setBackendUrl] = useState("http://localhost:3130")
  const [backendStatus, setBackendStatus] = useState<MergeBackendStatus>("idle")
  const [processing, setProcessing] = useState(false)
  const [lastError, setLastError] = useState<string | null>(null)

  useEffect(() => {
    const unsubs = [
      mentra.on("merge:snapshot", (snapshot: MergeSnapshot) => {
        setTranscripts(snapshot.transcripts)
        setInsights(snapshot.insights)
        setDecisions(snapshot.decisions)
        setFinalCount(snapshot.finalCount)
        setInterimCount(snapshot.interimCount)
        setCloudStatus(snapshot.cloudStatus)
        setSettings(snapshot.settings)
        setBackendUrl(snapshot.backendUrl)
        setBackendStatus(snapshot.backendStatus)
        setProcessing(snapshot.processing)
        setLastError(snapshot.lastError)
      }),
      mentra.on("merge:transcript", (entry: MergeTranscript) => {
        setTranscripts((current) => {
          if (entry.utteranceId) {
            const existing = current.findIndex((t) => t.utteranceId === entry.utteranceId)
            if (existing >= 0) {
              const next = [...current]
              next[existing] = entry
              return next
            }
          }
          return [...current, entry].slice(-30)
        })
        if (entry.isFinal) setFinalCount((count) => count + 1)
        else setInterimCount((count) => count + 1)
      }),
      mentra.on("merge:insight", (insight: MergeInsight) => {
        setInsights((current) => [...current.filter((item) => item.id !== insight.id), insight].slice(-50))
      }),
      mentra.on("merge:decision", (decision: MergeDecision) => {
        setDecisions((current) => [...current, decision].slice(-50))
      }),
      mentra.on("merge:cloud-status", (status: CloudClientStatus) => {
        setCloudStatus(status)
      }),
      mentra.on("merge:backend-status", ({status, lastError}) => {
        setBackendStatus(status)
        setLastError(lastError)
      }),
      mentra.on("merge:processing", ({processing}) => {
        setProcessing(processing)
      }),
    ]
    mentra.send("merge:request-snapshot", {})
    return () => {
      for (const unsub of unsubs) unsub()
    }
  }, [])

  const cloudPresentation = useMemo(() => getCloudPresentation(cloudStatus), [cloudStatus])
  const backendPresentation = useMemo(
    () => getBackendPresentation(backendStatus, processing),
    [backendStatus, processing],
  )
  const headerPaddingRight = capsuleMenu ? Math.max(20, capsuleMenu.width + 20) : 20
  const latestTranscript = transcripts.slice().reverse().find((entry) => entry.text.trim().length > 0)
  const latestDecision = decisions[decisions.length - 1]

  return (
    <div
      className="w-screen h-screen flex overflow-hidden font-sans"
      style={{
        ...MERGE_SHELL_STYLE,
        paddingTop: insets.top,
        paddingBottom: insets.bottom,
        paddingLeft: insets.left,
        paddingRight: insets.right,
      }}>
      <div className="min-h-0 flex-1 bg-zinc-100 flex flex-col overflow-hidden">
        <header
          className="pt-4 pb-3 pl-5 bg-white border-b border-[#e3e7e6]"
          style={{paddingRight: headerPaddingRight}}>
          <div className="flex items-center gap-3 min-w-0">
            <img src={MergeLogo} alt="" className="h-10 w-10 flex-shrink-0" />
            <div className="min-w-0">
              <h1 className="m-0 text-xl font-bold truncate">Merge</h1>
              <p className="m-0 mt-0.5 text-sm text-[#6b7280] truncate">
                {processing ? "Thinking..." : insights.length > 0 ? "Listening for useful context" : "Listening"}
              </p>
            </div>
          </div>
        </header>

        {showDeveloperInfo ? (
          <DeveloperInfo
            backendUrl={backendUrl}
            backendStatus={backendStatus}
            cloudStatus={cloudStatus}
            lastError={lastError}
            onBack={() => setShowDeveloperInfo(false)}
          />
        ) : (
          <div className="flex-1 min-h-0 overflow-hidden">
            {activeTab === "settings" ? (
              <SettingsView
                settings={settings}
                developerMode={developerMode}
                onFrequencyChange={(frequency) => {
                  setSettings((current) => ({...current, frequency}))
                  mentra.send("merge:set-frequency", {frequency})
                }}
                onAnswerLanguageChange={(answerLanguage) => {
                  setSettings((current) => ({...current, answerLanguage}))
                  mentra.send("merge:set-answer-language", {answerLanguage})
                }}
                onOpenDeveloperInfo={() => setShowDeveloperInfo(true)}
              />
            ) : (
              <InsightsView
                insights={insights}
                decisions={decisions}
                latestTranscript={latestTranscript}
                latestDecision={latestDecision}
                cloudPresentation={cloudPresentation}
                backendPresentation={backendPresentation}
                lastError={lastError}
                developerMode={developerMode}
              />
            )}
          </div>
        )}

        {!showDeveloperInfo && (
          <BottomNav
            activeTab={activeTab}
            onTabChange={setActiveTab}
            settingsHoldHandlers={holdHandlers}
          />
        )}
      </div>
    </div>
  )
}

function InsightsView({
  insights,
  decisions,
  latestTranscript,
  latestDecision,
  cloudPresentation,
  backendPresentation,
  lastError,
  developerMode,
}: {
  insights: MergeInsight[]
  decisions: MergeDecision[]
  latestTranscript?: MergeTranscript
  latestDecision?: MergeDecision
  cloudPresentation: Presentation
  backendPresentation: BackendPresentation
  lastError: string | null
  developerMode: boolean
}) {
  const [mode, setMode] = useState<InsightsMode>("insights")
  const [expandedInsightId, setExpandedInsightId] = useState<string | null>(null)
  const [expandedDecisionId, setExpandedDecisionId] = useState<string | null>(null)

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {developerMode && (
        <section className="px-4 py-2 bg-white border-b border-[#e3e7e6]">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5 min-w-0 flex-1 overflow-hidden">
              <StatusPill label={cloudPresentation.label} detail={cloudPresentation.detail} color={cloudPresentation.accentColor} />
              <StatusPill label={backendPresentation.label} detail={backendPresentation.detail} color={backendPresentation.dotColor} />
            </div>
            <ModeSwitch mode={mode} onModeChange={setMode} />
          </div>
        </section>
      )}

      <main className="flex-1 min-h-0 overflow-y-auto px-5 pb-4">
        {mode === "activity" ? (
          <ActivityTimeline
            decisions={decisions}
            expandedDecisionId={expandedDecisionId}
            onToggleDecision={(id) => setExpandedDecisionId((current) => (current === id ? null : id))}
          />
        ) : insights.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-center">
            <img src={MergeLogo} alt="" className="h-16 w-16 opacity-90" />
            <h2 className="mt-4 mb-1 text-lg font-bold text-[#202928]">No insights yet</h2>
            <p className="m-0 max-w-[260px] text-sm leading-5 text-[#6b7280]">
              Merge stays quiet until it has something useful to add.
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-3 py-4">
            {insights
              .slice()
              .reverse()
              .map((insight) => {
                const decision = findDecisionForInsight(decisions, insight)
                return (
                  <InsightCard
                    key={insight.id}
                    insight={insight}
                    decision={decision}
                    expanded={expandedInsightId === insight.id}
                    onToggle={() => setExpandedInsightId((current) => (current === insight.id ? null : insight.id))}
                  />
                )
              })}
          </div>
        )}
      </main>

      {developerMode && (
        <LiveDebugTray
          latestTranscript={latestTranscript}
          latestDecision={latestDecision}
          cloudPresentation={cloudPresentation}
          backendPresentation={backendPresentation}
          lastError={lastError}
          onOpenActivity={() => {
            setMode("activity")
            setExpandedDecisionId(latestDecision?.id ?? null)
          }}
        />
      )}
    </div>
  )
}

function SettingsView({
  settings,
  developerMode,
  onFrequencyChange,
  onAnswerLanguageChange,
  onOpenDeveloperInfo,
}: {
  settings: MergeSettings
  developerMode: boolean
  onFrequencyChange: (frequency: FrequencyMode) => void
  onAnswerLanguageChange: (answerLanguage: AnswerLanguage) => void
  onOpenDeveloperInfo: () => void
}) {
  return (
    <div className="h-full overflow-y-auto px-4 py-6 space-y-6 bg-zinc-100">
      <section className="space-y-3">
        <h2 className="text-base font-semibold text-gray-900">AI Settings</h2>
        <div className="bg-white rounded-2xl p-4 shadow-sm border border-gray-100 space-y-5">
          <div className="space-y-3">
            <div className="flex items-center gap-3">
              <LanguageIcon />
              <div>
                <div className="text-base font-medium text-gray-900">Answer language</div>
                <p className="m-0 text-xs leading-4 text-gray-500">
                  Merge can listen across languages but answers in this language.
                </p>
              </div>
            </div>
            <div className="relative">
              <select
                aria-label="Answer language"
                value={settings.answerLanguage}
                onChange={(event) => onAnswerLanguageChange(event.currentTarget.value as AnswerLanguage)}
                className="h-12 w-full appearance-none rounded-xl border border-[#f1dce5] bg-[#fff7fa] px-4 pr-11 text-base font-semibold text-[#202431] outline-none">
                {ANSWER_LANGUAGES.map((language) => (
                  <option key={language} value={language}>
                    {language}
                  </option>
                ))}
              </select>
              <div className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-[#747889]">
                <ChevronDownIcon />
              </div>
            </div>
          </div>

          <div className="h-px bg-gray-100 w-full" />

          <div className="space-y-3">
            <div className="flex items-center gap-3">
              <FrequencyIcon />
              <div>
                <div className="text-base font-medium text-gray-900">Insight frequency</div>
                <p className="m-0 text-xs leading-4 text-gray-500">Controls how eager Merge is to interrupt.</p>
              </div>
            </div>
            <div className="grid grid-cols-3 gap-2">
              {(["low", "medium", "high"] as const).map((frequency) => (
                <button
                  key={frequency}
                  onClick={() => onFrequencyChange(frequency)}
                  className={`h-11 rounded-xl text-sm font-semibold capitalize transition-colors ${
                    settings.frequency === frequency ? "shadow-sm" : "bg-gray-50 text-gray-900 hover:bg-gray-100"
                  }`}
                  style={settings.frequency === frequency ? MERGE_ACTIVE_STYLE : {}}>
                  {frequency}
                </button>
              ))}
            </div>
          </div>
        </div>
      </section>

      {developerMode && (
        <button
          className="w-full py-3 text-xs font-semibold text-zinc-400 hover:text-zinc-600 transition-colors"
          onClick={onOpenDeveloperInfo}>
          Developer info
        </button>
      )}
    </div>
  )
}

function DeveloperInfo({
  backendUrl,
  backendStatus,
  cloudStatus,
  lastError,
  onBack,
}: {
  backendUrl: string
  backendStatus: MergeBackendStatus
  cloudStatus: CloudClientStatus
  lastError: string | null
  onBack: () => void
}) {
  const publicEnv = publicEnvVars()
  return (
    <div className="h-full flex flex-col overflow-hidden bg-zinc-100">
      <div className="bg-white border-b border-zinc-200 px-5 py-3 flex items-center gap-3">
        <button className="h-9 w-9 rounded-full bg-zinc-100 flex items-center justify-center" onClick={onBack} aria-label="Back">
          <BackIcon />
        </button>
        <div>
          <h2 className="m-0 text-lg font-bold text-zinc-900">Developer info</h2>
          <p className="m-0 text-xs text-zinc-500">Public build configuration</p>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto px-4 py-5 space-y-4">
        <InfoCard title="Runtime">
          <InfoRow label="Backend URL" value={backendUrl} />
          <InfoRow label="Backend status" value={backendStatus} />
          <InfoRow label="Cloud status" value={cloudStatus.status} />
          <InfoRow label="Audio transport" value={cloudStatus.audioTransport} />
          <InfoRow label="Last error" value={lastError ?? "None"} />
        </InfoCard>
        <InfoCard title="Public env vars">
          {Object.keys(publicEnv).length === 0 ? (
            <InfoRow label="MENTRA_PUBLIC_*" value="None baked into bundle" />
          ) : (
            Object.entries(publicEnv).map(([key, value]) => <InfoRow key={key} label={key} value={value} />)
          )}
        </InfoCard>
      </div>
    </div>
  )
}

function BottomNav({
  activeTab,
  onTabChange,
  settingsHoldHandlers,
}: {
  activeTab: MergeTab
  onTabChange: (tab: MergeTab) => void
  settingsHoldHandlers?: HoldHandlers
}) {
  return (
    <div className="w-full h-14 bg-white/80 rounded-tl-2xl rounded-tr-2xl backdrop-blur-lg flex justify-center items-stretch">
      <NavButton active={activeTab === "insights"} label="Insights" onClick={() => onTabChange("insights")}>
        <InsightsIcon active={activeTab === "insights"} />
      </NavButton>
      <NavButton
        active={activeTab === "settings"}
        label="Settings"
        onClick={() => onTabChange("settings")}
        holdHandlers={settingsHoldHandlers}>
        <SettingsIcon active={activeTab === "settings"} />
      </NavButton>
    </div>
  )
}

function NavButton({
  active,
  label,
  onClick,
  holdHandlers,
  children,
}: {
  active: boolean
  label: string
  onClick: () => void
  holdHandlers?: HoldHandlers
  children: ReactNode
}) {
  // The button fills its flex cell so the touch target spans the full nav-bar
  // height and half its width; the active pill stays icon-sized inside it.
  return (
    <button
      aria-label={label}
      onClick={onClick}
      onPointerDown={holdHandlers?.onPointerDown}
      onPointerUp={holdHandlers?.onPointerUp}
      onPointerLeave={holdHandlers?.onPointerLeave}
      onPointerCancel={holdHandlers?.onPointerCancel}
      className="flex-1 inline-flex justify-center items-center">
      <span
        className="w-12 h-7 p-2 rounded-3xl inline-flex justify-center items-center transition-colors"
        style={active ? MERGE_ACTIVE_STYLE : {backgroundColor: "transparent"}}>
        {children}
      </span>
    </button>
  )
}

function ModeSwitch({
  mode,
  onModeChange,
}: {
  mode: InsightsMode
  onModeChange: (mode: InsightsMode) => void
}) {
  return (
    <div className="grid grid-cols-2 gap-1 rounded-full bg-zinc-100 p-1 border border-zinc-200 flex-shrink-0">
      {(["insights", "activity"] as const).map((item) => (
        <button
          key={item}
          className={`h-7 min-w-[62px] rounded-full px-2 text-[11px] font-bold capitalize transition-colors ${
            mode === item ? "text-white" : "text-zinc-500"
          }`}
          style={mode === item ? MERGE_ACTIVE_STYLE : {backgroundColor: "transparent"}}
          onClick={() => onModeChange(item)}>
          {item}
        </button>
      ))}
    </div>
  )
}

function InsightCard({
  insight,
  decision,
  expanded,
  onToggle,
}: {
  insight: MergeInsight
  decision?: MergeDecision
  expanded: boolean
  onToggle: () => void
}) {
  return (
    <article className="bg-white border border-[#e0e6e4] rounded-lg p-4 shadow-[0_1px_8px_rgba(16,24,24,0.05)]">
      <button className="w-full text-left" onClick={onToggle}>
        <div className="flex items-start gap-2 mb-2">
          <img src={MergeLogo} alt="" className="h-7 w-7 flex-shrink-0" />
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-2">
              <div className="text-sm font-bold text-[#1e2927] truncate">{insight.agentType || "Merge"}</div>
              <span className="text-[11px] text-[#9aa4a0] flex-shrink-0">{formatTime(insight.timestamp)}</span>
            </div>
            <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
              {insight.displayAction ? <ActionBadge action={insight.displayAction} /> : null}
              {typeof insight.confidence === "number" ? (
                <span className="text-[10px] font-bold uppercase text-zinc-400">
                  {Math.round(insight.confidence * 100)}%
                </span>
              ) : null}
              {insight.profiling ? <ProfilingBadge totalMs={insight.profiling.totalMs} /> : null}
              {insight.sources?.length ? <SourceCountBadge count={insight.sources.length} /> : null}
            </div>
          </div>
        </div>
        <p className="selectable-text m-0 text-base leading-6 text-[#202928] whitespace-pre-wrap break-words">
          {insight.text}
        </p>
      </button>

      {expanded ? (
        <div className="mt-3 space-y-2">
          {decision?.chunkText ? <DetailBlock label="Conversation" text={decision.chunkText} /> : null}
          {insight.reasoning || decision?.reasoning ? (
            <DetailBlock label="Reasoning" text={insight.reasoning ?? decision?.reasoning ?? ""} />
          ) : null}
          <SourcesBlock sources={insight.sources ?? decision?.sources ?? []} searchQueries={insight.searchQueries ?? decision?.searchQueries ?? []} />
          <ProfilingBlock profiling={insight.profiling ?? decision?.profiling} />
        </div>
      ) : null}
    </article>
  )
}

function ActivityTimeline({
  decisions,
  expandedDecisionId,
  onToggleDecision,
}: {
  decisions: MergeDecision[]
  expandedDecisionId: string | null
  onToggleDecision: (id: string) => void
}) {
  const [filter, setFilter] = useState<ActivityFilter>("all")
  const shownCount = decisions.filter((decision) => decision.action === "show" || decision.action === "replace").length
  const quietCount = decisions.length - shownCount
  const filteredDecisions = decisions.filter((decision) => decisionMatchesFilter(decision, filter))

  if (decisions.length === 0) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-center">
        <img src={MergeLogo} alt="" className="h-14 w-14 opacity-80" />
        <h2 className="mt-4 mb-1 text-base font-bold text-[#202928]">No AI activity yet</h2>
        <p className="m-0 max-w-[250px] text-sm leading-5 text-[#6b7280]">
          Decisions appear after Merge analyzes speech.
        </p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-2 py-4">
      <ActivityFilterBar
        filter={filter}
        onFilterChange={setFilter}
        counts={{all: decisions.length, shown: shownCount, quiet: quietCount}}
      />
      {filteredDecisions.length === 0 ? (
        <div className="rounded-lg border border-dashed border-[#dfe6e4] bg-white/70 px-4 py-6 text-center">
          <p className="m-0 text-sm font-semibold text-[#66736f]">No {filter === "shown" ? "shown insights" : "quiet decisions"} yet</p>
        </div>
      ) : (
        filteredDecisions
          .slice()
          .reverse()
          .map((decision) => (
            <ActivityRow
              key={decision.id}
              decision={decision}
              expanded={expandedDecisionId === decision.id}
              onToggle={() => onToggleDecision(decision.id)}
            />
          ))
      )}
    </div>
  )
}

function ActivityFilterBar({
  filter,
  onFilterChange,
  counts,
}: {
  filter: ActivityFilter
  onFilterChange: (filter: ActivityFilter) => void
  counts: Record<ActivityFilter, number>
}) {
  return (
    <div className="sticky top-0 z-10 -mx-5 px-5 pb-2 bg-zinc-100/95 backdrop-blur">
      <div className="grid grid-cols-3 gap-1 rounded-full bg-white p-1 border border-[#e0e6e4] shadow-[0_1px_6px_rgba(16,24,24,0.04)]">
        {(["all", "shown", "quiet"] as const).map((item) => (
          <button
            key={item}
            className={`h-8 rounded-full px-2 text-[11px] font-bold capitalize transition-colors ${
              filter === item ? "text-white" : "text-[#66736f]"
            }`}
            style={filter === item ? MERGE_ACTIVE_STYLE : {backgroundColor: "transparent"}}
            onClick={() => onFilterChange(item)}>
            {item} {counts[item]}
          </button>
        ))}
      </div>
    </div>
  )
}

function ActivityRow({
  decision,
  expanded,
  onToggle,
}: {
  decision: MergeDecision
  expanded: boolean
  onToggle: () => void
}) {
  return (
    <article className="rounded-lg border border-[#e0e6e4] bg-white px-3 py-2 shadow-[0_1px_6px_rgba(16,24,24,0.04)]">
      <button className="w-full text-left" onClick={onToggle}>
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <span className="h-2.5 w-2.5 rounded-full flex-shrink-0" style={{backgroundColor: actionColor(decision.action)}} />
            <span className="text-sm font-bold text-[#202928] truncate">{activityTitle(decision)}</span>
          </div>
          <span className="text-[11px] text-[#9aa4a0] flex-shrink-0">{formatTime(decision.timestamp)}</span>
        </div>
        <p className="m-0 mt-1 text-xs leading-4 text-[#66736f] line-clamp-2">
          {decision.reasoning || decision.insightText || decision.chunkText || "No reasoning recorded"}
        </p>
      </button>

      {expanded ? (
        <div className="mt-2 space-y-2">
          {decision.insightText ? <DetailBlock label="Insight" text={decision.insightText} /> : null}
          <DetailBlock label="Conversation" text={decision.chunkText || "No conversation chunk recorded"} />
          <DetailBlock label="Reasoning" text={decision.reasoning || "No reasoning recorded"} />
          <div className="flex flex-wrap gap-1.5">
            <ActionBadge action={decision.action} />
            <span className="rounded-full bg-zinc-100 px-2 py-1 text-[10px] font-bold uppercase text-zinc-500">
              {decision.trigger}
            </span>
            {decision.urgency ? (
              <span className="rounded-full bg-zinc-100 px-2 py-1 text-[10px] font-bold uppercase text-zinc-500">
                {decision.urgency}
              </span>
            ) : null}
            {typeof decision.confidence === "number" ? (
              <span className="rounded-full bg-zinc-100 px-2 py-1 text-[10px] font-bold uppercase text-zinc-500">
                {Math.round(decision.confidence * 100)}%
              </span>
            ) : null}
            {decision.profiling ? (
              <span className="rounded-full bg-zinc-100 px-2 py-1 text-[10px] font-bold uppercase text-zinc-500">
                {formatDuration(decision.profiling.totalMs)}
              </span>
            ) : null}
          </div>
          <SourcesBlock sources={decision.sources ?? []} searchQueries={decision.searchQueries ?? []} />
          <ProfilingBlock profiling={decision.profiling} />
        </div>
      ) : null}
    </article>
  )
}

function LiveDebugTray({
  latestTranscript,
  latestDecision,
  cloudPresentation,
  backendPresentation,
  lastError,
  onOpenActivity,
}: {
  latestTranscript?: MergeTranscript
  latestDecision?: MergeDecision
  cloudPresentation: Presentation
  backendPresentation: BackendPresentation
  lastError: string | null
  onOpenActivity: () => void
}) {
  const hasProblem = cloudPresentation.dark || backendPresentation.label === "AI offline" || backendPresentation.label === "AI unconfigured"
  const backendText = lastError ? `${backendPresentation.label} · ${lastError}` : backendPresentation.label

  return (
    <footer className="bg-white border-t border-[#e3e7e6] px-5 py-2">
      <button
        className="w-full rounded-lg bg-[#f8faf9] border border-[#e0e6e4] px-3 py-2 text-left"
        onClick={onOpenActivity}>
        <div className="flex items-center justify-between gap-3">
          <span className="text-[11px] font-bold uppercase text-[#7a8581]">Live</span>
          {latestDecision ? (
            <span className="text-[11px] font-bold uppercase" style={{color: actionColor(latestDecision.action)}}>
              {latestDecision.action} · {latestDecision.trigger}
            </span>
          ) : null}
        </div>
        <p className="m-0 mt-1 text-sm leading-5 text-[#2f3b38] line-clamp-1">
          {latestTranscript?.text || "Waiting for speech"}
        </p>
        <div className="mt-1 min-h-4 flex items-center justify-between gap-3 text-[11px] leading-4">
          <span className={`inline-flex min-w-0 items-center gap-1.5 font-semibold ${hasProblem ? "text-[#202431]" : "text-[#8a9692]"}`}>
            <span className="h-1.5 w-1.5 rounded-full flex-shrink-0" style={{backgroundColor: cloudPresentation.accentColor}} />
            <span className="truncate">{cloudPresentation.label}</span>
          </span>
          <span
            className={`min-w-0 truncate text-right font-semibold ${
              backendPresentation.label === "AI offline" ? "text-[#b94a5a]" : "text-[#8a9692]"
            }`}>
            {backendText}
          </span>
        </div>
      </button>
    </footer>
  )
}

function DetailBlock({label, text}: {label: string; text: string}) {
  return (
    <div className="rounded-md bg-[#f8faf9] border border-[#e0e6e4] px-3 py-2">
      <div className="text-[10px] font-bold uppercase text-[#8a9692]">{label}</div>
      <p className="m-0 mt-1 text-xs leading-4 text-[#46524f] whitespace-pre-wrap break-words">{text}</p>
    </div>
  )
}

function SourcesBlock({
  sources,
  searchQueries,
}: {
  sources: NonNullable<MergeInsight["sources"]>
  searchQueries: string[]
}) {
  if (sources.length === 0 && searchQueries.length === 0) return null

  return (
    <div className="rounded-md bg-[#f8faf9] border border-[#e0e6e4] px-3 py-2">
      <div className="text-[10px] font-bold uppercase text-[#8a9692]">Sources</div>
      {sources.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {sources.map((source, index) => (
            <a
              key={`${source.uri}-${index}`}
              href={source.uri}
              target="_blank"
              rel="noreferrer"
              className="max-w-full rounded-full bg-white border border-[#e0e6e4] px-2 py-1 text-[11px] font-semibold text-[#36423f] no-underline truncate">
              {source.domain || source.title}
            </a>
          ))}
        </div>
      ) : (
        <p className="m-0 mt-1 text-xs leading-4 text-[#66736f]">No grounded sources returned.</p>
      )}
      {searchQueries.length > 0 ? (
        <p className="m-0 mt-2 text-[11px] leading-4 text-[#66736f]">
          Searched: {searchQueries.slice(0, 3).join(" · ")}
        </p>
      ) : null}
    </div>
  )
}

function ProfilingBlock({profiling}: {profiling?: MergeInsight["profiling"]}) {
  if (!profiling) return null
  const rows = [
    ["Round trip", profiling.clientRoundTripMs == null ? "n/a" : formatDuration(profiling.clientRoundTripMs)],
    ["Total", formatDuration(profiling.totalMs)],
    ["Gemini", profiling.geminiMs == null ? "n/a" : formatDuration(profiling.geminiMs)],
    ["Parse", profiling.parseMs == null ? "n/a" : formatDuration(profiling.parseMs)],
    ["Search", profiling.webSearchEnabled ? (profiling.grounded ? `grounded · ${profiling.sourceCount}` : "enabled · no sources") : "off"],
    ["Model", profiling.model],
  ] as const

  return (
    <div className="rounded-md bg-[#f8faf9] border border-[#e0e6e4] px-3 py-2">
      <div className="text-[10px] font-bold uppercase text-[#8a9692]">Profiling</div>
      <div className="mt-2 grid grid-cols-2 gap-1.5">
        {rows.map(([label, value]) => (
          <div key={label} className="rounded bg-white border border-[#edf1ef] px-2 py-1">
            <div className="text-[9px] font-bold uppercase text-[#a0aaa6]">{label}</div>
            <div className="mt-0.5 text-[11px] font-semibold text-[#36423f] break-all">{value}</div>
          </div>
        ))}
      </div>
    </div>
  )
}

function ProfilingBadge({totalMs}: {totalMs: number}) {
  return <span className="text-[10px] font-bold uppercase text-zinc-400">{formatDuration(totalMs)}</span>
}

function SourceCountBadge({count}: {count: number}) {
  return <span className="text-[10px] font-bold uppercase text-zinc-400">{count} src</span>
}

function ActionBadge({action}: {action: MergeDecision["action"]}) {
  return (
    <span
      className="rounded-full px-2 py-0.5 text-[10px] font-bold uppercase"
      style={{backgroundColor: `${actionColor(action)}1A`, color: actionColor(action)}}>
      {action}
    </span>
  )
}

function StatusPill({label, detail, color}: {label: string; detail: string; color: string}) {
  return (
    <div className="flex items-center gap-1.5 rounded-full border border-[#dbe3e0] bg-[#f8faf9] px-2 py-1 flex-shrink-0">
      <span className="h-2 w-2 rounded-full flex-shrink-0" style={{backgroundColor: color}} />
      <span className="text-[11px] font-bold text-[#24302d] whitespace-nowrap">{compactStatusLabel(label)}</span>
      <span className="text-[10px] font-bold uppercase text-[#7a8581] whitespace-nowrap">
        {compactStatusDetail(label, detail)}
      </span>
    </div>
  )
}

function InfoCard({title, children}: {title: string; children: ReactNode}) {
  return (
    <section className="bg-white rounded-2xl p-4 shadow-sm border border-gray-100">
      <h3 className="m-0 mb-3 text-sm font-bold text-zinc-900">{title}</h3>
      <div className="space-y-3">{children}</div>
    </section>
  )
}

function InfoRow({label, value}: {label: string; value: string}) {
  return (
    <div>
      <div className="text-[11px] font-bold uppercase text-zinc-400 break-all">{label}</div>
      <div className="mt-0.5 text-sm leading-5 text-zinc-800 break-all">{value}</div>
    </div>
  )
}

type Presentation = {
  label: string
  detail: string
  accentColor: string
  dark: boolean
}

type BackendPresentation = {
  label: string
  detail: string
  dotColor: string
}

function getCloudPresentation(cloudStatus?: CloudClientStatus): Presentation {
  const status = cloudStatus ?? {status: "disconnected", audioTransport: "none"}
  if (status.audioTransport === "offline") {
    return {
      label: "Offline audio",
      detail: "On-device fallback",
      accentColor: MERGE_COLORS.offline,
      dark: true,
    }
  }
  if (status.audioTransport === "ws") {
    return {
      label: "Cloud connected",
      detail: "WebSocket audio",
      accentColor: MERGE_COLORS.sky,
      dark: false,
    }
  }
  if (status.audioTransport === "udp") {
    return {
      label: "Cloud connected",
      detail: "UDP audio",
      accentColor: MERGE_COLORS.pink,
      dark: false,
    }
  }
  if (status.status === "connecting" || status.status === "reconnecting") {
    return {
      label: "Cloud reconnecting",
      detail: "Waiting for Merge",
      accentColor: MERGE_COLORS.peach,
      dark: true,
    }
  }
  return {
    label: "Cloud unavailable",
    detail: "Waiting for runtime",
    accentColor: MERGE_COLORS.offline,
    dark: true,
  }
}

function getBackendPresentation(
  status: MergeBackendStatus,
  processing: boolean,
): BackendPresentation {
  if (processing || status === "processing") {
    return {label: "AI processing", detail: "AI", dotColor: MERGE_COLORS.peach}
  }
  if (status === "ok") {
    return {label: "AI ready", detail: "Backend", dotColor: MERGE_COLORS.sky}
  }
  if (status === "unconfigured") {
    return {label: "AI unconfigured", detail: "Key", dotColor: MERGE_COLORS.peach}
  }
  if (status === "error") {
    return {label: "AI offline", detail: "Backend", dotColor: MERGE_COLORS.coral}
  }
  return {label: "AI idle", detail: "Backend", dotColor: MERGE_COLORS.muted}
}

function compactStatusLabel(label: string): string {
  if (label.startsWith("Cloud")) return "Cloud"
  if (label.startsWith("Offline")) return "Cloud"
  if (label.startsWith("AI")) return "AI"
  return label
}

function compactStatusDetail(label: string, detail: string): string {
  if (detail.toLowerCase().includes("udp")) return "UDP"
  if (detail.toLowerCase().includes("websocket")) return "WS"
  if (detail.toLowerCase().includes("fallback")) return "offline"
  if (label === "Cloud reconnecting") return "retry"
  if (label === "Cloud unavailable") return "off"
  if (label === "AI processing") return "busy"
  if (label === "AI ready") return "ready"
  if (label === "AI unconfigured") return "key"
  if (label === "AI offline") return "off"
  if (label === "AI idle") return "idle"
  return detail
}

function publicEnvVars(): Record<string, string> {
  try {
    return JSON.parse(process.env.MENTRA_PUBLIC_ENV_JSON || "{}") as Record<string, string>
  } catch {
    return {}
  }
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], {hour: "numeric", minute: "2-digit", second: "2-digit"})
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms)) return "n/a"
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`
}

function findDecisionForInsight(decisions: MergeDecision[], insight: MergeInsight): MergeDecision | undefined {
  return decisions
    .slice()
    .reverse()
    .find((decision) => {
      if (decision.insightText === insight.text) return true
      if (decision.action === "silent" || decision.action === "error") return false
      return Math.abs(decision.timestamp - insight.timestamp) <= 2_000
    })
}

function activityTitle(decision: MergeDecision): string {
  if (decision.action === "silent") return "Stayed quiet"
  if (decision.action === "defer") return "Deferred for context"
  if (decision.action === "error") return "Request failed"
  if (decision.action === "drop") return "Dropped insight"
  if (decision.action === "replace") return "Replaced display"
  if (decision.action === "queue") return "Queued insight"
  return "Showed insight"
}

function actionColor(action: MergeDecision["action"]): string {
  if (action === "show" || action === "replace") return MERGE_COLORS.pink
  if (action === "queue") return MERGE_COLORS.sky
  if (action === "defer") return MERGE_COLORS.coral
  if (action === "silent" || action === "drop") return MERGE_COLORS.muted
  return MERGE_COLORS.coral
}

function decisionMatchesFilter(decision: MergeDecision, filter: ActivityFilter): boolean {
  if (filter === "shown") return decision.action === "show" || decision.action === "replace"
  if (filter === "quiet") return decision.action !== "show" && decision.action !== "replace"
  return true
}

function iconColor(active: boolean): string {
  return active ? "#FFFFFF" : MERGE_COLORS.ink
}

function InsightsIcon({active}: {active: boolean}) {
  return (
    <svg aria-hidden="true" className="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke={iconColor(active)} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 15h8" />
      <path d="M9 19h6" />
      <path d="M12 3a6 6 0 0 0-3.5 10.9c.4.3.5.7.5 1.1h6c0-.4.1-.8.5-1.1A6 6 0 0 0 12 3Z" />
    </svg>
  )
}

function SettingsIcon({active}: {active: boolean}) {
  return (
    <svg aria-hidden="true" className="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke={iconColor(active)} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.6-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.3 7a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.6V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1A2 2 0 1 1 19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.1a2 2 0 1 1 0 4H21a1.7 1.7 0 0 0-1.6 1Z" />
    </svg>
  )
}

function LanguageIcon() {
  return (
    <svg className="w-6 h-6 text-gray-900 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="m5 8 6 6" />
      <path d="m4 14 6-6 2-3" />
      <path d="M2 5h12" />
      <path d="M7 2h1" />
      <path d="m22 22-5-10-5 10" />
      <path d="M14 18h6" />
    </svg>
  )
}

function FrequencyIcon() {
  return (
    <svg className="w-6 h-6 text-gray-900 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 18V8" />
      <path d="M10 18V4" />
      <path d="M16 18v-6" />
      <path d="M22 18V10" />
    </svg>
  )
}

function ChevronDownIcon() {
  return (
    <svg aria-hidden="true" className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="m6 9 6 6 6-6" />
    </svg>
  )
}

function BackIcon() {
  return (
    <svg className="w-5 h-5 text-zinc-800" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="m15 18-6-6 6-6" />
    </svg>
  )
}

export default App
