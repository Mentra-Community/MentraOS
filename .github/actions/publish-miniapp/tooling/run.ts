import {canonicalJson, verifyBundleArchive} from "@mentra/miniapp-cli"
import {createHash} from "node:crypto"
import {readFileSync, writeFileSync} from "node:fs"
import {join, resolve} from "node:path"
import JSZip from "jszip"

export async function canonicalBundle(bytes: Uint8Array, manifest: unknown) {
  const verified = await verifyBundleArchive(bytes)
  if (verified.publisherKeyFingerprint) throw new Error("Store bundles must remain unsigned")
  if (canonicalJson(verified.manifest) !== canonicalJson(manifest)) throw new Error("Bundle manifest differs from source miniapp.json")
  const original = await JSZip.loadAsync(bytes)
  if (original.file("META-INF/MENTRA.SIG")) throw new Error("Store bundles must remain unsigned")
  const zip = new JSZip()
  for (const name of Object.keys(original.files).sort()) {
    const file = original.files[name]!
    if (!file.dir) zip.file(name, await file.async("uint8array"), {date: new Date("1980-01-01T00:00:00Z"), createFolders: false, unixPermissions: 0o100644})
  }
  const packed = await zip.generateAsync({type: "uint8array", platform: "UNIX", compression: "DEFLATE", compressionOptions: {level: 9}})
  await verifyBundleArchive(packed)
  return packed
}

async function main() {
  const vendor = JSON.parse(readFileSync(join(import.meta.dir, "vendor/manifest.json"), "utf8"))
  for (const entry of vendor.packages) {
    if (createHash("sha256").update(readFileSync(join(import.meta.dir, "vendor", entry.archive))).digest("hex") !== entry.sha256) throw new Error(`Pinned tool checksum mismatch: ${entry.name}`)
  }
  const directory = resolve(process.env.MENTRA_DIRECTORY || "miniapp")
  const branch = process.env.MENTRA_PUBLISH_BRANCH || "dev"
  const manifest = JSON.parse(readFileSync(join(directory, "miniapp.json"), "utf8"))
  const {packageName, version} = manifest
  if (!/^com\.mentra\.[a-z0-9.]+$/.test(packageName) || !/^\d+\.\d+\.\d+$/.test(version)) throw new Error("Expected a first-party package and stable MAJOR.MINOR.PATCH version")
  const bundlePath = join(directory, "build", `${packageName}-${version}.zip`)
  const bytes = readFileSync(bundlePath)
  const canonical = await canonicalBundle(bytes, manifest)
  if (process.env.MENTRA_OPERATION === "prepare") {
    writeFileSync(bundlePath, canonical)
    console.log(`Validated unsigned bundle ${packageName}@${version}: ${createHash("sha256").update(canonical).digest("hex")}`)
    return
  }
  if (process.env.MENTRA_OPERATION !== "publish") throw new Error("operation must be prepare or publish")
  if (!process.env.MENTRA_CLI_TOKEN) throw new Error("Missing app-restricted Store publishing key")
  if (!bytes.equals(Buffer.from(canonical))) throw new Error("Publish requires the original canonical artifact from the prepare step")
  if (process.env.GITHUB_ACTIONS === "true") {
    const response = await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/commits/${encodeURIComponent(branch)}`, {headers: {authorization: `Bearer ${process.env.GH_TOKEN}`, accept: "application/vnd.github+json"}})
    if (!response.ok) throw new Error(`Unable to verify current ${branch}: ${response.status}`)
    if ((await response.json() as {sha: string}).sha !== process.env.GITHUB_SHA) {
      console.log(`Skipping Store publication: a newer commit is on ${branch}.`)
      return
    }
  }
  const cliPath = join(import.meta.dir, "node_modules/@mentra/cli/src/index.ts")
  const cli = (args: string[], capture = false) => {
    const result = Bun.spawnSync([process.execPath, cliPath, ...args], {stdout: capture ? "pipe" : "inherit", stderr: "inherit", env: process.env})
    if (result.exitCode !== 0) throw new Error(`Store CLI failed: ${args.slice(0, 2).join(" ")}`)
    return result.stdout?.toString() || ""
  }
  const releases = JSON.parse(cli(["releases", "list", packageName, "--json"], true)).releases
  if (releases.some((r: {version: string; releaseTrack: string; status: string}) => r.version === version && r.releaseTrack === "stable" && r.status === "published")) {
    console.log(`${packageName}@${version} is already published; skipping the Store update.`)
    return
  }
  // Listing, artwork and artwork paths are relative to the miniapp directory.
  cli(["listing", "update", packageName, "--file", join(directory, "store/listing.json")])
  const artwork = JSON.parse(readFileSync(join(directory, "store/artwork.json"), "utf8"))
  for (const asset of artwork) {
    if (!["store_icon", "store_cover", "gallery_screenshot"].includes(asset.role)) throw new Error("Invalid artwork role")
    cli(["listing", "assets", "upload", packageName, join(directory, asset.path), "--role", asset.role, "--skip-existing"])
  }
  cli(["publish", "--cwd", directory, "--no-build", "--no-pack", "--skip-existing", "--publish", "--json"])
}
if (import.meta.main) await main()
