import assert from "node:assert/strict"
import {execFileSync} from "node:child_process"
import test from "node:test"

// Guards the regression that silently zeroed glasses WAU: from 2026-08-11 every
// dev/beta build shipped with `analytics: false` on the Bluetooth SDK plugin.
// The SDK's usage analytics are the source of truth for WAU, so the Mentra App
// must always leave them enabled and declare its build lane. Resolved through
// `expo config`, the same path prebuild uses, so what is asserted is what ships.

function bluetoothSdkPluginProps() {
  let json
  try {
    json = execFileSync("npx", ["expo", "config", "--json", "--type", "prebuild"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        EXPO_NO_TELEMETRY: "1",
        // app.config.ts refuses to build without a Mapbox token in CI. The token
        // has nothing to do with this check, so supply the same placeholder
        // .env.example ships when the environment has none.
        EXPO_PUBLIC_MAPBOX_ACCESS_TOKEN: process.env.EXPO_PUBLIC_MAPBOX_ACCESS_TOKEN || "ci-dummy-not-a-real-token",
      },
      maxBuffer: 16 * 1024 * 1024,
    })
  } catch (error) {
    throw new Error(
      `expo config failed: ${String(error.stderr || error.message)
        .trim()
        .slice(0, 2000)}`,
    )
  }
  const config = JSON.parse(json)
  const entry = (config.plugins ?? []).find(
    (p) => Array.isArray(p) && String(p[0]).includes("modules/bluetooth-sdk/app.plugin"),
  )
  assert.ok(entry, "app.config.ts no longer registers ./modules/bluetooth-sdk/app.plugin.js")
  return entry[1] ?? {}
}

test("the Mentra App never disables the Bluetooth SDK's usage analytics", () => {
  const {analytics} = bluetoothSdkPluginProps()
  assert.notEqual(analytics, false, "analytics: false would zero glasses WAU for every Mentra App install")
  if (analytics && typeof analytics === "object") {
    assert.notEqual(analytics.enabled, false)
  }
})

test("the Mentra App declares its build lane so store installs are separable from dev and staging", () => {
  const {analytics} = bluetoothSdkPluginProps()
  assert.ok(analytics && typeof analytics === "object", "analytics must be configured as an object with an environment")
  const expected = (process.env.EXPO_PUBLIC_BUILD_ENV || "dev").trim().toLowerCase()
  assert.equal(analytics.environment, expected)
  assert.match(analytics.environment, /^[a-z0-9][a-z0-9_-]{0,31}$/)
})
