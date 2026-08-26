import {useEffect, useMemo, useState} from "react"
import {AudioWaveform, Mic, Search, Trash2} from "lucide-react"
import {useColorScheme, useSafeArea} from "@mentra/miniapp/ui"

import type {RecordingItem} from "../shared/types"
import {Header} from "./components/Header"
import {RecordingRow} from "./components/RecordingRow"
import {RecordingScreen} from "./components/RecordingScreen"
import {useRecorder} from "./hooks/useRecorder"
import {fmtRelative, monthGroup} from "./lib/format"

/**
 * App — the WebView root for the Recorder. A list of recordings with a record
 * FAB; while capturing it swaps to a full-screen recording view. The background
 * controller is the source of truth; this is a thin control surface over it.
 */
export function App() {
  const scheme = useColorScheme()
  const {insets} = useSafeArea()
  const rec = useRecorder()
  const [query, setQuery] = useState("")
  // Deletion is permanent, so a tap on a row's trash opens an explicit confirm
  // dialog rather than deleting in place.
  const [pendingDelete, setPendingDelete] = useState<RecordingItem | null>(null)

  useEffect(() => {
    document.documentElement.classList.toggle("dark", scheme === "dark")
  }, [scheme])

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase()
    const filtered = q
      ? rec.recordings.filter((r) =>
          [r.title, r.name, r.transcript, fmtRelative(r.createdAt)].some((s) => s?.toLowerCase().includes(q)),
        )
      : rec.recordings
    const map = new Map<string, RecordingItem[]>()
    for (const r of filtered) {
      const key = monthGroup(r.createdAt)
      const arr = map.get(key)
      if (arr) arr.push(r)
      else map.set(key, [r])
    }
    return [...map.entries()]
  }, [rec.recordings, query])

  const frame = {
    background: "var(--bg)",
    paddingTop: insets.top,
    paddingBottom: insets.bottom,
    paddingLeft: insets.left,
    paddingRight: insets.right,
  }

  // While capturing, take over the whole screen.
  if (rec.isRecording && rec.status) {
    return (
      <div className="w-screen h-screen flex flex-col overflow-hidden" style={frame}>
        <RecordingScreen
          status={rec.status}
          levels={rec.levels}
          transcript={rec.transcript}
          transcriptLang={rec.transcriptLang}
          paused={rec.paused}
          stopping={rec.stopping}
          onPause={rec.pauseRecording}
          onResume={rec.resumeRecording}
          onStop={rec.stopRecording}
          onCancel={rec.cancelRecording}
        />
      </div>
    )
  }

  return (
    <div className="w-screen h-screen flex flex-col overflow-hidden" style={frame}>
      <Header />

      {/* Search */}
      <div className="px-4 pt-4 pb-3">
        <div
          className="field relative flex items-center rounded-2xl px-3.5"
          style={{height: 48, background: "var(--surface)", border: "1px solid var(--border)"}}>
          <Search className="w-[18px] h-[18px] shrink-0" style={{color: "var(--text-muted)"}} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search your recordings"
            className="flex-1 bg-transparent outline-none px-2.5 text-[15px]"
            style={{color: "var(--text)"}}
          />
        </div>
      </div>

      {/* List */}
      <div className="flex-1 min-h-0 overflow-y-auto scrollbar-hide px-4 pb-28">
        {!rec.ready ? (
          <Centered>Loading…</Centered>
        ) : rec.recordings.length === 0 ? (
          <EmptyState hasMic={rec.hasMic} />
        ) : groups.length === 0 ? (
          <Centered>No matches for “{query}”.</Centered>
        ) : (
          groups.map(([label, items]) => (
            <section key={label} className="mb-5">
              <h2
                className="px-1 pt-2 pb-2 text-[12px] font-semibold tracking-wider"
                style={{color: "var(--text-muted)"}}>
                {label}
              </h2>
              <div className="flex flex-col gap-2.5">
                {items.map((item) => (
                  <RecordingRow
                    key={item.id}
                    item={item}
                    playing={rec.playingId === item.id}
                    posMs={rec.playingId === item.id ? rec.playPosMs : 0}
                    unavailable={rec.unavailableId === item.id}
                    shareFailed={rec.shareFailedId === item.id}
                    onPlay={() => rec.play(item.id)}
                    onStopPlay={rec.stopPlay}
                    onExport={() => rec.exportRecording(item.id)}
                    onExportTranscript={() => rec.exportTranscript(item.id)}
                    onDelete={() => setPendingDelete(item)}
                  />
                ))}
              </div>
            </section>
          ))
        )}
      </div>

      {/* Scrim so the list fades out behind the floating FAB */}
      <div
        className="absolute inset-x-0 bottom-0 pointer-events-none"
        style={{height: insets.bottom + 110, background: "linear-gradient(to top, var(--bg) 28%, transparent)"}}
      />

      {/* Record FAB */}
      <div
        className="absolute inset-x-0 bottom-0 flex justify-center pointer-events-none"
        style={{paddingBottom: insets.bottom + 24}}>
        <button
          type="button"
          aria-label="Start recording"
          onClick={rec.startRecording}
          disabled={!rec.hasMic}
          className="pointer-events-auto grid place-items-center rounded-full text-white active:scale-95 transition-transform disabled:opacity-40"
          style={{
            width: 66,
            height: 66,
            background: "var(--rec-grad)",
            boxShadow: "var(--shadow-fab)",
            border: "3px solid color-mix(in srgb, var(--bg) 88%, transparent)",
          }}>
          <Mic className="w-7 h-7" strokeWidth={2.3} />
        </button>
      </div>

      {pendingDelete ? (
        <ConfirmDeleteModal
          item={pendingDelete}
          onCancel={() => setPendingDelete(null)}
          onConfirm={() => {
            rec.remove(pendingDelete.id)
            setPendingDelete(null)
          }}
        />
      ) : null}
    </div>
  )
}

