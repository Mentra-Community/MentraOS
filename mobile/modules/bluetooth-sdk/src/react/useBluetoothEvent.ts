import {useEffect, useRef} from "react"

import BluetoothSdk from "../index"
import type {
  BluetoothSdkEventListener,
  BluetoothSdkEventName,
} from "../BluetoothSdk.types"

export type UseBluetoothEventOptions = {
  enabled?: boolean
}

export function useBluetoothEvent<EventName extends BluetoothSdkEventName>(
  eventName: EventName,
  listener: BluetoothSdkEventListener<EventName>,
  options: UseBluetoothEventOptions = {},
): void {
  const enabled = options.enabled ?? true
  const listenerRef = useRef(listener)

  useEffect(() => {
    listenerRef.current = listener
  }, [listener])

  useEffect(() => {
    if (!enabled) {
      return undefined
    }

    const subscription = BluetoothSdk.addListener(eventName, (event) => {
      listenerRef.current(event)
    })

    return () => {
      subscription.remove()
    }
  }, [enabled, eventName])
}
