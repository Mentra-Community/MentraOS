/**
 * @fileoverview The JSON client for Core's workspace API (`/api/workspaces`, or the Store's
 * `/api/console/workspaces` proxy of it). One contract serves both embeddings, so everything
 * here is relative to `basePath`.
 *
 * Calls send the session cookie to the same origin only (`credentials: "same-origin"`), parse the
 * `{error, error_description}` failure body into a `WorkspaceApiError`, and answer 204 with
 * `undefined`. Nothing is cached here: the screens cache through TanStack Query.
 */

import type {
  AuditEventView,
  CredentialView,
  InvitationView,
  MemberView,
  PrincipalResponse,
  WorkspaceDetail,
  WorkspaceRole,
  WorkspaceSummary,
} from "@mentra/workspace-contract";
import { WorkspaceApiError } from "./errors";

/** One row of the caller's workspace list: the workspace, their membership and what they may do there. */
export type WorkspaceListItem = PrincipalResponse["workspaces"][number];

export interface CreatedInvitation {
  invitationId: string;
  /** The link to the invitation. It carries the only copy of the token, so show it once. */
  inviteUrl: string;
  expiresAt: string;
}

/** What an invitation link is for, before the invitee signs in and accepts. */
export interface InvitationPreview {
  workspaceName: string;
  email: string;
  role: WorkspaceRole;
}

export interface AcceptedInvitation {
  workspaceId: string;
  membershipId: string;
}

export interface CreateCredentialInput {
  name: string;
  /** Restricts the credential to these packages. Omit for every package of the workspace. */
  packageNames?: string[];
  /** An ISO 8601 date-time (`Date.toISOString()`). Omit or null for a credential that never expires. */
  expiresAt?: string | null;
}

export interface CreatedCredential {
  credential: CredentialView;
  /** The credential itself. Shown exactly once: the server keeps only its hash. */
  token: string;
}

export interface AuditPage {
  items: AuditEventView[];
  /** Pass as `before` to read the next (older) page; null on the last page. */
  next: string | null;
}

export interface WorkspaceApi {
  /** The base path without a trailing slash. It also scopes this API's query-cache keys. */
  readonly basePath: string;

  listWorkspaces(): Promise<WorkspaceListItem[]>;
  createWorkspace(name: string): Promise<WorkspaceDetail>;
  getWorkspace(workspaceId: string): Promise<WorkspaceDetail>;
  renameWorkspace(workspaceId: string, name: string, expectedRevision: number): Promise<WorkspaceDetail>;
  deleteWorkspace(workspaceId: string, confirmName: string): Promise<void>;
  leaveWorkspace(workspaceId: string): Promise<void>;

  listMembers(workspaceId: string): Promise<MemberView[]>;
  changeMemberRole(
    workspaceId: string,
    membershipId: string,
    role: WorkspaceRole,
    expectedRevision: number,
  ): Promise<WorkspaceSummary>;
  removeMember(workspaceId: string, membershipId: string, expectedRevision: number): Promise<void>;

  listInvitations(workspaceId: string): Promise<InvitationView[]>;
  createInvitation(workspaceId: string, input: { email: string; role: WorkspaceRole }): Promise<CreatedInvitation>;
  revokeInvitation(workspaceId: string, invitationId: string): Promise<void>;
  /** Looks an invitation up by its token. The token travels in the body, never the URL. */
  peekInvitation(token: string): Promise<InvitationPreview>;
  acceptInvitation(token: string): Promise<AcceptedInvitation>;

  listCredentials(workspaceId: string): Promise<CredentialView[]>;
  createCredential(workspaceId: string, input: CreateCredentialInput): Promise<CreatedCredential>;
  revokeCredential(workspaceId: string, credentialId: string): Promise<void>;

  listAudit(workspaceId: string, page?: { before?: string; limit?: number }): Promise<AuditPage>;
}

/** What `createWorkspaceApi` needs of `fetch`; the global `fetch` of any runtime satisfies it. */
export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/**
 * A client for the workspace API under `opts.basePath`. `opts.fetch` defaults to the global `fetch`,
 * looked up on each call so a host (or a test) that replaces it later is honored. `opts.credentials`
 * defaults to `"same-origin"`: the session cookie goes to this origin only.
 */
