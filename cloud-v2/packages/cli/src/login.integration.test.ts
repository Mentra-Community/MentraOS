/**
 * @fileoverview `mentra login`, `whoami`, `workspace`, `logout` and Core
 * requests, run as the real CLI in a child process against a fake sign-in
 * server (behaving like Core's) and a fake Core. No real keychain, browser or
 * network: the
 * keychain is turned off so the login is a file under `MENTRA_CLI_HOME`, and
 * `open`/`xdg-open` only record the URL they were given.
 */

import {afterEach, beforeEach, describe, expect, setDefaultTimeout, test} from "bun:test"
import {chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync} from "node:fs"
import {tmpdir} from "node:os"
import {join} from "node:path"

import {startFakeOidcIssuer, type FakeOidcIssuer} from "./testing/fake-oidc-issuer"
import {startFakeCore, type FakeService} from "./testing/fake-services"
import {expectLoopbackPortsFree, freeLoopbackPorts} from "./testing/loopback"

const INDEX = new URL("./index.ts", import.meta.url).pathname

// Each case starts the CLI in a child process, some several times.
setDefaultTimeout(30_000)

let dir = ""
let idp: FakeOidcIssuer
const services: FakeService[] = []
/** The CLI's ports free when the test starts: the ones it will use, in order. */
let freePorts: number[] = []

beforeEach(async () => {
  freePorts = await freeLoopbackPorts()
  dir = mkdtempSync(join(tmpdir(), "mentra-cli-login-"))
  idp = await startFakeOidcIssuer({publicClientId: "mentra-cli"})
  // The browser launchers record the URL and exit, as `open` does.
  for (const launcher of ["open", "xdg-open"]) {
    writeFileSync(join(dir, launcher), `#!/bin/sh\nprintf '%s' "$1" > '${join(dir, "opened-url")}'\n`)
    chmodSync(join(dir, launcher), 0o755)
  }
  // No keychain: logins go to mode-0600 files under MENTRA_CLI_HOME. Console output goes to files.
  writeFileSync(
    join(dir, "preload.ts"),
    `import {appendFileSync} from "node:fs";
Object.defineProperty(Bun, "secrets", {value: undefined});
console.log = (...args) => appendFileSync(${JSON.stringify(join(dir, "stdout"))}, args.join(" ") + "\\n");
console.error = (...args) => appendFileSync(${JSON.stringify(join(dir, "stderr"))}, args.join(" ") + "\\n");`,
  )
})

afterEach(async () => {
  for (const service of services.splice(0)) service.stop()
  idp.stop()
  rmSync(dir, {recursive: true, force: true})
  await expectLoopbackPortsFree(freePorts)
})

function core(options: Omit<Parameters<typeof startFakeCore>[0], "idp"> = {}): FakeService {
  const service = startFakeCore({idp, ...options})
  services.push(service)
  return service
}

const home = () => join(dir, "cli-home")

