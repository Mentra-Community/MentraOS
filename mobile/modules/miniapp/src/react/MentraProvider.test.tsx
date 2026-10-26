/**
 * MentraProvider's ready signal: the host lifts its splash and the background
 * opens the UI when `mentra.ready()` lands, so it must come after the app's
 * own mount effects have subscribed.
 */

import {afterEach, beforeEach, expect, test} from "bun:test"
import {Window} from "happy-dom"
import {act, type ReactElement, StrictMode, useEffect} from "react"
import {createRoot, type Root} from "react-dom/client"

import {MentraProvider} from "./MentraProvider"

let window: Window
let root: Root
let calls: string[]
const saved = {
  window: globalThis.window,
  document: globalThis.document,
  IS_REACT_ACT_ENVIRONMENT: (globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT,
}

function App() {
  useEffect(() => {
    calls.push("on")
  }, [])
  return null
}

async function render(element: ReactElement) {
  await act(async () => root.render(<StrictMode>{element}</StrictMode>))
}

beforeEach(() => {
  calls = []
  window = new Window({url: "https://com.mentra.test.miniapp.invalid/ui/index.html"})
  Object.assign(window, {mentra: {ready: () => calls.push("ready")}})
  Object.assign(globalThis, {window, document: window.document, IS_REACT_ACT_ENVIRONMENT: true})
  root = createRoot(window.document.body as unknown as HTMLElement)
})

afterEach(async () => {
  await act(async () => root.unmount())
  await window.happyDOM.close()
  Object.assign(globalThis, saved)
})

test("signals ready after the app's mount effects have run", async () => {
  await render(
    <MentraProvider>
      <App />
    </MentraProvider>,
  )
  expect(calls[0]).toBe("on")
  expect(calls).toContain("ready")
  expect(calls.indexOf("ready")).toBeGreaterThan(calls.indexOf("on"))
})

test("leaves ready to the app when autoReady is off", async () => {
  await render(
    <MentraProvider autoReady={false}>
      <App />
    </MentraProvider>,
  )
  expect(calls).not.toContain("ready")
})

test("renders outside a miniapp WebView, where there is no mentra global", async () => {
  delete (window as unknown as {mentra?: unknown}).mentra
  await render(
    <MentraProvider>
      <App />
    </MentraProvider>,
  )
  expect(calls).toEqual(["on", "on"])
})
