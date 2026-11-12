/**
 * @fileoverview `cloud.core.account`: what the phone keeps on the signed-in person's Core account, over Core's
 * `/api/account` router.
 *
 *   GET /declared-age           the age the person declared and when, both null until they answer
 *   PUT /declared-age   {age}   keep a new answer, dated now
 *
 * The engine asks a person's age once, when a miniapp rated above the host app's own App Store rating first installs
 * or opens, and keeps it here (`declared-age.ts` in `@mentra/cloud-protocol`). It is never sent to a miniapp.
 *
 * Each call is made as the account whose Core token it carries (see `account-call.ts`): an answer that comes back after
 * the account changed is discarded as `SessionChangedError`, and a 401 refreshes the token once. A failure keeps
 * Core's status and error code on a `CoreRequestError` (`invalid_request`, `rate_limited`, `network_error`); an answer
 * of another shape is a `CoreResponseError`.
 */
import {DeclaredAgeSchema, type DeclaredAge} from "@mentra/cloud-protocol"
import type {HttpClient} from "../../http"
import {AccountCaller, CoreResponseError, type AccountCallOptions, type CoreTokenSource} from "./account-call"

const DECLARED_AGE_PATH = "/api/account/declared-age"

export class Account {
  private readonly caller: AccountCaller

  constructor(
    private readonly http: HttpClient,
    auth?: CoreTokenSource,
  ) {
    this.caller = new AccountCaller(auth)
  }

  /** The age the signed-in person declared, and when; both null until they answer. */
  async declaredAge(opts?: AccountCallOptions): Promise<DeclaredAge> {
    const body = await this.caller.run(
      (bearer) =>
        this.http.get<unknown>(DECLARED_AGE_PATH, {
          bearer,
          // A read: safe to retry.
          idempotent: true,
          ...(opts?.signal ? {signal: opts.signal} : {}),
        }),
      opts,
    )
    return readDeclaredAge(body)
  }

  /** Keep `age` as the signed-in person's declared age, dated now. Resolves with what Core kept. */
  async setDeclaredAge(age: number, opts?: AccountCallOptions): Promise<DeclaredAge> {
    const body = await this.caller.run(
      (bearer) =>
        this.http.put<unknown>(
          DECLARED_AGE_PATH,
          {age},
          {
            bearer,
            // Sending the same answer again keeps the same age.
            idempotent: true,
            ...(opts?.signal ? {signal: opts.signal} : {}),
          },
        ),
      opts,
    )
    const kept = readDeclaredAge(body)
    if (kept.declaredAge !== age) throw new CoreResponseError("invalid_shape")
    return kept
  }
}

function readDeclaredAge(body: unknown): DeclaredAge {
  const parsed = DeclaredAgeSchema.safeParse(body)
  if (!parsed.success) throw new CoreResponseError("invalid_shape")
  return {declaredAge: parsed.data.declaredAge, declaredAgeAt: parsed.data.declaredAgeAt}
}
