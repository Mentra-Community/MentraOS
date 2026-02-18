import {useState, useEffect, useCallback, useRef} from "react"

interface ConnectionState {
  connected: boolean
  error: string | null
  sessionCount: number
}

const POLL_INTERVAL_MS = 5000 // Check every 5 seconds

export function useConnection() {
  const [state, setState] = useState<ConnectionState>({
    connected: false,
    error: null,
    sessionCount: 0,
  })
  const mountedRef = useRef(true)

  const checkConnection = useCallback(async () => {
    try {
      const response = await fetch("/api/connection-status")

      if (!mountedRef.current) return

      if (!response.ok) {
        setState({
          connected: false,
          error: `Server error: ${response.status}`,
          sessionCount: 0,
        })
        return
      }

      const data = await response.json()

      setState({
        connected: data.connected ?? false,
        error: null,
        sessionCount: data.sessionCount ?? 0,
      })
    } catch {
      if (!mountedRef.current) return

      setState({
        connected: false,
        error: "Unable to reach server",
        sessionCount: 0,
      })
    }
  }, [])

  // Initial check and polling
  useEffect(() => {
    mountedRef.current = true

    // Check immediately
    checkConnection()

    // Poll periodically
    const interval = setInterval(checkConnection, POLL_INTERVAL_MS)

    return () => {
      mountedRef.current = false
      clearInterval(interval)
    }
  }, [checkConnection])

  // Manual refresh
  const refresh = useCallback(() => {
    checkConnection()
  }, [checkConnection])

  return {
    connected: state.connected,
    error: state.error,
    sessionCount: state.sessionCount,
    refresh,
  }
}
