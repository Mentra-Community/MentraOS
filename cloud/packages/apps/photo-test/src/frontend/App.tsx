import {useState, useEffect, useCallback, useRef} from "react"
import {useMentraAuth} from "@mentra/react"

// ─── Types ───────────────────────────────────────────────────────────────────

interface PhotoTestResult {
  requestId: string
  status: "success" | "error" | "timeout" | "pending"
  startedAt: number
  completedAt?: number
  durationMs?: number
  errorMessage?: string
  errorCode?: string
  photoSize?: number
  photoMimeType?: string
  wasGenericTimeout: boolean
}

// ─── App ─────────────────────────────────────────────────────────────────────

export default function App() {
  const {userId, isLoading, error, isAuthenticated} = useMentraAuth()

  if (isLoading) {
    return (
      <div className="min-h-screen bg-neutral-950 flex items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 border-2 border-neutral-700 border-t-white rounded-full animate-spin" />
          <p className="text-sm text-neutral-400">Authenticating…</p>
        </div>
      </div>
    )
  }

  if (error || !isAuthenticated || !userId) {
    return (
      <div className="min-h-screen bg-neutral-950 flex items-center justify-center p-6">
        <div className="text-center max-w-sm">
          <h1 className="text-xl font-semibold text-white mb-2">📸 Photo Test</h1>
          {error ? (
            <p className="text-red-400 text-sm mb-4">{error}</p>
          ) : (
            <p className="text-neutral-400 text-sm mb-4">Open this page from the MentraOS app, or sign in below.</p>
          )}
          <a href="/mentra-auth" className="inline-block">
            <img
              src="https://account.mentra.glass/sign-in-mentra.png"
              alt="Sign in with Mentra"
              width={160}
              height={56}
              className="mx-auto"
            />
          </a>
        </div>
      </div>
    )
  }

  return <PhotoTestDashboard userId={userId} />
}

// ─── Dashboard ───────────────────────────────────────────────────────────────

