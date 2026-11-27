#!/usr/bin/env bun
// Serve a packed miniapp at a miniapp URL on this computer and ask the running Mentra App to install and open it.
// The app installs it as a development build from that address, as it installs what `mentra dev` serves.
import {spawnSync} from "node:child_process"
import {createHash, randomUUID} from "node:crypto"
import {resolve} from "node:path"

const [zip, target, serial] = process.argv.slice(2)
if (!zip || !["--mac", "--android"].includes(target) || (target === "--android" && !serial)) {
  console.error("Usage: bun scripts/load-authoring-miniapp.mjs <packed.zip> --mac | --android <phone-serial>")
  process.exit(1)
}
const hostPackage = process.env.MENTRA_HOST_PACKAGE || "com.mentra.mentra"
if (!/^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+$/.test(hostPackage)) throw new Error("Invalid MENTRA_HOST_PACKAGE")
const macApp = process.env.MENTRA_MAC_APP
if (target === "--mac" && (!macApp || !macApp.startsWith("/") || !macApp.endsWith(".app")))
  throw new Error("Set MENTRA_MAC_APP to the exact installed Mentra .app path")
const archive = Bun.file(resolve(zip))
if (!(await archive.exists())) throw new Error("Packed miniapp ZIP not found")
const manifestRead = spawnSync("unzip", ["-p", archive.name, "miniapp.json"], {encoding: "utf8"})
if (manifestRead.status !== 0) throw new Error("ZIP must contain miniapp.json at its root")
const manifest = JSON.parse(manifestRead.stdout)
const {packageName, version} = manifest
if (typeof packageName !== "string" || typeof version !== "string")
  throw new Error("Manifest requires packageName and version")
const sha256 = createHash("sha256")
  .update(new Uint8Array(await archive.arrayBuffer()))
  .digest("hex")
// The miniapp URL serves the ZIP's own manifest, naming the ZIP and its hash, as `mentra pack` writes it.
const token = randomUUID(),
  base = `/${token}/`,
  zipName = `${packageName}-${version}-${sha256.slice(0, 8)}.zip`
const served = JSON.stringify({...manifest, bundle: {url: zipName, sha256}})
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    const path = new URL(request.url).pathname
    if (path === base || path === `${base}miniapp.json`) {
      return new Response(served, {headers: {"Content-Type": "application/json", "Cache-Control": "no-store"}})
    }
    return path === `${base}${zipName}`
      ? new Response(archive, {headers: {"Content-Type": "application/zip"}})
      : new Response("Not found", {status: 404})
  },
})
const run = (command, args) => {
  const result = spawnSync(command, args, {stdio: "inherit"})
  if (result.status !== 0) throw new Error(`${command} failed`)
}
let reversed = false
const close = () => {
  server.stop(true)
  if (reversed) spawnSync("adb", ["-s", serial, "reverse", "--remove", `tcp:${server.port}`], {stdio: "inherit"})
}
try {
  if (target === "--android") {
    run("adb", ["-s", serial, "reverse", `tcp:${server.port}`, `tcp:${server.port}`])
    reversed = true
  }
  const query = new URLSearchParams({url: `http://127.0.0.1:${server.port}${base}`})
  const link = `com.mentra://test/load-miniapp?${query}`
  if (target === "--mac") run("open", ["-a", macApp, link])
  else
    run("adb", [
      "-s",
      serial,
      "shell",
      "am",
      "start",
      "-a",
      "android.intent.action.VIEW",
      "-d",
      `'${link}'`,
      "-p",
      hostPackage,
    ])
  console.log(
    `Requested ${packageName}@${version}. Leave this server running until the miniapp opens; Ctrl+C removes it and its USB tunnel.`,
  )
  console.log(
    "App logs report MINIAPP_LOAD_RESULT with opened or failed. Sending the URL alone is not proof of installation.",
  )
  process.on("SIGINT", () => {
    close()
    process.exit(0)
  })
  process.on("SIGTERM", () => {
    close()
    process.exit(0)
  })
} catch (error) {
  close()
  throw error
}
