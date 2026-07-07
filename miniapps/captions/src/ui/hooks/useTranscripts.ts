import {useEffect, useRef, useState} from "react"

import type {CloudClientStatus, DisplayPreview, LiveTranscript, Transcript} from "../../shared/types"

export type {CloudClientStatus, Transcript, DisplayPreview} from "../../shared/types"

const TRANSCRIPT_TIMING_TELEMETRY = (globalThis as {__DEV__?: boolean}).__DEV__ === true

/**
 * useTranscripts — thin hook over the background channel bus.
 *
 * Replaces the cloud app's EventSource/SSE hook (reconnect, heartbeat, backoff,
 * auth-token plumbing). In the local miniapp the background JSContext is always
 * up and pushes over session.ui.send, so there is no transport to reconnect to —
 * "connected" tracks whether we have received our hydration snapshot yet.
 *
 * Channels consumed:
 *   captions:snapshot           -> seed transcript list + display preview
 *   captions:live-transcript    -> one interim/final frame
 *   captions:transcripts-update -> full list replacement (e.g. after clear)
 *   captions:display-preview    -> glasses preview
 *   captions:request-snapshot   -> sent after listeners attach to avoid onOpen races
 */
export function useTranscripts() {
  const [transcripts, setTranscripts] = useState<Transcript[]>([])
  const [connected, setConnected] = useState(false)
  const [displayPreview, setDisplayPreview] = useState<DisplayPreview | null>(null)
  const [cloudStatus, setCloudStatus] = useState<CloudClientStatus>({
    status: "disconnected",
    audioTransport: "none",
  })
  const [isRecording, setIsRecording] = useState(false)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    const offs: Array<() => void> = []
    const on = mentra.on as (c: string, cb: (p: unknown) => void) => () => void

    offs.push(
      on("captions:snapshot", (payload) => {
        const snap = payload as {
          transcripts: Transcript[]
          displayPreview: DisplayPreview | null
          cloudStatus?: CloudClientStatus
        }
        if (!mountedRef.current) return
        setTranscripts(snap.transcripts || [])
        setDisplayPreview(snap.displayPreview ?? null)
        if (snap.cloudStatus) setCloudStatus(snap.cloudStatus)
        setConnected(true)
      }),
    )

    offs.push(
      on("captions:transcripts-update", (payload) => {
        if (!mountedRef.current) return
        setTranscripts((payload as {transcripts: Transcript[]}).transcripts || [])
      }),
    )

    offs.push(
      on("captions:display-preview", (payload) => {
        if (!mountedRef.current) return
        setDisplayPreview(payload as DisplayPreview)
      }),
    )

    offs.push(
      on("captions:cloud-status", (payload) => {
        if (!mountedRef.current) return
        setCloudStatus(payload as CloudClientStatus)
      }),
    )

    offs.push(
      on("captions:live-transcript", (payload) => {
        if (!mountedRef.current) return
        const data = payload as LiveTranscript
        if (TRANSCRIPT_TIMING_TELEMETRY) {
          console.log(
            `LocalCaptionsUI: transcript recv t=${Date.now()} type=${data.type} text="${data.text.slice(0, 48)}"`,
          )
        }
        setConnected(true)
        applyLiveTranscript(setTranscripts, data)
      }),
    )

    mentra.send("captions:request-snapshot", {})

    return () => {
      mountedRef.current = false
      for (const off of offs) off()
    }
  }, [])

  const toggleRecording = () => setIsRecording((prev) => !prev)

  const clearTranscripts = () => {
    setTranscripts([])
    mentra.send("captions:clear", {})
  }

  // No transport to reconnect in the local runtime — kept for prop parity.
  const reconnect = () => {}

  return {
    transcripts,
    connected,
    error: null as string | null,
    isRecording,
    toggleRecording,
    clearTranscripts,
    reconnect,
    displayPreview,
    cloudStatus,
  }
}

/**
 * Apply one live-transcript frame to the list. Mirrors the cloud SSE hook's
 * correlation logic: utteranceId-based update when present, else legacy
 * interim/final replacement keyed by speaker.
 */
function applyLiveTranscript(
  setTranscripts: React.Dispatch<React.SetStateAction<Transcript[]>>,
  data: LiveTranscript,
): void {
  if (data.utteranceId) {
    setTranscripts((prev) => {
      const existingIndex = prev.findIndex((t) => t.utteranceId === data.utteranceId)
      const next: Transcript = {
        id: data.id,
        utteranceId: data.utteranceId,
        speaker: data.speaker,
        text: data.text,
        timestamp: data.timestamp,
        isFinal: data.type === "final",
      }
      if (existingIndex >= 0) {
        const updated = [...prev]
        updated[existingIndex] = next
        return updated
      }
      return [...prev, next]
    })
    return
  }

  // Legacy: no utteranceId.
  if (data.type === "interim") {
    setTranscripts((prev) => {
      const filtered = prev.filter((t) => !(t.speaker === data.speaker && !t.isFinal))
      return [
        ...filtered,
        {
          id: data.id,
          utteranceId: null,
          speaker: data.speaker,
          text: data.text,
          timestamp: null,
          isFinal: false,
        },
      ]
    })
  } else {
    setTranscripts((prev) => {
      const alreadyExists = prev.some((t) => t.isFinal && t.id === data.id)
      if (alreadyExists) return prev
      const filtered = prev.filter((t) => !(t.speaker === data.speaker && !t.isFinal))
      return [
        ...filtered,
        {
          id: data.id,
          utteranceId: null,
          speaker: data.speaker,
          text: data.text,
          timestamp: data.timestamp,
          isFinal: true,
        },
      ]
    })
  }
}
