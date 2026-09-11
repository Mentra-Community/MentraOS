import {useEffect, useRef, useState} from "react"

import type {CloudClientStatus, DisplayPreview, LiveTranslation, TranslationEntry} from "../../shared/types"

export type {CloudClientStatus, TranslationEntry, DisplayPreview} from "../../shared/types"

export function useTranslations() {
  const [translations, setTranslations] = useState<TranslationEntry[]>([])
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
      on("translation:snapshot", (payload) => {
        const snap = payload as {
          translations: TranslationEntry[]
          displayPreview: DisplayPreview | null
          cloudStatus?: CloudClientStatus
        }
        if (!mountedRef.current) return
        setTranslations(snap.translations || [])
        setDisplayPreview(snap.displayPreview ?? null)
        if (snap.cloudStatus) setCloudStatus(snap.cloudStatus)
        setConnected(true)
      }),
    )

    offs.push(
      on("translation:translations-update", (payload) => {
        if (!mountedRef.current) return
        setTranslations((payload as {translations: TranslationEntry[]}).translations || [])
      }),
    )

    offs.push(
      on("translation:display-preview", (payload) => {
        if (!mountedRef.current) return
        setDisplayPreview(payload as DisplayPreview)
      }),
    )

    offs.push(
      on("translation:cloud-status", (payload) => {
        if (!mountedRef.current) return
        setCloudStatus(payload as CloudClientStatus)
      }),
    )

    offs.push(
      on("translation:live-translation", (payload) => {
        if (!mountedRef.current) return
        const data = payload as LiveTranslation
        setConnected(true)
        applyLiveTranslation(setTranslations, data)
      }),
    )

    mentra.send("translation:request-snapshot", {})

    return () => {
      mountedRef.current = false
      for (const off of offs) off()
    }
  }, [])

  const toggleRecording = () => setIsRecording((prev) => !prev)

  const clearTranslations = () => {
    setTranslations([])
    mentra.send("translation:clear", {})
  }

  const reconnect = () => {}

  return {
    translations,
    connected,
    error: null as string | null,
    isRecording,
    toggleRecording,
    clearTranslations,
    reconnect,
    displayPreview,
    cloudStatus,
  }
}

function applyLiveTranslation(
  setTranslations: React.Dispatch<React.SetStateAction<TranslationEntry[]>>,
  data: LiveTranslation,
): void {
  if (data.utteranceId) {
    setTranslations((prev) => {
      const existingIndex = prev.findIndex((t) => t.utteranceId === data.utteranceId)
      const next = toEntry(data)
      if (existingIndex >= 0) {
        const updated = [...prev]
        updated[existingIndex] = next
        return updated
      }
      return [...prev, next]
    })
    return
  }

  if (data.type === "interim") {
    setTranslations((prev) => {
      const filtered = prev.filter((t) => !(t.speaker === data.speaker && !t.isFinal))
      return [...filtered, toEntry(data)]
    })
  } else {
    setTranslations((prev) => {
      const alreadyExists = prev.some((t) => t.isFinal && t.id === data.id)
      if (alreadyExists) return prev
      const filtered = prev.filter((t) => !(t.speaker === data.speaker && !t.isFinal))
      return [...filtered, toEntry(data)]
    })
  }
}

function toEntry(data: LiveTranslation): TranslationEntry {
  return {
    id: data.id,
    utteranceId: data.utteranceId,
    speaker: data.speaker,
    text: data.text,
    originalText: data.originalText,
    sourceLanguage: data.sourceLanguage,
    targetLanguage: data.targetLanguage,
    timestamp: data.timestamp,
    isFinal: data.type === "final",
  }
}
