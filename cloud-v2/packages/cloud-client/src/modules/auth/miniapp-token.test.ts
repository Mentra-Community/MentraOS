import {describe, expect, test} from "bun:test"
import {Auth} from "./auth"
import {TokenStore} from "./token-store"
import type {AuthConfig} from "../../config"
import {AuthExpiredError, HttpError} from "../../errors"
import type {HttpClient} from "../../http"
import {noopLogger} from "../../logger"
import type {HttpTransport} from "../../transports"

/**
 * The miniapp token contract: the default call serves a cached token until it nears expiry, while `fresh: true`
 * always reaches Core, so a feature granted since the last mint (a purchase) is in the token the miniapp gets.
 * Mints for one package run one at a time, and a fresh caller shares only a mint whose request has not left yet.
 */

const PACKAGE = "com.mentra.call"

const jwt = (exp: number) => {
  const payload = Buffer.from(JSON.stringify({sub: "account-1", tenant_id: "consumer", exp})).toString("base64url")
  return `e30.${payload}.test`
}

const CONFIG: AuthConfig = {
  core: {subjectToken: "subject", subjectTokenType: "oidc"},
  runtime: {source: "core"},
}

interface Post {
  packageName: string
  bearer: string | undefined
  /** Answer this request with a token (or an error). */
  respond: (result: {token: string; expiresAt: number} | Error) => void
}

/**
 * An Auth over a fake Core. `/exchange` answers at once; each miniapp-token request is recorded and answered
 * either immediately (`auto`) or when the test calls `respond`, so the test decides what is in flight.
 */
function harness(opts: {auto?: boolean} = {}) {
  const posts: Post[] = []
  let minted = 0
  let inFlight = 0
  let maxInFlight = 0
  const mintedAt = () => Math.floor(Date.now() / 1000) + 3600
  const http = {
    post: <T>(path: string, body?: unknown, reqOpts?: {bearer?: string}) => {
      if (path === "/api/client/auth/revoke") return Promise.resolve({} as T)
      expect(path).toBe("/api/client/auth/miniapp-token")
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      return new Promise<T>((resolve, reject) => {
        const post: Post = {
          packageName: (body as {packageName: string}).packageName,
          bearer: reqOpts?.bearer,
          respond: (result) => {
            inFlight -= 1
            if (result instanceof Error) reject(result)
            else resolve(result as T)
          },
        }
        posts.push(post)
        if (opts.auto) post.respond({token: `miniapp-${++minted}`, expiresAt: mintedAt()})
      })
    },
  } as unknown as HttpClient
  const transport: HttpTransport = async () =>
    Response.json({
      access_token: jwt(Math.floor(Date.now() / 1000) + 3600),
      refresh_token: "refresh-1",
      token_type: "Bearer",
      expires_in: 3600,
    })
  const values = new Map<string, string>()
  const storage = {
    get: async (key: string) => values.get(key) ?? null,
    set: async (key: string, value: string) => {
      values.set(key, value)
    },
    delete: async (key: string) => {
      values.delete(key)
    },
  }
  const auth = new Auth({
    http,
    store: new TokenStore({storage}),
    config: CONFIG,
    logger: noopLogger,
    baseUrl: "https://core.example.test",
    fetch: transport,
  })
  return {
    auth,
    posts,
    maxInFlight: () => maxInFlight,
    answer: (post: Post, token: string) => post.respond({token, expiresAt: mintedAt()}),
  }
}

