import {execFileSync} from "node:child_process"
import {createHash, randomUUID} from "node:crypto"
import {createReadStream, createWriteStream, existsSync, statSync} from "node:fs"
import {mkdir, mkdtemp, rename, rm} from "node:fs/promises"
import {createRequire} from "node:module"
import {tmpdir} from "node:os"
import path from "node:path"
import {Readable} from "node:stream"
import {pipeline} from "node:stream/promises"
import {setTimeout as sleep} from "node:timers/promises"

export const ARTIFACT_ORIGIN = "https://artifactscdn.mentraglass.com"
const INDEX_NAME = "_assets.json"
const RESERVED_NAMES = new Set([INDEX_NAME, "index.html"])

export function usesPrivateArtifactStorage(release) {
  return release.draft && !/^mentra-v\d+\.\d+\.\d+$/.test(release.tag_name)
}

export function artifactPrefix(repository, tag) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository || "")) throw new Error("Invalid artifact repository")
  if (!tag || tag === "." || tag === ".." || /[\\/\r\n]/.test(tag)) throw new Error("Invalid artifact release tag")
  return `${repository}/releases/${tag}/`
}

export function artifactKey(repository, tag, name) {
  if (!name || name === "." || name === ".." || /[\\/\r\n]/.test(name) || RESERVED_NAMES.has(name)) {
    throw new Error("Invalid or reserved artifact name")
  }
  return artifactPrefix(repository, tag) + name
}

export function keyUrl(key) {
  return `${ARTIFACT_ORIGIN}/${key.split("/").map(encodeURIComponent).join("/")}`
}

export function artifactUrl(repository, tag, name) {
  return keyUrl(artifactKey(repository, tag, name))
}

export function artifactBaseUrl(repository, tag) {
  return keyUrl(artifactPrefix(repository, tag)).replace(/\/$/, "")
}

export function legacyArtifactUrl(repository, tag, name) {
  artifactKey(repository, tag, name)
  return `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`
}

export function resolveArtifactUrl(repository, release, name, assets, {legacy = [], allowMissing = false} = {}) {
  artifactKey(repository, release.tag_name, name)
  // Frozen records retain their original GitHub URLs even after mirroring.
  for (const source of [legacy, assets]) {
    const matches = source.filter((asset) => asset.name === name && asset.state === "uploaded")
    if (matches.length > 1) throw new Error(`Duplicate artifact ${name}`)
    if (matches.length === 1) return matches[0].browser_download_url
  }
  if (!allowMissing) throw new Error(`Expected an existing artifact ${name}`)
  return usesPrivateArtifactStorage(release)
    ? legacyArtifactUrl(repository, release.tag_name, name)
    : artifactUrl(repository, release.tag_name, name)
}

export function gh(args, options = {}) {
  return execFileSync("gh", args, {encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...options})
}

export function resolveRelease(repository, {releaseId, tag}) {
  artifactPrefix(repository, tag || "lookup")
  const route = releaseId ? String(releaseId) : `tags/${encodeURIComponent(tag)}`
  if (releaseId && !/^\d+$/.test(String(releaseId))) throw new Error("Invalid release ID")
  return JSON.parse(gh(["api", `repos/${repository}/releases/${route}`]))
}

export function mergeAssets(legacy, current) {
  const names = new Set()
  for (const asset of current) {
    if (names.has(asset.name)) throw new Error(`Duplicate R2 artifact ${asset.name}`)
    names.add(asset.name)
  }
  return [...legacy.filter((asset) => !names.has(asset.name)), ...current]
}

export function validateIndex(index, repository, tag) {
  if (
    index.schemaVersion !== 1 ||
    index.repository !== repository ||
    index.tag !== tag ||
    !Array.isArray(index.assets)
  ) {
    throw new Error("Artifact index does not match its release")
  }
  mergeAssets([], index.assets)
  for (const asset of index.assets) {
    const key = artifactKey(repository, tag, asset.name)
    if (
      asset.id !== `r2:${key}` ||
      asset.url !== keyUrl(key) ||
      asset.browser_download_url !== asset.url ||
      asset.state !== "uploaded" ||
      !Number.isSafeInteger(asset.size) ||
      asset.size < 0 ||
      !/^sha256:[a-f0-9]{64}$/.test(asset.digest || "")
    )
      throw new Error(`Invalid artifact record ${asset.name}`)
  }
  return index
}