function PhotoTestDashboard({userId}: {userId: string}) {
  const [results, setResults] = useState<Map<string, PhotoTestResult>>(new Map())
  const [sseConnected, setSseConnected] = useState(false)
  const [glassesConnected, setGlassesConnected] = useState(false)
  const [isTaking, setIsTaking] = useState(false)
  const [isRapidFiring, setIsRapidFiring] = useState(false)
  const eventSourceRef = useRef<EventSource | null>(null)

  // Connect SSE on mount
  useEffect(() => {
    const es = new EventSource(`/api/photo/stream?userId=${encodeURIComponent(userId)}`)

    es.onopen = () => setSseConnected(true)
    es.onerror = () => setSseConnected(false)
    es.onmessage = (e) => {
      try {
        const result: PhotoTestResult = JSON.parse(e.data)
        setResults((prev) => {
          const next = new Map(prev)
          next.set(result.requestId, result)
          return next
        })
      } catch {
        // ignore parse errors
      }
    }

    eventSourceRef.current = es

    return () => {
      es.close()
      eventSourceRef.current = null
    }
  }, [userId])

  // Poll glasses session status
  useEffect(() => {
    let active = true

    const check = async () => {
      try {
        const res = await fetch(`/api/session/status?userId=${encodeURIComponent(userId)}`)
        const data = (await res.json()) as {connected?: boolean}
        if (active) setGlassesConnected(!!data.connected)
      } catch {
        if (active) setGlassesConnected(false)
      }
    }

    check()
    const interval = setInterval(check, 5000)
    return () => {
      active = false
      clearInterval(interval)
    }
  }, [userId])

  // Actions
  const takePhoto = useCallback(
    async (options?: {size?: string; compress?: string}) => {
      setIsTaking(true)
      try {
        await fetch(`/api/photo/take?userId=${encodeURIComponent(userId)}`, {
          method: "POST",
          headers: {"Content-Type": "application/json"},
          body: JSON.stringify(options || {}),
        })
      } catch {
        // errors show in results via SSE
      } finally {
        setIsTaking(false)
      }
    },
    [userId],
  )

  const rapidFire = useCallback(async () => {
    setIsRapidFiring(true)
    try {
      await fetch(`/api/photo/take-rapid?userId=${encodeURIComponent(userId)}`, {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({count: 3}),
      })
    } catch {
      // errors show in results via SSE
    } finally {
      setIsRapidFiring(false)
    }
  }, [userId])

  const clearResults = useCallback(async () => {
    setResults(new Map())
    await fetch(`/api/photo/results?userId=${encodeURIComponent(userId)}`, {method: "DELETE"}).catch(() => {})
  }, [userId])

  // Derived data
  const sortedResults = Array.from(results.values()).sort((a, b) => b.startedAt - a.startedAt)
  const counts = {
    total: sortedResults.length,
    success: sortedResults.filter((r) => r.status === "success").length,
    error: sortedResults.filter((r) => r.status === "error").length,
    timeout: sortedResults.filter((r) => r.status === "timeout").length,
  }

  const canAct = glassesConnected && !isTaking

  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-200 p-4 max-w-2xl mx-auto">
      {/* Header */}
      <h1 className="text-xl font-semibold mb-0.5">📸 Photo Request Test</h1>
      <p className="text-xs text-neutral-500 mb-4">
        Verify <span className="text-amber-400 font-semibold">OS-947</span> &{" "}
        <span className="text-amber-400 font-semibold">OS-951</span> — error messages instead of generic timeouts
      </p>

      {/* Status bar */}
      <div className="flex items-center gap-3 p-3 rounded-lg bg-neutral-900 border border-neutral-800 mb-3 text-xs">
        <StatusDot ok={sseConnected} label="SSE" />
        <StatusDot ok={glassesConnected} label="Glasses" />
        <span className="text-neutral-600 ml-auto font-mono">{userId.slice(0, 24)}…</span>
      </div>

      {!glassesConnected && (
        <div className="p-3 rounded-lg bg-amber-950/40 border border-amber-800/50 text-amber-300 text-xs mb-3">
          ⚠️ No glasses connected — start the app on your glasses to enable photo requests.
        </div>
      )}

      {/* Actions */}
      <div className="flex flex-wrap gap-2 mb-4">
        <button
          onClick={() => takePhoto()}
          disabled={!canAct}
          className="px-3 py-2 rounded-lg text-sm font-medium bg-green-600 hover:bg-green-700 text-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
          {isTaking ? "⏳ Requesting…" : "📸 Take Photo"}
        </button>
        <button
          onClick={() => takePhoto({size: "small", compress: "heavy"})}
          disabled={!canAct}
          className="px-3 py-2 rounded-lg text-sm bg-neutral-800 hover:bg-neutral-700 border border-neutral-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
          📷 Small + Compressed
        </button>
        <button
          onClick={rapidFire}
          disabled={!canAct || isRapidFiring}
          className="px-3 py-2 rounded-lg text-sm bg-neutral-800 hover:bg-neutral-700 border border-neutral-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
          {isRapidFiring ? "⏳ Firing…" : "⚡ Rapid Fire (3x)"}
        </button>
        <button
          onClick={clearResults}
          className="px-3 py-2 rounded-lg text-sm bg-red-900/50 hover:bg-red-800/60 border border-red-800/50 text-red-300 transition-colors ml-auto">
          🗑 Clear
        </button>
      </div>

      {/* Summary */}
      <div className="grid grid-cols-4 gap-2 mb-4">
        <SummaryCard label="Total" value={counts.total} color="text-blue-400" />
        <SummaryCard label="Success" value={counts.success} color="text-green-400" />
        <SummaryCard label="Specific Error" value={counts.error} color="text-amber-400" />
        <SummaryCard label="Timeout ❌" value={counts.timeout} color="text-red-400" />
      </div>

      {/* Results */}
      <h3 className="text-sm font-medium text-neutral-400 mb-2">Results</h3>
      {sortedResults.length === 0 ? (
        <p className="text-center text-neutral-600 italic py-8 text-sm">No results yet — take a photo</p>
      ) : (
        <div className="space-y-2">
          {sortedResults.map((r) => (
            <ResultCard key={r.requestId} result={r} />
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Components ──────────────────────────────────────────────────────────────

function StatusDot({ok, label}: {ok: boolean; label: string}) {
  return (
    <div className="flex items-center gap-1.5">
      <div className={`w-2 h-2 rounded-full ${ok ? "bg-green-500" : "bg-neutral-600"}`} />
      <span className={ok ? "text-neutral-300" : "text-neutral-600"}>{label}</span>
    </div>
  )
}

function SummaryCard({label, value, color}: {label: string; value: number; color: string}) {
  return (
    <div className="p-3 rounded-lg bg-neutral-900 border border-neutral-800 text-center">
      <div className={`text-2xl font-bold ${color}`}>{value}</div>
      <div className="text-[10px] text-neutral-500 uppercase tracking-wide mt-0.5">{label}</div>
    </div>
  )
}

function ResultCard({result: r}: {result: PhotoTestResult}) {
  const borderColor = {
    success: "border-l-green-500",
    error: "border-l-amber-500",
    timeout: "border-l-red-500",
    pending: "border-l-blue-500",
  }[r.status]

  const statusColor = {
    success: "text-green-400",
    error: "text-amber-400",
    timeout: "text-red-400",
    pending: "text-blue-400",
  }[r.status]

  const timing = r.durationMs != null ? `${(r.durationMs / 1000).toFixed(2)}s` : "…"
  const timeStr = new Date(r.startedAt).toLocaleTimeString()

  return (
    <div
      className={`p-3 rounded-lg bg-neutral-900 border border-neutral-800 border-l-[3px] ${borderColor} text-xs ${
        r.status === "pending" ? "animate-pulse" : ""
      }`}>
      {/* Status + timing row */}
      <div className="flex justify-between items-center">
        <span className={`font-bold uppercase tracking-wider text-[11px] ${statusColor}`}>{r.status}</span>
        <span className="text-neutral-500 tabular-nums">{timing}</span>
      </div>

      {/* Error message */}
      {r.errorMessage && <div className="text-amber-300 mt-1.5 break-all">{r.errorMessage}</div>}

      {/* Verdict */}
      {r.status === "error" && !r.wasGenericTimeout && (
        <div className="mt-1.5 inline-block px-2 py-0.5 rounded bg-green-950 text-green-400 text-[11px]">
          ✅ PASS — Got specific error message
        </div>
      )}
      {(r.status === "timeout" || r.wasGenericTimeout) && (
        <div className="mt-1.5 inline-block px-2 py-0.5 rounded bg-red-950 text-red-400 text-[11px]">
          ❌ FAIL — Generic timeout (OS-947 not fixed)
        </div>
      )}
      {r.status === "success" && (
        <div className="mt-1.5 inline-block px-2 py-0.5 rounded bg-green-950 text-green-400 text-[11px]">
          ✅ Photo captured
          {r.photoSize ? ` (${(r.photoSize / 1024).toFixed(1)} KB)` : ""}
        </div>
      )}

      {/* Meta */}
      <div className="text-neutral-600 mt-1">
        {timeStr} · {r.requestId}
      </div>
    </div>
  )
}
