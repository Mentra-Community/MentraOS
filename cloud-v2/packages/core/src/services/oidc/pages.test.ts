import {createHash} from "node:crypto"

import {describe, expect, test} from "bun:test"

import {cspOrigin, renderPage} from "./pages"

function csp(headers: Record<string, string>): Map<string, string> {
  return new Map(
    headers["content-security-policy"]!.split(";").map(directive => {
      const [name, ...values] = directive.trim().split(/\s+/)
      return [name!, values.join(" ")] as const
    }),
  )
}

describe("the sign-in server's pages", () => {
  test("are light only: no dark color scheme and no dark media query", () => {
    const {html} = renderPage({title: "Signed out of Mentra"})
    expect(html).toContain("color-scheme:light;")
    expect(html).not.toContain("light dark")
    expect(html).not.toContain("prefers-color-scheme")
  })

  test("run no script and post forms only to their own origin", () => {
    const {html, headers} = renderPage({title: "Sign out of Mentra?", bodyHtml: "<form></form>"})
    expect(html).not.toContain("<script")
    const policy = csp(headers)
    expect(policy.get("default-src")).toBe("'none'")
    expect(policy.has("script-src")).toBe(false)
    expect(policy.get("form-action")).toBe("'self'")
    expect(policy.get("frame-ancestors")).toBe("'none'")
    expect(policy.get("style-src")).toMatch(/^'nonce-[A-Za-z0-9+/=]+'$/)
  })

  test("an auto-submit page runs exactly its one script, by hash, and lets its form's response go to the named origin", () => {
    const {html, headers} = renderPage({
      title: "Signing you out…",
      bodyHtml: '<button id="auto-submit">Sign out</button>',
      autoSubmit: {redirectsTo: "https://portal.example.com"},
    })
    const scripts = [...html.matchAll(/<script>([^<]*)<\/script>/g)].map(match => match[1]!)
    expect(scripts).toEqual(['document.getElementById("auto-submit").click()'])
    expect(html.match(/<script/g)).toHaveLength(1)
    const policy = csp(headers)
    expect(policy.get("script-src")).toBe(`'sha256-${createHash("sha256").update(scripts[0]!).digest("base64")}'`)
    expect(policy.get("form-action")).toBe("'self' https://portal.example.com")
    expect(policy.get("default-src")).toBe("'none'")
    expect(policy.get("frame-ancestors")).toBe("'none'")
    // The style nonce is not the script's way in.
    expect(policy.get("script-src")).not.toContain("nonce")
  })

  test("refuses an auto-submit target that is not a bare origin", () => {
    for (const redirectsTo of ["https://portal.example.com/", "'unsafe-inline'", "https://a.example; script-src *", "javascript:alert(1)"]) {
      expect(() => renderPage({title: "x", autoSubmit: {redirectsTo}})).toThrow("must be an origin")
    }
  })

  test("cspOrigin keeps only an http(s) origin", () => {
    expect(cspOrigin("https://portal.mentraglass.com/")).toBe("https://portal.mentraglass.com")
    expect(cspOrigin("https://portal.mentraglass.com:8443/x?y=1")).toBe("https://portal.mentraglass.com:8443")
    expect(cspOrigin("http://localhost:53998/")).toBe("http://localhost:53998")
    expect(cspOrigin("http://[::1]:4001/")).toBe("http://[::1]:4001")
    expect(cspOrigin("mentra://signed-out")).toBeNull()
    expect(cspOrigin("not a url")).toBeNull()
  })
})
