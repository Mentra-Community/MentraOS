export interface AppBuildInfo {
  appVersion: string
  buildCommit: string
  buildBranch: string
  buildTime: string
  buildUser: string
}

export function packagedBuildInfo(extra: Record<string, unknown> | undefined, embedded: AppBuildInfo): AppBuildInfo {
  const contract = extra?.mentraPrBuild
  if (
    !contract ||
    typeof contract !== "object" ||
    !("schemaVersion" in contract) ||
    contract.schemaVersion !== 1 ||
    !("buildInfo" in contract)
  )
    return embedded
  const info = contract.buildInfo
  if (!info || typeof info !== "object") return embedded
  if (
    !("commit" in info) ||
    typeof info.commit !== "string" ||
    !/^[a-f0-9]{40}$/.test(info.commit) ||
    !("branch" in info) ||
    typeof info.branch !== "string" ||
    !("time" in info) ||
    typeof info.time !== "string" ||
    !("user" in info) ||
    typeof info.user !== "string"
  )
    return embedded
  return {...embedded, buildCommit: info.commit, buildBranch: info.branch, buildTime: info.time, buildUser: info.user}
}
