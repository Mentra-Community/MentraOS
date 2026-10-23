import {describe, expect, mock, test} from "bun:test"
import {AuthExpiredError, AuthUnavailableError} from "../../errors"
import {createHttpClient} from "../../http"
import type {CloudClientTimers} from "../../timers"
import type {HttpTransport} from "../../transports"
import {CoreRequestError, CoreResponseError, SessionChangedError, type CoreTokenSource} from "./account-call"
import {Core} from "./core"
import {Workspaces} from "./workspaces"

const logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
}

const instantTimers: CloudClientTimers = {
  setTimeout(callback) {
    queueMicrotask(callback)
    return 0
  },
  clearTimeout: () => undefined,
  setInterval: () => 0,
  clearInterval: () => undefined,
}

const BASE = "https://core.test/api/client/workspaces"

function jwt(sub: string): string {
  const payload = Buffer.from(JSON.stringify({sub, tenant_id: "consumer", exp: 4_000_000_000})).toString("base64url")
  return `e30.${payload}.sig`
}

/** A token source that holds one account's session at a time, and mints a distinct token each time it refreshes. */
class FakeAuth implements CoreTokenSource {
  account: string | null
  generation = 0
  refreshes = 0
  /** When set, a forced refresh throws it. */
  refreshFails: Error | null = null
  /** When set, a forced refresh signs this account in instead (the session changed under the 401). */
  refreshSwitchesTo: string | null = null

  constructor(account: string) {
    this.account = account
  }

  tokenOf(account: string, generation = this.generation): string {
    return `${jwt(account)}#${generation}`
  }

  async getCoreToken(opts?: {forceRefresh?: boolean}): Promise<string> {
    if (this.account === null) throw new AuthExpiredError("auth session was cleared")
    if (opts?.forceRefresh) {
      this.refreshes += 1
      if (this.refreshFails) throw this.refreshFails
      if (this.refreshSwitchesTo) this.account = this.refreshSwitchesTo
      this.generation += 1
    }
    return this.tokenOf(this.account)
  }

  switchTo(account: string): void {
    this.account = account
    this.generation += 1
  }

  signOut(): void {
    this.account = null
  }
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {status, headers: {"Content-Type": "application/json", ...headers}})
}

type Handler = (url: string, init: RequestInit, attempt: number) => Response | Promise<Response>

function setup(handler: Handler, account = "account-a") {
  const auth = new FakeAuth(account)
  const requests: {url: string; method: string; authorization: string | undefined; body: unknown}[] = []
  const transport = mock(async (input: unknown, init?: unknown) => {
    const request = init as RequestInit
    requests.push({
      url: String(input),
      method: String(request.method),
      authorization: (request.headers as Record<string, string>)["Authorization"],
      body: request.body,
    })
    return handler(String(input), request, requests.length)
  })
  const http = createHttpClient({
    baseUrl: "https://core.test",
    logger,
    fetch: transport as unknown as HttpTransport,
    timers: instantTimers,
  })
  return {auth, requests, workspaces: new Workspaces(http, auth), http}
}

const workspace = {workspaceId: "ws-1", name: "Ridgeline", role: "member" as const, membershipId: "mem-1"}
const invitation = {
  invitationId: "inv-1",
  workspaceId: "ws-1",
  workspaceName: "Ridgeline",
  email: "a@example.com",
  role: "member" as const,
  invitedByEmail: null,
  expiresAt: "2026-11-01T00:00:00.000Z",
}

