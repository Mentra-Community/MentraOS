#!/usr/bin/env node
import {createPrivateKey, createPublicKey} from "node:crypto"
import {readdirSync, readFileSync, statSync, writeFileSync} from "node:fs"
import path from "node:path"
import {fileURLToPath} from "node:url"

const DIRECT_ENV_PATTERN = /process\.env\.([A-Z][A-Z0-9_]*)/g

function readJson(file) {
  return JSON.parse(readFileSync(path.resolve(file), "utf8"))
}

export function parseEnvironmentFile(contents) {
  const values = {}
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith("#")) continue
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line)
    if (!match) throw new Error("Environment file contains an unsupported line")
    let value = match[2]
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    values[match[1]] = value.replaceAll("\\n", "\n")
  }
  return values
}

function filesUnder(directory) {
  const files = []
  for (const entry of readdirSync(directory)) {
    const file = path.join(directory, entry)
    const stat = statSync(file)
    if (stat.isDirectory()) files.push(...filesUnder(file))
    else if (file.endsWith(".ts") && !file.endsWith(".test.ts")) files.push(file)
  }
  return files
}

export function directEnvironmentKeys(root) {
  const keys = new Set()
  for (const file of filesUnder(path.join(root, "cloud-v2/packages"))) {
    const source = readFileSync(file, "utf8")
    for (const match of source.matchAll(DIRECT_ENV_PATTERN)) keys.add(match[1])
  }
  return [...keys].sort()
}

export function classifiedContractKeys(contract) {
  const keys = new Set([
    ...Object.keys(contract.required || {}),
    ...(contract.optional || []),
    ...(contract.forbidden || []),
  ])
  for (const requirement of contract.requiredAnyOf || []) requirement.keys.forEach((key) => keys.add(key))
  for (const pair of contract.keyPairs || []) {
    keys.add(pair.privateKey)
    keys.add(pair.publicKey)
  }
  return keys
}

export function validateContractCoverage(contract, sourceKeys) {
  if (contract.schemaVersion !== 1 || typeof contract.contractVersion !== "string") {
    throw new Error("Unsupported production Cloud configuration contract")
  }
  const classified = classifiedContractKeys(contract)
  const missing = sourceKeys.filter((key) => !classified.has(key))
  if (missing.length > 0) throw new Error(`Unclassified Cloud V2 environment keys: ${missing.join(", ")}`)
  const overlaps = []
  for (const key of Object.keys(contract.required || {})) {
    if ((contract.optional || []).includes(key) || (contract.forbidden || []).includes(key)) overlaps.push(key)
  }
  if (overlaps.length > 0)
    throw new Error(`Cloud configuration keys have conflicting classifications: ${overlaps.join(", ")}`)
  return true
}

function validateUrl(value, protocols, label) {
  let url
  try {
    url = new URL(value)
  } catch {
    throw new Error(`${label} is not a valid URL`)
  }
  if (!protocols.includes(url.protocol) || url.username || url.password || url.hash) {
    throw new Error(`${label} has an unsafe or unsupported URL shape`)
  }
  return url
}

function validateValue(value, rule, label, environment) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} is missing or empty`)
  if (/TBD|CHANGEME|localhost|127\.0\.0\.1/i.test(value))
    throw new Error(`${label} contains a placeholder or local value`)
  const values = rule.valuesByEnvironment?.[environment] || rule.values
  if (values && !values.includes(value)) throw new Error(`${label} is not an allowed ${environment} value`)
  if (rule.kind === "https-url") validateUrl(value, ["https:"], label)
  if (rule.kind === "mongo-url") validateUrl(value, ["mongodb:", "mongodb+srv:"], label)
  if (rule.kind === "redis-url") validateUrl(value, ["redis:", "rediss:"], label)
  if (rule.kind === "integer" && (!/^\d+$/.test(value) || Number(value) < 1))
    throw new Error(`${label} is not positive integer text`)
  if (rule.kind === "json") {
    try {
      JSON.parse(value)
    } catch {
      throw new Error(`${label} is not valid JSON`)
    }
  }
  if (rule.kind === "host" && (!/^[A-Za-z0-9.-]+$/.test(value) || !value.includes("."))) {
    throw new Error(`${label} is not a hostname`)
  }
  if (rule.kind === "private-key" && !/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(value)) {
    throw new Error(`${label} is not private-key PEM`)
  }
  if (rule.kind === "public-key" && !/-----BEGIN (?:PUBLIC KEY|CERTIFICATE)-----/.test(value)) {
    throw new Error(`${label} is not public-key PEM`)
  }
}

export function validateProductionCloudConfig({contract, environment, values}) {
  if (!new Set(["staging", "prod"]).has(environment)) throw new Error(`Unsupported environment ${environment}`)
  validateContractCoverage(contract, [])
  const checks = []
  for (const [key, rule] of Object.entries(contract.required)) {
    validateValue(values[key], rule, key, environment)
    checks.push({id: key, keys: [key], status: "pass", acceptanceTest: rule.acceptanceTest})
  }
  for (const requirement of contract.requiredAnyOf || []) {
    const present = requirement.keys.filter((key) => typeof values[key] === "string" && values[key].trim() !== "")
    if (present.length === 0) throw new Error(`${requirement.id} requires one of ${requirement.keys.join(", ")}`)
    present.forEach((key) => validateValue(values[key], requirement, key, environment))
    checks.push({
      id: requirement.id,
      keys: present.sort(),
      status: "pass",
      acceptanceTest: requirement.acceptanceTest,
    })
  }
  for (const key of contract.forbidden || []) {
    if (typeof values[key] === "string" && values[key].trim() !== "")
      throw new Error(`${key} is forbidden in ${environment}`)
    checks.push({id: key, keys: [key], status: "absent", acceptanceTest: null})
  }
  for (const pair of contract.keyPairs || []) {
    let derived
    let supplied
    try {
      derived = createPublicKey(createPrivateKey(values[pair.privateKey])).export({type: "spki", format: "pem"})
      supplied = createPublicKey(values[pair.publicKey]).export({type: "spki", format: "pem"})
    } catch {
      throw new Error(`${pair.id} contains an invalid key pair`)
    }
    if (derived !== supplied) throw new Error(`${pair.id} private and public keys do not correspond`)
    checks.push({
      id: pair.id,
      keys: [pair.privateKey, pair.publicKey],
      status: "pass",
      acceptanceTest: pair.acceptanceTest,
    })
  }
  return {
    schemaVersion: 1,
    kind: "production-cloud-config-validation",
    contractVersion: contract.contractVersion,
    environment,
    checks: checks.sort((left, right) => left.id.localeCompare(right.id)),
  }
}

function parseArgs(args) {
  const values = {}
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index]
    const value = args[index + 1]
    if (!option?.startsWith("--") || value === undefined) throw new Error("Expected --name value pairs")
    values[option.slice(2)] = value
  }
  return values
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const root = path.resolve(args.root || process.cwd())
  const contract = readJson(args.contract)
  validateContractCoverage(contract, directEnvironmentKeys(root))
  if (args.values || args["env-file"]) {
    const evidence = validateProductionCloudConfig({
      contract,
      environment: args.environment,
      values: args["env-file"]
        ? parseEnvironmentFile(readFileSync(path.resolve(args["env-file"]), "utf8"))
        : readJson(args.values),
    })
    writeFileSync(path.resolve(args.output), `${JSON.stringify(evidence, null, 2)}\n`)
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
