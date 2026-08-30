import * as Sentry from "@sentry/react-native"
import {FC, createContext, useContext, useEffect, useMemo, useState} from "react"

import {SETTINGS, useSetting} from "@mentra/engine"
import {
  createDeploymentAuthProvider,
  type DeploymentAuthProvider,
  type DeploymentAuthSession,
  useDeployment,
} from "@/services/deployment"
import {LogoutUtils} from "@/utils/LogoutUtils"
import mentraAuth from "@/utils/auth/authClient"
import {MentraAuthSession, MentraAuthUser} from "@/utils/auth/authProvider.types"
import {ensureDevModeForUser} from "@/utils/dev/devModeAllowlist"

interface AuthContextProps {
  user: MentraAuthUser | null
  session: MentraAuthSession | null
  loading: boolean
  logout: () => Promise<void>
  signInWorkspace: () => Promise<void>
}

const AuthContext = createContext<AuthContextProps>({
  user: null,
  session: null,
  loading: true,
  logout: async () => {},
  signInWorkspace: async () => {},
})

function toMentraSession(session: DeploymentAuthSession | null): MentraAuthSession | null {
  if (!session) return null
  const {identity} = session
  const id = `workspace:${identity.deploymentId}:${encodeURIComponent(identity.issuer)}:${identity.subject}`
  return {
    token: session.accessToken,
    user: {
      id,
      email: identity.email,
      name: identity.displayName ?? identity.email ?? identity.subject,
      provider: "microsoft-entra",
    },
  }
}

export const AuthProvider: FC<{children: React.ReactNode}> = ({children}) => {
  const [session, setSession] = useState<MentraAuthSession | null>(null)
  const [user, setUser] = useState<MentraAuthUser | null>(null)
  const [loading, setLoading] = useState(true)
  const [_authEmail, setAuthEmail] = useSetting(SETTINGS.auth_email.key)
  const {activeDeployment, store} = useDeployment()
  const workspaceAuth = useMemo<DeploymentAuthProvider | null>(
    () => (activeDeployment.kind === "workspace" ? createDeploymentAuthProvider(activeDeployment) : null),
    [activeDeployment],
  )

  useEffect(() => {
    let cancelled = false
    let unsubscribe: (() => void) | undefined
    setLoading(true)

    const applySession = (next: MentraAuthSession | null, allowTelemetry: boolean) => {
      if (cancelled) return
      setSession(next)
      setUser(next?.user ?? null)
      if (allowTelemetry) {
        Sentry.setUser({id: next?.user?.id, email: next?.user?.email})
      }
      if (next?.user?.email) {
        setAuthEmail(next.user.email)
        if (activeDeployment.kind === "consumer") {
          void ensureDevModeForUser(next.user.email)
        }
      }
      setLoading(false)
    }

    if (workspaceAuth && activeDeployment.kind === "workspace") {
      const allowTelemetry = activeDeployment.manifest.telemetry
      unsubscribe = workspaceAuth.onStateChange((next) => applySession(toMentraSession(next), allowTelemetry))
      void workspaceAuth
        .getSession()
        .then((next) => applySession(toMentraSession(next), allowTelemetry))
        .catch((error) => {
          console.warn("AuthContext: failed to restore workspace session", error)
          applySession(null, allowTelemetry)
        })
    } else {
      let authSubscription: {unsubscribe: () => void} | undefined

      void mentraAuth.getSession().then((res) => {
        if (res.is_error()) {
          console.error("AuthContext: Error getting initial session:", res.error)
          applySession(null, true)
          return
        }
        applySession(res.value, true)
      })

      void (async () => {
        const res = await mentraAuth.onAuthStateChange((event, next: MentraAuthSession) => {
          console.log(`AuthContext: auth state ${event}, session ${next ? "present" : "absent"}`)
          applySession(next, true)
        })
        if (res.is_error()) return
        const changeData = res.value as {
          unsubscribe?: () => void
          data?: {subscription?: {unsubscribe: () => void}}
        }
        authSubscription =
          changeData.data?.subscription ??
          (typeof changeData.unsubscribe === "function" ? {unsubscribe: changeData.unsubscribe} : undefined)
        if (cancelled) authSubscription?.unsubscribe()
      })()

      unsubscribe = () => authSubscription?.unsubscribe()
    }

    return () => {
      cancelled = true
      unsubscribe?.()
    }
  }, [activeDeployment, setAuthEmail, workspaceAuth])

  const signInWorkspace = async () => {
    if (!workspaceAuth) throw new Error("No organization workspace is active")
    setLoading(true)
    try {
      const next = toMentraSession(await workspaceAuth.signIn())
      setSession(next)
      setUser(next?.user ?? null)
      if (next?.user?.email) setAuthEmail(next.user.email)
    } finally {
      setLoading(false)
    }
  }

  const logout = async () => {
    console.log("AuthContext: Starting logout process")
    try {
      if (workspaceAuth && activeDeployment.kind === "workspace") {
        const deployment = activeDeployment
        await workspaceAuth.signOut()
        await LogoutUtils.performCompleteLogout({skipAuthSignOut: true})
        // Complete logout intentionally clears user settings and MMKV. Restore
        // only the selected deployment so another employee returns to the
        // organization's sign-in screen, never to the consumer login.
        store.activate({
          workspaceOrigin: deployment.workspaceOrigin,
          manifestUrl: deployment.manifestUrl,
          manifest: deployment.manifest,
        })
      } else {
        await LogoutUtils.performCompleteLogout()
        const logoutSuccessful = await LogoutUtils.verifyLogoutSuccess()
        if (!logoutSuccessful) console.warn("AuthContext: Logout verification failed, but continuing...")
      }
    } catch (error) {
      console.error("AuthContext: Error during logout:", error)
    } finally {
      setSession(null)
      setUser(null)
    }
  }

  return (
    <AuthContext.Provider value={{user, session, loading, logout, signInWorkspace}}>{children}</AuthContext.Provider>
  )
}

export function useAuth() {
  return useContext(AuthContext)
}
