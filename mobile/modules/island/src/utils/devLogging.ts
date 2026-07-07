import {LogBox} from "react-native"
import {configureReanimatedLogger, ReanimatedLogLevel} from "react-native-reanimated"

export interface LogEntry {
  timestamp: number
  level: "debug" | "info" | "warn" | "error"
  message: string
  source?: string
  metadata?: Record<string, unknown>
}

class LogRingBuffer {
  private logs: LogEntry[] = []
  private maxAgeMs = 10 * 60 * 1000
  private maxEntries = 10000
  private isIntercepting = false

  append(entry: Omit<LogEntry, "timestamp">) {
    this.logs.push({...entry, timestamp: Date.now()})
    this.prune()
  }

  getRecentLogs(): LogEntry[] {
    this.prune()
    return [...this.logs]
  }

  clear() {
    this.logs = []
  }

  getStats(): {count: number; oldestTimestamp: number | null; newestTimestamp: number | null} {
    this.prune()
    return {
      count: this.logs.length,
      oldestTimestamp: this.logs.length > 0 ? this.logs[0].timestamp : null,
      newestTimestamp: this.logs.length > 0 ? this.logs[this.logs.length - 1].timestamp : null,
    }
  }

  private prune() {
    const cutoff = Date.now() - this.maxAgeMs
    this.logs = this.logs.filter((l) => l.timestamp > cutoff)
    if (this.logs.length > this.maxEntries) {
      this.logs = this.logs.slice(-this.maxEntries)
    }
  }

  startConsoleInterception() {
    if (this.isIntercepting) return
    this.isIntercepting = true

    const ignoredLogs = [
      /Failed to open debugger. Please check that the dev server is running and reload the app./,
      /Require cycle:/,
      /is missing the required default export./,
      /Attempted to import the module/,
      /The action 'RESET' with payload/,
      /The action 'POP_TO_TOP' was not handled/,
      /socket-0 binding/,
      /socket-0 bound to/,
      /Error while flushing PostHog/,
      /backTitleFontFamily prop is not available on Android/,
      /disableBackButtonMenu prop is not available on Android/,
      /backTitleVisible prop is not available on Android/,
      /topInsetEnabled prop is not available on Android/,
      /largeTitleHideShadow prop is not available on Android/,
      /largeTitleFontWeight prop is not available on Android/,
      /userInterfaceStyle prop is not available on Android/,
      /largeTitleFontFamily prop is not available on Android/,
      /Points are coincident/,
    ]

    LogBox.ignoreLogs(ignoredLogs)

    if (__DEV__) {
      const withoutIgnored =
        (logger: (...args: unknown[]) => void) =>
        (...args: unknown[]) => {
          const output = args.join(" ")
          if (!ignoredLogs.some((log) => log.test(output))) {
            logger(...args)
          }
        }

      console.log = withoutIgnored(console.log)
      console.info = withoutIgnored(console.info)
      console.warn = withoutIgnored(console.warn)
      console.error = withoutIgnored(console.error)
    }

    configureReanimatedLogger({
      level: ReanimatedLogLevel.warn,
      strict: false,
    })

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
        originalFn.apply(console, args)
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

export const logBuffer = new LogRingBuffer()
export default logBuffer
