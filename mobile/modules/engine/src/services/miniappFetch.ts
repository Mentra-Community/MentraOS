/**
 * Requests to miniapp URLs: `<url>/miniapp.json` and the ZIP it names.
 *
 * A request carries no Mentra account, token or cookie. A private miniapp's server asks for sign-in by answering
 * `401` with `WWW-Authenticate: Bearer realm="mentra", package="<packageName>"`. To answer, the engine checks that the
 * domain of the URL that asked owns the package, gets that package's miniapp token, and sends the same request once
 * more with it, following no redirects. A token is only ever sent that way, and only for the package that was named.
 */
import {fetch as expoFetch} from "expo/fetch"
import {MINIAPP_PACKAGE_NAME_PATTERN} from "@mentra/cloud-protocol/miniapp-url"

import {readBoundedByteStream} from "../utils/boundedByteStream"
import {sha256Hex} from "../utils/sha256"
import {cloudClientService} from "./CloudClientService"
import {isPackageNameAllowedForUrl} from "./miniappDomainRule"

/** `miniapp.json` is small: a copy of the ZIP's manifest plus `bundle`. */
export const MAX_MINIAPP_JSON_BYTES = 64 * 1024
export const MAX_MINIAPP_BUNDLE_BYTES = 50 * 1024 * 1024
const JSON_TIMEOUT_MS = 15_000
const BUNDLE_TIMEOUT_MS = 45_000

/** The response fields these requests read; `expo/fetch` provides them, with a readable body stream. */
export interface MiniappResponse {
  status: number
  /** Where the response came from, after redirects. */
  url: string
  headers: {get(name: string): string | null}
  body: ReadableStream<Uint8Array> | null
}

export interface MiniappRequestInit {
  headers: Record<string, string>
  signal: AbortSignal
  /** `error` for a request that carries a token: it must not reach another URL. */
  redirect: "follow" | "error"
  /** Never the phone's cookies. */
  credentials: "omit"
}

export type MiniappFetchTransport = (url: string, init: MiniappRequestInit) => Promise<MiniappResponse>

/** A sign-in challenge: the package whose token the server asks for. */
export interface MiniappChallenge {
  packageName: string
}

export type MiniappFetchErrorCode =
  /** Nothing usable answered: no connection, a timeout, or a redirect a token request may not follow. */
  | "network"
  | "too_large"
  /** The server asked for sign-in as a package its URL's domain doesn't own. */
  | "challenge_domain"
  /** The server asked for sign-in as another package than the one the caller fetches. */
  | "challenge_package"
  /** The package's miniapp token could not be had. */
  | "no_token"
  /** The ZIP's SHA-256 is not the one `miniapp.json` names. */
  | "integrity"
  /** The ZIP's server answered with this HTTP status. */
  | "http"

export class MiniappFetchError extends Error {
  readonly code: MiniappFetchErrorCode
  /** With `http`: the status the server answered. */
  readonly status?: number

  constructor(code: MiniappFetchErrorCode, message: string, options: {status?: number; cause?: unknown} = {}) {
    super(message)
    this.name = "MiniappFetchError"
    this.code = code
    if (options.status !== undefined) this.status = options.status
    if (options.cause !== undefined) (this as {cause?: unknown}).cause = options.cause
  }
}

export interface MiniappJsonResult {
  status: number
  /** The URL the response came from, after redirects. */
  url: string
  etag?: string
  /** The response text, for a 2xx answer. */
  body?: string
  /** From `Retry-After`, when the host asked us to wait. */
  retryAfterMs?: number
  /** The sign-in challenge the server answered with, answered or not. */
  challenge?: MiniappChallenge
}

export interface FetchMiniappJsonOptions {
  /** Make the request conditional: an unchanged `miniapp.json` answers `304` with no body. */
  etag?: string
  /**
   * Answer a sign-in challenge. A package name: only a challenge for that package, the one the caller knows the URL
   * serves. `true`: the package the challenge names, for an install that doesn't know it yet. Either way, the domain
   * of the URL that asked must own the package. Omitted, a challenge comes back unanswered, as its `401`.
   */
  packageForChallenge?: string | true
  /** Tests replace the network. */
  transport?: MiniappFetchTransport
}

export interface FetchMiniappBundleOptions {
  /** The package the ZIP belongs to: a sign-in challenge is answered only for it. */
  packageName: string
  /** The SHA-256 `miniapp.json` names, in lowercase hex. The bytes must have it. */
  sha256: string
  /** Called when the ZIP's server asks for sign-in. */
  onChallenge?: () => void
  transport?: MiniappFetchTransport
}

