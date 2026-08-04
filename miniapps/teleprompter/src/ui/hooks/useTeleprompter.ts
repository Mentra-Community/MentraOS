import {useCallback, useEffect, useRef, useState} from "react"

import type {LineWidth, PlaybackStatus, TeleprompterSettings, TeleprompterSnapshot} from "../../shared/types"

export type {LineWidth, PlaybackStatus, TeleprompterSettings} from "../../shared/types"

/**
 * useTeleprompter — single hook over the background channel bus.
 *
 * Holds the mirrored settings + live playback status, and exposes typed
 * actions that broadcast commands to the background controller (the source of
 * truth). Settings writes update local state optimistically; the background
 * echoes a `tp:settings-update` for confirmation.
 *
 * Channels consumed:
 *   tp:snapshot         -> seed settings + status on WebView open
 *   tp:status           -> live playback status (state, position, preview)
 *   tp:settings-update  -> settings echo after a persisted change
 */
export function useTeleprompter() {
  const [settings, setSettings] = useState<TeleprompterSettings | null>(null)
  const [status, setStatus] = useState<PlaybackStatus | null>(null)
  const [connected, setConnected] = useState(false)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    const offs: Array<() => void> = []
    const on = mentra.on as (c: string, cb: (p: unknown) => void) => () => void

    offs.push(
      on("tp:snapshot", (payload) => {
        if (!mountedRef.current) return
        const snap = payload as TeleprompterSnapshot
        setSettings(snap.settings)
        setStatus(snap.status)
        setConnected(true)
      }),
    )

    offs.push(
      on("tp:status", (payload) => {
        if (!mountedRef.current) return
        setStatus(payload as PlaybackStatus)
        setConnected(true)
      }),
    )

    offs.push(
      on("tp:settings-update", (payload) => {
        if (!mountedRef.current) return
        setSettings(payload as TeleprompterSettings)
      }),
    )

    mentra.send("tp:request-snapshot", {})

    return () => {
      mountedRef.current = false
      for (const off of offs) off()
    }
  }, [])

  // ── Settings writes (optimistic) ─────────────────────────────────────────
  const patchSettings = useCallback((patch: Partial<TeleprompterSettings>) => {
    setSettings((prev) => (prev ? {...prev, ...patch} : prev))
  }, [])

  const setScript = useCallback(
    (script: string) => {
      patchSettings({script})
      mentra.send("tp:set-script", {script})
    },
    [patchSettings],
  )
  const setWpm = useCallback(
    (wpm: number) => {
      patchSettings({wpm})
      mentra.send("tp:set-wpm", {wpm})
    },
    [patchSettings],
  )
  const setLines = useCallback(
    (lines: number) => {
      patchSettings({numberOfLines: lines})
      mentra.send("tp:set-lines", {lines})
    },
    [patchSettings],
  )
  const setWidth = useCallback(
    (width: LineWidth) => {
      patchSettings({lineWidth: width})
      mentra.send("tp:set-width", {width})
    },
    [patchSettings],
  )
  const setVoiceFollow = useCallback(
    (enabled: boolean) => {
      patchSettings({voiceFollow: enabled})
      mentra.send("tp:set-voice-follow", {enabled})
    },
    [patchSettings],
  )
  const setAutoRestart = useCallback(
    (enabled: boolean) => {
      patchSettings({autoRestart: enabled})
      mentra.send("tp:set-auto-restart", {enabled})
    },
    [patchSettings],
  )
  const setShowTimecode = useCallback(
    (enabled: boolean) => {
      patchSettings({showTimecode: enabled})
      mentra.send("tp:set-show-timecode", {enabled})
    },
    [patchSettings],
  )

  // ── Transport ──────────────────────────────────────────────────────────
  const play = useCallback(() => mentra.send("tp:play", {}), [])
  const pause = useCallback(() => mentra.send("tp:pause", {}), [])
  const restart = useCallback(() => mentra.send("tp:restart", {}), [])
  const seek = useCallback((percent: number) => mentra.send("tp:seek", {percent}), [])
  const nudge = useCallback((lines: number) => mentra.send("tp:nudge", {lines}), [])

  return {
    settings,
    status,
    connected,
    setScript,
    setWpm,
    setLines,
    setWidth,
    setVoiceFollow,
    setAutoRestart,
    setShowTimecode,
    play,
    pause,
    restart,
    seek,
    nudge,
  }
}
