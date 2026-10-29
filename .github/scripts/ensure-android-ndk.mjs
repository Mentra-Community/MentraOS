import {execFileSync} from "node:child_process"
import {readFile, realpath, rm} from "node:fs/promises"
import path from "node:path"
import {pathToFileURL} from "node:url"

/** Repair only an incomplete installation of React Native's selected NDK. */
export async function ensureAndroidNdk({sdkRoot, versionsFile, install = (version, sdk) => execFileSync("sdkmanager", [`--sdk_root=${sdk}`, `ndk;${version}`], {stdio: "inherit"})}) {
  const versions = await readFile(versionsFile, "utf8")
  const matches = [...versions.matchAll(/^ndkVersion = "([0-9]+(?:\.[0-9]+)+)"\s*$/gm)]
  if (matches.length !== 1) throw new Error("React Native must declare one exact Android NDK version")
  const version = matches[0][1], sdk = await realpath(sdkRoot)
  const directory = path.join(sdk, "ndk", version), metadata = path.join(directory, "source.properties")
  const complete = async () => {
    const value = await readFile(metadata, "utf8").catch(error => {if (error.code === "ENOENT") return ""; throw error})
    return value.split(/\r?\n/).some(line => line.replace(/\s/g, "") === `Pkg.Revision=${version}`)
  }
  if (await complete()) return {version, installed: false}
  // A cancelled/partial SDK install can leave a directory that Gradle treats as
  // installed. Gradle cache deletion cannot repair this SDK directory.
  await rm(directory, {recursive: true, force: true})
  await install(version, sdk)
  if (!await complete()) throw new Error(`Android NDK ${version} is still incomplete after sdkmanager`)
  return {version, installed: true}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const sdkRoot = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT
  if (!sdkRoot) throw new Error("ANDROID_HOME is required")
  console.log(JSON.stringify(await ensureAndroidNdk({sdkRoot, versionsFile: "mobile/node_modules/react-native/gradle/libs.versions.toml"})))
}
