/**
 * @fileoverview The portal's client for billing's data module, through Core's forwarding at
 * `/api/portal/billing`. Billing builds its answers with the contract's schemas
 * (`@mentra/workspace-contract/portal-billing`) and every answer is parsed with the same ones here, so what a
 * screen receives is typed and checked: an unknown status, action kind, tax value or price scheme arrives with
 * its value kept, and an answer that doesn't match the contract (or a hosted `url` the portal may not follow)
 * is {@link BillingUnavailableError}, which a screen shows as its "unavailable" state.
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
import { refusalMessage, type LicenseScope, type RefusalContext } from "./strings/licenses";

/** Whose billing: a workspace's, or the signed-in person's own (the personal Billing page). */
export type BillingScope = { kind: "workspace"; workspaceId: string } | { kind: "account" };

/** The signed-in person's own billing. */
export const ACCOUNT_SCOPE: BillingScope = { kind: "account" };

export const workspaceScope = (workspaceId: string): BillingScope => ({ kind: "workspace", workspaceId });

/** The owner type a scope sells to: a workspace's licenses, or a person's own. */
export const ownerTypeOf = (scope: BillingScope): LicenseScope => (scope.kind === "workspace" ? "workspace" : "person");

/**
 * Billing couldn't be read: the connection dropped, a gateway answered instead of billing, or what billing sent
 * doesn't match the contract (including a hosted `url` the portal won't follow). The screens show their
 * "unavailable" state, or the generic refusal line for an action.
 */
export class BillingUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "BillingUnavailableError";
  }
}

/**
 * A refusal: `{error}` with a code (billing's own, such as `already_licensed`, or Core's, such as
 * `unauthorized`), and whatever else the body carried in `details` (`{licenseId}` for `already_licensed`).
 * `status` is the HTTP status.
 */
export class BillingRefusedError extends Error {
  constructor(
    readonly code: string,
    readonly details: Record<string, unknown> = {},
    readonly status = 0,
  ) {
    super(code);
    this.name = "BillingRefusedError";
  }
}

/**
 * The words for a failed billing call: Core's line for a refusal it knows, and "Billing couldn't do that. Try
 * again." for any other refusal, an unavailable answer or anything else. `context` names the product and whether
 * it is a workspace's or a person's, for the refusals that say so.
 */
export function billingErrorMessage(error: unknown, context: RefusalContext = {}): string {
  return refusalMessage(error instanceof BillingRefusedError ? error.code : "", context);
}

export interface BillingApi {
  /** The base path without a trailing slash. It also scopes this client's query-cache keys. */
  readonly base: string;
  /** The locale sent with every request: the portal's own. */
  readonly locale: string;

  /** The products for the scope's owner type. Display content only unless the viewer may manage the owner's billing. */
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

  const owner = (scope: BillingScope) =>
    scope.kind === "workspace" ? `/workspaces/${encodeURIComponent(scope.workspaceId)}` : "/account";

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
    throw new BillingUnavailableError(`billing's ${what} doesn't match the contract: ${where}`, { cause: result.error });
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
