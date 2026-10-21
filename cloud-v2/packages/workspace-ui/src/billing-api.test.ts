import { describe, expect, test } from "bun:test";
import type { BillingCatalog, BillingStatus } from "@mentra/workspace-contract/portal-billing";
import {
  ACCOUNT_SCOPE,
  BillingContractError,
  BillingRefusedError,
  BillingUnavailableError,
  billingErrorMessage,
  createBillingApi,
  workspaceScope,
} from "./billing-api";
import { runtimeImports } from "./test-imports";

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
  credentials: string | undefined;
}

/** A fetch that records every request and answers each with the next canned response. */
function recordingFetch(...responses: Array<Response | (() => Response | Promise<Response>)>) {
  const calls: Recorded[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body,
      credentials: init?.credentials,
    });
    const next = responses.shift() ?? Response.json({});
    return typeof next === "function" ? next() : next;
  }) as unknown as typeof fetch;
  return { fetch: impl, calls };
}

const usd = (amountMinor: number) => ({ amountMinor, currency: "USD" });
const WORKSPACE = workspaceScope("ws_acme");

const CATALOG: BillingCatalog = {
  locale: "en",
  products: [
    {
      product: "mentra.call.unlimited",
      name: "Mentra Call Unlimited",
      shortName: "Call Unlimited",
      description: "Unlimited calls.",
      icon: "/api/portal/billing/ui/icons/call.png",
      features: [{ key: "call.unlimited", name: "Unlimited calls", appName: "Mentra Call" }],
      ownerTypes: ["workspace", "person"],
      offer: {
        price: { scheme: "per_seat", unit: usd(2900), recurrence: { interval: "month", count: 1 } },
        tax: "excluded",
        buy: { minSeats: 1, maxSeats: 500, defaultSeats: 5 },
      },
    },
  ],
};

const STATUS: BillingStatus = {
  locale: "en",
  licenses: [
    {
      licenseId: "lic_1",
      product: "mentra.call.unlimited",
      status: "active",
      fallbackStatusLabel: "Active",
      renewsAt: "2026-11-20T00:00:00Z",
      price: { scheme: "per_seat", unit: usd(2900), recurrence: { interval: "month", count: 1 } },
      quantity: 5,
      total: usd(14500),
      tax: "excluded",
      actions: [{ kind: "add_seats", fallbackLabel: "Add licenses" }],
    },
  ],
  total: { amount: usd(14500), recurrence: { interval: "month", count: 1 }, tax: "excluded", licenseCount: 1 },
  actions: [{ kind: "billing_and_invoices", fallbackLabel: "Billing & invoices" }],
  testMode: null,
  purchase: null,
};

