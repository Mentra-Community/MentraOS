import {spawn} from "node:child_process"
import {createHash} from "node:crypto"
import {mkdtemp, readdir, readFile, rm, writeFile} from "node:fs/promises"
import {homedir, tmpdir} from "node:os"
import path from "node:path"
import {fileURLToPath} from "node:url"

/**
 * CocoaPods clones React Native's third-party C++ deps (RCT-Folly, boost, …)
 * from GitHub with `git clone --depth 1`. That smart-HTTP path routinely dies
 * mid-transfer (`curl 56`, `early EOF`) on flaky or HTTP/2-hostile links.
 *
 * Before `pod install` we download the same tagged trees as GitHub tarballs
 * (curl/fetch retries + resume) into local git mirrors, then rewrite those
 * clone URLs to `file://` for the CocoaPods git subprocess only.
 */

export const DEFAULT_RN_GIT_PODS = [
  {name: "folly", git: "https://github.com/facebook/folly.git", tag: "v2024.11.18.00"},
  {
    name: "boost-for-react-native",
    git: "https://github.com/react-native-community/boost-for-react-native",
    tag: "v1.84.0",
  },
  {name: "glog", git: "https://github.com/google/glog.git", tag: "v0.3.5"},
  {name: "fmt", git: "https://github.com/fmtlib/fmt.git", tag: "12.1.0"},
  {name: "fast_float", git: "https://github.com/fastfloat/fast_float.git", tag: "v8.0.0"},
  {
    name: "double-conversion",
    git: "https://github.com/google/double-conversion.git",
    tag: "v1.1.6",
  },
]

const MIRROR_MARKER = ".mentra-mirror-ready"

export function defaultMirrorCacheDir() {
  return path.join(homedir(), "Library", "Caches", "mentra-cocoapods-mirrors")
}

export function githubArchiveUrl(gitUrl, tag) {
  const repo = String(gitUrl)
    .trim()
    .replace(/\.git$/i, "")
    .replace(/\/$/, "")
  return `${repo}/archive/refs/tags/${encodeURIComponent(tag)}.tar.gz`
}

export function gitUrlVariants(gitUrl) {
  const normalized = String(gitUrl).trim().replace(/\/$/, "")
  const withoutGit = normalized.replace(/\.git$/i, "")
  return [...new Set([normalized, withoutGit, `${withoutGit}.git`])]
}

export function fileUrlForPath(absPath) {
  const resolved = path.resolve(absPath)
  return `file://${resolved}`
}

export function gitInsteadOfPairs(gitUrl, localRepoPath) {
  const fileUrl = fileUrlForPath(localRepoPath)
  return gitUrlVariants(gitUrl).map((from) => ({
    key: `url.${fileUrl}.insteadOf`,
    value: from,
  }))
}

export function buildPodInstallEnv({mirrors = [], env = process.env} = {}) {
  const pairs = [
    {key: "http.version", value: "HTTP/1.1"},
    {key: "http.postBuffer", value: "524288000"},
    {key: "http.lowSpeedLimit", value: "0"},
    {key: "http.lowSpeedTime", value: "999999"},
  ]
  for (const mirror of mirrors) {
    pairs.push(...gitInsteadOfPairs(mirror.git, mirror.localPath))
  }

  const next = {
    ...env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: String(pairs.length),
  }
  for (const [index, pair] of pairs.entries()) {
    next[`GIT_CONFIG_KEY_${index}`] = pair.key
    next[`GIT_CONFIG_VALUE_${index}`] = pair.value
  }
  return next
}

export function isTransientPodInstallError(err) {
  const haystack = [err?.message, err?.stderr, err?.stdout, err?.shortMessage]
    .filter(Boolean)
    .join("\n")
  return /RPC failed|early EOF|Operation timed out|Recv failure|fetch-pack|HTTP\/2|Connection reset|Could not resolve host|SSL_ERROR|unable to access|Error installing (RCT-Folly|boost|glog|fmt|fast_float|DoubleConversion)/i.test(
    haystack,
  )
}

export function reactNativeThirdPartyDir(fromDir = process.cwd()) {
  return path.join(fromDir, "node_modules", "react-native", "third-party-podspecs")
}

/**
 * Drift check against the RN 0.83 podspecs / helpers currently installed.
 * Returns missing or mismatched entries so a RN bump fails tests instead of
 * silently cloning an unmirrored repo.
 */
export function collectRnGitPodDrift(pods, {helpersRb, podspecs} = {}) {
  const problems = []
  const corpus = [helpersRb, ...Object.values(podspecs ?? {})].filter(Boolean).join("\n")
  for (const pod of pods) {
    const helpersHit = !helpersRb || helpersRb.includes(pod.git.replace(/\.git$/i, ""))
    const tagHit = corpus.includes(pod.tag) || corpus.includes(pod.tag.replace(/^v/, ""))
    if (!helpersHit) {
      problems.push(`${pod.name}: git URL ${pod.git} not found in helpers.rb`)
    }
    if ((helpersRb || podspecs) && !tagHit) {
      problems.push(`${pod.name}: tag ${pod.tag} not found in RN CocoaPods sources`)
    }
  }
  return problems
}

