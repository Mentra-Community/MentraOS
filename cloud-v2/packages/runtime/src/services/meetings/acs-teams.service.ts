import {CommunicationIdentityClient, type CommunicationUserToken} from "@azure/communication-identity"

export const ACS_GUEST_TOKEN_EXPIRES_IN_MINUTES = 120
export const ACS_GUEST_MINT_LIMIT_PER_WINDOW = 12
export const ACS_GUEST_MINT_WINDOW_MS = 10 * 60 * 1000
export const ACS_GUEST_TOKEN_REUSE_MIN_REMAINING_MS = 15 * 60 * 1000
export const ACS_GUEST_STATE_IDLE_TTL_MS = 4 * 60 * 60 * 1000
export const ACS_GUEST_STATE_MAX_ENTRIES = 10_000
const ACS_GUEST_STATE_SWEEP_INTERVAL_MS = 5 * 60 * 1000
const ACS_GUEST_STATE_SWEEP_BATCH_SIZE = 25

export interface AcsIdentityClient {
  createUserAndToken(
    scopes: string[],
    options: {tokenExpiresInMinutes: number},
  ): Promise<Pick<CommunicationUserToken, "token" | "expiresOn" | "user">>
  getToken?(
    user: {communicationUserId: string},
    scopes: string[],
    options: {tokenExpiresInMinutes: number},
  ): Promise<Pick<CommunicationUserToken, "token" | "expiresOn">>
  deleteUser?(user: {communicationUserId: string}): Promise<void>
  getTokenForTeamsUser(input: {
    teamsUserAadToken: string
    clientId: string
    userObjectId: string
  }): Promise<{token: string; expiresOn: Date}>
}

export type AcsMeetingCredential =
  | {
      token: string
      expiresOn: string
      identityMode: "guest"
      acsUserId: string
      guestReason?: "teams-license-unavailable"
    }
  | {
      token: string
      expiresOn: string
      identityMode: "teams-user"
    }

interface GuestMintState {
  mints: number[]
  acsUserId?: string
  cached?: Extract<AcsMeetingCredential, {identityMode: "guest"}>
  inFlight?: Promise<Extract<AcsMeetingCredential, {identityMode: "guest"}>>
  cleanupInFlight?: Promise<void>
  lastAccessedAt: number
}

const guestMintState = new Map<string, GuestMintState>()
let lastGuestStateSweepAt = 0
let testClient: AcsIdentityClient | null = null

export class TeamsIdentityRejectedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "TeamsIdentityRejectedError"
  }
}

export class AcsCredentialError extends Error {
  constructor(
    message: string,
    readonly status: 429 | 502 | 503,
  ) {
    super(message)
    this.name = "AcsCredentialError"
  }
}

export interface TeamsSubject {
  token: string
  tenantId: string
  objectId: string
}

export function assertAcsTeamsConfigured(): void {
  if (!process.env.ACS_CONNECTION_STRING?.trim()) throw new Error("meetings service requires ACS_CONNECTION_STRING")
}

/**
 * Bind the opaque Microsoft token to our authenticated Runtime caller. ACS, the
 * token's resource server, validates it with the expected userObjectId/clientId.
 * Microsoft-owned access tokens are not necessarily readable JWTs:
 * https://learn.microsoft.com/entra/identity-platform/access-tokens#token-ownership
 */
export function bindTeamsSubject(token: string, expected: {tenantId: string; objectId: string}): TeamsSubject {
  const {tenantId} = teamsUserConfiguration()
  if (expected.tenantId !== tenantId || !expected.objectId)
    throw new TeamsIdentityRejectedError("Teams token subject does not match Runtime identity")
  return {token, tenantId, objectId: expected.objectId}
}

