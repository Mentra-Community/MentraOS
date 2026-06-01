import {useEffect, useState} from "react"

import type {Channels} from "../../shared/channels"

/**
 * useChannel — subscribe to a broadcast channel and get the latest
 * payload as React state. Returns `undefined` until the first push.
 */
export function useChannel<C extends keyof Channels & string>(
  channel: C,
  initial?: Channels[C],
): Channels[C] | undefined {
  const [value, setValue] = useState<Channels[C] | undefined>(initial)
  useEffect(() => {
    // The mentra global's narrow typing rejects RPC channels for `on`.
    // useChannel is a generic helper used by viewers of broadcast
    // channels. The cast bridges the typed surface to the runtime where
    // the channel registry is fully known. Real safety comes from the
    // `keyof Channels & string` constraint at the call site.
    return (mentra.on as unknown as (
      c: string,
      cb: (p: unknown) => void,
    ) => () => void)(channel, (payload) => setValue(payload as Channels[C]))
  }, [channel])
  return value
}
