export interface LocalMiniappUserIdentityBackend {
  get(): string | null
  set(userId: string): void
  remove(): void
}

/**
 * Keeps the stable Mentra user id available to local miniapps across process
 * restarts. The id is non-secret and is deliberately stored separately from
 * the short-lived Core access token.
 */
export class LocalMiniappUserIdentity {
  private current: string | null = null

  constructor(private readonly backend: LocalMiniappUserIdentityBackend) {}

  async resolve(resolveOnline: () => Promise<string>): Promise<string> {
    const available = this.get()
    if (available) return available

    const resolved = (await resolveOnline()).trim()
    if (!resolved) throw new Error("Mentra user identity is unavailable")
    this.remember(resolved)
    return resolved
  }

  get(): string | null {
    if (this.current) return this.current
    const cached = this.backend.get()?.trim() ?? ""
    if (!cached) return null
    this.current = cached
    return cached
  }

  remember(userId: string): void {
    const resolved = userId.trim()
    if (!resolved) throw new Error("Mentra user identity is unavailable")
    this.backend.set(resolved)
    this.current = resolved
  }

  forget(): void {
    this.current = null
    this.backend.remove()
  }
}
