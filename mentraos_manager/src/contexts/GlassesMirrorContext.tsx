// GlassesMirrorContext.tsx
import React, {createContext, useContext, useState, useEffect, useCallback} from "react"
import GlobalEventEmitter from "@/utils/GlobalEventEmitter"
import {MOCK_CONNECTION} from "@/consts"

interface IGlassesMirrorContext {
  events: any[]
  clearEvents: () => void
}

const GlassesMirrorContext = createContext<IGlassesMirrorContext>({
  events: [],
  clearEvents: () => {},
})

export const GlassesMirrorProvider: React.FC<{children: React.ReactNode}> = ({children}) => {
  const [events, setEvents] = useState<any[]>([])

  // 1) Attach the listener here in the provider. This provider
  //    lives at the top-level, so it’s always mounted.
  useEffect(() => {
    const handleGlassesDisplayEvent = (event: any) => {
      // console.log('Global Listener: GOT A GLASSES DISPLAY EVENT', event);
      //     setEvents(prev => [...prev, event]);
      setEvents([event])
    }

    if (!MOCK_CONNECTION) {
      GlobalEventEmitter.on("GLASSES_DISPLAY_EVENT", handleGlassesDisplayEvent)
    }

    return () => {
      if (!MOCK_CONNECTION) {
        GlobalEventEmitter.removeListener("GLASSES_DISPLAY_EVENT", handleGlassesDisplayEvent)
      }
    }
  }, [])

  // 2) Provide a way to clear events, if desired
  const clearEvents = useCallback(() => {
    setEvents([])
  }, [])

  return <GlassesMirrorContext.Provider value={{events, clearEvents}}>{children}</GlassesMirrorContext.Provider>
}

export const useGlassesMirror = () => useContext(GlassesMirrorContext)
