import {useEffect, useRef} from "react"
import {useNavigate} from "react-router-dom"
import {
  MiniappHeader,
  useCapabilities,
  useConnected,
  useVisibility,
} from "@mentra/miniapp/react"

import {getGlassesController} from "../controller/GlassesController"
import {useAppStore} from "../store/appStore"
import {Button} from "../ui/button"
import {Card, CardContent, CardHeader, CardTitle} from "../ui/card"
import {Label} from "../ui/label"
import {Switch} from "../ui/switch"
import {Shell} from "./Shell"

/**
 * CaptionsPage — viewer for the GlassesController's app state.
 *
 * Does NOT subscribe to session events. Reads from `useAppStore`; calls
 * imperative methods on the GlassesController for things the user
 * triggers (clear, speak summary, mirror toggle).
 *
 * Closing this page does NOT stop transcription on the glasses — the
 * controller keeps running. Tester pages (src/pages/tester/) are the
 * only place in this example where inline-subscribe to `session.*` is
 * acceptable, because they're diagnostic surfaces by design.
 */
export default function CaptionsPage() {
  const connected = useConnected()
  const caps = useCapabilities()
  const visibility = useVisibility()
  const navigate = useNavigate()

  // Read from the controller-driven store — no session subscriptions.
  const liveTranscript = useAppStore((s) => s.liveTranscript)
  const history = useAppStore((s) => s.history)
  const lastButton = useAppStore((s) => s.lastButton)
  const mirrorToGlasses = useAppStore((s) => s.mirrorToGlasses)
  const setMirrorToGlasses = useAppStore((s) => s.setMirrorToGlasses)

  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    scrollRef.current?.scrollTo({top: scrollRef.current.scrollHeight, behavior: "smooth"})
  }, [history])

  const hasCamera = !!(caps && (caps as Record<string, unknown>).hasCamera)
  const hasMic = !!(caps && (caps as Record<string, unknown>).hasMicrophone)
  const hasDisplay = !!(caps && (caps as Record<string, unknown>).hasDisplay)
  const hasSpeaker = !!(caps && (caps as Record<string, unknown>).hasSpeaker)
  const hasWifi = !!(caps && (caps as Record<string, unknown>).hasWifi)
  const modelName = (caps as Record<string, unknown>)?.modelName as string | undefined

  // Imperative actions — delegate to the controller.
  const onClear = () => getGlassesController().clearGlasses()
  const onSpeak = () => getGlassesController().speakSummary()

  return (
    <Shell>
      <MiniappHeader
        left={
          <span
            className={`h-2 w-2 rounded-full ${connected ? "bg-mentra-green shadow-[0_0_8px_var(--mentra-green-10)]" : "bg-destructive"}`}
          />
        }
        title="Live Captions"
      />

      {/* Capabilities bar */}
      <div className="flex flex-wrap gap-1.5 border-b border-border px-5 pb-3 pt-2">
        <Chip label="Camera" on={hasCamera} />
        <Chip label="Mic" on={hasMic} />
        <Chip label="Display" on={hasDisplay} />
        <Chip label="Speaker" on={hasSpeaker} />
        <Chip label="WiFi" on={hasWifi} />
      </div>

      {/* Device info row (replaces old header badge) */}
      <div className="flex items-center justify-between px-5 py-2 text-[11px] text-muted-foreground">
        <span>
          Device: <span className="font-mono text-foreground/80">{modelName || "no glasses"}</span>
        </span>
        <Button variant="outline" size="sm" onClick={() => navigate("/tester")}>
          SDK Tester →
        </Button>
      </div>

      {/* Live transcript */}
      <Card className="mx-5 mt-1 gap-2 py-4">
        <CardHeader className="gap-0 px-4">
          <CardTitle className="text-[10px] font-bold tracking-[0.15em] text-mentra-green">
            {hasMic ? "LISTENING" : "NO MICROPHONE"}
          </CardTitle>
        </CardHeader>
        <CardContent className="px-4">
          <p className="m-0 text-xl font-light leading-snug">
            {liveTranscript || <span className="text-muted-foreground">Waiting for speech…</span>}
          </p>
        </CardContent>
      </Card>

      {/* Controls */}
      <div className="flex items-center justify-between gap-3 px-5 py-3">
        <div className="flex items-center gap-2">
          <Switch id="mirror" checked={mirrorToGlasses} onCheckedChange={setMirrorToGlasses} />
          <Label htmlFor="mirror" className="text-sm text-muted-foreground">
            Mirror to glasses
          </Label>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={onSpeak}>
            Speak Summary
          </Button>
          <Button variant="destructive" size="sm" onClick={onClear}>
            Clear
          </Button>
        </div>
      </div>

      {/* Transcript history */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-5 pb-5">
        {history.length === 0 ? (
          <p className="mt-10 text-center text-sm leading-relaxed text-muted-foreground">
            Transcribed sentences appear here as you speak.
            {mirrorToGlasses && " They also show on your glasses in real time."}
          </p>
        ) : (
          history.map((line, i) => (
            <div key={i} className="flex gap-3 border-b border-border/50 py-2.5 text-sm leading-relaxed">
              <span className="min-w-5 pt-0.5 font-mono text-[11px] text-muted-foreground">{i + 1}</span>
              <span>{line}</span>
            </div>
          ))
        )}
      </div>

      {/* Footer */}
      <footer className="flex justify-between border-t border-border px-5 py-2.5 text-[11px] text-muted-foreground">
        {lastButton ? <span>Button: {lastButton}</span> : <span />}
        <span>
          {history.length} sentence{history.length !== 1 ? "s" : ""}
        </span>
        <span>{visibility}</span>
      </footer>
    </Shell>
  )
}

function Chip({label, on}: {label: string; on: boolean}) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-[3px] text-[11px] font-medium ${
        on
          ? "border-mentra-green/40 bg-mentra-green/15 text-mentra-green"
          : "border-border bg-muted text-muted-foreground"
      }`}>
      <span className={`h-1.5 w-1.5 rounded-full ${on ? "bg-mentra-green" : "bg-muted-foreground/50"}`} />
      {label}
    </span>
  )
}
