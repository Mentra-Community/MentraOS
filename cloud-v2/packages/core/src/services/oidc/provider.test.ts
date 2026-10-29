import {describe, expect, test} from "bun:test"
import type {KoaContextWithOIDC} from "oidc-provider"

import {logoutPage} from "./provider"

const FORM = '<form id="op.logoutForm" method="post" action="https://account.test/oidc/session/end/confirm"><input type="hidden" name="xsrf" value="x"/></form>'

/** The end-session request as the provider hands it to `logoutSource`, after checking the client and its return address. */
function request(opts: {clientId?: string; postLogoutRedirectUri?: string}): KoaContextWithOIDC {
  return {
    oidc: {
      client: opts.clientId ? {clientId: opts.clientId} : undefined,
      params: {post_logout_redirect_uri: opts.postLogoutRedirectUri},
    },
  } as unknown as KoaContextWithOIDC
}

describe("the end-session page", () => {
  test("a registered client asking to have the person back gets a page that signs them out at once", () => {
    const page = logoutPage(request({clientId: "workspace-portal", postLogoutRedirectUri: "https://portal.test/"}), FORM)
    expect(page.html).toContain("Signing you out…")
    expect(page.html).toContain(FORM)
    // The fallback button (for when script does not run) ends the whole sign-in server session, as the prompt's does.
    expect(page.html).toMatch(/<button[^>]*id="auto-submit"[^>]*form="op\.logoutForm"[^>]*name="logout"[^>]*value="yes"[^>]*>Sign out<\/button>/)
    expect(page.html).toContain('<script>document.getElementById("auto-submit").click()</script>')
    expect(page.html).not.toContain("Stay signed in")
    expect(page.headers["content-security-policy"]).toContain("form-action 'self' https://portal.test;")
    expect(page.headers["content-security-policy"]).toMatch(/script-src 'sha256-[A-Za-z0-9+/=]+'/)
  })

  test("a bare request, naming no client, asks the person to confirm and runs no script", () => {
    const page = logoutPage(request({}), FORM)
    expect(page.html).toContain("Sign out of Mentra?")
    expect(page.html).toContain("Stay signed in")
    expect(page.html).not.toContain("<script")
    expect(page.headers["content-security-policy"]).not.toContain("script-src")
    expect(page.headers["content-security-policy"]).toContain("form-action 'self';")
  })

  test("a client that names no return address also asks to confirm", () => {
    const page = logoutPage(request({clientId: "workspace-portal"}), FORM)
    expect(page.html).toContain("Sign out of Mentra?")
    expect(page.html).not.toContain("<script")
  })
})
