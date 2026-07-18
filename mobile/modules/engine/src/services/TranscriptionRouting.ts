export interface TranscriptionRouteSummary {
  hasCloudSubscriber: boolean
  hasForceLocalSubscriber: boolean
}

export function summarizeTranscriptionRoutes<T>(
  subscribers: Iterable<T>,
  forcesLocal: (subscriber: T) => boolean,
): TranscriptionRouteSummary {
  let hasCloudSubscriber = false
  let hasForceLocalSubscriber = false
  for (const subscriber of subscribers) {
    if (forcesLocal(subscriber)) hasForceLocalSubscriber = true
    else hasCloudSubscriber = true
  }
  return {hasCloudSubscriber, hasForceLocalSubscriber}
}

export function shouldDeliverTranscription(
  source: "cloud" | "local",
  forceLocal: boolean,
  cloudConnected: boolean,
): boolean {
  if (source === "cloud") return !forceLocal
  return forceLocal || !cloudConnected
}