export async function readPublicIndex(repository, tag, fetchImpl = fetch) {
  const url = keyUrl(artifactPrefix(repository, tag) + INDEX_NAME)
  const response = await fetchImpl(`${url}?read=${randomUUID()}`, {
    signal: AbortSignal.timeout(30_000),
    cache: "no-store",
  })
  if (response.status === 404) return {schemaVersion: 1, repository, tag, assets: []}
  if (!response.ok) throw new Error(`Reading artifact index failed with HTTP ${response.status}`)
  return validateIndex(await response.json(), repository, tag)
}

export async function listReleaseAssets(repository, release) {
  const legacy = JSON.parse(
    gh(["api", "--paginate", "--slurp", `repos/${repository}/releases/${release.id}/assets?per_page=100`]),
  ).flat()
  // Promotion evidence in a private draft must not become public as a side
  // effect of changing the transport used for public download artifacts.
  if (usesPrivateArtifactStorage(release)) return legacy
  return mergeAssets(legacy, (await readArtifactIndex(repository, release.tag_name)).assets)
}

export async function readArtifactIndex(repository, tag, {store, env = process.env, verify = downloadAsset} = {}) {
  // CI must discover committed objects even if the previous job died before
  // indexing them. Public/operator reads can still work without S3 credentials.
  if (!store && !env.ARTIFACTS_R2_ACCESS_KEY_ID && !env.ARTIFACTS_R2_SECRET_ACCESS_KEY)
    return readPublicIndex(repository, tag)
  store ||= await createR2Store(env)
  const prefix = artifactPrefix(repository, tag)
  const previous = await store.read(prefix + INDEX_NAME)
  const index = previous
    ? validateIndex(JSON.parse(previous.body), repository, tag)
    : {schemaVersion: 1, repository, tag, assets: []}
  const known = new Map(index.assets.map((asset) => [asset.name, asset]))
  const recovered = []
  const retentionDays = {"pr-builds": 7, "oem-app-builds": 14}[tag]
  for (const object of await store.list(prefix)) {
    const name = object.Key.slice(prefix.length)
    if (RESERVED_NAMES.has(name)) continue
    artifactKey(repository, tag, name)
    if (known.get(name)?.etag === object.ETag) continue
    // Lifecycle deletion is asynchronous. Do not resurrect an expired rolling
    // build that a sweep already removed from the download index.
    if (retentionDays && object.LastModified.getTime() < Date.now() - retentionDays * 86400000) continue
    const head = await store.head(object.Key)
    if (!head) continue // It expired between listing and HEAD.
    const asset = recordFromObject(repository, tag, name, head)
    const directory = await mkdtemp(path.join(tmpdir(), "mentra-artifact-recovery-"))
    try {
      // A corrupt/unavailable committed object is a failure, never "not built".
      await verify(repository, asset, path.join(directory, "artifact"))
    } finally {
      await rm(directory, {recursive: true, force: true})
    }
    recovered.push(asset)
  }
  if (!recovered.length) return index
  const next = await updateIndex(store, repository, tag, (assets) => {
    const current = new Map(assets.map((asset) => [asset.name, asset]))
    for (const asset of recovered) {
      // A concurrent publisher may have indexed a newer replacement while we
      // verified this one. Preserve its record and only repair our snapshot.
      if (JSON.stringify(current.get(asset.name)) === JSON.stringify(known.get(asset.name)))
        current.set(asset.name, asset)
    }
    return [...current.values()]
  })
  await writeDownloadPage(store, repository, tag)
  return next
}