/**
 * The package of a Mentra sign-in challenge (`Bearer realm="mentra", package="com.acme.tools"`) in a
 * `WWW-Authenticate` header, or null when the header holds none.
 */
export function parseMiniappChallenge(header: string | null | undefined): MiniappChallenge | null {
  if (!header) return null
  const bearer = /(?:^|,)\s*Bearer\s+/gi
  let match: RegExpExecArray | null
  while ((match = bearer.exec(header))) {
    const params = new Map<string, string>()
    const param = /\s*([A-Za-z][A-Za-z0-9_-]*)\s*=\s*"([^"\\]*)"\s*(?:,|$)/y
    param.lastIndex = match.index + match[0].length
    let found: RegExpExecArray | null
    while ((found = param.exec(header))) {
      const key = found[1]!.toLowerCase()
      if (!params.has(key)) params.set(key, found[2]!)
    }
    const packageName = params.get("package")
    if (params.get("realm") === "mentra" && packageName && MINIAPP_PACKAGE_NAME_PATTERN.test(packageName)) {
      return {packageName}
    }
  }
  return null
}

/**
 * Fetch `miniapp.json` from a miniapp URL: conditional, time-limited and size-bounded, with no account, token or
 * cookie. HTTP answers are returned, not thrown; with `packageForChallenge`, a sign-in challenge is answered first.
 * Throws {@link MiniappFetchError} when nothing usable answered or a challenge can't be answered.
 */
export async function fetchMiniappJson(url: string, options: FetchMiniappJsonOptions = {}): Promise<MiniappJsonResult> {
  const headers: Record<string, string> = {
    "Accept": "application/json",
    "Cache-Control": "no-cache",
    ...(options.etag ? {"If-None-Match": options.etag} : {}),
  }
  const transport = options.transport ?? defaultTransport
  const first = await sendJson(transport, url, headers)
  const challenge = first.status === 401 ? first.challenge : undefined
  if (!challenge || options.packageForChallenge === undefined) return first
  const expected = options.packageForChallenge === true ? undefined : options.packageForChallenge
  const authorization = await answerChallenge(challenge, first.url, expected)
  const second = await sendJson(transport, first.url, {...headers, Authorization: authorization}, true)
  return {...second, challenge}
}

/**
 * Download a miniapp's ZIP: time-limited, size-bounded, and checked against its SHA-256 before anything reads it.
 * A sign-in challenge is answered for `packageName` only. Throws {@link MiniappFetchError}.
 */
export async function fetchMiniappBundle(url: string, options: FetchMiniappBundleOptions): Promise<Uint8Array> {
  const transport = options.transport ?? defaultTransport
  const expectedSha256 = options.sha256.toLowerCase()
  const headers = {Accept: "application/zip, application/octet-stream;q=0.9, */*;q=0.1"}
  let response = await sendBundle(transport, url, headers)
  if (response.status === 401) {
    const challenge = parseMiniappChallenge(response.response.headers.get("www-authenticate"))
    if (challenge) {
      options.onChallenge?.()
      const authorization = await answerChallenge(challenge, response.url, options.packageName)
      response = await sendBundle(transport, response.url, {...headers, Authorization: authorization}, true)
    }
  }
  if (response.status < 200 || response.status >= 300) {
    throw new MiniappFetchError("http", `${url} answered ${response.status}`, {status: response.status})
  }
  if (!response.bytes || response.bytes.byteLength === 0) {
    throw new MiniappFetchError("integrity", `${url} returned an empty bundle`)
  }
  const actual = await sha256Hex(response.bytes)
  if (actual !== expectedSha256) {
    throw new MiniappFetchError("integrity", `bundle SHA-256 mismatch: expected ${expectedSha256}, got ${actual}`)
  }
  return response.bytes
}

const defaultTransport: MiniappFetchTransport = (url, init) =>
  expoFetch(url, init) as unknown as Promise<MiniappResponse>

/** The Authorization header for a challenge: its package, owned by the asking URL's domain, and its miniapp token. */
async function answerChallenge(
  challenge: MiniappChallenge,
  askedFrom: string,
  expectedPackage: string | undefined,
): Promise<string> {
  if (expectedPackage !== undefined && challenge.packageName !== expectedPackage) {
    throw new MiniappFetchError(
      "challenge_package",
      `${askedFrom} asked for sign-in as ${challenge.packageName}, not ${expectedPackage}`,
    )
  }
  if (!isPackageNameAllowedForUrl(challenge.packageName, askedFrom)) {
    throw new MiniappFetchError(
      "challenge_domain",
      `${askedFrom} asked for sign-in as ${challenge.packageName}, which its domain doesn't own`,
    )
  }
  let token: string
  try {
    if (!cloudClientService.hasCore()) throw new Error("this deployment has no Core")
    token = (await cloudClientService.getMiniappAuthToken(challenge.packageName)).token
  } catch (error) {
    throw new MiniappFetchError("no_token", `No miniapp token for ${challenge.packageName}`, {cause: error})
  }
  if (!token) throw new MiniappFetchError("no_token", `No miniapp token for ${challenge.packageName}`)
  return `Bearer ${token}`
}

