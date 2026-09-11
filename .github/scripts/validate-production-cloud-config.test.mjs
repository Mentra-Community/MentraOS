import assert from "node:assert/strict"
import {generateKeyPairSync} from "node:crypto"
import test from "node:test"

import {
  parseEnvironmentFile,
  validateContractCoverage,
  validateProductionCloudConfig,
  keyMaterial,
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
    REDIS_URL: {kind: "redis-url", acceptanceTest: "redis"},
  },
  requiredAnyOf: [{id: "storage", keys: ["R2_ENDPOINT", "S3_ENDPOINT"], kind: "https-url", acceptanceTest: "storage"}],
  optional: ["LOG_LEVEL"],
  forbidden: ["AUDIO_DEBUG_ECHO"],
  keyPairs: [{id: "jwt-pair", privateKey: "PRIVATE_KEY", publicKey: "PUBLIC_KEY", acceptanceTest: "auth"}],
}

function validValues() {
  return {
    NODE_ENV: "production",
    MONGO_URL: "mongodb+srv://mentra-user:encoded%40password@cluster.example.com/mentra",
    REDIS_URL: "rediss://default:encoded%40password@redis.example.com:6380",
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

test("allows credentials only in database connection URLs", () => {
  assert.doesNotThrow(() => validateProductionCloudConfig({contract, environment: "prod", values: validValues()}))
  const values = validValues()
  values.R2_ENDPOINT = "https://user:password@account.r2.cloudflarestorage.com"
  assert.throws(
    () => validateProductionCloudConfig({contract, environment: "prod", values}),
    /unsafe or unsupported URL shape/,
  )
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

test("accepts the bare base64 key bodies Cloud V2 stores, and rejects mismatched or garbage keys", () => {
  const {privateKey, publicKey} = generateKeyPairSync("ed25519")
  const body = (key, type) => key.export({type, format: "der"}).toString("base64")
  const bodies = {
    privateKey: body(privateKey, "pkcs8"),
    publicKey: body(publicKey, "spki"),
  }
  assert.match(
    keyMaterial(bodies.privateKey, "PRIVATE KEY"),
    /^-----BEGIN PRIVATE KEY-----\n[A-Za-z0-9+/=]+\n-----END PRIVATE KEY-----$/,
  )
  assert.equal(
    keyMaterial("-----BEGIN PUBLIC KEY-----\\nabc\\n-----END PUBLIC KEY-----", "PUBLIC KEY"),
    "-----BEGIN PUBLIC KEY-----\nabc\n-----END PUBLIC KEY-----",
  )
  const rules = {PRIVATE_KEY: {kind: "private-key"}, PUBLIC_KEY: {kind: "public-key"}}
  const pairContract = {
    schemaVersion: 1,
    contractVersion: "test",
    required: rules,
    keyPairs: [{id: "pair", privateKey: "PRIVATE_KEY", publicKey: "PUBLIC_KEY", acceptanceTest: "auth"}],
  }
  const result = validateProductionCloudConfig({
    contract: pairContract,
    environment: "prod",
    values: {PRIVATE_KEY: bodies.privateKey, PUBLIC_KEY: bodies.publicKey},
  })
  assert.equal(result.checks.find((check) => check.id === "pair").status, "pass")
  const other = generateKeyPairSync("ed25519")
  assert.throws(
    () =>
      validateProductionCloudConfig({
        contract: pairContract,
        environment: "prod",
        values: {PRIVATE_KEY: bodies.privateKey, PUBLIC_KEY: body(other.publicKey, "spki")},
      }),
    /do not correspond/,
  )
  assert.throws(
    () =>
      validateProductionCloudConfig({
        contract: pairContract,
        environment: "prod",
        values: {PRIVATE_KEY: "not a key at all!", PUBLIC_KEY: bodies.publicKey},
      }),
    /not a private key/,
  )
})

test("private key material is rejected in a public-key slot, in PEM and escaped form", () => {
  const {privateKey, publicKey} = generateKeyPairSync("ed25519")
  const privatePem = privateKey.export({type: "pkcs8", format: "pem"})
  const privateBody = privateKey.export({type: "pkcs8", format: "der"}).toString("base64")
  const publicBody = publicKey.export({type: "spki", format: "der"}).toString("base64")
  const pairContract = {
    schemaVersion: 1,
    contractVersion: "test",
    required: {PRIVATE_KEY: {kind: "private-key"}, PUBLIC_KEY: {kind: "public-key"}},
    keyPairs: [{id: "pair", privateKey: "PRIVATE_KEY", publicKey: "PUBLIC_KEY", acceptanceTest: "auth"}],
  }
  for (const publicSlot of [privatePem, privatePem.replace(/\n/g, "\\n")]) {
    assert.throws(
      () =>
        validateProductionCloudConfig({
          contract: pairContract,
          environment: "prod",
          values: {PRIVATE_KEY: privateBody, PUBLIC_KEY: publicSlot},
        }),
      /not a public key/,
    )
  }
  assert.throws(
    () =>
      keyMaterial(publicBody && `-----BEGIN PUBLIC KEY-----\n${publicBody}\n-----END PUBLIC KEY-----`, "PRIVATE KEY"),
    /expected type/,
  )
  assert.equal(
    validateProductionCloudConfig({
      contract: pairContract,
      environment: "prod",
      values: {PRIVATE_KEY: privateBody, PUBLIC_KEY: publicBody},
    }).checks.find((check) => check.id === "pair").status,
    "pass",
  )
})

test("staging may run with NODE_ENV=staging while prod must be production", () => {
  const rule = {kind: "enum", valuesByEnvironment: {staging: ["staging", "production"], prod: ["production"]}}
  const single = {schemaVersion: 1, contractVersion: "test", required: {NODE_ENV: rule}}
  assert.equal(
    validateProductionCloudConfig({contract: single, environment: "staging", values: {NODE_ENV: "staging"}}).checks[0]
      .status,
    "pass",
  )
  assert.throws(
    () => validateProductionCloudConfig({contract: single, environment: "prod", values: {NODE_ENV: "staging"}}),
    /not an allowed prod value/,
  )
})

const conditionalContract = {
  schemaVersion: 1,
  contractVersion: "test-2",
  required: {
    STORAGE_PROVIDER: {kind: "enum", values: ["local", "r2"], acceptanceTest: "camera"},
    CAMERA_WEBHOOK_SECRET: {
      kind: "secret",
      requiredWhen: {key: "STORAGE_PROVIDER", values: ["r2"]},
      acceptanceTest: "camera",
    },
  },
  requiredAnyOf: [
    {
      id: "runtime-storage-endpoint",
      keys: ["STORAGE_S3_ENDPOINT", "R2_ENDPOINT"],
      kind: "https-url",
      requiredWhen: {key: "STORAGE_PROVIDER", values: ["r2"]},
      acceptanceTest: "camera",
    },
  ],
}

test("conditional requirements apply only while the selecting key holds a listed value", () => {
  const local = validateProductionCloudConfig({
    contract: conditionalContract,
    environment: "prod",
    values: {STORAGE_PROVIDER: "local"},
  })
  assert.deepEqual(
    local.checks.map((check) => [check.id, check.status, check.keys]),
    [
      ["CAMERA_WEBHOOK_SECRET", "inactive", []],
      ["runtime-storage-endpoint", "inactive", []],
      ["STORAGE_PROVIDER", "pass", ["STORAGE_PROVIDER"]],
    ],
  )
  // Inactive keys that are nevertheless present are still validated.
  assert.throws(
    () =>
      validateProductionCloudConfig({
        contract: conditionalContract,
        environment: "prod",
        values: {STORAGE_PROVIDER: "local", R2_ENDPOINT: "http://localhost:9000"},
      }),
    /R2_ENDPOINT/,
  )
  assert.throws(
    () =>
      validateProductionCloudConfig({
        contract: conditionalContract,
        environment: "prod",
        values: {STORAGE_PROVIDER: "r2", R2_ENDPOINT: "https://account.r2.cloudflarestorage.com"},
      }),
    /CAMERA_WEBHOOK_SECRET is missing/,
  )
  assert.throws(
    () =>
      validateProductionCloudConfig({
        contract: conditionalContract,
        environment: "prod",
        values: {STORAGE_PROVIDER: "r2", CAMERA_WEBHOOK_SECRET: "s3cret"},
      }),
    /runtime-storage-endpoint requires one of/,
  )
  const remote = validateProductionCloudConfig({
    contract: conditionalContract,
    environment: "prod",
    values: {
      STORAGE_PROVIDER: "r2",
      CAMERA_WEBHOOK_SECRET: "s3cret",
      R2_ENDPOINT: "https://account.r2.cloudflarestorage.com",
    },
  })
  assert.equal(
    remote.checks.every((check) => check.status === "pass"),
    true,
  )
})

test("a condition must point at a required enum that offers the listed values", () => {
  const unknownSelector = structuredClone(conditionalContract)
  unknownSelector.required.CAMERA_WEBHOOK_SECRET.requiredWhen = {key: "PHOTO_MODE", values: ["cloud"]}
  assert.throws(() => validateContractCoverage(unknownSelector, []), /conditional on PHOTO_MODE/)
  const unknownValue = structuredClone(conditionalContract)
  unknownValue.requiredAnyOf[0].requiredWhen = {key: "STORAGE_PROVIDER", values: ["gcs"]}
  assert.throws(() => validateContractCoverage(unknownValue, []), /conditional on STORAGE_PROVIDER/)
})