/** Let every microtask the code under test has queued run, then the timers that follow them. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

describe("a default miniapp token request", () => {
  test("is served from the cache until the token nears expiry", async () => {
    const t = harness({auto: true})

    const first = await t.auth.getMiniappToken(PACKAGE)
    const second = await t.auth.getMiniappToken(PACKAGE)

    expect(second).toEqual(first)
    expect(t.posts).toHaveLength(1)
  })

  test("shares one mint between concurrent callers", async () => {
    const t = harness({auto: true})

    const [a, b] = await Promise.all([t.auth.getMiniappToken(PACKAGE), t.auth.getMiniappToken(PACKAGE)])

    expect(b).toEqual(a)
    expect(t.posts).toHaveLength(1)
  })

  test("joins a mint that is already in flight rather than starting another", async () => {
    const t = harness()

    const first = t.auth.getMiniappToken(PACKAGE)
    await settle()
    expect(t.posts).toHaveLength(1)
    const second = t.auth.getMiniappToken(PACKAGE)
    await settle()
    expect(t.posts).toHaveLength(1)

    t.answer(t.posts[0], "only")
    expect((await first).token).toBe("only")
    expect((await second).token).toBe("only")
  })
})

describe("a fresh miniapp token request", () => {
  test("mints on every call, even with a valid cached token: two opens within an hour mint two tokens", async () => {
    const t = harness({auto: true})

    const first = await t.auth.getMiniappToken(PACKAGE, {fresh: true})
    const second = await t.auth.getMiniappToken(PACKAGE, {fresh: true})

    expect(t.posts).toHaveLength(2)
    expect(second.token).not.toBe(first.token)
  })

  test("skips a valid cached token that an earlier default call left", async () => {
    const t = harness({auto: true})
    const cached = await t.auth.getMiniappToken(PACKAGE)

    const fresh = await t.auth.getMiniappToken(PACKAGE, {fresh: true})

    expect(fresh.token).not.toBe(cached.token)
    expect(t.posts).toHaveLength(2)
  })

  test("leaves its token in the cache for the default calls that follow", async () => {
    const t = harness({auto: true})
    const fresh = await t.auth.getMiniappToken(PACKAGE, {fresh: true})

    const later = await t.auth.getMiniappToken(PACKAGE)

    expect(later.token).toBe(fresh.token)
    expect(t.posts).toHaveLength(1)
  })

  test("sends the Core access token as the Bearer and names only the package", async () => {
    const t = harness({auto: true})

    await t.auth.getMiniappToken(PACKAGE, {fresh: true})

    expect(t.posts[0].packageName).toBe(PACKAGE)
    expect(t.posts[0].bearer).toStartWith("e30.")
  })

  test("concurrent requests made before the first request has left mint once", async () => {
    const t = harness({auto: true})

    const [connect, foreground] = await Promise.all([
      t.auth.getMiniappToken(PACKAGE, {fresh: true}),
      t.auth.getMiniappToken(PACKAGE, {fresh: true}),
    ])

    expect(foreground).toEqual(connect)
    expect(t.posts).toHaveLength(1)
  })

  test("does not reuse a mint whose request went out before the call", async () => {
    const t = harness()

    const older = t.auth.getMiniappToken(PACKAGE, {fresh: true})
    await settle()
    expect(t.posts).toHaveLength(1)

    // Core may already have read the user's features for the older request.
    const newer = t.auth.getMiniappToken(PACKAGE, {fresh: true})
    await settle()
    expect(t.posts).toHaveLength(1)

    t.answer(t.posts[0], "older")
    await settle()
    expect(t.posts).toHaveLength(2)
    t.answer(t.posts[1], "newer")

    expect((await older).token).toBe("older")
    expect((await newer).token).toBe("newer")
    expect(t.maxInFlight()).toBe(1)
  })

  test("callers that arrive while that follow-up has not left share it", async () => {
    const t = harness()
    const older = t.auth.getMiniappToken(PACKAGE, {fresh: true})
    await settle()

    const second = t.auth.getMiniappToken(PACKAGE, {fresh: true})
    const third = t.auth.getMiniappToken(PACKAGE, {fresh: true})
    await settle()
    t.answer(t.posts[0], "older")
    await settle()
    expect(t.posts).toHaveLength(2)
    t.answer(t.posts[1], "newer")

    expect((await older).token).toBe("older")
    expect((await second).token).toBe("newer")
    expect((await third).token).toBe("newer")
    expect(t.posts).toHaveLength(2)
  })

  test("a caller that arrives once the follow-up has left gets another one", async () => {
    const t = harness()
    const first = t.auth.getMiniappToken(PACKAGE, {fresh: true})
    await settle()
    const second = t.auth.getMiniappToken(PACKAGE, {fresh: true})
    await settle()
    t.answer(t.posts[0], "one")
    await settle()
    expect(t.posts).toHaveLength(2)

    const third = t.auth.getMiniappToken(PACKAGE, {fresh: true})
    await settle()
    t.answer(t.posts[1], "two")
    await settle()
    expect(t.posts).toHaveLength(3)
    t.answer(t.posts[2], "three")

    expect((await first).token).toBe("one")
    expect((await second).token).toBe("two")
    expect((await third).token).toBe("three")
    expect(t.maxInFlight()).toBe(1)
  })

  test("a default caller that arrives during a mint takes the latest one and starts none", async () => {
    const t = harness()
    const fresh = t.auth.getMiniappToken(PACKAGE, {fresh: true})
    await settle()

    const plain = t.auth.getMiniappToken(PACKAGE)
    await settle()
    expect(t.posts).toHaveLength(1)
    t.answer(t.posts[0], "only")

    expect((await fresh).token).toBe("only")
    expect((await plain).token).toBe("only")
    expect(t.posts).toHaveLength(1)
  })

  test("different packages mint independently", async () => {
    const t = harness()
    const call = t.auth.getMiniappToken(PACKAGE, {fresh: true})
    const notes = t.auth.getMiniappToken("com.mentra.notes", {fresh: true})
    await settle()

    expect(t.posts.map((post) => post.packageName).sort()).toEqual(["com.mentra.call", "com.mentra.notes"])
    t.answer(t.posts[0], "a")
    t.answer(t.posts[1], "b")
    await Promise.all([call, notes])
  })

  test("a failed mint rejects its callers and is not cached", async () => {
    const t = harness()
    const failed = t.auth.getMiniappToken(PACKAGE, {fresh: true})
    const failedResult = failed.catch((error) => error)
    await settle()
    t.posts[0].respond(new HttpError("boom", 503))
    expect(await failedResult).toBeInstanceOf(HttpError)

    const retry = t.auth.getMiniappToken(PACKAGE, {fresh: true})
    await settle()
    expect(t.posts).toHaveLength(2)
    t.answer(t.posts[1], "recovered")
    expect((await retry).token).toBe("recovered")
  })

  test("a follow-up still mints when the older mint it waited for failed", async () => {
    const t = harness()
    const older = t.auth.getMiniappToken(PACKAGE, {fresh: true}).catch((error) => error)
    await settle()
    const newer = t.auth.getMiniappToken(PACKAGE, {fresh: true})
    await settle()

    t.posts[0].respond(new HttpError("boom", 503))
    await settle()
    expect(await older).toBeInstanceOf(HttpError)
    expect(t.posts).toHaveLength(2)
    t.answer(t.posts[1], "newer")
    expect((await newer).token).toBe("newer")
  })

  test("a mint that answers after logout restores nothing", async () => {
    const t = harness()
    const pending = t.auth.getMiniappToken(PACKAGE, {fresh: true}).catch((error) => error)
    await settle()

    await t.auth.clearSession()
    t.answer(t.posts[0], "late")

    expect(await pending).toBeInstanceOf(AuthExpiredError)
    await expect(t.auth.getMiniappToken(PACKAGE)).rejects.toBeInstanceOf(AuthExpiredError)
  })
})
