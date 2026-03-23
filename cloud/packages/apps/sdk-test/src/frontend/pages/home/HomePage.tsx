import {useState, useEffect, useCallback, useRef} from "react"
import {Mic, Square, Loader2, Wifi, WifiOff, Camera, X, ChevronDown, ChevronUp, Volume2} from "lucide-react"

interface HomePageProps {
  userId: string
}

interface Photo {
  id: string
  requestId: string
  url: string
  timestamp: string
}

interface TranscriptEntry {
  id: number
  role: "user" | "ai"
  text: string
  time: string
}

type SessionStatus = "idle" | "connecting" | "active" | "error"

export default function HomePage({userId}: HomePageProps) {
  const [status, setStatus] = useState<SessionStatus>("idle")
  const [error, setError] = useState<string | null>(null)
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([])
  const [photos, setPhotos] = useState<Photo[]>([])
  const [photosExpanded, setPhotosExpanded] = useState(true)
  const [selectedPhoto, setSelectedPhoto] = useState<Photo | null>(null)
  const [provider, setProvider] = useState<"gemini" | "openai">("gemini")
  const [toneActive, setToneActive] = useState(false)
  const toneStartTime = useRef<number>(0)
  const transcriptEndRef = useRef<HTMLDivElement>(null)
  const idCounter = useRef(0)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Auto-scroll transcript
  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({behavior: "smooth"})
  }, [transcript])

  // Poll realtime status
  useEffect(() => {
    const check = async () => {
      try {
        const res = await fetch(`/api/realtime/status?userId=${encodeURIComponent(userId)}`)
        const data = await res.json()
        if (data.active && status === "idle") {
          setStatus("active")
        } else if (!data.active && status === "active") {
          setStatus("idle")
        }
      } catch {}
    }
    pollRef.current = setInterval(check, 3000)
    check()
    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, [userId, status])

  // Connect to transcription SSE stream
  useEffect(() => {
    if (!userId) return
    let es: EventSource | null = null

    const connect = () => {
      es = new EventSource(`/api/stream/transcription?userId=${encodeURIComponent(userId)}`)

      es.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data)
          if (data.type === "connected") return
          if (!data.text || !data.isFinal) return

          setTranscript((prev) => [
            ...prev,
            {
              id: idCounter.current++,
              role: "user",
              text: data.text,
              time: new Date().toLocaleTimeString([], {hour: "2-digit", minute: "2-digit"}),
            },
          ])
        } catch {}
      }

      es.onerror = () => {
        es?.close()
        setTimeout(connect, 3000)
      }
    }

    connect()
    return () => es?.close()
  }, [userId])

  // Connect to photo SSE stream
  useEffect(() => {
    if (!userId) return
    let es: EventSource | null = null

    const connect = () => {
      es = new EventSource(`/api/stream/photo?userId=${encodeURIComponent(userId)}`)

      es.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data)
          if (data.type === "connected") return

          setPhotos((prev) => {
            if (prev.some((p) => p.requestId === data.requestId)) return prev
            return [
              {
                id: data.requestId,
                requestId: data.requestId,
                url: data.dataUrl,
                timestamp: new Date(data.timestamp).toLocaleTimeString([], {hour: "2-digit", minute: "2-digit"}),
              },
              ...prev,
            ].slice(0, 20)
          })
        } catch {}
      }

      es.onerror = () => {
        es?.close()
        setTimeout(connect, 3000)
      }
    }

    connect()
    return () => es?.close()
  }, [userId])

  const startSession = useCallback(async () => {
    setError(null)
    setStatus("connecting")

    try {
      const res = await fetch("/api/realtime/start", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({userId, provider}),
      })

      const data = await res.json()

      if (!res.ok) {
        throw new Error(data.error || "Failed to start session")
      }

      setStatus("active")
      setTranscript([])
    } catch (err: any) {
      setError(err.message)
      setStatus("error")
      setTimeout(() => setStatus("idle"), 3000)
    }
  }, [userId, provider])

  const stopSession = useCallback(async () => {
    try {
      await fetch("/api/realtime/stop", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({userId}),
      })
    } catch {}
    setStatus("idle")
  }, [userId])

  const handleMicButton = useCallback(() => {
    if (status === "active") {
      stopSession()
    } else if (status === "idle" || status === "error") {
      startSession()
    }
  }, [status, startSession, stopSession])

  // ─── Tone test (press-and-hold) ──────────────────────────────────────────

  const startTone = useCallback(async () => {
    if (toneActive) return
    setToneActive(true)
    toneStartTime.current = Date.now()
    try {
      await fetch("/api/audio/tone/start", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({userId, frequency: 440}),
      })
    } catch {
      setToneActive(false)
    }
  }, [userId, toneActive])

  const stopTone = useCallback(async () => {
    if (!toneActive) return
    setToneActive(false)
    try {
      await fetch("/api/audio/tone/stop", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({userId}),
      })
    } catch {
      // ignore
    }
  }, [userId, toneActive])

  const statusLabel = {
    idle: "Tap to start",
    connecting: "Connecting...",
    active: "Listening",
    error: "Error",
  }[status]

  const statusColor = {
    idle: "text-zinc-400",
    connecting: "text-amber-400",
    active: "text-emerald-400",
    error: "text-red-400",
  }[status]

  return (
    <div className="min-h-screen bg-zinc-950 text-white flex flex-col">
      {/* Header */}
      <header className="flex items-center justify-between px-5 pt-5 pb-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Voice Assistant</h1>
          <p className="text-xs text-zinc-500">MentraOS SDK Test</p>
        </div>
        <div className="flex items-center gap-2">
          {status === "active" ? (
            <Wifi className="w-4 h-4 text-emerald-400" />
          ) : (
            <WifiOff className="w-4 h-4 text-zinc-600" />
          )}
          <span className="text-xs text-zinc-600 font-mono">{userId?.split("@")[0]}</span>
        </div>
      </header>

      {/* Provider Toggle */}
      {status === "idle" && (
        <div className="flex items-center justify-center gap-1 px-5">
          <button
            onClick={() => setProvider("gemini")}
            className={`px-3 py-1.5 rounded-l-lg text-xs font-medium transition-colors ${
              provider === "gemini"
                ? "bg-blue-600/20 border border-blue-500/40 text-blue-300"
                : "bg-zinc-800/50 border border-zinc-700/30 text-zinc-500 hover:text-zinc-300"
            }`}>
            Gemini
          </button>
          <button
            onClick={() => setProvider("openai")}
            className={`px-3 py-1.5 rounded-r-lg text-xs font-medium transition-colors ${
              provider === "openai"
                ? "bg-emerald-600/20 border border-emerald-500/40 text-emerald-300"
                : "bg-zinc-800/50 border border-zinc-700/30 text-zinc-500 hover:text-zinc-300"
            }`}>
            OpenAI
          </button>
        </div>
      )}

      {/* Photo Strip */}
      {photos.length > 0 && (
        <div className="px-5">
          <button
            onClick={() => setPhotosExpanded((p) => !p)}
            className="flex items-center gap-2 text-xs text-zinc-500 hover:text-zinc-300 transition-colors mb-2">
            <Camera className="w-3.5 h-3.5" />
            <span>Photos ({photos.length})</span>
            {photosExpanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
          </button>

          {photosExpanded && (
            <div className="flex gap-2 overflow-x-auto pb-3 scrollbar-hide">
              {photos.map((photo) => (
                <button
                  key={photo.id}
                  onClick={() => setSelectedPhoto(photo)}
                  className="flex-shrink-0 relative group rounded-lg overflow-hidden bg-zinc-800 border border-zinc-800 hover:border-zinc-600 transition-colors">
                  <img src={photo.url} alt={`Captured at ${photo.timestamp}`} className="w-20 h-20 object-cover" />
                  <div className="absolute bottom-0 inset-x-0 bg-gradient-to-t from-black/70 to-transparent px-1.5 py-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    <span className="text-[9px] text-white/80 font-mono">{photo.timestamp}</span>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Transcript Area */}
      <div className="flex-1 overflow-y-auto px-5 py-3 space-y-3">
        {transcript.length === 0 && status === "idle" && (
          <div className="flex flex-col items-center justify-center h-full opacity-40 select-none">
            <Mic className="w-12 h-12 mb-4 text-zinc-600" />
            <p className="text-sm text-zinc-500 text-center leading-relaxed">
              Start a conversation with AI.
              <br />
              Speak naturally through your glasses.
            </p>
          </div>
        )}

        {transcript.length === 0 && status === "active" && (
          <div className="flex flex-col items-center justify-center h-full opacity-60 select-none">
            <div className="relative">
              <div className="w-4 h-4 bg-emerald-400 rounded-full animate-ping absolute inset-0 m-auto" />
              <div className="w-4 h-4 bg-emerald-400 rounded-full relative" />
            </div>
            <p className="text-sm text-zinc-400 mt-4">Listening... say something</p>
          </div>
        )}

        {transcript.map((entry) => (
          <div key={entry.id} className={`flex ${entry.role === "user" ? "justify-end" : "justify-start"}`}>
            <div
              className={`max-w-[85%] rounded-2xl px-4 py-2.5 ${
                entry.role === "user"
                  ? "bg-blue-600/20 border border-blue-500/20 text-blue-100"
                  : "bg-zinc-800/80 border border-zinc-700/50 text-zinc-200"
              }`}>
              <p className="text-sm leading-relaxed">{entry.text}</p>
              <p className="text-[10px] mt-1 opacity-40">{entry.time}</p>
            </div>
          </div>
        ))}

        <div ref={transcriptEndRef} />
      </div>

      {/* Error Banner */}
      {error && (
        <div className="mx-5 mb-2 px-4 py-2 rounded-lg bg-red-500/10 border border-red-500/20">
          <p className="text-xs text-red-400">{error}</p>
        </div>
      )}

      {/* Bottom Controls */}
      <div className="flex flex-col items-center pb-8 pt-4 gap-3">
        {/* Status */}
        <div className="flex items-center gap-2">
          {status === "active" && (
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-400" />
            </span>
          )}
          <span className={`text-xs font-medium ${statusColor}`}>
            {status === "active" ? `${statusLabel} · ${provider}` : statusLabel}
          </span>
        </div>

        {/* Mic Button */}
        <button
          onClick={handleMicButton}
          disabled={status === "connecting"}
          className={`
            relative w-20 h-20 rounded-full flex items-center justify-center
            transition-all duration-300 active:scale-95
            ${
              status === "active"
                ? "bg-red-500/20 border-2 border-red-500/60 shadow-[0_0_30px_rgba(239,68,68,0.2)]"
                : status === "connecting"
                ? "bg-amber-500/10 border-2 border-amber-500/30"
                : "bg-white/5 border-2 border-white/10 hover:bg-white/10 hover:border-white/20"
            }
          `}>
          {/* Pulse ring when active */}
          {status === "active" && (
            <span className="absolute inset-0 rounded-full border-2 border-red-500/30 animate-ping" />
          )}

          {status === "connecting" ? (
            <Loader2 className="w-8 h-8 text-amber-400 animate-spin" />
          ) : status === "active" ? (
            <Square className="w-7 h-7 text-red-400 fill-red-400" />
          ) : (
            <Mic className="w-8 h-8 text-zinc-300" />
          )}
        </button>

        {/* Hint */}
        {status === "active" && <p className="text-[11px] text-zinc-600">Tap to stop</p>}

        {/* Tone Test Button — press and hold */}
        <button
          onPointerDown={startTone}
          onPointerUp={stopTone}
          onPointerLeave={stopTone}
          onContextMenu={(e) => e.preventDefault()}
          className={`
            flex items-center gap-2 px-4 py-2 rounded-full text-xs font-medium
            select-none touch-none transition-all duration-150
            ${
              toneActive
                ? "bg-amber-500/20 border border-amber-500/50 text-amber-300 scale-95"
                : "bg-zinc-800/50 border border-zinc-700/30 text-zinc-500 hover:text-zinc-300 hover:border-zinc-600"
            }
          `}>
          <Volume2 className={`w-3.5 h-3.5 ${toneActive ? "text-amber-400" : ""}`} />
          {toneActive ? "Playing tone..." : "Hold to test audio"}
        </button>
      </div>

      {/* Photo Lightbox */}
      {selectedPhoto && (
        <div
          className="fixed inset-0 z-50 bg-black/90 flex items-center justify-center p-4"
          onClick={() => setSelectedPhoto(null)}>
          <button
            onClick={() => setSelectedPhoto(null)}
            className="absolute top-4 right-4 w-10 h-10 rounded-full bg-white/10 flex items-center justify-center hover:bg-white/20 transition-colors">
            <X className="w-5 h-5" />
          </button>
          <img
            src={selectedPhoto.url}
            alt={`Photo from ${selectedPhoto.timestamp}`}
            className="max-w-full max-h-[85vh] rounded-xl object-contain"
            onClick={(e) => e.stopPropagation()}
          />
          <div className="absolute bottom-6 text-center">
            <span className="text-xs text-zinc-400 font-mono">{selectedPhoto.timestamp}</span>
          </div>
        </div>
      )}
    </div>
  )
}
