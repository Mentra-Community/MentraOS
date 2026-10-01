#!/usr/bin/env bun
// Serve a packed miniapp and ask the running Mentra App to install and open it.
import {spawnSync} from "node:child_process"
import {resolve} from "node:path"
import {randomUUID} from "node:crypto"

const [zip, target, serial] = process.argv.slice(2)
if (!zip || !["--mac", "--android"].includes(target) || (target === "--android" && !serial)) {
  console.error("Usage: bun scripts/load-authoring-miniapp.mjs <packed.zip> --mac | --android <phone-serial>")
  process.exit(1)
}
const archive = Bun.file(resolve(zip))
if (!(await archive.exists())) throw new Error("Packed miniapp ZIP not found")
const manifestRead = spawnSync("unzip", ["-p", archive.name, "miniapp.json"], {encoding: "utf8"})
if (manifestRead.status !== 0) throw new Error("ZIP must contain miniapp.json at its root")
const {packageName, version} = JSON.parse(manifestRead.stdout)
if (typeof packageName !== "string" || typeof version !== "string")
  throw new Error("Manifest requires packageName and version")
const token = randomUUID(),
  path = `/${token}/bundle.zip`
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    return new URL(request.url).pathname === path
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
  const query = new URLSearchParams({url: `http://127.0.0.1:${server.port}${path}`, package: packageName, version})
  const link = `com.mentra://test/load-miniapp?${query}`
  if (target === "--mac") run("open", [link])
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
      "com.mentra.mentra",
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
