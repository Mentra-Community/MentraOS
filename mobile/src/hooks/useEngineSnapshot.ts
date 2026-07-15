import {useEffect, useRef, useState} from "react"

/**
 * Subscribe a component to an engine read-model: `getSnapshot` reads the current
 * projection, `subscribe` wires the matching `onX` engine subscription.
 *
 * The subscription is established ONCE on mount — `subscribe` must target the
 * same engine surface for the component's lifetime (every call site passes a
 * fixed `engine.*.onX`). The refs keep the *callbacks* fresh across renders,
 * but an identity change of `subscribe` is deliberately ignored; a
 * prop-dependent subscription would need `subscribe` in the effect deps and a
 * `useCallback` at the call site instead.
 */
export function useEngineSnapshot<T>(getSnapshot: () => T, subscribe: (onChange: () => void) => () => void): T {
  const getSnapshotRef = useRef(getSnapshot)
  const subscribeRef = useRef(subscribe)
  getSnapshotRef.current = getSnapshot
  subscribeRef.current = subscribe

  const [snapshot, setSnapshot] = useState(() => getSnapshot())

  useEffect(() => {
    setSnapshot(getSnapshotRef.current())
    return subscribeRef.current(() => {
      setSnapshot(getSnapshotRef.current())
    })
  }, [])

  return snapshot
}