interface SentResponse {
  response: MiniappResponse
  status: number
  url: string
}

/** Send one request with a deadline that also covers reading the body. */
async function send<T>(
  transport: MiniappFetchTransport,
  url: string,
  headers: Record<string, string>,
  withToken: boolean,
  timeoutMs: number,
  read: (sent: SentResponse) => Promise<T>,
): Promise<T> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    let response: MiniappResponse
    try {
      response = await transport(url, {
        headers,
        signal: controller.signal,
        redirect: withToken ? "error" : "follow",
        credentials: "omit",
      })
    } catch (error) {
      throw new MiniappFetchError("network", `Could not reach ${url}`, {cause: error})
    }
    const finalUrl = response.url || url
    // A request with a token goes to one URL only, whatever the transport did with `redirect`.
    if (withToken && finalUrl !== url) {
      throw new MiniappFetchError("network", `${url} redirected a request that carried a token`)
    }
    if (new URL(url).protocol === "https:" && new URL(finalUrl).protocol !== "https:") {
      throw new MiniappFetchError("network", `${url} redirected away from HTTPS`)
    }
    return await read({response, status: response.status, url: finalUrl})
  } catch (error) {
    if (error instanceof MiniappFetchError) throw error
    if (controller.signal.aborted) throw new MiniappFetchError("network", `${url} timed out`, {cause: error})
    throw new MiniappFetchError("network", `Could not read ${url}`, {cause: error})
  } finally {
    clearTimeout(timeout)
  }
}

function sendJson(
  transport: MiniappFetchTransport,
  url: string,
  headers: Record<string, string>,
  withToken = false,
): Promise<MiniappJsonResult> {
  return send(transport, url, headers, withToken, JSON_TIMEOUT_MS, async ({response, status, url: servedFrom}) => {
    const retryAfter = Number(response.headers.get("retry-after"))
    const challenge = status === 401 ? parseMiniappChallenge(response.headers.get("www-authenticate")) : null
    const etag = response.headers.get("etag")
    const result: MiniappJsonResult = {
      status,
      url: servedFrom,
      ...(etag ? {etag} : {}),
      ...(Number.isFinite(retryAfter) && retryAfter > 0 ? {retryAfterMs: retryAfter * 1000} : {}),
      ...(challenge ? {challenge} : {}),
    }
    if (status < 200 || status >= 300) return result
    const bytes = await readBody(response, MAX_MINIAPP_JSON_BYTES, servedFrom)
    let body: string
    try {
      body = new TextDecoder("utf-8", {fatal: true}).decode(bytes)
    } catch (error) {
      throw new MiniappFetchError("network", `${servedFrom} is not UTF-8 text`, {cause: error})
    }
    return {...result, body}
  })
}

function sendBundle(
  transport: MiniappFetchTransport,
  url: string,
  headers: Record<string, string>,
  withToken = false,
): Promise<SentResponse & {bytes?: Uint8Array}> {
  return send(transport, url, headers, withToken, BUNDLE_TIMEOUT_MS, async (sent) => {
    if (sent.status < 200 || sent.status >= 300) return sent
    const declaredSize = Number(sent.response.headers.get("content-length"))
    if (Number.isFinite(declaredSize) && declaredSize > MAX_MINIAPP_BUNDLE_BYTES) {
      throw new MiniappFetchError("too_large", `bundle exceeds ${MAX_MINIAPP_BUNDLE_BYTES} bytes`)
    }
    return {...sent, bytes: await readBody(sent.response, MAX_MINIAPP_BUNDLE_BYTES, sent.url)}
  })
}

async function readBody(response: MiniappResponse, maxBytes: number, url: string): Promise<Uint8Array> {
  if (!response.body) throw new MiniappFetchError("network", `${url} returned no body`)
  try {
    return await readBoundedByteStream(response.body, maxBytes)
  } catch (error) {
    if (error instanceof Error && /exceeds/.test(error.message)) {
      throw new MiniappFetchError("too_large", `${url} exceeds ${maxBytes} bytes`, {cause: error})
    }
    throw error
  }
}