function spawnCommand(command, args, {cwd, env, stdio = "inherit"} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {cwd, env, stdio})
    let stdout = ""
    let stderr = ""
    if (child.stdout) {
      child.stdout.on("data", (chunk) => {
        stdout += chunk
      })
    }
    if (child.stderr) {
      child.stderr.on("data", (chunk) => {
        stderr += chunk
      })
    }
    child.on("error", reject)
    child.on("exit", (code) => {
      if (code === 0) {
        resolve({stdout, stderr})
        return
      }
      const error = new Error(`${command} ${args.join(" ")} exited ${code}`)
      error.exitCode = code
      error.stdout = stdout
      error.stderr = stderr
      reject(error)
    })
  })
}

async function pathExists(target) {
  try {
    await readFile(target)
    return true
  } catch {
    return false
  }
}

export async function downloadFile(url, dest, {run = spawnCommand, attempts = 5} = {}) {
  let lastError
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await run(
        "curl",
        [
          "-L",
          "--fail",
          "--retry",
          "5",
          "--retry-delay",
          "2",
          "--retry-all-errors",
          "-C",
          "-",
          "--connect-timeout",
          "30",
          "--max-time",
          "600",
          "-o",
          dest,
          url,
        ],
        {stdio: "inherit"},
      )
      return dest
    } catch (error) {
      lastError = error
      if (attempt === attempts) break
      const delay = 2000 * attempt
      console.warn(`Download failed (attempt ${attempt}/${attempts}): ${url}`)
      console.warn(`Retrying in ${Math.round(delay / 1000)}s...`)
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }
  throw lastError
}

async function firstExtractedDir(extractRoot, {run = spawnCommand} = {}) {
  const listing = await run("sh", ["-c", "ls -1"], {cwd: extractRoot, stdio: "pipe"})
  const names = listing.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
  if (names.length !== 1) {
    throw new Error(`Expected one extracted directory in ${extractRoot}, found: ${names.join(", ") || "none"}`)
  }
  return path.join(extractRoot, names[0])
}

export async function materializeGitMirror(pod, destDir, {run = spawnCommand, download = downloadFile} = {}) {
  const markerPath = path.join(destDir, MIRROR_MARKER)
  if (await pathExists(markerPath)) {
    const marker = await readFile(markerPath, "utf8")
    if (marker.trim() === pod.tag) return destDir
  }

  await rm(destDir, {recursive: true, force: true})
  const scratch = await mkdtemp(path.join(tmpdir(), `mentra-pod-mirror-${pod.name}-`))
  try {
    const tarball = path.join(scratch, `${pod.name}.tar.gz`)
    const extractRoot = path.join(scratch, "extract")
    await run("mkdir", ["-p", extractRoot], {stdio: "pipe"})
    console.log(`Prefetching ${pod.name} ${pod.tag} as a GitHub tarball (avoids git clone timeouts)...`)
    await download(githubArchiveUrl(pod.git, pod.tag), tarball, {run})
    await run("tar", ["-xzf", tarball, "-C", extractRoot], {stdio: "inherit"})
    const extracted = await firstExtractedDir(extractRoot, {run})

    const gitEnv = {
      ...process.env,
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "user.email",
      GIT_CONFIG_VALUE_0: "cocoapods-mirror@mentra.local",
      GIT_CONFIG_KEY_1: "user.name",
      GIT_CONFIG_VALUE_1: "Mentra CocoaPods Mirror",
    }
    await run("git", ["init"], {cwd: extracted, env: gitEnv, stdio: "pipe"})
    await run("git", ["add", "-A"], {cwd: extracted, env: gitEnv, stdio: "pipe"})
    await run("git", ["commit", "-m", pod.tag, "--no-verify"], {cwd: extracted, env: gitEnv, stdio: "pipe"})
    await run("git", ["tag", pod.tag], {cwd: extracted, env: gitEnv, stdio: "pipe"})

    await run("mkdir", ["-p", path.dirname(destDir)], {stdio: "pipe"})
    await run("mv", [extracted, destDir], {stdio: "pipe"})
    await writeFile(markerPath, `${pod.tag}\n`)
    return destDir
  } finally {
    await rm(scratch, {recursive: true, force: true})
  }
}

export async function prefetchRnGitPods(
  pods = DEFAULT_RN_GIT_PODS,
  {cacheDir = defaultMirrorCacheDir(), run = spawnCommand, download = downloadFile} = {},
) {
  const mirrors = []
  for (const pod of pods) {
    const localPath = path.join(cacheDir, `${pod.name}-${pod.tag}`)
    try {
      await materializeGitMirror(pod, localPath, {run, download})
      mirrors.push({...pod, localPath})
    } catch (error) {
      console.warn(`Could not prefetch ${pod.name} ${pod.tag}: ${error?.message ?? error}`)
      console.warn("pod install will fall back to cloning this repo from GitHub.")
    }
  }
  return mirrors
}

