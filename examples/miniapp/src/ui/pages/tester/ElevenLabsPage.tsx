// Tester page — ElevenLabs ConvAI mic → WebSocket (port of RN audio repro).

import {useEffect, useState} from "react"
import {useNavigate} from "react-router-dom"
import {MiniappHeader, useRpc} from "@mentra/miniapp/ui"

import "../../../shared/channels"
import type {Channels} from "../../../shared/channels"
import type {ElevenLabsDiagnostics, ElevenLabsSnapshot} from "../../../shared/types"
import {useChannel} from "../../hooks/useChannel"
import {Shell} from "../Shell"
import {Button} from "../../components/button"
import {ErrorRow, Row} from "./_TesterRow"

function formatDuration(ms: number | null): string {
  if (ms === null) return "?"
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function formatSignedUrlStatus(diagnostics: ElevenLabsDiagnostics): string {
  if (diagnostics.signedUrlLatencyMs === null) return diagnostics.signedUrlStatus
  return `${diagnostics.signedUrlStatus} in ${formatDuration(diagnostics.signedUrlLatencyMs)}`
}

function formatTimestamp(timestampMs: number | null, nowMs: number): string {
  if (timestampMs === null) return "None"
  return `${formatDuration(Math.max(0, nowMs - timestampMs))} ago`
}

function formatLastPcm(diagnostics: ElevenLabsDiagnostics, nowMs: number): string {
  if (diagnostics.lastPcmAtMs === null) return "None"
  return `${formatTimestamp(diagnostics.lastPcmAtMs, nowMs)}, ${diagnostics.lastPcmSize ?? "?"} bytes`
}

function formatPcmWait(diagnostics: ElevenLabsDiagnostics, nowMs: number): string {
  if (diagnostics.firstPcmDelayMs !== null) {
    return `first frame after ${formatDuration(diagnostics.firstPcmDelayMs)}`
  }
  if (diagnostics.micRequestedAtMs !== null) {
    return `waiting ${formatDuration(Math.max(0, nowMs - diagnostics.micRequestedAtMs))}`
  }
  return "Not requested"
}

function formatWebSocketClose(diagnostics: ElevenLabsDiagnostics): string {
  if (diagnostics.websocketCloseCode === null) return "None"
  return `${diagnostics.websocketCloseSource}, code ${diagnostics.websocketCloseCode}, clean=${String(
    diagnostics.websocketCloseWasClean,
  )}, after ${formatDuration(diagnostics.websocketCloseAfterMs)}, reason ${
    diagnostics.websocketCloseReason || "empty"
  }`
}

function formatRecordingDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

export default function ElevenLabsPage() {
  const navigate = useNavigate()
  const snapshot = useChannel("elevenlabs:update") as ElevenLabsSnapshot | undefined
  const startRpc = useRpc<Channels, "elevenlabs:start">("elevenlabs:start")
  const stopRpc = useRpc<Channels, "elevenlabs:stop">("elevenlabs:stop")
  const playRecordingRpc = useRpc<Channels, "elevenlabs:play-recording">("elevenlabs:play-recording")
  const stopPlaybackRpc = useRpc<Channels, "elevenlabs:stop-playback">("elevenlabs:stop-playback")
  const [busy, setBusy] = useState(false)
  const [playBusy, setPlayBusy] = useState(false)
  const [rpcError, setRpcError] = useState<string | null>(null)
  const [nowMs, setNowMs] = useState(Date.now())

  useEffect(() => {
    const interval = setInterval(() => setNowMs(Date.now()), 1000)
    return () => clearInterval(interval)
  }, [])

  const conversationState = snapshot?.conversationState ?? "Idle"
  const isActive = conversationState === "Signing" || conversationState === "Streaming"
  const diagnostics = snapshot?.diagnostics
  const stats = snapshot?.stats
  const recording = snapshot?.recording
  const canPlayRecording =
    !isActive && recording?.status === "ready" && !!recording.uri && !recording.isPlaying

  const onToggle = async () => {
    setRpcError(null)
    setBusy(true)
    try {
      if (isActive) {
        await stopRpc({})
      } else {
        await startRpc({})
      }
    } catch (err) {
      setRpcError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const onPlayRecording = async () => {
    setRpcError(null)
    setPlayBusy(true)
    try {
      if (recording?.isPlaying) {
        await stopPlaybackRpc({})
      } else {
        await playRecordingRpc({})
      }
    } catch (err) {
      setRpcError(err instanceof Error ? err.message : String(err))
    } finally {
      setPlayBusy(false)
    }
  }

  return (
    <Shell>
      <MiniappHeader title="ElevenLabs" onBack={() => navigate("/")} />
      <div className="flex-1 overflow-y-auto px-4 pb-6">
        <p className="mb-3 text-[13px] text-muted-foreground">
          ConvAI mic → WebSocket, agent PCM → glasses speaker. Mic PCM from
          <code className="mx-1">session.mic.onAudioChunk</code>
          is recorded for playback (same feed as Recorder). Glasses must already be connected via
          MentraOS. Run the local signing server first. Do not use the
          <code className="mx-1">session.mic</code>
          tester at the same time.
        </p>

        <Row emoji="🤖" label="Agent" value={snapshot?.agentId ?? "(loading)"} mono />
        <Row emoji="🔗" label="Signed URL endpoint" value={snapshot?.signedUrlEndpoint ?? "(loading)"} mono />
        <Row emoji="📡" label="WebSocket" value={conversationState} />
        <Row emoji="🎚️" label="Mic stage" value={diagnostics?.micStage ?? "—"} />
        <Row emoji="🎵" label="Audio metadata" value={snapshot?.metadata || "Waiting for PCM"} mono />
        <Row
          emoji="🎤"
          label="ElevenLabs VAD"
          value={snapshot?.vadScore === null || snapshot?.vadScore === undefined ? "None" : snapshot.vadScore.toFixed(3)}
        />

        <div className="mt-3 flex flex-wrap gap-2">
          <Button
            variant={isActive ? "destructive" : "default"}
            disabled={busy}
            onClick={() => void onToggle()}>
            {isActive ? "Stop" : "Start"}
          </Button>
          <Button
            variant="secondary"
            disabled={playBusy || (!canPlayRecording && !recording?.isPlaying)}
            onClick={() => void onPlayRecording()}>
            {recording?.isPlaying ? "Stop playback" : "Play recording"}
          </Button>
        </div>
        {conversationState === "Signing" ? (
          <p className="mt-2 text-[12px] text-muted-foreground">Fetching signed URL…</p>
        ) : null}

        {(rpcError || snapshot?.lastError) && (
          <div className="mt-3">
            <ErrorRow
              event={{
                iface: "elevenlabs",
                kind: "error",
                payload: {message: rpcError || snapshot?.lastError},
              }}
            />
          </div>
        )}

        <h3 className="mb-2 mt-5 text-[13px] font-semibold uppercase tracking-wider text-muted-foreground">
          Recording
        </h3>
        <p className="mb-2 text-[12px] text-muted-foreground">
          Captures glasses mic PCM from <code className="mx-1">session.mic.onAudioChunk</code>
          (post-LC3 decode — same feed as the Recorder miniapp) into one fixed phone path,
          overwritten on each Start.
        </p>
        {recording ? (
          <>
            <Row emoji="⏺️" label="Status" value={recording.status} />
            <Row emoji="🔑" label="Blob key" value={recording.blobKey} mono />
            <Row emoji="📁" label="Path" value={recording.uri ?? "—"} mono />
            <Row
              emoji="⏱️"
              label="Duration"
              value={
                recording.durationMs > 0 ? formatRecordingDuration(recording.durationMs) : "—"
              }
            />
            <Row emoji="📦" label="Size" value={recording.bytes > 0 ? `${recording.bytes} bytes` : "—"} />
            <Row
              emoji="🎚️"
              label="Sample rate"
              value={recording.sampleRate ? `${recording.sampleRate} Hz` : "—"}
            />
            {recording.error ? (
              <div className="mt-2">
                <ErrorRow
                  event={{
                    iface: "elevenlabs",
                    kind: "error",
                    payload: {message: recording.error},
                  }}
                />
              </div>
            ) : null}
          </>
        ) : (
          <p className="text-[13px] text-muted-foreground">Waiting for background snapshot…</p>
        )}

        <h3 className="mb-2 mt-5 text-[13px] font-semibold uppercase tracking-wider text-muted-foreground">
          Diagnostics
        </h3>
        {diagnostics ? (
          <>
            <Row emoji="🔏" label="Signed URL" value={formatSignedUrlStatus(diagnostics)} mono />
            <Row emoji="🎯" label="WS target" value={diagnostics.websocketTarget} mono />
            <Row emoji="📶" label="WS state" value={diagnostics.websocketState} />
            <Row emoji="🚪" label="WS close" value={formatWebSocketClose(diagnostics)} mono />
            <Row emoji="⏱️" label="PCM wait" value={formatPcmWait(diagnostics, nowMs)} />
            <Row emoji="1️⃣" label="First PCM" value={formatTimestamp(diagnostics.firstPcmAtMs, nowMs)} />
            <Row emoji="📦" label="Last PCM" value={formatLastPcm(diagnostics, nowMs)} mono />
            <Row
              emoji="📨"
              label="11Labs event"
              value={`${diagnostics.lastElevenLabsEvent} (${diagnostics.elevenLabsEventCount})`}
            />
            <Row emoji="⚠️" label="Send error" value={diagnostics.lastSendError ?? "None"} mono />
          </>
        ) : (
          <p className="text-[13px] text-muted-foreground">Waiting for background snapshot…</p>
        )}

        <h3 className="mb-2 mt-5 text-[13px] font-semibold uppercase tracking-wider text-muted-foreground">
          Counters
        </h3>
        {stats ? (
          <>
            <Row emoji="🔢" label="PCM frames" value={String(stats.frames)} />
            <Row emoji="⬇️" label="Received" value={`${stats.receivedBytes} bytes`} />
            <Row emoji="⬆️" label="Sent chunks" value={String(stats.sentChunks)} />
            <Row emoji="📤" label="Sent" value={`${stats.sentBytes} bytes`} />
            <Row emoji="🗑️" label="Dropped" value={String(stats.droppedChunks)} />
          </>
        ) : null}

        <h3 className="mb-2 mt-5 text-[13px] font-semibold uppercase tracking-wider text-muted-foreground">
          Transcript
        </h3>
        <p className="mb-3 text-sm">{snapshot?.lastTranscript || "No transcript yet"}</p>
        <h3 className="mb-2 text-[13px] font-semibold uppercase tracking-wider text-muted-foreground">Agent</h3>
        <p className="mb-3 text-sm">{snapshot?.lastAgentResponse || "No response yet"}</p>

        <h3 className="mb-2 mt-5 text-[13px] font-semibold uppercase tracking-wider text-muted-foreground">
          Log
        </h3>
        <div className="space-y-1 font-mono text-[11px] text-muted-foreground">
          {(snapshot?.logs ?? []).map((entry) => (
            <div key={entry.id} className="break-all">
              {entry.message}
            </div>
          ))}
          {!snapshot?.logs?.length ? <div>(empty)</div> : null}
        </div>
      </div>
    </Shell>
  )
}
