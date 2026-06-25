import type {MentraTyped} from "@mentra/miniapp/ui"

export interface ListDemoItem {
  id: string
  label: string
  detail: string
}

export interface ListDemoSnapshot {
  items: ListDemoItem[]
  selectedIndex: number
  selectedLabel: string
  displayMode: "list" | "detail"
  lastEvent: string
  lastSelectedItemName?: string
}

export interface Channels {
  "list-demo:snapshot": ListDemoSnapshot
  "list-demo:show-list": Record<string, never>
  "list-demo:show-detail": Record<string, never>
}

declare global {
  // eslint-disable-next-line no-var
  var mentra: MentraTyped<Channels>
}
