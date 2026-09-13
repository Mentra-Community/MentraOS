import assert from "node:assert/strict"
import {execFileSync} from "node:child_process"
import {mkdtempSync, readFileSync, rmSync} from "node:fs"
import {tmpdir} from "node:os"
import path from "node:path"
import {fileURLToPath} from "node:url"
import test from "node:test"

import {nativeBuildNumberForFamily} from "./native-build-numbers.mjs"
import {prepareMobileReleaseEnvironment} from "./prepare-mobile-release-env.mjs"

test("native build numbers follow the release family", () => {
  assert.equal(nativeBuildNumberForFamily("3.1.0", 222), 310000222)
  assert.equal(nativeBuildNumberForFamily("3.2.0", 222), 320000222)
  assert.equal(nativeBuildNumberForFamily("3.2.1", 222), 321000222)
  assert.equal(nativeBuildNumberForFamily("4.0.0", 1), 400000001)
  assert.equal(nativeBuildNumberForFamily("20.9.9", 999999), 2099999999)
})

test("invalid families and sequences cannot overflow into another family or exceed Play's limit", () => {
  for (const version of ["3.2", "3.2.0-dev.1", "03.2.0", "0.2.0", "3.10.0", "3.2.10", "21.0.0"]) {
    assert.throws(() => nativeBuildNumberForFamily(version, 222), /Native build family/)
  }
  for (const sequence of [undefined, 0, -1, 1.5, "222", NaN, Infinity, 1000000]) {
    assert.throws(() => nativeBuildNumberForFamily("3.2.0", sequence), /Native build sequence/)
  }
})

test("CLI derives dev and beta native pins from root package.json and preserves explicit build numbers", (t) => {
  const root = fileURLToPath(new URL("../../", import.meta.url))
  const version = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version
  const dir = mkdtempSync(path.join(tmpdir(), "mentra-native-plan-"))
  t.after(() => rmSync(dir, {recursive: true, force: true}))

  function createPlan(branch, extra = []) {
    const output = path.join(dir, `${branch}.json`)
    execFileSync(
      process.execPath,
      [
        ".github/scripts/create-release-plan.mjs",
        "--branch",
        branch,
        "--sequence",
        "222",
        "--source-commit",
        "a".repeat(40),
        "--require-version-mirrors",
        "true",
        "--output",
        output,
        ...extra,
      ],
      {cwd: root},
    )
    return JSON.parse(readFileSync(output, "utf8"))
  }

  for (const [branch, channel, backendEnvironment] of [
    ["dev", "dev", "dev"],
    ["staging", "beta", "staging"],
  ]) {
    const plan = createPlan(branch)
    assert.equal(plan.native.marketingVersion, version)
    assert.equal(plan.native.buildNumber, nativeBuildNumberForFamily(version, 222))
    assert.equal(plan.native.googlePlayUpload !== false, channel !== "dev")
    assert.equal(plan.members.mentraos.publishTargets.includes("google-play"), channel !== "dev")
    assert.deepEqual(createPlan(branch), plan, "the same run must produce the same plan on retry")
    const env = prepareMobileReleaseEnvironment({
      plan,
      template: "EXPO_PUBLIC_MENTRAOS_VERSION=0.0.0\n",
      backendEnvironment,
      otaManifestUrl: "https://example.com/ota.json",
      publicValues: {},
    })
    assert.ok(env.includes(`MENTRAOS_NATIVE_MARKETING_VERSION=${version}\n`))
    assert.ok(env.includes(`MENTRAOS_PINNED_BUILD_NUMBER=${plan.native.buildNumber}\n`))
    assert.ok(env.includes(`EXPO_PUBLIC_MENTRAOS_VERSION=${version}-${channel}.222\n`))
  }
  assert.equal(createPlan("dev", ["--native-build-number", "900000003"]).native.buildNumber, 900000003)
  assert.equal(createPlan("main", ["--native-build-number", "900000004"]).native.buildNumber, 900000004)
  assert.ok(
    createPlan("main", ["--native-build-number", "900000004"]).members.mentraos.publishTargets.includes("google-play"),
  )
})
