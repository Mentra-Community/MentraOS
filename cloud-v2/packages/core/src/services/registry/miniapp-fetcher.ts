/**
 * @fileoverview Core's fetcher for developers' miniapp URLs.
 *
 * The registry verifies a miniapp URL by reading its `miniapp.json`, and this
 * is the only code in Core that fetches a developer's URL. The developer
 * chooses the URL, so the fetcher guards against server-side request forgery:
 * - it accepts HTTPS on port 443 only, for the URL and every redirect;
 * - it resolves the host and refuses it unless every answer is public unicast
 *   (address-policy.ts);
 * - it connects to an address it checked, with the original host for TLS SNI
 *   and the certificate check, so a second DNS answer can't move the request;
 * - it follows at most 3 redirects, checking each the same way, and none on a
 *   request that carries a bearer token;
 * - it reads at most 64 KB of body within 5 seconds overall;
 * - it sends no cookies, and no credential except the bearer token of a
 *   sign-in challenge retry.
 *
 * It speaks HTTP/1.1 over a TLS socket it opens itself. On Bun, `fetch` and
 * `node:https` share one client, which uses HTTPS_PROXY from the environment
 * and, given a custom `lookup`, checks the certificate against the resolved
 * address instead of the host. A socket to the checked address leaves no
 * other route.
 */

import dns from "node:dns"
import net from "node:net"
import tls from "node:tls"
import {isPublicAddress} from "./address-policy"

export {isPublicAddress} from "./address-policy"

/** The most body the fetcher reads, in bytes. */
export const MINIAPP_FETCH_MAX_BYTES = 64 * 1024
/** The whole fetch, redirects included, in milliseconds. */
export const MINIAPP_FETCH_TIMEOUT_MS = 5_000
/** Redirects followed before the fetch gives up. */
export const MINIAPP_FETCH_MAX_REDIRECTS = 3
/** The most a response's status line and headers may take, in bytes. */
const MAX_HEAD_BYTES = 16 * 1024
/** Chunked framing allowed on top of the body, in bytes. */
const MAX_CHUNK_FRAMING_BYTES = 16 * 1024
const HTTPS_PORT = 443
const USER_AGENT = "Mentra-Core (miniapp registry)"

export interface FetchedManifest {
  /** Where the `miniapp.json` was read, after any redirects. */
  finalUrl: string
  status: 200
  body: string
  etag: string | null
}

export type MiniappUnreachableReason =
  | "dns"
  | "private_address"
  | "timeout"
  | "tls"
  | "connect"
  | "too_large"
  | "too_many_redirects"
  | "bad_redirect"
  /** The URL isn't HTTPS on port 443, or names credentials. Nothing was sent. */
  | "bad_url"
  /** A status the registry can't use (such as a 5xx), or a malformed response. */
  | "bad_response"

export type MiniappFetchResult =
  | {kind: "ok"; manifest: FetchedManifest}
  /** The URL's own server answered 401 with the sign-in challenge, to a request without a bearer token. */
  | {kind: "challenge"; packageName: string}
  /** 403, 404, 410, or a 401 that isn't such a challenge (including any 401 after a redirect or to a bearer token). */
  | {kind: "refused"; status: number}
  | {kind: "unreachable"; reason: MiniappUnreachableReason}

export interface MiniappFetchOptions {
  /** The miniapp token for a sign-in challenge retry. The request then follows no redirects. */
  bearer?: string
}

export interface MiniappFetcherConfig {
  /**
   * Resolves a host name to its addresses. The default asks the system
   * resolver for the name as fully qualified, so no search domain applies.
   */
  resolve?: (hostname: string) => Promise<string[]>
  /**
   * Where the TCP connection for a checked address goes. Tests route public
   * addresses to a local server; the default is the address itself on 443.
   */
  dial?: (address: string) => {host: string; port: number}
  /** Trust anchors to use instead of the system's (tests' local server). */
  ca?: string
  timeoutMs?: number
}

export type MiniappFetcher = (url: string, options?: MiniappFetchOptions) => Promise<MiniappFetchResult>