export async function exchangeAcsTeamsUserToken(
  subject: TeamsSubject,
): Promise<Extract<AcsMeetingCredential, {identityMode: "teams-user"}>> {
  const {tenantId, clientId} = teamsUserConfiguration()
  if (subject.tenantId !== tenantId || !subject.objectId)
    throw new TeamsIdentityRejectedError("Teams token subject does not match Runtime identity")
  const client = identityClient()
  let result
  try {
    // These trusted identifiers must never come from the request body or a decoded
    // access token. Microsoft validates both against its opaque token.
    result = await client.getTokenForTeamsUser({
      teamsUserAadToken: subject.token,
      clientId,
      userObjectId: subject.objectId,
    })
  } catch (error) {
    if (isTeamsLicenseUnavailable(error)) throw error
    const status = error && typeof error === "object" && "statusCode" in error ? error.statusCode : undefined
    if (status === 400 || status === 401 || status === 403)
      throw new TeamsIdentityRejectedError(
        "Microsoft could not verify your Teams account. Sign in again or contact your administrator",
      )
    if (status === 429) throw new AcsCredentialError("Microsoft Teams is busy; try again later", 429)
    // Azure errors can include the request (and its bearer). Never forward/log them.
    throw new AcsCredentialError("Teams identity provider unavailable", 502)
  }
  return {
    token: result.token,
    expiresOn: result.expiresOn.toISOString(),
    identityMode: "teams-user",
  }
}

/** Only Microsoft's explicit license rejection permits automatic guest joining. */
export function isTeamsLicenseUnavailable(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && "code" in error && error.code === "UserLicenseNotPresentForbidden"
  )
}

/** The subject identifiers must come from the authenticated Runtime user. */
export async function issueAcsTeamsCredential(
  subject: TeamsSubject,
  authenticatedUserId: string,
): Promise<AcsMeetingCredential> {
  try {
    return await exchangeAcsTeamsUserToken(subject)
  } catch (error) {
    if (!isTeamsLicenseUnavailable(error)) throw error
    return {...(await mintAcsGuestToken(authenticatedUserId)), guestReason: "teams-license-unavailable"}
  }
}

export async function mintAcsGuestToken(
  authenticatedUserId: string,
): Promise<Extract<AcsMeetingCredential, {identityMode: "guest"}>> {
  const now = Date.now()
  const state = await guestStateFor(authenticatedUserId, now)
  if (state.cached && Date.parse(state.cached.expiresOn) - now > ACS_GUEST_TOKEN_REUSE_MIN_REMAINING_MS) {
    return state.cached
  }
  if (state.inFlight) return state.inFlight

  const mint = mintGuestTokenForState(state, now)
  state.inFlight = mint
  try {
    return await mint
  } finally {
    if (state.inFlight === mint) state.inFlight = undefined
    state.lastAccessedAt = Date.now()
  }
}

async function mintGuestTokenForState(
  state: GuestMintState,
  now: number,
): Promise<Extract<AcsMeetingCredential, {identityMode: "guest"}>> {
  enforceGuestMintLimit(state, now)

  try {
    const client = identityClient()
    const options = {
      tokenExpiresInMinutes: ACS_GUEST_TOKEN_EXPIRES_IN_MINUTES,
    }
    let credential: Extract<AcsMeetingCredential, {identityMode: "guest"}>
    if (state.acsUserId && client.getToken) {
      const result = await client.getToken({communicationUserId: state.acsUserId}, ["voip"], options)
      credential = {
        token: result.token,
        expiresOn: result.expiresOn.toISOString(),
        identityMode: "guest",
        acsUserId: state.acsUserId,
      }
    } else {
      const result = await client.createUserAndToken(["voip"], options)
      credential = {
        token: result.token,
        expiresOn: result.expiresOn.toISOString(),
        identityMode: "guest",
        acsUserId: result.user.communicationUserId,
      }
    }
    state.acsUserId = credential.acsUserId
    state.cached = credential
    return credential
  } catch (error) {
    if (error instanceof AcsCredentialError) throw error
    // Only a confirmed missing ACS user invalidates the reusable identity.
    // Network, throttling, and provider failures must not rotate the caller to
    // a new communication user on the next retry.
    if (isMissingAcsUserError(error)) {
      state.acsUserId = undefined
      state.cached = undefined
    }
    throw new AcsCredentialError("Teams meeting provider unavailable", 502)
  }
}

export function resetAcsTeamsAuthCache(): void {
  guestMintState.clear()
  lastGuestStateSweepAt = 0
  testClient = null
}

/** Test-only observation for the bounded in-process guest state. */
export function getAcsGuestStateSizeForTests(): number {
  return guestMintState.size
}

/** Test-only seam for exercising both ACS identity operations without Azure. */
export function setAcsIdentityClientForTests(client: AcsIdentityClient | null): void {
  testClient = client
  guestMintState.clear()
  lastGuestStateSweepAt = 0
}

