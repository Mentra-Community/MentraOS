export interface TranscriptionRouteSummary {
  hasCloudSubscriber: boolean
  hasForceLocalSubscriber: boolean
}

export interface TranscriptionSubscriberRoutes {
  cloud: boolean
  forceLocal: boolean
}

export type TranscriptionDeliveryRoute = "default" | "forceLocal" | "all"

export function summarizeTranscriptionRoutes<T>(
  subscribers: Iterable<T>,
  routesFor: (subscriber: T) => TranscriptionSubscriberRoutes,
): TranscriptionRouteSummary {
  let hasCloudSubscriber = false
  let hasForceLocalSubscriber = false
  for (const subscriber of subscribers) {
    const routes = routesFor(subscriber)
    if (routes.cloud) hasCloudSubscriber = true
    if (routes.forceLocal) hasForceLocalSubscriber = true
  }
  return {hasCloudSubscriber, hasForceLocalSubscriber}
}

export function transcriptionDeliveryRoute(
  source: "cloud" | "local",
  routes: TranscriptionSubscriberRoutes,
  cloudConnected: boolean,
): TranscriptionDeliveryRoute | null {
  if (source === "cloud") return routes.cloud ? "default" : null
  if (cloudConnected) return routes.forceLocal ? "forceLocal" : null
  if (routes.cloud && routes.forceLocal) return "all"
  if (routes.forceLocal) return "forceLocal"
  return routes.cloud ? "default" : null
}