describe("workspaces: paths, methods, bodies", () => {
  test("mine is GET /mine", async () => {
    const {workspaces, requests} = setup(() => json(200, {workspace}))
    await expect(workspaces.mine()).resolves.toEqual({workspace})
    expect(requests.map(r => [r.method, r.url])).toEqual([["GET", `${BASE}/mine`]])
  })

  test("mine reads `workspace: null` as no workspace", async () => {
    const {workspaces} = setup(() => json(200, {workspace: null}))
    await expect(workspaces.mine()).resolves.toEqual({workspace: null})
  })

  test("pendingInvitations is GET /invitations/mine", async () => {
    const {workspaces, requests} = setup(() => json(200, {invitations: [invitation]}))
    await expect(workspaces.pendingInvitations()).resolves.toEqual({invitations: [invitation]})
    expect(requests.map(r => [r.method, r.url])).toEqual([["GET", `${BASE}/invitations/mine`]])
  })

  test("acceptInvitation is POST /invitations/:id/accept with no body", async () => {
    const {workspaces, requests} = setup(() => json(200, {workspace}))
    await expect(workspaces.acceptInvitation("inv-1")).resolves.toEqual({workspace})
    expect(requests.map(r => [r.method, r.url, r.body])).toEqual([["POST", `${BASE}/invitations/inv-1/accept`, undefined]])
  })

  test("declineInvitation is POST /invitations/:id/decline", async () => {
    const {workspaces, requests} = setup(() => json(200, {invitationId: "inv-1", declined: true}))
    await expect(workspaces.declineInvitation("inv-1")).resolves.toEqual({invitationId: "inv-1", declined: true})
    expect(requests.map(r => [r.method, r.url])).toEqual([["POST", `${BASE}/invitations/inv-1/decline`]])
  })

  test("leave is POST /leave and resolves on 204", async () => {
    const {workspaces, requests} = setup(() => new Response(null, {status: 204}))
    await expect(workspaces.leave()).resolves.toBeUndefined()
    expect(requests.map(r => [r.method, r.url])).toEqual([["POST", `${BASE}/leave`]])
  })

  test("leave names the workspace it leaves when given one, and sends no body without one", async () => {
    const {workspaces, requests} = setup(() => new Response(null, {status: 204}))
    await workspaces.leave({workspaceId: "ws-1"})
    await workspaces.leave()
    expect(requests.map(r => [r.method, r.url, r.body])).toEqual([
      ["POST", `${BASE}/leave`, JSON.stringify({workspaceId: "ws-1"})],
      ["POST", `${BASE}/leave`, undefined],
    ])
  })

  test("an invitation ID is one path segment", async () => {
    const {workspaces, requests} = setup(() => json(200, {workspace}))
    await workspaces.acceptInvitation("a/b?c")
    expect(requests[0]!.url).toBe(`${BASE}/invitations/a%2Fb%3Fc/accept`)
  })

  test("is exposed as cloud.core.workspaces, bound", async () => {
    const {http, auth, requests} = setup(() => json(200, {workspace: null}))
    const core = new Core({http, auth})
    const {mine} = core.workspaces
    await mine()
    expect(requests[0]!.url).toBe(`${BASE}/mine`)
  })
})

describe("workspaces: the answer must be what Core sends", () => {
  test("mine with a workspace missing a field is a CoreResponseError, never no-workspace", async () => {
    const {workspaces} = setup(() => json(200, {workspace: {workspaceId: "ws-1", name: "x", role: "member"}}))
    await expect(workspaces.mine()).rejects.toBeInstanceOf(CoreResponseError)
  })

  test("mine without a `workspace` key is a CoreResponseError", async () => {
    const {workspaces} = setup(() => json(200, {}))
    await expect(workspaces.mine()).rejects.toBeInstanceOf(CoreResponseError)
  })

  test("an empty 200 body is a CoreResponseError", async () => {
    const {workspaces} = setup(() => new Response(null, {status: 200}))
    await expect(workspaces.mine()).rejects.toBeInstanceOf(CoreResponseError)
  })

  test("a 200 body that is not JSON is a CoreResponseError", async () => {
    const {workspaces} = setup(() => new Response("<html>proxy</html>", {status: 200}))
    await expect(workspaces.pendingInvitations()).rejects.toBeInstanceOf(CoreResponseError)
  })

  test("an invitation missing its ID is a CoreResponseError", async () => {
    const {workspaces} = setup(() => json(200, {invitations: [{...invitation, invitationId: undefined}]}))
    await expect(workspaces.pendingInvitations()).rejects.toBeInstanceOf(CoreResponseError)
  })

  test("decline that does not say declined is a CoreResponseError", async () => {
    const {workspaces} = setup(() => json(200, {invitationId: "inv-1", declined: false}))
    await expect(workspaces.declineInvitation("inv-1")).rejects.toBeInstanceOf(CoreResponseError)
  })
})

