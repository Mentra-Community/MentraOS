import {
  CommunicationIdentityClient,
  type CommunicationUserToken,
} from "@azure/communication-identity";
import * as jose from "jose";

const REQUIRED_TEAMS_SCOPES = new Set([
  "Teams.ManageCalls",
  "Teams.ManageChats",
]);
export const ACS_GUEST_TOKEN_EXPIRES_IN_MINUTES = 120;
export const ACS_GUEST_MINT_LIMIT_PER_WINDOW = 12;
export const ACS_GUEST_MINT_WINDOW_MS = 10 * 60 * 1000;
export const ACS_GUEST_TOKEN_REUSE_MIN_REMAINING_MS = 15 * 60 * 1000;
let microsoftJwks: ReturnType<typeof jose.createRemoteJWKSet> | undefined;

export interface AcsIdentityClient {
  createUserAndToken(
    scopes: string[],
    options: { tokenExpiresInMinutes: number },
  ): Promise<Pick<CommunicationUserToken, "token" | "expiresOn" | "user">>;
  getToken?(
    user: { communicationUserId: string },
    scopes: string[],
    options: { tokenExpiresInMinutes: number },
  ): Promise<Pick<CommunicationUserToken, "token" | "expiresOn">>;
  getTokenForTeamsUser(input: {
    teamsUserAadToken: string;
    clientId: string;
    userObjectId: string;
  }): Promise<{ token: string; expiresOn: Date }>;
}

export type AcsMeetingCredential =
  | {
      token: string;
      expiresOn: string;
      identityMode: "guest";
      acsUserId: string;
    }
  | {
      token: string;
      expiresOn: string;
      identityMode: "teams-user";
    };

interface GuestMintState {
  mints: number[];
  acsUserId?: string;
  cached?: Extract<AcsMeetingCredential, { identityMode: "guest" }>;
}

const guestMintState = new Map<string, GuestMintState>();
let testClient: AcsIdentityClient | null = null;

export class TeamsIdentityRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TeamsIdentityRejectedError";
  }
}

export class AcsCredentialError extends Error {
  constructor(
    message: string,
    readonly status: 429 | 502 | 503,
  ) {
    super(message);
    this.name = "AcsCredentialError";
  }
}

export interface VerifiedTeamsSubject {
  token: string;
  tenantId: string;
  objectId: string;
}

export function assertAcsTeamsConfigured(): void {
  if (!process.env.ACS_CONNECTION_STRING?.trim())
    throw new Error("meetings service requires ACS_CONNECTION_STRING");
}

export async function verifyTeamsSubjectToken(
  token: string,
  expected: { tenantId: string; objectId: string },
): Promise<VerifiedTeamsSubject> {
  const { tenantId, clientId } = teamsUserConfiguration();
  if (expected.tenantId !== tenantId)
    throw new TeamsIdentityRejectedError(
      "Teams token tenant does not match Runtime identity",
    );

  microsoftJwks ??= jose.createRemoteJWKSet(
    new URL(
      `https://login.microsoftonline.com/${tenantId}/discovery/v2.0/keys`,
    ),
  );
  const issuers = [
    `https://login.microsoftonline.com/${tenantId}/v2.0`,
    `https://sts.windows.net/${tenantId}/`,
  ];
  let payload: jose.JWTPayload;
  try {
    ({ payload } = await jose.jwtVerify(token, microsoftJwks, {
      issuer: issuers,
      audience:
        process.env.ENTRA_TEAMS_TOKEN_AUDIENCE ??
        "https://auth.msft.communication.azure.com",
      algorithms: ["RS256"],
      clockTolerance: "2 minutes",
    }));
  } catch (error) {
    // Signature/claim/key mismatches are credential rejection. Network and
    // JWKS timeouts remain provider outages so the API can return a 5xx.
    if (
      error instanceof jose.errors.JOSEError &&
      error.code !== "ERR_JWKS_TIMEOUT"
    ) {
      throw new TeamsIdentityRejectedError("Teams token verification failed");
    }
    throw error;
  }
  validateTeamsSubjectClaims(payload, expected, { tenantId, clientId });
  return { token, tenantId, objectId: expected.objectId };
}

