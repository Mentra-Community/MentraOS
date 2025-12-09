import {createContext, ReactNode, useCallback, useContext, useEffect, useState} from "react"

import {INTENSE_LOGGING} from "@/utils/Constants"
import {CoreStatus, CoreStatusParser} from "@/utils/CoreStatusParser"
import GlobalEventEmitter from "@/utils/GlobalEventEmitter"
import {deepCompare} from "@/utils/debug/debugging"

interface CoreStatusContextType {
  status: CoreStatus
  refreshStatus: (data: any) => void
}

const CoreStatusContext = createContext<CoreStatusContextType | undefined>(undefined)

export const CoreStatusProvider = ({children}: {children: ReactNode}) => {
  const [status, setStatus] = useState<CoreStatus>(() => {
    return CoreStatusParser.parseStatus({})
  })

  const refreshStatus = useCallback((data: any) => {
    if (!(data && "core_status" in data)) {
      return
    }

    const parsedStatus = CoreStatusParser.parseStatus(data)
    if (INTENSE_LOGGING) console.log("CoreStatus: status:", parsedStatus)

    // only update the status if diff > 0
    setStatus(prevStatus => {
      const diff = deepCompare(prevStatus, parsedStatus)
      if (diff.length === 0) {
        console.log("CoreStatus: Status did not change")
        return prevStatus // don't re-render
      }

      console.log("CoreStatus: Status changed:", diff)
      return parsedStatus
    })
  }, [])

  useEffect(() => {
    const handleCoreStatusUpdate = (data: any) => {
      if (INTENSE_LOGGING) console.log("Handling received data.. refreshing status..")
      refreshStatus(data)
    }

    GlobalEventEmitter.on("CORE_STATUS_UPDATE", handleCoreStatusUpdate)

    return () => {
      GlobalEventEmitter.removeListener("CORE_STATUS_UPDATE", handleCoreStatusUpdate)
    }
  }, [])

  return (
    <CoreStatusContext.Provider
      value={{
        status,
        refreshStatus,
      }}>
      {children}
    </CoreStatusContext.Provider>
  )
}

export const useCoreStatus = () => {
  const context = useContext(CoreStatusContext)
  if (!context) {
    throw new Error("useStatus must be used within a StatusProvider")
  }
  return context
}
