import {useEffect, useMemo, useState} from "react"
import {useSafeArea} from "@mentra/miniapp/ui"

import MergeLogo from "./assets/merge_logo.png"

import type {
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
const DEFAULT_SETTINGS: MergeSettings = {frequency: "medium"}

export function App() {
  const {insets} = useSafeArea()
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
  const latestTranscript = transcripts.slice().reverse().find((entry) => entry.text.trim().length > 0)
  const latestDecision = decisions[decisions.length - 1]

  return (
    <div
      className="h-screen w-screen overflow-hidden flex flex-col bg-[#f5f7f7] text-[#171717]"
      style={{
        paddingTop: insets.top,
        paddingBottom: insets.bottom,
        paddingLeft: insets.left,
        paddingRight: insets.right,
      }}>
      <header className="px-5 pt-4 pb-3 bg-white border-b border-[#e3e7e6]">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <img src={MergeLogo} alt="" className="h-10 w-10 flex-shrink-0" />
            <div className="min-w-0">
              <h1 className="m-0 text-xl font-bold truncate">Local Merge</h1>
              <p className="m-0 mt-0.5 text-sm text-[#6b7280] truncate">
                {processing ? "Thinking..." : insights.length > 0 ? "Listening for useful context" : "Listening"}
              </p>
            </div>
          </div>
          <button
            className="h-9 px-3 rounded-md border border-[#d5dddb] bg-white text-sm font-semibold text-[#252525]"
            onClick={() => mentra.send("merge:clear", {})}>
            Clear
          </button>
        </div>
      </header>

      <section className="px-5 py-3 bg-white border-b border-[#e3e7e6]">
        <div className="flex flex-wrap gap-2">
          <StatusPill label={cloudPresentation.label} detail={cloudPresentation.detail} color={cloudPresentation.dotColor} />
          <StatusPill label={backendPresentation.label} detail={backendPresentation.detail} color={backendPresentation.dotColor} />
        </div>
        {lastError ? <p className="m-0 mt-2 text-xs leading-4 text-[#9f3a3a]">{lastError}</p> : null}
      </section>

      <section className="px-5 py-3 bg-[#eef3f2] border-b border-[#dfe6e4]">
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm font-bold text-[#2b3432]">Frequency</span>
          <div className="grid grid-cols-3 gap-1 rounded-lg bg-white p-1 border border-[#d5dddb]">
            {(["low", "medium", "high"] as const).map((frequency) => (
              <button
                key={frequency}
                className={`h-8 min-w-16 rounded-md px-2 text-xs font-bold capitalize ${
                  settings.frequency === frequency ? "bg-[#426b63] text-white" : "bg-transparent text-[#576460]"
                }`}
                onClick={() => setFrequency(frequency)}>
                {frequency}
              </button>
            ))}
          </div>
        </div>
      </section>

      <main className="flex-1 min-h-0 overflow-y-auto px-5 pb-5">
        {insights.length === 0 ? (
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
              .map((insight) => (
                <article key={insight.id} className="bg-white border border-[#e0e6e4] rounded-lg p-4 shadow-[0_1px_8px_rgba(16,24,24,0.05)]">
                  <div className="flex items-center gap-2 mb-2">
                    <img src={MergeLogo} alt="" className="h-7 w-7 flex-shrink-0" />
                    <div className="min-w-0">
                      <div className="text-sm font-bold text-[#1e2927] truncate">{insight.agentType || "Merge"}</div>
                      <div className="text-xs text-[#7a8581]">{formatTime(insight.timestamp)}</div>
                    </div>
                  </div>
                  <p className="m-0 text-base leading-6 text-[#202928] whitespace-pre-wrap break-words">{insight.text}</p>
                </article>
              ))}
          </div>
        )}
      </main>

      <footer className="bg-white border-t border-[#e3e7e6] px-5 py-3">
        <div className="grid grid-cols-2 gap-2 mb-3">
          <Counter label="Final" value={finalCount} />
          <Counter label="Interim" value={interimCount} />
        </div>
        <div className="min-h-11 rounded-lg bg-[#f5f7f7] border border-[#e0e6e4] px-3 py-2">
          <div className="text-[11px] font-bold uppercase text-[#7a8581]">Latest speech</div>
          <p className="m-0 mt-1 text-sm leading-5 text-[#2f3b38] line-clamp-2">
            {latestTranscript?.text || "Waiting for transcription"}
          </p>
        </div>
        {latestDecision ? <DecisionAudit decision={latestDecision} /> : null}
        <div className="mt-2 text-[11px] text-[#8a9490] truncate">{backendUrl}</div>
      </footer>
    </div>
  )
}

function DecisionAudit({decision}: {decision: MergeDecision}) {
  return (
    <div className="mt-2 rounded-lg bg-[#f8faf9] border border-[#e0e6e4] px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] font-bold uppercase text-[#7a8581]">AI decision</span>
        <span className="text-[11px] font-bold uppercase text-[#426b63]">
          {decision.action} · {decision.trigger}
        </span>
      </div>
      <p className="m-0 mt-1 text-xs leading-4 text-[#46524f] line-clamp-2">
        {decision.reasoning || decision.insightText || "No reason provided"}
      </p>
    </div>
  )
}

function Counter({label, value}: {label: string; value: number}) {
  return (
    <div className="bg-[#f8faf9] border border-[#e0e6e4] rounded-lg px-3 py-2">
      <div className="text-[11px] font-bold uppercase text-[#7a8581]">{label}</div>
      <div className="text-xl font-bold text-[#202928] mt-0.5">{value}</div>
    </div>
  )
}

function StatusPill({label, detail, color}: {label: string; detail: string; color: string}) {
  return (
    <div className="flex items-center gap-2 rounded-full border border-[#dbe3e0] bg-[#f8faf9] px-3 py-1.5">
      <span className="h-2.5 w-2.5 rounded-full flex-shrink-0" style={{backgroundColor: color}} />
      <span className="text-xs font-bold text-[#24302d]">{label}</span>
      <span className="text-[11px] font-bold uppercase text-[#7a8581]">{detail}</span>
    </div>
  )
}

function setFrequency(frequency: FrequencyMode): void {
  mentra.send("merge:set-frequency", {frequency})
}

function getCloudPresentation(status: CloudClientStatus): {label: string; detail: string; dotColor: string} {
  if (status.audioTransport === "udp") {
    return {label: "Cloud connected", detail: "UDP", dotColor: "#6DAEA6"}
  }
  if (status.audioTransport === "ws") {
    return {label: "Cloud connected", detail: "WS", dotColor: "#A7CDE3"}
  }
  if (status.audioTransport === "offline") {
    return {label: "Offline fallback", detail: "Local", dotColor: "#52525B"}
  }
  if (status.status === "connecting" || status.status === "reconnecting") {
    return {label: "Cloud reconnecting", detail: status.status, dotColor: "#71717A"}
  }
  return {label: "Cloud unavailable", detail: "None", dotColor: "#71717A"}
}

function getBackendPresentation(
  status: MergeBackendStatus,
  processing: boolean,
): {label: string; detail: string; dotColor: string} {
  if (processing || status === "processing") {
    return {label: "AI processing", detail: "AI", dotColor: "#c4a15d"}
  }
  if (status === "ok") {
    return {label: "AI ready", detail: "Backend", dotColor: "#6DAEA6"}
  }
  if (status === "unconfigured") {
    return {label: "AI unconfigured", detail: "Key", dotColor: "#d38d6b"}
  }
  if (status === "error") {
    return {label: "AI offline", detail: "Backend", dotColor: "#b75f5f"}
  }
  return {label: "AI idle", detail: "Backend", dotColor: "#8a9490"}
}

function formatTime(value: number): string {
  return new Date(value).toLocaleTimeString([], {hour: "numeric", minute: "2-digit", second: "2-digit"})
}

export default App
