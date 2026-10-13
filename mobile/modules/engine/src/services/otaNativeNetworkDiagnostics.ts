import {DeviceEventEmitter, Platform} from "react-native"

type FailureCategory = "dns" | "connect" | "tls" | "timeout" | "other"

function classifyFailure(message: string, timedOut: boolean): FailureCategory {
  if (timedOut || /\b(?:timed out|timeout)\b/i.test(message)) return "timeout"
  if (/unable to resolve host|no address associated with hostname|UnknownHostException/i.test(message)) return "dns"
  if (
    /SSLHandshakeException|SSLProtocolException|SSLPeerUnverifiedException|handshake failed|trust anchor|certificate/i.test(
      message,
    )
  )
    return "tls"
  if (
    /failed to connect|connection refused|network is unreachable|no route to host|ENETUNREACH|EHOSTUNREACH|ECONNREFUSED/i.test(
      message,
    )
  )
    return "connect"
  return "other"
}

/**
 * Observe Android's existing RN completion event before fetch discards its error.
 * The event exposes no URL and fetch exposes no native request ID. Other concurrent
 * RN requests may fail in this window; these observations are explicitly uncorrelated.
 */
export function observeManifestNativeErrors(manifestRequestId: number, startedAtMs: number): () => void {
  if (Platform.OS !== "android") return () => {}
  try {
    let active = true
    const subscription = DeviceEventEmitter.addListener("didCompleteNetworkResponse", (payload: unknown) => {
      try {
        if (!active) return
        if (!Array.isArray(payload) || (payload.length !== 2 && payload.length !== 3)) return
        const [nativeRequestId, message, timedOut] = payload as readonly unknown[]
        if (typeof nativeRequestId !== "number" || !Number.isSafeInteger(nativeRequestId) || nativeRequestId < 0) return
        if (typeof message !== "string" || !message || (timedOut !== undefined && typeof timedOut !== "boolean")) return
        const observedAtMs = Date.now()
        console.log(
          `OTA: native network failure observation ${JSON.stringify({
            manifestRequestId,
            nativeRequestId,
            correlation: "unavailable",
            observedAtMs,
            elapsedMs: Math.max(0, observedAtMs - startedAtMs),
            category: classifyFailure(message, timedOut === true),
            classification: timedOut === true ? "native-timeout-flag" : "message-pattern",
          })}`,
        )
      } catch {
        // Diagnostic parsing/logging cannot affect the native request's other listeners.
      }
    })
    return () => {
      if (!active) return
      active = false
      try {
        subscription.remove()
      } catch {
        // Diagnostic cleanup must not replace the manifest's result.
      }
    }
  } catch {
    // The ordinary fetch still runs if diagnostic subscription is unavailable.
    return () => {}
  }
}
