/** React Native AbortSignal does not provide throwIfAborted. */
export function assertReportNotAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return
  const error = new Error("Incident report aborted")
  error.name = "AbortError"
  throw error
}
