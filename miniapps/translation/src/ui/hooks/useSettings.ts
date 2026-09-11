import {useEffect, useRef, useState} from "react"

import type {TranslationSettings} from "../../shared/types"

export type {TranslationSettings} from "../../shared/types"

/**
 * useSettings — thin hook over the background channel bus.
 *
 * Replaces the cloud app's REST fetch/POST hook. Reads come from the
 * `translation:snapshot` (initial) and `translation:settings-update` (on change)
 * channels; writes go out as `translation:set-*` broadcasts. Each updater
 * optimistically updates local state and resolves true (the background is the
 * source of truth and echoes a settings-update for confirmation).
 */
export function useSettings() {
  const [settings, setSettings] = useState<TranslationSettings | null>(null)
  const [loading, setLoading] = useState(true)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    const offs: Array<() => void> = []
    const on = mentra.on as (c: string, cb: (p: unknown) => void) => () => void

    offs.push(
      on("translation:snapshot", (payload) => {
        if (!mountedRef.current) return
        setSettings((payload as {settings: TranslationSettings}).settings)
        setLoading(false)
      }),
    )

    offs.push(
      on("translation:settings-update", (payload) => {
        if (!mountedRef.current) return
        setSettings(payload as TranslationSettings)
        setLoading(false)
      }),
    )

    return () => {
      mountedRef.current = false
      for (const off of offs) off()
    }
  }, [])

  const updateTargetLanguage = async (targetLanguage: string): Promise<boolean> => {
    setSettings((prev) => (prev ? {...prev, targetLanguage} : prev))
    mentra.send("translation:set-target-language", {targetLanguage})
    return true
  }

  const updateDisplayLines = async (lines: number): Promise<boolean> => {
    setSettings((prev) => (prev ? {...prev, displayLines: lines} : prev))
    mentra.send("translation:set-display-lines", {lines})
    return true
  }

  const updateDisplayWidth = async (width: number): Promise<boolean> => {
    setSettings((prev) => (prev ? {...prev, displayWidth: width} : prev))
    mentra.send("translation:set-display-width", {width})
    return true
  }

  const updateWordBreaking = async (enabled: boolean): Promise<boolean> => {
    setSettings((prev) => (prev ? {...prev, wordBreaking: enabled} : prev))
    mentra.send("translation:set-word-breaking", {enabled})
    return true
  }

  const updateShowOriginalText = async (enabled: boolean): Promise<boolean> => {
    setSettings((prev) => (prev ? {...prev, showOriginalText: enabled} : prev))
    mentra.send("translation:set-show-original-text", {enabled})
    return true
  }

  const updateGlassesDisplayMode = async (mode: "translation" | "both"): Promise<boolean> => {
    setSettings((prev) => (prev ? {...prev, glassesDisplayMode: mode} : prev))
    mentra.send("translation:set-glasses-display-mode", {mode})
    return true
  }

  return {
    settings,
    loading,
    error: null as string | null,
    updateTargetLanguage,
    updateDisplayLines,
    updateDisplayWidth,
    updateWordBreaking,
    updateShowOriginalText,
    updateGlassesDisplayMode,
  }
}
