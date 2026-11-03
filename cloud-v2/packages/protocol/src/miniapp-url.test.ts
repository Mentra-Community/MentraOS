import {describe, expect, test} from "bun:test"
import {readFileSync} from "node:fs"
import {join} from "node:path"
import {
  isLocalNetworkHost,
  isPackageNameAllowedForUrl,
  MINIAPP_AGE_RATINGS,
  normalizeMiniappUrl,
  packagePrefixForHost,
  registrableDomain,
  ServedMiniappManifestSchema,
} from "./miniapp-url"

// Resolved from the package root, so the tsc-emitted copy under dist/ finds the same fixture. The engine's tests read
// this file too.
const vectors = JSON.parse(
  readFileSync(join(import.meta.dir, "..", "src", "__fixtures__", "miniapp-url-vectors.json"), "utf8"),
) as {
  normalize: Array<{input: string; expected: {url: string; host: string; kind: string} | null}>
  registrableDomain: Array<{host: string; expected: string | null}>
  packagePrefix: Array<{host: string; expected: string | null}>
  localNetwork: Array<{host: string; expected: boolean}>
  domainRule: Array<{packageName: string; url: string; allowed: boolean}>
}

describe("normalizing a miniapp URL", () => {
  test.each(vectors.normalize.map((vector) => [vector.input, vector.expected] as const))("%p", (input, expected) => {
    expect(normalizeMiniappUrl(input)).toEqual(expected as never)
  })

  test("a normalized URL normalizes to itself", () => {
    for (const {expected} of vectors.normalize) {
      if (expected) expect(normalizeMiniappUrl(expected.url)).toEqual(expected as never)
    }
  })

  test("a non-string is refused", () => {
    expect(normalizeMiniappUrl(undefined as unknown as string)).toBeNull()
    expect(normalizeMiniappUrl(42 as unknown as string)).toBeNull()
  })

  test("a very long URL is refused", () => {
    expect(normalizeMiniappUrl(`https://notes.example.com/${"a".repeat(2048)}`)).toBeNull()
  })
})

describe("the registrable domain, from the Public Suffix List", () => {
  test.each(vectors.registrableDomain.map((vector) => [vector.host, vector.expected] as const))(
    "%p is %p",
    (host, expected) => {
      expect(registrableDomain(host)).toBe(expected)
    },
  )
})

describe("the package prefix a host may use", () => {
  test("the spec's table", () => {
    expect(packagePrefixForHost("notes.example.com")).toBe("com.example")
    expect(packagePrefixForHost("alice.github.io")).toBe("io.github.alice")
    expect(packagePrefixForHost("tools.acme.co.uk")).toBe("uk.co.acme")
    expect(packagePrefixForHost("miniapps.mentraglass.com")).toBe("com.mentraglass")
  })

  test.each(vectors.packagePrefix.map((vector) => [vector.host, vector.expected] as const))(
    "%p may use %p",
    (host, expected) => {
      expect(packagePrefixForHost(host)).toBe(expected)
    },
  )
})

describe("local-network hosts", () => {
  test.each(vectors.localNetwork.map((vector) => [vector.host, vector.expected] as const))(
    "%p is local: %p",
    (host, expected) => {
      expect(isLocalNetworkHost(host)).toBe(expected)
    },
  )

  test("every local-network URL is local, and no name passes the domain rule on one", () => {
    for (const {expected} of vectors.normalize) {
      if (expected?.kind !== "local") continue
      expect(isLocalNetworkHost(expected.host)).toBe(true)
      expect(isPackageNameAllowedForUrl("com.example.notes", expected.url)).toBe(false)
      expect(isPackageNameAllowedForUrl("com.mentra.notes", expected.url)).toBe(false)
    }
  })
})

describe("the domain rule", () => {
  test.each(vectors.domainRule.map((vector) => [vector.packageName, vector.url, vector.allowed] as const))(
    "%p from %p: %p",
    (packageName, url, allowed) => {
      expect(isPackageNameAllowedForUrl(packageName, url)).toBe(allowed)
    },
  )

  test("a name allowed from a URL is allowed from its normalized form", () => {
    for (const {packageName, url, allowed} of vectors.domainRule) {
      const normalized = normalizeMiniappUrl(url)
      if (normalized) expect(isPackageNameAllowedForUrl(packageName, normalized.url)).toBe(allowed)
    }
  })
})

