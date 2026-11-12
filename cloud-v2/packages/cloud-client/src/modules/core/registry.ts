/**
 * @fileoverview `cloud.core.registry`: the Mentra App's registry calls, over Core's `/api/client/registry` router.
 *
 *   POST /register  at each install of a miniapp URL; Core verifies the URL and answers
 *                   `accepted` (with Core's verified `miniapp.json`), `accepted_unverified`, `not_a_miniapp` or
 *                   `archived`
 *   POST /status    one batch of installed URLs and versions; Core answers `active`, `archived` or `unknown` for
 *                   each, and how long the answer stays valid
 *
 * Each call is made as the account whose Core token it carries (see `account-call.ts`): an answer that comes back
 * after the account changed is discarded as `SessionChangedError`, and a 401 refreshes the token once. A failure keeps
 * Core's status and error code on a `CoreRequestError`: `email_unverified` (403), `rate_limited` (429, with
 * `retryAfterSeconds`), `invalid_request` (400), `unavailable` (503), `network_error` (no answer). An answer of
 * another shape, or a `result` this client doesn't know, is a `CoreResponseError`, never a guess.
 */
import {
  RegistryRegisterResponseSchema,
  RegistryStatusResponseSchema,
  type RegistryRegisterRequest,
  type RegistryRegisterResponse,
  type RegistryStatusRequest,
  type RegistryStatusResponse,
} from "@mentra/cloud-protocol"
import type {HttpClient} from "../../http"
import {AccountCaller, CoreResponseError, type AccountCallOptions, type CoreTokenSource} from "./account-call"

const REGISTER_PATH = "/api/client/registry/register"
const STATUS_PATH = "/api/client/registry/status"
const KNOWN_RESULTS = new Set(["accepted", "accepted_unverified", "not_a_miniapp", "archived"])

export class Registry {
  private readonly caller: AccountCaller

  constructor(
    private readonly http: HttpClient,
    auth?: CoreTokenSource,
  ) {
    this.caller = new AccountCaller(auth)
  }

  /**
   * Registers a miniapp URL at install. `reported` is what the phone read from `<url>/miniapp.json`; Core keeps it
   * only when it can't read the URL itself. Resolves with Core's verdict; rejects for every failure (see the file
   * comment), so a caller can tell "Core said no" from "Core didn't answer".
   */
  async registerMiniappUrl(request: RegistryRegisterRequest, opts?: AccountCallOptions): Promise<RegistryRegisterResponse> {
    const body = await this.caller.run(
      (bearer) =>
        this.http.post<unknown>(REGISTER_PATH, request, {
          bearer,
          // Registering a URL twice gives the same answer, so a transient network failure may be retried.
          idempotent: true,
          ...(opts?.signal ? {signal: opts.signal} : {}),
        }),
      opts,
    )
    const parsed = RegistryRegisterResponseSchema.safeParse(body)
    if (parsed.success) return parsed.data
    const result = typeof body === "object" && body !== null && "result" in body ? body.result : undefined
    throw new CoreResponseError(
      typeof result === "string" && !KNOWN_RESULTS.has(result) ? "unknown_status" : "invalid_shape",
    )
  }

  /** The registry status of each installed URL, in the order sent, with how long the answer stays valid. */
  async registryStatus(request: RegistryStatusRequest, opts?: AccountCallOptions): Promise<RegistryStatusResponse> {
    const body = await this.caller.run(
      (bearer) =>
        this.http.post<unknown>(STATUS_PATH, request, {
          bearer,
          // A read: safe to retry.
          idempotent: true,
          ...(opts?.signal ? {signal: opts.signal} : {}),
        }),
      opts,
    )
    const parsed = RegistryStatusResponseSchema.safeParse(body)
    if (!parsed.success || parsed.data.statuses.length !== request.entries.length) {
      throw new CoreResponseError("invalid_shape")
    }
    return parsed.data
  }
}
