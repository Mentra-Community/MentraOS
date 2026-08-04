import {useCallback, useEffect, useRef, useState} from "react"

import type {RecorderStatus, RecordingItem, Usage} from "../../shared/types"

const EMPTY_USAGE: Usage = {bytes: 0, count: 0, quotaBytes: 0}
/** Number of bars held in the live waveform's rolling window. */
const WAVE_BARS = 56

/**
 * useRecorder — single hook over the background channel bus.
 *
 * The background controller owns all recorder logic; this hook mirrors its
 * state and exposes typed commands. Channels consumed:
 *   rec:snapshot      -> seed everything on WebView open
 *   rec:status        -> live capture status (while recording)
 *   rec:stopped       -> capture ended
 *   rec:transcript    -> live Soniox transcript during a capture
 *   rec:list          -> recordings + usage after save/delete/clear
 *   rec:playback      -> which recording is playing
 *   rec:audio-missing -> a recording's stored audio is unreadable
 *
 * Playback runs natively in the background via `session.speaker.play` (the file
 * never crosses the bridge). The progress scrubber is driven UI-side off a
 * lightweight timer that runs while a recording is the active playback.
 */
export function useRecorder() {
  const [status, setStatus] = useState<RecorderStatus | null>(null)
  const [stopping, setStopping] = useState(false)
  const [recordings, setRecordings] = useState<RecordingItem[]>([])
  const [usage, setUsage] = useState<Usage>(EMPTY_USAGE)
  const [playingId, setPlayingId] = useState<string | null>(null)
  const [hasMic, setHasMic] = useState(true)
  const [ready, setReady] = useState(false)
  const [levels, setLevels] = useState<number[]>([])
  const [transcript, setTranscript] = useState("")
  const [transcriptLang, setTranscriptLang] = useState("")
  const [playPosMs, setPlayPosMs] = useState(0)
  const [unavailableId, setUnavailableId] = useState<string | null>(null)
  const mounted = useRef(true)
  const unavailableTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Tracks the capture a status belongs to, so we only clear the live transcript
  // + waveform when a genuinely new capture starts — not on a same-capture
  // status (e.g. an early pause that reports ms === 0 before any PCM buffered).
  const lastRecId = useRef<string | null>(null)

  useEffect(() => {
    mounted.current = true
    const offs: Array<() => void> = []
    const on = mentra.on as (c: string, cb: (p: unknown) => void) => () => void

    offs.push(
      on("rec:snapshot", (p) => {
        if (!mounted.current) return
        const s = p as {
          recording: RecorderStatus | null
          stopping?: boolean
          recordings: RecordingItem[]
          usage: Usage
          playingId: string | null
          hasMic: boolean
          transcript?: string
          transcriptLang?: string
        }
        setStatus(s.recording)
        setStopping(s.stopping ?? false)
        setRecordings(s.recordings)
        setUsage(s.usage)
        setPlayingId(s.playingId)
        setHasMic(s.hasMic)
        // Restore an in-progress capture's transcript on WebView reopen.
        lastRecId.current = s.recording?.recordingId ?? null
        if (s.recording) {
          setTranscript(s.transcript ?? "")
          setTranscriptLang(s.transcriptLang ?? "")
        }
        setReady(true)
      }),
    )
    offs.push(
      on("rec:status", (p) => {
        if (!mounted.current) return
        const st = p as RecorderStatus
        setStatus(st)
        // A new recordingId means a fresh capture — clear carryover. Keyed off
        // the id (not ms === 0) so a same-capture status can't wipe live state.
        if (st.recordingId !== lastRecId.current) {
          setStopping(false)
          lastRecId.current = st.recordingId
          setTranscript("")
          setTranscriptLang("")
          setLevels([])
        }
        // Feed a rolling waveform; frozen while paused.
        if (!st.paused) {
          setLevels((prev) => {
            const next = [...prev, st.level]
            return next.length > WAVE_BARS ? next.slice(next.length - WAVE_BARS) : next
          })
        }
      }),
    )
    offs.push(
      on("rec:stopping", () => {
        if (mounted.current) setStopping(true)
      }),
    )
    offs.push(
      on("rec:stopped", () => {
        if (!mounted.current) return
        setStopping(false)
        lastRecId.current = null
        setStatus(null)
        setLevels([])
        setTranscript("")
        setTranscriptLang("")
      }),
    )
    offs.push(
      on("rec:transcript", (p) => {
        if (!mounted.current) return
        const {final, interim, lang} = p as {final: string; interim: string; lang?: string}
        setTranscript([final, interim].filter(Boolean).join(" "))
        if (lang) setTranscriptLang(lang)
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
    offs.push(
      on("rec:audio-missing", (p) => {
        if (!mounted.current) return
        const {id} = p as {id: string}
        setUnavailableId(id)
        if (unavailableTimer.current) clearTimeout(unavailableTimer.current)
        unavailableTimer.current = setTimeout(() => {
          if (mounted.current) setUnavailableId(null)
        }, 2600)
      }),
    )

    mentra.send("rec:request-snapshot", {})
    return () => {
      mounted.current = false
      if (unavailableTimer.current) clearTimeout(unavailableTimer.current)
      for (const off of offs) off()
    }
  }, [])

  // Drive the playback scrubber off a local clock while a row is playing. The
  // background plays the file natively (no position events come back over the
  // bridge), so we approximate elapsed time from when playback began; the row
  // caps it at the recording's duration. Resets whenever playback changes.
  useEffect(() => {
    if (!playingId) {
      setPlayPosMs(0)
      return
    }
    const startedAt = performance.now()
    setPlayPosMs(0)
    const id = setInterval(() => {
      if (mounted.current) setPlayPosMs(performance.now() - startedAt)
    }, 100)
    return () => clearInterval(id)
  }, [playingId])

  const startRecording = useCallback(() => mentra.send("rec:start", {}), [])
  const stopRecording = useCallback(() => {
    // Give the tap immediate visual feedback; the background echoes
    // rec:stopping for snapshots and other control surfaces.
    setStopping(true)
    mentra.send("rec:stop", {})
  }, [])
  const cancelRecording = useCallback(() => mentra.send("rec:cancel", {}), [])
  const pauseRecording = useCallback(() => mentra.send("rec:pause", {}), [])
  const resumeRecording = useCallback(() => mentra.send("rec:resume", {}), [])
  const play = useCallback((id: string) => mentra.send("rec:play", {id}), [])
  const stopPlay = useCallback(() => mentra.send("rec:stop-play", {}), [])
  const exportRecording = useCallback((id: string) => mentra.send("rec:export", {id}), [])
  const exportTranscript = useCallback((id: string) => mentra.send("rec:export-transcript", {id}), [])
  const remove = useCallback((id: string) => mentra.send("rec:delete", {id}), [])
  const clearAll = useCallback(() => mentra.send("rec:clear", {}), [])

  return {
    status,
    levels,
    transcript,
    transcriptLang,
    recordings,
    usage,
    playingId,
    playPosMs,
    unavailableId,
    hasMic,
    ready,
    isRecording: status !== null,
    paused: status?.paused ?? false,
    stopping,
    startRecording,
    stopRecording,
    cancelRecording,
    pauseRecording,
    resumeRecording,
    play,
    stopPlay,
    exportRecording,
    exportTranscript,
    remove,
    clearAll,
  }
}
