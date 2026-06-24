import {useCallback, useEffect, useRef, useState} from "react"

import type {RecorderStatus, RecordingItem, Usage} from "../../shared/types"

const EMPTY_USAGE: Usage = {bytes: 0, count: 0, quotaBytes: 0}

/**
 * useRecorder — single hook over the background channel bus.
 *
 * The background controller owns all recorder logic; this hook mirrors its
 * state and exposes typed commands. Channels consumed:
 *   rec:snapshot  -> seed everything on WebView open
 *   rec:status    -> live capture status (while recording)
 *   rec:stopped   -> capture ended
 *   rec:list      -> recordings + usage after save/delete/clear
 *   rec:playback  -> which recording is playing
 */
export function useRecorder() {
  const [status, setStatus] = useState<RecorderStatus | null>(null)
  const [recordings, setRecordings] = useState<RecordingItem[]>([])
  const [usage, setUsage] = useState<Usage>(EMPTY_USAGE)
  const [playingId, setPlayingId] = useState<string | null>(null)
  const [hasMic, setHasMic] = useState(true)
  const [ready, setReady] = useState(false)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    const offs: Array<() => void> = []
    const on = mentra.on as (c: string, cb: (p: unknown) => void) => () => void

    offs.push(
      on("rec:snapshot", (p) => {
        if (!mounted.current) return
        const s = p as {
          recording: RecorderStatus | null
          recordings: RecordingItem[]
          usage: Usage
          playingId: string | null
          hasMic: boolean
        }
        setStatus(s.recording)
        setRecordings(s.recordings)
        setUsage(s.usage)
        setPlayingId(s.playingId)
        setHasMic(s.hasMic)
        setReady(true)
      }),
    )
    offs.push(
      on("rec:status", (p) => {
        if (mounted.current) setStatus(p as RecorderStatus)
      }),
    )
    offs.push(
      on("rec:stopped", () => {
        if (mounted.current) setStatus(null)
      }),
    )
    offs.push(
      on("rec:list", (p) => {
        if (!mounted.current) return
        const s = p as {recordings: RecordingItem[]; usage: Usage}
        setRecordings(s.recordings)
        setUsage(s.usage)
      }),
    )
    offs.push(
      on("rec:playback", (p) => {
        if (mounted.current) setPlayingId((p as {playingId: string | null}).playingId)
      }),
    )

    mentra.send("rec:request-snapshot", {})
    return () => {
      mounted.current = false
      for (const off of offs) off()
    }
  }, [])

  const startRecording = useCallback(() => mentra.send("rec:start", {}), [])
  const stopRecording = useCallback(() => mentra.send("rec:stop", {}), [])
  const cancelRecording = useCallback(() => mentra.send("rec:cancel", {}), [])
  const play = useCallback((id: string) => mentra.send("rec:play", {id}), [])
  const stopPlay = useCallback(() => mentra.send("rec:stop-play", {}), [])
  const exportRecording = useCallback((id: string) => mentra.send("rec:export", {id}), [])
  const remove = useCallback((id: string) => mentra.send("rec:delete", {id}), [])
  const clearAll = useCallback(() => mentra.send("rec:clear", {}), [])

  return {
    status,
    recordings,
    usage,
    playingId,
    hasMic,
    ready,
    isRecording: status !== null,
    startRecording,
    stopRecording,
    cancelRecording,
    play,
    stopPlay,
    exportRecording,
    remove,
    clearAll,
  }
}
