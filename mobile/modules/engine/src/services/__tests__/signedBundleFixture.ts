import {Buffer} from "buffer"
import JSZip from "jszip"
import nacl from "tweetnacl"

import {sha256Hex} from "../../utils/sha256"

export async function signedBundleFixture(
  manifest: Record<string, unknown>,
  configure?: (zip: JSZip) => void,
): Promise<Uint8Array> {
  const zip = new JSZip()
  zip.file("miniapp.json", JSON.stringify(manifest))
  configure?.(zip)
  const files: Array<{path: string; size: number; sha256: string}> = []
  for (const entry of Object.values(zip.files)) {
    if (entry.dir) continue
    const bytes = await entry.async("uint8array")
    files.push({path: entry.name, size: bytes.byteLength, sha256: await sha256Hex(bytes)})
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  const pair = nacl.sign.keyPair()
  const payload = {
    packageName: String(manifest.packageName),
    version: String(manifest.version),
    manifestSha256: await sha256Hex(new TextEncoder().encode(canonicalJson(manifest))),
    contentSha256: await sha256Hex(new TextEncoder().encode(canonicalJson({schemaVersion: 1, files}))),
  }
  const publicX = Buffer.from(pair.publicKey).toString("base64url")
  const fingerprint = `sha256:${await sha256Hex(pair.publicKey)}`
  zip.file(
    "META-INF/MENTRA.SIG",
    canonicalJson({
      schemaVersion: 1,
      algorithm: "Ed25519",
      publicKeyJwk: {kty: "OKP", crv: "Ed25519", x: publicX},
      publisherKeyFingerprint: fingerprint,
      payload,
      signature: Buffer.from(
        nacl.sign.detached(new TextEncoder().encode(canonicalJson(payload)), pair.secretKey),
      ).toString("base64url"),
    }),
  )
  return zip.generateAsync({type: "uint8array", compression: "DEFLATE"})
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`
}
