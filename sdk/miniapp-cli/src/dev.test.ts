/// <reference types="bun-types" />

import {afterEach, describe, expect, test} from "bun:test"
import {createHash} from "node:crypto"
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from "node:fs"
import {tmpdir} from "node:os"
import {dirname, join} from "node:path"
import JSZip from "jszip"
import {normalizeMiniappUrl, ServedMiniappManifestSchema} from "../../../cloud-v2/packages/protocol/src/miniapp-url"
import {
  buildDevUrl,
  createBuildQueue,
  createDevRequestHandler,
  servedZipName,
  type DevRequestHandlerOptions,
} from "./dev"
import {buildBundle, iconFromArchive, pack} from "./pack"
import {generatePackageSigningKey} from "./package-signing-key"
import {verifySignedBundleArchive} from "./bundle-signing"

const MANIFEST = {
  packageName: "com.example.devtest",
  version: "1.2.3",
  name: "Dev Test",
  icon: "icon.png",
  entry: {background: "background/index.js", ui: "ui/index.html"},
  permissions: [],
  hardwareRequirements: [],
}

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, {recursive: true, force: true})
})

function project(manifest: unknown = MANIFEST): string {
  const root = mkdtempSync(join(tmpdir(), "mentra-dev-url-"))
  roots.push(root)
  write(root, "miniapp.json", typeof manifest === "string" ? manifest : JSON.stringify(manifest))
  write(root, "icon.png", "png bytes")
  write(root, "dist/background/index.js", "console.log('bg')")
  write(root, "dist/ui/index.html", "<!doctype html>")
  return root
}

function write(root: string, rel: string, contents: string): void {
  mkdirSync(dirname(join(root, rel)), {recursive: true})
  writeFileSync(join(root, rel), contents)
}

