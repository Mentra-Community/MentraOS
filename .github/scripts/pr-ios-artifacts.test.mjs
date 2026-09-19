import assert from "node:assert/strict"
import test from "node:test"
import {iosReceiptName, validateIosReceipt} from "./pr-ios-artifacts.mjs"
import {validateMacProvisioning} from "../../mobile/scripts/install-ios-mac.mjs"

const coordinates = {pr: 123, sha: "a".repeat(40), runId: 100, attempt: 2}
const receipt = {
  schemaVersion: 1,
  pr: 123,
  headSha: coordinates.sha,
  buildSha: "b".repeat(40),
  runId: 100,
  runAttempt: 2,
  buildAttempt: 1,
  artifacts: Object.fromEntries(
    [
      ["iphone", "ipa"],
      ["mac", "zip"],
    ].map(([kind, ext]) => [
      kind,
      {
        name: `mentra-ios-${kind}-pr-123-${coordinates.sha}-100-1.${ext}`,
        size: 10,
        sha256: "c".repeat(64),
      },
    ]),
  ),
}

test("publication rerun identifies original build bytes and current publication attempt", () => {
  assert.equal(validateIosReceipt(receipt, coordinates), receipt.artifacts)
  assert.throws(() => validateIosReceipt(receipt, {...coordinates, attempt: 1}), /different/)
  assert.throws(() => validateIosReceipt(receipt, {...coordinates, runId: 101}), /different/)
  assert.throws(() => validateIosReceipt({...receipt, buildSha: "wrong"}, coordinates), /different/)
  assert.throws(() => iosReceiptName(123, "../bad", 100, 1), /Invalid/)
})

test("rejects partial or cross-run artifact metadata", () => {
  for (const asset of [
    undefined,
    {...receipt.artifacts.mac, name: "another.zip"},
    {...receipt.artifacts.mac, size: 0},
    {...receipt.artifacts.mac, sha256: ""},
  ])
    assert.throws(
      () => validateIosReceipt({...receipt, artifacts: {...receipt.artifacts, mac: asset}}, coordinates),
      /Invalid/,
    )
})

test("Mac installer rejects expired, malformed and unregistered provisioning before replacement", () => {
  const profile = {ExpirationDate: "2027-01-01T00:00:00Z", ProvisionedDevices: ["registered"]}
  const now = Date.parse("2026-01-01T00:00:00Z")
  validateMacProvisioning(profile, "registered", now)
  assert.throws(() => validateMacProvisioning(profile, "unknown", now), /not in/)
  assert.throws(() => validateMacProvisioning(profile, "registered", Date.parse("2028-01-01")), /expired/)
  assert.throws(() => validateMacProvisioning({...profile, ExpirationDate: "nonsense"}, "registered", now), /expired/)
})
