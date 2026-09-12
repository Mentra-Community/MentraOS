// Phone scheme: 3.2.0 build 222 = 320000222. Keep six digits for the run
// number and reject overflow instead of letting adjacent families collide.
export function nativeBuildNumberForFamily(baseVersion, sequence) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(baseVersion || "")
  if (!match) throw new Error("Native build family must be a plain X.Y.Z version")
  const [major, minor, patch] = match.slice(1).map(Number)
  if (major < 1 || major > 20 || minor > 9 || patch > 9) {
    throw new Error("Native build family requires major 1..20 and minor/patch 0..9; revise the scheme before overflow")
  }
  if (!Number.isSafeInteger(sequence) || sequence < 1 || sequence > 999_999) {
    throw new Error("Native build sequence must be an integer in 1..999999")
  }
  return major * 100_000_000 + minor * 10_000_000 + patch * 1_000_000 + sequence
}
