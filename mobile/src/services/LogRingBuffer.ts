// mobile/src/services/LogRingBuffer.ts
// Ring buffer for capturing logs to include in bug reports

export interface LogEntry {
  timestamp: number
  level: "debug" | "info" | "warn" | "error"
  message: string
  source?: string // 'BLE', 'WebSocket', 'Navigation', 'Network', 'console', etc.
  metadata?: Record<string, unknown>
}

class LogRingBuffer {
  private logs: LogEntry[] = []
  private maxAgeMs = 10 * 60 * 1000 // 10 minutes
  private maxEntries = 10000
  private isIntercepting = false

  /**
   * Append a log entry to the buffer
   */
  append(entry: Omit<LogEntry, "timestamp">) {
    this.logs.push({...entry, timestamp: Date.now()})
    this.prune()
  }

  /**
   * Get all recent logs (within maxAgeMs window)
   */
  getRecentLogs(): LogEntry[] {
    this.prune()
    return [...this.logs]
  }

  /**
   * Clear all logs from the buffer
   */
  clear() {
    this.logs = []
  }

  /**
   * Get buffer statistics
   */
  getStats(): {count: number; oldestTimestamp: number | null; newestTimestamp: number | null} {
    this.prune()
    return {
      count: this.logs.length,
      oldestTimestamp: this.logs.length > 0 ? this.logs[0].timestamp : null,
      newestTimestamp: this.logs.length > 0 ? this.logs[this.logs.length - 1].timestamp : null,
    }
  }

  /**
   * Remove old entries beyond maxAgeMs or maxEntries
   */
  private prune() {
    const cutoff = Date.now() - this.maxAgeMs
    this.logs = this.logs.filter((l) => l.timestamp > cutoff)
    if (this.logs.length > this.maxEntries) {
      this.logs = this.logs.slice(-this.maxEntries)
    }
  }

  /**
   * Start intercepting console methods to capture logs.
   * Should be called once at app startup.
   */
  startConsoleInterception() {
    if (this.isIntercepting) {
      return
    }
    this.isIntercepting = true

    const originalConsole = {
      log: console.log,
      info: console.info,
      warn: console.warn,
      error: console.error,
      debug: console.debug,
    }

    const appendToBuffer = this.append.bind(this)

    const createInterceptor =
      (level: "debug" | "info" | "warn" | "error", originalFn: (...args: unknown[]) => void) =>
      (...args: unknown[]) => {
        // Call original first
        originalFn.apply(console, args)

        // Append to ring buffer
        appendToBuffer({
          level,
          message: args
            .map((a) => {
              if (a === null) return "null"
              if (a === undefined) return "undefined"
              if (typeof a === "object") {
                try {
                  return JSON.stringify(a)
                } catch {
                  return String(a)
                }
              }
              return String(a)
            })
            .join(" "),
          source: "console",
        })
      }

    console.log = createInterceptor("info", originalConsole.log)
    console.info = createInterceptor("info", originalConsole.info)
    console.warn = createInterceptor("warn", originalConsole.warn)
    console.error = createInterceptor("error", originalConsole.error)
    console.debug = createInterceptor("debug", originalConsole.debug)
  }
}

// Export singleton instance
export const logBuffer = new LogRingBuffer()
export default logBuffer
