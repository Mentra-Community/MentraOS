import { describe, expect, test } from "bun:test";
import { MutationObserver, QueryClient } from "@tanstack/react-query";
import { WORKSPACE_CHANGED_MESSAGE, WorkspaceApiError, errorMessage } from "./errors";
import { shouldRetry, workspaceKeys, workspaceMutationOptions } from "./queries";
import { detailFor, membersFor, offlineApi, seedClient, WORKSPACE_ID } from "./test-fixtures";

const OTHER_ID = "ws_other";

function seeded() {
  const { api } = offlineApi();
  const detail = detailFor("admin");
  const client = seedClient(api, { list: [detail], detail, members: membersFor(detail) });
  client.setQueryData(workspaceKeys.detail(api, OTHER_ID), { ...detail, workspaceId: OTHER_ID });
  return { api, client };
}

const stale = (client: QueryClient, key: readonly unknown[]) => client.getQueryState(key)?.isInvalidated === true;

describe("workspaceMutationOptions", () => {
  test("a success marks the workspace's data and the workspace list stale so they refetch", async () => {
    const { api, client } = seeded();
    const observer = new MutationObserver(client, workspaceMutationOptions(client, api, WORKSPACE_ID, async () => "done"));
    expect(await observer.mutate(undefined)).toBe("done");
    expect(stale(client, workspaceKeys.detail(api, WORKSPACE_ID))).toBe(true);
    expect(stale(client, workspaceKeys.members(api, WORKSPACE_ID))).toBe(true);
    expect(stale(client, workspaceKeys.list(api))).toBe(true);
    // Another workspace's data is not touched.
    expect(stale(client, workspaceKeys.detail(api, OTHER_ID))).toBe(false);
  });

  test("409 membership_changed refetches the workspace and surfaces the review-and-retry message", async () => {
    const { api, client } = seeded();
    const changed = new WorkspaceApiError(409, "membership_changed", "membership_changed");
    const observer = new MutationObserver(
      client,
      workspaceMutationOptions(client, api, WORKSPACE_ID, async () => {
        throw changed;
      }),
    );
    const error = await observer.mutate(undefined).catch((e: unknown) => e);
    expect(error).toBe(changed);
    expect(errorMessage(error)).toBe(WORKSPACE_CHANGED_MESSAGE);
    expect(stale(client, workspaceKeys.detail(api, WORKSPACE_ID))).toBe(true);
    expect(stale(client, workspaceKeys.members(api, WORKSPACE_ID))).toBe(true);
  });

  test("any other failure leaves the cache alone", async () => {
    const { api, client } = seeded();
    for (const failure of [
      new WorkspaceApiError(409, "last_owner", "a workspace must keep at least one owner"),
      new WorkspaceApiError(403, "forbidden", "a admin cannot remove a owner"),
    ]) {
      const observer = new MutationObserver(
        client,
        workspaceMutationOptions(client, api, WORKSPACE_ID, async () => {
          throw failure;
        }),
      );
      await observer.mutate(undefined).catch(() => {});
    }
    expect(stale(client, workspaceKeys.detail(api, WORKSPACE_ID))).toBe(false);
    expect(stale(client, workspaceKeys.members(api, WORKSPACE_ID))).toBe(false);
  });

  test("a workspace that is gone (deleted or left) is forgotten instead of refetched", async () => {
    const { api, client } = seeded();
    const observer = new MutationObserver(
      client,
      workspaceMutationOptions(client, api, WORKSPACE_ID, async () => undefined, { workspaceGone: true }),
    );
    await observer.mutate(undefined);
    expect(client.getQueryData(workspaceKeys.detail(api, WORKSPACE_ID))).toBeUndefined();
    expect(client.getQueryData(workspaceKeys.members(api, WORKSPACE_ID))).toBeUndefined();
    expect(client.getQueryData(workspaceKeys.detail(api, OTHER_ID))).toBeDefined();
    expect(stale(client, workspaceKeys.list(api))).toBe(true);
  });

  test("keys are scoped by base path, so two embeddings never share data", () => {
    const admin = { basePath: "/api/workspaces" };
    const store = { basePath: "/api/console/workspaces" };
    expect(workspaceKeys.detail(admin, WORKSPACE_ID)).not.toEqual(workspaceKeys.detail(store, WORKSPACE_ID));
  });
});

describe("shouldRetry", () => {
  test("never retries a request the server understood and refused, retries transient failures a couple of times", () => {
    expect(shouldRetry(0, new WorkspaceApiError(403, "forbidden", "forbidden"))).toBe(false);
    expect(shouldRetry(0, new WorkspaceApiError(404, "workspace_not_found", "x"))).toBe(false);
    expect(shouldRetry(0, new WorkspaceApiError(502, "http_502", "Bad Gateway"))).toBe(true);
    expect(shouldRetry(0, new WorkspaceApiError(0, "network_error", "offline"))).toBe(true);
    expect(shouldRetry(2, new WorkspaceApiError(502, "http_502", "Bad Gateway"))).toBe(false);
  });
});
