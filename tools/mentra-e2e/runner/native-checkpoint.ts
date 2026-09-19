import type {Interface} from "node:readline"

export const BROWSER_CONTROLLER_TIMEOUT_MS = 240000

/** Native actions and their recordings share the controller's overall deadline. */
export function waitForNativeCheckpoint(
  input: Interface,
  checkpoint: string,
  publish: () => Promise<void>,
  deadline: number,
  signal: AbortSignal,
) {
  return new Promise<void>((resolve, reject) => {
    let acknowledged = false
    let published = false
    let finished = false
    const finish = (error?: unknown) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      input.off("line", onLine)
      signal.removeEventListener("abort", onAbort)
      error !== undefined ? reject(error) : resolve()
    }
    const onLine = (line: string) => {
      if (line !== "MENTRA_NATIVE_ACK " + checkpoint) return
      acknowledged = true
      if (published) finish()
    }
    const onAbort = () => finish(signal.reason ?? new Error("Native controller closed"))
    const remaining = deadline - performance.now()
    const timer = setTimeout(
      () => finish(new Error(`Controller deadline expired while awaiting native acknowledgement: ${checkpoint}`)),
      Math.max(0, remaining),
    )
    input.on("line", onLine)
    signal.addEventListener("abort", onAbort, {once: true})
    if (signal.aborted) return onAbort()
    if (remaining <= 0) return finish(new Error("Controller deadline expired before publishing native checkpoint"))
    void Promise.resolve()
      .then(() => {
        if (!finished) return publish()
      })
      .then(
        () => {
          published = true
          if (acknowledged) finish()
        },
        (error) => finish(error ?? new Error("Native checkpoint evidence failed")),
      )
  })
}
