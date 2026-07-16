import {useEffect, useMemo, useState, type CSSProperties, type ReactNode} from "react"
import {useColorScheme, useSafeArea} from "@mentra/miniapp/ui"

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
  ink: "#15171C",
  muted: "#8A8F9C",
  pink: "#F5497B",
  coral: "#FF6F7D",
  sky: "#39BFE9",
  violet: "#7C6FF2",
  peach: "#FF9B62",
  offline: "#4B4B5A",
  surface: "#FFFFFF",
  border: "#ECECF1",
  chip: "#F3F3F7",
}

const MERGE_ACTIVE_STYLE: CSSProperties = {
  backgroundColor: MERGE_COLORS.pink,
  color: "#FFFFFF",
  boxShadow: "0 8px 20px rgba(245, 73, 123, 0.28)",
}

// Soft light gradient. Starts near-white so the safe-area top inset (where the
// phone status bar sits) reads light, then cools toward the bottom — the header
// and cards float over it instead of sitting on a hard white bar.
const MERGE_SHELL_STYLE: CSSProperties = {
  background: "linear-gradient(180deg, #FFFFFF 0%, #FBFAFC 42%, #F1F1F6 100%)",
}

const CARD_SHADOW = "0 4px 18px rgba(20, 23, 28, 0.06)"

type MergeTab = "insights" | "settings"
type InsightsMode = "insights" | "activity"
type ActivityFilter = "all" | "shown" | "quiet"

// Per-agent presentation: the tinted icon tile + glyph that fronts each card
// and the "standing by" chips. Unknown agents fall back to a neutral mark.
type AgentVisual = {bg: string; fg: string; glyph: ReactNode; bgDark?: string}
const AGENT_VISUALS: Record<string, AgentVisual> = {
  QuestionAnswerer: {bg: "#FFE7F0", bgDark: "#3F1D2E", fg: MERGE_COLORS.pink, glyph: <SparkGlyph />},
  FactChecker: {bg: "#ECEAFE", bgDark: "#2A2350", fg: MERGE_COLORS.violet, glyph: <CheckGlyph />},
  Definer: {bg: "#ECEAFE", bgDark: "#2A2350", fg: MERGE_COLORS.violet, glyph: <CheckGlyph />},
  Initial: {bg: "#FFE7F0", bgDark: "#3F1D2E", fg: MERGE_COLORS.pink, glyph: <SparkGlyph />},
}
const STANDBY_AGENTS = ["QuestionAnswerer", "FactChecker", "Definer"]

function agentVisual(type?: string): AgentVisual {
  return AGENT_VISUALS[type ?? ""] ?? {bg: MERGE_COLORS.chip, fg: MERGE_COLORS.muted, glyph: <SparkGlyph />}
}

export function App() {
  const {insets, capsuleMenu} = useSafeArea()
  const scheme = useColorScheme()
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

  // Mirror the host-reported color scheme onto <html> so `.dark` CSS and
  // Tailwind `dark:` variants activate. Light remains the untouched default.
  useEffect(() => {
    document.documentElement.classList.toggle("dark", scheme === "dark")
  }, [scheme])

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
  const busy = processing || backendStatus === "processing"

  const statusText = busy ? "Thinking…" : insights.length > 0 ? "Listening for useful context" : "Listening"

  return (
    <div
      className="merge-shell w-screen h-screen flex overflow-hidden font-sans"
      style={{
        ...MERGE_SHELL_STYLE,
        paddingTop: insets.top,
        paddingBottom: insets.bottom,
        paddingLeft: insets.left,
        paddingRight: insets.right,
      }}>
      <div className="relative min-h-0 flex-1 flex flex-col overflow-hidden">
        {!showDeveloperInfo && (
          <header className="pt-4 pb-3 pl-5" style={{paddingRight: headerPaddingRight}}>
            <div className="flex items-center gap-3 min-w-0">
              <img src={MergeLogo} alt="" className="h-10 w-10 flex-shrink-0" />
              <div className="min-w-0">
                <h1 className="m-0 text-xl font-bold text-[#15171c] dark:text-zinc-50 truncate">Merge</h1>
                <p className="m-0 mt-0.5 flex items-center gap-1.5 text-sm text-[#8a8f9c] dark:text-zinc-400 truncate">
                  <span
                    className="h-1.5 w-1.5 rounded-full flex-shrink-0"
                    style={{backgroundColor: busy ? MERGE_COLORS.peach : MERGE_COLORS.pink}}
                  />
                  {statusText}
                </p>
              </div>
            </div>
          </header>
        )}

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
                busy={busy}
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
          <BottomNav activeTab={activeTab} onTabChange={setActiveTab} settingsHoldHandlers={holdHandlers} />
        )}
      </div>
    </div>
  )
}