function identityClient(): AcsIdentityClient {
  assertAcsTeamsConfigured()
  return testClient ?? new CommunicationIdentityClient(process.env.ACS_CONNECTION_STRING!)
}

function teamsUserConfiguration(): {
  tenantId: string
  clientId: string
} {
  const tenantId = process.env.ENTRA_TENANT_ID?.trim()
  const clientId = process.env.ENTRA_CLIENT_ID?.trim()
  if (!tenantId || !clientId) {
    throw new AcsCredentialError("Microsoft Teams employee identity is not configured", 503)
  }
  return {tenantId, clientId}
}

async function guestStateFor(authenticatedUserId: string, now: number): Promise<GuestMintState> {
  let state = guestMintState.get(authenticatedUserId)
  if (state) {
    if (state.cleanupInFlight) {
      await state.cleanupInFlight
      return guestStateFor(authenticatedUserId, Date.now())
    }
    state.lastAccessedAt = now
    return state
  }

  pruneGuestMintState(now)
  if (guestMintState.size >= ACS_GUEST_STATE_MAX_ENTRIES) {
    const cleanup = [...guestMintState.values()].find(({cleanupInFlight}) => cleanupInFlight)?.cleanupInFlight
    if (cleanup) {
      await cleanup
      if (guestMintState.size >= ACS_GUEST_STATE_MAX_ENTRIES) {
        throw new AcsCredentialError("Teams credential service is temporarily at capacity", 503)
      }
      return guestStateFor(authenticatedUserId, Date.now())
    }
    throw new AcsCredentialError("Teams credential service is temporarily at capacity", 503)
  }

  state = {mints: [], lastAccessedAt: now}
  guestMintState.set(authenticatedUserId, state)
  return state
}

function pruneGuestMintState(now: number): void {
  if (
    now - lastGuestStateSweepAt >= ACS_GUEST_STATE_SWEEP_INTERVAL_MS ||
    guestMintState.size >= ACS_GUEST_STATE_MAX_ENTRIES
  ) {
    lastGuestStateSweepAt = now
    let started = 0
    for (const [userId, state] of guestMintState) {
      if (
        started < ACS_GUEST_STATE_SWEEP_BATCH_SIZE &&
        !state.inFlight &&
        !state.cleanupInFlight &&
        now - state.lastAccessedAt >= ACS_GUEST_STATE_IDLE_TTL_MS
      ) {
        startGuestStateCleanup(userId, state)
        started += 1
      }
    }
  }
}

function startGuestStateCleanup(userId: string, state: GuestMintState): void {
  const client = identityClient()
  if (state.acsUserId && !client.deleteUser) return
  const deletion = state.acsUserId
    ? Promise.resolve().then(() => client.deleteUser!({communicationUserId: state.acsUserId!}))
    : Promise.resolve()
  const cleanup = deletion
    .then(
      () => true,
      (error) => isMissingAcsUserError(error),
    )
    .then((identityIsGone) => {
      if (
        identityIsGone &&
        guestMintState.get(userId) === state &&
        state.cleanupInFlight === cleanup &&
        !state.inFlight
      ) {
        guestMintState.delete(userId)
      }
    })
    .finally(() => {
      // Retain the mapping when ACS cleanup fails transiently so we never lose
      // track of a persistent identity and create an orphan on the next request.
      if (guestMintState.get(userId) === state && state.cleanupInFlight === cleanup) {
        state.cleanupInFlight = undefined
      }
    })
  state.cleanupInFlight = cleanup
}

function isMissingAcsUserError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false
  const candidate = error as {
    status?: unknown
    statusCode?: unknown
    code?: unknown
  }
  return (
    candidate.status === 404 ||
    candidate.statusCode === 404 ||
    candidate.code === "ResourceNotFound" ||
    candidate.code === "UserNotFound" ||
    candidate.code === "IdentityNotFound"
  )
}

function enforceGuestMintLimit(state: GuestMintState, now: number): void {
  state.mints = state.mints.filter((mintedAt) => now - mintedAt < ACS_GUEST_MINT_WINDOW_MS)
  if (state.mints.length >= ACS_GUEST_MINT_LIMIT_PER_WINDOW) {
    throw new AcsCredentialError("Too many Teams credential requests. Try again in a few minutes.", 429)
  }
  state.mints.push(now)
}
