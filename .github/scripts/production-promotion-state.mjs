#!/usr/bin/env node
import {readFileSync, writeFileSync} from "node:fs"
import path from "node:path"
import {fileURLToPath} from "node:url"
import {isDeepStrictEqual} from "node:util"

import {releaseRecordSha256, requirePublicHttpsUrl, serializeReleaseRecord} from "./release-family.mjs"

const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const BETA_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-beta\.([1-9]\d*)$/
const COMMIT_PATTERN = /^[0-9a-f]{40}$/
const SHA256_PATTERN = /^[0-9a-f]{64}$/
const ISO_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

export const PROMOTION_STATES = Object.freeze([
  "selected",
  "staging-compatible",
  "production-config-ready",
  "cloud-approved",
  "cloud-deployed",
  "current-clients-accepted",
  "mobile-candidates-uploaded",
  "mobile-candidates-accepted",
  "stores-submitted",
  "stores-approved",
  "public-release-approved",
  "rolling-out",
  "completed",
])

const STATE_INDEX = new Map(PROMOTION_STATES.map((state, index) => [state, index]))

export const TERMINAL_PROMOTION_STATES = Object.freeze(["aborted", "completed"])

export const ATTESTATION_CHECKS = Object.freeze({
  "staging-mobile-n-compatibility": {
    from: "selected",
    to: "staging-compatible",
    coverage: ["mentra-app:ios", "mentra-app:android"],
  },
  "production-mobile-n-compatibility": {
    from: "cloud-deployed",
    to: "current-clients-accepted",
    coverage: ["mentra-app:ios", "mentra-app:android"],
  },
  "production-mobile-candidate-acceptance": {
    from: "mobile-candidates-uploaded",
    to: "mobile-candidates-accepted",
    coverage: ["mentra-app:ios", "mentra-app:android", "starter-kit:ios", "starter-kit:android"],
  },
  "store-review-approved": {
    from: "stores-submitted",
    to: "stores-approved",
    coverage: ["mentra-app:ios", "mentra-app:android", "starter-kit:ios", "starter-kit:android"],
  },
})

export const NEXT_ACTIONS = Object.freeze({
  "staging-compatible": {kind: "workflow", workflow: "production-release-cloud.yml", phase: "preflight"},
  "production-config-ready": {kind: "workflow", workflow: "production-release-cloud.yml", phase: "deploy"},
  "cloud-approved": {kind: "workflow", workflow: "production-release-cloud.yml", phase: "deploy"},
  "cloud-deployed": {kind: "attest", check: "production-mobile-n-compatibility"},
  "current-clients-accepted": {kind: "workflow", workflow: "production-release-mobile.yml", phase: "build"},
  "mobile-candidates-uploaded": {kind: "attest", check: "production-mobile-candidate-acceptance"},
  "mobile-candidates-accepted": {
    kind: "workflow",
    workflow: "production-release-store-submit.yml",
    phase: "submit",
  },
  "stores-submitted": {kind: "attest", check: "store-review-approved"},
  "stores-approved": {kind: "command", command: "release"},
  "public-release-approved": {
    kind: "workflow",
    workflow: "production-release-store-release.yml",
    phase: "release",
  },
  "rolling-out": {kind: "command", command: "advance"},
  "completed": {kind: "none"},
  "aborted": {kind: "none"},
})

function fail(message) {
  throw new Error(`Invalid production promotion: ${message}`)
}

function requireString(value, label, maximum = 512) {
  if (typeof value !== "string" || value.trim() === "") fail(`${label} must be a non-empty string`)
  if (value.length > maximum) fail(`${label} is longer than ${maximum} characters`)
  if (/\r|\n/.test(value)) fail(`${label} must be one line`)
  return value
}

function requireIsoUtc(value, label) {
  if (typeof value !== "string" || !ISO_UTC_PATTERN.test(value) || new Date(value).toISOString() !== value) {
    fail(`${label} must be an ISO-8601 UTC timestamp with milliseconds`)
  }
  return value
}

function requireSha256(value, label) {
  if (!SHA256_PATTERN.test(value || "")) fail(`${label} must be a lowercase SHA-256 digest`)
  return value
}

