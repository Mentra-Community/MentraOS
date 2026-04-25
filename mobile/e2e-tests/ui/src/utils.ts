import type {DelayPoint} from "./types"

export function formatClock(ms?: number | null): string {
  if (!ms) {
    return "-"
  }
  return new Date(ms).toLocaleTimeString()
}

export function formatClockWithMs(ms?: number | null): string {
  if (!ms) {
    return "-"
  }
  const date = new Date(ms)
  return `${date.toLocaleTimeString()}.${String(date.getMilliseconds()).padStart(3, "0")}`
}

export function formatDuration(ms?: number | null): string {
  if (ms === null || ms === undefined) {
    return "-"
  }
  const seconds = ms / 1000
  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`
  }
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = Math.round(seconds % 60)
  return `${minutes}m ${remainingSeconds}s`
}

export function formatDelay(ms?: number | null): string {
  if (ms === null || ms === undefined) {
    return "-"
  }
  return `${Math.round(ms)} ms`
}

export function formatAge(ms?: number | null): string {
  if (!ms) {
    return "-"
  }
  return `${((Date.now() - ms) / 1000).toFixed(1)}s ago`
}

export function trimmedMean(values: number[], trimFraction = 0.1): number | null {
  if (!values.length) {
    return null
  }
  const sortedValues = [...values].sort((left, right) => left - right)
  let trimCount = Math.floor(sortedValues.length * trimFraction)
  if (trimCount * 2 >= sortedValues.length) {
    trimCount = Math.max(0, Math.floor((sortedValues.length - 1) / 2))
  }
  const trimmedValues = trimCount ? sortedValues.slice(trimCount, sortedValues.length - trimCount) : sortedValues
  const valuesToAverage = trimmedValues.length ? trimmedValues : sortedValues
  return valuesToAverage.reduce((sum, value) => sum + value, 0) / valuesToAverage.length
}

export function buildLatencySeries(points: DelayPoint[]): Array<DelayPoint & {moving_average: number | null}> {
  const sortedPoints = [...points].sort((left, right) => left.ts_ms - right.ts_ms)
  return sortedPoints.map((point, index) => {
    if (index < 9) {
      return {...point, moving_average: null}
    }
    const window = sortedPoints.slice(index - 9, index + 1)
    return {
      ...point,
      moving_average: trimmedMean(window.map((item) => item.delay_ms)),
    }
  })
}

export function statusTone(status: string): "good" | "warn" | "bad" {
  if (status === "running_utterance") {
    return "good"
  }
  if (status === "error") {
    return "bad"
  }
  return "warn"
}