function InsightsView({
  insights,
  decisions,
  busy,
  latestTranscript,
  latestDecision,
  cloudPresentation,
  backendPresentation,
  lastError,
  developerMode,
}: {
  insights: MergeInsight[]
  decisions: MergeDecision[]
  busy: boolean
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

  const newestId = insights.length > 0 ? insights[insights.length - 1].id : null

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {developerMode && (
        <section className="px-4 py-2">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5 min-w-0 flex-1 overflow-hidden">
              <StatusPill label={cloudPresentation.label} detail={cloudPresentation.detail} color={cloudPresentation.accentColor} />
              <StatusPill label={backendPresentation.label} detail={backendPresentation.detail} color={backendPresentation.dotColor} />
            </div>
            <ModeSwitch mode={mode} onModeChange={setMode} />
          </div>
        </section>
      )}

      <main className="flex-1 min-h-0 overflow-y-auto px-5">
        {mode === "activity" ? (
          <ActivityTimeline
            decisions={decisions}
            expandedDecisionId={expandedDecisionId}
            onToggleDecision={(id) => setExpandedDecisionId((current) => (current === id ? null : id))}
          />
        ) : insights.length === 0 ? (
          busy ? (
            <ThinkingHero quote={latestTranscript?.text} />
          ) : (
            <ListeningEmpty />
          )
        ) : (
          <div className="flex flex-col gap-3 pt-3 pb-28">
            <SectionLabel>Today</SectionLabel>
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
                    isNewest={insight.id === newestId}
                    developerMode={developerMode}
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

// ── Empty / Thinking hero ────────────────────────────────────────────────

function PulseHero({thinking}: {thinking?: boolean}) {
  return (
    <div className="relative flex items-center justify-center" style={{width: 232, height: 232}}>
      <span className="absolute rounded-full" style={{width: 232, height: 232, border: "1px solid #F2DEE7"}} />
      <span className="absolute rounded-full" style={{width: 176, height: 176, border: "1px solid #F4D6E2"}} />
      {thinking ? (
        <svg
          className="absolute animate-spin"
          style={{width: 208, height: 208, animationDuration: "1.4s"}}
          viewBox="0 0 100 100"
          fill="none"
          aria-hidden="true">
          <circle cx="50" cy="50" r="48" stroke={MERGE_COLORS.pink} strokeWidth="2.5" strokeLinecap="round" strokeDasharray="74 230" />
        </svg>
      ) : (
        <span
          className="absolute rounded-full animate-pulse"
          style={{width: 208, height: 208, border: "1px solid #F8CFDE"}}
        />
      )}
      <img src={MergeLogo} alt="" className="relative h-[88px] w-[88px]" />
    </div>
  )
}

function ListeningEmpty() {
  return (
    <div className="h-full flex flex-col items-center justify-center text-center px-6 pb-24">
      <PulseHero />
      <h2 className="mt-6 mb-0 text-[22px] font-bold text-[#15171c] dark:text-zinc-50">No insights yet</h2>
      <p className="m-0 mt-2 max-w-[280px] text-sm leading-5 text-[#8a8f9c] dark:text-zinc-400">
        Merge stays quiet until it has something useful to add.
      </p>
      <p className="m-0 mt-9 text-[11px] font-bold uppercase tracking-[0.16em] text-[#b3b7c2] dark:text-zinc-500">Agents standing by</p>
      <div className="mt-3 flex flex-wrap items-center justify-center gap-2 max-w-[300px]">
        {STANDBY_AGENTS.map((agent) => (
          <AgentChip key={agent} type={agent} />
        ))}
      </div>
    </div>
  )
}

function ThinkingHero({quote}: {quote?: string}) {
  return (
    <div className="h-full flex flex-col items-center justify-center text-center px-6 pb-24">
      <PulseHero thinking />
      <h2 className="mt-6 mb-0 text-[22px] font-bold text-[#15171c] dark:text-zinc-50">Thinking…</h2>
      {quote ? (
        <p className="m-0 mt-2 max-w-[290px] text-base leading-6 text-[#3a3f4c] dark:text-zinc-200">“{quote}”</p>
      ) : (
        <p className="m-0 mt-2 max-w-[290px] text-base leading-6 text-[#8a8f9c] dark:text-zinc-400">Checking what matters…</p>
      )}
    </div>
  )
}

function AgentChip({type}: {type: string}) {
  return (
    <div
      className="inline-flex items-center gap-2 rounded-full bg-white dark:bg-zinc-900 py-1.5 pl-1.5 pr-3.5 border border-[#F0F0F4] dark:border-zinc-800"
      style={{boxShadow: "0 4px 14px rgba(20, 23, 28, 0.06)"}}>
      <AgentIconTile type={type} size={24} />
      <span className="text-sm font-semibold text-[#15171c] dark:text-zinc-50">{type}</span>
    </div>
  )
}

function AgentIconTile({type, size = 30}: {type?: string; size?: number}) {
  const visual = agentVisual(type)
  // Tile background is an inline style, out of Tailwind dark:'s reach — pick
  // the pastel or its dark twin by scheme. Saturated glyph inks stay put.
  const isDark = useColorScheme() === "dark"
  const bg = isDark ? (visual.bgDark ?? "#27272A") : visual.bg
  return (
    <span
      className="inline-flex items-center justify-center rounded-[9px] flex-shrink-0"
      style={{width: size, height: size, backgroundColor: bg, color: visual.fg}}>
      {visual.glyph}
    </span>
  )
}

// ── Settings ─────────────────────────────────────────────────────────────

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
    <div className="h-full overflow-y-auto px-5 pt-4 pb-28">
      <h1 className="m-0 text-[26px] font-bold text-[#15171c] dark:text-zinc-50">Settings</h1>
      <p className="m-0 mt-1 text-sm text-[#8a8f9c] dark:text-zinc-400">Tune how Merge listens, thinks, and speaks.</p>

      <SectionLabel className="mt-7">Intelligence</SectionLabel>
      <div
        className="mt-3 rounded-2xl bg-white dark:bg-zinc-900 border border-[#ECECF1] dark:border-zinc-800 overflow-hidden"
        style={{boxShadow: CARD_SHADOW}}>
        {/* Answer language — native picker overlaid on a row that shows the value. */}
        <div className="relative flex items-center gap-3 px-4 py-3.5">
          <SettingIconTile>
            <LanguageIcon />
          </SettingIconTile>
          <span className="flex-1 text-[15px] font-semibold text-[#15171c] dark:text-zinc-50">Answer language</span>
          <span className="flex items-center gap-1 text-[15px] text-[#8a8f9c] dark:text-zinc-400">
            {settings.answerLanguage}
            <ChevronRightIcon />
          </span>
          <select
            aria-label="Answer language"
            value={settings.answerLanguage}
            onChange={(event) => onAnswerLanguageChange(event.currentTarget.value as AnswerLanguage)}
            className="absolute inset-0 h-full w-full cursor-pointer opacity-0">
            {ANSWER_LANGUAGES.map((language) => (
              <option key={language} value={language}>
                {language}
              </option>
            ))}
          </select>
        </div>

        <div className="h-px bg-[#F1F1F4] dark:bg-zinc-800 mx-4" />

        {/* Insight frequency */}
        <div className="px-4 py-3.5">
          <div className="flex items-center gap-3">
            <SettingIconTile>
              <FrequencyIcon />
            </SettingIconTile>
            <span className="flex-1 text-[15px] font-semibold text-[#15171c] dark:text-zinc-50">Insight frequency</span>
          </div>
          <div className="mt-3 grid grid-cols-3 gap-2">
            {(["low", "medium", "high"] as const).map((frequency) => {
              const active = settings.frequency === frequency
              return (
                <button
                  key={frequency}
                  onClick={() => onFrequencyChange(frequency)}
                  className="h-11 rounded-xl text-sm font-semibold capitalize transition-colors"
                  style={active ? MERGE_ACTIVE_STYLE : {backgroundColor: MERGE_COLORS.chip, color: MERGE_COLORS.ink}}>
                  {frequency}
                </button>
              )
            })}
          </div>
        </div>
      </div>

      {developerMode && (
        <button
          className="mt-6 w-full py-3 text-xs font-semibold text-zinc-400 hover:text-zinc-600 dark:text-zinc-500 dark:hover:text-zinc-300 transition-colors"
          onClick={onOpenDeveloperInfo}>
          Developer info
        </button>
      )}
    </div>
  )
}

function SettingIconTile({children}: {children: ReactNode}) {
  return (
    <span className="inline-flex h-9 w-9 items-center justify-center rounded-[11px] bg-[#F3F3F7] dark:bg-zinc-800 text-[#5b6070] dark:text-zinc-300 flex-shrink-0">
      {children}
    </span>
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
    <div className="h-full flex flex-col overflow-hidden">
      <div className="px-5 py-3 flex items-center gap-3">
        <button className="h-9 w-9 rounded-full bg-white dark:bg-zinc-900 border border-[#ECECF1] dark:border-zinc-800 flex items-center justify-center" onClick={onBack} aria-label="Back">
          <BackIcon />
        </button>
        <div>
          <h2 className="m-0 text-lg font-bold text-zinc-900 dark:text-zinc-50">Developer info</h2>
          <p className="m-0 text-xs text-zinc-500 dark:text-zinc-400">Public build configuration</p>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto px-5 py-3 space-y-4">
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
  // Floating dock — centered pill that hovers over the scrolling content; the
  // views reserve bottom padding so nothing hides behind it.
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
      <div
        className="pointer-events-auto inline-flex items-center gap-1 rounded-full bg-white/90 dark:bg-zinc-900/90 backdrop-blur-lg p-1.5 border border-[#ECECF1] dark:border-zinc-800"
        style={{boxShadow: "0 12px 30px rgba(20, 23, 28, 0.14)"}}>
        <DockButton active={activeTab === "insights"} label="Insights" onClick={() => onTabChange("insights")}>
          <InsightsIcon active={activeTab === "insights"} />
        </DockButton>
        <DockButton
          active={activeTab === "settings"}
          label="Settings"
          onClick={() => onTabChange("settings")}
          holdHandlers={settingsHoldHandlers}>
          <SettingsIcon active={activeTab === "settings"} />
        </DockButton>
      </div>
    </div>
  )
}

function DockButton({
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
  return (
    <button
      aria-label={label}
      onClick={onClick}
      onPointerDown={holdHandlers?.onPointerDown}
      onPointerUp={holdHandlers?.onPointerUp}
      onPointerLeave={holdHandlers?.onPointerLeave}
      onPointerCancel={holdHandlers?.onPointerCancel}
      className="inline-flex h-10 items-center gap-2 rounded-full px-4 transition-colors"
      style={active ? MERGE_ACTIVE_STYLE : {backgroundColor: "transparent"}}>
      {children}
      <span className="text-sm font-semibold" style={{color: active ? "#FFFFFF" : MERGE_COLORS.muted}}>
        {label}
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
    <div className="grid grid-cols-2 gap-1 rounded-full bg-zinc-100 dark:bg-zinc-800 p-1 border border-zinc-200 dark:border-zinc-700 flex-shrink-0">
      {(["insights", "activity"] as const).map((item) => (
        <button
          key={item}
          className={`h-7 min-w-[62px] rounded-full px-2 text-[11px] font-bold capitalize transition-colors ${
            mode === item ? "text-white" : "text-zinc-500 dark:text-zinc-400"
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
  isNewest,
  developerMode,
  expanded,
  onToggle,
}: {
  insight: MergeInsight
  decision?: MergeDecision
  isNewest: boolean
  developerMode: boolean
  expanded: boolean
  onToggle: () => void
}) {
  const quote = decision?.chunkText?.trim()
  const duration = insight.profiling ? formatDuration(insight.profiling.totalMs) : null
  const sources = insight.sources ?? decision?.sources ?? []
  const hasUserDetails = sources.length > 0
  const canExpand = developerMode || hasUserDetails
  return (
    <article
      className={`rounded-[20px] bg-white dark:bg-zinc-900 p-4 ${isNewest ? "border-2 border-[#F8B4CC] dark:border-pink-900" : "border border-[#ECECF1] dark:border-zinc-800"}`}
      style={{boxShadow: CARD_SHADOW}}>
      <button className="w-full text-left" onClick={canExpand ? onToggle : undefined}>
        <div className="flex items-center gap-2.5">
          <AgentIconTile type={insight.agentType} />
          <span className="flex-1 text-[15px] font-bold text-[#15171c] dark:text-zinc-50 truncate">{insight.agentType || "Merge"}</span>
          {isNewest ? (
            <NewBadge />
          ) : (
            <span className="text-xs text-[#9aa0ad] dark:text-zinc-500 flex-shrink-0">{formatClockTime(insight.timestamp)}</span>
          )}
        </div>

        {quote ? (
          <div className="mt-3 flex items-center gap-2 rounded-xl bg-[#F4F4F7] dark:bg-zinc-800 px-3 py-2">
            <WaveformIcon />
            <span className="min-w-0 flex-1 truncate text-[13px] italic text-[#8a8f9c] dark:text-zinc-400">“{quote}”</span>
          </div>
        ) : null}

        <p className="selectable-text m-0 mt-3 text-[15px] font-semibold leading-6 text-[#15171c] dark:text-zinc-50 whitespace-pre-wrap break-words">
          {insight.text}
        </p>

        {developerMode ? (
          <div className="mt-3 flex items-center gap-2">
            {insight.displayAction ? <ActionBadge action={insight.displayAction} /> : null}
            {typeof insight.confidence === "number" ? (
              <span className="text-xs font-semibold text-[#8a8f9c] dark:text-zinc-400">{Math.round(insight.confidence * 100)}%</span>
            ) : null}
            {duration ? (
              <>
                <span className="text-[#c4c8d1] dark:text-zinc-600">·</span>
                <span className="text-xs text-[#8a8f9c] dark:text-zinc-400">{duration}</span>
              </>
            ) : null}
          </div>
        ) : null}
      </button>

      {expanded && canExpand ? (
        <div className="mt-3 space-y-2">
          {developerMode && decision?.chunkText ? <DetailBlock label="Conversation" text={decision.chunkText} /> : null}
          {developerMode && (insight.reasoning || decision?.reasoning) ? (
            <DetailBlock label="Reasoning" text={insight.reasoning ?? decision?.reasoning ?? ""} />
          ) : null}
          <SourcesBlock
            sources={sources}
            searchQueries={developerMode ? (insight.searchQueries ?? decision?.searchQueries ?? []) : []}
          />
          {developerMode ? <ProfilingBlock profiling={insight.profiling ?? decision?.profiling} /> : null}
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
      <div className="h-full flex flex-col items-center justify-center text-center pb-24">
        <img src={MergeLogo} alt="" className="h-14 w-14 opacity-80" />
        <h2 className="mt-4 mb-1 text-base font-bold text-[#15171c] dark:text-zinc-50">No AI activity yet</h2>
        <p className="m-0 max-w-[250px] text-sm leading-5 text-[#8a8f9c] dark:text-zinc-400">
          Decisions appear after Merge analyzes speech.
        </p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-2 py-4 pb-28">
      <ActivityFilterBar
        filter={filter}
        onFilterChange={setFilter}
        counts={{all: decisions.length, shown: shownCount, quiet: quietCount}}
      />
      {filteredDecisions.length === 0 ? (
        <div className="rounded-lg border border-dashed border-[#dfe6e4] dark:border-zinc-700 bg-white/70 dark:bg-zinc-900/70 px-4 py-6 text-center">
          <p className="m-0 text-sm font-semibold text-[#66736f] dark:text-zinc-400">No {filter === "shown" ? "shown insights" : "quiet decisions"} yet</p>
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
    <div className="sticky top-0 z-10 -mx-5 px-5 pb-2 bg-[#f6f6fa]/95 dark:bg-zinc-950/95 backdrop-blur">
      <div className="grid grid-cols-3 gap-1 rounded-full bg-white dark:bg-zinc-900 p-1 border border-[#ECECF1] dark:border-zinc-800 shadow-[0_1px_6px_rgba(16,24,24,0.04)]">
        {(["all", "shown", "quiet"] as const).map((item) => (
          <button
            key={item}
            className={`h-8 rounded-full px-2 text-[11px] font-bold capitalize transition-colors ${
              filter === item ? "text-white" : "text-[#66736f] dark:text-zinc-400"
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
    <article className="rounded-lg border border-[#ECECF1] dark:border-zinc-800 bg-white dark:bg-zinc-900 px-3 py-2 shadow-[0_1px_6px_rgba(16,24,24,0.04)]">
      <button className="w-full text-left" onClick={onToggle}>
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <span className="h-2.5 w-2.5 rounded-full flex-shrink-0" style={{backgroundColor: actionColor(decision.action)}} />
            <span className="text-sm font-bold text-[#15171c] dark:text-zinc-50 truncate">{activityTitle(decision)}</span>
          </div>
          <span className="text-[11px] text-[#9aa0ad] dark:text-zinc-500 flex-shrink-0">{formatTime(decision.timestamp)}</span>
        </div>
        <p className="m-0 mt-1 text-xs leading-4 text-[#66736f] dark:text-zinc-400 line-clamp-2">
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
            <span className="rounded-full bg-zinc-100 dark:bg-zinc-800 px-2 py-1 text-[10px] font-bold uppercase text-zinc-500 dark:text-zinc-400">
              {decision.trigger}
            </span>
            {decision.urgency ? (
              <span className="rounded-full bg-zinc-100 dark:bg-zinc-800 px-2 py-1 text-[10px] font-bold uppercase text-zinc-500 dark:text-zinc-400">
                {decision.urgency}
              </span>
            ) : null}
            {typeof decision.confidence === "number" ? (
              <span className="rounded-full bg-zinc-100 dark:bg-zinc-800 px-2 py-1 text-[10px] font-bold uppercase text-zinc-500 dark:text-zinc-400">
                {Math.round(decision.confidence * 100)}%
              </span>
            ) : null}
            {decision.profiling ? (
              <span className="rounded-full bg-zinc-100 dark:bg-zinc-800 px-2 py-1 text-[10px] font-bold uppercase text-zinc-500 dark:text-zinc-400">
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
    <footer className="px-5 pb-20 pt-2">
      <button
        className="w-full rounded-lg bg-white dark:bg-zinc-900 border border-[#ECECF1] dark:border-zinc-800 px-3 py-2 text-left"
        onClick={onOpenActivity}>
        <div className="flex items-center justify-between gap-3">
          <span className="text-[11px] font-bold uppercase text-[#7a8581] dark:text-zinc-500">Live</span>
          {latestDecision ? (
            <span className="text-[11px] font-bold uppercase" style={{color: actionColor(latestDecision.action)}}>
              {latestDecision.action} · {latestDecision.trigger}
            </span>
          ) : null}
        </div>
        <p className="m-0 mt-1 text-sm leading-5 text-[#2f3b38] dark:text-zinc-200 line-clamp-1">
          {latestTranscript?.text || "Waiting for speech"}
        </p>
        <div className="mt-1 min-h-4 flex items-center justify-between gap-3 text-[11px] leading-4">
          <span className={`inline-flex min-w-0 items-center gap-1.5 font-semibold ${hasProblem ? "text-[#202431] dark:text-zinc-200" : "text-[#8a9692] dark:text-zinc-500"}`}>
            <span className="h-1.5 w-1.5 rounded-full flex-shrink-0" style={{backgroundColor: cloudPresentation.accentColor}} />
            <span className="truncate">{cloudPresentation.label}</span>
          </span>
          <span
            className={`min-w-0 truncate text-right font-semibold ${
              backendPresentation.label === "AI offline" ? "text-[#b94a5a] dark:text-[#ef7688]" : "text-[#8a9692] dark:text-zinc-500"
            }`}>
            {backendText}
          </span>
        </div>
      </button>
    </footer>
  )
}

function SectionLabel({children, className}: {children: ReactNode; className?: string}) {
  return (
    <p className={`m-0 px-1 text-[11px] font-bold uppercase tracking-[0.12em] text-[#b3b7c2] dark:text-zinc-500 ${className ?? ""}`}>
      {children}
    </p>
  )
}

function NewBadge() {
  return (
    <span
      className="flex-shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase text-white"
      style={{backgroundColor: MERGE_COLORS.pink}}>
      New
    </span>
  )
}

function DetailBlock({label, text}: {label: string; text: string}) {
  return (
    <div className="rounded-md bg-[#f8faf9] dark:bg-zinc-800 border border-[#e0e6e4] dark:border-zinc-700 px-3 py-2">
      <div className="text-[10px] font-bold uppercase text-[#8a9692] dark:text-zinc-500">{label}</div>
      <p className="m-0 mt-1 text-xs leading-4 text-[#46524f] dark:text-zinc-300 whitespace-pre-wrap break-words">{text}</p>
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
    <div className="rounded-md bg-[#f8faf9] dark:bg-zinc-800 border border-[#e0e6e4] dark:border-zinc-700 px-3 py-2">
      <div className="text-[10px] font-bold uppercase text-[#8a9692] dark:text-zinc-500">Sources</div>
      {sources.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {sources.map((source, index) => (
            <a
              key={`${source.uri}-${index}`}
              href={source.uri}
              target="_blank"
              rel="noreferrer"
              className="max-w-full rounded-full bg-white dark:bg-zinc-900 border border-[#e0e6e4] dark:border-zinc-700 px-2 py-1 text-[11px] font-semibold text-[#36423f] dark:text-zinc-300 no-underline truncate">
              {source.domain || source.title}
            </a>
          ))}
        </div>
      ) : (
        <p className="m-0 mt-1 text-xs leading-4 text-[#66736f] dark:text-zinc-400">No grounded sources returned.</p>
      )}
      {searchQueries.length > 0 ? (
        <p className="m-0 mt-2 text-[11px] leading-4 text-[#66736f] dark:text-zinc-400">
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
    <div className="rounded-md bg-[#f8faf9] dark:bg-zinc-800 border border-[#e0e6e4] dark:border-zinc-700 px-3 py-2">
      <div className="text-[10px] font-bold uppercase text-[#8a9692] dark:text-zinc-500">Profiling</div>
      <div className="mt-2 grid grid-cols-2 gap-1.5">
        {rows.map(([label, value]) => (
          <div key={label} className="rounded bg-white dark:bg-zinc-900 border border-[#edf1ef] dark:border-zinc-700 px-2 py-1">
            <div className="text-[9px] font-bold uppercase text-[#a0aaa6] dark:text-zinc-500">{label}</div>
            <div className="mt-0.5 text-[11px] font-semibold text-[#36423f] dark:text-zinc-300 break-all">{value}</div>
          </div>
        ))}
      </div>
    </div>
  )
}

function ActionBadge({action}: {action: MergeDecision["action"]}) {
  return (
    <span
      className="rounded-md px-2 py-0.5 text-[10px] font-bold uppercase"
      style={{backgroundColor: `${actionColor(action)}1A`, color: actionColor(action)}}>
      {action}
    </span>
  )
}

function StatusPill({label, detail, color}: {label: string; detail: string; color: string}) {
  return (
    <div className="flex items-center gap-1.5 rounded-full border border-[#e3e4ea] dark:border-zinc-700 bg-white dark:bg-zinc-900 px-2 py-1 flex-shrink-0">
      <span className="h-2 w-2 rounded-full flex-shrink-0" style={{backgroundColor: color}} />
      <span className="text-[11px] font-bold text-[#24302d] dark:text-zinc-200 whitespace-nowrap">{compactStatusLabel(label)}</span>
      <span className="text-[10px] font-bold uppercase text-[#7a8581] dark:text-zinc-500 whitespace-nowrap">
        {compactStatusDetail(label, detail)}
      </span>
    </div>
  )
}

function InfoCard({title, children}: {title: string; children: ReactNode}) {
  return (
    <section className="bg-white dark:bg-zinc-900 rounded-2xl p-4 border border-[#ECECF1] dark:border-zinc-800" style={{boxShadow: CARD_SHADOW}}>
      <h3 className="m-0 mb-3 text-sm font-bold text-zinc-900 dark:text-zinc-50">{title}</h3>
      <div className="space-y-3">{children}</div>
    </section>
  )
}

function InfoRow({label, value}: {label: string; value: string}) {
  return (
    <div>
      <div className="text-[11px] font-bold uppercase text-zinc-400 dark:text-zinc-500 break-all">{label}</div>
      <div className="mt-0.5 text-sm leading-5 text-zinc-800 dark:text-zinc-200 break-all">{value}</div>
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

function formatClockTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], {hour: "numeric", minute: "2-digit"})
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

// ── Icons / glyphs ─────────────────────────────────────────────────────────

function InsightsIcon({active}: {active: boolean}) {
  const color = active ? "#FFFFFF" : MERGE_COLORS.muted
  return (
    <svg aria-hidden="true" className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 15h8" />
      <path d="M9 19h6" />
      <path d="M12 3a6 6 0 0 0-3.5 10.9c.4.3.5.7.5 1.1h6c0-.4.1-.8.5-1.1A6 6 0 0 0 12 3Z" />
    </svg>
  )
}

function SettingsIcon({active}: {active: boolean}) {
  const color = active ? "#FFFFFF" : MERGE_COLORS.muted
  return (
    <svg aria-hidden="true" className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.6-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.3 7a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.6V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1A2 2 0 1 1 19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.1a2 2 0 1 1 0 4H21a1.7 1.7 0 0 0-1.6 1Z" />
    </svg>
  )
}

function LanguageIcon() {
  return (
    <svg className="w-5 h-5 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
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
    <svg className="w-5 h-5 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 18V8" />
      <path d="M10 18V4" />
      <path d="M16 18v-6" />
      <path d="M22 18V10" />
    </svg>
  )
}

function ChevronRightIcon() {
  return (
    <svg aria-hidden="true" className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="m9 6 6 6-6 6" />
    </svg>
  )
}

function BackIcon() {
  return (
    <svg className="w-5 h-5 text-zinc-800 dark:text-zinc-200" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="m15 18-6-6 6-6" />
    </svg>
  )
}

function WaveformIcon() {
  return (
    <svg aria-hidden="true" className="w-4 h-4 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke={MERGE_COLORS.pink} strokeWidth="2" strokeLinecap="round">
      <path d="M5 10v4" />
      <path d="M9 7v10" />
      <path d="M13 4v16" />
      <path d="M17 8v8" />
      <path d="M21 11v2" />
    </svg>
  )
}

function SparkGlyph() {
  return (
    <svg aria-hidden="true" className="w-[15px] h-[15px]" viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 2c.5 3.6 2.4 5.5 6 6-3.6.5-5.5 2.4-6 6-.5-3.6-2.4-5.5-6-6 3.6-.5 5.5-2.4 6-6Z" />
    </svg>
  )
}

function CheckGlyph() {
  return (
    <svg aria-hidden="true" className="w-[15px] h-[15px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="m5 12 4.5 4.5L19 7" />
    </svg>
  )
}

export default App
