#!/usr/bin/env bun
import {createHash} from "node:crypto"
import {execFileSync} from "node:child_process"
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import {homedir} from "node:os"
import path from "node:path"
import {fileURLToPath} from "node:url"
import {parseArgs} from "node:util"

const scripts = path.dirname(fileURLToPath(import.meta.url))
const owner = "mentra-ios-mac-v1"
const command = (name, args, options = {}) =>
  execFileSync(name, args, {encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 180_000, ...options}).trim()
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

function validateLauncherOptions(launcherPath, launcherSha256) {
  if (launcherPath === undefined && launcherSha256 === undefined) return
  if (typeof launcherPath !== "string" || typeof launcherSha256 !== "string")
    throw new Error("Provide --launcher and --launcher-sha256 together")
  if (!path.isAbsolute(launcherPath) || path.normalize(launcherPath) !== launcherPath)
    throw new Error("Preinstalled launcher requires an absolute canonical path")
  if (!/^[a-fA-F0-9]{64}$/.test(launcherSha256)) throw new Error("Invalid preinstalled launcher SHA256")
}

export async function verifyLauncherOverride(launcherPath, launcherSha256) {
  validateLauncherOptions(launcherPath, launcherSha256)
  if (launcherPath === undefined) return undefined
  const info = await lstat(launcherPath)
  if (!info.isFile() || info.isSymbolicLink() || (await realpath(launcherPath)) !== launcherPath)
    throw new Error("Preinstalled launcher must be a regular file at its canonical path, without symlinks")
  const sha256 = await hash(launcherPath)
  if (sha256 !== launcherSha256.toLowerCase()) throw new Error("Preinstalled launcher SHA256 mismatch")
  return {source: "preinstalled", path: launcherPath, sha256}
}

export function parseInstallerArgs(args) {
  const {values} = parseArgs({
    args,
    options: {
      "manifest": {type: "string"},
      "launcher": {type: "string"},
      "launcher-sha256": {type: "string"},
      "no-launch": {type: "boolean"},
    },
  })
  if (!values.manifest)
    throw new Error(
      "Usage: bun scripts/install-ios-mac.mjs --manifest PATH [--launcher PATH --launcher-sha256 HEX] [--no-launch]",
    )
  validateLauncherOptions(values.launcher, values["launcher-sha256"])
  return {
    manifestPath: path.resolve(values.manifest),
    launch: !values["no-launch"],
    launcherPath: values.launcher,
    launcherSha256: values["launcher-sha256"],
  }
}

export function isPortableMacPackage(manifest) {
  const version = manifest.macPackageVersion
  if (version !== undefined && version !== 1 && version !== 2) throw new Error("Unsupported Mac package version")
  if (version === 2) {
    if (
      manifest.app !== "Mentra.app" ||
      manifest.macInstaller !== "Install Mentra.app" ||
      "launcherPath" in manifest ||
      "launcherSha256" in manifest
    )
      throw new Error("Invalid native installer package layout")
    return true
  }
  return Boolean(manifest.launcherPath)
}

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
  // Portable PR downloads must not require Xcode on the receiving Mac.
  const executableUUID = isPortableMacPackage(manifest)
    ? undefined
    : command("/usr/bin/xcrun", ["dwarfdump", "--uuid", path.join(app, executable)])
  if (executableUUID !== undefined && !/^UUID: [A-F0-9-]+ /im.test(executableUUID))
    throw new Error("The executable has no Mach-O UUID")
  return {codeRequirement, ...(executableUUID === undefined ? {} : {executableUUID})}
}

export function validateMacProvisioning(profile, deviceId, now = Date.now()) {
  if (!Number.isFinite(Date.parse(profile.ExpirationDate)) || Date.parse(profile.ExpirationDate) <= now)
    throw new Error("The app provisioning profile has expired; download a fresh PR build")
  if (!deviceId || !profile.ProvisionedDevices?.includes(deviceId))
    throw new Error(
      "This Mac is not in the app provisioning profile. Register its provisioning UDID and re-export the PR build",
    )
}