/** RFC 6750's b64token, which a JWT satisfies; nothing that could end the header. */
const BEARER_TOKEN = /^[A-Za-z0-9\-._~+/]+=*$/
const PACKAGE_NAME = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/
const STATUS_LINE = /^HTTP\/1\.[01] (\d{3})(?: [^\r\n]*)?$/
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
const REFUSED_STATUSES = new Set([403, 404, 410])
const TLS_ERROR_CODE = /^(ERR_TLS_|ERR_SSL_|CERT_|UNABLE_TO_|DEPTH_ZERO_|SELF_SIGNED_|HOSTNAME_MISMATCH)/

/** Fetches `<url>/miniapp.json` through Core's guarded fetcher. */
export function fetchMiniappManifest(url: string, options: MiniappFetchOptions = {}): Promise<MiniappFetchResult> {
  return defaultFetcher(url, options)
}

/** A fetcher with its resolver, routing or trust replaced, for tests. */
export function createMiniappFetcher(config: MiniappFetcherConfig = {}): MiniappFetcher {
  const settings: Settings = {
    resolve: config.resolve ?? resolveSystem,
    dial: config.dial ?? (address => ({host: address, port: HTTPS_PORT})),
    ca: config.ca,
    timeoutMs: config.timeoutMs ?? MINIAPP_FETCH_TIMEOUT_MS,
  }
  return (url, options = {}) => fetchManifest(settings, url, options)
}

const defaultFetcher = createMiniappFetcher()

interface Settings {
  resolve: (hostname: string) => Promise<string[]>
  dial: (address: string) => {host: string; port: number}
  ca: string | undefined
  timeoutMs: number
}

type HopResult = MiniappFetchResult | {kind: "redirect"; location: string | null}

async function fetchManifest(settings: Settings, url: string, options: MiniappFetchOptions): Promise<MiniappFetchResult> {
  const bearer = options.bearer
  if (bearer !== undefined && !BEARER_TOKEN.test(bearer)) {
    throw new TypeError("fetchMiniappManifest: the bearer token isn't a valid token")
  }
  let target = manifestUrl(url)
  if (!target) return unreachable("bad_url")

  const deadline = new AbortController()
  const timer = setTimeout(() => deadline.abort(), settings.timeoutMs)
  try {
    for (let redirects = 0; ; redirects++) {
      const hop = await fetchHop(settings, target, bearer, deadline.signal)
      if (hop.kind !== "redirect") {
        // Only the URL's own server may ask for a token: the retry carrying
        // it goes to the URL and follows no redirect. A 401 to the token is
        // a refusal.
        if (hop.kind === "challenge" && (bearer !== undefined || redirects > 0)) return {kind: "refused", status: 401}
        return hop
      }
      if (bearer !== undefined) return unreachable("bad_redirect")
      if (redirects >= MINIAPP_FETCH_MAX_REDIRECTS) return unreachable("too_many_redirects")
      const next = redirectTarget(target, hop.location)
      if (!next) return unreachable("bad_redirect")
      target = next
    }
  } finally {
    clearTimeout(timer)
  }
}

/** `<url>/miniapp.json`, or null for a URL the fetcher never requests. */
function manifestUrl(input: string): URL | null {
  let base: URL
  try {
    base = new URL(input)
  } catch {
    return null
  }
  if (!isFetchable(base)) return null
  if (!base.pathname.endsWith("/")) base.pathname += "/"
  return new URL("miniapp.json", base)
}

function redirectTarget(from: URL, location: string | null): URL | null {
  if (location === null) return null
  let next: URL
  try {
    next = new URL(location, from)
  } catch {
    return null
  }
  next.hash = ""
  return isFetchable(next) ? next : null
}

/** HTTPS on the default port (the URL parser drops an explicit 443), without credentials. */
function isFetchable(url: URL): boolean {
  return url.protocol === "https:" && url.port === "" && url.username === "" && url.password === "" && url.hostname !== ""
}

/** The URL's host without IPv6 brackets or a trailing dot. */
function hostOf(url: URL): string {
  const hostname = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname
  return hostname.endsWith(".") ? hostname.slice(0, -1) : hostname
}