describe("createBillingApi: routes and the locale", () => {
  test("reads a workspace's catalog from GET catalog?locale=, with the cookie and no body", async () => {
    const rec = recordingFetch(Response.json(CATALOG));
    const billing = createBillingApi({ fetch: rec.fetch, locale: "en-GB" });
    expect(await billing.catalog(WORKSPACE)).toEqual(CATALOG);
    expect(rec.calls[0]).toMatchObject({
      url: "/api/portal/billing/workspaces/ws_acme/catalog?locale=en-GB",
      method: "GET",
      credentials: "same-origin",
    });
    expect(rec.calls[0]!.headers.accept).toBe("application/json");
    expect(rec.calls[0]!.body).toBeUndefined();
  });

  test("reads the account's catalog and status under /account", async () => {
    const rec = recordingFetch(Response.json(CATALOG), Response.json(STATUS));
    const billing = createBillingApi({ fetch: rec.fetch, locale: "en-US" });
    await billing.catalog(ACCOUNT_SCOPE);
    await billing.status(ACCOUNT_SCOPE, {});
    expect(rec.calls.map((call) => call.url)).toEqual([
      "/api/portal/billing/account/catalog?locale=en-US",
      "/api/portal/billing/account/status?locale=en-US",
    ]);
  });

  test("status carries the purchase to look up, when there is one, and the locale", async () => {
    const rec = recordingFetch(Response.json(STATUS), Response.json(STATUS));
    const billing = createBillingApi({ fetch: rec.fetch, locale: "de-DE" });
    await billing.status(WORKSPACE, { purchase: "pur_01ABC" });
    await billing.status(WORKSPACE, { purchase: null });
    expect(rec.calls[0]!.url).toBe("/api/portal/billing/workspaces/ws_acme/status?locale=de-DE&purchase=pur_01ABC");
    expect(rec.calls[1]!.url).toBe("/api/portal/billing/workspaces/ws_acme/status?locale=de-DE");
  });

  test("a purchase POSTs the product, the seats and the locale, and answers the hosted url", async () => {
    const rec = recordingFetch(Response.json({ url: "https://pay.example.test/checkout/abc" }));
    const billing = createBillingApi({ fetch: rec.fetch, locale: "en-US" });
    expect(await billing.purchase(WORKSPACE, { product: "mentra.call.unlimited", seats: 10 })).toEqual({
      url: "https://pay.example.test/checkout/abc",
    });
    expect(rec.calls[0]).toMatchObject({
      url: "/api/portal/billing/workspaces/ws_acme/purchase",
      method: "POST",
      body: { product: "mentra.call.unlimited", seats: 10, locale: "en-US" },
    });
    expect(rec.calls[0]!.headers["content-type"]).toBe("application/json");
  });

  test("a session POSTs the action, and only the license and seats it was given, with the locale", async () => {
    const rec = recordingFetch(
      Response.json({ url: "https://billing.example.test/s/1" }),
      Response.json({ url: "https://billing.example.test/s/2" }),
    );
    const billing = createBillingApi({ fetch: rec.fetch, locale: "en-US" });
    await billing.session(WORKSPACE, { action: "add_seats", licenseId: "lic_1", seats: 2 });
    await billing.session(WORKSPACE, { action: "billing_and_invoices" });
    expect(rec.calls[0]!.body).toEqual({ action: "add_seats", licenseId: "lic_1", seats: 2, locale: "en-US" });
    expect(rec.calls[0]!.url).toBe("/api/portal/billing/workspaces/ws_acme/session");
    expect(rec.calls[1]!.body).toEqual({ action: "billing_and_invoices", locale: "en-US" });
  });

  test("every request of every kind carries the locale", async () => {
    const rec = recordingFetch(
      Response.json(CATALOG),
      Response.json(STATUS),
      Response.json({ url: "https://pay.example.test/c" }),
      Response.json({ url: "https://pay.example.test/s" }),
    );
    const billing = createBillingApi({ fetch: rec.fetch, locale: "fr-CA" });
    await billing.catalog(WORKSPACE);
    await billing.status(WORKSPACE, {});
    await billing.purchase(ACCOUNT_SCOPE, { product: "p", seats: 1 });
    await billing.session(ACCOUNT_SCOPE, { action: "billing_and_invoices" });
    expect(new URL(rec.calls[0]!.url, "https://x.test").searchParams.get("locale")).toBe("fr-CA");
    expect(new URL(rec.calls[1]!.url, "https://x.test").searchParams.get("locale")).toBe("fr-CA");
    expect((rec.calls[2]!.body as { locale: string }).locale).toBe("fr-CA");
    expect((rec.calls[3]!.body as { locale: string }).locale).toBe("fr-CA");
  });

  test("honors a different base path, ignores its trailing slash, and escapes the workspace id", async () => {
    const rec = recordingFetch(Response.json(CATALOG));
    const billing = createBillingApi({ fetch: rec.fetch, locale: "en-US", base: "/proxy/billing/" });
    await billing.catalog(workspaceScope("ws/odd id"));
    expect(rec.calls[0]!.url).toBe("/proxy/billing/workspaces/ws%2Fodd%20id/catalog?locale=en-US");
  });

  test("exposes the base and locale it was built with", () => {
    const billing = createBillingApi({ fetch: recordingFetch().fetch, locale: "en-GB" });
    expect(billing.base).toBe("/api/portal/billing");
    expect(billing.locale).toBe("en-GB");
  });
});

