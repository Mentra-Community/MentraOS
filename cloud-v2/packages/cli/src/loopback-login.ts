/**
 * @fileoverview `mentra login`: the authorization code flow with a loopback
 * redirect (RFC 8252), as a public client of Core's sign-in server.
 *
 * - Listens on 127.0.0.1 at the first free port of `CLI_LOOPBACK_PORTS`; the
 *   redirect URI is `http://127.0.0.1:<port>/callback`, registered for the
 *   CLI client.
 * - S256 PKCE, a random `state` and `nonce`, scope
 *   `openid email profile offline_access`.
 * - Accepts only `GET /callback` with `Host: 127.0.0.1:<port>` and the
 *   matching `state`; anything else is refused and the login keeps waiting.
 *   The code is redeemed once. An `error` with the matching `state` ends the
 *   login.
 * - The browser gets fixed text, never anything from the request.
 * - The URL is always printed, so a browser elsewhere can finish the sign-in
 *   through port forwarding (`--no-browser` over SSH).
 */

import * as client from "openid-client"

import {describeOidcError, expiresAtMs} from "./api"

export const CLI_LOOPBACK_PORTS = [53682, 53683, 53684] as const
export const CLI_LOGIN_SCOPE = "openid email profile offline_access"
export const DEFAULT_LOGIN_TIMEOUT_MS = 300_000

const SIGNED_IN = "Signed in to Mentra. You can close this tab."
const NOT_SIGNED_IN = "Sign-in did not complete. Return to the terminal for details."
const NOT_A_SIGN_IN = "This is not a Mentra sign-in in progress."

export interface LoopbackLoginResult {
  accessToken: string
  refreshToken: string
  /** When the access token expires, in epoch milliseconds. */
  expiresAt: number
  /** The signed-in person as the verified ID token names them: `sub` is the Core user ID. */
  subject: string
  email: string | null
}

/** A sign-in that did not complete. The message says what happened and what to do. */
export class LoginError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "LoginError"
  }
}

type LoopbackServer = ReturnType<typeof Bun.serve>

function page(status: number, text: string): Response {
  return new Response(text, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      connection: "close",
    },
  })
}

function portList(): string {
  const ports = CLI_LOOPBACK_PORTS.map(String)
  return `${ports.slice(0, -1).join(", ")} and ${ports.at(-1)}`
}

/** Listen on 127.0.0.1 at the first free loopback port. */
function listen(handle: (request: Request, port: number) => Promise<Response>): {server: LoopbackServer; port: number} {
  for (const port of CLI_LOOPBACK_PORTS) {
    try {
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port,
        development: false,
        fetch: request => handle(request, port),
        error: () => page(500, NOT_SIGNED_IN),
      })
      return {server, port}
    } catch (error) {
      if ((error as {code?: string})?.code === "EADDRINUSE") continue
      throw error
    }
  }
  throw new LoginError(`Ports ${portList()} on 127.0.0.1 are all in use. Free one of them and run \`mentra login\` again.`)
}

/** Stop listening once the browser has its answer; never leave the port held. */
async function shutdown(server: LoopbackServer): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([server.stop(), new Promise<void>(resolve => (timer = setTimeout(resolve, 1000)))])
  clearTimeout(timer)
  await server.stop(true)
}

function authorizationErrorMessage(error: string): string {
  const code = /^[A-Za-z0-9_.-]{1,64}$/.test(error) ? error : "unknown_error"
  if (code === "access_denied") return "Sign-in was cancelled in the browser. Run `mentra login` to try again."
  return `Sign-in did not complete (${code}). Run \`mentra login\` to try again.`
}

function minutes(ms: number): string {
  const value = Math.round(ms / 60_000)
  return value >= 1 ? `${value} minute${value === 1 ? "" : "s"}` : `${Math.round(ms / 1000)} seconds`
}

