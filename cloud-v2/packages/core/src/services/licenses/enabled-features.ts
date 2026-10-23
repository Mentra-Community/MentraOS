/**
 * @fileoverview `CLOUD_CORE_ENABLED_FEATURES`: the first-party features an operator switches on for every
 * signed-in person, and the one parser for it.
 *
 * The setting is a comma-separated list of `feature[:package+package]` entries, for example
 * `call.unlimited:com.mentra.call, fleet.managed`:
 *
 *  - an entry with packages grants that feature to every signed-in person, in those packages' miniapp
 *    tokens only (`features.service.ts`);
 *  - an entry without packages names a feature that reaches no token. Fleet reads only the names, to
 *    know whether `fleet.managed` is listed (`services/fleet/fleet-config.ts`);
 *  - a feature listed twice gets the union of its packages;
 *  - names are case-sensitive, whitespace around names and packages is ignored, and an entry with no
 *    feature name is skipped.
 *
 * Blank or unset (the hosted Core) is different from a value that lists nothing: Fleet's installation is
 * left to its own settings only while the setting is blank, so `enabledFeaturesConfigured` tells the two
 * apart. Both functions read the environment on each call, so a changed setting takes effect on the next
 * request and tests can pass their own.
 */

/** The only setting this module reads, taken from the process now as a literal `process.env` property. */
function processEnvironment(): NodeJS.ProcessEnv {
  return {CLOUD_CORE_ENABLED_FEATURES: process.env.CLOUD_CORE_ENABLED_FEATURES}
}

function rawSetting(env: NodeJS.ProcessEnv): string {
  return (env.CLOUD_CORE_ENABLED_FEATURES ?? "").trim()
}

/** Whether `CLOUD_CORE_ENABLED_FEATURES` is set to anything but blank, even a value that lists no feature. */
export function enabledFeaturesConfigured(env: NodeJS.ProcessEnv = processEnvironment()): boolean {
  return rawSetting(env) !== ""
}

/**
 * The features `CLOUD_CORE_ENABLED_FEATURES` lists, each with the packages it is for (a feature for no
 * package has an empty set). Empty when the setting is blank or lists no feature.
 */
export function parseEnabledFeatures(env: NodeJS.ProcessEnv = processEnvironment()): Map<string, Set<string>> {
  const features = new Map<string, Set<string>>()
  const raw = rawSetting(env)
  if (!raw) return features

  for (const entry of raw.split(",")) {
    const colon = entry.indexOf(":")
    const name = (colon === -1 ? entry : entry.slice(0, colon)).trim()
    if (!name) continue
    const packages = features.get(name) ?? new Set<string>()
    features.set(name, packages)
    if (colon === -1) continue
    for (const packageName of entry.slice(colon + 1).split("+")) {
      const trimmed = packageName.trim()
      if (trimmed) packages.add(trimmed)
    }
  }
  return features
}
