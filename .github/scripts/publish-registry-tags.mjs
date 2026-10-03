#!/usr/bin/env node
// Point extra tags at an image that is already in the registry, without
// changing its digest.
//
// `docker buildx imagetools create --tag <tag> <image>@<digest>` cannot be used
// for this: it republishes the source wrapped in a NEW OCI index, so the tag
// resolves to a different digest than the one that was built and attested. The
// Mentra Cloud image is single-platform and built with `provenance: false`, so
// it is a bare image manifest with no index to copy through.
//
// A tag is just a name pointing at manifest bytes, so re-PUT the exact bytes
// that are already stored under the digest. Identical bytes hash to an
// identical digest, which keeps the attested digest and the published digest
// the same value end to end.
import {createHash} from "node:crypto"
import path from "node:path"
import {pathToFileURL} from "node:url"

const MANIFEST_MEDIA_TYPES = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.docker.distribution.manifest.v2+json",
]

export const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/

export function manifestDigest(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`
}

export function parseImageReference(image) {
  const match = /^([^/]+\.[^/]+)\/(.+)$/.exec(image || "")
  if (!match) throw new Error(`Image must be a fully qualified registry reference: ${JSON.stringify(image)}`)
  const [, registry, repository] = match
  if (repository.includes(":") || repository.includes("@")) {
    throw new Error(`Image must not carry a tag or digest: ${JSON.stringify(image)}`)
  }
  return {registry, repository}
}

export function tagName(reference) {
  const name = reference.slice(reference.lastIndexOf(":") + 1)
  if (!name || name === reference) throw new Error(`Reference is not tagged: ${JSON.stringify(reference)}`)
  if (!/^[A-Za-z0-9_][A-Za-z0-9._-]*$/.test(name)) throw new Error(`Invalid tag ${JSON.stringify(name)}`)
  return name
}

async function authorize({registry, repository, username, password, fetchImpl}) {
  if (!username || !password) throw new Error("Registry credentials are required")
  const url = new URL(`https://${registry}/token`)
  url.searchParams.set("service", registry)
  url.searchParams.set("scope", `repository:${repository}:pull,push`)
  const response = await fetchImpl(url.toString(), {
    headers: {authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`},
  })
  if (!response.ok) throw new Error(`Registry token request failed with ${response.status}`)
  const {token} = await response.json()
  if (!token) throw new Error("Registry token response has no token")
  return token
}

export async function publishRegistryTags({image, digest, tags, username, password, fetchImpl = fetch}) {
  if (!DIGEST_PATTERN.test(digest || "")) throw new Error(`Invalid digest ${JSON.stringify(digest)}`)
  if (!tags?.length) throw new Error("At least one tag is required")
  const {registry, repository} = parseImageReference(image)
  const names = tags.map(tagName)
  const token = await authorize({registry, repository, username, password, fetchImpl})

  const source = await fetchImpl(`https://${registry}/v2/${repository}/manifests/${digest}`, {
    headers: {authorization: `Bearer ${token}`, accept: MANIFEST_MEDIA_TYPES.join(",")},
  })
  if (!source.ok) throw new Error(`Reading ${image}@${digest} failed with ${source.status}`)
  const contentType = source.headers.get("content-type")
  if (!MANIFEST_MEDIA_TYPES.includes(contentType)) {
    throw new Error(`Unexpected manifest media type ${JSON.stringify(contentType)}`)
  }
  const manifest = Buffer.from(await source.arrayBuffer())
  // Byte-identity is the entire guarantee, so prove it before publishing. A
  // converted or re-serialized manifest would silently change the digest.
  const observed = manifestDigest(manifest)
  if (observed !== digest) throw new Error(`Registry returned ${observed} for ${digest}`)

  for (const name of names) {
    const response = await fetchImpl(`https://${registry}/v2/${repository}/manifests/${name}`, {
      method: "PUT",
      headers: {"authorization": `Bearer ${token}`, "content-type": contentType},
      body: manifest,
    })
    if (!response.ok) throw new Error(`Tagging ${image}:${name} failed with ${response.status}`)
    const published = response.headers.get("docker-content-digest")
    if (published && published !== digest) throw new Error(`${image}:${name} published as ${published}`)
  }
  return {digest, tags: names}
}

function parseArgs(args) {
  const values = {tag: []}
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index]
    const value = args[index + 1]
    if (!option?.startsWith("--") || value === undefined) throw new Error("Expected --name value pairs")
    const name = option.slice(2)
    if (name === "tag") values.tag.push(value)
    else values[name] = value
  }
  return values
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = parseArgs(process.argv.slice(2))
  const result = await publishRegistryTags({
    image: args.image,
    digest: args.digest,
    tags: args.tag,
    username: process.env.REGISTRY_USER,
    password: process.env.REGISTRY_PASSWORD,
  })
  console.log(`Tagged ${args.image}@${result.digest} as ${result.tags.join(", ")}`)
}
