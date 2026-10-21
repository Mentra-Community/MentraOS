/**
 * @fileoverview The screens' data layer: query keys, query options and the one mutation wrapper.
 *
 * Every key starts with the API's base path, so two embeddings in one page (or one cache) never
 * share data. A workspace's data lives under one prefix, which is what lets a mutation refresh or
 * forget all of it at once.
 */

import {
  infiniteQueryOptions,
  queryOptions,
  useMutation,
  useQueryClient,
  type QueryClient,
  type UseMutationOptions,
} from "@tanstack/react-query";
import type { WorkspaceDetail } from "@mentra/workspace-contract";
import type { WorkspaceApi } from "./api";
import type { BillingApi } from "./billing-api";
import { BillingRefusedError } from "./billing-errors";
import { workspaceScope, type BillingScope } from "./billing-scope";
import { isLicenseChangedError, isWorkspaceChangedError, isWorkspaceHeldError, WorkspaceApiError } from "./errors";

type ApiScope = Pick<WorkspaceApi, "basePath">;

export const AUDIT_PAGE_SIZE = 50;

export const workspaceKeys = {
  root: (api: ApiScope) => ["workspace-ui", api.basePath] as const,
  list: (api: ApiScope) => [...workspaceKeys.root(api), "list"] as const,
  /** Everything about one workspace: invalidate or remove this to refresh or forget all of it. */
  workspace: (api: ApiScope, workspaceId: string) => [...workspaceKeys.root(api), "workspace", workspaceId] as const,
  detail: (api: ApiScope, workspaceId: string) => [...workspaceKeys.workspace(api, workspaceId), "detail"] as const,
  members: (api: ApiScope, workspaceId: string) => [...workspaceKeys.workspace(api, workspaceId), "members"] as const,
  invitations: (api: ApiScope, workspaceId: string) =>
    [...workspaceKeys.workspace(api, workspaceId), "invitations"] as const,
  credentials: (api: ApiScope, workspaceId: string) =>
    [...workspaceKeys.workspace(api, workspaceId), "credentials"] as const,
  licenses: (api: ApiScope, workspaceId: string) => [...workspaceKeys.workspace(api, workspaceId), "licenses"] as const,
  audit: (api: ApiScope, workspaceId: string) => [...workspaceKeys.workspace(api, workspaceId), "audit"] as const,
  invitationPreview: (api: ApiScope, token: string) =>
    [...workspaceKeys.root(api), "invitation-preview", token] as const,
  /** The invitations addressed to the signed-in person. */
  myInvitations: (api: ApiScope) => [...workspaceKeys.root(api), "my-invitations"] as const,
};

/**
 * Billing's answers, which are not part of the workspace API's cache but belong to an owner: a workspace's start
 * with its id, and the person's own sit apart. The billing client's base path and locale are in each key, so two
 * embeddings, or a locale change, never share an answer. Status and catalog are separate branches under the
 * owner, so a seat change can refresh the one it affects (`statuses`) and leave the other.
 */
export const billingKeys = {
  root: ["workspace-ui", "billing"] as const,
  /** Everything billing said about one owner: remove this to forget all of it. */
  owner: (scope: BillingScope): readonly string[] =>
    scope.kind === "workspace" ? [...billingKeys.root, "workspace", scope.workspaceId] : [...billingKeys.root, "account"],
  /** Every status billing gave about one owner, for any purchase, locale or base path: invalidate this to refresh them. */
  statuses: (scope: BillingScope): readonly string[] => [...billingKeys.owner(scope), "status"],
  catalog: (billing: Pick<BillingApi, "base" | "locale">, scope: BillingScope) =>
    [...billingKeys.owner(scope), "catalog", billing.base, billing.locale] as const,
  status: (billing: Pick<BillingApi, "base" | "locale">, scope: BillingScope, purchase?: string | null) =>
    [...billingKeys.statuses(scope), billing.base, billing.locale, purchase ?? null] as const,
};

/**
 * Retry only what may pass: a request the server understood and refused (4xx) will be refused again,
 * while a dropped connection or a 5xx deserves a couple more tries.
 */
export function shouldRetry(failureCount: number, error: unknown): boolean {
  if (error instanceof WorkspaceApiError && error.status !== 0 && error.status < 500) return false;
  return failureCount < 2;
}

export const workspaceListQuery = (api: WorkspaceApi) =>
  queryOptions({ queryKey: workspaceKeys.list(api), queryFn: () => api.listWorkspaces(), retry: shouldRetry });

export const workspaceDetailQuery = (api: WorkspaceApi, workspaceId: string) =>
  queryOptions({
    queryKey: workspaceKeys.detail(api, workspaceId),
    queryFn: () => api.getWorkspace(workspaceId),
    retry: shouldRetry,
  });