function recordFromObject(repository, tag, name, head) {
  const key = artifactKey(repository, tag, name)
  const digest = head.Metadata?.sha256
  const fingerprint = head.Metadata?.fingerprint
  if (!/^[a-f0-9]{64}$/.test(digest || "") || (fingerprint && !/^[a-f0-9]{64}$/.test(fingerprint)))
    throw new Error(`Committed R2 artifact ${name} has invalid checksum/fingerprint metadata`)
  return validateIndex(
    {
      schemaVersion: 1,
      repository,
      tag,
      assets: [
        {
          id: `r2:${key}`,
          name,
          size: head.ContentLength,
          digest: `sha256:${digest}`,
          state: "uploaded",
          url: keyUrl(key),
          browser_download_url: keyUrl(key),
          created_at: head.LastModified.toISOString(),
          updated_at: head.LastModified.toISOString(),
          etag: head.ETag,
          ...(fingerprint ? {label: `mobile-v1:${fingerprint}:${digest}`} : {}),
        },
      ],
    },
    repository,
    tag,
  ).assets[0]
}

export async function sha256File(file) {
  const hash = createHash("sha256")
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest("hex")
}

export async function downloadAsset(repository, asset, file) {
  await mkdir(path.dirname(path.resolve(file)), {recursive: true})
  const temporary = `${file}.${randomUUID()}.part`
  try {
    if (String(asset.id).startsWith("r2:")) {
      const key = asset.id.slice(3)
      if (!key.startsWith(`${repository}/releases/`) || key.split("/").some((part) => part === ".." || part === ".")) {
        throw new Error("R2 asset belongs to a different repository")
      }
      const response = await fetch(keyUrl(key), {signal: AbortSignal.timeout(15 * 60_000)})
      if (!response.ok) throw new Error(`Downloading ${asset.name || key} failed with HTTP ${response.status}`)
      await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary))
    } else {
      if (!/^\d+$/.test(String(asset.id))) throw new Error("Invalid GitHub asset ID")
      const {openSync, closeSync} = await import("node:fs")
      const fd = openSync(temporary, "w")
      try {
        gh(["api", "-H", "Accept: application/octet-stream", `repos/${repository}/releases/assets/${asset.id}`], {
          stdio: ["ignore", fd, "inherit"],
        })
      } finally {
        closeSync(fd)
      }
    }
    if (asset.size !== undefined && statSync(temporary).size !== asset.size)
      throw new Error("Downloaded artifact size mismatch")
    if (asset.digest && `sha256:${await sha256File(temporary)}` !== asset.digest)
      throw new Error("Downloaded artifact SHA-256 mismatch")
    await rename(temporary, file)
  } finally {
    await rm(temporary, {force: true})
  }
}

