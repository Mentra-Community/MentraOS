/// <reference types="bun-types" />

import {beforeEach, describe, expect, mock, test} from "bun:test"

import {cloudClientService} from "./cloudClientServiceTestMock"

mock.module("expo/fetch", () => ({
  fetch: async () => {
    throw new Error("the tests pass their own transport")
  },
}))

const {fetchMiniappBundle, fetchMiniappJson, MAX_MINIAPP_JSON_BYTES, MiniappFetchError, parseMiniappChallenge} =
  await import("../miniappFetch")
type MiniappFetchTransport = import("../miniappFetch").MiniappFetchTransport
type MiniappRequestInit = import("../miniappFetch").MiniappRequestInit

const pkg = "com.acme.tools"
const base = "https://tools.acme.com/app/"
const manifestUrl = `${base}miniapp.json`
const challenge = `Bearer realm="mentra", package="${pkg}"`

interface Sent {
  url: string
  init: MiniappRequestInit
}

interface Answer {
  status: number
  body?: string | Uint8Array
  headers?: Record<string, string>
  /** Where the response says it came from (after redirects). */
  url?: string
}

let sent: Sent[]
let tokens: string[]

/** A transport answering each request with the next answer. */
function serve(...answers: Answer[]): MiniappFetchTransport {
  return async (url, init) => {
    sent.push({url, init})
    const answer = answers.shift()
    if (!answer) throw new Error(`no answer queued for ${url}`)
    const response = new Response(
      answer.body === undefined || answer.status === 304 ? null : (answer.body as BodyInit),
      {
        status: answer.status,
        headers: answer.headers,
      },
    )
    Object.defineProperty(response, "url", {value: answer.url ?? url})
    return response
  }
}

function authorizationOf(request: Sent): string | undefined {
  return request.init.headers.Authorization
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes)
  return Buffer.from(digest).toString("hex")
}

beforeEach(() => {
  sent = []
  tokens = []
  cloudClientService.hasCore = () => true
  cloudClientService.getMiniappAuthToken = async (packageName: string) => {
    tokens.push(packageName)
    return {token: `token-for-${packageName}`, mentraUserId: "user", tenantId: "mentra", expiresAt: 0}
  }
})

describe("the sign-in challenge", () => {
  test.each([
    [challenge, pkg],
    [`bearer realm="mentra",package="${pkg}"`, pkg],
    [`Basic realm="other", Bearer realm="mentra", package="${pkg}"`, pkg],
    [`Bearer package="${pkg}", realm="mentra", error="invalid_token"`, pkg],
  ])("%s names %s", (header, packageName) => {
    expect(parseMiniappChallenge(header)).toEqual({packageName})
  })

  test.each([
    [null],
    [""],
    [`Basic realm="mentra", package="${pkg}"`],
    [`Bearer realm="other", package="${pkg}"`],
    [`Bearer package="${pkg}"`],
    [`Bearer realm="mentra"`],
    [`Bearer realm="mentra", package="Not A Package"`],
    [`Bearer realm="mentra", package="com.my-site.tools"`],
  ])("%p is not a Mentra challenge", (header) => {
    expect(parseMiniappChallenge(header)).toBeNull()
  })
})

