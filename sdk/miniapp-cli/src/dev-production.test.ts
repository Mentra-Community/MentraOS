/// <reference types="bun-types" />

import {afterEach, describe, expect, test} from "bun:test"
import {spawnSync} from "node:child_process"
import {createHash} from "node:crypto"
import {existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs"
import {tmpdir} from "node:os"
import {join} from "node:path"
import JSZip from "jszip"
import {normalizeMiniappUrl, ServedMiniappManifestSchema} from "../../../cloud-v2/packages/protocol/src/miniapp-url"

const CLI = new URL("./index.ts", import.meta.url).pathname

const MANIFEST = {
  packageName: "com.example.production",
  version: "2.3.4",
  name: "Production Test",
  icon: "icon.png",
  entry: {background: "background/index.js", ui: "ui/index.html"},
  permissions: [],
  hardwareRequirements: [],
}

const roots: string[] = []
const running: Array<ReturnType<typeof Bun.spawn>> = []
afterEach(async () => {
  for (const child of running.splice(0)) {
    child.kill("SIGKILL")
    await child.exited
  }
  for (const root of roots.splice(0)) rmSync(root, {recursive: true, force: true})
})

/** A project whose build writes the mode it was built in into both layers. */
function project(): string {
  const root = mkdtempSync(join(tmpdir(), "mentra-dev-production-"))
  roots.push(root)
  writeFileSync(join(root, "miniapp.json"), JSON.stringify(MANIFEST))
  writeFileSync(join(root, "icon.png"), "png bytes")
  writeFileSync(join(root, "package.json"), JSON.stringify({name: "fixture", scripts: {build: "bun build.ts"}}))
  // Its lockfile makes Bun the package manager the production build runs.
  writeFileSync(join(root, "bun.lock"), "")
  writeFileSync(
    join(root, "build.ts"),
    `import {mkdirSync, writeFileSync} from "node:fs"
     mkdirSync("dist/background", {recursive: true})
     mkdirSync("dist/ui", {recursive: true})
     writeFileSync("dist/background/index.js", "export const mode = " + JSON.stringify(process.env.NODE_ENV ?? "none"))
     writeFileSync("dist/ui/index.html", "<!doctype html>")
    `,
  )
  return root
}

/** Run the CLI in `cwd` until it prints its miniapp URL; the server is then at that URL's port, on loopback too. */
async function serve(cwd: string, args: string[]) {
  const port = 20_000 + Math.floor(Math.random() * 20_000)
  const child = Bun.spawn([process.execPath, CLI, ...args, "--qr-output", join(cwd, "qr.png")], {
    cwd,
    env: {...process.env, MENTRA_MINIAPP_DEV_PORT: String(port), NODE_ENV: "test"},
    stdout: "pipe",
    stderr: "pipe",
  })
  running.push(child)
  let output = ""
  const read = async (stream: ReadableStream<Uint8Array>) => {
    for await (const chunk of stream) output += new TextDecoder().decode(chunk)
  }
  void read(child.stdout as ReadableStream<Uint8Array>)
  void read(child.stderr as ReadableStream<Uint8Array>)
  const deadline = Date.now() + 30_000
  let printed: string | undefined
  while (!(printed = /Miniapp URL: (http:\/\/\S+)/.exec(output)?.[1])) {
    if (child.exitCode !== null || Date.now() > deadline) throw new Error(`The CLI printed no miniapp URL:\n${output}`)
    await Bun.sleep(50)
  }
  const served = new URL(printed)
  return {child, printed, base: `http://127.0.0.1:${served.port}/`, port: Number(served.port), output: () => output}
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")

describe("mentra-miniapp dev --production", () => {
  test("builds the production bundle and serves it as a miniapp URL, without a phone", async () => {
    const cwd = project()
    const {child, printed, base, port, output} = await serve(cwd, ["dev", "--production"])

    // What it prints for a phone to scan is what `dev` prints: the plain local-network miniapp URL.
    expect(normalizeMiniappUrl(printed)?.kind).toBe("local")
    expect(output()).not.toContain("miniapp://")
    expect(existsSync(join(cwd, "qr.png"))).toBe(true)

    const response = await fetch(`${base}miniapp.json`)
    expect(response.headers.get("cache-control")).toBe("no-store")
    const served = (await response.json()) as Record<string, any>
    expect(ServedMiniappManifestSchema.safeParse(served).success).toBe(true)
    expect(served.bundle.url).toBe(`com.example.production-2.3.4-${served.bundle.sha256.slice(0, 8)}.zip`)
    expect(served).not.toHaveProperty("versions")
    expect(served.development.reload).toBe(`ws://127.0.0.1:${port + 1}/__mentra_dev`)

    // The ZIP it names has that hash, and holds the packed miniapp.json and a production build.
    const bytes = new Uint8Array(await (await fetch(new URL(served.bundle.url, base))).arrayBuffer())
    expect(sha256(bytes)).toBe(served.bundle.sha256)
    const zip = await JSZip.loadAsync(bytes)
    expect(JSON.parse(await zip.file("miniapp.json")!.async("string"))).toEqual(MANIFEST)
    expect(await zip.file("background/index.js")!.async("string")).toBe('export const mode = "production"')
    expect(await zip.file("icon.png")!.async("string")).toBe("png bytes")
    expect(zip.file("META-INF/MENTRA.SIG")).toBeNull()

    // The paths released Mentra Apps ask for serve the same ZIP, on both servers.
    for (const legacy of [`${base}bundle.zip`, `http://127.0.0.1:${port + 1}/__mentra_dev/bundle.zip`]) {
      expect(sha256(new Uint8Array(await (await fetch(legacy)).arrayBuffer()))).toBe(served.bundle.sha256)
    }
    expect(await (await fetch(`${base}icon.png`)).text()).toBe("png bytes")
    expect((await fetch(`${base}dist/ui/index.html`)).status).toBe(404)

    // Nothing is watched: a save neither rebuilds nor changes what is served.
    writeFileSync(join(cwd, "build.ts"), "throw new Error('must not rebuild')")
    await Bun.sleep(1_000)
    expect(((await (await fetch(`${base}miniapp.json`)).json()) as Record<string, any>).bundle).toEqual(served.bundle)
    expect(output()).not.toContain("must not rebuild")

    // It writes no build/ folder, so it lists no version a later `pack` would keep.
    expect(existsSync(join(cwd, "build"))).toBe(false)

    child.kill("SIGTERM")
    expect(await child.exited).toBe(0)
    expect(existsSync(join(cwd, "qr.png"))).toBe(true)
  }, 60_000)

  test("signing fails without a key before anything is built or served", () => {
    const cwd = project()
    const runner = join(cwd, "check.ts")
    writeFileSync(
      runner,
      `
      import {writeFileSync} from "node:fs";
      import {dev} from ${JSON.stringify(new URL("./dev.ts", import.meta.url).pathname)};
      Object.defineProperty(Bun, "secrets", {value: {get: async () => null}});
      Object.defineProperty(Bun, "serve", {value: () => {throw new Error("must not serve an unsigned build")}});
      try { await dev({production: true, sign: true}); }
      catch (error) { writeFileSync(${JSON.stringify(join(cwd, "error.txt"))}, String(error)); }
    `,
    )
    const result = spawnSync(process.execPath, [runner], {
      cwd,
      timeout: 20_000,
      encoding: "utf8",
      env: {
        ...process.env,
        MENTRA_CLI_HOME: join(cwd, "keys"),
        MENTRA_MINIAPP_SIGNING_KEY_FILE: "",
        MENTRA_MINIAPP_SIGNING_KEY_JSON: "",
      },
    })
    expect(result.status).toBe(0)
    expect(readFileSync(join(cwd, "error.txt"), "utf8")).toContain("No publisher signing key exists")
    expect(existsSync(join(cwd, "dist"))).toBe(false)
  })
})

describe("mentra-miniapp release", () => {
  test("says it is now dev --production, and serves the production bundle the same way", async () => {
    const cwd = project()
    // --no-cache is a flag scripts already pass: it still runs.
    const {child, printed, base, output} = await serve(cwd, ["release", "--no-cache"])

    expect(output().split("\n")[0]).toBe("mentra-miniapp release is now mentra-miniapp dev --production.")
    expect(normalizeMiniappUrl(printed)?.kind).toBe("local")
    expect(output()).not.toContain("miniapp://release")

    const served = (await (await fetch(`${base}miniapp.json`)).json()) as Record<string, any>
    expect(ServedMiniappManifestSchema.safeParse(served).success).toBe(true)
    const bytes = new Uint8Array(await (await fetch(new URL(served.bundle.url, base))).arrayBuffer())
    expect(sha256(bytes)).toBe(served.bundle.sha256)
    const zip = await JSZip.loadAsync(bytes)
    expect(await zip.file("background/index.js")!.async("string")).toBe('export const mode = "production"')

    child.kill("SIGTERM")
    expect(await child.exited).toBe(0)
  }, 60_000)
})
