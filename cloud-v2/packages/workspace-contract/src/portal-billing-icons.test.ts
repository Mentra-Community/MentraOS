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
    // What it names at run time, and what the files it reaches name in turn (a harmless import would be fine; zod, or
    // the module that builds the schemas, would not).
    const specifiers = runtimeImports(iconsModule)
    expect(specifiers.filter((specifier) => /^zod(\/|$)/.test(specifier))).toEqual([])
    expect(specifiers.filter((specifier) => /portal-billing(?!-icons)/.test(specifier))).toEqual([])
    const manifest = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8"))
    // The package depends on zod for its schemas; this file isn't one of the places that uses it.
    expect(manifest.dependencies.zod).toBeDefined()
    expect(readFileSync(iconsModule, "utf8")).not.toMatch(/from\s*["']zod["']|require\(\s*["']zod["']\s*\)/)
  })

  test("bundles for the browser without zod's code", () => {
    // Separate `bun build`s, as portal-billing's own bundle test does. A word in a comment is not code: look for what
    // zod's code defines, and check the same markers are there in the bundle of the module that does use zod.
    const bundle = (entry: string) => {
      const result = Bun.spawnSync([process.execPath, "build", entry, "--target=browser"], {stdout: "pipe", stderr: "pipe"})
      expect(result.stderr.toString()).not.toContain("error")
      expect(result.exitCode).toBe(0)
      return result.stdout.toString()
    }
    const markers = ["ZodError", "ZodIssueCode", "invalid_type"]
    const withSchemas = bundle(Bun.resolveSync("./portal-billing", here))
    for (const marker of markers) expect([marker, withSchemas.includes(marker)]).toEqual([marker, true])
    const icons = bundle(iconsModule)
    expect(icons).toContain("billingIconPath")
    for (const marker of markers) expect([marker, icons.includes(marker)]).toEqual([marker, false])
  })
})
