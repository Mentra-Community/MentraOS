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

// Lets feature-level popstate handlers (e.g. LocationSearch's
// back-to-close-drawer) tell the router "I just consumed this back
// press — don't pop the route stack." Set this from a capture-phase
// popstate listener; the router's bubble-phase listener checks and
// clears it before deciding whether to mutate the stack.
let suppressNextRouterPop = false
export function suppressNextRouterPopOnce(): void {
  suppressNextRouterPop = true
}

type RouterContextValue = {
  route: Route
  push: (r: Route) => void
  pop: () => void
}

const RouterContext = createContext<RouterContextValue | null>(null)

export function RouterProvider({children}: {children: ReactNode}) {
  const [stack, setStack] = useState<Route[]>([{name: "navigation"}])
  const route = stack[stack.length - 1]

  // Seed the History API cursor on first mount. Replace (not push) so
  // we don't add a phantom entry at depth 0. Side-effects belong in
  // useEffect, NOT in useState's initialiser — initialisers can run
  // multiple times in StrictMode + concurrent rendering, which would
  // fire replaceState repeatedly and could race with later pushes.
  useEffect(() => {
    try {
      history.replaceState({route: "navigation"}, "")
    } catch {
      /* no-op: WebView may not allow replaceState in some sandboxes */
    }
  }, [])

  const push = useCallback((r: Route) => {
    // history.pushState MUST run outside the setState updater. React
    // calls the updater multiple times in StrictMode + concurrent
    // rendering, and side-effecting inside the updater would push
    // multiple history entries — each with its own WKWebView snapshot.
    // The second snapshot can capture AddPlace mid-mount instead of the
    // home map, breaking the back-swipe preview. Mutating history
    // before the state change also means WKWebView captures the
    // *current* viewport (home) as the snapshot for the entry we're
    // leaving — which is exactly what we want to see on swipe-back.
    try {
      history.pushState({route: r.name}, "")
    } catch {
      /* no-op: WebView may not allow pushState in some sandboxes */
    }
    setStack((s) => [...s, r])
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
      if (suppressNextRouterPop) {
        suppressNextRouterPop = false
        return
      }
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
