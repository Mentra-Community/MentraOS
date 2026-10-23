/**
 * @fileoverview Core calls made as one account.
 *
 * A call here belongs to the account whose Core token it was sent with, and to no other. The runner:
 *
 *  - gets the token and reads whose it is (`sub`), then sends that exact token as the request's bearer, so the
 *    request never reads the token source again and cannot pick up another account's token;
 *  - refuses to send when the caller named the account it expects and the token is someone else's;
 *  - after the answer (a good one or a failure), asks the token source whose session it holds now. When that is not
 *    the account the request was sent for, the answer is discarded as `SessionChangedError`: a switch or sign-out
 *    during the request must not hand A's data to a screen that now speaks for B;
 *  - on a 401, refreshes the token once, and sends again only when the refreshed token is still the same account's.
 *    A second 401 is an error.
 *
 * Every failure of a Core answer is a `CoreRequestError` that keeps the HTTP status and Core's error code. Its message
 * is fixed text built from the status; Core's own wording (`error_description`) never reaches it, because a screen
 * may show the message and the app has its own words for each code.
 */
import {AuthExpiredError, CloudClientError, HttpError} from "../../errors"
import {decodeClaims} from "../auth/jwt"

/** Core's error codes are short snake_case words; anything else is not safe to surface or branch on. */
const ERROR_CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/

/** The part of `cloud.auth` the runner needs. */
export interface CoreTokenSource {
  getCoreToken(opts?: {forceRefresh?: boolean}): Promise<string>
}

/** Per-call options. */
export interface AccountCallOptions {
  signal?: AbortSignal
  /**
   * The Mentra user ID the caller is acting for. When the client holds another account's token the call is refused
   * with `SessionChangedError` before anything is sent.
   */
  expectedAccount?: string
}

/** A Core answer that was not a success. `status` is 0 when nothing answered. */
export class CoreRequestError extends CloudClientError {
  readonly status: number
  /** Core's error code when it gave a well-formed one; `network_error` when nothing answered. */
  readonly code?: string
  readonly retryAfterSeconds?: number

  constructor(status: number, code?: string, retryAfterSeconds?: number) {
    super(status === 0 ? "Core request failed: no answer" : `Core request failed (HTTP ${status})`)
    this.name = "CoreRequestError"
    this.status = status
    this.code = code
    this.retryAfterSeconds = retryAfterSeconds
    Object.setPrototypeOf(this, new.target.prototype)
  }
}

/**
 * Core answered 2xx, but not with what this client can use: no body, a body of another shape, or (for desired state)
 * a status this client does not know. Never read as an empty or `unmanaged` answer.
 */
export class CoreResponseError extends CloudClientError {
  readonly reason: "invalid_shape" | "unknown_status"

  constructor(reason: "invalid_shape" | "unknown_status") {
    super(`Core's answer was not usable (${reason})`)
    this.name = "CoreResponseError"
    this.reason = reason
    Object.setPrototypeOf(this, new.target.prototype)
  }
}

/**
 * The client no longer holds the session the call was made for (another account signed in, or the session ended),
 * so nothing was sent or the answer was dropped. The caller discards it and follows the new session.
 */
export class SessionChangedError extends CloudClientError {
  readonly reason: "other_account" | "signed_out" | "unreadable_token"

  constructor(reason: "other_account" | "signed_out" | "unreadable_token") {
    super(`The signed-in account changed during the request (${reason})`)
    this.name = "SessionChangedError"
    this.reason = reason
    Object.setPrototypeOf(this, new.target.prototype)
  }
}

function isAbortError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "name" in error && error.name === "AbortError"
}

function abortReason(signal: AbortSignal): unknown {
  if (signal.reason !== undefined) return signal.reason
  const error = new Error("The request was aborted")
  error.name = "AbortError"
  return error
}

