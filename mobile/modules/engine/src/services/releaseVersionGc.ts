import semver from "semver"

/** Select obsolete installed release directories without touching dev/staging artifacts. */
export function selectReleaseVersionsForGarbageCollection(
  versions: readonly string[],
  keepVersions: ReadonlySet<string>,
): string[] {
  return versions.filter((version) => semver.valid(version) && !keepVersions.has(version))
}
