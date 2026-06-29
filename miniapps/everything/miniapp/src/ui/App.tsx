import {useEffect, useMemo, useRef, useState, type CSSProperties} from "react"
import {useSafeArea} from "@mentra/miniapp/ui"

import EverythingLogo from "./assets/everything_logo.png"
import {useDeveloperMode} from "./useDeveloperMode"

import type {
  ChatMessage,
  CloudClientStatus,
  EverythingBackendStatus,
  EverythingSnapshot,
} from "../shared/types"

const DEFAULT_STATUS: CloudClientStatus = {status: "disconnected", audioTransport: "none"}

const COLORS = {
  ink: "#202431",
  muted: "#747889",
  accent: "#F45D8B",
  coral: "#FF6F7D",
  sky: "#39BFE9",
  peach: "#FF9B62",
  surface: "#FFFFFF",
}

const ACCENT_STYLE: CSSProperties = {
  backgroundColor: COLORS.accent,
  color: "#FFFFFF",
  boxShadow: "0 8px 20px rgba(244, 93, 139, 0.24)",
}

const SHELL_STYLE: CSSProperties = {background: COLORS.surface}

export function App() {
  const {insets, capsuleMenu} = useSafeArea()
  const {developerMode, holdHandlers} = useDeveloperMode()

  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [recording, setRecording] = useState(false)
  const [processing, setProcessing] = useState(false)
  const [interim, setInterim] = useState("")
  const [draft, setDraft] = useState("")
  const [cloudStatus, setCloudStatus] = useState<CloudClientStatus>(DEFAULT_STATUS)
  const [backendStatus, setBackendStatus] = useState<EverythingBackendStatus>("idle")
  const [backendUrl, setBackendUrl] = useState("")
  const [lastError, setLastError] = useState<string | null>(null)

  const scrollRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const unsubs = [
      mentra.on("everything:snapshot", (snapshot: EverythingSnapshot) => {
        setMessages(snapshot.messages)
        setRecording(snapshot.recording)
        setProcessing(snapshot.processing)
        setCloudStatus(snapshot.cloudStatus)
        setBackendStatus(snapshot.backendStatus)
        setBackendUrl(snapshot.backendUrl)
        setLastError(snapshot.lastError)
      }),
      mentra.on("everything:message", (message: ChatMessage) => {
        setMessages((current) => [...current.filter((m) => m.id !== message.id), message].slice(-50))
      }),
      mentra.on("everything:recording", ({recording}) => {
        setRecording(recording)
        if (!recording) setInterim("")
      }),
      mentra.on("everything:processing", ({processing}) => setProcessing(processing)),
      mentra.on("everything:backend-status", ({status, lastError}) => {
        setBackendStatus(status)
        setLastError(lastError)
      }),
      mentra.on("everything:cloud-status", (status: CloudClientStatus) => setCloudStatus(status)),
      mentra.on("everything:interim", ({text}) => setInterim(text)),
    ]
    mentra.send("everything:request-snapshot", {})
    return () => {
      for (const unsub of unsubs) unsub()
    }
  }, [])

  // Keep the latest message in view as the conversation grows.
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages, interim, processing])

  const headerPaddingRight = capsuleMenu ? Math.max(20, capsuleMenu.width + 20) : 20
  const subtitle = recording ? "Recording…" : processing ? "Thinking…" : "Ask me anything"

  const sendDraft = () => {
    const text = draft.trim()
    if (!text || processing) return
    mentra.send("everything:send", {text})
    setDraft("")
  }

  const toggleRecording = () => {
    if (recording) mentra.send("everything:stop-recording", {})
    else mentra.send("everything:start-recording", {})
  }

  return (
    <div
      className="w-screen h-screen flex overflow-hidden font-sans"
      style={{
        ...SHELL_STYLE,
        paddingTop: insets.top,
        paddingBottom: insets.bottom,
        paddingLeft: insets.left,
        paddingRight: insets.right,
      }}>
      <div className="min-h-0 flex-1 bg-zinc-100 flex flex-col overflow-hidden">
        <header
          className="pt-4 pb-3 pl-5 bg-white border-b border-[#e3e7e6]"
          style={{paddingRight: headerPaddingRight}}
          onPointerDown={holdHandlers.onPointerDown}
          onPointerUp={holdHandlers.onPointerUp}
          onPointerLeave={holdHandlers.onPointerLeave}
          onPointerCancel={holdHandlers.onPointerCancel}>
          <div className="flex items-center gap-3 min-w-0">
            <img src={EverythingLogo} alt="" className="h-10 w-10 flex-shrink-0 rounded-lg" />
            <div className="min-w-0">
              <h1 className="m-0 text-xl font-bold truncate">Everything</h1>
              <p className="m-0 mt-0.5 text-sm text-[#6b7280] truncate">{subtitle}</p>
            </div>
          </div>
        </header>

        {developerMode && (
          <DevBar
            cloudStatus={cloudStatus}
            backendStatus={backendStatus}
            backendUrl={backendUrl}
            lastError={lastError}
          />
        )}

        <main ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto px-4 py-4">
          {messages.length === 0 ? (
            <EmptyState />
          ) : (
            <div className="flex flex-col gap-3">
              {messages.map((message) => (
                <Bubble key={message.id} message={message} />
              ))}
              {processing && <TypingBubble />}
            </div>
          )}
        </main>

        <Composer
          draft={draft}
          interim={interim}
          recording={recording}
          processing={processing}
          onDraftChange={setDraft}
          onSend={sendDraft}
          onToggleRecording={toggleRecording}
        />
      </div>
    </div>
  )
}

