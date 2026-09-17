#!/usr/bin/env bun
import {createHash} from "node:crypto"
import {execFileSync} from "node:child_process"
import {access, lstat, mkdir, mkdtemp, readFile, readlink, rename, rm, symlink, writeFile} from "node:fs/promises"
import {homedir} from "node:os"
import path from "node:path"
import {fileURLToPath} from "node:url"

const scripts = path.dirname(fileURLToPath(import.meta.url))
const owner = "mentra-ios-mac-v1"
const command = (name, args) =>
  execFileSync(name, args, {encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 180_000}).trim()
const exists = async (file) =>
  access(file).then(
    () => true,
    () => false,
  )
const hash = async (file) =>
  createHash("sha256")
    .update(await readFile(file))
    .digest("hex")
export const installationRoot = () => path.join(homedir(), "Applications", "Mentra E2E")

async function regularDirectory(directory) {
  const info = await lstat(directory)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Expected a real directory: ${directory}`)
}

export async function verifyApp(app, manifest) {
  await regularDirectory(app)
  const plist = path.join(app, "Info.plist")
  const bundleId = command("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleIdentifier", plist])
  const executable = command("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleExecutable", plist])
  if (bundleId !== manifest.bundleId || path.basename(executable) !== executable)
    throw new Error("App identity mismatch")
  if ((await hash(path.join(app, executable))) !== manifest.executableSha256)
    throw new Error("Executable hash mismatch")
  if (manifest.javascriptSha256 && (await hash(path.join(app, "main.jsbundle"))) !== manifest.javascriptSha256) {
    throw new Error("JavaScript hash mismatch")
  }
  command("/usr/bin/codesign", ["--verify", "--deep", "--strict", app])
  // Require Apple-issued signing rather than ad hoc signing. Preserve the
  // original signature and UUID; permission stability is not a reason to resign.
  command("/usr/bin/codesign", ["--verify", "-R", "=anchor apple generic", app])
  const codeRequirement = command("/usr/bin/codesign", ["-dr", "-", app])
  const executableUUID = command("/usr/bin/xcrun", ["dwarfdump", "--uuid", path.join(app, executable)])
  if (!/^UUID: [A-F0-9-]+ /im.test(executableUUID)) throw new Error("The executable has no Mach-O UUID")
  return {codeRequirement, executableUUID}
}

export async function archiveBuild(app, manifest, directory) {
  const identity = await verifyApp(app, manifest)
  await mkdir(directory, {recursive: true})
  const temporary = await mkdtemp(path.join(directory, ".archive-"))
  try {
    const zip = path.join(temporary, "build.zip")
    command("/usr/bin/ditto", ["-c", "-k", "--keepParent", app, zip])
    command("/usr/bin/unzip", ["-tq", zip])
    const archiveSha256 = await hash(zip)
    const archivePath = path.join(directory, `${archiveSha256}.zip`)
    if (await exists(archivePath)) {
      if ((await hash(archivePath)) !== archiveSha256) throw new Error("Existing build archive is corrupt")
    } else await rename(zip, archivePath)
    return {archivePath, archiveSha256, archivedAppName: path.basename(app), ...identity}
  } finally {
    await rm(temporary, {recursive: true, force: true})
  }
}

// Never replace an ordinary user installation or a directory owned by another
// tool. The marker is outside the signed app and survives build replacement.
export async function claimInstallation(root, bundleId) {
  await mkdir(path.dirname(root), {recursive: true})
  await regularDirectory(path.dirname(root))
  try {
    await mkdir(root, {mode: 0o700})
    await writeFile(path.join(root, "owner.json"), JSON.stringify({owner, bundleId}) + "\n", {flag: "wx", mode: 0o600})
  } catch (error) {
    if (error.code !== "EEXIST") throw error
  }
  await regularDirectory(root)
  const marker = JSON.parse(await readFile(path.join(root, "owner.json"), "utf8"))
  if (marker.owner !== owner || marker.bundleId !== bundleId)
    throw new Error("Installation directory is not owned by this app installer")
}

export async function installBuild(manifestPath, {launch = true} = {}) {
  if (process.platform !== "darwin") throw new Error("Requires macOS")
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"))
  if (!manifest.bundleId || !manifest.executableSha256) throw new Error("Invalid build manifest")
  const root = installationRoot()
  const destination = path.join(root, "Mentra.app")
  await claimInstallation(root, manifest.bundleId)
  const lock = path.join(root, ".install-lock")
  await mkdir(lock) // A second installer fails rather than racing the replacement.
  let staging
  let movedPrevious = false
  let installedNew = false
  const previous = path.join(lock, "previous.app")
  try {
    staging = await mkdtemp(path.join(root, ".staging-"))
    let source = manifest.app
    if (manifest.archivePath) {
      if ((await hash(manifest.archivePath)) !== manifest.archiveSha256) throw new Error("Archive hash mismatch")
      const unpacked = path.join(staging, "unpacked")
      await mkdir(unpacked)
      command("/usr/bin/ditto", ["-x", "-k", manifest.archivePath, unpacked])
      if (!manifest.archivedAppName || path.basename(manifest.archivedAppName) !== manifest.archivedAppName)
        throw new Error("Invalid archived app name")
      source = path.join(unpacked, manifest.archivedAppName)
    }
    await verifyApp(source, manifest)
    const wrapper = path.join(staging, "Mentra.app")
    const inner = path.join(wrapper, "Wrapper", "Mentra.app")
    await mkdir(path.dirname(inner), {recursive: true})
    command("/bin/cp", ["-cR", source, inner])
    await symlink("Wrapper/Mentra.app", path.join(wrapper, "WrappedBundle"))
    const identity = await verifyApp(inner, manifest)
    const launcher = path.join(staging, "launch-ios-on-mac")
    command("/usr/bin/xcrun", [
      "swiftc",
      "-parse-as-library",
      "-O",
      path.join(scripts, "launch-ios-on-mac.swift"),
      "-o",
      launcher,
    ])
    if (await exists(destination)) {
      await regularDirectory(destination)
      if ((await readlink(path.join(destination, "WrappedBundle"))) !== "Wrapper/Mentra.app")
        throw new Error("Installed wrapper target changed; refusing replacement")
      const previousManifest = JSON.parse(await readFile(path.join(root, "installed-build.json"), "utf8"))
      if (previousManifest.bundleId !== manifest.bundleId) throw new Error("Installed app identity changed")
      await verifyApp(path.join(destination, "Wrapper", "Mentra.app"), previousManifest)
      // A recoverable ZIP replaces live duplicate .app backups.
      const backup = path.join(staging, "previous-installation.zip")
      command("/usr/bin/ditto", ["-c", "-k", "--keepParent", destination, backup])
      command("/usr/bin/unzip", ["-tq", backup])
      await rename(backup, path.join(root, "previous-installation.zip"))
    }
    command(launcher, ["--quit", wrapper])
    if (await exists(destination)) {
      await rename(destination, previous)
      movedPrevious = true
    }
    await rename(wrapper, destination)
    installedNew = true
    const installed = {...manifest, ...identity, launchPath: destination, installedAt: new Date().toISOString()}
    await writeFile(path.join(staging, "installed-build.json"), JSON.stringify(installed, null, 2) + "\n")
    await rename(path.join(staging, "installed-build.json"), path.join(root, "installed-build.json"))
    if (launch) console.log(command(launcher, [destination]))
    console.log(`Installed app: ${destination}\nInstalled evidence: ${path.join(root, "installed-build.json")}`)
    return installed
  } catch (error) {
    // Roll back a failed filesystem replacement. If launching the verified new
    // app times out on a permission prompt, leave it installed for the user.
    if (movedPrevious && !installedNew) await rename(previous, destination)
    throw error
  } finally {
    if (staging) await rm(staging, {recursive: true, force: true})
    if (installedNew || !(await exists(previous))) await rm(lock, {recursive: true, force: true})
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  if (args[0] !== "--manifest" || !args[1] || args.slice(2).some((arg) => arg !== "--no-launch")) {
    throw new Error("Usage: bun scripts/install-ios-mac.mjs --manifest PATH [--no-launch]")
  }
  await installBuild(path.resolve(args[1]), {launch: !args.includes("--no-launch")})
}