async function fetchHop(settings: Settings, url: URL, bearer: string | undefined, signal: AbortSignal): Promise<HopResult> {
  const host = hostOf(url)
  if (host === "") return unreachable("bad_url")
  let addresses: string[]
  if (net.isIP(host) !== 0) {
    addresses = [host]
  } else {
    const answer = await untilAborted(Promise.resolve().then(() => settings.resolve(host)), signal)
    if (answer === ABORTED) return unreachable("timeout")
    if (!answer.ok || !Array.isArray(answer.value) || answer.value.length === 0) return unreachable("dns")
    addresses = answer.value
  }
  if (!addresses.every(address => typeof address === "string" && isPublicAddress(address))) {
    return unreachable("private_address")
  }

  const request = requestText(url, host, bearer)
  // IPv4 first: a container often has no IPv6 route even when the host has one.
  const ordered = [...addresses.filter(address => net.isIPv4(address)), ...addresses.filter(address => !net.isIPv4(address))]
  for (const address of ordered) {
    if (signal.aborted) return unreachable("timeout")
    const result = await exchange(settings, address, host, request, url.href, signal)
    if (result !== CONNECT_FAILED) return result
  }
  return unreachable("connect")
}

function requestText(url: URL, host: string, bearer: string | undefined): string {
  const lines = [
    `GET ${url.pathname}${url.search} HTTP/1.1`,
    `Host: ${net.isIPv6(host) ? `[${host}]` : host}`,
    `User-Agent: ${USER_AGENT}`,
    "Accept: application/json",
    "Accept-Encoding: identity",
    "Connection: close",
  ]
  if (bearer !== undefined) lines.push(`Authorization: Bearer ${bearer}`)
  return `${lines.join("\r\n")}\r\n\r\n`
}

const CONNECT_FAILED = Symbol("connect failed")

/**
 * One request to one checked address. Resolves CONNECT_FAILED when no TCP
 * connection opened, so the caller can try the host's next address.
 */
function exchange(
  settings: Settings,
  address: string,
  host: string,
  request: string,
  finalUrl: string,
  signal: AbortSignal,
): Promise<HopResult | typeof CONNECT_FAILED> {
  return new Promise(resolve => {
    const target = settings.dial(address)
    const hostIsAddress = net.isIP(host) !== 0
    let phase: "tcp" | "tls" | "http" = "tcp"
    let settled = false
    const reader = new ResponseReader(finalUrl)

    const socket = tls.connect({
      host: target.host,
      port: target.port,
      // SNI can't carry an address literal.
      servername: hostIsAddress ? undefined : host,
      ca: settings.ca,
      rejectUnauthorized: true,
      minVersion: "TLSv1.2",
      ALPNProtocols: ["http/1.1"],
      // The certificate must name the URL's host, whatever address was dialled.
      checkServerIdentity: (_dialled, certificate) => identityError(host, certificate),
    })

    const finish = (result: HopResult | typeof CONNECT_FAILED) => {
      if (settled) return
      settled = true
      signal.removeEventListener("abort", onAbort)
      socket.destroy()
      resolve(result)
    }
    const onAbort = () => finish(unreachable("timeout"))
    if (signal.aborted) return onAbort()
    signal.addEventListener("abort", onAbort, {once: true})

    socket.once("connect", () => {
      if (phase === "tcp") phase = "tls"
    })
    socket.once("secureConnect", () => {
      if (!socket.authorized) return finish(unreachable("tls"))
      // Checked again here: Bun skips checkServerIdentity on a connection
      // without SNI, as to an address literal.
      if (identityError(host, socket.getPeerCertificate())) return finish(unreachable("tls"))
      phase = "http"
      socket.write(request)
    })
    socket.on("data", (chunk: Buffer) => {
      if (settled) return
      if (phase !== "http") return finish(unreachable("tls"))
      const result = reader.push(chunk)
      if (result) finish(result)
    })
    socket.on("end", () => finish(reader.end()))
    socket.on("close", () => finish(reader.end()))
    socket.on("error", (error: NodeJS.ErrnoException) => {
      // A reset is no proper end, even for a body that runs until the close.
      if (phase === "http") return finish(unreachable("connect"))
      const code = typeof error.code === "string" ? error.code : ""
      if (phase === "tls" || TLS_ERROR_CODE.test(code)) return finish(unreachable("tls"))
      finish(CONNECT_FAILED)
    })
  })
}

