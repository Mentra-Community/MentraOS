export type AppBuildInfo = {
  appVersion: string
  buildCommit: string
  buildBranch: string
  buildTime: string
  buildUser: string
}

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object"

/** A CI build carries its identity in app.config's `mentraBuild`, which packaging rewrites without recompiling. A local
 * developer build has none and keeps the values its .env inlined. */
export function packagedBuildInfo(extra: Record<string, unknown> | undefined, local: AppBuildInfo): AppBuildInfo {
  const build = extra?.mentraBuild
  if (!isRecord(build) || build.schemaVersion !== 2) return local
  const appVersion = typeof build.identity === "string" && build.identity ? build.identity : local.appVersion
  const info = build.buildInfo
  if (
    !isRecord(info) ||
    typeof info.commit !== "string" ||
    !/^[a-f0-9]{40}$/.test(info.commit) ||
    typeof info.branch !== "string" ||
    typeof info.time !== "string" ||
    typeof info.user !== "string"
  )
    return {...local, appVersion}
  return {appVersion, buildCommit: info.commit, buildBranch: info.branch, buildTime: info.time, buildUser: info.user}
}
