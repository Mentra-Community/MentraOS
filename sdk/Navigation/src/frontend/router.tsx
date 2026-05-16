/**
 * Minimal stack router backed by the browser History API.
 * Pushing a route adds a history entry so the iOS WebView swipe-back
 * gesture (which fires popstate) naturally pops back to the previous page.
 */

import {type ReactNode, createContext, useCallback, useContext, useEffect, useRef, useState} from "react"

export type Route =
  | {name: "navigation"}
  | {name: "add-place"; presetType?: "home" | "work"}

type RouterContextValue = {
  route: Route
  push: (r: Route) => void
  pop: () => void
}

const RouterContext = createContext<RouterContextValue | null>(null)

export function RouterProvider({children}: {children: ReactNode}) {
  const [stack, setStack] = useState<Route[]>([{name: "navigation"}])
  const route = stack[stack.length - 1]

  // Keep a ref so the popstate handler always sees the latest stack length
  const stackLen = useRef(stack.length)
  stackLen.current = stack.length

  const push = useCallback((r: Route) => {
    history.pushState({route: r.name}, "")
    setStack((s) => [...s, r])
  }, [])

  const pop = useCallback(() => {
    setStack((s) => (s.length > 1 ? s.slice(0, -1) : s))
  }, [])

  // iOS swipe-back fires popstate — treat it as a pop
  useEffect(() => {
    function onPopState() {
      if (stackLen.current > 1) {
        setStack((s) => (s.length > 1 ? s.slice(0, -1) : s))
      }
    }
    window.addEventListener("popstate", onPopState)
    return () => window.removeEventListener("popstate", onPopState)
  }, [])

  return (
    <RouterContext.Provider value={{route, push, pop}}>
      {children}
    </RouterContext.Provider>
  )
}

export function useRouter() {
  const ctx = useContext(RouterContext)
  if (!ctx) throw new Error("useRouter must be used inside RouterProvider")
  return ctx
}