describe("workspaces: bearer binding", () => {
  test("every call sends the token of the signed-in account", async () => {
    const {workspaces, requests, auth} = setup(url => {
      if (url.endsWith("/leave")) return new Response(null, {status: 204})
      if (url.endsWith("/decline")) return json(200, {invitationId: "inv-1", declined: true})
      if (url.endsWith("/accept")) return json(200, {workspace})
      if (url.endsWith("/invitations/mine")) return json(200, {invitations: []})
      return json(200, {workspace: null})
    })
    await workspaces.mine()
    await workspaces.pendingInvitations()
    await workspaces.acceptInvitation("inv-1")
    await workspaces.declineInvitation("inv-1")
    await workspaces.leave()
    expect(requests).toHaveLength(5)
    for (const request of requests) expect(request.authorization).toBe(`Bearer ${auth.tokenOf("account-a")}`)
  })

  test("after a switch, the next call carries the new account's token and never the old one", async () => {
    const {workspaces, requests, auth} = setup(() => json(200, {workspace: null}))
    await workspaces.mine()
    auth.switchTo("account-b")
    await workspaces.mine()
    expect(requests[0]!.authorization).toBe(`Bearer ${jwt("account-a")}#0`)
    expect(requests[1]!.authorization).toBe(`Bearer ${jwt("account-b")}#1`)
  })

  test("expectedAccount that is not the signed-in account sends nothing", async () => {
    const {workspaces, requests} = setup(() => json(200, {workspace: null}))
    await expect(workspaces.mine({expectedAccount: "account-b"})).rejects.toMatchObject({
      name: "SessionChangedError",
      reason: "other_account",
    })
    expect(requests).toHaveLength(0)
  })

  test("expectedAccount that is the signed-in account sends", async () => {
    const {workspaces, requests} = setup(() => json(200, {workspace: null}))
    await workspaces.mine({expectedAccount: "account-a"})
    expect(requests).toHaveLength(1)
  })

  test("a call with no token source rejects without sending", async () => {
    const {http, requests} = setup(() => json(200, {workspace: null}))
    await expect(new Workspaces(http).mine()).rejects.toThrow("no Core sign-in")
    expect(requests).toHaveLength(0)
  })

  test("a token that cannot be read is refused rather than sent unattributed", async () => {
    const {http, requests} = setup(() => json(200, {workspace: null}))
    const auth: CoreTokenSource = {getCoreToken: async () => "not-a-jwt"}
    await expect(new Workspaces(http, auth).mine()).rejects.toMatchObject({reason: "unreadable_token"})
    expect(requests).toHaveLength(0)
  })

  test("auth failures from the token source reach the caller as they are", async () => {
    const {http} = setup(() => json(200, {workspace: null}))
    const expired = new AuthExpiredError()
    const unavailable = new AuthUnavailableError("offline")
    await expect(new Workspaces(http, {getCoreToken: async () => Promise.reject(expired)}).mine()).rejects.toBe(expired)
    await expect(new Workspaces(http, {getCoreToken: async () => Promise.reject(unavailable)}).mine()).rejects.toBe(
      unavailable,
    )
  })
})

describe("workspaces: a 401 refreshes once and retries", () => {
  test("refreshes the token, sends again with the new one, and returns the answer", async () => {
    const {workspaces, requests, auth} = setup((_url, _init, n) =>
      n === 1 ? json(401, {error: "unauthorized"}) : json(200, {workspace}),
    )
    await expect(workspaces.mine()).resolves.toEqual({workspace})
    expect(auth.refreshes).toBe(1)
    expect(requests.map(r => r.authorization)).toEqual([
      `Bearer ${auth.tokenOf("account-a", 0)}`,
      `Bearer ${auth.tokenOf("account-a", 1)}`,
    ])
  })

  test("a second 401 is an error: one refresh, two requests", async () => {
    const {workspaces, requests, auth} = setup(() => json(401, {error: "unauthorized"}))
    const error = await workspaces.mine().catch((e: unknown) => e)
    expect(error).toBeInstanceOf(CoreRequestError)
    expect(error).toMatchObject({status: 401, code: "unauthorized"})
    expect(auth.refreshes).toBe(1)
    expect(requests).toHaveLength(2)
  })

  test("a POST is retried after a 401 (Core refused it before doing anything)", async () => {
    const {workspaces, requests} = setup((_url, _init, n) =>
      n === 1 ? json(401, {error: "unauthorized"}) : json(200, {workspace}),
    )
    await workspaces.acceptInvitation("inv-1")
    expect(requests.map(r => r.method)).toEqual(["POST", "POST"])
  })

  test("a refresh Core refuses reaches the caller as AuthExpiredError, with nothing sent again", async () => {
    const {workspaces, requests, auth} = setup(() => json(401, {error: "unauthorized"}))
    auth.refreshFails = new AuthExpiredError()
    await expect(workspaces.mine()).rejects.toBeInstanceOf(AuthExpiredError)
    expect(requests).toHaveLength(1)
  })

  test("a refresh that lands on another account is a SessionChangedError and the request is not resent", async () => {
    const {workspaces, requests, auth} = setup(() => json(401, {error: "unauthorized"}))
    auth.refreshSwitchesTo = "account-b"
    await expect(workspaces.mine()).rejects.toBeInstanceOf(SessionChangedError)
    expect(requests).toHaveLength(1)
    expect(requests[0]!.authorization).toBe(`Bearer ${auth.tokenOf("account-a", 0)}`)
  })

  test("other 4xx are not refreshed", async () => {
    const {workspaces, auth} = setup(() => json(403, {error: "forbidden"}))
    await expect(workspaces.mine()).rejects.toMatchObject({status: 403})
    expect(auth.refreshes).toBe(0)
  })
})

