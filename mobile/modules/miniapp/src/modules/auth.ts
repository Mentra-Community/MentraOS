import type {MiniappSession, MiniappAuthState} from "../session"

export interface AuthFetchOptions extends RequestInit {
  /**
   * Minimum remaining token lifetime before using the current token. Defaults to
   * 30 seconds. If the token is absent or too close to expiry, the call waits
   * for the host's next auth update.
   */
  minTtlMs?: number
}

const DEFAULT_MIN_TTL_MS = 30_000

export class AuthModule {
  constructor(private readonly session: MiniappSession) {}

  get current(): MiniappAuthState | null {
    return this.session._getAuth()
  }

  get mentraUserId(): string | null {
    return this.current?.mentraUserId ?? null
  }

  get oemId(): string | null {
    return this.current?.oemId ?? null
  }

  async getToken(options: {minTtlMs?: number} = {}): Promise<string> {
    const auth = await this.session._waitForAuth(options.minTtlMs ?? DEFAULT_MIN_TTL_MS)
    return auth.token
  }

  async getAuthHeader(options: {minTtlMs?: number} = {}): Promise<string> {
    return `Bearer ${await this.getToken(options)}`
  }

  async fetch(input: RequestInfo | URL, init: AuthFetchOptions = {}): Promise<Response> {
    const {minTtlMs, ...requestInit} = init
    const token = await this.getToken({minTtlMs})
    const headers = new Headers(requestInit.headers)
    headers.set("Authorization", `Bearer ${token}`)
    return fetch(input, {...requestInit, headers})
  }

  onUpdate(handler: (auth: MiniappAuthState) => void): () => void {
    return this.session.on("auth", handler)
  }
}