/** Centered confirm dialog for the permanent delete of a recording. */
function ConfirmDeleteModal({
  item,
  onCancel,
  onConfirm,
}: {
  item: RecordingItem
  onCancel: () => void
  onConfirm: () => void
}) {
  return (
    <div
      className="absolute inset-0 z-50 flex items-center justify-center p-6"
      style={{background: "color-mix(in srgb, #000 55%, transparent)"}}
      onClick={onCancel}>
      <div
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-[20rem] rounded-3xl p-5 elev"
        style={{background: "var(--surface)", border: "1px solid var(--border)", boxShadow: "var(--shadow-card)"}}>
        <div className="flex flex-col items-center text-center gap-3">
          <span
            className="grid place-items-center rounded-2xl"
            style={{width: 48, height: 48, background: "color-mix(in srgb, var(--rec) 16%, transparent)"}}>
            <Trash2 className="w-6 h-6" style={{color: "var(--rec)"}} />
          </span>
          <h2 className="text-[17px] font-bold" style={{color: "var(--text)"}}>
            Delete recording?
          </h2>
          <p className="text-[13px] leading-snug" style={{color: "var(--text-muted)"}}>
            <span className="font-semibold" style={{color: "var(--text)"}}>
              {item.title ?? item.name}
            </span>{" "}
            will be permanently deleted. This can’t be undone.
          </p>
        </div>
        <div className="flex gap-2.5 mt-5">
          <button
            type="button"
            onClick={onCancel}
            className="flex-1 h-11 rounded-full text-[15px] font-semibold press active:opacity-80"
            style={{background: "var(--surface-2)", color: "var(--text)"}}>
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="flex-1 h-11 rounded-full text-[15px] font-semibold text-white press active:opacity-90"
            style={{background: "var(--rec-grad)"}}>
            Delete
          </button>
        </div>
      </div>
    </div>
  )
}

function Centered({children}: {children: React.ReactNode}) {
  return (
    <div className="h-full grid place-items-center">
      <p className="text-[13px]" style={{color: "var(--text-muted)"}}>
        {children}
      </p>
    </div>
  )
}

function EmptyState({hasMic}: {hasMic: boolean}) {
  return (
    <div className="h-full grid place-items-center text-center px-8">
      <div className="flex flex-col items-center gap-3">
        <span
          className="grid place-items-center rounded-2xl"
          style={{width: 56, height: 56, background: "color-mix(in srgb, var(--green) 16%, transparent)"}}>
          <AudioWaveform className="w-7 h-7" style={{color: "var(--green)"}} strokeWidth={2} />
        </span>
        <p className="text-[15px] font-semibold" style={{color: "var(--text)"}}>
          No recordings yet
        </p>
        <p className="text-[13px] leading-snug max-w-[16rem]" style={{color: "var(--text-muted)"}}>
          {hasMic
            ? "Tap the mic to capture audio from your glasses. Recordings are saved on your phone."
            : "Connect glasses with a microphone to start recording."}
        </p>
      </div>
    </div>
  )
}

export default App