describe("workspaces: no request carries another account's token, even across a switch", () => {
  test("a request in flight during a switch is dropped, and the new account's token is never used for it", async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    const {workspaces, requests, auth} = setup(async () => {
      await gate
      return json(200, {workspace})
    })
    const pending = workspaces.mine()
    // Let the request go out under A, then B signs in before the answer arrives.
    await Promise.resolve()
    while (requests.length === 0) await new Promise(resolve => setTimeout(resolve, 0))
    auth.switchTo("account-b")
    release()
    await expect(pending).rejects.toBeInstanceOf(SessionChangedError)
    expect(requests).toHaveLength(1)
    expect(requests[0]!.authorization).toBe(`Bearer ${jwt("account-a")}#0`)
  })

  test("a 401 for A that arrives after B signed in does not refresh B's session or resend", async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    const {workspaces, requests, auth} = setup(async () => {
      await gate
      return json(401, {error: "unauthorized"})
    })
    const pending = workspaces.mine()
    while (requests.length === 0) await new Promise(resolve => setTimeout(resolve, 0))
    auth.switchTo("account-b")
    release()
    await expect(pending).rejects.toBeInstanceOf(SessionChangedError)
    expect(auth.refreshes).toBe(0)
    expect(requests).toHaveLength(1)
  })

  test("a failure for A that arrives after B signed in is a SessionChangedError, not A's error", async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    const {workspaces, requests, auth} = setup(async () => {
      await gate
      return json(409, {error: "already_in_workspace"})
    })
    const pending = workspaces.acceptInvitation("inv-1")
    while (requests.length === 0) await new Promise(resolve => setTimeout(resolve, 0))
    auth.switchTo("account-b")
    release()
    await expect(pending).rejects.toBeInstanceOf(SessionChangedError)
  })

  test("signing out during the request drops the answer", async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    const {workspaces, requests, auth} = setup(async () => {
      await gate
      return json(200, {workspace})
    })
    const pending = workspaces.mine()
    while (requests.length === 0) await new Promise(resolve => setTimeout(resolve, 0))
    auth.signOut()
    release()
    await expect(pending).rejects.toMatchObject({name: "SessionChangedError", reason: "signed_out"})
  })

  test("two calls in flight across a switch each keep their own account's token", async () => {
    const gates: (() => void)[] = []
    const {workspaces, requests, auth} = setup(
      () =>
        new Promise<Response>(resolve => {
          gates.push(() => resolve(json(200, {workspace: null})))
        }),
    )
    const first = workspaces.mine()
    while (requests.length < 1) await new Promise(resolve => setTimeout(resolve, 0))
    auth.switchTo("account-b")
    const second = workspaces.mine()
    while (requests.length < 2) await new Promise(resolve => setTimeout(resolve, 0))
    for (const open of gates) open()
    await expect(first).rejects.toBeInstanceOf(SessionChangedError)
    await expect(second).resolves.toEqual({workspace: null})
    expect(requests[0]!.authorization).toBe(`Bearer ${jwt("account-a")}#0`)
    expect(requests[1]!.authorization).toBe(`Bearer ${jwt("account-b")}#1`)
  })
})

