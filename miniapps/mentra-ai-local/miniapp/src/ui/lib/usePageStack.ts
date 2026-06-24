import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Minimal stack navigation backed by the browser History API, so the OS back
 * gesture (iOS edge-swipe / Android back) respects our in-app pages.
 *
 * Why History API as the single source of truth: the miniapp host
 * (LocalMiniappView) wires the WebView's native back gesture to its
 * `canGoBack` — i.e. when our history depth is > 1 the OS back-swipe is
 * enabled and pops a page; when depth is 1 (root) the gesture instead exits
 * the mini app. We only have to push/pop browser history and the host does the
 * rest. React state is mutated ONLY by the popstate handler, so the OS gesture
 * and our own back() converge on one code path (no double-animation race).
 *
 * Modeled on the Navigation miniapp's router (src/ui/router.tsx).
 *
 * @param root The base page that can never be popped (back from it exits the app).
 */
export function usePageStack<T extends string>(root: T) {
  const [stack, setStack] = useState<T[]>([root]);
  const page = stack[stack.length - 1];
  // Current page depth (0 = root), kept in a ref so push() can compute the next
  // depth and call history.pushState OUTSIDE the setState updater. Side effects
  // inside a React state updater run twice under StrictMode/concurrent
  // rendering, which would push duplicate history entries and make a single
  // back() only undo one of them ("back needs N clicks").
  const depthRef = useRef(0);

  // Seed the history cursor once with this stack's depth tag (0 = root).
  // replaceState (not push) so we don't add a phantom entry at depth 0. In an
  // effect, not useState's initialiser, which can run multiple times under
  // StrictMode/concurrent rendering.
  useEffect(() => {
    try {
      history.replaceState({ pageStackDepth: 0, page: root }, '');
    } catch {
      /* WebView may disallow replaceState in some sandboxes */
    }
    // root is stable for the life of the component; run once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Push a new page: stamp the new history entry with its depth so popstate can
  // reconcile to it. history.pushState runs EXACTLY ONCE here (outside the
  // state updater) — depth comes from the ref, not the updater's draft state.
  const push = useCallback((next: T) => {
    const depth = depthRef.current + 1;
    depthRef.current = depth;
    try {
      history.pushState({ pageStackDepth: depth, page: next }, '');
    } catch {
      /* no-op */
    }
    setStack((s) => [...s, next]);
  }, []);

  // Programmatic back just drives history.back(); the popstate handler does the
  // actual React state change, matching the OS-gesture path exactly.
  const back = useCallback(() => {
    try {
      history.back();
    } catch {
      setStack((s) => (s.length > 1 ? s.slice(0, -1) : s));
    }
  }, []);

  // popstate fires for: iOS back-swipe, Android back, our own back(), AND any
  // OTHER layer's history juggling (e.g. a bottom sheet that pushes a throwaway
  // entry and pops it on close). To avoid reacting to entries that aren't ours,
  // we RECONCILE the React stack to the depth tagged on the current history
  // entry instead of blindly trimming a frame. A sheet's entry carries no
  // `pageStackDepth` (or the same one as the page beneath it), so landing back
  // on the page entry is idempotent — no spurious page pop.
  useEffect(() => {
    const onPopState = (e: PopStateEvent) => {
      const depth = (e.state as { pageStackDepth?: number } | null)?.pageStackDepth;
      if (typeof depth !== 'number') return; // not one of our entries — ignore
      depthRef.current = depth;
      setStack((s) => {
        const targetLen = depth + 1;
        if (targetLen >= s.length || targetLen < 1) return s;
        return s.slice(0, targetLen);
      });
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  return { page, push, back };
}
