#!/usr/bin/env zx
import {execFile} from "node:child_process"
import {readFile, rm} from "node:fs/promises"
import {join} from "node:path"
import {promisify} from "node:util"

const execFileAsync = promisify(execFile)

const ROOT_AUTOLINKING_DIR = "android/build/generated/autolinking"
const APP_AUTOLINKING_DIR = "android/app/build/generated/autolinking"
const CACHED_GRAPH_PATH = join(ROOT_AUTOLINKING_DIR, "autolinking.json")
const ENTRY_POINT_PATH = join(
  APP_AUTOLINKING_DIR,
  "src/main/java/com/facebook/react/ReactNativeApplicationEntryPoint.java",
)
const PACKAGE_LIST_PATH = join(APP_AUTOLINKING_DIR, "src/main/java/com/facebook/react/PackageList.java")
const RESOLVE_TIMEOUT_MS = 30_000

/**
 * Delete the React Native Gradle plugin's cached autolinking config so it is
 * regenerated on the next Gradle run.
 *
 * Why: the plugin caches `android/build/generated/autolinking/autolinking.json`
 * (including `project.android.packageName`, which it bakes into the generated
 * ReactNativeApplicationEntryPoint.java) and only re-runs the resolver when
 * yarn.lock / package-lock.json / package.json / react-native.config.js
 * change. This repo uses bun.lock, which is NOT on that list, so a stale or
 * wrong packageName (e.g. "com.mentra" instead of "com.mentra.mentra")
 * survives indefinitely and breaks :app:compileReleaseJavaWithJavac with
 * "cannot find symbol: class BuildConfig". Regenerating costs a few seconds,
 * a poisoned cache costs a 4-minute failed build.
 */
export async function clearAutolinkingCache() {
  await rm(ROOT_AUTOLINKING_DIR, {recursive: true, force: true})
  await rm(APP_AUTOLINKING_DIR, {recursive: true, force: true})
}

/**
 * Normalize the resolved autolinking graph so key insertion order cannot hide
 * a workspace-module android config change.
 */
export function normalizeAutolinkingGraph(config) {
  return JSON.stringify({
    packageName: config?.project?.android?.packageName || null,
    reactNativePath: config?.reactNativePath ?? null,
    dependencies: Object.entries(config?.dependencies ?? {})
      .map(([name, dep]) => [name, dep?.root ?? null, dep?.platforms?.android ?? null])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  })
}

export function evaluateAutolinkingCache({
  cached,
  resolved,
  resolveError,
  forceWipe = false,
  entryPointSource,
  packageListExists = false,
} = {}) {
  if (forceWipe) return {wiped: true, reason: "force"}
  if (!cached) return {wiped: false, reason: "nothing-cached"}
  if (resolveError) return {wiped: true, reason: "unresolved"}
  const packageName = resolved?.project?.android?.packageName
  if (typeof packageName !== "string" || packageName.length === 0) {
    return {wiped: true, reason: "unresolved"}
  }
  const cachedPackageName = cached?.project?.android?.packageName
  if (packageName !== cachedPackageName) {
    return {wiped: true, reason: "packageName"}
  }
  if (normalizeAutolinkingGraph(resolved) !== normalizeAutolinkingGraph(cached)) {
    return {wiped: true, reason: "graph"}
  }
  if (typeof entryPointSource !== "string" || !entryPointSource.includes(`${packageName}.BuildConfig`)) {
    return {wiped: true, reason: "entry-point"}
  }
  if (!packageListExists) {
    return {wiped: true, reason: "package-list"}
  }
  return {wiped: false, reason: "clean"}
}

export async function resolveAutolinkingGraph({
  cwd = process.cwd(),
  timeoutMs = RESOLVE_TIMEOUT_MS,
  execFileImpl = execFileAsync,
} = {}) {
  const bin = join(cwd, "node_modules/expo-modules-autolinking/bin/expo-modules-autolinking.js")
  const {stdout} = await execFileImpl("node", [bin, "react-native-config", "--json", "--platform", "android"], {
    cwd,
    timeout: timeoutMs,
    maxBuffer: 20 * 1024 * 1024,
    env: {...process.env, FORCE_COLOR: "0", NO_COLOR: "1"},
  })
  return JSON.parse(stdout)
}

async function readJsonIfPresent(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"))
  } catch {
    return null
  }
}

async function readTextIfPresent(path) {
  try {
    return await readFile(path, "utf8")
  } catch {
    return null
  }
}

/**
 * Wipe the RN autolinking cache only when the resolved graph no longer matches
 * the cached artifact, or when generated sources look poisoned.
 */
export async function syncAutolinkingCache({
  cwd = process.cwd(),
  env = process.env,
  resolve = resolveAutolinkingGraph,
  log = console.log,
} = {}) {
  const forceWipe = Boolean(env.MENTRA_FORCE_AUTOLINK_WIPE)
  const cached = await readJsonIfPresent(join(cwd, CACHED_GRAPH_PATH))
  let resolved = null
  let resolveError = null
  if (cached || forceWipe) {
    try {
      resolved = await resolve({cwd})
    } catch (error) {
      resolveError = error
    }
  }
  const entryPointSource = await readTextIfPresent(join(cwd, ENTRY_POINT_PATH))
  const packageListExists = (await readTextIfPresent(join(cwd, PACKAGE_LIST_PATH))) != null
  const decision = evaluateAutolinkingCache({
    cached,
    resolved,
    resolveError,
    forceWipe,
    entryPointSource,
    packageListExists,
  })
  if (decision.wiped) {
    await rm(join(cwd, ROOT_AUTOLINKING_DIR), {recursive: true, force: true})
    await rm(join(cwd, APP_AUTOLINKING_DIR), {recursive: true, force: true})
  }
  log(`[autolinking-guard] ${decision.wiped ? "wiped" : "kept"} (${decision.reason})`)
  return decision
}
