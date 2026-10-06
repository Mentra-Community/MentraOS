/**
 * Shared fixtures for the package's tests. Not exported from the package: it is synthetic data only.
 */
import {
  capabilitiesForRole,
  type AuditEventView,
  type CredentialView,
  type InvitationView,
  type MemberView,
  type WorkspaceCapability,
  type WorkspaceDetail,
  type WorkspaceRole,
} from "@mentra/workspace-contract";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createWorkspaceApi, type WorkspaceApi } from "./api";
import {
  auditQuery,
  credentialsQuery,
  invitationsQuery,
  membersQuery,
  workspaceDetailQuery,
  workspaceKeys,
  workspaceListQuery,
} from "./queries";

export const WORKSPACE_ID = "ws_acme";
export const WORKSPACE_NAME = "Acme Robotics";

/** A synthetic credential token, shaped like a real one so that a leak would be recognizable. */
export const TOKEN = "msk_prod_01JZ0SYNTHETIC00000000000A.abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";

/** An API whose every request is recorded and fails: a server render must never reach the network. */
export function offlineApi() {
  const requests: string[] = [];
  const api: WorkspaceApi = createWorkspaceApi({
    basePath: "/api/workspaces",
    fetch: (async (input: RequestInfo | URL) => {
      requests.push(String(input));
      throw new Error("a server render must not fetch");
    }) as unknown as typeof fetch,
  });
  return { api, requests };
}

/** The detail the API answers for a member holding `role`, with the caller's own membership. */
export function detailFor(role: WorkspaceRole, extra: WorkspaceCapability[] = []): WorkspaceDetail {
  return {
    organizationId: "org_test",
    workspaceId: WORKSPACE_ID,
    name: WORKSPACE_NAME,
    status: "active",
    authorizationRevision: 7,
    membership: { membershipId: "wm_self", role },
    capabilities: [...new Set([...capabilitiesForRole(role), ...extra])],
  };
}

/** An organization admin who is not a member: owner capabilities and no membership. */
export function organizationAdminDetail(): WorkspaceDetail {
  return { ...detailFor("owner"), membership: null };
}

const START = "2026-09-01T10:00:00.000Z";

export const OTHER_MEMBERS: MemberView[] = [
  { membershipId: "wm_owner", mentraUserId: "u_1", email: "olivia@acme.test", name: "Olivia Owner", role: "owner", startedAt: START, pending: false },
  { membershipId: "wm_admin", mentraUserId: "u_2", email: "adam@acme.test", name: "Adam Admin", role: "admin", startedAt: START, pending: false },
  { membershipId: "wm_dev", mentraUserId: "u_3", email: "dana@acme.test", name: "Dana Developer", role: "developer", startedAt: START, pending: false },
  { membershipId: "wm_member", mentraUserId: "u_4", email: "max@acme.test", name: "Max Member", role: "member", startedAt: START, pending: false },
  { membershipId: "wm_pending", mentraUserId: null, email: "pending@acme.test", name: null, role: "developer", startedAt: START, pending: true },
];

/** The member list as the viewer sees it: the others plus the viewer's own row when they are a member. */
export function membersFor(viewer: WorkspaceDetail): MemberView[] {
  if (!viewer.membership) return OTHER_MEMBERS;
  const self: MemberView = {
    membershipId: viewer.membership.membershipId,
    mentraUserId: "u_self",
    email: "sam@acme.test",
    name: "Sam Self",
    role: viewer.membership.role,
    startedAt: START,
    pending: false,
  };
  return [self, ...OTHER_MEMBERS];
}

export const INVITATIONS: InvitationView[] = [
  { invitationId: "inv_member", email: "newbie@acme.test", role: "member", expiresAt: "2026-10-19T10:00:00.000Z", invitedByMembershipId: "wm_admin" },
  { invitationId: "inv_admin", email: "boss@acme.test", role: "admin", expiresAt: "2026-10-19T10:00:00.000Z", invitedByMembershipId: "wm_owner" },
];

export const CREDENTIALS: CredentialView[] = [
  {
    credentialId: "cred_ci",
    prefix: "msk",
    name: "CI publisher",
    display: "msk_prod_…abcd",
    workspaceId: WORKSPACE_ID,
    scopes: ["miniapps.publish"],
    packageNames: ["com.acme.scanner"],
    createdByEmail: "dana@acme.test",
    issuedByService: null,
    expiresAt: null,
    lastUsedAt: null,
    createdAt: START,
  },
];

