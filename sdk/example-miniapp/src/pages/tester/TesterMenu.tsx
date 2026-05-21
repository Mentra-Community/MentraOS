// Tester page — diagnostic surface, ephemeral by design.
// This is the ONLY place in the example where inline-subscribing to
// `session.*` (or imperative one-shot calls in response to user input)
// is acceptable. User-facing glasses logic must live in
// src/controller/GlassesController.ts.

import {useNavigate} from "react-router-dom"
import {MiniappHeader, useCapabilities} from "@mentra/miniapp/react"

import {Shell} from "../Shell"

interface Row {
  emoji: string
  title: string
  subtitle: string
  path: string
  /** Gate requirement for this row. undefined = always enabled. */
  requires?: "mentra-live"
  badge?: "soon" | "mentra-live-only"
}

// Order mirrors the SDK module overview doc: output first (display, speaker),
// then input (mic, transcription, translation, input, location, imu),
// then state (glasses, phone), then misc (system, led, storage, permissions),
// then placeholders.
const ROWS: Row[] = [
  {emoji: "🖥️", title: "session.display", subtitle: "text walls, cards, bitmaps", path: "/tester/display"},
  {emoji: "🔊", title: "session.speaker", subtitle: "play URL, speak text", path: "/tester/speaker"},
  {emoji: "🎙️", title: "session.mic", subtitle: "audio chunks, VAD, stop()", path: "/tester/mic"},
  {emoji: "📝", title: "session.transcription", subtitle: "on / forLanguage / configure / stop", path: "/tester/transcription"},
  {emoji: "🌐", title: "session.translation", subtitle: "forLanguagePair, stop", path: "/tester/translation"},
  {emoji: "👆", title: "session.input", subtitle: "buttons, touch + gesture filters", path: "/tester/input"},
  {emoji: "📍", title: "session.location", subtitle: "GPS updates", path: "/tester/location"},
  {emoji: "↕️", title: "session.imu", subtitle: "head position", path: "/tester/imu"},
  {emoji: "👓", title: "session.glasses", subtitle: "battery, connection", path: "/tester/glasses"},
  {emoji: "📱", title: "session.phone", subtitle: "battery, notifications, calendar", path: "/tester/phone"},
  {emoji: "🔗", title: "session.system", subtitle: "share, open URL, clipboard", path: "/tester/system"},
  {
    emoji: "💡",
    title: "session.led",
    subtitle: "color, blink, solid",
    path: "/tester/led",
    requires: "mentra-live",
    badge: "mentra-live-only",
  },
  {emoji: "📦", title: "session.storage", subtitle: "get / set / delete / list", path: "/tester/storage"},
  {emoji: "🔐", title: "session.permissions", subtitle: "has / getAll / onUpdate / errors", path: "/tester/permissions"},
  {
    emoji: "⏳",
    title: "Coming Soon",
    subtitle: "camera, streaming, dashboard",
    path: "/tester/coming-soon",
    badge: "soon",
  },
]

function Badge({badge}: {badge?: Row["badge"]}) {
  if (!badge) return null
  if (badge === "soon") {
    return (
      <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-[1px] text-[10px] font-medium uppercase tracking-wider text-amber-500">
        soon
      </span>
    )
  }
  if (badge === "mentra-live-only") {
    return (
      <span className="rounded-full border border-blue-500/40 bg-blue-500/10 px-2 py-[1px] text-[10px] font-medium uppercase tracking-wider text-blue-500">
        Mentra Live only
      </span>
    )
  }
  return null
}

export default function TesterMenu() {
  const navigate = useNavigate()
  const caps = useCapabilities() as Record<string, unknown> | null
  const modelName = (caps?.modelName as string | undefined) ?? ""
  const isMentraLive = modelName.toLowerCase().includes("live")

  return (
    <Shell>
      <MiniappHeader title="SDK Tester" onBack={() => navigate("/")} />

      <div className="flex-1 overflow-y-auto px-4 pb-6">
        <p className="mb-3 px-1 text-[13px] text-muted-foreground">
          Each section exercises one module of the @mentra/miniapp SDK. Use this to verify your glasses + phone + miniapp host are talking correctly.
        </p>
        <div className="flex flex-col gap-2">
          {ROWS.map((row) => {
            const disabled = row.requires === "mentra-live" && !isMentraLive
            return (
              <button
                key={row.path}
                onClick={() => {
                  if (!disabled) navigate(row.path)
                }}
                disabled={disabled}
                className={`group flex items-center gap-3 rounded-xl border border-border px-4 py-3 text-left transition ${
                  disabled
                    ? "cursor-not-allowed bg-muted/30 opacity-55"
                    : "bg-card hover:border-mentra-green/40 hover:bg-mentra-green/5"
                }`}>
                <div className="text-2xl">{row.emoji}</div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-sm font-semibold">{row.title}</span>
                    <Badge badge={row.badge} />
                  </div>
                  <div className="truncate text-[12px] text-muted-foreground">
                    {disabled ? `Requires Mentra Live (connected: ${modelName || "no glasses"})` : row.subtitle}
                  </div>
                </div>
                {!disabled && <div className="text-muted-foreground group-hover:text-foreground">›</div>}
              </button>
            )
          })}
        </div>
      </div>
    </Shell>
  )
}