/** Why `certificate` doesn't name `host`, or undefined when it does. */
function identityError(host: string, certificate: tls.PeerCertificate | undefined): Error | undefined {
  if (!certificate || Object.keys(certificate).length === 0) return new Error("the server sent no certificate")
  try {
    return tls.checkServerIdentity(host, certificate)
  } catch (error) {
    return error instanceof Error ? error : new Error("the certificate could not be checked")
  }
}

/** Reads one HTTP/1.1 response, skipping interim 1xx responses. */
class ResponseReader {
  private head: Buffer = Buffer.alloc(0)
  /** Bytes of interim responses already read, which count toward the head limit. */
  private interimBytes = 0
  private body: BodyReader | null = null
  private etag: string | null = null

  constructor(private readonly finalUrl: string) {}

  /** Feeds bytes; answers the hop's result once there is one. */
  push(chunk: Buffer): HopResult | null {
    if (this.body) return this.pushBody(chunk)
    this.head = this.head.length === 0 ? chunk : Buffer.concat([this.head, chunk])
    for (;;) {
      const end = this.head.indexOf("\r\n\r\n")
      if (end === -1) return this.interimBytes + this.head.length > MAX_HEAD_BYTES ? unreachable("too_large") : null
      if (this.interimBytes + end + 4 > MAX_HEAD_BYTES) return unreachable("too_large")
      const parsed = parseHead(this.head.subarray(0, end).toString("latin1"))
      if (!parsed) return unreachable("bad_response")
      const rest = this.head.subarray(end + 4)
      if (parsed.status >= 100 && parsed.status < 200) {
        // An interim response, such as 103 Early Hints; the real one follows.
        if (parsed.status === 101) return unreachable("bad_response")
        this.interimBytes += end + 4
        this.head = rest
        continue
      }
      this.head = Buffer.alloc(0)
      return this.onHead(parsed, rest)
    }
  }

  /** The connection ended: the result if the response is complete. */
  end(): HopResult {
    if (this.body?.endsAtClose) return this.complete()
    return unreachable("connect")
  }

  private onHead(head: ParsedHead, rest: Buffer): HopResult | null {
    const {status, headers} = head
    if (REDIRECT_STATUSES.has(status)) {
      const location = headers.get("location")
      return {kind: "redirect", location: location?.length === 1 ? location[0]! : null}
    }
    if (status === 401) {
      const packageName = mentraChallengePackage(headers.get("www-authenticate") ?? [])
      return packageName ? {kind: "challenge", packageName} : {kind: "refused", status}
    }
    if (REFUSED_STATUSES.has(status)) return {kind: "refused", status}
    if (status !== 200) return unreachable("bad_response")

    const encoding = (headers.get("content-encoding") ?? []).join(",").trim().toLowerCase()
    if (encoding !== "" && encoding !== "identity") return unreachable("bad_response")
    const body = bodyReader(headers)
    if (body === "too_large" || body === "bad_response") return unreachable(body)
    this.etag = headers.get("etag")?.[0] ?? null
    this.body = body
    return rest.length > 0 ? this.pushBody(rest) : this.body.done ? this.complete() : null
  }

  private pushBody(chunk: Buffer): HopResult | null {
    const body = this.body!
    const state = body.push(chunk)
    if (state === "too_large" || state === "bad_response") return unreachable(state)
    return state === "done" ? this.complete() : null
  }

  private complete(): HopResult {
    if (!this.body) return unreachable("connect")
    const body = new TextDecoder("utf-8").decode(this.body.bytes())
    return {kind: "ok", manifest: {finalUrl: this.finalUrl, status: 200, body, etag: this.etag}}
  }
}

interface ParsedHead {
  status: number
  headers: Map<string, string[]>
}

