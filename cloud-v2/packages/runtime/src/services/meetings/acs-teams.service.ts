import { CommunicationIdentityClient } from "@azure/communication-identity";
import * as jose from "jose";

const REQUIRED_TEAMS_SCOPES = new Set([
  "Teams.ManageCalls",
  "Teams.ManageChats",
]);
let microsoftJwks: ReturnType<typeof jose.createRemoteJWKSet> | undefined;

export class TeamsIdentityRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TeamsIdentityRejectedError";
  }
}

export interface VerifiedTeamsSubject {
  token: string;
  tenantId: string;
  objectId: string;
}

export function assertAcsTeamsConfigured(): void {
  for (const name of [
    "ENTRA_TENANT_ID",
    "ENTRA_CLIENT_ID",
    "ACS_CONNECTION_STRING",
  ] as const) {
    if (!process.env[name]?.trim())
      throw new Error(`meetings service requires ${name}`);
  }
}

export async function verifyTeamsSubjectToken(
  token: string,
  expected: { tenantId: string; objectId: string },
): Promise<VerifiedTeamsSubject> {
  const tenantId = process.env.ENTRA_TENANT_ID!;
  const clientId = process.env.ENTRA_CLIENT_ID!;
  if (expected.tenantId !== tenantId)
    throw new TeamsIdentityRejectedError("Teams token tenant does not match Runtime identity");

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
    throw new TeamsIdentityRejectedError("Teams token tenant does not match Runtime identity");
  }
  if (
    tokenTenant !== configuration.tenantId ||
    objectId !== expected.objectId
  ) {
    throw new TeamsIdentityRejectedError("Teams token subject does not match Runtime identity");
  }
  if (authorizedParty !== configuration.clientId)
    throw new TeamsIdentityRejectedError("Teams token was issued to an unexpected client");
  for (const scope of REQUIRED_TEAMS_SCOPES) {
    if (!scopes.has(scope))
      throw new TeamsIdentityRejectedError("Teams token is missing required delegated permissions");
  }
}

export async function exchangeAcsTeamsUserToken(
  subject: VerifiedTeamsSubject,
): Promise<{
  token: string;
  expiresOn: string;
}> {
  const client = new CommunicationIdentityClient(
    process.env.ACS_CONNECTION_STRING!,
  );
  const result = await client.getTokenForTeamsUser({
    teamsUserAadToken: subject.token,
    clientId: process.env.ENTRA_CLIENT_ID!,
    userObjectId: subject.objectId,
  });
  return { token: result.token, expiresOn: result.expiresOn.toISOString() };
}

export function resetAcsTeamsAuthCache(): void {
  microsoftJwks = undefined;
}