/** Run the CLI. `whileRunning` gets the child's console so far and can act on it (for example, approve a sign-in). */
async function cli(
  args: string[],
  env: Record<string, string>,
  whileRunning?: (output: () => string) => Promise<void>,
): Promise<{code: number; stdout: string; stderr: string}> {
  for (const name of ["stdout", "stderr"]) writeFileSync(join(dir, name), "")
  const child = Bun.spawn([process.execPath, "--preload", join(dir, "preload.ts"), INDEX, ...args], {
    cwd: dir,
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH}`,
      MENTRA_CLI_HOME: home(),
      MENTRA_CLI_OIDC_ISSUER: "",
      MENTRA_CLI_CLIENT_ID: "",
      MENTRA_CORE_URL: "",
      ...env,
    },
    stdout: "ignore",
    stderr: "pipe",
  })
  const output = () => readFileSync(join(dir, "stdout"), "utf8")
  if (whileRunning) await whileRunning(output)
  const code = await child.exited
  const stderr = readFileSync(join(dir, "stderr"), "utf8") + (await new Response(child.stderr).text())
  return {code, stdout: output(), stderr}
}

async function eventually<T>(read: () => T | null | undefined, what: string): Promise<T> {
  for (let i = 0; i < 200; i++) {
    const value = read()
    if (value) return value
    await Bun.sleep(25)
  }
  throw new Error(`timed out waiting for ${what}`)
}

/** The sign-in URL the CLI printed. */
function printedUrl(output: string): string | null {
  return output.split("\n").find(line => line.startsWith(`${idp.issuer}/authorize?`)) ?? null
}

/** `mentra login --no-browser`, approved in the "browser" as `sub`. */
async function login(env: Record<string, string>, person = {sub: "mu_1", email: "ada@example.com"}) {
  let page: {status: number; text: string} | undefined
  const result = await cli(["login", "--no-browser"], env, async output => {
    const url = await eventually(() => printedUrl(output()), "the sign-in URL")
    page = await idp.approveInBrowser(url, person)
  })
  return {...result, page}
}

function storedLoginFile(): string {
  const files = existsSync(home()) ? readdirSync(home()).filter(name => name.endsWith(".json")) : []
  expect(files).toHaveLength(1)
  return join(home(), files[0]!)
}

const storedLogin = () => JSON.parse(readFileSync(storedLoginFile(), "utf8")) as Record<string, string>

/** The Core requests after the sign-in settings, as [method, path, bearer]. */
const coreCalls = (service: FakeService, from = 0) =>
  service.requests.slice(from).filter(request => request.path !== "/api/cli/config").map(request => [request.method, request.path, request.authorization])

describe("mentra login", () => {
  test("login opens the browser, redeems the code once, stores the refresh token for its Core and prints the email (L09)", async () => {
    const mentra = core()
    let page: {status: number; text: string} | undefined
    const result = await cli(["login"], {MENTRA_CORE_URL: mentra.url}, async () => {
      const url = await eventually(() => (existsSync(join(dir, "opened-url")) ? readFileSync(join(dir, "opened-url"), "utf8") : null), "the browser")
      page = await idp.approveInBrowser(url, {sub: "mu_1", email: "ada@example.com"})
    })
    expect(result.stderr).toBe("")
    expect(result.code).toBe(0)
    expect(page).toEqual({status: 200, text: "Signed in to Mentra. You can close this tab."})
    expect(printedUrl(result.stdout)).toBe(readFileSync(join(dir, "opened-url"), "utf8"))
    expect(result.stdout).toContain("Signed in as ada@example.com\n")
    expect(result.stdout).toContain(`Core: ${mentra.url}\n`)
    expect(idp.codeRedemptions).toBe(1)

    const saved = storedLogin()
    expect(statSync(storedLoginFile()).mode & 0o777).toBe(0o600)
    expect(saved).toMatchObject({mentraUserId: "mu_1", email: "ada@example.com", issuer: idp.issuer, clientId: "mentra-cli", coreUrl: mentra.url})
    expect(saved.storeUrl).toBeUndefined()
    expect(saved.workspaceId).toBeUndefined()
    expect(idp.refreshTokenActive(saved.refreshToken!)).toBe(true)
    // Core named the sign-in server, unauthenticated, and was asked nothing else.
    expect(mentra.requests).toEqual([{method: "GET", path: "/api/cli/config", authorization: null}])
  })

  test("--no-browser prints the URL and still completes", async () => {
    const mentra = core()
    const result = await login({MENTRA_CORE_URL: mentra.url})
    expect(result.code).toBe(0)
    expect(existsSync(join(dir, "opened-url"))).toBe(false)
    expect(result.stdout).toContain(`ssh -L ${freePorts[0]}:127.0.0.1:${freePorts[0]} <host>`)
    expect(result.stdout).toContain("Signed in as ada@example.com")
    expect(storedLogin().refreshToken).toBeTruthy()
  })

  test("--no-open still works as --no-browser", async () => {
    const mentra = core()
    let completed = false
    const result = await cli(["login", "--no-open"], {MENTRA_CORE_URL: mentra.url}, async output => {
      await idp.approveInBrowser(await eventually(() => printedUrl(output()), "the sign-in URL"), {sub: "mu_1"})
      completed = true
    })
    expect(completed).toBe(true)
    expect(result.code).toBe(0)
    expect(existsSync(join(dir, "opened-url"))).toBe(false)
  })

  test("a declined sign-in fails with a clear message and stores nothing", async () => {
    const mentra = core()
    const result = await cli(["login", "--no-browser"], {MENTRA_CORE_URL: mentra.url}, async output => {
      await idp.denyInBrowser(await eventually(() => printedUrl(output()), "the sign-in URL"))
    })
    expect(result.code).toBe(1)
    expect(result.stderr).toContain("Sign-in was cancelled in the browser. Run `mentra login` to try again.")
    expect(existsSync(home()) ? readdirSync(home()).filter(name => name.endsWith(".json")) : []).toEqual([])
  })

  test("--core-url selects the Core for one run, over MENTRA_CORE_URL", async () => {
    const mentra = core()
    const signedIn = await login({MENTRA_CORE_URL: mentra.url})
    expect(signedIn.code).toBe(0)
    const whoami = await cli(["--core-url", mentra.url, "whoami"], {MENTRA_CORE_URL: "https://elsewhere.example.test"})
    expect(whoami.code).toBe(0)
    expect(whoami.stdout).toContain(`Core: ${mentra.url}\n`)
    expect(whoami.stdout).toContain("Core user: mu_1\n")
  })
})

describe("a stored login", () => {
  test("whoami shows the email, Core user, issuer, Core and expiry", async () => {
    const mentra = core()
    await login({MENTRA_CORE_URL: mentra.url})
    const result = await cli(["whoami"], {MENTRA_CORE_URL: mentra.url})
    expect(result.code).toBe(0)
    expect(result.stdout).toContain("Email: ada@example.com\n")
    expect(result.stdout).toContain("Core user: mu_1\n")
    expect(result.stdout).toContain(`Issuer: ${idp.issuer}\n`)
    expect(result.stdout).toContain(`Core: ${mentra.url}\n`)
    expect(result.stdout).toContain("Expires: ")
  })

  test("workspace show asks Core with the bearer and shows the workspace and role", async () => {
    const mentra = core()
    await login({MENTRA_CORE_URL: mentra.url})
    const seen = mentra.requests.length
    const result = await cli(["workspace", "show"], {MENTRA_CORE_URL: mentra.url})
    expect(result.code).toBe(0)
    expect(result.stdout).toBe("Workspace: Team One (ws_1)\nRole: owner\n")
    expect(coreCalls(mentra, seen)).toEqual([["GET", "/api/workspaces", `Bearer ${storedLogin().token}`]])
  })

  test("workspace show says how to create one, and an account in several says to contact support", async () => {
    const none = core({workspaces: []})
    await login({MENTRA_CORE_URL: none.url})
    const empty = await cli(["workspace", "show"], {MENTRA_CORE_URL: none.url})
    expect(empty.code).toBe(0)
    expect(empty.stdout).toBe("This account has no workspace. Create one with `mentra workspace create <name>`.\n")

    const several = core({
      workspaces: [
        {workspaceId: "ws_1", name: "One"},
        {workspaceId: "ws_2", name: "Two"},
      ],
    })
    await login({MENTRA_CORE_URL: several.url})
    const result = await cli(["workspace", "show"], {MENTRA_CORE_URL: several.url})
    expect(result.code).toBe(0)
    expect(result.stdout).toContain("This account is in more than one workspace, which Mentra no longer allows.")
    expect(result.stdout).toContain("  ws_1\tOne\n  ws_2\tTwo\n")
  })

  test("workspace create creates it at Core", async () => {
    const mentra = core({workspaces: []})
    await login({MENTRA_CORE_URL: mentra.url})
    const seen = mentra.requests.length
    const result = await cli(["workspace", "create", "Acme Robotics"], {MENTRA_CORE_URL: mentra.url})
    expect(result.code).toBe(0)
    expect(result.stdout).toBe("Workspace created: Acme Robotics (ws_new)\n")
    expect(coreCalls(mentra, seen)).toEqual([["POST", "/api/workspaces", `Bearer ${storedLogin().token}`]])
    expect((await cli(["workspace", "show"], {MENTRA_CORE_URL: mentra.url})).stdout).toContain("Workspace: Acme Robotics (ws_new)")
  })

  test("refresh rotates the stored refresh token before the new access token is used", async () => {
    const mentra = core()
    await login({MENTRA_CORE_URL: mentra.url})
    const before = storedLogin()
    // The access token expires within the minute: the next command refreshes first.
    writeFileSync(storedLoginFile(), JSON.stringify({...before, expiresAt: new Date(Date.now() + 30_000).toISOString()}))
    const result = await cli(["workspace", "show"], {MENTRA_CORE_URL: mentra.url})
    expect(result.code).toBe(0)
    const after = storedLogin()
    expect(idp.refreshes).toBe(1)
    expect(after.refreshToken).not.toBe(before.refreshToken)
    expect(idp.refreshTokenActive(before.refreshToken!)).toBe(false)
    expect(idp.refreshTokenActive(after.refreshToken!)).toBe(true)
    expect(mentra.requests.at(-1)).toMatchObject({path: "/api/workspaces", authorization: `Bearer ${after.token}`})
  })

  test("a refused refresh says Session expired and clears the login", async () => {
    const mentra = core()
    await login({MENTRA_CORE_URL: mentra.url})
    const before = storedLogin()
    // Revoked elsewhere: the sign-in server no longer accepts this login's refresh token.
    await fetch(`${idp.issuer}/revoke`, {
      method: "POST",
      body: new URLSearchParams({token: before.refreshToken!, client_id: "mentra-cli"}),
    })
    writeFileSync(storedLoginFile(), JSON.stringify({...before, expiresAt: new Date(Date.now() - 1000).toISOString()}))
    const result = await cli(["workspace", "show"], {MENTRA_CORE_URL: mentra.url})
    expect(result.code).toBe(1)
    expect(result.stderr).toContain("Session expired. Run `mentra login`.")
    expect(readdirSync(home()).filter(name => name.endsWith(".json"))).toEqual([])
  })

  test("a Core refusal of an access token whose sign-in has ended ends the login at that request", async () => {
    const mentra = core()
    await login({MENTRA_CORE_URL: mentra.url})
    const before = storedLogin()
    // "Log out everywhere": the grant is gone, so its access token and refresh token are both refused,
    // although the access token has not expired.
    await fetch(`${idp.issuer}/revoke`, {
      method: "POST",
      body: new URLSearchParams({token: before.refreshToken!, client_id: "mentra-cli"}),
    })
    const seen = mentra.requests.length
    const tokenRequests = idp.requests.filter(request => request === "POST /token").length
    const result = await cli(["workspace", "show"], {MENTRA_CORE_URL: mentra.url})
    expect(result.code).toBe(1)
    expect(result.stderr).toContain("Session expired. Run `mentra login`.")
    expect(readdirSync(home()).filter(name => name.endsWith(".json"))).toEqual([])
    // One refused request, one refused refresh, and no retry.
    expect(coreCalls(mentra, seen)).toEqual([["GET", "/api/workspaces", `Bearer ${before.token}`]])
    expect(idp.requests.filter(request => request === "POST /token").length - tokenRequests).toBe(1)
    expect(idp.refreshes).toBe(0)
  })

  test("a Core refusal of an access token whose sign-in is still live refreshes the login and retries once", async () => {
    const mentra = core()
    await login({MENTRA_CORE_URL: mentra.url})
    const before = storedLogin()
    idp.refuseAccessToken(before.token!)
    const seen = mentra.requests.length
    const result = await cli(["workspace", "show"], {MENTRA_CORE_URL: mentra.url})
    expect(result.code).toBe(0)
    expect(result.stdout).toContain("Workspace: Team One (ws_1)")
    const after = storedLogin()
    expect(idp.refreshes).toBe(1)
    expect(after.token).not.toBe(before.token)
    expect(after.refreshToken).not.toBe(before.refreshToken)
    // Only the first request carried the refused token; the retry carries the new one.
    expect(coreCalls(mentra, seen)).toEqual([
      ["GET", "/api/workspaces", `Bearer ${before.token}`],
      ["GET", "/api/workspaces", `Bearer ${after.token}`],
    ])
  })

  test("logout revokes the refresh token at the revocation endpoint and prints Signed out; the old refresh token then fails (L09)", async () => {
    const mentra = core()
    await login({MENTRA_CORE_URL: mentra.url})
    const before = storedLogin()
    const result = await cli(["logout"], {MENTRA_CORE_URL: mentra.url})
    expect(result.code).toBe(0)
    expect(result.stdout).toBe("Signed out\n")
    expect(idp.revocations).toEqual([{token: before.refreshToken!, hint: "refresh_token", clientId: "mentra-cli"}])
    expect(idp.refreshTokenActive(before.refreshToken!)).toBe(false)
    const refresh = await fetch(`${idp.issuer}/token`, {
      method: "POST",
      body: new URLSearchParams({grant_type: "refresh_token", refresh_token: before.refreshToken!, client_id: "mentra-cli"}),
    })
    expect(refresh.status).toBe(400)
    expect(await refresh.json()).toMatchObject({error: "invalid_grant"})
    expect(readdirSync(home()).filter(name => name.endsWith(".json"))).toEqual([])
    expect((await cli(["whoami"], {MENTRA_CORE_URL: mentra.url})).stderr).toContain("Not signed in. Run `mentra login`.")
  })

  test("logout clears the credentials when revocation fails and prints the not-confirmed line", async () => {
    const mentra = core()
    await login({MENTRA_CORE_URL: mentra.url})
    idp.failRevocation = true
    const result = await cli(["logout"], {MENTRA_CORE_URL: mentra.url})
    expect(result.code).toBe(0)
    expect(result.stdout).toBe("Signed out locally; server sign-out not confirmed\n")
    expect(idp.revocations).toHaveLength(1)
    expect(readdirSync(home()).filter(name => name.endsWith(".json"))).toEqual([])
  })

  test("a login stored by the older CLI reads as signed out", async () => {
    const mentra = core()
    await login({MENTRA_CORE_URL: mentra.url})
    const {issuer: _issuer, clientId: _clientId, mentraUserId: _user, ...older} = storedLogin()
    writeFileSync(storedLoginFile(), JSON.stringify(older))
    const result = await cli(["whoami"], {MENTRA_CORE_URL: mentra.url})
    expect(result.code).toBe(1)
    expect(result.stderr).toContain("Not signed in. Run `mentra login`.")
  })
})

describe("the Mentra Miniapp Store", () => {
  test("its commands are gone, and nothing reaches Core for them", async () => {
    const mentra = core()
    await login({MENTRA_CORE_URL: mentra.url})
    const seen = mentra.requests.length
    for (const args of [
      ["publish"],
      ["releases", "list", "com.example.app"],
      ["listing", "show", "com.example.app"],
      ["tokens", "list"],
      ["admin", "me"],
      ["miniapps", "list"],
      ["miniapps", "create", "com.example.app", "--name", "App"],
      ["workspace", "set-prefix", "com.example"],
    ]) {
      const result = await cli(args, {MENTRA_CORE_URL: mentra.url})
      expect(result.code).not.toBe(0)
      expect(result.stderr).toMatch(/unknown command|too many arguments/)
    }
    expect(mentra.requests.slice(seen)).toEqual([])
  })

  test("--store-url is not an option, and MENTRA_STORE_URL is not read", async () => {
    const flag = await cli(["--store-url", "https://store.example.test", "whoami"], {})
    expect(flag.code).toBe(1)
    expect(flag.stderr).toContain("unknown option '--store-url'")
    const mentra = core()
    await login({MENTRA_CORE_URL: mentra.url})
    const env = await cli(["whoami"], {MENTRA_CORE_URL: mentra.url, MENTRA_STORE_URL: "https://store.example.test"})
    expect(env.code).toBe(0)
    expect(env.stdout).toContain(`Core: ${mentra.url}\n`)
  })
})