function EmptyState() {
  return (
    <div className="h-full flex flex-col items-center justify-center text-center">
      <img src={EverythingLogo} alt="" className="h-16 w-16 opacity-90 rounded-2xl" />
      <h2 className="mt-4 mb-1 text-lg font-bold text-[#202928]">Ask Everything</h2>
      <p className="m-0 max-w-[280px] text-sm leading-5 text-[#6b7280]">
        Type a message or tap the mic to record. Try “show me a 7-day weather chart for San Francisco.”
      </p>
    </div>
  )
}

function Bubble({message}: {message: ChatMessage}) {
  const isUser = message.role === "user"
  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[82%] rounded-2xl px-3.5 py-2.5 shadow-[0_1px_8px_rgba(16,24,24,0.05)] ${
          isUser ? "text-white" : "bg-white text-[#202928] border border-[#e0e6e4]"
        }`}
        style={isUser ? {backgroundColor: COLORS.accent} : undefined}>
        {message.text ? (
          <p className="selectable-text m-0 text-[15px] leading-5 whitespace-pre-wrap break-words">
            {message.text}
          </p>
        ) : null}
        {message.imageBase64 ? (
          <img
            src={`data:image/png;base64,${message.imageBase64}`}
            alt="Assistant chart"
            className={`mt-2 w-full rounded-xl border ${isUser ? "border-white/30" : "border-[#e0e6e4]"}`}
          />
        ) : null}
      </div>
    </div>
  )
}

function TypingBubble() {
  return (
    <div className="flex justify-start">
      <div className="rounded-2xl bg-white border border-[#e0e6e4] px-4 py-3 shadow-[0_1px_8px_rgba(16,24,24,0.05)]">
        <div className="flex items-center gap-1.5">
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              className="h-2 w-2 rounded-full bg-zinc-300 animate-pulse"
              style={{animationDelay: `${i * 150}ms`}}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

function Composer({
  draft,
  interim,
  recording,
  processing,
  onDraftChange,
  onSend,
  onToggleRecording,
}: {
  draft: string
  interim: string
  recording: boolean
  processing: boolean
  onDraftChange: (text: string) => void
  onSend: () => void
  onToggleRecording: () => void
}) {
  return (
    <footer className="bg-white border-t border-[#e3e7e6] px-3 py-2.5">
      {recording ? (
        <div className="mb-2 flex items-center gap-2 px-1">
          <span
            className="h-2 w-2 rounded-full flex-shrink-0 animate-pulse"
            style={{backgroundColor: COLORS.accent}}
          />
          <p className="m-0 text-sm leading-5 text-[#46524f] line-clamp-2 min-w-0">{interim || "Listening…"}</p>
        </div>
      ) : null}
      <div className="flex items-end gap-2">
        <button
          aria-label={recording ? "Stop recording" : "Start recording"}
          onClick={onToggleRecording}
          className="h-11 w-11 flex-shrink-0 rounded-full inline-flex items-center justify-center transition-colors"
          style={recording ? ACCENT_STYLE : {backgroundColor: "#f1f5f4", color: COLORS.ink}}>
          <MicIcon active={recording} />
        </button>
        <textarea
          value={draft}
          onChange={(event) => onDraftChange(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault()
              onSend()
            }
          }}
          rows={1}
          placeholder="Message Everything…"
          className="flex-1 max-h-28 resize-none rounded-2xl border border-[#e0e6e4] bg-[#f8faf9] px-4 py-2.5 text-[15px] leading-5 text-[#202431] outline-none"
        />
        <button
          aria-label="Send"
          onClick={onSend}
          disabled={!draft.trim() || processing}
          className="h-11 w-11 flex-shrink-0 rounded-full inline-flex items-center justify-center transition-colors disabled:opacity-40"
          style={ACCENT_STYLE}>
          <SendIcon />
        </button>
      </div>
    </footer>
  )
}

function DevBar({
  cloudStatus,
  backendStatus,
  backendUrl,
  lastError,
}: {
  cloudStatus: CloudClientStatus
  backendStatus: EverythingBackendStatus
  backendUrl: string
  lastError: string | null
}) {
  const cloud = useMemo(() => cloudPresentation(cloudStatus), [cloudStatus])
  const backend = useMemo(() => backendPresentation(backendStatus), [backendStatus])
  return (
    <section className="px-4 py-2 bg-white border-b border-[#e3e7e6]">
      <div className="flex items-center gap-1.5 overflow-x-auto">
        <Pill label={cloud.label} color={cloud.color} />
        <Pill label={backend.label} color={backend.color} />
        <span className="text-[10px] font-semibold uppercase text-[#9aa4a0] whitespace-nowrap">{backendUrl}</span>
      </div>
      {lastError ? <p className="m-0 mt-1 text-[11px] leading-4 text-[#b94a5a] break-words">{lastError}</p> : null}
    </section>
  )
}

function Pill({label, color}: {label: string; color: string}) {
  return (
    <div className="flex items-center gap-1.5 rounded-full border border-[#dbe3e0] bg-[#f8faf9] px-2 py-1 flex-shrink-0">
      <span className="h-2 w-2 rounded-full flex-shrink-0" style={{backgroundColor: color}} />
      <span className="text-[11px] font-bold text-[#24302d] whitespace-nowrap">{label}</span>
    </div>
  )
}

function cloudPresentation(status: CloudClientStatus): {label: string; color: string} {
  if (status.audioTransport === "ws" || status.audioTransport === "udp") return {label: "Cloud", color: COLORS.sky}
  if (status.status === "connecting" || status.status === "reconnecting")
    return {label: "Cloud retry", color: COLORS.peach}
  return {label: "Cloud off", color: COLORS.muted}
}

function backendPresentation(status: EverythingBackendStatus): {label: string; color: string} {
  if (status === "processing") return {label: "AI busy", color: COLORS.peach}
  if (status === "ok") return {label: "AI ready", color: COLORS.sky}
  if (status === "unconfigured") return {label: "AI key", color: COLORS.peach}
  if (status === "error") return {label: "AI off", color: COLORS.coral}
  return {label: "AI idle", color: COLORS.muted}
}

function MicIcon({active}: {active: boolean}) {
  return (
    <svg
      className="w-5 h-5"
      viewBox="0 0 24 24"
      fill="none"
      stroke={active ? "#FFFFFF" : COLORS.ink}
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round">
      <path d="M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
      <path d="M19 10v1a7 7 0 0 1-14 0v-1" />
      <path d="M12 18v4" />
    </svg>
  )
}

function SendIcon() {
  return (
    <svg
      className="w-5 h-5"
      viewBox="0 0 24 24"
      fill="none"
      stroke="#FFFFFF"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round">
      <path d="m22 2-7 20-4-9-9-4 20-7Z" />
    </svg>
  )
}

export default App
