/**
 * @fileoverview Reproduces and guards against a concurrent-refresh race in
 * AccountAuthProvider. Two callers (e.g. AuthContext's getSession() and
 * CloudClientService's getSubjectToken()) can both see a rejected access
 * token and both call refreshTokens() with the same stored refresh token.
 * Core enforces single-use rotation (session.service.ts refreshSession):
 * only one concurrent refresh wins; the loser gets a legitimate 400
 * invalid_grant. Before the fix, the loser's 400 makes the client call
 * clearTokens() unconditionally, wiping out the winner's freshly-saved
 * tokens, even though a valid session was just established.
 *
 * This is a LIVE integration test, opt-in via env var so the normal Jest
 * run (and CI, which has no local core) skips it instead of failing:
 *
 *   1. cd cloud-v2 && bash scripts/dev-local.sh   (core on :3000)
 *   2. cd mobile && RUN_LIVE_AUTH_TESTS=1 doppler run --project mentra-sre \
 *        --config dev -- bunx jest accountClient.race
 *
 * Credentials come from MENTRA_LIVE_TEST_EMAIL / MENTRA_LIVE_TEST_PASSWORD
 * env vars, not hardcoded: dev-local.sh points core at the real (shared,
 * dev-tier) Supabase project via Doppler, so a real account password
 * belongs in Doppler (mentra-sre, config dev), never in a public repo's
 * git history.
 */
jest.mock("@/services/cloudClient", () => ({
  resolvedEndpoints: () => ({core: "http://localhost:3000", runtime: "ws://localhost:3001"}),
}))

// authClient.ts and accountClient.ts import each other (AuthClient base class
// vs AccountAuthProvider), which breaks under Jest's CJS module resolution
// (AuthClient is still undefined when accountClient.ts's `extends AuthClient`
// clause runs). AccountAuthProvider overrides every method AuthClient stubs,
// so a trivial extendable class is behaviorally equivalent for this test.
jest.mock("@/utils/auth/authClient", () => ({AuthClient: class {}}))

import {AccountAuthProvider} from "./accountClient"
import {storage} from "@/utils/storage"

const CORE = "http://localhost:3000"
const TEST_EMAIL = process.env.MENTRA_LIVE_TEST_EMAIL
const TEST_PASSWORD = process.env.MENTRA_LIVE_TEST_PASSWORD

const ACCESS_KEY = "mentra.account.accessToken"
const REFRESH_KEY = "mentra.account.refreshToken"

async function loginForRealTokens(): Promise<{access: string; refresh: string}> {
  if (!TEST_EMAIL || !TEST_PASSWORD) {
    throw new Error(
      "RUN_LIVE_AUTH_TESTS is set but MENTRA_LIVE_TEST_EMAIL / MENTRA_LIVE_TEST_PASSWORD are not. " +
        "Set them to the standing e2e test account before running this suite.",
    )
  }
  const res = await fetch(`${CORE}/api/account/login`, {
    method: "POST",
    headers: {"content-type": "application/json"},
    body: JSON.stringify({email: TEST_EMAIL, password: TEST_PASSWORD}),
  })
  if (!res.ok) throw new Error(`login failed: HTTP ${res.status} ${await res.text()}`)
  const body = (await res.json()) as {access_token: string; refresh_token: string}
  return {access: body.access_token, refresh: body.refresh_token}
}

// Opt-in gate: the normal Jest run (and CI, which has no local core) skips
// this suite entirely instead of failing on the unreachable dependency.
const describeLive = process.env.RUN_LIVE_AUTH_TESTS ? describe : describe.skip

describeLive("AccountAuthProvider concurrent refresh (live, RUN_LIVE_AUTH_TESTS=1 + local core on :3000)", () => {
  beforeAll(async () => {
    const health = await fetch(`${CORE}/api/client/min-version`).catch(() => null)
    if (!health || !health.ok) {
      throw new Error(
        "RUN_LIVE_AUTH_TESTS is set but local Cloud V2 core is not reachable at " +
          "http://localhost:3000. Run `cd cloud-v2 && bash scripts/dev-local.sh` first.",
      )
    }
  })

  test("two concurrent session checks against an expired access token do not both survive", async () => {
    const real = await loginForRealTokens()

    // Deliberately invalid access token: forces BOTH concurrent calls below to
    // hit the /api/account/me probe, get rejected, and attempt a refresh with
    // the same (real, valid, unused) refresh token — faithfully reproducing
    // "access token expired after backgrounding" without waiting out a TTL.
    storage.save(ACCESS_KEY, "garbage-expired-access-token")
    storage.save(REFRESH_KEY, real.refresh)

    const provider = new AccountAuthProvider()

    // Two independent entry points that both bottom out in refreshTokens():
    // getSession() (AuthContext on mount) and getSubjectToken() (CloudClientService
    // reconnect via ensureFreshAccess()) — fired concurrently, exactly as they
    // would be on a cold resume after the access token's 1h TTL has elapsed.
    const [sessionResult, subjectResult] = await Promise.all([provider.getSession(), provider.getSubjectToken()])

    const tokensAfter = {
      access: storage.load<string>(ACCESS_KEY),
      refresh: storage.load<string>(REFRESH_KEY),
    }
    const survived = tokensAfter.access.is_ok() && tokensAfter.refresh.is_ok()

    console.log("session result:", sessionResult.is_ok() ? "ok" : sessionResult.error.message)
    console.log("subjectToken result:", subjectResult.is_ok() ? "ok" : subjectResult.error.message)
    console.log("tokens survived in storage after the race:", survived)

    // The fix under test: a valid session existed (the server accepted exactly
    // one of the two concurrent refreshes) and it must still be in storage
    // afterward. Before the fix, the losing call's clearTokens() wipes it.
    expect(survived).toBe(true)
  })

  test("a caller presenting an already-rotated refresh token does not wipe the winner's session", async () => {
    const real = await loginForRealTokens()
    storage.save(ACCESS_KEY, real.access)
    storage.save(REFRESH_KEY, real.refresh)

    const provider = new AccountAuthProvider() as any

    // Caller A's full cycle completes first: rotates the refresh token and
    // saves the new pair. refreshInFlight is cleared by the time this
    // resolves, so it does NOT protect a later, independent call.
    const afterA = await provider.performRefresh(real.refresh)
    expect(afterA).not.toBeNull()

    // Caller B snapshotted the refresh token before A ran (the realistic
    // case: both callers call loadTokens() around the same moment, but B's
    // own /me probe + dispatch to refreshTokens() is slightly slower than
    // A's full round trip). B now presents that stale token on its own,
    // independent call, well after A's in-flight promise is gone.
    const afterB = await provider.performRefresh(real.refresh)

    const stored = {
      access: storage.load<string>(ACCESS_KEY),
      refresh: storage.load<string>(REFRESH_KEY),
    }
    const survived = stored.access.is_ok() && stored.refresh.is_ok()

    console.log("caller B result:", afterB ? "recovered current session" : "null (would clearTokens)")
    console.log("tokens survived after the stale caller:", survived)

    // Before the fix: the stale token gets a real 400 invalid_grant,
    // performRefresh returns null, and ensureFreshAccess()/getSession() would
    // clearTokens() on that null, wiping out A's still-valid session. After
    // the fix: performRefresh notices storage already moved on and hands back
    // the current tokens instead of reporting a hard failure.
    expect(afterB).not.toBeNull()
    expect(survived).toBe(true)
  })
})
