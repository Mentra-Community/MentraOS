import { useState, useEffect, useRef, useCallback } from "react"

export interface Transcript {
  id: string
  utteranceId: string | null
  speaker: string
  text: string
  timestamp: string | null
  isFinal: boolean
}

export interface DisplayPreview {
  text: string
  lines: string[]
  isFinal: boolean
  timestamp: number
}

// Reconnection configuration
const INITIAL_RETRY_DELAY_MS = 1000
const MAX_RETRY_DELAY_MS = 30000
const MAX_RECONNECT_ATTEMPTS = 20
const HEARTBEAT_TIMEOUT_MS = 45000 // Consider connection dead if no data for 45s
const HEARTBEAT_CHECK_INTERVAL_MS = 10000

export function useTranscripts() {
  const [transcripts, setTranscripts] = useState<Transcript[]>([])
  const [connected, setConnected] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [reconnectAttempt, setReconnectAttempt] = useState(0)
  const [reconnectSecondsRemaining, setReconnectSecondsRemaining] = useState<number | null>(null)
  const [displayPreview, setDisplayPreview] = useState<DisplayPreview | null>(null)

  // Refs for cleanup and state tracking
  const eventSourceRef = useRef<EventSource | null>(null)
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const countdownIntervalRef = useRef<NodeJS.Timeout | null>(null)
  const heartbeatCheckRef = useRef<NodeJS.Timeout | null>(null)
  const lastActivityRef = useRef<number>(Date.now())
  const isConnectingRef = useRef(false)
  const mountedRef = useRef(true)

  // Cleanup function
  const cleanup = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close()
      eventSourceRef.current = null
    }
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current)
      reconnectTimeoutRef.current = null
    }
    if (countdownIntervalRef.current) {
      clearInterval(countdownIntervalRef.current)
      countdownIntervalRef.current = null
    }
    if (heartbeatCheckRef.current) {
      clearInterval(heartbeatCheckRef.current)
      heartbeatCheckRef.current = null
    }
  }, [])

  // Calculate retry delay with exponential backoff
  const getRetryDelay = useCallback((attempt: number): number => {
    const delay = INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt)
    return Math.min(delay, MAX_RETRY_DELAY_MS)
  }, [])

  // Schedule a reconnection attempt
  const scheduleReconnect = useCallback((attempt: number) => {
    if (!mountedRef.current) return

    if (attempt >= MAX_RECONNECT_ATTEMPTS) {
      setError("Connection lost. Please refresh the page to reconnect.")
      setConnected(false)
      return
    }

    const delay = getRetryDelay(attempt)
    console.log(`[SSE] Scheduling reconnect attempt ${attempt + 1}/${MAX_RECONNECT_ATTEMPTS} in ${delay}ms`)

    const secondsRemaining = Math.round(delay / 1000)
    setReconnectSecondsRemaining(secondsRemaining)
    setError(`Connection lost. Reconnecting in ${secondsRemaining}s...`)
    setReconnectAttempt(attempt)

    // Clear any existing countdown interval
    if (countdownIntervalRef.current) {
      clearInterval(countdownIntervalRef.current)
    }

    // Update countdown every second
    const startTime = Date.now()
    countdownIntervalRef.current = setInterval(() => {
      const elapsed = Date.now() - startTime
      const remaining = Math.max(0, Math.round((delay - elapsed) / 1000))
      setReconnectSecondsRemaining(remaining)
      setError(`Connection lost. Reconnecting in ${remaining}s...`)

      if (remaining <= 0 && countdownIntervalRef.current) {
        clearInterval(countdownIntervalRef.current)
        countdownIntervalRef.current = null
      }
    }, 1000)

    reconnectTimeoutRef.current = setTimeout(() => {
      if (mountedRef.current) {
        // Clear countdown when actually reconnecting
        if (countdownIntervalRef.current) {
          clearInterval(countdownIntervalRef.current)
          countdownIntervalRef.current = null
        }
        setReconnectSecondsRemaining(null)
        connect(attempt + 1)
      }
    }, delay)
  }, [getRetryDelay])

  // Main connection function
  const connect = useCallback(async (attempt: number = 0) => {
    if (!mountedRef.current || isConnectingRef.current) return

    isConnectingRef.current = true
    cleanup()

    try {
      console.log(`[SSE] Connecting (attempt ${attempt + 1})...`)

      // First, try to load initial transcript history
      const response = await fetch("/api/transcripts")

      if (!mountedRef.current) {
        isConnectingRef.current = false
        return
      }

      if (response.status === 401) {
        console.log("[SSE] Not authenticated")
        setError("Not authenticated. Waiting for session...")
        isConnectingRef.current = false
        scheduleReconnect(attempt)
        return
      }

      if (response.status === 404) {
        console.log("[SSE] No active session")
        setError("No active session. Waiting for connection...")
        isConnectingRef.current = false
        scheduleReconnect(attempt)
        return
      }

      if (response.ok) {
        const data = await response.json()
        setTranscripts(data.transcripts || [])
      }

      // Connect to SSE stream
      const eventSource = new EventSource("/api/transcripts/stream")
      eventSourceRef.current = eventSource
      lastActivityRef.current = Date.now()

      eventSource.onopen = () => {
        if (!mountedRef.current) return

        console.log("[SSE] Connected successfully")
        setConnected(true)
        setError(null)
        setReconnectAttempt(0)
        setReconnectSecondsRemaining(null)
        lastActivityRef.current = Date.now()
        isConnectingRef.current = false
      }

      eventSource.onmessage = (event) => {
        if (!mountedRef.current) return

        lastActivityRef.current = Date.now()

        try {
          const data = JSON.parse(event.data)

          // Handle heartbeat/ping messages
          if (data.type === "heartbeat" || data.type === "ping") {
            console.log("[SSE] Heartbeat received")
            return
          }

          if (data.type === "connected") {
            console.log("[SSE] Server confirmed connection")
            return
          }

          // Handle settings update - dispatch custom event for useSettings hook
          if (data.type === "settings_update" && data.settings) {
            console.log("[SSE] Settings update received:", data.settings)
            window.dispatchEvent(
              new CustomEvent("settings_update", { detail: data.settings })
            )
            return
          }

          // Handle display preview update
          if (data.type === "display_preview") {
            setDisplayPreview({
              text: data.text,
              lines: data.lines,
              isFinal: data.isFinal,
              timestamp: data.timestamp,
            })
            return
          }

          // Use utteranceId for correlation if available
          if (data.utteranceId) {
            setTranscripts((prev) => {
              const existingIndex = prev.findIndex(
                (t) => t.utteranceId === data.utteranceId
              )

              const newTranscript: Transcript = {
                id: data.id,
                utteranceId: data.utteranceId,
                speaker: data.speaker,
                text: data.text,
                timestamp: data.timestamp,
                isFinal: data.type === "final",
              }

              if (existingIndex >= 0) {
                // Update existing transcript (interim->interim or interim->final)
                const updated = [...prev]
                updated[existingIndex] = newTranscript
                return updated
              } else {
                // New utterance
                return [...prev, newTranscript]
              }
            })
          } else {
            // Legacy behavior: no utteranceId
            if (data.type === "interim") {
              setTranscripts((prev) => {
                // Remove any existing INTERIM transcript from the same speaker
                const filtered = prev.filter(
                  (t) => !(t.speaker === data.speaker && !t.isFinal)
                )

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
            } else if (data.type === "final") {
              setTranscripts((prev) => {
                // Check if we already have this final transcript by ID
                const alreadyExists = prev.some((t) => t.isFinal && t.id === data.id)
                if (alreadyExists) {
                  return prev
                }

                // Remove the interim transcript from the same speaker
                const filtered = prev.filter(
                  (t) => !(t.speaker === data.speaker && !t.isFinal)
                )

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
        } catch (e) {
          console.error("[SSE] Failed to parse message:", e)
        }
      }

      eventSource.onerror = (e) => {
        console.error("[SSE] Connection error:", e)

        if (!mountedRef.current) return

        setConnected(false)
        isConnectingRef.current = false

        // Close the current connection
        if (eventSourceRef.current) {
          eventSourceRef.current.close()
          eventSourceRef.current = null
        }

        // Schedule reconnection
        scheduleReconnect(attempt)
      }

      // Start heartbeat monitoring
      heartbeatCheckRef.current = setInterval(() => {
        if (!mountedRef.current) return

        const timeSinceLastActivity = Date.now() - lastActivityRef.current

        if (timeSinceLastActivity > HEARTBEAT_TIMEOUT_MS) {
          console.log(`[SSE] No activity for ${timeSinceLastActivity}ms, reconnecting...`)

          if (eventSourceRef.current) {
            eventSourceRef.current.close()
            eventSourceRef.current = null
          }

          setConnected(false)
          scheduleReconnect(0) // Start fresh with attempt 0
        }
      }, HEARTBEAT_CHECK_INTERVAL_MS)

    } catch (err) {
      console.error("[SSE] Failed to connect:", err)

      if (!mountedRef.current) {
        isConnectingRef.current = false
        return
      }

      setConnected(false)
      isConnectingRef.current = false
      scheduleReconnect(attempt)
    }
  }, [cleanup, scheduleReconnect])

  // Initial connection and cleanup
  useEffect(() => {
    mountedRef.current = true
    connect(0)

    return () => {
      mountedRef.current = false
      cleanup()
    }
  }, [connect, cleanup])

  // Manual reconnect function (for UI button)
  const reconnect = useCallback(() => {
    console.log("[SSE] Manual reconnect triggered")
    cleanup()
    setReconnectAttempt(0)
    connect(0)
  }, [connect, cleanup])

  const [isRecording, setIsRecording] = useState(false)

  const toggleRecording = () => {
    setIsRecording((prev) => !prev)
  }

  const clearTranscripts = () => {
    setTranscripts([])
  }

  return {
    transcripts,
    connected,
    error,
    reconnectAttempt,
    isRecording,
    toggleRecording,
    clearTranscripts,
    reconnect,
    displayPreview,
  }
}
