import {describe, expect, test} from "bun:test"
import {readFileSync} from "node:fs"
import {dirname, join} from "node:path"
import * as root from "./index"
import {BILLING_ICON_FILE, BILLING_ICON_PATH_PREFIX, billingIconPath} from "./portal-billing-icons"
import * as billing from "./portal-billing"

const here = import.meta.dir
// Resolved rather than hard-coded so the compiled copy under dist/ finds its own portal-billing-icons.js.
const iconsModule = Bun.resolveSync("./portal-billing-icons", here)

/** Every specifier `file` names at run time, and those of each file it reaches through a relative import. */
function runtimeImports(file: string): string[] {
  const specifiers = new Set<string>()
  const seen = new Set<string>()
  const visit = (path: string) => {
    if (seen.has(path)) return
    seen.add(path)
    const loader = path.endsWith(".ts") ? "ts" : "js"
    for (const {path: specifier} of new Bun.Transpiler({loader}).scanImports(readFileSync(path, "utf8"))) {
      specifiers.add(specifier)
      if (specifier.startsWith(".")) visit(Bun.resolveSync(specifier, dirname(path)))
    }
  }
  visit(file)
  return [...specifiers]
}

describe("portal-billing-icons", () => {
  test("is the icon rule on its own: the prefix, the file pattern and billingIconPath", () => {
    expect(BILLING_ICON_PATH_PREFIX).toBe("/api/portal/billing/ui/icons/")
    expect(BILLING_ICON_FILE.test("mentra.call.unlimited.png")).toBe(true)
    expect(BILLING_ICON_FILE.test("..")).toBe(false)
    expect(billingIconPath("/api/portal/billing/ui/icons/mentra.call.unlimited.png")).toBe(
      "/api/portal/billing/ui/icons/mentra.call.unlimited.png",
    )
    for (const value of [
      "/api/portal/billing/ui/entry.js",
      "/api/portal/billing/ui/icons/",
      "/api/portal/billing/ui/icons/..",
      "/api/portal/billing/ui/icons/x.png?a=b",
      "/api/portal/billing/ui/icons/a b.png",
      "https://evil.example/api/portal/billing/ui/icons/x.png",
      null,
      undefined,
      42,
    ]) {
      expect([value, billingIconPath(value)]).toEqual([value, null])
    }
  })

  test("portal-billing re-exports the very same values, so every existing import still works", () => {
    expect(billing.BILLING_ICON_PATH_PREFIX).toBe(BILLING_ICON_PATH_PREFIX)
    expect(billing.BILLING_ICON_FILE).toBe(BILLING_ICON_FILE)
    expect(billing.billingIconPath).toBe(billingIconPath)
    // And the prefix stays under billing's `ui/` path, which the schemas' module still names.
    expect(BILLING_ICON_PATH_PREFIX).toBe(`${billing.BILLING_UI_PATH_PREFIX}icons/`)
  })

  test("is a subpath of the package, not part of the root", () => {
    const manifest = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8"))
    expect(manifest.exports["./portal-billing-icons"]).toBe("./src/portal-billing-icons.ts")
    expect(manifest.exports["./portal-billing"]).toBe("./src/portal-billing.ts")
    expect(Object.keys(root)).not.toContain("billingIconPath")
  })

  test("imports no zod, and nothing that does", () => {
    const specifiers = runtimeImports(iconsModule)
    expect(specifiers.filter((specifier) => /^zod(\/|$)/.test(specifier) || /portal-billing(?!-icons)/.test(specifier))).toEqual([])
    // As written it needs nothing at all.
    expect(specifiers).toEqual([])
  })

  test("bundles for the browser without zod", () => {
    // A separate `bun build`, as portal-billing's own bundle test does.
    const result = Bun.spawnSync([process.execPath, "build", iconsModule, "--target=browser"], {stdout: "pipe", stderr: "pipe"})
    expect(result.stderr.toString()).not.toContain("error")
    expect(result.exitCode).toBe(0)
    const bundle = result.stdout.toString()
    expect(bundle).toContain("billingIconPath")
    expect(bundle).not.toContain("ZodError")
    expect(bundle).not.toMatch(/\bzod\b/i)
  })
})
