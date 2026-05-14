import {useEffect, useRef, useState} from "react"
import {useNavigate} from "react-router-dom"
import {MiniappHeader, useVisibility} from "@mentra/miniapp/ui"

import "../../shared/channels"
import {useChannel} from "../hooks/useChannel"
import {Button} from "../components/button"
import {Card, CardContent, CardHeader, CardTitle} from "../components/card"
import {Label} from "../components/label"
import {Switch} from "../components/switch"
import {Shell} from "./Shell"

/**
 * CaptionsPage — renders the GlassesController's pushed state.
 *
 * Does NOT subscribe to glasses events directly (no `session.*` in the
 * WebView). Background pushes a `captions:snapshot` envelope on each
 * `session.ui.onOpen`, then hot updates on transcription / button /
 * settings changes. The page just renders what background has sent.
 *
 * User input flows the other direction via `mentra.send`:
 *   - mirror toggle  → "captions:set-mirror"
 *   - "Speak Summary" → "captions:speak-summary"
 *   - "Clear"        → "captions:clear"
 */
export default function CaptionsPage() {
  const visibility = useVisibility()
  const navigate = useNavigate()

  const snapshot = useChannel("captions:snapshot")
  const liveUpdate = useChannel("captions:live-transcript")
  const historyUpdate = useChannel("captions:history-update")
  const lastButtonUpdate = useChannel("captions:last-button")
  const settingsUpdate = useChannel("captions:settings-update")

  // Resolve a single render-time view of state, preferring hot updates
  // over the (older) snapshot. The hot-update channels arrive on every
  // change; the snapshot only on WebView open.
  const liveTranscript = liveUpdate?.text ?? snapshot?.liveTranscript ?? ""
  const history = historyUpdate?.history ?? snapshot?.history ?? []
  const lastButton = lastButtonUpdate?.label ?? snapshot?.lastButton ?? ""
  const mirrorToGlasses = settingsUpdate?.mirrorToGlasses ?? snapshot?.settings?.mirrorToGlasses ?? true
  const capabilities = snapshot?.capabilities
  const connected = snapshot?.connection?.connected ?? false

  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    scrollRef.current?.scrollTo({top: scrollRef.current.scrollHeight, behavior: "smooth"})
  }, [history])

  const hasCamera = !!capabilities?.hasCamera
  const hasMic = !!capabilities?.hasMicrophone
  const hasDisplay = !!capabilities?.hasDisplay
  const hasSpeaker = !!capabilities?.hasSpeaker
  const hasWifi = !!capabilities?.hasWifi
  const modelName = capabilities?.modelName

  const [pendingMirror, setPendingMirror] = useState<boolean | null>(null)
  const setMirror = (v: boolean) => {
    setPendingMirror(v)
    mentra.send("captions:set-mirror", {mirrorToGlasses: v})
  }
  const mirrorChecked = pendingMirror ?? mirrorToGlasses

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

      <div className="flex flex-wrap gap-1.5 border-b border-border px-5 pb-3 pt-2">
        <Chip label="Camera" on={hasCamera} />
        <Chip label="Mic" on={hasMic} />
        <Chip label="Display" on={hasDisplay} />
        <Chip label="Speaker" on={hasSpeaker} />
        <Chip label="WiFi" on={hasWifi} />
      </div>

      <div className="flex items-center justify-between px-5 py-2 text-[11px] text-muted-foreground">
        <span>
          Device: <span className="font-mono text-foreground/80">{modelName || "no glasses"}</span>
        </span>
        <Button variant="outline" size="sm" onClick={() => navigate("/tester")}>
          SDK Tester →
        </Button>
      </div>

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

      <div className="flex items-center justify-between gap-3 px-5 py-3">
        <div className="flex items-center gap-2">
          <Switch id="mirror" checked={mirrorChecked} onCheckedChange={setMirror} />
          <Label htmlFor="mirror" className="text-sm text-muted-foreground">
            Mirror to glasses
          </Label>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => mentra.send("captions:speak-summary", {})}>
            Speak Summary
          </Button>
          <Button variant="destructive" size="sm" onClick={() => mentra.send("captions:clear", {})}>
            Clear
          </Button>
        </div>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-5 pb-5">
        {history.length === 0 ? (
          <p className="mt-10 text-center text-sm leading-relaxed text-muted-foreground">
            Transcribed sentences appear here as you speak.
            {mirrorChecked && " They also show on your glasses in real time."}
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