export async function createR2Store(env = process.env) {
  const {
    ARTIFACTS_R2_ACCESS_KEY_ID: accessKeyId,
    ARTIFACTS_R2_SECRET_ACCESS_KEY: secretAccessKey,
    ARTIFACTS_R2_ACCOUNT_ID: accountId,
    ARTIFACTS_R2_BUCKET: bucket = "artifactscdn",
  } = env
  if (!accessKeyId || !secretAccessKey || !/^[a-f0-9]{32}$/.test(accountId || "")) {
    throw new Error(
      "ARTIFACTS_R2_ACCOUNT_ID, ARTIFACTS_R2_ACCESS_KEY_ID and ARTIFACTS_R2_SECRET_ACCESS_KEY are required",
    )
  }
  const require = createRequire(new URL("../artifact-storage/package.json", import.meta.url))
  // Keep CI tooling isolated from the monorepo's install/build hooks. Runners
  // only need Node/npm; the committed lockfile pins this small S3 client.
  if (
    !existsSync(new URL("../artifact-storage/node_modules/@aws-sdk/client-s3/package.json", import.meta.url)) ||
    !existsSync(new URL("../artifact-storage/node_modules/@aws-sdk/lib-storage/package.json", import.meta.url))
  ) {
    const {fileURLToPath} = await import("node:url")
    execFileSync(
      "npm",
      [
        "ci",
        "--prefix",
        fileURLToPath(new URL("../artifact-storage/", import.meta.url)),
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
      ],
      // Listing commands write JSON to stdout. Keep installation output out
      // of that data stream, including the first call on a fresh runner.
      {stdio: ["ignore", 2, 2]},
    )
  }
  const sdk = require("@aws-sdk/client-s3")
  const {Upload} = require("@aws-sdk/lib-storage")
  const client = new sdk.S3Client({
    region: "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: {accessKeyId, secretAccessKey},
    maxAttempts: 5,
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  })
  const send = (command, input) => client.send(new sdk[command]({Bucket: bucket, ...input}))
  return {
    async list(prefix) {
      const objects = []
      let token
      do {
        const result = await send("ListObjectsV2Command", {Prefix: prefix, ContinuationToken: token})
        objects.push(...(result.Contents || []))
        token = result.NextContinuationToken
      } while (token)
      return objects
    },
    async head(key) {
      try {
        return await send("HeadObjectCommand", {Key: key})
      } catch (error) {
        if (error.$metadata?.httpStatusCode === 404) return null
        throw error
      }
    },
    async read(key) {
      try {
        const result = await send("GetObjectCommand", {Key: key})
        return {etag: result.ETag, body: await result.Body.transformToString()}
      } catch (error) {
        if (error.$metadata?.httpStatusCode === 404) return null
        throw error
      }
    },
    put(key, body, options = {}) {
      return send("PutObjectCommand", {Key: key, Body: body, ...options})
    },
    async upload(key, file, digest, {etag, replace = false, fingerprint} = {}) {
      const upload = new Upload({
        client,
        queueSize: 4,
        partSize: 16 * 1024 * 1024,
        leavePartsOnError: false,
        params: {
          Bucket: bucket,
          Key: key,
          Body: createReadStream(file),
          ...artifactHeaders(file, digest, fingerprint),
          ...(etag ? {IfMatch: etag} : {IfNoneMatch: "*"}),
        },
      })
      return upload.done()
    },
    remove: (key) => send("DeleteObjectCommand", {Key: key}),
  }
}

export function artifactHeaders(file, digest, fingerprint) {
  return {
    ContentLength: statSync(file).size,
    ContentType: file.endsWith(".json") ? "application/json" : "application/octet-stream",
    // Recovery can discard an incomplete artifact pair or failed deployment
    // record and rebuild that key. This zone rewrites no-cache to a four-hour
    // TTL; no-store is honored by both the CDN and browsers.
    CacheControl: "no-store",
    Metadata: {sha256: digest, ...(fingerprint ? {fingerprint} : {})},
  }
}

const preconditionFailed = (error) => [409, 412].includes(error.$metadata?.httpStatusCode)

export async function updateIndex(store, repository, tag, change, wait = sleep) {
  const key = artifactPrefix(repository, tag) + INDEX_NAME
  for (let attempt = 0; attempt < 8; attempt++) {
    const previous = await store.read(key)
    const index = previous
      ? validateIndex(JSON.parse(previous.body), repository, tag)
      : {schemaVersion: 1, repository, tag, assets: []}
    const next = validateIndex(
      {...index, assets: change(index.assets).sort((a, b) => a.name.localeCompare(b.name))},
      repository,
      tag,
    )
    try {
      await store.put(key, JSON.stringify(next, null, 2) + "\n", {
        ContentType: "application/json",
        CacheControl: "no-store",
        ...(previous ? {IfMatch: previous.etag} : {IfNoneMatch: "*"}),
      })
      return next
    } catch (error) {
      if (!preconditionFailed(error) || attempt === 7) throw error
      await wait(100 * 2 ** attempt)
    }
  }
}

export function releaseDownloadBody(body, repository, tag) {
  const url = `${artifactBaseUrl(repository, tag)}/index.html`
  if ((body || "").includes(url)) return body
  return `${body || ""}\n\n[Download release artifacts](${url}) — files are hosted on Mentra's artifact CDN.\n`
}