/** Sign in through the browser and a loopback redirect. */
export async function loopbackLogin(
  config: client.Configuration,
  opts: {
    /** Open `url` in a browser; false when no browser could be opened. */
    openBrowser: (url: string) => Promise<boolean>
    print: (line: string) => void
    timeoutMs?: number
  },
): Promise<LoopbackLoginResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS
  const verifier = client.randomPKCECodeVerifier()
  const state = client.randomState()
  const nonce = client.randomNonce()

  let settle!: {resolve: (result: LoopbackLoginResult) => void; reject: (error: Error) => void}
  const outcome = new Promise<LoopbackLoginResult>((resolve, reject) => (settle = {resolve, reject}))
  // Awaited below; this keeps an early failure from counting as unhandled meanwhile.
  outcome.catch(() => {})
  let answered = false

  async function handle(request: Request, port: number): Promise<Response> {
    const redirectUri = `http://127.0.0.1:${port}/callback`
    // The Host check refuses pages that reach the port under another name (DNS rebinding).
    if (request.method !== "GET" || request.headers.get("host") !== `127.0.0.1:${port}`) return page(400, NOT_A_SIGN_IN)
    let url: URL
    try {
      url = new URL(request.url)
    } catch {
      return page(400, NOT_A_SIGN_IN)
    }
    if (url.pathname !== "/callback") return page(404, NOT_A_SIGN_IN)
    if (url.searchParams.get("state") !== state) return page(400, NOT_A_SIGN_IN)
    // One answer per login: the code is redeemed once.
    if (answered) return page(409, NOT_A_SIGN_IN)
    answered = true

    const error = url.searchParams.get("error")
    if (error !== null) {
      settle.reject(new LoginError(authorizationErrorMessage(error)))
      return page(400, NOT_SIGNED_IN)
    }
    try {
      // The callback URL verified is the redirect URI with the query the provider sent, never one built from the request's Host.
      const callback = new URL(redirectUri)
      callback.search = url.search
      const tokens = await client.authorizationCodeGrant(config, callback, {
        pkceCodeVerifier: verifier,
        expectedState: state,
        expectedNonce: nonce,
        idTokenExpected: true,
      })
      const claims = tokens.claims()
      if (!claims) throw new Error("no ID token")
      if (!tokens.refresh_token) throw new Error("the sign-in server issued no refresh token")
      settle.resolve({
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiresAt: expiresAtMs(tokens),
        subject: claims.sub,
        email: typeof claims.email === "string" ? claims.email : null,
      })
      return page(200, SIGNED_IN)
    } catch (err) {
      settle.reject(new LoginError(`Sign-in failed: ${describeOidcError(err)}. Run \`mentra login\` to try again.`))
      return page(400, NOT_SIGNED_IN)
    }
  }

  const {server, port} = listen(handle)
  const timer = setTimeout(
    () => settle.reject(new LoginError(`Sign-in timed out after ${minutes(timeoutMs)}. Run \`mentra login\` to try again.`)),
    timeoutMs,
  )
  try {
    const authorizationUrl = client
      .buildAuthorizationUrl(config, {
        redirect_uri: `http://127.0.0.1:${port}/callback`,
        scope: CLI_LOGIN_SCOPE,
        code_challenge: await client.calculatePKCECodeChallenge(verifier),
        code_challenge_method: "S256",
        state,
        nonce,
      })
      .toString()
    opts.print("Sign in to Mentra in your browser:")
    opts.print(authorizationUrl)
    const opened = await Promise.race([
      opts.openBrowser(authorizationUrl).catch(() => false),
      outcome.then(
        () => true,
        () => true,
      ),
    ])
    if (!opened) {
      opts.print(
        `Open the URL above in a browser on this computer. Over SSH, forward the port first: ssh -L ${port}:127.0.0.1:${port} <host>`,
      )
    }
    opts.print(`Waiting for the browser on http://127.0.0.1:${port}/callback ...`)
    return await outcome
  } finally {
    clearTimeout(timer)
    await shutdown(server)
  }
}
