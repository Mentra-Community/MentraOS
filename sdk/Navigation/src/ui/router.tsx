/**
 * Minimal stack router backed by the browser History API.
 *
 * History API is the SINGLE source of truth. push() calls
 * history.pushState; pop() calls history.back(). React stack state is
 * mutated only by the popstate handler. This avoids the double-animation
 * race where (a) the iOS WKWebView native back-swipe gesture fires
 * popstate AND animates the WebView slide AND (b) a programmatic
 * setStack() simultaneously runs motion's exit animation — the user
 * sees AddPlace slide off twice.
 *
 * The host wraps this WebView with `allowsBackForwardNavigationGestures
 * = webViewCanGoBack`, so when our stack has >1 entry the native iOS
 * edge-swipe is enabled and drives the back action via popstate. When
 * the stack has 1 entry the host disables the WebView gesture and
 * enables React Navigation's route-level swipe — so swiping from the
 * root takes the user out of the mini app.
 */

import {type ReactNode, createContext, useCallback, useContext, useEffect, useState} from "react"

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
  // Seed the stack with the initial route AND replace the current
  // history entry so the bottom of the stack matches the cursor.
  // Without replaceState the first push() would land us at history
  // index 1 with a phantom index 0, and the first swipe back would
  // pop to that phantom entry instead of exiting the miniapp.
  const [stack, setStack] = useState<Route[]>(() => {
    try {
      history.replaceState({routerStackDepth: 1}, "")
    } catch {
      /* no-op: WebView may not allow replaceState in some sandboxes */
    }
    return [{name: "navigation"}]
  })
  const route = stack[stack.length - 1]

  const push = useCallback((r: Route) => {
    setStack((s) => {
      const next = [...s, r]
      try {
        history.pushState({routerStackDepth: next.length}, "")
      } catch {
        /* no-op */
      }
      return next
    })
  }, [])

  // Programmatic pop just drives history.back(). The popstate handler
  // does the React state mutation, so there is exactly one code path
  // that changes `stack` regardless of whether the user swiped or we
  // called pop() ourselves.
  const pop = useCallback(() => {
    try {
      history.back()
    } catch {
      // Safety net: still pop the React stack if history.back somehow
      // fails. Better to leave the user one frame inconsistent than
      // stranded on the wrong page.
      setStack((s) => (s.length > 1 ? s.slice(0, -1) : s))
    }
  }, [])

  // popstate fires on:
  //   - iOS WKWebView's native back-swipe (when allowsBackForwardNavigationGestures is on)
  //   - Android hardware back if mapped
  //   - our own pop() via history.back()
  // All three converge here. We trim one frame off the React stack to
  // match the new history cursor.
  useEffect(() => {
    function onPopState() {
      setStack((s) => (s.length > 1 ? s.slice(0, -1) : s))
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