function handler(cwd: string, overrides: Partial<DevRequestHandlerOptions> = {}) {
  return createDevRequestHandler({cwd, sidecarPort: () => 3001, mdnsHost: "dev-mac.local", ...overrides})
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")

async function fetchServed(serve: (req: Request) => Promise<Response>, url: string) {
  const response = await serve(new Request(new URL("miniapp.json", url)))
  expect(response.status).toBe(200)
  expect(response.headers.get("content-type")).toContain("application/json")
  expect(response.headers.get("cache-control")).toBe("no-store")
  return (await response.json()) as Record<string, any>
}

async function fetchBundle(serve: (req: Request) => Promise<Response>, url: string, bundleUrl: string) {
  const response = await serve(new Request(new URL(bundleUrl, url)))
  expect(response.status).toBe(200)
  expect(response.headers.get("content-type")).toBe("application/zip")
  return new Uint8Array(await response.arrayBuffer())
}

describe("buildDevUrl: the URL the QR encodes and dev prints", () => {
  test("is the dev server's root on the LAN address, a local-network miniapp URL", () => {
    const url = buildDevUrl("192.168.1.20", 3000)
    expect(url).toBe("http://192.168.1.20:3000/")
    expect(normalizeMiniappUrl(url)).toEqual({url, host: "192.168.1.20", kind: "local"})
  })

  test("is loopback over USB", () => {
    const url = buildDevUrl("127.0.0.1", 3004)
    expect(url).toBe("http://127.0.0.1:3004/")
    expect(normalizeMiniappUrl(url)?.kind).toBe("local")
  })

  test("brackets an IPv6 address", () => {
    expect(buildDevUrl("fe80::1", 3000)).toBe("http://[fe80::1]:3000/")
    expect(buildDevUrl("[fd00::2]", 3000)).toBe("http://[fd00::2]:3000/")
  })
})

describe("the dev server's miniapp.json", () => {
  test("is the project's miniapp.json plus bundle and development, and names the ZIP's hash", async () => {
    const serve = handler(project())
    const url = buildDevUrl("192.168.1.20", 3000)
    const served = await fetchServed(serve, url)

    const parsed = ServedMiniappManifestSchema.safeParse(served)
    expect(parsed.success).toBe(true)
    expect(served).toEqual({
      ...MANIFEST,
      bundle: {
        url: expect.stringMatching(/^com\.example\.devtest-1\.2\.3-[0-9a-f]{8}\.zip$/),
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
      development: {reload: "ws://192.168.1.20:3001/__mentra_dev", mdns: "dev-mac.local"},
    })
    // The ZIP's name carries its hash, as `pack` names one. Only `pack` writes `versions`.
    expect(served.bundle.url).toBe(`com.example.devtest-1.2.3-${served.bundle.sha256.slice(0, 8)}.zip`)
    expect(served).not.toHaveProperty("versions")

    const bytes = await fetchBundle(serve, url, served.bundle.url)
    expect(sha256(bytes)).toBe(served.bundle.sha256)
    const zip = await JSZip.loadAsync(bytes)
    expect(JSON.parse(await zip.file("miniapp.json")!.async("string"))).toEqual(MANIFEST)
    expect(zip.file("background/index.js")).not.toBeNull()
    expect(zip.file("ui/index.html")).not.toBeNull()
  })

  test("is served at the URL itself too", async () => {
    const serve = handler(project())
    const response = await serve(new Request("http://192.168.1.20:3000/"))
    expect(response.status).toBe(200)
    const served = (await response.json()) as Record<string, any>
    expect(served.bundle.url).toBe(servedZipName(MANIFEST, served.bundle.sha256))
  })

  test("names the reload socket on the host the phone reached the server by", async () => {
    const serve = handler(project())
    expect((await fetchServed(serve, "http://127.0.0.1:3000/")).development.reload).toBe(
      "ws://127.0.0.1:3001/__mentra_dev",
    )
    expect((await fetchServed(serve, "http://dev-mac.local:3000/")).development.reload).toBe(
      "ws://dev-mac.local:3001/__mentra_dev",
    )
  })

  test("leaves out reload while the sidecar isn't running, and mdns without an mDNS name", async () => {
    const serve = handler(project(), {sidecarPort: () => null, mdnsHost: null})
    const served = await fetchServed(serve, "http://192.168.1.20:3000/")
    expect(served.development).toEqual({})
    expect(ServedMiniappManifestSchema.safeParse(served).success).toBe(true)
  })

  test("names the same hash until the files change, and the new ZIP's after", async () => {
    const root = project()
    const serve = handler(root)
    const url = "http://192.168.1.20:3000/"
    const first = (await fetchServed(serve, url)).bundle.sha256
    expect((await fetchServed(serve, url)).bundle.sha256).toBe(first)

    write(root, "dist/ui/index.html", "<!doctype html><p>changed</p>")
    const changed = await fetchServed(serve, url)
    const next = changed.bundle.sha256
    expect(next).not.toBe(first)
    expect(sha256(await fetchBundle(serve, url, changed.bundle.url))).toBe(next)
  })

  test("waits for the build in flight", async () => {
    const root = project()
    let finishBuild = () => {}
    const building = new Promise<void>((resolve) => (finishBuild = resolve))
    const serve = handler(root, {idle: () => building})

    const pending = fetchServed(serve, "http://192.168.1.20:3000/")
    // The build writes dist/ after the request arrived.
    write(root, "dist/ui/index.html", "<!doctype html><p>rebuilt</p>")
    finishBuild()
    const served = await pending

    const bytes = await fetchBundle(handler(root), "http://192.168.1.20:3000/", "bundle.zip")
    expect(served.bundle.sha256).toBe(sha256(bytes))
    const zip = await JSZip.loadAsync(bytes)
    expect(await zip.file("ui/index.html")!.async("string")).toContain("rebuilt")
  })

  test("answers 500 for a miniapp.json that isn't a JSON object", async () => {
    const serve = handler(project("{not json"))
    expect((await serve(new Request("http://192.168.1.20:3000/miniapp.json"))).status).toBe(500)
    const array = handler(project("[]"))
    expect((await array(new Request("http://192.168.1.20:3000/miniapp.json"))).status).toBe(500)
  })
})

describe("the dev server's ZIP", () => {
  const url = "http://192.168.1.20:3000/"

  test("is also at /bundle.zip, where released Mentra Apps ask for it: always the latest build", async () => {
    const root = project()
    const serve = handler(root)
    const first = await fetchServed(serve, url)
    expect(sha256(await fetchBundle(serve, url, "bundle.zip"))).toBe(first.bundle.sha256)

    write(root, "dist/ui/index.html", "<!doctype html><p>changed</p>")
    const next = await fetchServed(serve, url)
    expect(next.bundle.url).not.toBe(first.bundle.url)
    expect(sha256(await fetchBundle(serve, url, "bundle.zip"))).toBe(next.bundle.sha256)
  })

  test("a build keeps its ZIP at its own name after a save, so a miniapp.json fetched before it still matches", async () => {
    const root = project()
    const serve = handler(root)
    const first = await fetchServed(serve, url)

    // The save lands between the phone's two requests.
    write(root, "dist/ui/index.html", "<!doctype html><p>changed</p>")
    const next = await fetchServed(serve, url)

    expect(sha256(await fetchBundle(serve, url, first.bundle.url))).toBe(first.bundle.sha256)
    expect(sha256(await fetchBundle(serve, url, next.bundle.url))).toBe(next.bundle.sha256)
  })

  test("keeps only the last few builds", async () => {
    const root = project()
    const serve = handler(root)
    const first = await fetchServed(serve, url)
    for (let save = 1; save <= 4; save++) {
      write(root, "dist/ui/index.html", `<!doctype html><p>save ${save}</p>`)
      await fetchServed(serve, url)
    }
    expect((await serve(new Request(new URL(first.bundle.url, url)))).status).toBe(404)
  })

  test("after a restart, unchanged files are still served under the name they had", async () => {
    const root = project()
    const before = await fetchServed(handler(root), url)
    // A new server has named no build yet.
    const restarted = handler(root)
    expect(sha256(await fetchBundle(restarted, url, before.bundle.url))).toBe(before.bundle.sha256)
  })

  test("answers 404 for a ZIP name no build has", async () => {
    const serve = handler(project())
    await fetchServed(serve, url)
    expect((await serve(new Request(new URL("com.example.devtest-1.2.3-00000000.zip", url)))).status).toBe(404)
  })

  test("a package name or version that can't be in a URL keeps the hash in the name", () => {
    const hash = "9f2c0e1a".padEnd(64, "0")
    expect(servedZipName({packageName: "com.example.notes", version: "0.3.5"}, hash)).toBe(
      "com.example.notes-0.3.5-9f2c0e1a.zip",
    )
    expect(servedZipName({packageName: "com.example.notes", version: "1.0 beta?"}, hash)).toBe("bundle-9f2c0e1a.zip")
    expect(servedZipName({}, hash)).toBe("bundle-9f2c0e1a.zip")
  })
})

describe("dev --production: the production bundle, served as a miniapp URL", () => {
  const url = "http://192.168.1.20:3000/"

  /** The request handler `dev --production` runs, over the project's production bundle. */
  async function production(root: string, signingKey?: ReturnType<typeof generatePackageSigningKey>) {
    const bundle = await buildBundle({cwd: root, silent: true, signingKey})
    const icon = await iconFromArchive(bundle.archive, bundle.manifest.icon, true)
    return {bundle, serve: handler(root, {production: {bundle, icon}})}
  }

  test("serves the bundle pack builds: miniapp.json names its ZIP and hash, and the ZIP holds the packed miniapp.json", async () => {
    const root = project()
    const {bundle, serve} = await production(root)
    const served = await fetchServed(serve, url)

    expect(ServedMiniappManifestSchema.safeParse(served).success).toBe(true)
    expect(served).toEqual({
      ...MANIFEST,
      bundle: {url: bundle.zipName, sha256: bundle.sha256},
      development: {reload: "ws://192.168.1.20:3001/__mentra_dev", mdns: "dev-mac.local"},
    })
    expect(served).not.toHaveProperty("versions")

    const bytes = await fetchBundle(serve, url, served.bundle.url)
    expect(sha256(bytes)).toBe(served.bundle.sha256)
    const zip = await JSZip.loadAsync(bytes)
    expect(JSON.parse(await zip.file("miniapp.json")!.async("string"))).toEqual(MANIFEST)
    expect(zip.file("background/index.js")).not.toBeNull()

    // The same bytes `pack` writes to build/ for these files.
    const packed = await Bun.file(await pack({cwd: root, silent: true})).bytes()
    expect(sha256(packed)).toBe(served.bundle.sha256)
  })

  test("serves that ZIP at /bundle.zip too, and the icon from the bundle", async () => {
    const root = project()
    const {bundle, serve} = await production(root)
    expect(sha256(await fetchBundle(serve, url, "bundle.zip"))).toBe(bundle.sha256)
    const icon = await serve(new Request(new URL("icon.png", url)))
    expect(icon.status).toBe(200)
    expect(icon.headers.get("content-type")).toBe("image/png")
    expect(await icon.text()).toBe("png bytes")
  })

  test("doesn't follow the working copy: a save changes nothing it serves", async () => {
    const root = project()
    const {bundle, serve} = await production(root)
    write(root, "dist/ui/index.html", "<!doctype html><p>changed</p>")
    write(root, "miniapp.json", JSON.stringify({...MANIFEST, version: "9.9.9"}))

    const served = await fetchServed(serve, url)
    expect(served.version).toBe("1.2.3")
    expect(served.bundle).toEqual({url: bundle.zipName, sha256: bundle.sha256})
    expect(sha256(await fetchBundle(serve, url, served.bundle.url))).toBe(bundle.sha256)
  })

  test("serves no project file: only what a host holding pack's folder serves", async () => {
    const root = project()
    const {serve} = await production(root)
    for (const path of ["dist/ui/index.html", "dist/background/index.js", "package.json", "nope.zip", "miniapp.json.bak"]) {
      expect((await serve(new Request(`${url}${path}`))).status).toBe(404)
    }
  })

  test("serves the signed bundle when signing is asked for", async () => {
    const root = project()
    const signingKey = generatePackageSigningKey("com.example.devtest")
    const {serve} = await production(root, signingKey)
    const served = await fetchServed(serve, url)
    const bytes = await fetchBundle(serve, url, served.bundle.url)
    expect(sha256(bytes)).toBe(served.bundle.sha256)
    const verified = await verifySignedBundleArchive(bytes)
    expect(verified.packageName).toBe("com.example.devtest")
    expect(verified.version).toBe("1.2.3")
  })
})

describe("the dev server's other files", () => {
  test("serves the icon and dist/ for live launches, and the sidecar's ZIP path", async () => {
    const serve = handler(project())
    const icon = await serve(new Request("http://192.168.1.20:3000/icon.png"))
    expect(icon.status).toBe(200)
    expect(await icon.text()).toBe("png bytes")
    const ui = await serve(new Request("http://192.168.1.20:3000/dist/ui/index.html"))
    expect(ui.headers.get("content-type")).toContain("text/html")
    const sidecarZip = await serve(new Request("http://192.168.1.20:3000/__mentra_dev/bundle.zip"))
    expect(sidecarZip.headers.get("content-type")).toBe("application/zip")
  })

  test("refuses folders and missing files", async () => {
    const serve = handler(project())
    expect((await serve(new Request("http://192.168.1.20:3000/dist"))).status).toBe(404)
    expect((await serve(new Request("http://192.168.1.20:3000/nope.js"))).status).toBe(404)
  })
})

describe("createBuildQueue: one build at a time", () => {
  function deferred() {
    let resolve = () => {}
    let reject = (_error: Error) => {}
    const promise = new Promise<void>((res, rej) => {
      resolve = res
      reject = rej
    })
    return {promise, resolve, reject}
  }

  const settled = async (promise: Promise<unknown>) => {
    let done = false
    void promise.then(
      () => (done = true),
      () => (done = true),
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
    return done
  }

  test("a second build waits for the first, and idle waits for both", async () => {
    const builds = [deferred(), deferred()]
    const started: number[] = []
    const queue = createBuildQueue(() => {
      started.push(started.length)
      return builds[started.length - 1]!.promise
    })

    const first = queue.build()
    const second = queue.build()
    await settled(first)
    expect(started).toEqual([0])

    // The second can't finish first: it hasn't started.
    builds[1]!.resolve()
    expect(await settled(queue.idle())).toBe(false)

    builds[0]!.resolve()
    await first
    await second
    expect(started).toEqual([0, 1])
    expect(await settled(queue.idle())).toBe(true)
  })

  test("idle waits for a build asked for while it was waiting", async () => {
    const builds = [deferred(), deferred()]
    let count = 0
    const queue = createBuildQueue(() => builds[count++]!.promise)
    void queue.build()
    const idle = queue.idle()
    void queue.build()
    builds[0]!.resolve()
    expect(await settled(idle)).toBe(false)
    builds[1]!.resolve()
    expect(await settled(idle)).toBe(true)
  })

  test("a failed build rejects its caller but doesn't stop the next or hold idle", async () => {
    const builds = [deferred(), deferred()]
    let count = 0
    const queue = createBuildQueue(() => builds[count++]!.promise)
    const failing = queue.build()
    const next = queue.build()
    builds[0]!.reject(new Error("build.ts exited with code 1"))
    await expect(failing).rejects.toThrow("code 1")
    builds[1]!.resolve()
    await next
    expect(count).toBe(2)
    expect(await settled(queue.idle())).toBe(true)
  })
})
