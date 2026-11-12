/**
 * @fileoverview The CLI's requests: sign-in at Core's sign-in server (an
 * OpenID Connect provider; the CLI is its public client), and Core's
 * workspace API, with `Authorization: Bearer <Core access token>`.
 */

import type { PrincipalResponse, WorkspaceDetail } from "@mentra/workspace-contract";
import * as client from "openid-client";
import { isLoopbackHttp } from "./config";
import type { CliCredentials } from "./credentials";

/** What a Core request needs: the bearer and the Core. */
export interface CoreCredentials {
  token: string;
  coreUrl: string;
  /**
   * The stored login's way back from a refused access token: called when Core answers 401 to
   * `refused`, for the access token to retry with, or null when there is none. It throws
   * `SessionExpiredError` when the sign-in has ended.
   */
  renewToken?: (refused: string) => Promise<string | null>;
}

/** A workspace the caller belongs to, with their role in it. */
export type CliWorkspace = PrincipalResponse["workspaces"][number];

/** Core's `GET /api/workspaces`: the workspaces the signed-in person belongs to. */
export async function listWorkspaces(credentials: CoreCredentials): Promise<CliWorkspace[]> {
  return (await coreRequest<{ items: CliWorkspace[] }>(credentials, "/api/workspaces")).items;
}

/** Core's `POST /api/workspaces`: create a workspace. The caller becomes its owner. */
export async function createWorkspace(credentials: CoreCredentials, name: string): Promise<WorkspaceDetail> {
  return coreRequest(credentials, "/api/workspaces", { method: "POST", body: JSON.stringify({ name }) });
}

/** Core refused a request. `code` is its `error` field, when it sent one. */
export class CoreRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    message: string,
  ) {
    super(message);
    this.name = "CoreRequestError";
  }
}

async function coreRequest<T>(credentials: CoreCredentials, path: string, init?: RequestInit): Promise<T> {
  let response = await coreFetch(credentials, path, init);
  if (response.status === 401 && credentials.renewToken) {
    // Core no longer accepts this access token (the person's sign-ins were revoked, for example):
    // renew it, which ends the login when its grant is gone too, and retry once.
    const token = await credentials.renewToken(credentials.token);
    if (token && token !== credentials.token) {
      await response.body?.cancel();
      // The command's later requests carry the renewed token too.
      credentials.token = token;
      response = await coreFetch(credentials, path, init);
    }
  }
  if (!response.ok) {
    const body = await errorBody(response);
    throw new CoreRequestError(response.status, body.error ?? null, errorText(body, response.status));
  }
  return (await response.json()) as T;
}

function coreFetch(credentials: CoreCredentials, path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${credentials.coreUrl}${path}`, {
    ...init,
    headers: {
      accept: "application/json",
      authorization: `Bearer ${credentials.token}`,
      ...(typeof init?.body === "string" ? { "content-type": "application/json" } : {}),
      ...init?.headers,
    },
  });
}

// --- Sign-in at Core's sign-in server ---------------------------------------------

/** The algorithm Core's sign-in server signs ID tokens with. */
const ID_TOKEN_ALG = "EdDSA";
/** Seconds the CLI waits for the sign-in server before giving up on a request. */
const OIDC_TIMEOUT_SEC = 15;

/** Where `ensureOidcClient` finds the sign-in server and the CLI client. */
export interface OidcClientSettings {
  /** The issuer and client ID, when known (`MENTRA_CLI_OIDC_ISSUER` and `MENTRA_CLI_CLIENT_ID`, or a stored login's). */
  oidcIssuer?: string;
  cliClientId?: string;
  /** Asked for both otherwise: the Core whose `/api/cli/config` names them. */
  coreUrl?: string;
}

/** What Core's `/api/cli/config` answers. */
export interface CliSignInConfig {
  issuer: string;
  clientId: string;
}

/** The sign-in server refused the stored login's refresh token; the person must sign in again. */
export class SessionExpiredError extends Error {
  constructor() {
    super("Session expired. Run `mentra login`.");
    this.name = "SessionExpiredError";
  }
}

/**
 * The CLI as a public client (`none`) of its sign-in server: discovery from
 * the issuer, EdDSA ID tokens whose signatures are checked against the
 * issuer's key set. Plain HTTP only for a loopback issuer.
 */
export async function ensureOidcClient(settings: OidcClientSettings): Promise<client.Configuration> {
  const explicit = { issuer: settings.oidcIssuer?.trim() ?? "", clientId: settings.cliClientId?.trim() ?? "" };
  if (Boolean(explicit.issuer) !== Boolean(explicit.clientId)) {
    throw new Error("Set both MENTRA_CLI_OIDC_ISSUER and MENTRA_CLI_CLIENT_ID, or neither.");
  }
  let signIn: CliSignInConfig;
  if (explicit.issuer) signIn = explicit;
  else if (settings.coreUrl) signIn = await fetchCliSignInConfig(settings.coreUrl);
  else throw new Error("No sign-in server is configured. Run `mentra login`.");

  const issuer = issuerUrl(signIn.issuer);
  const config = await client.discovery(
    issuer,
    signIn.clientId,
    { id_token_signed_response_alg: ID_TOKEN_ALG },
    client.None(),
    {
      execute: [...(isLoopbackHttp(issuer) ? [client.allowInsecureRequests] : []), client.enableNonRepudiationChecks],
      timeout: OIDC_TIMEOUT_SEC,
    },
  );
  config.timeout = OIDC_TIMEOUT_SEC;
  return config;
}

/** Ask the Core at `coreUrl` which sign-in server and CLI client to use. */
export async function fetchCliSignInConfig(coreUrl: string): Promise<CliSignInConfig> {
  let response: Response;
  try {
    response = await fetch(`${coreUrl}/api/cli/config`, { headers: { accept: "application/json" } });
  } catch (error) {
    throw new Error(`Could not reach ${coreUrl}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) {
    const body = await errorBody(response);
    if (body.error === "not_configured") throw new Error(`The Core at ${coreUrl} does not offer CLI sign-in.`);
    throw new Error(`The Core at ${coreUrl} did not provide CLI sign-in settings: ${errorText(body, response.status)}`);
  }
  const body = (await response.json().catch(() => ({}))) as Partial<CliSignInConfig>;
  if (typeof body.issuer !== "string" || !body.issuer || typeof body.clientId !== "string" || !body.clientId) {
    throw new Error(`The Core at ${coreUrl} did not provide CLI sign-in settings.`);
  }
  return { issuer: body.issuer, clientId: body.clientId };
}

function issuerUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`The sign-in issuer is not a URL: ${value}`);
  }
  if (url.username || url.password || url.search || url.hash || (url.protocol !== "https:" && !isLoopbackHttp(url))) {
    throw new Error(`The sign-in issuer must be an HTTPS URL (plain HTTP only on this machine): ${value}`);
  }
  return url;
}

/**
 * Exchange the stored login's refresh token for new tokens. The sign-in
 * server rotates refresh tokens, so the result's `refreshToken` replaces the
 * stored one before its `token` is used. A refused refresh token
 * (`invalid_grant`) is a `SessionExpiredError`.
 */
export async function refreshLoginToken(credentials: CliCredentials): Promise<CliCredentials> {
  const config = await ensureOidcClient({ oidcIssuer: credentials.issuer, cliClientId: credentials.clientId });
  let tokens: Awaited<ReturnType<typeof client.refreshTokenGrant>>;
  try {
    tokens = await client.refreshTokenGrant(config, credentials.refreshToken);
  } catch (error) {
    if (error instanceof client.ResponseBodyError && error.error === "invalid_grant") throw new SessionExpiredError();
    throw new Error(`Could not refresh the sign-in: ${describeOidcError(error)}`);
  }
  const claims = tokens.claims();
  // A refresh continues one person's login.
  if (claims && claims.sub !== credentials.mentraUserId) throw new SessionExpiredError();
  const storedAt = new Date();
  return {
    ...credentials,
    token: tokens.access_token,
    refreshToken: tokens.refresh_token ?? credentials.refreshToken,
    expiresAt: new Date(expiresAtMs(tokens, storedAt.getTime())).toISOString(),
    email: typeof claims?.email === "string" ? claims.email : credentials.email,
    storedAt: storedAt.toISOString(),
  };
}

/**
 * Revoke this login's refresh token at the sign-in server's revocation
 * endpoint. Confirmed only when the server answered 200. This ends only this
 * login: the person's other CLI logins and Mentra sign-ins stay signed in.
 */
export async function revokeLogin(credentials: CliCredentials): Promise<{ confirmed: boolean }> {
  try {
    const config = await ensureOidcClient({ oidcIssuer: credentials.issuer, cliClientId: credentials.clientId });
    if (!config.serverMetadata().revocation_endpoint) return { confirmed: false };
    await client.tokenRevocation(config, credentials.refreshToken, { token_type_hint: "refresh_token" });
    return { confirmed: true };
  } catch {
    return { confirmed: false };
  }
}

/** When the access token in `tokens` expires, in epoch milliseconds. */
export function expiresAtMs(tokens: { expiresIn(): number | undefined; access_token: string }, now = Date.now()): number {
  const expiresIn = tokens.expiresIn();
  if (typeof expiresIn === "number") return now + expiresIn * 1000;
  const exp = jwtExpiry(tokens.access_token);
  // Unknown: treat as expired, so the next command refreshes it.
  return exp ? exp * 1000 : now;
}

function jwtExpiry(token: string): number {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as { exp?: unknown };
    return typeof payload.exp === "number" ? payload.exp : 0;
  } catch {
    return 0;
  }
}

/** A short, printable reason for an openid-client failure. */
export function describeOidcError(error: unknown): string {
  if (error instanceof client.ResponseBodyError) return error.error;
  if (error instanceof client.AuthorizationResponseError) return error.error;
  if (error instanceof Error) return error.message;
  return String(error);
}

type ErrorBody = { error?: string; error_description?: string };

async function errorBody(response: Response): Promise<ErrorBody> {
  try {
    return (await response.json()) as ErrorBody;
  } catch {
    return {};
  }
}

function errorText(body: ErrorBody, status: number): string {
  return body.error_description || body.error || `HTTP ${status}`;
}
