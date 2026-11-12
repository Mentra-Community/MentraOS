/**
 * Which kind of build each package's latest context runs. The router records it as it registers the context
 * (`MentraJSRouter.registerApp`, on every spawn and respawn), before the context is live.
 *
 * A local or development build (a local-network install, a development server or a development snapshot) may claim
 * any package name, so nothing about the name is trusted: its data is apart from every other install of the name
 * (`miniappDataPartition.ts`), its miniapp tokens are marked as a local build's, and it never gets system privileges
 * (`LocalMiniappRuntime`).
 */
const localBuilds = new Set<string>()

/** Record which kind of build `packageName`'s context runs, as it starts. */
export function recordMiniappBuild(packageName: string, build: {localBuild: boolean}): void {
  if (build.localBuild) localBuilds.add(packageName)
  else localBuilds.delete(packageName)
}

/** Whether `packageName`'s latest context started as a local or development build. */
export function isLocalBuildContext(packageName: string): boolean {
  return localBuilds.has(packageName)
}

/** Tests only. */
export function resetMiniappBuildsForTests(): void {
  localBuilds.clear()
}
