type HotspotState = {state: "disabled" | "enabled"}

type HotspotShutdownOptions = {
  attempts?: number
  initialDelayMs?: number
  retryDelayMs?: number
  sleep?: (delayMs: number) => Promise<void>
}

const sleep = (delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs))

/**
 * Disable a glasses hotspot with a bounded retry. ASG APK replacement keeps the
 * BLE link alive through BES, but the first command after the new ASG process
 * appears can still land while its command path is settling.
 */
export async function disableHotspotWithRetry(
  requestDisabled: () => Promise<HotspotState>,
  options: HotspotShutdownOptions = {},
): Promise<boolean> {
  const attempts = Math.max(1, options.attempts ?? 2)
  const initialDelayMs = Math.max(0, options.initialDelayMs ?? 0)
  const retryDelayMs = Math.max(0, options.retryDelayMs ?? 500)
  const wait = options.sleep ?? sleep

  if (initialDelayMs > 0) await wait(initialDelayMs)

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const status = await requestDisabled()
      if (status.state === "disabled") return true
    } catch {
      // A lost command is indistinguishable from a response timeout here. Retry
      // while the phone still owns the hotspot network and local server.
    }

    if (attempt < attempts && retryDelayMs > 0) await wait(retryDelayMs)
  }

  return false
}