describe("createBillingApi: answers that don't match the contract", () => {
  test("a catalog that doesn't match throws BillingUnavailableError", async () => {
    const rec = recordingFetch(Response.json({ locale: "en", products: [{ product: "p" }] }));
    const billing = createBillingApi({ fetch: rec.fetch, locale: "en-US" });
    await expect(billing.catalog(WORKSPACE)).rejects.toBeInstanceOf(BillingUnavailableError);
  });

  test("so does a status that doesn't match, and an answer that isn't JSON", async () => {
    const rec = recordingFetch(
      Response.json({ ...STATUS, licenses: [{ ...STATUS.licenses[0], renewsAt: "next Tuesday" }] }),
      new Response("<html>bad gateway</html>", { status: 200 }),
    );
    const billing = createBillingApi({ fetch: rec.fetch, locale: "en-US" });
    await expect(billing.status(WORKSPACE, {})).rejects.toBeInstanceOf(BillingUnavailableError);
    await expect(billing.status(WORKSPACE, {})).rejects.toBeInstanceOf(BillingUnavailableError);
  });

  test("a mismatch (and a url the portal won't follow) is a BillingContractError, which a dropped connection or a proxy's page is not", async () => {
    const rec = recordingFetch(
      Response.json({ locale: "en", products: [{ product: "p" }] }),
      Response.json({ url: "javascript:alert(1)" }),
      new Response("<html>bad gateway</html>", { status: 200 }),
      new Response("<html>bad gateway</html>", { status: 502 }),
    );
    const billing = createBillingApi({ fetch: rec.fetch, locale: "en-US" });
    const errors = [
      await billing.catalog(WORKSPACE).catch((e: unknown) => e),
      await billing.session(WORKSPACE, { action: "cancel" }).catch((e: unknown) => e),
      await billing.status(WORKSPACE, {}).catch((e: unknown) => e),
      await billing.status(WORKSPACE, {}).catch((e: unknown) => e),
    ];
    // Every one is "unavailable" to a screen, but only the first two would be answered the same way again.
    expect(errors.map((error) => error instanceof BillingUnavailableError)).toEqual([true, true, true, true]);
    expect(errors.map((error) => error instanceof BillingContractError)).toEqual([true, true, false, false]);
  });

  test("a dropped connection and a proxy's error page are 'unavailable' too, not a refusal", async () => {
    const billing = createBillingApi({
      fetch: (async () => {
        throw new TypeError("network down");
      }) as unknown as typeof fetch,
      locale: "en-US",
    });
    await expect(billing.catalog(WORKSPACE)).rejects.toBeInstanceOf(BillingUnavailableError);

    const proxy = recordingFetch(new Response("<html>Bad gateway</html>", { status: 502 }));
    const behindProxy = createBillingApi({ fetch: proxy.fetch, locale: "en-US" });
    await expect(behindProxy.status(WORKSPACE, {})).rejects.toBeInstanceOf(BillingUnavailableError);
  });

  test("a purchase or session url that is not a hosted page is refused as unavailable, never handed back", async () => {
    const rec = recordingFetch(
      Response.json({ url: "javascript:alert(1)" }),
      Response.json({ url: "http://evil.example.test/pay" }),
      Response.json({ url: "https://user:pw@pay.example.test/x" }),
      Response.json({}),
    );
    const billing = createBillingApi({ fetch: rec.fetch, locale: "en-US" });
    await expect(billing.purchase(WORKSPACE, { product: "p", seats: 1 })).rejects.toBeInstanceOf(BillingUnavailableError);
    await expect(billing.session(WORKSPACE, { action: "cancel", licenseId: "lic_1" })).rejects.toBeInstanceOf(
      BillingUnavailableError,
    );
    await expect(billing.purchase(WORKSPACE, { product: "p", seats: 1 })).rejects.toBeInstanceOf(BillingUnavailableError);
    await expect(billing.session(WORKSPACE, { action: "cancel" })).rejects.toBeInstanceOf(BillingUnavailableError);
  });

  test("a local development address is a hosted page, and the answer is its canonical form", async () => {
    const rec = recordingFetch(Response.json({ url: "http://localhost:4242/pay" }), Response.json({ url: " https://pay.example.test/a b " }));
    const billing = createBillingApi({ fetch: rec.fetch, locale: "en-US" });
    expect(await billing.purchase(WORKSPACE, { product: "p", seats: 1 })).toEqual({ url: "http://localhost:4242/pay" });
    expect(await billing.session(WORKSPACE, { action: "cancel" })).toEqual({ url: "https://pay.example.test/a%20b" });
  });
});

describe("createBillingApi: values it doesn't know", () => {
  test("an unknown status, action kind, tax value and price scheme survive, and unknown fields are dropped", async () => {
    const body = {
      ...STATUS,
      surprise: true,
      licenses: [
        {
          ...STATUS.licenses[0],
          status: "paused",
          fallbackStatusLabel: "Paused",
          tax: "reverse_charge",
          price: { scheme: "tiered", fallbackLabel: "From $10 per user a month" },
          total: null,
          actions: [{ kind: "pause_collection", fallbackLabel: "Pause billing", returns: false }],
          extra: 1,
        },
      ],
    };
    const billing = createBillingApi({ fetch: recordingFetch(Response.json(body)).fetch, locale: "en-US" });
    const status = await billing.status(WORKSPACE, {});
    expect(status.licenses[0]).toMatchObject({
      status: "paused",
      fallbackStatusLabel: "Paused",
      tax: "reverse_charge",
      price: { scheme: "tiered", fallbackLabel: "From $10 per user a month" },
      total: null,
      actions: [{ kind: "pause_collection", fallbackLabel: "Pause billing", returns: false }],
    });
    expect(status).not.toHaveProperty("surprise");
    expect(status.licenses[0]).not.toHaveProperty("extra");
  });

  test("an icon outside billing's own path parses to null instead of failing the catalog", async () => {
    const body = { ...CATALOG, products: [{ ...CATALOG.products[0], icon: "https://cdn.example.test/icon.png" }] };
    const billing = createBillingApi({ fetch: recordingFetch(Response.json(body)).fetch, locale: "en-US" });
    expect((await billing.catalog(WORKSPACE)).products[0]!.icon).toBeNull();
  });
});

