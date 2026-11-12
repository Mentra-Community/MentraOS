import assert from "node:assert/strict"
import {generateKeyPairSync} from "node:crypto"
import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs"
import {tmpdir} from "node:os"
import path from "node:path"
import test from "node:test"
import {fileURLToPath} from "node:url"

import {
  directEnvironmentKeys,
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

// The release preflight stops on any key the Cloud V2 source reads that the
// contract doesn't classify. Fail here, on the change that adds the key, rather
// than on release day.
test("the production contract classifies every key the Cloud V2 source reads", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
  const production = JSON.parse(
    readFileSync(path.join(root, ".github/production-release/cloud-config-contract.json"), "utf8"),
  )
  assert.equal(validateContractCoverage(production, directEnvironmentKeys(root)), true)
})

test("the source scan reads package code, not tests or installed dependencies", () => {
  const root = mkdtempSync(path.join(tmpdir(), "cloud-config-scan-"))
  try {
    const write = (file, source) => {
      mkdirSync(path.dirname(path.join(root, file)), {recursive: true})
      writeFileSync(path.join(root, file), source)
    }
    write("cloud-v2/packages/core/src/config.ts", "process.env.SOURCE_KEY")
    write("cloud-v2/packages/core/src/config.test.ts", "process.env.TEST_ONLY_KEY")
    write("cloud-v2/packages/core/node_modules/dependency/index.ts", "process.env.DEPENDENCY_KEY")
    assert.deepEqual(directEnvironmentKeys(root), ["SOURCE_KEY"])
  } finally {
    rmSync(root, {recursive: true, force: true})
  }
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

test("key material is never mistaken for a placeholder, whatever its base64 body spells", () => {
  // A fixed Ed25519 pair whose SPKI body happens to spell "TBD", which the
  // placeholder scan would otherwise reject.
  const publicBody = "MCowBQYDK2VwAyEAmtpvSUvHfAc6TBDMnD3v+3avELwMAeYHXxTW4uPjQkQ="
  const privateBody = "MC4CAQAwBQYDK2VwBCIEIDwvpu7AMQgOEE8GXeCapSjNcO1tj5ICp151m3u6cGbK"
  assert.match(publicBody, /tbd/i)
  const pairContract = {
    schemaVersion: 1,
    contractVersion: "test",
    required: {PRIVATE_KEY: {kind: "private-key"}, PUBLIC_KEY: {kind: "public-key"}},
    keyPairs: [{id: "pair", privateKey: "PRIVATE_KEY", publicKey: "PUBLIC_KEY", acceptanceTest: "auth"}],
  }
  const result = validateProductionCloudConfig({
    contract: pairContract,
    environment: "prod",
    values: {PRIVATE_KEY: privateBody, PUBLIC_KEY: publicBody},
  })
  assert.equal(result.checks.find((check) => check.id === "pair").status, "pass")
  assert.throws(
    () =>
      validateProductionCloudConfig({
        contract: {schemaVersion: 1, contractVersion: "test", required: {NAME: {kind: "string"}}},
        environment: "prod",
        values: {NAME: "tbd-later"},
      }),
    /placeholder or local value/,
  )
})

// Prod 3.3.0 deployed without any sign-in settings and passed this check, because they were optional; Core then turned
// portal sign-in off. The production contract's own sign-in rule must pass a working configuration and stop each
// configuration Core would refuse.
function signInCase() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
  const production = JSON.parse(
    readFileSync(path.join(root, ".github/production-release/cloud-config-contract.json"), "utf8"),
  )
  const rule = production.required.CLOUD_CORE_OIDC_CLIENTS
  const keys = [
    "CLOUD_CORE_OIDC_CLIENTS",
    ...Object.values(rule.clients).flatMap((client) => (client.siteKey ? [client.siteKey] : [])),
  ]
  const signInContract = {
    schemaVersion: 1,
    contractVersion: "test",
    required: Object.fromEntries(keys.map((key) => [key, production.required[key]])),
  }
  const clients = [
    {
      clientId: "mentra-admin-prod",
      kind: "admin_portal",
      secretEnv: "CLOUD_CORE_OIDC_ADMIN_PORTAL_CLIENT_SECRET",
      redirectUris: ["https://admin.example.com/api/admin/auth/callback"],
    },
    {
      clientId: "mentra-portal-prod",
      kind: "workspace_portal",
      secretEnv: "CLOUD_CORE_OIDC_WORKSPACE_PORTAL_CLIENT_SECRET",
      redirectUris: ["https://portal.example.com/api/portal/auth/callback"],
    },
    {clientId: "mentra-cli-prod", kind: "cli", redirectUris: ["http://127.0.0.1:53682/callback"]},
    {
      clientId: "mentra-console-prod",
      kind: "console",
      secretEnv: "CLOUD_CORE_OIDC_CONSOLE_CLIENT_SECRET",
      redirectUris: ["https://console.example.com/api/console/auth/callback"],
    },
  ]
  const values = {
    CLOUD_CORE_ADMIN_PORTAL_URL: "https://admin.example.com",
    CLOUD_CORE_ENTERPRISE_PORTAL_URL: "https://portal.example.com",
    CLOUD_CORE_OIDC_ADMIN_PORTAL_CLIENT_SECRET: "a".repeat(64),
    CLOUD_CORE_OIDC_WORKSPACE_PORTAL_CLIENT_SECRET: "b".repeat(64),
    CLOUD_CORE_OIDC_CONSOLE_CLIENT_SECRET: "c".repeat(64),
  }
  return {signInContract, clients, values}
}

function validateSignIn(signInContract, clients, values) {
  return validateProductionCloudConfig({
    contract: signInContract,
    environment: "prod",
    values: {...values, CLOUD_CORE_OIDC_CLIENTS: JSON.stringify(clients)},
  })
}

test("portal sign-in needs each portal's client, its secret and its callback", () => {
  const {signInContract, clients, values} = signInCase()
  assert.equal(validateContractCoverage(signInContract, []), true)
  const evidence = validateSignIn(signInContract, clients, values)
  assert.equal(evidence.checks.find((check) => check.id === "CLOUD_CORE_OIDC_CLIENTS").status, "pass")
  assert.equal(JSON.stringify(evidence).includes("mentra-admin-prod"), false)

  assert.throws(
    () => validateSignIn(signInContract, [], values),
    /CLOUD_CORE_OIDC_CLIENTS has no admin_portal client/,
  )
  assert.throws(
    () =>
      validateSignIn(
        signInContract,
        clients.filter((client) => client.kind !== "console"),
        values,
      ),
    /has no console client/,
  )
  assert.throws(
    () =>
      validateSignIn(
        signInContract,
        clients.map((client) => (client.kind === "console" ? {...client, secretEnv: undefined} : client)),
        values,
      ),
    /the console client names no secretEnv/,
  )
  assert.throws(
    () => validateSignIn(signInContract, clients, {...values, CLOUD_CORE_OIDC_WORKSPACE_PORTAL_CLIENT_SECRET: ""}),
    /workspace_portal client's CLOUD_CORE_OIDC_WORKSPACE_PORTAL_CLIENT_SECRET is missing/,
  )
  assert.throws(
    () => validateSignIn(signInContract, clients, {...values, CLOUD_CORE_ADMIN_PORTAL_URL: "https://admin.other.com"}),
    /admin_portal client does not register the CLOUD_CORE_ADMIN_PORTAL_URL callback/,
  )
  assert.throws(
    () =>
      validateProductionCloudConfig({
        contract: signInContract,
        environment: "prod",
        values: {...values, CLOUD_CORE_OIDC_CLIENTS: "{}"},
      }),
    /not a JSON array of clients/,
  )
})

test("a sign-in client's site must itself be a required key", () => {
  const {signInContract} = signInCase()
  const unchecked = structuredClone(signInContract)
  delete unchecked.required.CLOUD_CORE_ADMIN_PORTAL_URL
  assert.throws(() => validateContractCoverage(unchecked, []), /CLOUD_CORE_ADMIN_PORTAL_URL, which is not a required key/)
})

test("sign-in secrets and the issuer meet Core's startup rules", () => {
  const {signInContract, clients, values} = signInCase()
  assert.throws(
    () => validateSignIn(signInContract, clients, {...values, CLOUD_CORE_OIDC_CONSOLE_CLIENT_SECRET: "short"}),
    /console client's CLOUD_CORE_OIDC_CONSOLE_CLIENT_SECRET is shorter than 32 characters/,
  )
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
  const production = JSON.parse(
    readFileSync(path.join(root, ".github/production-release/cloud-config-contract.json"), "utf8"),
  )
  const issuerContract = {
    schemaVersion: 1,
    contractVersion: "test",
    required: {
      CLOUD_CORE_OIDC_ISSUER: production.required.CLOUD_CORE_OIDC_ISSUER,
      CLOUD_CORE_OIDC_COOKIE_KEYS: production.required.CLOUD_CORE_OIDC_COOKIE_KEYS,
    },
  }
  const issuerValues = {CLOUD_CORE_OIDC_ISSUER: "https://account.example.com", CLOUD_CORE_OIDC_COOKIE_KEYS: "k".repeat(64)}
  const check = (overrides) =>
    validateProductionCloudConfig({contract: issuerContract, environment: "prod", values: {...issuerValues, ...overrides}})
  assert.doesNotThrow(() => check({}))
  assert.doesNotThrow(() => check({CLOUD_CORE_OIDC_ISSUER: "https://account.example.com/"}))
  assert.doesNotThrow(() => check({CLOUD_CORE_OIDC_COOKIE_KEYS: `${"n".repeat(32)}, ${"o".repeat(40)}`}))
  assert.throws(() => check({CLOUD_CORE_OIDC_ISSUER: "https://account.example.com/oidc"}), /must be an origin/)
  assert.throws(() => check({CLOUD_CORE_OIDC_ISSUER: "https://account.example.com?x=1"}), /must be an origin/)
  assert.throws(() => check({CLOUD_CORE_OIDC_ISSUER: "http://account.example.com"}), /unsafe or unsupported URL shape/)
  assert.throws(
    () => check({CLOUD_CORE_OIDC_COOKIE_KEYS: `${"n".repeat(32)},short`}),
    /CLOUD_CORE_OIDC_COOKIE_KEYS has an entry shorter than 32 characters/,
  )
})
