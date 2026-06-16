import {useEffect, useMemo, useState} from "react"
import {useSafeArea} from "@mentra/miniapp/ui"

import type {CloudClientStatus, MergeSnapshot, MergeTranscript} from "../shared/types"

const DEFAULT_STATUS: CloudClientStatus = {status: "disconnected", audioTransport: "none"}

export function App() {
  const {insets} = useSafeArea()
  const [transcripts, setTranscripts] = useState<MergeTranscript[]>([])
  const [finalCount, setFinalCount] = useState(0)
  const [interimCount, setInterimCount] = useState(0)
  const [cloudStatus, setCloudStatus] = useState<CloudClientStatus>(DEFAULT_STATUS)

  useEffect(() => {
    const unsubs = [
      mentra.on("merge:snapshot", (snapshot: MergeSnapshot) => {
        setTranscripts(snapshot.transcripts)
        setFinalCount(snapshot.finalCount)
        setInterimCount(snapshot.interimCount)
        setCloudStatus(snapshot.cloudStatus)
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
      mentra.on("merge:cloud-status", (status: CloudClientStatus) => {
        setCloudStatus(status)
      }),
    ]
    mentra.send("merge:request-snapshot", {})
    return () => {
      for (const unsub of unsubs) unsub()
    }
  }, [])

  const presentation = useMemo(() => getCloudPresentation(cloudStatus), [cloudStatus])

  return (
    <div
      className="h-screen w-screen overflow-hidden flex flex-col bg-zinc-100"
      style={{
        paddingTop: insets.top,
        paddingBottom: insets.bottom,
        paddingLeft: insets.left,
        paddingRight: insets.right,
      }}>
      <header className="px-5 py-4 border-b border-zinc-200 bg-white">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h1 className="m-0 text-xl font-bold text-zinc-950 truncate">Local Merge</h1>
            <p className="m-0 mt-1 text-sm text-zinc-500 truncate">Background transcription fanout probe</p>
          </div>
          <button
            className="h-9 px-3 rounded-md border border-zinc-300 bg-white text-sm font-semibold text-zinc-800"
            onClick={() => mentra.send("merge:clear", {})}>
            Clear
          </button>
        </div>
      </header>

      <section className="px-5 py-3 bg-white border-b border-zinc-200">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <span
              className="h-2.5 w-2.5 rounded-full flex-shrink-0"
              style={{backgroundColor: presentation.dotColor}}
            />
            <span className="text-sm font-semibold text-zinc-900 truncate">{presentation.label}</span>
          </div>
          <span className="text-xs font-semibold text-zinc-500 uppercase tracking-wide">{presentation.detail}</span>
        </div>
      </section>

      <section className="grid grid-cols-2 gap-3 px-5 py-4 bg-zinc-100">
        <Counter label="Final" value={finalCount} />
        <Counter label="Interim" value={interimCount} />
      </section>

      <main className="flex-1 min-h-0 overflow-y-auto px-5 pb-5">
        {transcripts.length === 0 ? (
          <div className="h-full flex items-center justify-center text-center text-zinc-500 text-sm">
            Waiting for shared cloud transcription events.
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {transcripts
              .slice()
              .reverse()
              .map((entry) => (
                <article key={`${entry.id}-${entry.isFinal ? "final" : "interim"}`} className="bg-white border border-zinc-200 rounded-lg p-3">
                  <div className="flex items-center justify-between gap-2 mb-1">
                    <span className={`text-xs font-bold ${entry.isFinal ? "text-emerald-700" : "text-zinc-500"}`}>
                      {entry.isFinal ? "Final" : "Interim"}
                    </span>
                    <span className="text-xs text-zinc-400">{formatTime(entry.receivedAt)}</span>
                  </div>
                  <p className="m-0 text-base leading-6 text-zinc-950">{entry.text}</p>
                  <div className="mt-2 flex items-center gap-2 text-xs text-zinc-500">
                    <span>{entry.language ?? "unknown language"}</span>
                    <span>{entry.utteranceId ? "utterance id" : "legacy id"}</span>
                  </div>
                </article>
              ))}
          </div>
        )}
      </main>
    </div>
  )
}

function Counter({label, value}: {label: string; value: number}) {
  return (
    <div className="bg-white border border-zinc-200 rounded-lg p-3">
      <div className="text-xs font-semibold text-zinc-500 uppercase tracking-wide">{label}</div>
      <div className="text-2xl font-bold text-zinc-950 mt-1">{value}</div>
    </div>
  )
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

function formatTime(value: number): string {
  return new Date(value).toLocaleTimeString([], {hour: "numeric", minute: "2-digit", second: "2-digit"})
}

export default App