export function createWorkspaceApi(opts: {
  basePath: string;
  fetch?: FetchLike;
  credentials?: RequestCredentials;
}): WorkspaceApi {
  const basePath = opts.basePath.replace(/\/+$/, "");
  const doFetch: FetchLike = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const id = encodeURIComponent;
  const workspace = (workspaceId: string) => `/${id(workspaceId)}`;

  async function send(method: string, path: string, body?: unknown): Promise<Response> {
    const headers: Record<string, string> = { accept: "application/json" };
    const init: RequestInit = { method, headers, credentials: opts.credentials ?? "same-origin" };
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    let response: Response;
    try {
      response = await doFetch(`${basePath}${path}`, init);
    } catch {
      throw new WorkspaceApiError(0, "network_error", "could not reach the server");
    }
    if (!response.ok) throw await failure(response);
    return response;
  }

  async function json<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await send(method, path, body);
    try {
      return (await response.json()) as T;
    } catch {
      throw new WorkspaceApiError(response.status, "invalid_response", "the server sent a response that is not JSON");
    }
  }

  async function empty(method: string, path: string, body?: unknown): Promise<void> {
    await send(method, path, body);
  }

  return {
    basePath,

    listWorkspaces: async () => (await json<{ items: WorkspaceListItem[] }>("GET", "")).items,
    createWorkspace: (name) => json("POST", "", { name }),
    getWorkspace: (workspaceId) => json("GET", workspace(workspaceId)),
    renameWorkspace: (workspaceId, name, expectedRevision) =>
      json("PATCH", workspace(workspaceId), { name, expectedRevision }),
    deleteWorkspace: (workspaceId, confirmName) => empty("DELETE", workspace(workspaceId), { confirmName }),
    leaveWorkspace: (workspaceId) => empty("POST", `${workspace(workspaceId)}/leave`),

    listMembers: async (workspaceId) =>
      (await json<{ items: MemberView[] }>("GET", `${workspace(workspaceId)}/members`)).items,
    changeMemberRole: (workspaceId, membershipId, role, expectedRevision) =>
      json("PATCH", `${workspace(workspaceId)}/members/${id(membershipId)}`, { role, expectedRevision }),
    removeMember: (workspaceId, membershipId, expectedRevision) =>
      empty("DELETE", `${workspace(workspaceId)}/members/${id(membershipId)}`, { expectedRevision }),

    listInvitations: async (workspaceId) =>
      (await json<{ items: InvitationView[] }>("GET", `${workspace(workspaceId)}/invitations`)).items,
    createInvitation: (workspaceId, input) => json("POST", `${workspace(workspaceId)}/invitations`, input),
    revokeInvitation: (workspaceId, invitationId) =>
      empty("DELETE", `${workspace(workspaceId)}/invitations/${id(invitationId)}`),
    peekInvitation: (token) => json("POST", "/invitations/peek", { token }),
    acceptInvitation: (token) => json("POST", "/invitations/accept", { token }),

    listCredentials: async (workspaceId) =>
      (await json<{ items: CredentialView[] }>("GET", `${workspace(workspaceId)}/credentials`)).items,
    createCredential: (workspaceId, input) => {
      // Absent optional fields stay out of the body: the server reads a missing field as "none".
      const body: Record<string, unknown> = { name: input.name };
      if (input.packageNames !== undefined) body.packageNames = input.packageNames;
      if (input.expiresAt !== undefined) body.expiresAt = input.expiresAt;
      return json("POST", `${workspace(workspaceId)}/credentials`, body);
    },
    revokeCredential: (workspaceId, credentialId) =>
      empty("DELETE", `${workspace(workspaceId)}/credentials/${id(credentialId)}`),

    listAudit: (workspaceId, page = {}) => {
      const query = new URLSearchParams();
      if (page.before) query.set("before", page.before);
      if (page.limit !== undefined) query.set("limit", String(page.limit));
      const queryString = query.toString();
      return json("GET", `${workspace(workspaceId)}/audit${queryString ? `?${queryString}` : ""}`);
    },
  };
}

/** The typed error for a non-2xx response: Core's `{error, error_description}` body when it sent one. */
async function failure(response: Response): Promise<WorkspaceApiError> {
  let code = `http_${response.status}`;
  let message = response.statusText || `request failed with status ${response.status}`;
  try {
    const body = (await response.json()) as { error?: unknown; error_description?: unknown } | null;
    if (typeof body?.error === "string" && body.error) {
      code = body.error;
      message = typeof body.error_description === "string" && body.error_description ? body.error_description : code;
    }
  } catch {
    // Not JSON (a proxy's error page, for instance): keep the status-based code and message.
  }
  return new WorkspaceApiError(response.status, code, message);
}