const SHA = "9f2c0e".padEnd(64, "a")

/** The spec's example `miniapp.json`. */
function specManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    packageName: "com.example.notes",
    version: "1.4.2",
    name: "Notes",
    description: "Take notes with your voice.",
    icon: "icon.png",
    ageRating: "4+",
    sdkVersion: "3.3.0",
    minHostVersion: "3.3.0",
    entry: {background: "background/index.js", ui: "ui/index.html"},
    permissions: [{type: "MICROPHONE", required: true}],
    hardwareRequirements: [{type: "MICROPHONE", level: "REQUIRED"}],
    listing: {category: "productivity"},
    bundle: {url: "com.example.notes-1.4.2.zip", sha256: SHA},
    ...overrides,
  }
}

describe("the served miniapp.json", () => {
  test("accepts the spec's example, and keeps every field of the ZIP's manifest", () => {
    const manifest = specManifest({$schema: "https://example.com/schema.json", port: 3000, actions: []})
    expect(ServedMiniappManifestSchema.parse(manifest)).toEqual(manifest as never)
  })

  test("needs only a package name, a version, a name and the bundle", () => {
    const minimal = {
      packageName: "com.example.notes",
      version: "1.0.0",
      name: "Notes",
      bundle: {url: "https://cdn.example.net/notes.zip", sha256: SHA},
    }
    expect(ServedMiniappManifestSchema.parse(minimal)).toEqual(minimal)
  })

  test("reads the bundle's SHA-256 in lowercase", () => {
    const parsed = ServedMiniappManifestSchema.parse(specManifest({bundle: {url: "n.zip", sha256: SHA.toUpperCase()}}))
    expect(parsed.bundle.sha256).toBe(SHA)
  })

  test.each(MINIAPP_AGE_RATINGS.map((rating) => [rating]))("accepts the age rating %p", (rating) => {
    expect(ServedMiniappManifestSchema.safeParse(specManifest({ageRating: rating})).success).toBe(true)
  })

  test("the age ratings are Apple's age categories", () => {
    expect([...MINIAPP_AGE_RATINGS]).toEqual(["4+", "9+", "13+", "16+", "18+"])
  })

  test("leaves the directory's listing to the directory", () => {
    const listing = {category: 7, future: {field: true}}
    expect(ServedMiniappManifestSchema.parse(specManifest({listing})).listing).toEqual(listing)
  })

  test.each([
    ["no package name", {packageName: undefined}],
    ["a package name with a hyphen", {packageName: "com.example.my-notes"}],
    ["a package name in uppercase", {packageName: "com.Example.notes"}],
    ["a one-part package name", {packageName: "notes"}],
    ["no version", {version: undefined}],
    ["a version that isn't semver", {version: "latest"}],
    ["a two-part version", {version: "1.4"}],
    ["a version with a v", {version: "v1.4.2"}],
    ["no name", {name: undefined}],
    ["a blank name", {name: "  "}],
    ["a description that isn't text", {description: 5}],
    ["an empty icon", {icon: ""}],
    ["an age rating that isn't one of Apple's", {ageRating: "12+"}],
    ["an age rating that isn't text", {ageRating: 18}],
    ["an empty sdkVersion", {sdkVersion: ""}],
    ["hardware requirements that aren't a list", {hardwareRequirements: {type: "DISPLAY"}}],
    ["a hardware requirement without a level", {hardwareRequirements: [{type: "DISPLAY"}]}],
    ["no bundle", {bundle: undefined}],
    ["no bundle URL", {bundle: {sha256: SHA}}],
    ["an empty bundle URL", {bundle: {url: " ", sha256: SHA}}],
    ["no SHA-256", {bundle: {url: "n.zip"}}],
    ["a short SHA-256", {bundle: {url: "n.zip", sha256: "abc"}}],
    ["a SHA-256 that isn't hex", {bundle: {url: "n.zip", sha256: "z".repeat(64)}}],
  ])("refuses %s", (_name, overrides) => {
    expect(ServedMiniappManifestSchema.safeParse(specManifest(overrides)).success).toBe(false)
  })

  test.each([[null], [[]], ["miniapp"], [42]])("refuses %p", (value) => {
    expect(ServedMiniappManifestSchema.safeParse(value).success).toBe(false)
  })
})
