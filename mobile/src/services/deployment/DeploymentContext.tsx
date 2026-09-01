import {createContext, type PropsWithChildren, useCallback, useContext, useEffect, useState} from "react"

import {deploymentStore, type DeploymentStore} from "./store"
import type {ActiveDeployment, DeploymentCandidate} from "./types"

interface DeploymentContextValue {
  activeDeployment: ActiveDeployment
  selectionResolved: boolean
  candidate: DeploymentCandidate | null
  setCandidate: (candidate: DeploymentCandidate) => void
  clearCandidate: () => void
  store: DeploymentStore
}

const DeploymentContext = createContext<DeploymentContextValue | null>(null)

export function DeploymentProvider({children}: PropsWithChildren) {
  const [activeDeployment, setActiveDeployment] = useState(() => deploymentStore.getActive())
  const [selectionResolved, setSelectionResolved] = useState(() => deploymentStore.isResolved())
  const [candidate, setCandidateState] = useState<DeploymentCandidate | null>(null)

  useEffect(
    () =>
      deploymentStore.subscribe((deployment, resolved) => {
        setActiveDeployment(deployment)
        setSelectionResolved(resolved)
      }),
    [],
  )

  const setCandidate = useCallback((next: DeploymentCandidate) => setCandidateState(next), [])
  const clearCandidate = useCallback(() => setCandidateState(null), [])

  return (
    <DeploymentContext.Provider
      value={{activeDeployment, selectionResolved, candidate, setCandidate, clearCandidate, store: deploymentStore}}>
      {children}
    </DeploymentContext.Provider>
  )
}

export function useDeployment(): DeploymentContextValue {
  const value = useContext(DeploymentContext)
  if (!value) throw new Error("useDeployment must be used inside DeploymentProvider")
  return value
}
