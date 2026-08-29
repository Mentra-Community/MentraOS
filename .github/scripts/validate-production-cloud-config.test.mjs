import assert from "node:assert/strict"
import {generateKeyPairSync} from "node:crypto"
import test from "node:test"

import {
  parseEnvironmentFile,
  validateContractCoverage,
  validateProductionCloudConfig,
} from "./validate-production-cloud-config.mjs"

const keys = generateKeyPairSync("rsa", {modulusLength: 1024})
const privateKey = keys.privateKey.export({type: "pkcs8", format: "pem"})
const publicKey = keys.publicKey.export({type: "spki", format: "pem"})

const contract = {
  schemaVersion: 1,
  contractVersion: "test-1",
  required: {
    NODE_ENV: {kind: "enum", values: ["production"], acceptanceTest: "ready"},
    MONGO_URL: {kind: "mongo-url", acceptanceTest: "mongo"},
  },
  requiredAnyOf: [{id: "storage", keys: ["R2_ENDPOINT", "S3_ENDPOINT"], kind: "https-url", acceptanceTest: "storage"}],
  optional: ["LOG_LEVEL"],
  forbidden: ["AUDIO_DEBUG_ECHO"],
  keyPairs: [{id: "jwt-pair", privateKey: "PRIVATE_KEY", publicKey: "PUBLIC_KEY", acceptanceTest: "auth"}],
}

function validValues() {
  return {
    NODE_ENV: "production",
    MONGO_URL: "mongodb+srv://cluster.example.com/mentra",
    R2_ENDPOINT: "https://account.r2.cloudflarestorage.com",
    PRIVATE_KEY: privateKey,
    PUBLIC_KEY: publicKey,
  }
}

test("validates config without returning secret values", () => {
  const evidence = validateProductionCloudConfig({
    contract,
    environment: "prod",
    values: validValues(),
  })
  assert.equal(evidence.contractVersion, "test-1")
  assert.deepEqual(evidence.checks.find((check) => check.id === "storage").keys, ["R2_ENDPOINT"])
  assert.equal(JSON.stringify(evidence).includes("cluster.example.com"), false)
  assert.equal(evidence.checks.find((check) => check.id === "jwt-pair").status, "pass")
})

test("parses a pulled environment file without emitting values", () => {
  assert.deepEqual(parseEnvironmentFile("export NODE_ENV=production\nTOKEN='secret-value'\n"), {
    NODE_ENV: "production",
    TOKEN: "secret-value",
  })
})

test("fails for missing, forbidden, local, and unclassified config", () => {
  assert.throws(
    () => validateProductionCloudConfig({contract, environment: "prod", values: {NODE_ENV: "production"}}),
    /MONGO_URL/,
  )
  const mismatch = validValues()
  mismatch.PUBLIC_KEY = generateKeyPairSync("rsa", {modulusLength: 1024}).publicKey.export({
    type: "spki",
    format: "pem",
  })
  assert.throws(
    () => validateProductionCloudConfig({contract, environment: "prod", values: mismatch}),
    /do not correspond/,
  )
  assert.throws(
    () =>
      validateProductionCloudConfig({
        contract,
        environment: "prod",
        values: {
          NODE_ENV: "production",
          MONGO_URL: "mongodb://localhost/db",
          R2_ENDPOINT: "https://example.com",
        },
      }),
    /local value/,
  )
  assert.throws(
    () => validateContractCoverage(contract, ["NODE_ENV", "NEW_REQUIRED_FEATURE_KEY"]),
    /NEW_REQUIRED_FEATURE_KEY/,
  )
})