describe("workspaces: errors keep the status and Core's code, never Core's wording", () => {
  test("409 already_in_workspace", async () => {
    const {workspaces} = setup(() =>
      json(409, {error: "already_in_workspace", error_description: "leave your current workspace before joining another"}),
    )
    const error = (await workspaces.acceptInvitation("inv-1").catch((e: unknown) => e)) as CoreRequestError
    expect(error).toBeInstanceOf(CoreRequestError)
    expect(error.status).toBe(409)
    expect(error.code).toBe("already_in_workspace")
    expect(error.message).toBe("Core request failed (HTTP 409)")
    expect(error.message).not.toContain("leave your current")
  })

  test("a `code` field wins over `error`, and a description under `message` is dropped too", async () => {
    const {workspaces} = setup(() => json(409, {code: "last_owner", message: "You are the only Owner of Acme"}))
    const error = (await workspaces.leave().catch((e: unknown) => e)) as CoreRequestError
    expect(error).toMatchObject({status: 409, code: "last_owner"})
    expect(error.message).not.toContain("Acme")
  })

  test("the codes the app maps each come through", async () => {
    for (const [status, code] of [
      [410, "invitation_expired"],
      [404, "invitation_not_found"],
      [403, "email_unverified"],
      [409, "membership_changed"],
    ] as const) {
      const {workspaces} = setup(() => json(status, {error: code}))
      await expect(workspaces.acceptInvitation("inv-1")).rejects.toMatchObject({status, code})
    }
  })

  test("a code that is not a short snake_case word is not passed on", async () => {
    const {workspaces} = setup(() => json(400, {error: "Bad Request: please sign in as joe@example.com"}))
    const error = (await workspaces.mine().catch((e: unknown) => e)) as CoreRequestError
    expect(error.status).toBe(400)
    expect(error.code).toBeUndefined()
    expect(error.message).not.toContain("joe@example.com")
  })

  test("503 keeps its status, code and Retry-After", async () => {
    const {workspaces} = setup(() => json(503, {error: "unavailable"}, {"Retry-After": "7"}))
    await expect(workspaces.mine()).rejects.toMatchObject({status: 503, code: "unavailable", retryAfterSeconds: 7})
  })

  test("a plain-text error body keeps the status", async () => {
    const {workspaces} = setup(() => new Response("Bad Gateway", {status: 502}))
    await expect(workspaces.mine()).rejects.toMatchObject({status: 502, code: undefined})
  })

  test("a network failure is status 0 / network_error, after the idempotent retries", async () => {
    const {workspaces, requests} = setup(() => {
      throw new TypeError("Network request failed")
    })
    await expect(workspaces.mine()).rejects.toMatchObject({name: "CoreRequestError", status: 0, code: "network_error"})
    expect(requests).toHaveLength(3)
  })

  test("a POST that fails on the network is not sent twice", async () => {
    const {workspaces, requests} = setup(() => {
      throw new TypeError("Network request failed")
    })
    await expect(workspaces.acceptInvitation("inv-1")).rejects.toMatchObject({status: 0})
    expect(requests).toHaveLength(1)
  })

  test("decline is retried on a network failure (Core makes it idempotent)", async () => {
    const {workspaces, requests} = setup((_url, _init, n) => {
      if (n === 1) throw new TypeError("Network request failed")
      return json(200, {invitationId: "inv-1", declined: true})
    })
    await expect(workspaces.declineInvitation("inv-1")).resolves.toEqual({invitationId: "inv-1", declined: true})
    expect(requests).toHaveLength(2)
  })
})

describe("workspaces: abort", () => {
  test("an aborted signal rejects with its reason and sends nothing", async () => {
    const {workspaces, requests} = setup(() => json(200, {workspace: null}))
    const controller = new AbortController()
    const reason = new Error("stop")
    controller.abort(reason)
    await expect(workspaces.mine({signal: controller.signal})).rejects.toBe(reason)
    expect(requests).toHaveLength(0)
  })

  test("aborting mid-flight rejects with the abort and does not read as a session change", async () => {
    const controller = new AbortController()
    const {workspaces, requests} = setup(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            const error = new Error("aborted")
            error.name = "AbortError"
            reject(error)
          })
        }),
    )
    const pending = workspaces.mine({signal: controller.signal})
    while (requests.length === 0) await new Promise(resolve => setTimeout(resolve, 0))
    controller.abort()
    await expect(pending).rejects.toMatchObject({name: "AbortError"})
  })
})
