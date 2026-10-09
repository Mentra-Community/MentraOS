import * as Sentry from "@sentry/react-native"
import {FC, createContext, useContext, useEffect, useMemo, useState} from "react"

import {SETTINGS, useSetting} from "@mentra/engine"
import {
  createDeploymentAuthProvider,
  type DeploymentAuthProvider,
  type DeploymentAuthSession,
  useDeployment,
} from "@/services/deployment"
import {clearDeploymentDebugOverrides} from "@/services/deployment/debugOverrides"
import {PERSISTED_USER_ID_PREFIX} from "@/services/deployment/legacyPersistedNames"
import {LogoutUtils} from "@/utils/LogoutUtils"
import {storage} from "@/utils/storage"
import mentraAuth from "@/utils/auth/authClient"
import {MentraAuthSession, MentraAuthUser} from "@/utils/auth/authProvider.types"
import {ensureDevModeForUser} from "@/utils/dev/devModeAllowlist"

interface AuthContextProps {
  user: MentraAuthUser | null
  session: MentraAuthSession | null
  loading: boolean
  logout: () => Promise<void>
  signInOrganization: () => Promise<void>
  leaveOrganization: (destination: "consumer" | "selector") => Promise<void>
}

// Native provider sign-out (MSAL) removes every cached account for the client
// id, so a sign-out still running from a previous organization visit must finish
// before a new interactive sign-in stores its account.
let pendingProviderCleanup: Promise<void> = Promise.resolve()

function queueProviderCleanup(provider: DeploymentAuthProvider): Promise<void> {
  const cleanup = pendingProviderCleanup.then(() =>
    provider.signOut().catch((error) => {
      console.warn("AuthContext: failed to clear organization provider account", error)
    }),
  )
  pendingProviderCleanup = cleanup
  return cleanup
}

const AuthContext = createContext<AuthContextProps>({
  user: null,
  session: null,
  loading: true,
  logout: async () => {},
  signInOrganization: async () => {},
  leaveOrganization: async () => {},
})

function toMentraSession(session: DeploymentAuthSession | null): MentraAuthSession | null {
  if (!session) return null
  const {identity} = session
  const id = `${PERSISTED_USER_ID_PREFIX}${identity.deploymentId}:${encodeURIComponent(identity.issuer)}:${identity.subject}`
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
  const {activeDeployment, selectionResolved, store} = useDeployment()
  const organizationAuth = useMemo<DeploymentAuthProvider | null>(
    () => (activeDeployment.kind === "organization" ? createDeploymentAuthProvider(activeDeployment) : null),
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
      Sentry.setUser(allowTelemetry && next?.user ? {id: next.user.id, email: next.user.email} : null)
      if (allowTelemetry && next?.user?.email) {
        setAuthEmail(next.user.email)
        if (activeDeployment.kind === "consumer") {
          void ensureDevModeForUser(next.user.email)
        }
      }
      setLoading(false)
    }

    if (activeDeployment.kind === "consumer" && !selectionResolved) {
      // A fresh install must not contact Mentra account services until the user
      // chooses the consumer path. Preserve seamless upgrades for already
      // signed-in consumers by recognizing their existing local token pair.
      const access = storage.load<string>("mentra.account.accessToken")
      const refresh = storage.load<string>("mentra.account.refreshToken")
      const hasExistingConsumerSession =
        (access.is_ok() && Boolean(access.value)) || (refresh.is_ok() && Boolean(refresh.value))
      if (hasExistingConsumerSession && !store.isSelectingOrganization()) {
        store.restoreConsumerSessionSelection()
      } else {
        applySession(null, false)
      }
    } else if (organizationAuth && activeDeployment.kind === "organization") {
      const allowTelemetry = activeDeployment.manifest.telemetry
      unsubscribe = organizationAuth.onStateChange((next) => applySession(toMentraSession(next), allowTelemetry))
      void organizationAuth
        .getSession()
        .then((next) => applySession(toMentraSession(next), allowTelemetry))
        .catch((error) => {
          console.warn("AuthContext: failed to restore organization session", error)
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
  }, [activeDeployment, selectionResolved, setAuthEmail, store, organizationAuth])

  const signInOrganization = async () => {
    if (!organizationAuth) throw new Error("No organization is active")
    setLoading(true)
    try {
      await pendingProviderCleanup
      const next = toMentraSession(await organizationAuth.signIn())
      setSession(next)
      setUser(next?.user ?? null)
      if (activeDeployment.kind === "consumer" && next?.user?.email) setAuthEmail(next.user.email)
    } finally {
      setLoading(false)
    }
  }

  const logout = async () => {
    console.log("AuthContext: Starting logout process")
    try {
      if (organizationAuth && activeDeployment.kind === "organization") {
        try {
          await LogoutUtils.performCompleteLogout({skipAuthSignOut: true})
          await queueProviderCleanup(organizationAuth)
        } finally {
          // Log out means leaving the organization, including its cached manifest.
          // A future same-organization account switch must be a separate action.
          await store.clearSelection()
        }
      } else {
        await LogoutUtils.performCompleteLogout()
        const logoutSuccessful = await LogoutUtils.verifyLogoutSuccess()
        if (!logoutSuccessful) console.warn("AuthContext: Logout verification failed, but continuing...")
      }
    } catch (error) {
      console.error("AuthContext: Error during logout:", error)
      throw error
    } finally {
      try {
        await clearDeploymentDebugOverrides()
      } finally {
        setSession(null)
        setUser(null)
      }
    }
  }

  const leaveOrganization = async (destination: "consumer" | "selector") => {
    const organizationAuthToClear = organizationAuth

    // Leaving the unauthenticated organization screen must never be blocked by
    // native provider cleanup. Organization activation and organization logout have
    // already performed the full local-data teardown; this path only removes
    // a possibly cached provider account and changes the deployment selection.
    // Switch immediately so a rejected or slow MSAL sign-out cannot trap the
    // user inside an organization they have not signed in to.
    if (destination === "consumer") await store.returnToMentra()
    else await store.clearSelection()
    setSession(null)
    setUser(null)
    Sentry.setUser(null)

    if (organizationAuthToClear) void queueProviderCleanup(organizationAuthToClear)
  }

  return (
    <AuthContext.Provider value={{user, session, loading, logout, signInOrganization, leaveOrganization}}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  return useContext(AuthContext)
}