/**
 * The workspace detail as the settings screen reads it: the same cache entry, refetched when the window
 * regains focus while a service holds the workspace from deletion. Hosts turn refetch-on-focus off, but
 * a hold is cleared elsewhere (the Store clears it once the Developer Console has deleted the miniapps),
 * so a person coming back to this tab sees Delete offered again without reloading.
 */
export const settingsDetailQuery = (api: WorkspaceApi, workspaceId: string) =>
  queryOptions({
    ...workspaceDetailQuery(api, workspaceId),
    refetchOnWindowFocus: (query: { state: { data: WorkspaceDetail | undefined } }) =>
      (query.state.data?.deletionHolds?.length ?? 0) > 0,
  });

export const membersQuery = (api: WorkspaceApi, workspaceId: string) =>
  queryOptions({
    queryKey: workspaceKeys.members(api, workspaceId),
    queryFn: () => api.listMembers(workspaceId),
    retry: shouldRetry,
  });

export const invitationsQuery = (api: WorkspaceApi, workspaceId: string) =>
  queryOptions({
    queryKey: workspaceKeys.invitations(api, workspaceId),
    queryFn: () => api.listInvitations(workspaceId),
    retry: shouldRetry,
  });

export const credentialsQuery = (api: WorkspaceApi, workspaceId: string) =>
  queryOptions({
    queryKey: workspaceKeys.credentials(api, workspaceId),
    queryFn: () => api.listCredentials(workspaceId),
    retry: shouldRetry,
  });

/**
 * The workspace's licenses as the viewer may see them (see `WorkspaceApi.listLicenses`). A host reads it to
 * decide whether the workspace has any, as well as the licenses panel to list them.
 */
export const licensesQuery = (api: WorkspaceApi, workspaceId: string) =>
  queryOptions({
    queryKey: workspaceKeys.licenses(api, workspaceId),
    queryFn: () => api.listLicenses(workspaceId),
    retry: shouldRetry,
  });

/**
 * Retry billing once for a dropped connection or a 5xx, and not at all for a refusal (4xx) it would only repeat:
 * a page that can't read billing shows "unavailable" with Retry, and waiting through retries first would only
 * delay it.
 */
export function billingShouldRetry(failureCount: number, error: unknown): boolean {
  if (error instanceof BillingRefusedError && error.status !== 0 && error.status < 500) return false;
  return failureCount < 1;
}

/**
 * The products for the scope's owner type, parsed with the contract. Display content only unless the viewer may
 * manage the owner's billing (then each product has its `offer`).
 */
export const billingCatalogQuery = (billing: BillingApi, scope: BillingScope) =>
  queryOptions({
    queryKey: billingKeys.catalog(billing, scope),
    queryFn: () => billing.catalog(scope),
    retry: billingShouldRetry,
  });

/**
 * The owner's licenses as billing reads them, parsed with the contract; `purchase` is the `?purchase=` a checkout
 * returned with (its progress comes back in `purchase`). Pass `enabled: false` where the viewer isn't offered
 * billing: the route refuses them.
 */
export const billingStatusQuery = (billing: BillingApi, scope: BillingScope, purchase?: string | null) =>
  queryOptions({
    queryKey: billingKeys.status(billing, scope, purchase),
    queryFn: () => billing.status(scope, { purchase }),
    retry: billingShouldRetry,
  });

/**
 * The `placeholderData` for billing's status read: what the page keeps showing while the read under `current` (its
 * key, from `billingStatusQuery`) is on its way. It keeps the previous answer only when the previous query's key
 * differs from `current` in its last part alone, the `purchase` (`?purchase=` came or went: the same owner, the same
 * client, the same locale), so the page doesn't blank for a read it already has the substance of.
 *
 * It never carries an answer across anything else in the key: another workspace's licenses, prices, total and actions
 * are not this workspace's, and showing them (a click on one of those cards would ask this workspace's billing for
 * another's license) until the right answer arrives is worse than waiting. `keepPreviousData` keeps data for any key
 * change, so it can't be used here.
 */
export function statusPlaceholder<T>(current: readonly unknown[]) {
  return (previous: T | undefined, previousQuery: { queryKey: readonly unknown[] } | undefined): T | undefined => {
    if (previous === undefined || previousQuery === undefined) return undefined;
    const before = previousQuery.queryKey;
    const sameButPurchase = before.length === current.length && before.every((part, index) => index === before.length - 1 || part === current[index]);
    return sameButPurchase ? previous : undefined;
  };
}

