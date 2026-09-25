/**
 * useHistoryState against a session history that behaves like a WebView's:
 * pushState is synchronous, while back/forward/go land in a later task and
 * fire popstate. happy-dom provides the DOM; its own history never fires popstate.
 */

import {afterEach, beforeEach, expect, test} from "bun:test"
import {Window} from "happy-dom"
import {act, StrictMode} from "react"
import {createRoot, type Root} from "react-dom/client"

import {useHistoryState, type SetHistoryState} from "./useHistoryState"

type Hook<T> = [T, SetHistoryState<T>]

class SessionHistory {
  private entries: unknown[] = [null]
  index = 0

  constructor(private readonly window: Window) {}

  get state(): unknown {
    return this.entries[this.index]
  }

  pushState(state: unknown) {
    this.entries.splice(this.index + 1, Infinity, structuredClone(state))
    this.index++
  }

  replaceState(state: unknown) {
    this.entries[this.index] = structuredClone(state)
  }

  back() {
    this.go(-1)
  }

  forward() {
    this.go(1)
  }

  go(delta: number) {
    setTimeout(() => {
      const target = this.index + delta
      if (delta === 0 || target < 0 || target >= this.entries.length) return
      this.index = target
      // The hook reads history.state, not event.state.
      this.window.dispatchEvent(new this.window.Event("popstate"))
    }, 0)
  }
}

let window: Window
let history: SessionHistory
let root: Root
let tab: Hook<string>, dialog: Hook<boolean>, screen: Hook<string>
const saved = {
  window: globalThis.window,
  document: globalThis.document,
  IS_REACT_ACT_ENVIRONMENT: (globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT,
}

function App() {
  tab = useHistoryState("tab", "home")
  dialog = useHistoryState("dialog", false)
  screen = useHistoryState("screen", "list")
  return null
}

async function render() {
  await act(async () =>
    root.render(
      <StrictMode>
        <App />
      </StrictMode>,
    ),
  )
}

/** Run `action` and wait until the history traversal it starts has landed. */
async function traverse(action: () => void) {
  await act(async () => {
    const landed = new Promise((resolve) => window.addEventListener("popstate", resolve, {once: true}))
    action()
    await landed
    await new Promise((resolve) => setTimeout(resolve, 10))
  })
}

beforeEach(async () => {
  window = new Window({url: "file:///miniapp/index.html"})
  history = new SessionHistory(window)
  Object.defineProperty(window, "history", {value: history, configurable: true})
  Object.assign(globalThis, {window, document: window.document, IS_REACT_ACT_ENVIRONMENT: true})
  root = createRoot(window.document.body as unknown as HTMLElement)
  await render()
})

afterEach(async () => {
  await act(async () => root.unmount())
  await window.happyDOM.close()
  Object.assign(globalThis, saved)
})

test("each change is one entry that back undoes and forward redoes", async () => {
  await act(async () => tab[1]("settings"))
  await act(async () => tab[1]("settings"))
  expect(history.index).toBe(1)
  await act(async () => screen[1]((previous) => `${previous}-detail`))
  expect(screen[0]).toBe("list-detail")
  expect(history.index).toBe(2)

  await traverse(() => history.back())
  expect([tab[0], screen[0], history.index]).toEqual(["settings", "list", 1])
  await traverse(() => history.back())
  expect([tab[0], history.index]).toEqual(["home", 0])
  await traverse(() => history.forward())
  expect(tab[0]).toBe("settings")
})

test("closing with the app's own control consumes the entry once", async () => {
  await act(async () => tab[1]("settings"))
  await act(async () => dialog[1](true))
  expect(history.index).toBe(2)

  await traverse(() => {
    dialog[1](false)
    dialog[1](false)
  })
  expect([dialog[0], tab[0], history.index]).toEqual([false, "settings", 1])
})

test("reverting to an earlier value pops every entry since it", async () => {
  await act(async () => screen[1]("audio"))
  await act(async () => screen[1]("transcript"))
  expect(history.index).toBe(2)

  await traverse(() => screen[1]("list"))
  expect([screen[0], history.index]).toEqual(["list", 0])
})

test("a change made while going back waits for the traversal", async () => {
  await act(async () => dialog[1](true))
  await traverse(() => {
    dialog[1](false)
    screen[1]("audio")
  })
  expect([dialog[0], screen[0], history.index]).toEqual([false, "audio", 1])

  await traverse(() => history.back())
  expect([dialog[0], screen[0], history.index]).toEqual([false, "list", 0])
})

test("keeps other history state fields and restores values on remount", async () => {
  history.replaceState({idx: 0})
  await act(async () => tab[1]("settings"))
  expect(history.state).toMatchObject({idx: 0})

  await act(async () => root.unmount())
  root = createRoot(window.document.body as unknown as HTMLElement)
  await render()
  expect(tab[0]).toBe("settings")
})
