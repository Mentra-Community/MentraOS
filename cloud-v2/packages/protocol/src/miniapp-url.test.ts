import {describe, expect, test} from "bun:test"
import {readFileSync} from "node:fs"
import {join} from "node:path"
import {
  isLocalNetworkHost,
  isPackageNameAllowedForUrl,
  MINIAPP_AGE_RATINGS,
  MINIAPP_PIN_UNMET_REASONS,
  normalizeMiniappUrl,
  packagePrefixForHost,
  parseMiniappVersions,
  registrableDomain,
  selectMiniappTarget,
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
    ["an API level that isn't a positive integer", {minApiLevel: 1.5}],
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

const OLD_SHA = "41ab77".padEnd(64, "b")
const OLDER_SHA = "c07e5b".padEnd(64, "c")

/** The update spec's example list: the latest version first, then two older ones. */
const VERSIONS = [
  {version: "1.4.2", url: "com.example.notes-1.4.2.zip", sha256: SHA},
  {version: "1.4.1", url: "com.example.notes-1.4.1.zip", sha256: OLD_SHA},
  {version: "1.4.0", url: "https://cdn.example.net/notes-1.4.0.zip", sha256: OLDER_SHA},
]

describe("the versions a served miniapp.json lists", () => {
  test("a list of versions is kept, each with its URL and hash", () => {
    const parsed = ServedMiniappManifestSchema.parse(specManifest({versions: VERSIONS}))
    expect(parsed.versions).toEqual(VERSIONS)
    expect(parseMiniappVersions(VERSIONS)).toEqual(VERSIONS)
  })

  test("a miniapp.json without a list parses as before, with no versions key", () => {
    const parsed = ServedMiniappManifestSchema.parse(specManifest())
    expect(parsed).toStrictEqual(specManifest() as never)
    expect("versions" in parsed).toBe(false)
  })

  test("hashes are read in lowercase, an entry's other fields are kept, and an empty list is a list", () => {
    const served = [{version: "1.4.2", url: "n.zip", sha256: SHA.toUpperCase(), minHostVersion: "3.3.0"}]
    expect(ServedMiniappManifestSchema.parse(specManifest({versions: served})).versions).toEqual([
      {version: "1.4.2", url: "n.zip", sha256: SHA, minHostVersion: "3.3.0"} as never,
    ])
    expect(ServedMiniappManifestSchema.parse(specManifest({versions: []})).versions).toEqual([])
  })

  test.each([
    ["text", "1.4.2"],
    ["an object", {"1.4.2": {url: "n.zip", sha256: SHA}}],
    ["null", null],
    ["a number", 3],
    ["an entry that isn't an object", [VERSIONS[0], "1.4.1"]],
    ["an entry that is a list", [VERSIONS[0], []]],
    ["an entry without a version", [{url: "n.zip", sha256: SHA}]],
    ["a version that isn't semver", [{version: "latest", url: "n.zip", sha256: SHA}]],
    ["an entry without a URL", [{version: "1.4.2", sha256: SHA}]],
    ["a blank URL", [{version: "1.4.2", url: " ", sha256: SHA}]],
    ["a URL over 2,048 characters", [{version: "1.4.2", url: `n${"a".repeat(2048)}.zip`, sha256: SHA}]],
    ["an entry without a hash", [{version: "1.4.2", url: "n.zip"}]],
    ["a short hash", [{version: "1.4.2", url: "n.zip", sha256: "abc"}]],
    ["a hash that isn't hex", [{version: "1.4.2", url: "n.zip", sha256: "z".repeat(64)}]],
    ["one bad entry among good ones", [...VERSIONS, {version: "1.3.0", url: "n.zip", sha256: 7}]],
    ["a version listed twice", [VERSIONS[0], {...VERSIONS[0], url: "other.zip"}]],
  ])("a malformed list (%s) reads as no list, and the miniapp.json stays valid", (_name, versions) => {
    expect(parseMiniappVersions(versions)).toBeUndefined()
    const parsed = ServedMiniappManifestSchema.safeParse(specManifest({versions}))
    expect(parsed.success).toBe(true)
    if (!parsed.success) return
    expect("versions" in parsed.data).toBe(false)
    expect(parsed.data).toStrictEqual(specManifest() as never)
  })
})

describe("the build a phone should hold (selectMiniappTarget)", () => {
  const served = ServedMiniappManifestSchema.parse(specManifest({versions: VERSIONS}))
  const latest = {version: "1.4.2", url: "com.example.notes-1.4.2.zip", sha256: SHA}

  test("without a pin the target is the bundle, with or without a list", () => {
    expect(selectMiniappTarget(served)).toEqual({ok: true, target: latest})
    expect(selectMiniappTarget(served, null)).toEqual({ok: true, target: latest})
    const unlisted = ServedMiniappManifestSchema.parse(specManifest())
    expect(selectMiniappTarget(unlisted, undefined)).toEqual({ok: true, target: latest})
  })

  test("without a pin the bundle is the target even when the list says otherwise (a rollback)", () => {
    const rolledBack = ServedMiniappManifestSchema.parse(
      specManifest({version: "1.4.1", bundle: {url: "com.example.notes-1.4.1.zip", sha256: OLD_SHA}, versions: VERSIONS}),
    )
    expect(selectMiniappTarget(rolledBack)).toEqual({
      ok: true,
      target: {version: "1.4.1", url: "com.example.notes-1.4.1.zip", sha256: OLD_SHA},
    })
  })

  test("a pin that is met is its version's entry, older than the latest or not", () => {
    expect(selectMiniappTarget(served, {version: "1.4.1", sha256: OLD_SHA})).toEqual({
      ok: true,
      target: {version: "1.4.1", url: "com.example.notes-1.4.1.zip", sha256: OLD_SHA},
    })
    expect(selectMiniappTarget(served, {version: "1.4.0", sha256: OLDER_SHA})).toEqual({
      ok: true,
      target: {version: "1.4.0", url: "https://cdn.example.net/notes-1.4.0.zip", sha256: OLDER_SHA},
    })
  })

  test("a pin to the latest version is that version's entry, the same build as the bundle", () => {
    expect(selectMiniappTarget(served, {version: "1.4.2", sha256: SHA})).toEqual({ok: true, target: latest})
  })

  test("the seal is compared whatever the case of either hash", () => {
    expect(selectMiniappTarget(served, {version: "1.4.1", sha256: OLD_SHA.toUpperCase()})).toEqual({
      ok: true,
      target: {version: "1.4.1", url: "com.example.notes-1.4.1.zip", sha256: OLD_SHA},
    })
    const upper = {version: "1.4.2", bundle: {url: "n.zip", sha256: SHA}, versions: [{version: "1.4.1", url: "o.zip", sha256: OLD_SHA.toUpperCase()}]}
    expect(selectMiniappTarget(upper, {version: "1.4.1", sha256: OLD_SHA})).toEqual({
      ok: true,
      target: {version: "1.4.1", url: "o.zip", sha256: OLD_SHA},
    })
  })

  test("a version that is no longer listed has no target: pin_unlisted", () => {
    expect(selectMiniappTarget(served, {version: "1.3.9", sha256: OLD_SHA})).toEqual({ok: false, reason: "pin_unlisted"})
    const shorter = ServedMiniappManifestSchema.parse(specManifest({versions: VERSIONS.slice(0, 1)}))
    expect(selectMiniappTarget(shorter, {version: "1.4.1", sha256: OLD_SHA})).toEqual({ok: false, reason: "pin_unlisted"})
  })

  test("a miniapp with no list, an empty one or a malformed one meets no pin, not even to the version it serves", () => {
    for (const versions of [undefined, [], "1.4.2", [{version: "1.4.2", url: "n.zip"}]]) {
      const manifest = ServedMiniappManifestSchema.parse(specManifest(versions === undefined ? {} : {versions}))
      expect(selectMiniappTarget(manifest, {version: "1.4.2", sha256: SHA})).toEqual({ok: false, reason: "pin_unlisted"})
    }
  })

  test("a listed version with other bytes has no target: pin_hash_changed", () => {
    expect(selectMiniappTarget(served, {version: "1.4.1", sha256: OLDER_SHA})).toEqual({ok: false, reason: "pin_hash_changed"})
    // The latest version republished: the bundle's new hash never stands in for the sealed one.
    const republished = ServedMiniappManifestSchema.parse(
      specManifest({bundle: {url: "n.zip", sha256: OLDER_SHA}, versions: [{version: "1.4.2", url: "n.zip", sha256: OLDER_SHA}]}),
    )
    expect(selectMiniappTarget(republished, {version: "1.4.2", sha256: SHA})).toEqual({ok: false, reason: "pin_hash_changed"})
  })

  test("the reasons are the two a phone reports", () => {
    expect([...MINIAPP_PIN_UNMET_REASONS]).toEqual(["pin_unlisted", "pin_hash_changed"])
  })
})
