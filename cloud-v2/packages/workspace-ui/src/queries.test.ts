import { describe, expect, spyOn, test } from "bun:test";
import { MutationObserver, QueryClient } from "@tanstack/react-query";
import { WORKSPACE_CHANGED_MESSAGE, WorkspaceApiError, errorMessage } from "./errors";
import { createWorkspaceApi } from "./api";
import { ACCOUNT_SCOPE, BillingRefusedError, BillingUnavailableError, createBillingApi, workspaceScope } from "./billing-api";
import {
  billingCatalogQuery,
  billingKeys,
  billingStatusQuery,
  invitationPreviewQuery,
  settingsDetailQuery,
  shouldRetry,
  workspaceKeys,
  workspaceMutationOptions,
} from "./queries";
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

  test("409 workspace_has_holds refetches the workspace, so the screen shows what holds it", async () => {
    const { api, client } = seeded();
    const held = new WorkspaceApiError(409, "workspace_has_holds", "held", [
      { service: "store", reason: "owns_miniapps", count: 1 },
    ]);
    const observer = new MutationObserver(
      client,
      workspaceMutationOptions(
        client,
        api,
        WORKSPACE_ID,
        async () => {
          throw held;
        },
        { workspaceGone: true },
      ),
    );
    expect(await observer.mutate(undefined).catch((e: unknown) => e)).toBe(held);
    expect(stale(client, workspaceKeys.detail(api, WORKSPACE_ID))).toBe(true);
  });

  test("a license that changed under the caller (every seat taken, or gone) is read again, and the error still reaches them", async () => {
    for (const changed of [
      new WorkspaceApiError(409, "no_seats_available", "every seat of this license is assigned"),
      new WorkspaceApiError(404, "license_not_found", "license not found"),
    ]) {
      const { api, client } = seeded();
      client.setQueryData(workspaceKeys.licenses(api, WORKSPACE_ID), []);
      const observer = new MutationObserver(
        client,
        workspaceMutationOptions(client, api, WORKSPACE_ID, async () => {
          throw changed;
        }),
      );
      expect(await observer.mutate(undefined).catch((e: unknown) => e)).toBe(changed);
      expect(stale(client, workspaceKeys.licenses(api, WORKSPACE_ID))).toBe(true);
    }
  });

  test("a success marks the workspace's licenses stale too, and another workspace's alone are left", async () => {
    const { api, client } = seeded();
    client.setQueryData(workspaceKeys.licenses(api, WORKSPACE_ID), []);
    client.setQueryData(workspaceKeys.licenses(api, OTHER_ID), []);
    const observer = new MutationObserver(client, workspaceMutationOptions(client, api, WORKSPACE_ID, async () => "done"));
    await observer.mutate(undefined);
    expect(stale(client, workspaceKeys.licenses(api, WORKSPACE_ID))).toBe(true);
    expect(stale(client, workspaceKeys.licenses(api, OTHER_ID))).toBe(false);
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

describe("settingsDetailQuery", () => {
  test("shares the workspace detail's cache, and refetches on focus while a service holds the workspace", () => {
    const { api } = offlineApi();
    const options = settingsDetailQuery(api, WORKSPACE_ID);
    expect([...options.queryKey]).toEqual([...workspaceKeys.detail(api, WORKSPACE_ID)]);
    // Hosts turn refetch-on-focus off; a held workspace is the exception, since its hold is cleared
    // elsewhere (the Developer Console) while this tab is in the background.
    const onFocus = options.refetchOnWindowFocus as (query: { state: { data: unknown } }) => boolean;
    const held = { ...detailFor("owner"), deletionHolds: [{ service: "store", reason: "owns_miniapps", count: 1 }] };
    expect(onFocus({ state: { data: held } })).toBe(true);
    expect(onFocus({ state: { data: { ...detailFor("owner"), deletionHolds: [] } } })).toBe(false);
    expect(onFocus({ state: { data: detailFor("owner") } })).toBe(false);
    expect(onFocus({ state: { data: undefined } })).toBe(false);
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

describe("invitationPreviewQuery", () => {
  const { api } = offlineApi();

  test("is dropped from the cache as soon as nothing shows it, and a refusal is not retried", () => {
    const options = invitationPreviewQuery(api, "secret-token");
    expect(options.gcTime).toBe(0);
    const retry = options.retry as (count: number, error: unknown) => boolean;
    for (const status of [401, 404, 410]) {
      expect(retry(0, new WorkspaceApiError(status, "invitation_not_found", "invitation not found"))).toBe(false);
    }
  });

  test("the token's query is gone from the cache after it settles with no observer", async () => {
    const client = new QueryClient();
    const live = createWorkspaceApi({ basePath: "/api/workspaces" });
    const fetched = spyOn(globalThis, "fetch").mockImplementation((async () =>
      Response.json({ error: "invitation_not_found", error_description: "invitation not found" }, { status: 404 })) as unknown as typeof fetch);
    try {
      await client.prefetchQuery(invitationPreviewQuery(live, "secret-token"));
      expect(fetched).toHaveBeenCalledTimes(1);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(client.getQueryCache().getAll()).toEqual([]);
      expect(JSON.stringify(client.getQueryCache().getAll().map((query) => query.queryKey))).not.toContain("secret-token");
    } finally {
      fetched.mockRestore();
      client.clear();
    }
  });
});

describe("billing's queries", () => {
  const catalogBody = { locale: "en", products: [] };
  const statusBody = { locale: "en", licenses: [], total: null, actions: [], testMode: null, purchase: null };

  function billingFor(...bodies: unknown[]) {
    const urls: string[] = [];
    const answers = [...bodies];
    const billing = createBillingApi({
      locale: "en-US",
      fetch: (async (input: RequestInfo | URL) => {
        urls.push(String(input));
        return Response.json(answers.shift() ?? {});
      }) as unknown as typeof fetch,
    });
    return { billing, urls };
  }

  test("the catalog and the status are read through the billing client, parsed with the contract", async () => {
    const { billing, urls } = billingFor(catalogBody, statusBody);
    const client = new QueryClient();
    expect(await client.fetchQuery(billingCatalogQuery(billing, workspaceScope(WORKSPACE_ID)))).toEqual(catalogBody);
    expect(await client.fetchQuery(billingStatusQuery(billing, workspaceScope(WORKSPACE_ID), "pur_1"))).toEqual(statusBody);
    expect(urls).toEqual([
      `/api/portal/billing/workspaces/${WORKSPACE_ID}/catalog?locale=en-US`,
      `/api/portal/billing/workspaces/${WORKSPACE_ID}/status?locale=en-US&purchase=pur_1`,
    ]);
  });

  test("an answer that doesn't match the contract fails the query", async () => {
    const { billing } = billingFor({ locale: "en", products: "none" });
    const client = new QueryClient();
    const error = await client.fetchQuery({ ...billingCatalogQuery(billing, ACCOUNT_SCOPE), retry: false }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BillingUnavailableError);
  });

  test("keys are per owner, per locale and per purchase, and a workspace's start with its id", () => {
    const { billing } = billingFor();
    const german = createBillingApi({ locale: "de-DE" });
    const ws = workspaceScope(WORKSPACE_ID);
    expect(billingKeys.catalog(billing, ws)).not.toEqual(billingKeys.catalog(billing, ACCOUNT_SCOPE));
    expect(billingKeys.catalog(billing, ws)).not.toEqual(billingKeys.catalog(german, ws));
    expect(billingKeys.status(billing, ws, "pur_1")).not.toEqual(billingKeys.status(billing, ws, null));
    expect(billingKeys.status(billing, ws, undefined)).toEqual(billingKeys.status(billing, ws, null));
    for (const key of [billingKeys.catalog(billing, ws), billingKeys.status(billing, ws, "pur_1")]) {
      expect(key.slice(0, billingKeys.owner(ws).length)).toEqual([...billingKeys.owner(ws)]);
    }
    expect(JSON.stringify(billingKeys.owner(ACCOUNT_SCOPE))).not.toContain(WORKSPACE_ID);
  });

  test("a refusal (4xx) isn't retried, and an unavailable answer or a 5xx gets one more try", () => {
    const { billing } = billingFor();
    const retry = billingStatusQuery(billing, ACCOUNT_SCOPE).retry as (count: number, error: unknown) => boolean;
    expect(retry(0, new BillingRefusedError("forbidden", {}, 403))).toBe(false);
    expect(retry(0, new BillingRefusedError("billing_unavailable", {}, 503))).toBe(true);
    expect(retry(1, new BillingRefusedError("billing_unavailable", {}, 503))).toBe(false);
    expect(retry(0, new BillingUnavailableError("network"))).toBe(true);
    expect(retry(1, new BillingUnavailableError("network"))).toBe(false);
  });

  test("a workspace mutation (a seat given, a seat taken back) marks that workspace's billing stale too, and no other owner's", async () => {
    const { api } = offlineApi();
    const { billing } = billingFor();
    const client = new QueryClient();
    const mine = workspaceScope(WORKSPACE_ID);
    const other = workspaceScope(OTHER_ID);
    client.setQueryData(billingKeys.status(billing, mine, null), statusBody);
    client.setQueryData(billingKeys.catalog(billing, mine), catalogBody);
    client.setQueryData(billingKeys.status(billing, other, null), statusBody);
    client.setQueryData(billingKeys.status(billing, ACCOUNT_SCOPE, null), statusBody);
    client.setQueryData(workspaceKeys.licenses(api, WORKSPACE_ID), []);
    client.setQueryData(workspaceKeys.members(api, WORKSPACE_ID), []);
    const observer = new MutationObserver(client, workspaceMutationOptions(client, api, WORKSPACE_ID, async () => "done"));
    await observer.mutate(undefined);
    expect(stale(client, workspaceKeys.licenses(api, WORKSPACE_ID))).toBe(true);
    expect(stale(client, workspaceKeys.members(api, WORKSPACE_ID))).toBe(true);
    expect(stale(client, billingKeys.status(billing, mine, null))).toBe(true);
    expect(stale(client, billingKeys.catalog(billing, mine))).toBe(true);
    expect(stale(client, billingKeys.status(billing, other, null))).toBe(false);
    expect(stale(client, billingKeys.status(billing, ACCOUNT_SCOPE, null))).toBe(false);
  });

  test("a license that changed under the caller refreshes billing's status as well", async () => {
    const { api } = offlineApi();
    const { billing } = billingFor();
    const client = new QueryClient();
    const mine = workspaceScope(WORKSPACE_ID);
    client.setQueryData(billingKeys.status(billing, mine, null), statusBody);
    const observer = new MutationObserver(
      client,
      workspaceMutationOptions(client, api, WORKSPACE_ID, async () => {
        throw new WorkspaceApiError(409, "no_seats_available", "not enough seats");
      }),
    );
    await observer.mutate(undefined).catch(() => {});
    expect(stale(client, billingKeys.status(billing, mine, null))).toBe(true);
  });

  test("a workspace that is gone takes its billing answers with it", async () => {
    const { api } = offlineApi();
    const { billing } = billingFor();
    const client = new QueryClient();
    const mine = workspaceScope(WORKSPACE_ID);
    const other = workspaceScope(OTHER_ID);
    client.setQueryData(billingKeys.status(billing, mine, null), statusBody);
    client.setQueryData(billingKeys.status(billing, other, null), statusBody);
    const observer = new MutationObserver(
      client,
      workspaceMutationOptions(client, api, WORKSPACE_ID, async () => undefined, { workspaceGone: true }),
    );
    await observer.mutate(undefined);
    expect(client.getQueryData(billingKeys.status(billing, mine, null))).toBeUndefined();
    expect(client.getQueryData(billingKeys.status(billing, other, null))).toBeDefined();
  });
});
