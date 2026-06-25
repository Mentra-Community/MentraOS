/**
 * Background JSContext entry - native selectable list demo.
 *
 * The glasses render a firmware-owned list. The miniapp receives row clicks
 * through session.input.onTouch(...), including selectedItemIndex/name on G2.
 */

import {
  registerMiniapp,
  type MiniappSession,
  type TouchData,
  type UIModule,
} from "@mentra/miniapp/background"

import type {Channels, ListDemoItem, ListDemoSnapshot} from "../shared/channels"

const ITEMS: ListDemoItem[] = [
  {
    id: "weather",
    label: "Weather",
    detail: "Shows a short forecast card, then returns to the list.",
  },
  {
    id: "timer",
    label: "Timer",
    detail: "Pretends to start a five minute focus timer.",
  },
  {
    id: "messages",
    label: "Messages",
    detail: "Represents opening a recent message thread.",
  },
  {
    id: "music",
    label: "Music",
    detail: "Represents choosing a playback control surface.",
  },
  {
    id: "settings",
    label: "Settings",
    detail: "Represents a nested settings page.",
  },
  {
    id: "help",
    label: "Help",
    detail: "Explains that G2 scrolls and highlights the rows natively.",
  },
]

const ROW_LABELS = ITEMS.map((item, index) => `${index + 1}. ${item.label}`)

class SelectableListDemo {
  private readonly ui: UIModule<Channels>
  private selectedIndex = 0
  private displayMode: "list" | "detail" = "list"
  private lastEvent = "List shown. Scroll on G2, tap a row to select it."
  private lastSelectedItemName: string | undefined
  private returnTimer: ReturnType<typeof setTimeout> | undefined

  constructor(private readonly session: MiniappSession) {
    this.ui = session.ui as unknown as UIModule<Channels>
  }

  start(): void {
    this.ui.onOpen(() => this.pushSnapshot())
    this.ui.on("list-demo:show-list", () => this.showList("List restored from UI."))
    this.ui.on("list-demo:show-detail", () => this.showDetail("Detail restored from UI."))

    this.session.input.onTouch((event) => this.handleTouch(event))
    this.showList()
  }

  private handleTouch(event: TouchData): void {
    this.updateSelectedIndex(event)
    this.lastSelectedItemName = event.selectedItemName

    if (event.kind === "click") {
      this.showDetail(`Selected ${ITEMS[this.selectedIndex]?.label ?? "row"}.`)
      return
    }

    if (event.kind === "double_click") {
      this.showList("Double click returned to the list.")
      return
    }

    if (event.kind === "scroll_top") {
      this.lastEvent = "Reached the top of the native list."
    } else if (event.kind === "scroll_bottom") {
      this.lastEvent = "Reached the bottom of the native list."
    } else {
      this.lastEvent = `Touch event: ${event.kind}`
    }
    this.pushSnapshot()
  }

  private updateSelectedIndex(event: TouchData): void {
    if (event.selectedItemName) {
      const fromName = ROW_LABELS.indexOf(event.selectedItemName)
      if (fromName >= 0) {
        this.selectedIndex = fromName
        return
      }
    }

    if (typeof event.selectedItemIndex === "number" && Number.isFinite(event.selectedItemIndex)) {
      const raw = Math.trunc(event.selectedItemIndex)
      this.selectedIndex = Math.min(Math.max(raw, 0), ITEMS.length - 1)
    }
  }

  private showList(lastEvent = "List shown. Scroll on G2, tap a row to select it."): void {
    this.clearReturnTimer()
    // G2 recreates the native list with the first row highlighted. Keep the
    // demo's logical selection aligned until the next list event says otherwise.
    this.selectedIndex = 0
    this.lastSelectedItemName = undefined
    this.displayMode = "list"
    this.lastEvent = lastEvent
    this.session.display.showSelectableList(ROW_LABELS, {
      x: 24,
      y: 16,
      width: 528,
      height: 256,
      borderWidth: 1,
      borderColor: 13,
      borderRadius: 8,
      paddingLength: 8,
      itemWidth: 500,
      showSelectionBorder: true,
    })
    this.pushSnapshot()
  }

  private showDetail(lastEvent = "Detail shown."): void {
    this.clearReturnTimer()
    const item = ITEMS[this.selectedIndex] ?? ITEMS[0]!
    this.displayMode = "detail"
    this.lastEvent = lastEvent
    this.session.display.showTextWall(`Selected: ${item.label}\n\n${item.detail}\n\nDouble click to return.`)
    this.returnTimer = setTimeout(() => this.showList("Auto-returned to the list after showing detail."), 5000)
    this.pushSnapshot()
  }

  private pushSnapshot(): void {
    const selected = ITEMS[this.selectedIndex] ?? ITEMS[0]!
    const snapshot: ListDemoSnapshot = {
      items: ITEMS,
      selectedIndex: this.selectedIndex,
      selectedLabel: selected.label,
      displayMode: this.displayMode,
      lastEvent: this.lastEvent,
      lastSelectedItemName: this.lastSelectedItemName,
    }
    this.ui.send("list-demo:snapshot", snapshot)
  }

  private clearReturnTimer(): void {
    if (this.returnTimer) {
      clearTimeout(this.returnTimer)
      this.returnTimer = undefined
    }
  }
}

registerMiniapp((session) => {
  new SelectableListDemo(session).start()
})