function parseHead(text: string): ParsedHead | null {
  const lines = text.split("\r\n")
  const statusLine = STATUS_LINE.exec(lines[0] ?? "")
  if (!statusLine) return null
  const headers = new Map<string, string[]>()
  for (const line of lines.slice(1)) {
    // Obsolete line folding, a bare CR or LF, or a missing name: refuse it.
    if (line.startsWith(" ") || line.startsWith("\t") || /[\r\n]/.test(line)) return null
    const colon = line.indexOf(":")
    if (colon <= 0) return null
    const name = line.slice(0, colon)
    if (!HEADER_NAME.test(name)) return null
    const value = line.slice(colon + 1).replace(/^[ \t]+|[ \t]+$/g, "")
    const key = name.toLowerCase()
    const values = headers.get(key)
    if (values) values.push(value)
    else headers.set(key, [value])
  }
  return {status: Number(statusLine[1]), headers}
}

type BodyState = "more" | "done" | "too_large" | "bad_response"

interface BodyReader {
  /** The body runs until the server closes the connection. */
  readonly endsAtClose: boolean
  readonly done: boolean
  push(chunk: Buffer): BodyState
  bytes(): Buffer
}

function bodyReader(headers: Map<string, string[]>): BodyReader | "too_large" | "bad_response" {
  const transferEncoding = headers.get("transfer-encoding")
  if (transferEncoding) {
    const codings = transferEncoding.join(",").split(",").map(coding => coding.trim().toLowerCase())
    return codings.length === 1 && codings[0] === "chunked" ? new ChunkedBody() : "bad_response"
  }
  const contentLength = headers.get("content-length")
  if (contentLength) {
    const values = new Set(contentLength.join(",").split(",").map(value => value.trim()))
    if (values.size !== 1) return "bad_response"
    const [value] = [...values]
    if (!/^\d{1,15}$/.test(value!)) return "bad_response"
    const length = Number(value)
    return length > MINIAPP_FETCH_MAX_BYTES ? "too_large" : new LengthBody(length)
  }
  return new UntilCloseBody()
}

class LengthBody implements BodyReader {
  readonly endsAtClose = false
  private readonly chunks: Buffer[] = []
  private received = 0
  constructor(private readonly length: number) {}

  get done(): boolean {
    return this.received >= this.length
  }

  push(chunk: Buffer): BodyState {
    const take = Math.min(chunk.length, this.length - this.received)
    if (take > 0) this.chunks.push(chunk.subarray(0, take))
    this.received += take
    return this.done ? "done" : "more"
  }

  bytes(): Buffer {
    return Buffer.concat(this.chunks)
  }
}

class UntilCloseBody implements BodyReader {
  readonly endsAtClose = true
  readonly done = false
  private readonly chunks: Buffer[] = []
  private received = 0

  push(chunk: Buffer): BodyState {
    this.received += chunk.length
    if (this.received > MINIAPP_FETCH_MAX_BYTES) return "too_large"
    this.chunks.push(chunk)
    return "more"
  }

  bytes(): Buffer {
    return Buffer.concat(this.chunks)
  }
}

/** Transfer-Encoding: chunked, with extensions and trailers ignored. */
class ChunkedBody implements BodyReader {
  readonly endsAtClose = false
  done = false
  private pending: Buffer = Buffer.alloc(0)
  private state: "size" | "data" | "data_end" | "trailer" = "size"
  private remaining = 0
  private readonly chunks: Buffer[] = []
  private received = 0
  private raw = 0

