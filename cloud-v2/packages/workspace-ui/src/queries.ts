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
import type { WorkspaceApi } from "./api";
import { isWorkspaceChangedError, WorkspaceApiError } from "./errors";

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
  audit: (api: ApiScope, workspaceId: string) => [...workspaceKeys.workspace(api, workspaceId), "audit"] as const,
  invitationPreview: (api: ApiScope, token: string) =>
    [...workspaceKeys.root(api), "invitation-preview", token] as const,
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

export const auditQuery = (api: WorkspaceApi, workspaceId: string) =>
  infiniteQueryOptions({
    queryKey: workspaceKeys.audit(api, workspaceId),
    queryFn: ({ pageParam }) => api.listAudit(workspaceId, { before: pageParam, limit: AUDIT_PAGE_SIZE }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.next ?? undefined,
    retry: shouldRetry,
  });

export const invitationPreviewQuery = (api: WorkspaceApi, token: string) =>
  queryOptions({
    queryKey: workspaceKeys.invitationPreview(api, token),
    queryFn: () => api.peekInvitation(token),
    retry: shouldRetry,
    refetchOnWindowFocus: false,
  });

/**
 * Options for a mutation that changes one workspace.
 *
 * On success the workspace's data and the workspace list are refetched before the mutation settles, so
 * a screen never offers a second change built on the revision the first one just replaced. On a 409
 * `membership_changed` (someone else changed the workspace first) the same refetch runs and the error
 * still reaches the caller, whose message is `WORKSPACE_CHANGED_MESSAGE`. With `workspaceGone` (deleted
 * or left) the workspace's data is dropped instead, since fetching it again would only fail.
 *
 * `gcTime: 0` keeps results out of the shared mutation cache once the screen lets go of them.
 */
export function workspaceMutationOptions<TVariables, TData>(
  client: QueryClient,
  api: WorkspaceApi,
  workspaceId: string,
  mutationFn: (variables: TVariables) => Promise<TData>,
  extra: { workspaceGone?: boolean } = {},
): UseMutationOptions<TData, Error, TVariables> {
  const refresh = () => client.invalidateQueries({ queryKey: workspaceKeys.workspace(api, workspaceId) });
  return {
    mutationFn,
    gcTime: 0,
    onSuccess: async () => {
      if (extra.workspaceGone) client.removeQueries({ queryKey: workspaceKeys.workspace(api, workspaceId) });
      else await refresh();
      await client.invalidateQueries({ queryKey: workspaceKeys.list(api) });
    },
    onError: async (error) => {
      if (isWorkspaceChangedError(error)) await refresh();
    },
  };
}

/** `useMutation` with `workspaceMutationOptions`. */
export function useWorkspaceMutation<TVariables, TData>(
  api: WorkspaceApi,
  workspaceId: string,
  mutationFn: (variables: TVariables) => Promise<TData>,
  extra?: { workspaceGone?: boolean },
) {
  const client = useQueryClient();
  return useMutation(workspaceMutationOptions(client, api, workspaceId, mutationFn, extra));
}
