/** How a billing call fails, and the words for it. Schema-free: see `billing-scope.ts`. */

import { refusalMessage, type RefusalContext } from "./strings/licenses";

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
 * Billing answered, but not as the contract says: the shape doesn't match, or a hosted `url` is one the portal won't
 * follow. It is "unavailable" to a screen like any {@link BillingUnavailableError}, but asking again gets the same
 * answer, so the query layer does not retry it.
 */
export class BillingContractError extends BillingUnavailableError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "BillingContractError";
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
 * again." for any other refusal, an unavailable answer or anything else. `context` names the product, for the refusals that say so.
 */
export function billingErrorMessage(error: unknown, context: RefusalContext = {}): string {
  return refusalMessage(error instanceof BillingRefusedError ? error.code : "", context);
}