describe("fetching miniapp.json", () => {
  test("a public miniapp gets one request with no token, cookie or account", async () => {
    const result = await fetchMiniappJson(manifestUrl, {
      packageForChallenge: true,
      transport: serve({status: 200, body: '{"ok":true}', headers: {etag: '"v1"'}}),
    })
    expect(result).toEqual({status: 200, url: manifestUrl, etag: '"v1"', body: '{"ok":true}'})
    expect(sent).toHaveLength(1)
    expect(sent[0]!.init.credentials).toBe("omit")
    expect(sent[0]!.init.redirect).toBe("follow")
    expect(authorizationOf(sent[0]!)).toBeUndefined()
    expect(Object.keys(sent[0]!.init.headers).map((name) => name.toLowerCase())).not.toContain("cookie")
    expect(tokens).toEqual([])
  })

  test("is conditional on the ETag, and a 304 has no body", async () => {
    const result = await fetchMiniappJson(manifestUrl, {etag: '"v1"', transport: serve({status: 304})})
    expect(result).toEqual({status: 304, url: manifestUrl})
    expect(sent[0]!.init.headers["If-None-Match"]).toBe('"v1"')
  })

  test("Retry-After is kept", async () => {
    const result = await fetchMiniappJson(manifestUrl, {
      transport: serve({status: 503, headers: {"retry-after": "120"}}),
    })
    expect(result).toMatchObject({status: 503, retryAfterMs: 120_000})
  })

  test("a challenge is answered once, with that package's token, to the URL that asked, following no redirects", async () => {
    const result = await fetchMiniappJson(manifestUrl, {
      packageForChallenge: true,
      transport: serve({status: 401, headers: {"www-authenticate": challenge}}, {status: 200, body: "{}"}),
    })
    expect(result).toEqual({status: 200, url: manifestUrl, body: "{}", challenge: {packageName: pkg}})
    expect(tokens).toEqual([pkg])
    expect(sent.map((request) => request.url)).toEqual([manifestUrl, manifestUrl])
    expect(authorizationOf(sent[0]!)).toBeUndefined()
    expect(authorizationOf(sent[1]!)).toBe(`Bearer token-for-${pkg}`)
    expect(sent[1]!.init.redirect).toBe("error")
    expect(sent[1]!.init.credentials).toBe("omit")
  })

  test("a token the server refuses is its answer: there is no second retry", async () => {
    const result = await fetchMiniappJson(manifestUrl, {
      packageForChallenge: true,
      transport: serve(
        {status: 401, headers: {"www-authenticate": challenge}},
        {status: 401, headers: {"www-authenticate": challenge}},
      ),
    })
    expect(result).toMatchObject({status: 401, challenge: {packageName: pkg}})
    expect(sent).toHaveLength(2)
  })

  test("without packageForChallenge, a challenge comes back unanswered", async () => {
    const result = await fetchMiniappJson(manifestUrl, {
      transport: serve({status: 401, headers: {"www-authenticate": challenge}}),
    })
    expect(result).toMatchObject({status: 401, challenge: {packageName: pkg}})
    expect(sent).toHaveLength(1)
    expect(tokens).toEqual([])
  })

  test("a 401 without a Mentra challenge is not answered", async () => {
    const result = await fetchMiniappJson(manifestUrl, {
      packageForChallenge: true,
      transport: serve({status: 401, headers: {"www-authenticate": 'Basic realm="intranet"'}}),
    })
    expect(result).toEqual({status: 401, url: manifestUrl})
    expect(tokens).toEqual([])
  })

  test("a challenge for a package the URL's domain doesn't own gets no token", async () => {
    const promise = fetchMiniappJson(manifestUrl, {
      packageForChallenge: true,
      transport: serve({
        status: 401,
        headers: {"www-authenticate": 'Bearer realm="mentra", package="com.mentra.notes"'},
      }),
    })
    await expect(promise).rejects.toMatchObject({code: "challenge_domain"})
    expect(tokens).toEqual([])
    expect(sent).toHaveLength(1)
  })

  test("a challenge for another package than the caller fetches gets no token", async () => {
    const promise = fetchMiniappJson(manifestUrl, {
      packageForChallenge: "com.acme.notes",
      transport: serve({status: 401, headers: {"www-authenticate": challenge}}),
    })
    await expect(promise).rejects.toMatchObject({code: "challenge_package"})
    expect(tokens).toEqual([])
  })

  test("a challenge after a redirect is checked against, and answered to, the URL that asked", async () => {
    const moved = "https://cdn.acme.com/tools/miniapp.json"
    await fetchMiniappJson(manifestUrl, {
      packageForChallenge: true,
      transport: serve({status: 401, url: moved, headers: {"www-authenticate": challenge}}, {status: 200, body: "{}"}),
    })
    expect(sent.map((request) => request.url)).toEqual([manifestUrl, moved])

    sent = []
    const away = "https://evil.example.org/miniapp.json"
    const promise = fetchMiniappJson(manifestUrl, {
      packageForChallenge: true,
      transport: serve({status: 401, url: away, headers: {"www-authenticate": challenge}}),
    })
    await expect(promise).rejects.toMatchObject({code: "challenge_domain"})
  })

  test("a request with a token that ends anywhere else is refused", async () => {
    const promise = fetchMiniappJson(manifestUrl, {
      packageForChallenge: true,
      transport: serve(
        {status: 401, headers: {"www-authenticate": challenge}},
        {status: 200, body: "{}", url: "https://tools.acme.com/elsewhere/miniapp.json"},
      ),
    })
    await expect(promise).rejects.toMatchObject({code: "network"})
  })

  test("no token can be had without Core, or when Core refuses one", async () => {
    cloudClientService.hasCore = () => false
    const transport = () => serve({status: 401, headers: {"www-authenticate": challenge}})
    await expect(
      fetchMiniappJson(manifestUrl, {packageForChallenge: true, transport: transport()}),
    ).rejects.toMatchObject({code: "no_token"})
    cloudClientService.hasCore = () => true
    cloudClientService.getMiniappAuthToken = async () => {
      throw new Error("Core is down")
    }
    await expect(
      fetchMiniappJson(manifestUrl, {packageForChallenge: true, transport: transport()}),
    ).rejects.toMatchObject({code: "no_token"})
  })

  test("is size-bounded", async () => {
    const promise = fetchMiniappJson(manifestUrl, {
      transport: serve({status: 200, body: "x".repeat(MAX_MINIAPP_JSON_BYTES + 1)}),
    })
    await expect(promise).rejects.toMatchObject({code: "too_large"})
  })

  test("a connection failure is a network error", async () => {
    const promise = fetchMiniappJson(manifestUrl, {
      transport: async () => {
        throw new TypeError("Network request failed")
      },
    })
    await expect(promise).rejects.toBeInstanceOf(MiniappFetchError)
    await expect(promise).rejects.toMatchObject({code: "network"})
  })

  test("a redirect away from HTTPS is refused", async () => {
    const promise = fetchMiniappJson(manifestUrl, {
      transport: serve({status: 200, body: "{}", url: "http://tools.acme.com/app/miniapp.json"}),
    })
    await expect(promise).rejects.toMatchObject({code: "network"})
  })
})

