import type {OfflineModelStatus} from "../../shared/types"

/**
 * What the phone's on-device speech model is doing for offline captions, in
 * words: downloading, loading, ready, or why captions get no text.
 */
export function offlineModelMessage(status: OfflineModelStatus | null): string | null {
  if (!status) return null
  switch (status.state) {
    case "downloading":
      return `Downloading the on-device speech model… ${Math.round(status.progress ?? 0)}%`
    case "loading":
      return "Loading the on-device speech model…"
    case "ready":
      return null
    case "unavailable":
      return `Offline captions are unavailable: ${status.reason ?? "the on-device speech model is unavailable"}`
  }
}

/**
 * A notice for offline captions while they can't show text yet, or at all.
 * Renders nothing while offline speech to text is off or the model is ready.
 */
export function OfflineModelNotice({
  enabled,
  status,
  className = "",
}: {
  enabled: boolean
  status: OfflineModelStatus | null
  className?: string
}) {
  const message = enabled ? offlineModelMessage(status) : null
  if (!message) return null
  const unavailable = status?.state === "unavailable"
  return (
    <p
      role={unavailable ? "alert" : "status"}
      className={`text-sm font-['Red_Hat_Display'] rounded-xl px-3 py-2 ${
        unavailable
          ? "bg-amber-50 text-amber-900 dark:bg-amber-950/60 dark:text-amber-100"
          : "bg-gray-50 text-gray-600 dark:bg-zinc-800 dark:text-zinc-300"
      } ${className}`}>
      {message}
    </p>
  )
}
