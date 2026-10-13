import {afterEach, beforeEach, describe, expect, test} from "bun:test"

import {ensureOidcClient} from "./api"
import {CLI_LOOPBACK_PORTS, loopbackLogin, LoginError} from "./loopback-login"
import {startFakeOidcIssuer, type FakeOidcIssuer} from "./testing/fake-oidc-issuer"
import {expectLoopbackPortsFree, occupy, rawGet} from "./testing/loopback"

const SIGNED_IN = "Signed in to Mentra. You can close this tab."

let idp: FakeOidcIssuer
const releases: Array<() => Promise<void>> = []

beforeEach(async () => {
  idp = await startFakeOidcIssuer({publicClientId: "mentra-cli"})
})

afterEach(async () => {
  for (const release of releases.splice(0)) await release()
  idp.stop()
  // No test may leave a listener on the CLI's ports.
  await expectLoopbackPortsFree()
})

async function oidc() {
  return ensureOidcClient({oidcIssuer: idp.issuer, cliClientId: "mentra-cli"})
}

function portOf(authorizationUrl: string): number {
  return Number(new URL(new URL(authorizationUrl).searchParams.get("redirect_uri")!).port)
}

describe("loopbackLogin", () => {
  test("loopback login redeems the code once and stores the refresh token (L09)", async () => {
    let opened = ""
    let browser: Promise<{status: number; text: string}> | undefined
    const result = await loopbackLogin(await oidc(), {
      openBrowser: async url => {
        opened = url
        browser = idp.approveInBrowser(url, {sub: "mu_1", email: "ada@example.com"})
        return true
      },
      print: () => {},
    })
    const request = new URL(opened)
    expect(request.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:53682/callback")
    expect(request.searchParams.get("code_challenge_method")).toBe("S256")
    expect(request.searchParams.get("scope")).toBe("openid email profile offline_access")
    expect(request.searchParams.get("state")).toBeTruthy()
    expect(request.searchParams.get("nonce")).toBeTruthy()
    expect(result.refreshToken).toBeTruthy()
    expect(result.accessToken).toBeTruthy()
    expect(result.subject).toBe("mu_1")
    expect(result.email).toBe("ada@example.com")
    expect(result.expiresAt).toBeGreaterThan(Date.now() + 3_000_000)
    expect(idp.codeRedemptions).toBe(1)
    expect(await browser).toEqual({status: 200, text: SIGNED_IN})
  })

  test("each login uses fresh state, nonce and PKCE", async () => {
    const urls: string[] = []
    for (let i = 0; i < 2; i++) {
      let browser: Promise<unknown> | undefined
      await loopbackLogin(await oidc(), {
        openBrowser: async url => {
          urls.push(url)
          browser = idp.approveInBrowser(url, {sub: "mu_1"})
          return true
        },
        print: () => {},
      })
      await browser
    }
    const [first, second] = urls.map(url => new URL(url).searchParams)
    for (const name of ["state", "nonce", "code_challenge"]) expect(first!.get(name)).not.toBe(second!.get(name))
  })

  test("with port 53682 taken, login uses 53683", async () => {
    releases.push(await occupy(53682))
    let browser: Promise<unknown> | undefined
    let opened = ""
    await loopbackLogin(await oidc(), {
      openBrowser: async url => {
        opened = url
        browser = idp.approveInBrowser(url, {sub: "mu_1"})
        return true
      },
      print: () => {},
    })
    await browser
    expect(new URL(opened).searchParams.get("redirect_uri")).toBe("http://127.0.0.1:53683/callback")
  })

  test("with every loopback port taken, login fails naming the ports", async () => {
    for (const port of CLI_LOOPBACK_PORTS) releases.push(await occupy(port))
    const error = await loopbackLogin(await oidc(), {openBrowser: async () => true, print: () => {}}).catch(caught => caught)
    expect(error).toBeInstanceOf(LoginError)
    expect((error as Error).message).toContain("53682, 53683 and 53684")
    expect(idp.authorizationRequests).toHaveLength(0)
  })

  test("a callback with the wrong state is refused and the login keeps waiting for the right one", async () => {
    let browser: Promise<unknown> | undefined
    let refused: {status: number; text: string} | undefined
    const result = await loopbackLogin(await oidc(), {
      openBrowser: async url => {
        const port = portOf(url)
        refused = await rawGet(port, "/callback?code=stolen&state=not-the-state", `127.0.0.1:${port}`)
        browser = idp.approveInBrowser(url, {sub: "mu_1"})
        return true
      },
      print: () => {},
    })
    await browser
    expect(refused!.status).toBe(400)
    expect(refused!.text).not.toContain("stolen")
    expect(result.subject).toBe("mu_1")
    expect(idp.codeRedemptions).toBe(1)
  })

  test("a callback with another Host is refused and the login keeps waiting for the right one", async () => {
    let browser: Promise<unknown> | undefined
    let refused: {status: number; text: string} | undefined
    const result = await loopbackLogin(await oidc(), {
      openBrowser: async url => {
        const port = portOf(url)
        const state = new URL(url).searchParams.get("state")!
        // A page on another site (DNS rebinding) reaches the port with its own Host.
        refused = await rawGet(port, `/callback?code=forged&state=${state}`, `evil.example:${port}`)
        browser = idp.approveInBrowser(url, {sub: "mu_1"})
        return true
      },
      print: () => {},
    })
    await browser
    expect(refused!.status).toBe(400)
    expect(result.subject).toBe("mu_1")
    expect(idp.codeRedemptions).toBe(1)
  })

  test("only refused callbacks: the login times out", async () => {
    const error = await loopbackLogin(await oidc(), {
      openBrowser: async url => {
        const port = portOf(url)
        await rawGet(port, "/callback?code=x&state=wrong", `127.0.0.1:${port}`)
        await rawGet(port, "/callback?code=x&state=wrong", `localhost:${port}`)
        return true
      },
      print: () => {},
      timeoutMs: 400,
    }).catch(caught => caught)
    expect(error).toBeInstanceOf(LoginError)
    expect((error as Error).message).toContain("timed out")
    expect(idp.codeRedemptions).toBe(0)
  })

  test("an error callback with the right state ends the login with a clear message", async () => {
    let browser: Promise<{status: number; text: string}> | undefined
    const error = await loopbackLogin(await oidc(), {
      openBrowser: async url => {
        browser = idp.denyInBrowser(url, "access_denied")
        return true
      },
      print: () => {},
    }).catch(caught => caught)
    expect(error).toBeInstanceOf(LoginError)
    expect((error as Error).message).toBe("Sign-in was cancelled in the browser. Run `mentra login` to try again.")
    const page = await browser!
    expect(page.status).toBe(400)
    expect(page.text).not.toContain("access_denied")
    expect(idp.codeRedemptions).toBe(0)
  })

  test("the browser gets fixed text and never the request's data", async () => {
    const error = await loopbackLogin(await oidc(), {
      openBrowser: async url => {
        const port = portOf(url)
        const state = new URL(url).searchParams.get("state")!
        const probe = "%3Cscript%3Ealert(1)%3C%2Fscript%3E"
        for (const path of [`/callback?state=${probe}`, `/other?${probe}`, `/callback?state=${state}&error=${probe}`]) {
          const page = await rawGet(port, path, `127.0.0.1:${port}`)
          expect(page.text).not.toContain("script")
          expect(page.text).not.toContain("alert")
        }
        return true
      },
      print: () => {},
    }).catch(caught => caught)
    expect((error as Error).message).toBe("Sign-in did not complete (unknown_error). Run `mentra login` to try again.")
  })

  test("a code the issuer refuses ends the login", async () => {
    const error = await loopbackLogin(await oidc(), {
      openBrowser: async url => {
        const port = portOf(url)
        const state = new URL(url).searchParams.get("state")!
        const page = await rawGet(port, `/callback?code=unknown&state=${state}&iss=${encodeURIComponent(idp.issuer)}`, `127.0.0.1:${port}`)
        expect(page.status).toBe(400)
        return true
      },
      print: () => {},
    }).catch(caught => caught)
    expect(error).toBeInstanceOf(LoginError)
    expect((error as Error).message).toContain("invalid_grant")
  })

  test("the URL is always printed, and how to reach the port when no browser opens", async () => {
    const lines: string[] = []
    let opened = ""
    let browser: Promise<unknown> | undefined
    await loopbackLogin(await oidc(), {
      openBrowser: async url => {
        opened = url
        browser = idp.approveInBrowser(url, {sub: "mu_1"})
        return false
      },
      print: line => lines.push(line),
    })
    await browser
    expect(lines).toContain(opened)
    expect(lines.join("\n")).toContain("ssh -L 53682:127.0.0.1:53682")
  })
})