function verifyMacProvisioning(app) {
  const xml = command("/usr/bin/security", ["cms", "-D", "-i", path.join(app, "embedded.mobileprovision")])
  const profile = {
    ExpirationDate: command("/usr/bin/plutil", ["-extract", "ExpirationDate", "raw", "-o", "-", "--", "-"], {
      input: xml,
    }),
    ProvisionedDevices: JSON.parse(
      command("/usr/bin/plutil", ["-extract", "ProvisionedDevices", "json", "-o", "-", "--", "-"], {input: xml}),
    ),
  }
  const hardware = JSON.parse(command("/usr/sbin/system_profiler", ["SPHardwareDataType", "-json"]))
  validateMacProvisioning(profile, hardware.SPHardwareDataType?.[0]?.provisioning_UDID)
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

export class InstallationRollbackError extends AggregateError {}

/** Commit an already verified wrapper and its staged manifest as one recoverable replacement. */
export async function commitStagedInstallation({root, staging, lock}, move = rename) {
  const destination = path.join(root, "Mentra.app")
  const wrapper = path.join(staging, "Mentra.app")
  const previous = path.join(lock, "previous.app")
  let movedPrevious = false
  let movedNew = false
  try {
    if (await exists(destination)) {
      await move(destination, previous)
      movedPrevious = true
    }
    await move(wrapper, destination)
    movedNew = true
    await move(path.join(staging, "installed-build.json"), path.join(root, "installed-build.json"))
  } catch (error) {
    try {
      if (movedNew) await move(destination, wrapper)
      if (movedPrevious) await move(previous, destination)
    } catch (rollbackError) {
      throw new InstallationRollbackError(
        [error, rollbackError],
        "Installation rollback failed; recovery files retained",
      )
    }
    throw error
  }
}

export async function installBuild(manifestPath, {launch = true, launcherPath, launcherSha256} = {}) {
  if (process.platform !== "darwin") throw new Error("Requires macOS")
  const preinstalledLauncher = await verifyLauncherOverride(launcherPath, launcherSha256)
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"))
  if (!manifest.bundleId || !manifest.executableSha256) throw new Error("Invalid build manifest")
  const portablePackage = isPortableMacPackage(manifest)
  if (manifest.macPackageVersion === 2 && !preinstalledLauncher)
    throw new Error(
      "For this Mac ZIP, open Install Mentra.app, or provide --launcher and --launcher-sha256 from host provisioning",
    )
  const root = installationRoot()
  const destination = path.join(root, "Mentra.app")
  await claimInstallation(root, manifest.bundleId)
  const lock = path.join(root, ".install-lock")
  await mkdir(lock) // A second installer fails rather than racing the replacement.
  let staging
  let installedNew = false
  let preserveRecovery = false
  const previous = path.join(lock, "previous.app")
  try {
    staging = await mkdtemp(path.join(root, ".staging-"))
    let source = path.resolve(path.dirname(manifestPath), manifest.app)
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
    if (portablePackage) verifyMacProvisioning(source)
    const wrapper = path.join(staging, "Mentra.app")
    const inner = path.join(wrapper, "Wrapper", "Mentra.app")
    await mkdir(path.dirname(inner), {recursive: true})
    command("/bin/cp", ["-cR", source, inner])
    await symlink("Wrapper/Mentra.app", path.join(wrapper, "WrappedBundle"))
    const identity = await verifyApp(inner, manifest)
    const launcher = preinstalledLauncher
      ? preinstalledLauncher.path
      : manifest.launcherPath
        ? path.resolve(path.dirname(manifestPath), manifest.launcherPath)
        : path.join(staging, "launch-ios-on-mac")
    if (!preinstalledLauncher && manifest.launcherPath) {
      if (
        path.basename(manifest.launcherPath) !== manifest.launcherPath ||
        (await hash(launcher)) !== manifest.launcherSha256
      )
        throw new Error("Bundled launcher path or hash mismatch")
    } else if (!preinstalledLauncher)
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
    const installationLauncher = preinstalledLauncher ?? {
      source: manifest.launcherPath ? "bundled" : "compiled",
      path: launcher,
      sha256: await hash(launcher),
    }
    const installed = {
      ...manifest,
      ...identity,
      installationLauncher,
      launchPath: destination,
      installedAt: new Date().toISOString(),
    }
    await writeFile(path.join(staging, "installed-build.json"), JSON.stringify(installed, null, 2) + "\n")
    await verifyLauncherOverride(launcherPath, launcherSha256)
    command(launcher, ["--quit", wrapper])
    await commitStagedInstallation({root, staging, lock})
    installedNew = true
    if (launch) {
      await verifyLauncherOverride(launcherPath, launcherSha256)
      console.log(command(launcher, [destination]))
    }
    console.log(`Installed app: ${destination}\nInstalled evidence: ${path.join(root, "installed-build.json")}`)
    return installed
  } catch (error) {
    // Roll back a failed filesystem replacement. If launching the verified new
    // app times out on a permission prompt, leave it installed for the user.
    preserveRecovery = error instanceof InstallationRollbackError
    throw error
  } finally {
    if (!preserveRecovery) {
      if (staging) await rm(staging, {recursive: true, force: true})
      if (installedNew || !(await exists(previous))) await rm(lock, {recursive: true, force: true})
    }
  }
}

if (import.meta.main) {
  const {manifestPath, ...options} = parseInstallerArgs(process.argv.slice(2))
  await installBuild(manifestPath, options)
}
