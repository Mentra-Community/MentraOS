import * as fs from "fs"
import * as path from "path"

// Guards the invariant that `bun run compile` type-checks @mentra/bluetooth-sdk
// against the same files Metro bundles (src/, via the "react-native" exports
// condition), never against the gitignored build/ output. build/ is only
// regenerated when expo-module prepare runs, so once it goes stale tsc would
// otherwise green-light calls that are undefined at runtime — we shipped
// exactly that once (a method present in stale build/*.d.ts but absent from
// the src public surface).
//
// Two pieces make the invariant hold:
//  1. tsc activates the "react-native" condition: customConditions comes from
//     expo/tsconfig.base, which mobile/tsconfig.json extends.
//  2. In every bluetooth-sdk exports entry, "react-native" precedes "types".
//     Exports conditions match in declaration order and "types" is always
//     active for tsc, so listing "types" first sends tsc back to build/.

const mobileRoot = path.resolve(__dirname, "../..")

const readJson = (filePath: string) => {
  const raw = fs.readFileSync(filePath, "utf8")
  try {
    return JSON.parse(raw)
  } catch (error) {
    throw new Error(`Failed to parse ${filePath}: ${error}`)
  }
}

describe("bluetooth-sdk type/runtime surface alignment", () => {
  const packageJson = readJson(path.join(mobileRoot, "modules/bluetooth-sdk/package.json"))
  const conditionEntries = Object.entries(packageJson.exports as Record<string, unknown>).filter(
    ([, conditions]) => typeof conditions === "object" && conditions !== null && "react-native" in conditions,
  ) as Array<[string, Record<string, string>]>

  it("covers the conditional export subpaths", () => {
    expect(conditionEntries.map(([subpath]) => subpath)).toEqual(
      expect.arrayContaining([".", "./internal", "./react", "./photo-receiver", "./debug"]),
    )
  })

  it.each(conditionEntries)("lists react-native before types for %s", (_subpath, conditions) => {
    const keys = Object.keys(conditions)
    expect(keys.indexOf("react-native")).toBeGreaterThanOrEqual(0)
    expect(keys.indexOf("types")).toBeGreaterThan(keys.indexOf("react-native"))
    expect(conditions["react-native"]).toMatch(/^\.\/src\//)
  })

  it("activates the react-native condition for tsc", () => {
    const tsconfig = readJson(path.join(mobileRoot, "tsconfig.json"))
    expect(tsconfig.extends).toBe("expo/tsconfig.base")

    const expoBase = readJson(path.join(mobileRoot, "node_modules/expo/tsconfig.base.json"))
    const effective = (key: string) => tsconfig.compilerOptions?.[key] ?? expoBase.compilerOptions?.[key]

    expect(effective("customConditions")).toContain("react-native")
    // customConditions only applies under these moduleResolution modes.
    expect(["bundler", "node16", "nodenext"]).toContain(effective("moduleResolution"))
  })
})
