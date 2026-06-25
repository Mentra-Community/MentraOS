import "../shared/channels"
import type {ListDemoSnapshot} from "../shared/channels"

const mode = document.getElementById("mode")
const selected = document.getElementById("selected")
const event = document.getElementById("event")
const items = document.getElementById("items")
const showList = document.getElementById("show-list")
const showDetail = document.getElementById("show-detail")

function render(snapshot: ListDemoSnapshot): void {
  if (mode) mode.textContent = snapshot.displayMode === "list" ? "List" : "Detail"
  if (selected) selected.textContent = `${snapshot.selectedIndex + 1}. ${snapshot.selectedLabel}`
  if (event) {
    event.textContent = snapshot.lastSelectedItemName
      ? `${snapshot.lastEvent} Firmware item: ${snapshot.lastSelectedItemName}`
      : snapshot.lastEvent
  }
  if (items) {
    items.innerHTML = ""
    for (const [index, item] of snapshot.items.entries()) {
      const row = document.createElement("li")
      row.className = index === snapshot.selectedIndex ? "active" : ""
      const label = document.createElement("span")
      label.textContent = item.label
      const detail = document.createElement("small")
      detail.textContent = item.detail
      row.append(label, detail)
      items.appendChild(row)
    }
  }
}

showList?.addEventListener("click", () => {
  mentra.send("list-demo:show-list", {})
})

showDetail?.addEventListener("click", () => {
  mentra.send("list-demo:show-detail", {})
})

mentra.on("list-demo:snapshot", render)
mentra.ready()
