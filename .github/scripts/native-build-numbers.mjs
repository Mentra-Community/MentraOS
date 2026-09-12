import {readFileSync} from "node:fs"

export const MAX_NATIVE_BUILD_NUMBER = 2_100_000_000
export const MAX_NATIVE_SEQUENCE = 999_999

// Preserve the phone scheme: 3.2.0 build 222 = 320000222. Reject overflow
// rather than allowing (for example) 3.10.0 to alias 4.0.0.
export function nativeBuildPrefix(baseVersion) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(baseVersion || "")
  if (!match) throw new Error("Native build family must be a plain X.Y.Z version")
  const [major, minor, patch] = match.slice(1).map(Number)
  if (major < 1 || major > 20 || minor > 9 || patch > 9) {
    throw new Error("Native build family requires major 1..20 and minor/patch 0..9; revise the scheme before overflow")
  }
  return major * 100_000_000 + minor * 10_000_000 + patch * 1_000_000
}

export function validBuildNumber(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_NATIVE_BUILD_NUMBER) {
    throw new Error(`Invalid native build number ${JSON.stringify(value)}`)
  }
  return value
}

export function reserveNativeBuilds(state, request) {
  if (state?.schemaVersion !== 1 || !Array.isArray(state.reservations)) throw new Error("Invalid native build ledger")
  const {key, baseVersion, sourceCommit, count = 1, minimumSequence = 1, minimumBuildNumber = 0} = request
  const prefix = nativeBuildPrefix(baseVersion)
  if (typeof key !== "string" || !/^[a-zA-Z0-9:._-]{1,200}$/.test(key)) throw new Error("Invalid reservation key")
  if (!/^[a-f0-9]{40}$/.test(sourceCommit || "")) throw new Error("Reservation requires an exact source commit")
  if (![1, 2].includes(count)) throw new Error("Reserve one build or a compatibility-lab/candidate pair")
  if (!Number.isSafeInteger(minimumSequence) || minimumSequence < 1 || minimumSequence > MAX_NATIVE_SEQUENCE) {
    throw new Error("Native build sequence is outside 1..999999")
  }
  if (!Number.isSafeInteger(minimumBuildNumber) || minimumBuildNumber < 0) throw new Error("Invalid store floor")
  const keys = new Set()
  const codes = new Set()
  let lastSequence = 0
  for (const entry of state.reservations) {
    if (keys.has(entry.key)) throw new Error("Duplicate reservation key in native build ledger")
    keys.add(entry.key)
    const entryPrefix = nativeBuildPrefix(entry.baseVersion)
    if (!/^[a-f0-9]{40}$/.test(entry.sourceCommit || "") || ![1, 2].includes(entry.buildNumbers?.length)) {
      throw new Error("Invalid reservation in native build ledger")
    }
    for (const [index, code] of entry.buildNumbers.entries()) {
      validBuildNumber(code)
      if (codes.has(code)) throw new Error("Duplicate native build number in ledger")
      codes.add(code)
      if (
        code <= entryPrefix ||
        code > entryPrefix + MAX_NATIVE_SEQUENCE ||
        (index && code !== entry.buildNumbers[index - 1] + 1)
      ) {
        throw new Error("Reservation does not belong to its native build family")
      }
      if (entry.baseVersion === baseVersion) lastSequence = Math.max(lastSequence, code - prefix)
    }
  }
  const existing = state.reservations.find((entry) => entry.key === key)
  if (existing) {
    if (
      existing.baseVersion !== baseVersion ||
      existing.sourceCommit !== sourceCommit ||
      existing.buildNumbers.length !== count
    ) {
      throw new Error("Retry changed the immutable native build reservation")
    }
    return {state, reservation: existing, reused: true}
  }
  const sequence = Math.max(lastSequence + 1, minimumSequence, minimumBuildNumber - prefix + 1)
  if (sequence + count - 1 > MAX_NATIVE_SEQUENCE) {
    throw new Error(`Store floor or ledger exceeds native family ${baseVersion}; refusing to jump to another family`)
  }
  const reservation = {
    key,
    baseVersion,
    sourceCommit,
    buildNumbers: Array.from({length: count}, (_, i) => validBuildNumber(prefix + sequence + i)),
  }
  return {state: {...state, reservations: [...state.reservations, reservation]}, reservation, reused: false}
}

export function playReleaseStatus({versionCode, existingCodes, immutableArtifactsExist = false}) {
  validBuildNumber(versionCode)
  if (!Array.isArray(existingCodes)) throw new Error("Play inventory must be an array")
  const codes = existingCodes.map((code) => validBuildNumber(Number(code)))
  if (codes.includes(versionCode)) {
    if (!immutableArtifactsExist)
      throw new Error("Play already contains this build number without this release's immutable artifacts")
    return "exists"
  }
  if (codes.some((code) => code > versionCode))
    throw new Error("Planned Android version code is below the selected Play track; refusing a downgrade")
  return "new"
}

export function readNativeBuildPolicy() {
  const policy = JSON.parse(readFileSync(new URL("../native-build-policy.json", import.meta.url), "utf8"))
  if (policy.schemaVersion !== 1) throw new Error("Unknown native build policy")
  const tracks = ["dev", "beta", "productionCandidates", "production"].map((key) => policy.play?.[key])
  if (
    tracks.some((track) => typeof track !== "string" || !/^[a-z][a-z0-9-]*$/.test(track)) ||
    new Set(tracks).size !== tracks.length
  ) {
    throw new Error("Native build policy requires four distinct Play tracks")
  }
  if (!Array.isArray(policy.retiredPlayTracks) || policy.retiredPlayTracks.some((track) => tracks.includes(track))) {
    throw new Error("Retired Play tracks must not receive new builds")
  }
  return policy
}

// Keep the full inventory for audit, but order a production candidate against
// its delivery track, production, the selected beta and the relevant iOS
// marketing versions. Dev can already be on the next family; its testers do
// not need to downgrade to an older production build.
export function productionBuildFloor({
  inventory,
  betaBuildNumber,
  baseVersion,
  includeCompatibilityLab = false,
  policy = readNativeBuildPolicy(),
}) {
  const tracks = inventory.google?.tracks
  if (!tracks || typeof tracks !== "object" || Array.isArray(tracks))
    throw new Error("Production allocation needs Google Play track inventory")
  const relevantTracks = [policy.play.productionCandidates, policy.play.production]
  const codes = relevantTracks.flatMap((track) => {
    if (!Array.isArray(tracks[track])) throw new Error(`Missing Google Play inventory for ${track}`)
    return tracks[track].map((code) => validBuildNumber(Number(code)))
  })
  const versions = [baseVersion]
  if (includeCompatibilityLab) versions.push(inventory.apple.current.marketingVersion)
  const appleFloors = versions.map((version) => {
    const floor = inventory.apple.maxBuildNumbersByMarketingVersion?.[version]
    if (!Number.isSafeInteger(floor) || floor < 0)
      throw new Error(`Missing numeric Apple inventory for version ${version}`)
    return floor
  })
  return Math.max(
    validBuildNumber(betaBuildNumber),
    validBuildNumber(inventory.google.currentVersionCode),
    ...appleFloors,
    ...codes,
  )
}

export function validateNativeReservation(reservation, {baseVersion, sourceCommit, count}) {
  if (!reservation) throw new Error("A durable native build reservation is required")
  return reserveNativeBuilds(
    {schemaVersion: 1, reservations: [reservation]},
    {
      key: reservation.key,
      baseVersion,
      sourceCommit,
      count,
    },
  ).reservation
}
