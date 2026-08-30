import {createContext, type PropsWithChildren, useCallback, useContext, useEffect, useState} from "react"

import {deploymentStore, type DeploymentStore} from "./store"
import type {ActiveDeployment, DeploymentCandidate} from "./types"

interface DeploymentContextValue {
  activeDeployment: ActiveDeployment
  candidate: DeploymentCandidate | null
  setCandidate: (candidate: DeploymentCandidate) => void
  clearCandidate: () => void
  store: DeploymentStore
}

const DeploymentContext = createContext<DeploymentContextValue | null>(null)

export function DeploymentProvider({children}: PropsWithChildren) {
  const [activeDeployment, setActiveDeployment] = useState(() => deploymentStore.getActive())
  const [candidate, setCandidateState] = useState<DeploymentCandidate | null>(null)

  useEffect(() => deploymentStore.subscribe(setActiveDeployment), [])

  const setCandidate = useCallback((next: DeploymentCandidate) => setCandidateState(next), [])
  const clearCandidate = useCallback(() => setCandidateState(null), [])

  return (
    <DeploymentContext.Provider
      value={{activeDeployment, candidate, setCandidate, clearCandidate, store: deploymentStore}}>
      {children}
    </DeploymentContext.Provider>
  )
}

export function useDeployment(): DeploymentContextValue {
  const value = useContext(DeploymentContext)
  if (!value) throw new Error("useDeployment must be used inside DeploymentProvider")
  return value
}