/** The account a Core token belongs to (its `sub`), or null when the token is not readable. */
function accountOf(token: string): string | null {
  try {
    const sub = decodeClaims(token).sub
    return typeof sub === "string" && sub ? sub : null
  } catch {
    return null
  }
}

function toRequestError(error: HttpError): CoreRequestError {
  const code =
    error.status === 0
      ? "network_error"
      : typeof error.code === "string" && ERROR_CODE_PATTERN.test(error.code)
        ? error.code
        : undefined
  return new CoreRequestError(error.status, code, error.retryAfterSeconds)
}

/** Runs requests as one account. See the file comment. */
export class AccountCaller {
  constructor(private readonly auth: CoreTokenSource | undefined) {}

  /**
   * Sends one request with the current account's token. `send` receives the bearer to use and must use exactly it.
   * Rejects with `CoreRequestError` for a Core answer that is not a success, `SessionChangedError` when the account
   * changed, the auth errors from the token source (`AuthExpiredError`, `AuthUnavailableError`) as they are, and the
   * caller's abort reason when `opts.signal` is aborted.
   */
  async run<T>(send: (bearer: string) => Promise<T>, opts: AccountCallOptions = {}): Promise<T> {
    const auth = this.auth
    if (!auth) throw new CloudClientError("This client has no Core sign-in; workspace and Fleet calls need one")
    const {signal} = opts

    const first = await this.tokenFor(auth, false, signal)
    const account = first.account
    if (opts.expectedAccount !== undefined && opts.expectedAccount !== account) {
      throw new SessionChangedError("other_account")
    }

    let token = first.token
    for (let attempt = 0; ; attempt++) {
      let result: T
      try {
        result = await send(token)
      } catch (error) {
        if (signal?.aborted) throw abortReason(signal)
        if (isAbortError(error)) throw error
        if (!(error instanceof HttpError)) {
          // Not a Core answer: a 2xx body that is not JSON, or a connection that dropped while the body was read.
          await this.assertStill(auth, account, signal)
          if (error instanceof CloudClientError) throw error
          throw error instanceof SyntaxError
            ? new CoreResponseError("invalid_shape")
            : new CoreRequestError(0, "network_error")
        }
        // Whatever Core answered, it answered A: if the session is not A's any more, nobody here wants the answer,
        // and a 401 must not trigger a refresh of someone else's session.
        await this.assertStill(auth, account, signal)
        if (error.status === 401 && attempt === 0) {
          const refreshed = await this.tokenFor(auth, true, signal)
          if (refreshed.account !== account) throw new SessionChangedError("other_account")
          token = refreshed.token
          continue
        }
        throw toRequestError(error)
      }
      if (signal?.aborted) throw abortReason(signal)
      await this.assertStill(auth, account, signal)
      return result
    }
  }

  private async tokenFor(
    auth: CoreTokenSource,
    forceRefresh: boolean,
    signal?: AbortSignal,
  ): Promise<{token: string; account: string}> {
    if (signal?.aborted) throw abortReason(signal)
    let token: string
    try {
      token = await auth.getCoreToken(forceRefresh ? {forceRefresh: true} : undefined)
    } catch (error) {
      if (signal?.aborted) throw abortReason(signal)
      throw error
    }
    if (signal?.aborted) throw abortReason(signal)
    const account = accountOf(token)
    if (!account) throw new SessionChangedError("unreadable_token")
    return {token, account}
  }

  /** Throws `SessionChangedError` unless the client holds `account`'s session right now. */
  private async assertStill(auth: CoreTokenSource, account: string, signal?: AbortSignal): Promise<void> {
    let current: string
    try {
      current = (await this.tokenFor(auth, false, signal)).account
    } catch (error) {
      // A session that ended mid-request is a change; any other trouble reading it is reported as it is.
      if (error instanceof AuthExpiredError) throw new SessionChangedError("signed_out")
      throw error
    }
    if (current !== account) throw new SessionChangedError("other_account")
  }
}
