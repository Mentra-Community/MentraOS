import {useCallback, useEffect, useRef, useState} from "react"

/** Browser-backed UI state: phone back restores the previous screen or dialog. */
export function useHistoryState<T>(key: string, initial: T): [T, (next: T) => void] {
  const initialRef = useRef(initial)
  const read = useCallback((): T => window.history.state?.miniappViews?.[key] ?? initialRef.current, [key])
  const [value, setValue] = useState<T>(read)
  const pendingBack = useRef(false)

  useEffect(() => {
    const onPop = () => {
      pendingBack.current = false
      setValue(read())
    }
    window.addEventListener("popstate", onPop)
    return () => window.removeEventListener("popstate", onPop)
  }, [read])

  const navigate = useCallback(
    (next: T) => {
      if (pendingBack.current) return
      const state = window.history.state ?? {}
      const current = read()
      if (Object.is(current, next)) return
      // Closing a dialog or returning to the previous tab consumes its entry.
      // Do not add another entry that would reopen it on the next back gesture.
      const trail: Array<{key: string; previous: unknown}> = state.miniappViewTrail ?? []
      for (let index = trail.length - 1; index >= 0 && trail[index].key === key; index--) {
        if (Object.is(trail[index].previous, next)) {
          pendingBack.current = true
          window.history.go(index - trail.length)
          return
        }
      }
      window.history.pushState(
        {
          ...state,
          miniappViews: {...state.miniappViews, [key]: next},
          miniappViewTrail: [...trail, {key, previous: current}],
        },
        "",
      )
      setValue(next)
    },
    [key, read],
  )

  return [value, navigate]
}
