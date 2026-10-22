/**
 * @fileoverview The portal's client for billing's data module, through Core's forwarding at
 * `/api/portal/billing`. Billing builds its answers with the contract's schemas
 * (`@mentra/workspace-contract/portal-billing`) and every answer is parsed with the same ones here, so what a
 * screen receives is typed and checked: an unknown status, action kind, tax value or price scheme arrives with
 * its value kept, and an answer that doesn't match the contract (or a hosted `url` the portal may not follow)
 * is {@link BillingContractError}, a {@link BillingUnavailableError}, which a screen shows as its "unavailable" state.
 *
 * Every request carries the portal's `locale`: a query parameter on `GET`s, a body field on `POST`s. Calls send
 * the session cookie to the same origin only, and nothing is cached here: the screens cache through TanStack
 * Query (`billingCatalogQuery`, `billingStatusQuery`).
 */

import {
  BillingCatalogSchema,
  BillingStatusSchema,
  PurchaseAnswerSchema,
  SessionAnswerSchema,
  type BillingCatalog,
  type BillingStatus,
  type PurchaseAnswer,
  type SessionAnswer,
} from "@mentra/workspace-contract/portal-billing";
import type { FetchLike } from "./api";
import { BillingContractError, BillingRefusedError, BillingUnavailableError } from "./billing-errors";
import type { BillingScope } from "./billing-scope";

// The scope and the errors live in schema-free modules (the query layer imports those, not this file); they are
// re-exported here so a screen that uses the client has one place to import from.
export { billingErrorMessage, BillingContractError, BillingRefusedError, BillingUnavailableError } from "./billing-errors";
export { workspaceScope, type BillingScope } from "./billing-scope";

export interface BillingApi {
  /** The base path without a trailing slash. It also scopes this client's query-cache keys. */
  readonly base: string;
  /** The locale sent with every request: the portal's own. */
  readonly locale: string;

  /** The products a workspace is shown. Display content only unless the viewer may manage the owner's billing. */
  catalog(scope: BillingScope): Promise<BillingCatalog>;
  /** The owner's licenses as billing reads them, with the owner's total and actions. `purchase` is the `?purchase=` a checkout returned with. */
  status(scope: BillingScope, options?: { purchase?: string | null }): Promise<BillingStatus>;
  /** Starts one checkout of `product` for `seats`: the hosted page to send the browser to. */
  purchase(scope: BillingScope, request: { product: string; seats: number }): Promise<PurchaseAnswer>;
  /** The hosted page for a billing action (`licenseId` names its license; `seats` is how many `add_seats` adds). */
  session(scope: BillingScope, request: { action: string; licenseId?: string; seats?: number }): Promise<SessionAnswer>;
}

/**
 * A client for billing under `opts.base`. `opts.fetch` defaults to the global `fetch`, looked up on each call so
 * a host (or a test) that replaces it later is honored; `opts.locale` is a BCP 47 tag, the portal's own.
 */
export function createBillingApi(opts: {
  locale: string;
  fetch?: FetchLike;
  base?: string;
  credentials?: RequestCredentials;
}): BillingApi {
  const base = (opts.base ?? "/api/portal/billing").replace(/\/+$/, "");
  const doFetch: FetchLike = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const { locale } = opts;

  const owner = (scope: BillingScope) => `/workspaces/${encodeURIComponent(scope.workspaceId)}`;

  async function send(method: "GET" | "POST", path: string, body?: Record<string, unknown>): Promise<unknown> {
    const headers: Record<string, string> = { accept: "application/json" };
    const init: RequestInit = { method, headers, credentials: opts.credentials ?? "same-origin" };
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    let response: Response;
    try {
      response = await doFetch(`${base}${path}`, init);
    } catch (cause) {
      throw new BillingUnavailableError("could not reach billing", { cause });
    }
    if (!response.ok) throw await refusal(response);
    try {
      return await response.json();
    } catch (cause) {
      throw new BillingUnavailableError("billing sent a response that is not JSON", { cause });
    }
  }

  function parse<T>(schema: Schema<T>, value: unknown, what: string): T {
    const result = schema.safeParse(value);
    if (result.success) return result.data;
    // Paths only: the values may be a person's.
    const where = [...new Set(result.error.issues.slice(0, 5).map((issue) => issue.path.join(".") || "(root)"))].join(", ");
    throw new BillingContractError(`billing's ${what} doesn't match the contract: ${where}`, { cause: result.error });
  }

  return {
    base,
    locale,

    catalog: async (scope) =>
      parse(BillingCatalogSchema, await send("GET", `${owner(scope)}/catalog?${new URLSearchParams({ locale })}`), "catalog"),

    status: async (scope, options = {}) => {
      const query = new URLSearchParams({ locale });
      if (options.purchase) query.set("purchase", options.purchase);
      return parse(BillingStatusSchema, await send("GET", `${owner(scope)}/status?${query}`), "status");
    },

    purchase: async (scope, request) =>
      parse(
        PurchaseAnswerSchema,
        await send("POST", `${owner(scope)}/purchase`, { product: request.product, seats: request.seats, locale }),
        "purchase answer",
      ),

    session: async (scope, request) => {
      // Absent optional fields stay out of the body: billing reads a missing field as "none".
      const body: Record<string, unknown> = { action: request.action };
      if (request.licenseId !== undefined) body.licenseId = request.licenseId;
      if (request.seats !== undefined) body.seats = request.seats;
      body.locale = locale;
      return parse(SessionAnswerSchema, await send("POST", `${owner(scope)}/session`, body), "session answer");
    },
  };
}

/** The part of a zod schema this file needs, so the package doesn't depend on zod for a type. */
interface Schema<T> {
  safeParse(value: unknown): { success: true; data: T } | { success: false; error: { issues: ReadonlyArray<{ path: ReadonlyArray<string | number> }> } };
}

/** A non-2xx answer: a refusal when it is `{error}`, and "unavailable" when it is anything else (a gateway's page). */
async function refusal(response: Response): Promise<BillingRefusedError | BillingUnavailableError> {
  try {
    const body = (await response.json()) as Record<string, unknown> | null;
    if (body !== null && typeof body === "object" && typeof body.error === "string" && body.error !== "") {
      const { error, ...details } = body;
      return new BillingRefusedError(error, details, response.status);
    }
  } catch {
    // Not JSON: a proxy's error page, for instance.
  }
  return new BillingUnavailableError(`billing answered ${response.status}`);
}
