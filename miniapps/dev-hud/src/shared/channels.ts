import type {DevHudNotification, DevHudSnapshot, DevHudStatus, DevHudView, NotificationTarget} from "./types"

export interface Channels {
  "devhud:snapshot": DevHudSnapshot
  "devhud:status": DevHudStatus
  "devhud:notification": DevHudNotification
  "devhud:open-target": NotificationTarget
  "devhud:close-detail": Record<string, never>
  "devhud:show-target": NotificationTarget
  "devhud:close-detail-on-glasses": {view: Extract<DevHudView, "github" | "codex">}
  "devhud:error": {message: string}
  "devhud:loading": {loading: boolean}
  "devhud:request-snapshot": Record<string, never>
  "devhud:refresh": Record<string, never>
  "devhud:set-endpoint": {endpoint: string}
  "devhud:set-view": {view: DevHudView}
}

declare global {
  // eslint-disable-next-line no-var
  var mentra: import("@mentra/miniapp/ui").MentraTyped<Channels>
}
