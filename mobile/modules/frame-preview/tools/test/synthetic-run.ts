/** Builds synthetic run logs in the real line schema, so gate tests can vary one input at a time. */

export interface SyntheticRunOptions {
  platform?: "ios" | "android"
  mode?: string
  seconds?: number
  targetFps?: number
  /** Each of these is evaluated per status line index; `undefined` omits the key. */
  deliveredFps?: (i: number) => number | undefined
  deliveryGapMsP95?: (i: number) => number | undefined
  tapFramesOffered?: (i: number) => number | undefined
  tapFramesWithSink?: (i: number) => number | undefined
  tapOfferMeanUs?: (i: number) => number | undefined
  tapCadenceMaxMs?: (i: number) => number | undefined
  memoryFootprintMb?: (i: number) => number | undefined
  thermalState?: (i: number) => string | undefined
  statusExtra?: (i: number) => Record<string, unknown>
  meta?: Record<string, unknown>
  end?: Record<string, unknown> | null
}

export function syntheticRun(options: SyntheticRunOptions = {}): string {
  const platform = options.platform ?? "android"
  const seconds = options.seconds ?? 60
  const targetFps = options.targetFps ?? 15
  const mode = options.mode ?? "render"
  const on = mode !== "off"
  const runId = `${platform}-synthetic`
  const lines: string[] = [
    JSON.stringify({
      t: "meta",
      runId,
      platform,
      schema: 1,
      source: "call",
      mode,
      targetFps,
      deviceModel: "test",
      ...options.meta,
    }),
  ]
  const pick = <T>(fn: ((i: number) => T | undefined) | undefined, i: number, fallback: T | undefined) =>
    fn ? fn(i) : fallback
  for (let i = 0; i < seconds; i++) {
    const status: Record<string, unknown> = {
      t: "status",
      platform,
      runId,
      running: true,
      mode,
      targetFps,
      deliveredFps: pick(options.deliveredFps, i, on ? targetFps : 0),
      deliveryGapMsP95: pick(options.deliveryGapMsP95, i, on ? 1000 / targetFps + 3 : 0),
      tapFramesOffered: pick(options.tapFramesOffered, i, 30),
      tapFramesWithSink: pick(options.tapFramesWithSink, i, on ? 30 : 0),
      tapOfferMeanUs: pick(options.tapOfferMeanUs, i, on ? 15 : 0),
      tapCadenceMaxMs: pick(options.tapCadenceMaxMs, i, 40),
      memoryFootprintMb: pick(options.memoryFootprintMb, i, 100),
      thermalState: pick(options.thermalState, i, platform === "ios" ? "nominal" : "none"),
      ackTimeouts: 0,
      transportErrors: 0,
      packFailures: 0,
      tapSinkExceptions: 0,
      ...options.statusExtra?.(i),
    }
    for (const key of Object.keys(status)) if (status[key] === undefined) delete status[key]
    lines.push(JSON.stringify(status))
  }
  if (options.end !== null) {
    lines.push(
      JSON.stringify({t: "end", runId, reason: "stop", durationMs: seconds * 1000, installReloads: 0, ...options.end}),
    )
  }
  return lines.join("\n") + "\n"
}