export const auditQuery = (api: WorkspaceApi, workspaceId: string) =>
  infiniteQueryOptions({
    queryKey: workspaceKeys.audit(api, workspaceId),
    queryFn: ({ pageParam }) => api.listAudit(workspaceId, { before: pageParam, limit: AUDIT_PAGE_SIZE }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.next ?? undefined,
    retry: shouldRetry,
  });

/**
 * The key carries the invitation token, so the query is dropped from the cache as soon as nothing is
 * showing it (`gcTime: 0`), and a refusal (4xx: unknown, expired, used, signed out) is not retried.
 */
export const invitationPreviewQuery = (api: WorkspaceApi, token: string) =>
  queryOptions({
    queryKey: workspaceKeys.invitationPreview(api, token),
    queryFn: () => api.peekInvitation(token),
    retry: shouldRetry,
    gcTime: 0,
    refetchOnWindowFocus: false,
  });

/**
 * The invitations addressed to the signed-in person's verified email. Refusals (4xx: an unverified
 * email, signed out) are not retried; a host that only offers what it can show treats them as none.
 */
export const myInvitationsQuery = (api: WorkspaceApi) =>
  queryOptions({
    queryKey: workspaceKeys.myInvitations(api),
    queryFn: () => api.listMyInvitations(),
    retry: shouldRetry,
    refetchOnWindowFocus: false,
  });

/**
 * Options for a mutation that changes one workspace.
 *
 * On success the workspace's data and the workspace list are refetched before the mutation settles, so
 * a screen never offers a second change built on the revision the first one just replaced. On a 409
 * `membership_changed` (someone else changed the workspace first) the same refetch runs and the error
 * still reaches the caller, whose message is `WORKSPACE_CHANGED_MESSAGE`. A 409 `workspace_has_holds` (a
 * service placed a hold since the screen loaded) refetches too, so the screen shows what holds the
 * workspace, and so does a license that changed under the caller (every seat taken, or gone), so the
 * licenses show their real seats. With `workspaceGone` (deleted or left) a success drops the workspace's data,
 * billing's included, instead, since fetching it again would only fail.
 *
 * `seats` marks a seat mutation (assign, release, assign in bulk). Wherever the workspace's data is refreshed
 * for one, billing's status for the workspace is marked stale too, and read again in the background where a
 * screen shows it: nothing the caller does next builds on it, so it doesn't wait for a read that goes out to the
 * payment backend. Billing's catalog and every other mutation (rename, invite, role change) leave billing alone.
 *
 * `gcTime: 0` keeps results out of the shared mutation cache once the screen lets go of them.
 */
export function workspaceMutationOptions<TVariables, TData>(
  client: QueryClient,
  api: WorkspaceApi,
  workspaceId: string,
  mutationFn: (variables: TVariables) => Promise<TData>,
  extra: { workspaceGone?: boolean; seats?: boolean } = {},
): UseMutationOptions<TData, Error, TVariables> {
  const scope = workspaceScope(workspaceId);
  const refresh = () => {
    if (extra.seats) void client.invalidateQueries({ queryKey: billingKeys.statuses(scope) });
    return client.invalidateQueries({ queryKey: workspaceKeys.workspace(api, workspaceId) });
  };
  return {
    mutationFn,
    gcTime: 0,
    onSuccess: async () => {
      if (extra.workspaceGone) {
        client.removeQueries({ queryKey: workspaceKeys.workspace(api, workspaceId) });
        client.removeQueries({ queryKey: billingKeys.owner(scope) });
      } else await refresh();
      await client.invalidateQueries({ queryKey: workspaceKeys.list(api) });
    },
    onError: async (error) => {
      if (isWorkspaceChangedError(error) || isWorkspaceHeldError(error) || isLicenseChangedError(error)) await refresh();
    },
  };
}

/** `useMutation` with `workspaceMutationOptions`. */
export function useWorkspaceMutation<TVariables, TData>(
  api: WorkspaceApi,
  workspaceId: string,
  mutationFn: (variables: TVariables) => Promise<TData>,
  extra?: { workspaceGone?: boolean; seats?: boolean },
) {
  const client = useQueryClient();
  return useMutation(workspaceMutationOptions(client, api, workspaceId, mutationFn, extra));
}

/**
 * `useWorkspaceMutation` for a seat: assigning one, releasing one, or assigning several at once. It refreshes the
 * workspace's licenses and members and billing's status for the workspace; use it for every seat mutation.
 */
export function useSeatMutation<TVariables, TData>(
  api: WorkspaceApi,
  workspaceId: string,
  mutationFn: (variables: TVariables) => Promise<TData>,
) {
  return useWorkspaceMutation(api, workspaceId, mutationFn, { seats: true });
}