export async function runPodInstall({
  cwd = "ios",
  extraArgs = [],
  env = process.env,
  cacheDir,
  pods = DEFAULT_RN_GIT_PODS,
  attempts = 3,
  baseDelayMs = 3000,
  run = spawnCommand,
  prefetch = prefetchRnGitPods,
} = {}) {
  const mirrors = await prefetch(pods, {cacheDir, run})
  const podEnv = buildPodInstallEnv({mirrors, env})
  let lastError
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      console.log(`Installing CocoaPods dependencies${attempt > 1 ? ` (retry ${attempt}/${attempts})` : ""}...`)
      await run("pod", ["install", ...extraArgs], {cwd, env: podEnv, stdio: "inherit"})
      return
    } catch (error) {
      lastError = error
      if (attempt === attempts) break
      const delay = baseDelayMs * attempt
      console.warn(`pod install failed (attempt ${attempt}/${attempts}): ${error?.message ?? error}`)
      if (delay > 0) {
        console.warn(`Retrying in ${Math.round(delay / 1000)}s...`)
        await new Promise((resolve) => setTimeout(resolve, delay))
      } else {
        console.warn("Retrying immediately...")
      }
    }
  }
  throw lastError
}

/**
 * `pod install` is not free and not idempotent from Xcode's point of view: it
 * re-copies every public/private header into ios/Pods/Headers, which refreshes
 * ~12k mtimes. Xcode then treats each one as a changed input and recompiles the
 * world — a no-change `bun ios` paid ~35s of pod install plus ~80s of pointless
 * Swift/ObjC recompiles. So only run it when its inputs actually moved.
 */
const POD_STAMP_FILE = ".mentra-pod-install.stamp"

async function readIfExists(target) {
  try {
    return await readFile(target)
  } catch {
    return null
  }
}

/** First-party podspecs only — node_modules podspecs move with bun.lock. */
export async function firstPartyPodspecs(projectRoot) {
  const modulesDir = path.join(projectRoot, "modules")
  let moduleEntries
  try {
    moduleEntries = await readdir(modulesDir, {withFileTypes: true})
  } catch {
    return []
  }
  const found = []
  for (const entry of moduleEntries) {
    if (!entry.isDirectory()) continue
    const iosDir = path.join(modulesDir, entry.name, "ios")
    let files
    try {
      files = await readdir(iosDir)
    } catch {
      continue
    }
    for (const file of files) {
      if (file.endsWith(".podspec")) found.push(path.join(iosDir, file))
    }
  }
  return found.sort()
}

export async function computePodFingerprint({iosDir, projectRoot}) {
  const inputs = [
    path.join(iosDir, "Podfile"),
    path.join(iosDir, "Podfile.lock"),
    path.join(projectRoot, "package.json"),
    path.join(projectRoot, "bun.lock"),
    ...(await firstPartyPodspecs(projectRoot)),
  ]
  const hash = createHash("sha256")
  for (const input of inputs) {
    hash.update(path.relative(projectRoot, input))
    hash.update("\0")
    hash.update((await readIfExists(input)) ?? "<missing>")
    hash.update("\0")
  }
  return hash.digest("hex")
}

/** Why pod install has to run, or null when the Pods tree is already correct. */
export async function podInstallReason({iosDir, projectRoot}) {
  const podsDir = path.join(iosDir, "Pods")
  const manifest = await readIfExists(path.join(podsDir, "Manifest.lock"))
  if (!manifest) return "ios/Pods/Manifest.lock is missing"
  const lock = await readIfExists(path.join(iosDir, "Podfile.lock"))
  if (!lock) return "ios/Podfile.lock is missing"
  if (!lock.equals(manifest)) return "Podfile.lock and Pods/Manifest.lock disagree"
  const stamp = await readIfExists(path.join(podsDir, POD_STAMP_FILE))
  if (!stamp) return "no pod install stamp from a previous run"
  const fingerprint = await computePodFingerprint({iosDir, projectRoot})
  if (`${stamp}`.trim() !== fingerprint) return "Podfile, first-party podspec, or dependency change"
  return null
}

export async function runPodInstallIfNeeded({
  cwd = "ios",
  projectRoot = process.cwd(),
  force = false,
  ...podInstallOptions
} = {}) {
  const iosDir = path.resolve(projectRoot, cwd)
  const reason = force ? "MENTRA_POD_INSTALL=force" : await podInstallReason({iosDir, projectRoot})
  if (!reason) {
    console.log("CocoaPods already in sync — skipping pod install (saves ~2 min of needless recompiling).")
    console.log("Force it with MENTRA_POD_INSTALL=force.")
    return {skipped: true}
  }
  console.log(`Running pod install: ${reason}.`)
  await runPodInstall({cwd, ...podInstallOptions})
  await writeFile(path.join(iosDir, "Pods", POD_STAMP_FILE), `${await computePodFingerprint({iosDir, projectRoot})}\n`)
  return {skipped: false, reason}
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isDirectRun) {
  await runPodInstall({
    cwd: process.cwd(),
    extraArgs: process.argv.slice(2),
  })
}