  push(chunk: Buffer): BodyState {
    if (this.done) return "done"
    this.raw += chunk.length
    if (this.raw > MINIAPP_FETCH_MAX_BYTES + MAX_CHUNK_FRAMING_BYTES) return "too_large"
    this.pending = this.pending.length === 0 ? chunk : Buffer.concat([this.pending, chunk])
    for (;;) {
      if (this.state === "data") {
        const take = Math.min(this.remaining, this.pending.length)
        if (take === 0) return "more"
        this.chunks.push(this.pending.subarray(0, take))
        this.pending = this.pending.subarray(take)
        this.remaining -= take
        if (this.remaining > 0) return "more"
        this.state = "data_end"
        continue
      }
      if (this.state === "data_end") {
        if (this.pending.length < 2) return "more"
        if (this.pending[0] !== 0x0d || this.pending[1] !== 0x0a) return "bad_response"
        this.pending = this.pending.subarray(2)
        this.state = "size"
        continue
      }
      const lineEnd = this.pending.indexOf("\r\n")
      if (lineEnd === -1) return "more"
      const line = this.pending.subarray(0, lineEnd).toString("latin1")
      this.pending = this.pending.subarray(lineEnd + 2)
      if (this.state === "trailer") {
        if (line !== "") continue
        this.done = true
        return "done"
      }
      const size = /^([0-9A-Fa-f]{1,8})[ \t]*(?:;[^\r\n]*)?$/.exec(line)
      if (!size) return "bad_response"
      const length = parseInt(size[1]!, 16)
      if (length === 0) {
        this.state = "trailer"
        continue
      }
      this.received += length
      if (this.received > MINIAPP_FETCH_MAX_BYTES) return "too_large"
      this.remaining = length
      this.state = "data"
    }
  }

  bytes(): Buffer {
    return Buffer.concat(this.chunks)
  }
}

/**
 * The package a 401 asks the miniapp token for:
 * `WWW-Authenticate: Bearer realm="mentra", package="<packageName>"`.
 * Null when no such challenge is present, or when two name different packages.
 */
export function mentraChallengePackage(headerValues: string[]): string | null {
  const packages = new Set<string>()
  for (const value of headerValues) {
    for (const challenge of parseChallenges(value) ?? []) {
      const packageName = challenge.params.get("package")
      if (challenge.scheme !== "bearer" || challenge.params.get("realm") !== "mentra" || packageName === undefined) continue
      if (packageName.length > 255 || !PACKAGE_NAME.test(packageName)) continue
      packages.add(packageName)
    }
  }
  return packages.size === 1 ? [...packages][0]! : null
}

interface Challenge {
  scheme: string
  params: Map<string, string>
}

/** RFC 9110 challenges with auth-params; null when the value is malformed. */
function parseChallenges(value: string): Challenge[] | null {
  const challenges: Challenge[] = []
  let current: Challenge | null = null
  let at = 0
  const skipSpace = () => {
    while (value[at] === " " || value[at] === "\t") at++
  }
  const readToken = (): string | null => {
    const match = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+/.exec(value.slice(at))
    if (!match) return null
    at += match[0].length
    return match[0]
  }
  const readQuoted = (): string | null => {
    let text = ""
    for (at++; at < value.length; at++) {
      const char = value[at]!
      if (char === "\\") {
        at++
        if (at >= value.length) return null
        text += value[at]
      } else if (char === '"') {
        at++
        return text
      } else {
        text += char
      }
    }
    return null
  }
  while (at < value.length) {
    skipSpace()
    if (value[at] === ",") {
      at++
      continue
    }
    if (at >= value.length) break
    const token = readToken()
    if (token === null) return null
    skipSpace()
    if (value[at] === "=" && current) {
      at++
      skipSpace()
      const paramValue = value[at] === '"' ? readQuoted() : readToken()
      if (paramValue === null) return null
      const name = token.toLowerCase()
      if (current.params.has(name)) return null
      current.params.set(name, paramValue)
    } else {
      current = {scheme: token.toLowerCase(), params: new Map()}
      challenges.push(current)
    }
  }
  return challenges
}

async function resolveSystem(hostname: string): Promise<string[]> {
  const answers = await dns.promises.lookup(`${hostname}.`, {all: true, verbatim: true})
  return answers.map(answer => answer.address)
}

const ABORTED = Symbol("aborted")

function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<{ok: true; value: T} | {ok: false} | typeof ABORTED> {
  if (signal.aborted) return Promise.resolve(ABORTED)
  return new Promise(resolve => {
    const onAbort = () => resolve(ABORTED)
    signal.addEventListener("abort", onAbort, {once: true})
    promise.then(
      value => {
        signal.removeEventListener("abort", onAbort)
        resolve({ok: true, value})
      },
      () => {
        signal.removeEventListener("abort", onAbort)
        resolve({ok: false})
      },
    )
  })
}

function unreachable(reason: MiniappUnreachableReason): MiniappFetchResult {
  return {kind: "unreachable", reason}
}