const INDEX_HTML = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Mentra release artifacts</title><style>body{font:16px system-ui;max-width:1000px;margin:48px auto;padding:0 24px}table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:12px;border-bottom:1px solid #ddd}code{font-size:12px;overflow-wrap:anywhere}a{color:#1765ce}</style><h1>Mentra release artifacts</h1><p id="status">Loading downloads…</p><table><thead><tr><th>File</th><th>Size</th><th>SHA-256</th></tr></thead><tbody></tbody></table><noscript><a href="_assets.json">Download the artifact manifest</a></noscript><script>fetch('_assets.json?read='+Date.now(),{cache:'no-store'}).then(r=>{if(!r.ok)throw Error('Could not load downloads');return r.json()}).then(index=>{document.querySelector('#status').textContent=index.repository+' · '+index.tag;for(const a of index.assets){const row=document.createElement('tr'),name=document.createElement('td'),size=document.createElement('td'),hash=document.createElement('td'),link=document.createElement('a'),code=document.createElement('code');link.textContent=a.name;link.href=a.browser_download_url;name.append(link);size.textContent=(a.size/1000000).toFixed(1)+' MB';code.textContent=a.digest.replace('sha256:','');hash.append(code);row.append(name,size,hash);document.querySelector('tbody').append(row)}}).catch(e=>document.querySelector('#status').textContent=e.message)</script></html>`

function writeDownloadPage(store, repository, tag) {
  return store.put(artifactPrefix(repository, tag) + "index.html", INDEX_HTML, {
    ContentType: "text/html; charset=utf-8",
    CacheControl: "no-cache",
  })
}

export async function publishR2Artifact({
  repository,
  release,
  name,
  file,
  store,
  replace = false,
  fingerprint,
  verify = downloadAsset,
  log = console.log,
  updateRelease = true,
  wait = sleep,
}) {
  if (usesPrivateArtifactStorage(release))
    throw new Error("Refusing to publish private draft artifacts in the public R2 bucket")
  if (replace && !["pr-builds", "oem-app-builds"].includes(release.tag_name))
    throw new Error("Replacement is only allowed for rolling PR/OEM builds")
  if (fingerprint && !/^[a-f0-9]{64}$/.test(fingerprint)) throw new Error("Invalid mobile build fingerprint")
  store ||= await createR2Store()
  const key = artifactKey(repository, release.tag_name, name)
  const digest = await sha256File(file)
  const size = statSync(file).size
  const existing = await store.head(key)
  const matches = (head) => head && head.ContentLength === size && head.Metadata?.sha256 === digest
  if (existing && !matches(existing) && !replace)
    throw new Error(`Refusing to overwrite immutable R2 artifact ${name} with different bytes`)
  if (!matches(existing) || replace) {
    try {
      await store.upload(key, file, digest, {replace, etag: existing?.ETag, fingerprint})
    } catch (error) {
      // A lost completion response or a concurrent identical publisher is safe
      // to reconcile; an incomplete multipart upload never becomes an object.
      if (!matches(await store.head(key))) throw error
    }
  }
  const committed = await store.head(key)
  if (!matches(committed)) throw new Error(`Committed R2 artifact ${name} changed during publication`)
  const asset = recordFromObject(repository, release.tag_name, name, committed)
  const verificationFile = `${file}.${randomUUID()}.verify`
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        await verify(repository, asset, verificationFile)
        break
      } catch (error) {
        if (attempt === 2) throw error
        log(`Retrying public verification of ${name}: ${error.message}`)
        await wait(1000 * 2 ** attempt)
      }
    }
  } finally {
    await rm(verificationFile, {force: true})
  }
  await updateIndex(store, repository, release.tag_name, (assets) => [...assets.filter((a) => a.name !== name), asset])
  await writeDownloadPage(store, repository, release.tag_name)
  if (updateRelease) {
    const current = resolveRelease(repository, {releaseId: release.id})
    const body = releaseDownloadBody(current.body, repository, release.tag_name)
    if (body !== current.body)
      gh(["api", "--method", "PATCH", `repos/${repository}/releases/${release.id}`, "--input", "-"], {
        input: JSON.stringify({body}),
      })
  }
  log(`Published ${name} (${size} bytes, sha256:${digest}) at ${asset.url}`)
  return asset
}
