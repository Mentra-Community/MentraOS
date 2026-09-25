import {expect, test} from "bun:test"
import {JSDOM} from "jsdom"
import React, {act} from "react"
import {createRoot} from "react-dom/client"
import {useHistoryState} from "./useHistoryState"
import {miniappHistoryBridge} from "../../mobile/src/components/miniapp/historyBridge"
test("nested screens, dialogs, recording completion and forward navigation use host history", async () => {
  const dom = new JSDOM('<div id="app"></div>', {url: "file:///miniapp/index.html", runScripts: "outside-only"})
  const w = dom.window
  const messages: any[] = []
  w.ReactNativeWebView = {postMessage: (s: string) => messages.push(JSON.parse(s))}
  w.eval(miniappHistoryBridge)
  const previousGlobals = {
    window: globalThis.window,
    document: globalThis.document,
    IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT,
  }
  Object.assign(globalThis, {window: w, document: w.document, IS_REACT_ACT_ENVIRONMENT: true})
  let tab: any, modal: any, screen: any
  function App() {
    tab = useHistoryState("tab", "home")
    modal = useHistoryState("modal", false)
    screen = useHistoryState("screen", "list")
    return (
      <span>
        {tab[0]}:{String(modal[0])}:{screen[0]}
      </span>
    )
  }
  const root = createRoot(document.getElementById("app")!)
  try {
    await act(async () =>
      root.render(
        <React.StrictMode>
          <App />
        </React.StrictMode>,
      ),
    )
    function check(condition: boolean, label: string) {
      expect(condition, label).toBe(true)
    }
    async function pop(action: () => void) {
      await act(async () => {
        const done = new Promise((r) => w.addEventListener("popstate", r, {once: true}))
        action()
        await done
      })
    }
    await act(async () => tab[1]("settings"))
    await act(async () => tab[1]("settings"))
    check(messages.at(-1).depth === 1, "StrictMode and repeated tabs create one history entry")
    await act(async () => modal[1](true))
    check(messages.at(-1).depth === 2, "nested dialog creates history")
    await pop(() => w.history.back())
    check(tab[0] === "settings" && !modal[0], "phone back dismisses dialog and preserves settings")
    await pop(() => w.history.back())
    check(tab[0] === "home" && messages.at(-1).depth === 0, "second back returns to root")
    await act(async () => modal[1](true))
    await pop(() => {
      modal[1](false)
      modal[1](false)
    })
    check(messages.at(-1).depth === 0, "explicit close consumes entry once")
    await act(async () => screen[1]("audio"))
    await act(async () => screen[1]("transcript"))
    await pop(() => screen[1]("list"))
    check(screen[0] === "list" && messages.at(-1).depth === 0, "finishing recording removes nested capture views")
    await act(async () => screen[1]("audio"))
    await pop(() => w.history.back())
    check(screen[0] === "list", "recording screen backs to list without invoking stop")
    await pop(() => w.history.forward())
    check(screen[0] === "audio", "forward restores page")
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
    Object.assign(globalThis, previousGlobals)
  }
})