export function validateTeamsSubjectClaims(
  payload: jose.JWTPayload,
  expected: { tenantId: string; objectId: string },
  configuration: { tenantId: string; clientId: string },
): void {
  const tokenTenant = typeof payload.tid === "string" ? payload.tid : undefined;
  const objectId = typeof payload.oid === "string" ? payload.oid : undefined;
  const authorizedParty =
    typeof payload.azp === "string"
      ? payload.azp
      : typeof payload.appid === "string"
        ? payload.appid
        : undefined;
  const scopes = new Set(
    typeof payload.scp === "string"
      ? payload.scp.split(" ").filter(Boolean)
      : [],
  );

  if (expected.tenantId !== configuration.tenantId) {
    throw new TeamsIdentityRejectedError(
      "Teams token tenant does not match Runtime identity",
    );
  }
  if (
    tokenTenant !== configuration.tenantId ||
    objectId !== expected.objectId
  ) {
    throw new TeamsIdentityRejectedError(
      "Teams token subject does not match Runtime identity",
    );
  }
  if (authorizedParty !== configuration.clientId)
    throw new TeamsIdentityRejectedError(
      "Teams token was issued to an unexpected client",
    );
  for (const scope of REQUIRED_TEAMS_SCOPES) {
    if (!scopes.has(scope))
      throw new TeamsIdentityRejectedError(
        "Teams token is missing required delegated permissions",
      );
  }
}

export async function exchangeAcsTeamsUserToken(
  subject: VerifiedTeamsSubject,
): Promise<Extract<AcsMeetingCredential, { identityMode: "teams-user" }>> {
  const { clientId } = teamsUserConfiguration();
  const client = identityClient();
  const result = await client.getTokenForTeamsUser({
    teamsUserAadToken: subject.token,
    clientId,
    userObjectId: subject.objectId,
  });
  return {
    token: result.token,
    expiresOn: result.expiresOn.toISOString(),
    identityMode: "teams-user",
  };
}

export async function mintAcsGuestToken(
  authenticatedUserId: string,
): Promise<Extract<AcsMeetingCredential, { identityMode: "guest" }>> {
  const now = Date.now();
  const state = guestStateFor(authenticatedUserId);
  if (
    state.cached &&
    Date.parse(state.cached.expiresOn) - now >
      ACS_GUEST_TOKEN_REUSE_MIN_REMAINING_MS
  ) {
    return state.cached;
  }
  enforceGuestMintLimit(state, now);

  try {
    const client = identityClient();
    const options = {
      tokenExpiresInMinutes: ACS_GUEST_TOKEN_EXPIRES_IN_MINUTES,
    };
    let credential: Extract<AcsMeetingCredential, { identityMode: "guest" }>;
    if (state.acsUserId && client.getToken) {
      const result = await client.getToken(
        { communicationUserId: state.acsUserId },
        ["voip"],
        options,
      );
      credential = {
        token: result.token,
        expiresOn: result.expiresOn.toISOString(),
        identityMode: "guest",
        acsUserId: state.acsUserId,
      };
    } else {
      const result = await client.createUserAndToken(["voip"], options);
      credential = {
        token: result.token,
        expiresOn: result.expiresOn.toISOString(),
        identityMode: "guest",
        acsUserId: result.user.communicationUserId,
      };
    }
    state.acsUserId = credential.acsUserId;
    state.cached = credential;
    return credential;
  } catch (error) {
    if (error instanceof AcsCredentialError) throw error;
    // A deleted or otherwise stale ACS identity must not permanently wedge the
    // authenticated user. The next request creates a fresh communication user.
    state.acsUserId = undefined;
    state.cached = undefined;
    throw new AcsCredentialError("Teams meeting provider unavailable", 502);
  }
}

export function resetAcsTeamsAuthCache(): void {
  microsoftJwks = undefined;
  guestMintState.clear();
  testClient = null;
}

/** Test-only seam for exercising both ACS identity operations without Azure. */
export function setAcsIdentityClientForTests(
  client: AcsIdentityClient | null,
): void {
  testClient = client;
  guestMintState.clear();
}

function identityClient(): AcsIdentityClient {
  assertAcsTeamsConfigured();
  return (
    testClient ??
    new CommunicationIdentityClient(process.env.ACS_CONNECTION_STRING!)
  );
}

function teamsUserConfiguration(): {
  tenantId: string;
  clientId: string;
} {
  const tenantId = process.env.ENTRA_TENANT_ID?.trim();
  const clientId = process.env.ENTRA_CLIENT_ID?.trim();
  if (!tenantId || !clientId) {
    throw new AcsCredentialError(
      "Microsoft Teams employee identity is not configured",
      503,
    );
  }
  return { tenantId, clientId };
}

function guestStateFor(authenticatedUserId: string): GuestMintState {
  let state = guestMintState.get(authenticatedUserId);
  if (!state) {
    state = { mints: [] };
    guestMintState.set(authenticatedUserId, state);
  }
  return state;
}

function enforceGuestMintLimit(state: GuestMintState, now: number): void {
  state.mints = state.mints.filter(
    (mintedAt) => now - mintedAt < ACS_GUEST_MINT_WINDOW_MS,
  );
  if (state.mints.length >= ACS_GUEST_MINT_LIMIT_PER_WINDOW) {
    throw new AcsCredentialError(
      "Too many Teams credential requests. Try again in a few minutes.",
      429,
    );
  }
  state.mints.push(now);
}