describe("createBillingApi: refusals", () => {
  test("a 409 already_licensed becomes BillingRefusedError with the license it names", async () => {
    const rec = recordingFetch(
      Response.json({ error: "already_licensed", licenseId: "lic_9" }, { status: 409 }),
    );
    const billing = createBillingApi({ fetch: rec.fetch, locale: "en-US" });
    const error = await billing.purchase(WORKSPACE, { product: "p", seats: 1 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BillingRefusedError);
    const refused = error as BillingRefusedError;
    expect(refused.code).toBe("already_licensed");
    expect(refused.details).toEqual({ licenseId: "lic_9" });
    expect(refused.status).toBe(409);
  });

  test("a refusal with only its code has empty details, and a 503 from billing is still its code", async () => {
    const rec = recordingFetch(
      Response.json({ error: "checkout_in_progress" }, { status: 409 }),
      Response.json({ error: "billing_unavailable" }, { status: 503 }),
    );
    const billing = createBillingApi({ fetch: rec.fetch, locale: "en-US" });
    const first = (await billing.purchase(WORKSPACE, { product: "p", seats: 1 }).catch((e: unknown) => e)) as BillingRefusedError;
    expect([first.code, first.details]).toEqual(["checkout_in_progress", {}]);
    const second = (await billing.session(WORKSPACE, { action: "cancel" }).catch((e: unknown) => e)) as BillingRefusedError;
    expect([second.code, second.status]).toEqual(["billing_unavailable", 503]);
  });

  test("Core's own refusals arrive the same way, by their code", async () => {
    const rec = recordingFetch(Response.json({ error: "unauthorized", error_description: "expired" }, { status: 401 }));
    const billing = createBillingApi({ fetch: rec.fetch, locale: "en-US" });
    const error = (await billing.catalog(WORKSPACE).catch((e: unknown) => e)) as BillingRefusedError;
    expect(error).toBeInstanceOf(BillingRefusedError);
    expect(error.code).toBe("unauthorized");
  });
});

describe("billingErrorMessage", () => {
  const refused = (code: string, details: Record<string, unknown> = {}) => new BillingRefusedError(code, details, 409);

  test("words the refusals the screens act on, with the product's name", () => {
    expect(billingErrorMessage(refused("already_licensed"), { product: "Mentra Call Unlimited" })).toBe(
      "You already have Mentra Call Unlimited. Add licenses instead.",
    );
    expect(billingErrorMessage(refused("already_licensed"), { product: "Mentra Call Unlimited", scope: "person" })).toBe(
      "You already have Mentra Call Unlimited.",
    );
    expect(billingErrorMessage(refused("checkout_in_progress"), { product: "Mentra Call Unlimited" })).toBe(
      "A purchase of Mentra Call Unlimited is already under way. Finish it, or try again in a minute.",
    );
  });

  test("a code Core doesn't know, an unavailable answer and anything else are 'Billing couldn't do that. Try again.'", () => {
    expect(billingErrorMessage(refused("something_new"), {})).toBe("Billing couldn't do that. Try again.");
    expect(billingErrorMessage(new BillingUnavailableError("mismatch"), {})).toBe("Billing couldn't do that. Try again.");
    expect(billingErrorMessage(new Error("boom"), {})).toBe("Billing couldn't do that. Try again.");
  });
});

describe("what a screen that doesn't use billing pulls in", () => {
  test("the query layer reaches neither the contract's schemas nor zod, so embedders that don't use billing don't carry them", () => {
    const { files, specifiers } = runtimeImports("queries.ts");
    expect(specifiers.filter((specifier) => /portal-billing|^zod/.test(specifier))).toEqual([]);
    expect(files.some((file) => file.endsWith("billing-api.ts"))).toBe(false);
  });

  test("the scope and the errors are in modules of their own, and billing-api still re-exports them", async () => {
    for (const entry of ["billing-scope.ts", "billing-errors.ts"]) {
      expect(runtimeImports(entry).specifiers.filter((specifier) => /portal-billing|^zod/.test(specifier))).toEqual([]);
    }
    const scope = await import("./billing-scope");
    const errors = await import("./billing-errors");
    const api = await import("./billing-api");
    expect(api.BillingRefusedError).toBe(errors.BillingRefusedError);
    expect(api.BillingUnavailableError).toBe(errors.BillingUnavailableError);
    expect(api.billingErrorMessage).toBe(errors.billingErrorMessage);
    expect(api.workspaceScope).toBe(scope.workspaceScope);
    expect(api.ACCOUNT_SCOPE).toBe(scope.ACCOUNT_SCOPE);
    expect(api.ownerTypeOf).toBe(scope.ownerTypeOf);
  });
});
