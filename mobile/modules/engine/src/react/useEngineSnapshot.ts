import {useEffect, useRef, useState} from "react"

export function useEngineSnapshot<T>(getSnapshot: () => T, subscribe: (onChange: () => void) => () => void): T {
  const getSnapshotRef = useRef(getSnapshot)
  const subscribeRef = useRef(subscribe)
  getSnapshotRef.current = getSnapshot
  subscribeRef.current = subscribe
  const [snapshot, setSnapshot] = useState(() => getSnapshot())

  useEffect(() => {
    setSnapshot(getSnapshotRef.current())
    return subscribeRef.current(() => setSnapshot(getSnapshotRef.current()))
  }, [])

  return snapshot
}
