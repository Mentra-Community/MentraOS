// Tester page — diagnostic surface, ephemeral by design.
// This is the ONLY place in the example where inline-subscribing to
// `session.*` (or imperative one-shot calls in response to user input)
// is acceptable. User-facing glasses logic must live in
// src/controller/GlassesController.ts.

import {useEffect, useRef, useState} from "react"
import {useNavigate} from "react-router-dom"
import {MiniappHeader, useSession} from "@mentra/miniapp/react"

import {Button} from "../../ui/button"
import {Shell} from "../Shell"
import {Row, TableRow} from "./_TesterRow"

export default function MicrophonePage() {
  const session = useSession()
  const navigate = useNavigate()

  const [vad, setVad] = useState<boolean>(false)
  const [chunkCount, setChunkCount] = useState(0)
  const [lastChunk, setLastChunk] = useState<Record<string, unknown> | null>(null)
  const chunkUnsubRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    const unsub = session.mic.onVoiceActivity((d) => setVad(!!d.status))
    return () => unsub()
  }, [session])

  const startChunks = () => {
    if (chunkUnsubRef.current) return
    chunkUnsubRef.current = session.mic.onAudioChunk((d) => {
      setChunkCount((n) => n + 1)
      setLastChunk({
        sampleRate: d.sampleRate ?? "—",
        format: d.format ?? "—",
        bytes: d.data?.length ?? 0,
        receivedAt: new Date().toLocaleTimeString(),
      })
    })
  }

  const stopChunks = () => {
    chunkUnsubRef.current?.()
    chunkUnsubRef.current = null
  }

  const stopAll = () => {
    session.mic.stop()
    chunkUnsubRef.current = null
    setChunkCount(0)
    setLastChunk(null)
  }

  return (
    <Shell>
      <MiniappHeader title="session.mic" onBack={() => navigate("/tester")} />

      <div className="flex-1 overflow-y-auto px-4 pb-6">
        <p className="mb-3 text-[13px] text-muted-foreground">
          Low-level audio + VAD. Requires <code className="font-mono">MICROPHONE</code> in miniapp.json.
        </p>

        <Row emoji="🗣️" label="onVoiceActivity" value={vad ? "speaking" : "silent"} />

        <div className="mb-2 rounded-xl border border-border bg-card p-3">
          <div className="mb-2 flex items-center gap-2 text-[12px] font-semibold uppercase tracking-wider text-muted-foreground">
            <span className="text-base">🎙️</span>
            <span>onAudioChunk</span>
          </div>
          <div className="mb-2 flex flex-wrap gap-2">
            <Button onClick={startChunks}>Start</Button>
            <Button variant="destructive" onClick={stopChunks}>Stop</Button>
          </div>
          <div className="text-sm">Chunks received: <span className="font-mono">{chunkCount}</span></div>
        </div>

        <TableRow emoji="📦" label="Last chunk metadata" data={lastChunk} />

        <div className="mt-3 rounded-xl border border-border bg-card p-3">
          <div className="mb-2 flex items-center gap-2 text-[12px] font-semibold uppercase tracking-wider text-muted-foreground">
            <span className="text-base">🛑</span>
            <span>stop()</span>
          </div>
          <p className="mb-2 text-[12px] text-muted-foreground">Tears down every mic subscription this module owns.</p>
          <Button variant="destructive" onClick={stopAll}>session.mic.stop()</Button>
        </div>
      </div>
    </Shell>
  )
}