function requireCommit(value, label) {
  if (!COMMIT_PATTERN.test(value || "")) fail(`${label} must be a full lowercase Git commit`)
  return value
}

function baseVersion(betaIdentity) {
  const match = BETA_PATTERN.exec(betaIdentity || "")
  if (!match) fail("selectedBeta.identity must be X.Y.Z-beta.N")
  return `${match[1]}.${match[2]}.${match[3]}`
}

function requireHttps(value, label) {
  try {
    return requirePublicHttpsUrl(value, label)
  } catch (error) {
    fail(error.message)
  }
}

function validateAppCoordinate(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`)
  requireString(value.marketingVersion, `${label}.marketingVersion`)
  if (!Number.isSafeInteger(value.buildNumber) || value.buildNumber < 1) {
    fail(`${label}.buildNumber must be a positive safe integer`)
  }
  return value
}

function validatePromotionSource(source) {
  if (!source || typeof source !== "object" || Array.isArray(source)) fail("source must be an object")
  requireCommit(source.mentraosCommit, "source.mentraosCommit")
  requireCommit(source.starterKitCommit, "source.starterKitCommit")
  return source
}

function validateEvidenceReference(evidence, label = "evidence") {
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) fail(`${label} must be an object`)
  requireString(evidence.kind, `${label}.kind`, 80)
  requireHttps(evidence.url, `${label}.url`)
  requireSha256(evidence.sha256, `${label}.sha256`)
  if (evidence.assetName !== undefined) requireString(evidence.assetName, `${label}.assetName`, 200)
  return evidence
}

function validatePrevious(previous, sequence) {
  if (sequence === 0) {
    if (previous !== null) fail("the initial record must have previous set to null")
    return
  }
  if (!previous || typeof previous !== "object" || Array.isArray(previous)) {
    fail("non-initial records require previous evidence")
  }
  requireString(previous.assetName, "previous.assetName", 200)
  requireSha256(previous.sha256, "previous.sha256")
}

export function promotionAssetName(record) {
  validatePromotionRecord(record)
  return `production-promotion-${record.releaseIdentity}-attempt-${record.attempt}-${String(record.sequence).padStart(2, "0")}-${record.state}.json`
}

export function validatePromotionRecord(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) fail("record must be an object")
  if (record.schemaVersion !== 1 || record.kind !== "mentra-production-promotion") {
    fail("unsupported record schema")
  }
  if (!VERSION_PATTERN.test(record.releaseIdentity || "")) fail("releaseIdentity must be X.Y.Z")
  if (!Number.isSafeInteger(record.attempt) || record.attempt < 1) fail("attempt must be a positive safe integer")
  if (record.promotionId !== `mentra-${record.releaseIdentity}-attempt-${record.attempt}`) {
    fail("promotionId does not match releaseIdentity and attempt")
  }
  if (!STATE_INDEX.has(record.state) && record.state !== "aborted")
    fail(`unknown state ${JSON.stringify(record.state)}`)
  if (!Number.isSafeInteger(record.sequence) || record.sequence < 0) fail("sequence must be a non-negative integer")
  validatePrevious(record.previous, record.sequence)
  requireIsoUtc(record.createdAt, "createdAt")
  requireString(record.actor, "actor", 100)
  requireHttps(record.provenanceUrl, "provenanceUrl")
  validatePromotionSource(record.source)
  if (!record.selectedBeta || typeof record.selectedBeta !== "object") fail("selectedBeta must be an object")
  const selectedBase = baseVersion(record.selectedBeta.identity)
  if (selectedBase !== record.releaseIdentity) fail("selected beta belongs to a different release identity")
  if (record.selectedBeta.releaseSetId !== `mentra-${record.selectedBeta.identity}`) {
    fail("selectedBeta.releaseSetId does not match its identity")
  }
  requireHttps(record.selectedBeta.manifestUrl, "selectedBeta.manifestUrl")
  requireSha256(record.selectedBeta.manifestSha256, "selectedBeta.manifestSha256")
  if (!record.coordinates || typeof record.coordinates !== "object") fail("coordinates must be an object")
  requireCommit(record.coordinates.currentMentraApp.sourceCommit, "coordinates.currentMentraApp.sourceCommit")
  requireHttps(record.coordinates.currentMentraApp.provenanceUrl, "coordinates.currentMentraApp.provenanceUrl")
  validateAppCoordinate(record.coordinates.currentMentraApp.ios, "coordinates.currentMentraApp.ios")
  validateAppCoordinate(record.coordinates.currentMentraApp.android, "coordinates.currentMentraApp.android")
  validateAppCoordinate(record.coordinates.compatibilityLab.ios, "coordinates.compatibilityLab.ios")
  validateAppCoordinate(record.coordinates.compatibilityLab.android, "coordinates.compatibilityLab.android")
  validateAppCoordinate(record.coordinates.candidates.mentraApp.ios, "coordinates.candidates.mentraApp.ios")
  validateAppCoordinate(record.coordinates.candidates.mentraApp.android, "coordinates.candidates.mentraApp.android")
  validateAppCoordinate(record.coordinates.candidates.starterKit.ios, "coordinates.candidates.starterKit.ios")
  validateAppCoordinate(record.coordinates.candidates.starterKit.android, "coordinates.candidates.starterKit.android")
  if (!Array.isArray(record.evidence)) fail("evidence must be an array")
  record.evidence.forEach((item, index) => validateEvidenceReference(item, `evidence[${index}]`))
  if (record.abort !== undefined) {
    if (record.state !== "aborted") fail("abort details are valid only in the aborted state")
    requireString(record.abort.reason, "abort.reason", 1000)
  }
  return record
}

export function validatePromotionChain(previous, next) {
  validatePromotionRecord(previous)
  validatePromotionRecord(next)
  if (previous.promotionId !== next.promotionId) fail("record chain changes promotionId")
  if (next.sequence !== previous.sequence + 1) fail("record sequence is not contiguous")
  if (next.previous.assetName !== promotionAssetName(previous)) fail("previous asset name does not match")
  if (next.previous.sha256 !== releaseRecordSha256(previous)) fail("previous record digest does not match")
  for (const field of [
    "schemaVersion",
    "kind",
    "promotionId",
    "releaseIdentity",
    "attempt",
    "selectedBeta",
    "source",
    "coordinates",
  ]) {
    if (!isDeepStrictEqual(previous[field], next[field])) fail(`record chain changes frozen field ${field}`)
  }
  if (
    next.evidence.length < previous.evidence.length ||
    !isDeepStrictEqual(next.evidence.slice(0, previous.evidence.length), previous.evidence)
  ) {
    fail("record chain rewrites existing evidence")
  }
  const addedEvidence = next.evidence.length - previous.evidence.length
  if (next.state === "aborted" ? addedEvidence > 1 : addedEvidence !== 1) {
    fail("each non-abort transition must append exactly one evidence reference")
  }
  if (previous.state === "aborted" || previous.state === "completed")
    fail(`cannot append after terminal state ${previous.state}`)
  if (next.state !== "aborted") {
    const previousIndex = STATE_INDEX.get(previous.state)
    const nextIndex = STATE_INDEX.get(next.state)
    const rolloutUpdate = previous.state === "rolling-out" && next.state === "rolling-out"
    const compatibilityLabUpdate =
      previous.state === "selected" &&
      next.state === "selected" &&
      !previous.evidence.some((item) => item.kind === "staging-mobile-n-compatibility-lab") &&
      next.evidence.length === previous.evidence.length + 1 &&
      next.evidence.at(-1)?.kind === "staging-mobile-n-compatibility-lab"
    if (
      previous.state === "selected" &&
      next.state === "staging-compatible" &&
      (!previous.evidence.some((item) => item.kind === "staging-mobile-n-compatibility-lab") ||
        next.evidence.length !== previous.evidence.length + 1 ||
        next.evidence.at(-1)?.kind !== "staging-mobile-n-compatibility")
    ) {
      fail("staging-compatible requires lab build evidence followed by Mobile N acceptance")
    }
    if (!rolloutUpdate && !compatibilityLabUpdate && nextIndex !== previousIndex + 1) {
      fail(`transition ${previous.state} -> ${next.state} is not contiguous`)
    }
  }
  return next
}

export function createInitialPromotionRecord({
  releaseIdentity,
  attempt,
  selectedBeta,
  source,
  coordinates,
  actor,
  createdAt,
  provenanceUrl,
  evidence = [],
}) {
  const record = {
    schemaVersion: 1,
    kind: "mentra-production-promotion",
    promotionId: `mentra-${releaseIdentity}-attempt-${attempt}`,
    releaseIdentity,
    attempt,
    state: "selected",
    sequence: 0,
    previous: null,
    createdAt,
    actor,
    provenanceUrl,
    selectedBeta,
    source,
    coordinates,
    evidence,
  }
  return validatePromotionRecord(record)
}

export function transitionPromotionRecord({record, to, actor, createdAt, provenanceUrl, evidence}) {
  validatePromotionRecord(record)
  if (to === "aborted") fail("use abortPromotionRecord to abort a promotion")
  const next = {
    ...record,
    state: to,
    sequence: record.sequence + 1,
    previous: {assetName: promotionAssetName(record), sha256: releaseRecordSha256(record)},
    createdAt,
    actor,
    provenanceUrl,
    evidence: [...record.evidence, validateEvidenceReference(evidence)],
  }
  delete next.abort
  return validatePromotionChain(record, next)
}

export function abortPromotionRecord({record, actor, createdAt, provenanceUrl, reason, evidence}) {
  validatePromotionRecord(record)
  const next = {
    ...record,
    state: "aborted",
    sequence: record.sequence + 1,
    previous: {assetName: promotionAssetName(record), sha256: releaseRecordSha256(record)},
    createdAt,
    actor,
    provenanceUrl,
    evidence: evidence ? [...record.evidence, validateEvidenceReference(evidence)] : [...record.evidence],
    abort: {reason: requireString(reason, "abort.reason", 1000)},
  }
  return validatePromotionChain(record, next)
}

function secretLike(value) {
  return (
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(value) ||
    /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/i.test(value) ||
    /\b(?:msk|sk|pk_live|rk_live)_[A-Za-z0-9_-]{12,}\b/.test(value)
  )
}

function requireSafeText(value, label, maximum) {
  if (value === undefined) return
  if (typeof value !== "string" || value.length > maximum) fail(`${label} must be text up to ${maximum} characters`)
  if (secretLike(value)) fail(`${label} appears to contain credential material`)
}

export function validateAttestation(attestation, record, expectedCheck) {
  validatePromotionRecord(record)
  if (!attestation || typeof attestation !== "object" || Array.isArray(attestation))
    fail("attestation must be an object")
  if (attestation.schemaVersion !== 1) fail("attestation.schemaVersion must be 1")
  if (attestation.promotionId !== record.promotionId || attestation.releaseIdentity !== record.releaseIdentity) {
    fail("attestation does not identify the current promotion")
  }
  const check = ATTESTATION_CHECKS[attestation.check]
  if (!check || (expectedCheck && attestation.check !== expectedCheck)) fail("attestation check is not expected")
  if (
    attestation.check === "staging-mobile-n-compatibility" &&
    !record.evidence.some((item) => item.kind === "staging-mobile-n-compatibility-lab")
  ) {
    fail("staging Mobile N acceptance requires recorded compatibility-lab build evidence")
  }
  if (record.state !== check.from) fail(`attestation ${attestation.check} cannot apply in state ${record.state}`)
  if (attestation.result !== "pass") fail("only passing attestations can advance a promotion")
  requireIsoUtc(attestation.performedAt, "attestation.performedAt")
  requireString(attestation.tester?.githubLogin, "attestation.tester.githubLogin", 100)
  requireSafeText(attestation.notes, "attestation.notes", 2000)
  if (!Array.isArray(attestation.tests)) fail("attestation.tests must be an array")
  const observed = new Set()
  for (const [index, item] of attestation.tests.entries()) {
    if (!new Set(["mentra-app", "starter-kit"]).has(item?.product)) {
      fail(`attestation.tests[${index}].product is unsupported`)
    }
    if (!new Set(["ios", "android"]).has(item?.platform)) {
      fail(`attestation.tests[${index}].platform is unsupported`)
    }
    if (item.result !== "pass") fail(`attestation.tests[${index}] did not pass`)
    requireString(item.appVersion, `attestation.tests[${index}].appVersion`, 80)
    requireString(String(item.appBuild), `attestation.tests[${index}].appBuild`, 80)
    requireString(item.deviceModel, `attestation.tests[${index}].deviceModel`, 120)
    requireString(item.osVersion, `attestation.tests[${index}].osVersion`, 80)
    requireSafeText(item.notes, `attestation.tests[${index}].notes`, 1000)
    observed.add(`${item.product}:${item.platform}`)
  }
  for (const required of check.coverage) {
    if (!observed.has(required)) fail(`attestation is missing required coverage ${required}`)
  }
  if (!Array.isArray(attestation.evidenceUrls) || attestation.evidenceUrls.length === 0) {
    fail("attestation.evidenceUrls must contain durable evidence")
  }
  attestation.evidenceUrls.forEach((url, index) => requireHttps(url, `attestation.evidenceUrls[${index}]`))
  return attestation
}

export function transitionWithAttestation({
  record,
  attestation,
  expectedCheck = attestation.check,
  actor,
  createdAt,
  provenanceUrl,
  evidenceUrl,
  assetName,
  sha256,
}) {
  validateAttestation(attestation, record, expectedCheck)
  const target = ATTESTATION_CHECKS[attestation.check].to
  return transitionPromotionRecord({
    record,
    to: target,
    actor,
    createdAt,
    provenanceUrl,
    evidence: {kind: attestation.check, url: evidenceUrl, assetName, sha256},
  })
}

export function nextAction(record) {
  validatePromotionRecord(record)
  if (record.state === "selected") {
    return record.evidence.some((item) => item.kind === "staging-mobile-n-compatibility-lab")
      ? {kind: "attest", check: "staging-mobile-n-compatibility"}
      : {kind: "workflow", workflow: "production-release-compatibility-lab.yml", phase: "build"}
  }
  return NEXT_ACTIONS[record.state]
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

function readJson(file) {
  return JSON.parse(readFileSync(path.resolve(file), "utf8"))
}

function main() {
  const command = process.argv[2]
  const args = parseArgs(process.argv.slice(3))
  if (command === "validate") {
    const record = validatePromotionRecord(readJson(args.record))
    if (args.previous) validatePromotionChain(readJson(args.previous), record)
    console.log(`${record.promotionId} is ${record.state}`)
    return
  }
  if (command === "transition") {
    const record = transitionPromotionRecord({
      record: readJson(args.record),
      to: args.to,
      actor: args.actor,
      createdAt: args["created-at"],
      provenanceUrl: args["provenance-url"],
      evidence: readJson(args.evidence),
    })
    writeFileSync(path.resolve(args.output), serializeReleaseRecord(record))
    return
  }
  if (command === "abort") {
    const record = abortPromotionRecord({
      record: readJson(args.record),
      actor: args.actor,
      createdAt: args["created-at"],
      provenanceUrl: args["provenance-url"],
      reason: args.reason,
    })
    writeFileSync(path.resolve(args.output), serializeReleaseRecord(record))
    return
  }
  if (command === "attest") {
    const record = readJson(args.record)
    const attestation = readJson(args.attestation)
    validateAttestation(attestation, record, args.check)
    console.log(`${attestation.check} is valid for ${record.promotionId}`)
    return
  }
  if (command === "attest-transition") {
    const record = transitionWithAttestation({
      record: readJson(args.record),
      attestation: readJson(args.attestation),
      expectedCheck: args.check,
      actor: args.actor,
      createdAt: args["created-at"],
      provenanceUrl: args["provenance-url"],
      evidenceUrl: args["evidence-url"],
      assetName: args["asset-name"],
      sha256: args.sha256,
    })
    writeFileSync(path.resolve(args.output), serializeReleaseRecord(record))
    return
  }
  if (command === "next") {
    console.log(JSON.stringify(nextAction(readJson(args.record))))
    return
  }
  throw new Error(`Unknown production promotion state command ${JSON.stringify(command)}`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
