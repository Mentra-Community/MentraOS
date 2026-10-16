export interface NativeHttpResult {
  status: number
  statusText: string
  headers: Record<string, string>
  body: string
}

export interface NativeHttpTransport {
  nativeHttpRequest(
    requestId: string,
    method: string,
    url: string,
    headers: Record<string, string>,
    body: string | null,
  ): Promise<NativeHttpResult>
  cancelNativeHttpRequest(requestId: string): Promise<void>
}

let requestSequence = 0

function abortReason(signal: AbortSignal): unknown {
  if (signal.reason !== undefined) return signal.reason
  const error = new Error("Native HTTP request aborted")
  error.name = "AbortError"
  return error
}

/** Keep Android's background-safe HTTP path while cancelling its actual native request. */
export function nativeHttpRequest(
  native: NativeHttpTransport,
  method: string,
  url: string,
  headers: Record<string, string>,
  body: string | null,
  signal?: AbortSignal,
): Promise<NativeHttpResult> {
  if (signal?.aborted) return Promise.reject(abortReason(signal))
  const requestId = `http-${Date.now().toString(36)}-${++requestSequence}`
  // Start first, then subscribe: Expo delivers start and cancel on the same serial queue.
  const request = native.nativeHttpRequest(requestId, method, url, headers, body)
  if (!signal) return request

  return new Promise((resolve, reject) => {
    let settled = false
    let cancelling = false
    const finish = (action: () => void) => {
      if (settled) return
      settled = true
      signal.removeEventListener("abort", onAbort)
      action()
    }
    const onAbort = () => {
      if (settled || cancelling) return
      cancelling = true
      void native.cancelNativeHttpRequest(requestId).then(
        () => finish(() => reject(abortReason(signal))),
        (error: unknown) => finish(() => reject(error)),
      )
    }
    request.then(
      (result) => {
        if (signal.aborted) onAbort()
        else finish(() => resolve(result))
      },
      (error: unknown) => {
        if (signal.aborted) onAbort()
        else finish(() => reject(error))
      },
    )
    signal.addEventListener("abort", onAbort, {once: true})
    // Handles an abort fired synchronously during native registration.
    if (signal.aborted) onAbort()
  })
}
