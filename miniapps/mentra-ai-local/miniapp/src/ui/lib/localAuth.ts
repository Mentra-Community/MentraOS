/**
 * Local auth shim — drop-in replacement for @mentra/react's useMentraAuth.
 *
 * The cloud app authenticated the webview against a server. The local miniapp
 * has no server and exactly one user, so there's nothing to authenticate:
 * this hook reports an always-ready, always-authenticated single user. The
 * `frontendToken` is unused (settings now go over the channel RPC, not HTTP),
 * but kept in the shape so the copied components compile unchanged.
 */

export interface MentraAuth {
  userId: string | null
  frontendToken: string | null
  isLoading: boolean
  error: string | null
  isAuthenticated: boolean
}

const LOCAL_AUTH: MentraAuth = {
  userId: "local-user",
  frontendToken: null,
  isLoading: false,
  error: null,
  isAuthenticated: true,
}

export function useMentraAuth(): MentraAuth {
  return LOCAL_AUTH
}