export const AUDIT_EVENTS: AuditEventView[] = [
  {
    eventId: "evt_2",
    action: "membership.role_changed",
    actor: { kind: "user", email: "olivia@acme.test", credentialId: null, service: null },
    target: { membershipId: "wm_dev", mentraUserId: "u_3" },
    before: { role: "member" },
    after: { role: "developer" },
    occurredAt: "2026-09-02T10:00:00.000Z",
  },
  {
    eventId: "evt_1",
    action: "credential.created",
    actor: { kind: "service", email: null, credentialId: null, service: "store" },
    target: { credentialId: "cred_ci" },
    before: null,
    after: null,
    occurredAt: "2026-09-01T10:00:00.000Z",
  },
];

/** What a test seeds into the query cache before a server render. */
export interface Seed {
  list?: WorkspaceDetail[];
  detail?: WorkspaceDetail;
  members?: MemberView[];
  invitations?: InvitationView[];
  credentials?: CredentialView[];
  audit?: { items: AuditEventView[]; next: string | null };
}

export function seedClient(api: WorkspaceApi, seed: Seed, client = new QueryClient()): QueryClient {
  if (seed.list) client.setQueryData(workspaceKeys.list(api), seed.list);
  if (seed.detail) client.setQueryData(workspaceKeys.detail(api, WORKSPACE_ID), seed.detail);
  if (seed.members) client.setQueryData(workspaceKeys.members(api, WORKSPACE_ID), seed.members);
  if (seed.invitations) client.setQueryData(workspaceKeys.invitations(api, WORKSPACE_ID), seed.invitations);
  if (seed.credentials) client.setQueryData(workspaceKeys.credentials(api, WORKSPACE_ID), seed.credentials);
  if (seed.audit) {
    client.setQueryData(workspaceKeys.audit(api, WORKSPACE_ID), { pages: [seed.audit], pageParams: [undefined] });
  }
  return client;
}

/** Renders `ui` once, on the server, against a client seeded with `seed`. */
export function renderSeeded(api: WorkspaceApi, seed: Seed, ui: ReactElement): string {
  const client = seedClient(api, seed);
  try {
    return renderToStaticMarkup(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
  } finally {
    client.clear();
  }
}

const FAILING = {
  list: (client: QueryClient, api: WorkspaceApi) => client.fetchQuery({ ...workspaceListQuery(api), retry: false }),
  detail: (client: QueryClient, api: WorkspaceApi) =>
    client.fetchQuery({ ...workspaceDetailQuery(api, WORKSPACE_ID), retry: false }),
  members: (client: QueryClient, api: WorkspaceApi) =>
    client.fetchQuery({ ...membersQuery(api, WORKSPACE_ID), retry: false }),
  invitations: (client: QueryClient, api: WorkspaceApi) =>
    client.fetchQuery({ ...invitationsQuery(api, WORKSPACE_ID), retry: false }),
  credentials: (client: QueryClient, api: WorkspaceApi) =>
    client.fetchQuery({ ...credentialsQuery(api, WORKSPACE_ID), retry: false }),
  audit: (client: QueryClient, api: WorkspaceApi) =>
    client.fetchInfiniteQuery({ ...auditQuery(api, WORKSPACE_ID), retry: false }),
};

/**
 * Renders `ui` after the named, already-loaded queries failed a background refetch: they hold their old
 * data and are in the error state, which is what a dropped connection leaves behind. `api` must be an
 * `offlineApi()`, whose every request fails.
 */
export async function renderAfterFailedRefetch(
  api: WorkspaceApi,
  seed: Seed,
  ui: ReactElement,
  failing: Array<keyof typeof FAILING>,
): Promise<string> {
  const client = seedClient(api, seed);
  try {
    for (const name of failing) await FAILING[name](client, api).catch(() => undefined);
    for (const name of failing) {
      const key = name === "list" ? workspaceKeys.list(api) : workspaceKeys[name](api, WORKSPACE_ID);
      const state = client.getQueryState(key);
      if (state?.status !== "error" || state.data === undefined) {
        throw new Error(`fixture: the ${name} query is not in the "failed refetch with old data" state`);
      }
    }
    return renderToStaticMarkup(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
  } finally {
    client.clear();
  }
}

/** The option values of every `<select aria-label="<label> for X">`, keyed by X. */
export function selectOptions(markup: string, label: string): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  const pattern = new RegExp(`<select[^>]*aria-label="${label} for ([^"]+)"[^>]*>([\\s\\S]*?)</select>`, "g");
  for (const match of markup.matchAll(pattern)) {
    result[match[1]!] = [...match[2]!.matchAll(/<option value="([^"]+)"/g)].map((option) => option[1]!);
  }
  return result;
}

/** The `aria-label` of every control whose label starts with `prefix`. */
export function labelsStartingWith(markup: string, prefix: string): string[] {
  return [...markup.matchAll(new RegExp(`aria-label="(${prefix}[^"]*)"`, "g"))].map((match) => match[1]!);
}
