import {useEffect, useRef, useState} from "react"

import type {Channels} from "../../shared/channels"

/**
 * useChannel — subscribe to a background-pushed channel and get the
 * latest payload as React state.
 *
 * The WebView's `mentra` global doesn't expose state; it's a
 * fire-and-forget bus. Components that want to *render* what background
 * pushed use this hook — it subscribes once on mount, holds the latest
 * payload in React state, and unsubscribes on unmount.
 *
 * On first render the hook returns `initial` (defaults to undefined).
 * Background usually pushes a `captions:snapshot` on `session.ui.onOpen`
 * which seeds all the per-field channels, so the "no data" window is
 * typically a frame or two.
 */
export function useChannel<C extends keyof Channels & string>(
  channel: C,
  initial?: Channels[C],
): Channels[C] | undefined {
  const [value, setValue] = useState<Channels[C] | undefined>(initial)
  // Hold `initial` in a ref so resetting on channel change doesn't make the
  // effect re-run on every render when callers pass an inline object literal.
  const initialRef = useRef(initial)
  useEffect(() => {
    // Switching channel re-subscribes; reset to the seed so a payload from
    // the previous channel can't render as if it belonged to the new one.
    setValue(initialRef.current)
    // `mentra.on` rejects RPC channels at the type level. This hook is
    // intentionally a thin pass-through over any channel name; the cast
    // tells TS to trust the runtime — non-broadcast channels just won't
    // receive a payload at runtime.
    return (mentra.on as (c: string, cb: (p: unknown) => void) => () => void)(
      channel,
      (payload) => setValue(payload as Channels[C]),
    )
  }, [channel])
  return value
}
