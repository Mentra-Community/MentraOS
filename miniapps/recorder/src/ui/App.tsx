import {useEffect} from "react"
import {AudioWaveform} from "lucide-react"
import {useColorScheme, useSafeArea} from "@mentra/miniapp/ui"

import {Header} from "./components/Header"
import {RecordButton} from "./components/RecordButton"
import {RecordingRow} from "./components/RecordingRow"
import {useRecorder} from "./hooks/useRecorder"

/**
 * App — the WebView root for the Recorder miniapp. A thin control surface over
 * the background controller (the source of truth). Light theme by default; the
 * dark palette is applied when the Mentra host reports a dark color scheme.
 */
export function App() {
  const scheme = useColorScheme()
  const {insets} = useSafeArea()
  const rec = useRecorder()

  // Apply the host color scheme. Light is the default (no class).
  useEffect(() => {
    document.documentElement.classList.toggle("dark", scheme === "dark")
  }, [scheme])

  return (
    <div
      className="w-screen h-screen flex flex-col overflow-hidden"
      style={{
        background: "var(--bg)",
        paddingTop: insets.top,
        paddingBottom: insets.bottom,
        paddingLeft: insets.left,
        paddingRight: insets.right,
      }}>
      <Header usage={rec.usage} onClearAll={rec.clearAll} />

      <RecordButton status={rec.status} hasMic={rec.hasMic} onStart={rec.startRecording} onStop={rec.stopRecording} />

      <div className="flex-1 min-h-0 overflow-y-auto scrollbar-hide px-4 pb-5">
        {!rec.ready ? (
          <div className="h-full grid place-items-center">
            <p className="text-[13px]" style={{color: "var(--text-muted)"}}>
              Loading…
            </p>
          </div>
        ) : rec.recordings.length === 0 ? (
          <EmptyState recording={rec.isRecording} />
        ) : (
          <div className="flex flex-col gap-2.5">
            {rec.recordings.map((item) => (
              <RecordingRow
                key={item.id}
                item={item}
                playing={rec.playingId === item.id}
                onPlay={() => rec.play(item.id)}
                onStopPlay={rec.stopPlay}
                onExport={() => rec.exportRecording(item.id)}
                onDelete={() => rec.remove(item.id)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function EmptyState({recording}: {recording: boolean}) {
  return (
    <div className="h-full grid place-items-center text-center px-8">
      <div className="flex flex-col items-center gap-3">
        <span
          className="grid place-items-center rounded-2xl"
          style={{width: 56, height: 56, background: "color-mix(in srgb, var(--accent) 14%, transparent)"}}>
          <AudioWaveform className="w-7 h-7" style={{color: "var(--accent)"}} strokeWidth={2} />
        </span>
        <p className="text-[15px] font-semibold" style={{color: "var(--text)"}}>
          {recording ? "Recording…" : "No recordings yet"}
        </p>
        <p className="text-[13px] leading-snug max-w-[16rem]" style={{color: "var(--text-muted)"}}>
          {recording
            ? "Audio from your glasses is being captured to a file on your phone."
            : "Hit record to capture audio from your glasses microphone. Recordings are saved on your phone as WAV files you can play back or export."}
        </p>
      </div>
    </div>
  )
}

export default App