describe("downloading the ZIP", () => {
  const zipUrl = `${base}${pkg}-1.0.0.zip`
  const bytes = new TextEncoder().encode("zip bytes")

  test("downloads anonymously and checks the SHA-256", async () => {
    const hash = await sha256(bytes)
    const result = await fetchMiniappBundle(zipUrl, {
      packageName: pkg,
      sha256: hash,
      transport: serve({status: 200, body: bytes}),
    })
    expect(Array.from(result)).toEqual(Array.from(bytes))
    expect(authorizationOf(sent[0]!)).toBeUndefined()
    expect(sent[0]!.init.credentials).toBe("omit")
  })

  test("bytes with another SHA-256 are refused", async () => {
    const promise = fetchMiniappBundle(zipUrl, {
      packageName: pkg,
      sha256: "0".repeat(64),
      transport: serve({status: 200, body: bytes}),
    })
    await expect(promise).rejects.toMatchObject({code: "integrity"})
  })

  test("its server's challenge is answered for the miniapp's own package only", async () => {
    const hash = await sha256(bytes)
    let challenged = 0
    const result = await fetchMiniappBundle(zipUrl, {
      packageName: pkg,
      sha256: hash,
      onChallenge: () => {
        challenged += 1
      },
      transport: serve({status: 401, headers: {"www-authenticate": challenge}}, {status: 200, body: bytes}),
    })
    expect(result.byteLength).toBe(bytes.byteLength)
    expect(challenged).toBe(1)
    expect(tokens).toEqual([pkg])
    expect(authorizationOf(sent[1]!)).toBe(`Bearer token-for-${pkg}`)
    expect(sent[1]!.init.redirect).toBe("error")

    sent = []
    tokens = []
    const other = fetchMiniappBundle(zipUrl, {
      packageName: pkg,
      sha256: hash,
      transport: serve({status: 401, headers: {"www-authenticate": 'Bearer realm="mentra", package="com.acme.other"'}}),
    })
    await expect(other).rejects.toMatchObject({code: "challenge_package"})
    expect(tokens).toEqual([])
  })

  test("a refused token is the server's HTTP answer", async () => {
    const promise = fetchMiniappBundle(zipUrl, {
      packageName: pkg,
      sha256: "0".repeat(64),
      transport: serve({status: 401, headers: {"www-authenticate": challenge}}, {status: 403}),
    })
    await expect(promise).rejects.toMatchObject({code: "http", status: 403})
  })

  test("a declared size over the limit is refused before reading", async () => {
    const promise = fetchMiniappBundle(zipUrl, {
      packageName: pkg,
      sha256: "0".repeat(64),
      transport: serve({status: 200, body: bytes, headers: {"content-length": String(60 * 1024 * 1024)}}),
    })
    await expect(promise).rejects.toMatchObject({code: "too_large"})
  })
})
