import type {PreinstalledMiniappRegistryEntry} from "@mentra/cloud-client/react-native"
import {appRegistry} from "@mentra/engine/internal"
import {Directory, File, Paths} from "expo-file-system"
import semver from "semver"

import {cloudClient} from "@/services/cloudClient"

const LOG_TAG = "PreinstalledMiniappSync"

// The user-facing mobile app version (e.g. "2.12.0"), sourced the same way as
// the rest of the app (see mobile/src/app/index.tsx getLocalVersion).
const MOBILE_APP_VERSION = process.env.EXPO_PUBLIC_MENTRAOS_VERSION || null

/**
 * Whether the current mobile build satisfies an entry's minMobileVersion /
 * maxMobileVersion gate. Both bounds are optional and inclusive. Versions are
 * coerced (semver.coerce) so partial bounds like "2.11" work. If the app
 * version can't be determined or a bound is unparseable, we conservatively
 * treat the gate as satisfied rather than blocking installs on bad metadata.
 */
function isMobileVersionSupported(entry: PreinstalledMiniappRegistryEntry): boolean {
  const min = entry.minMobileVersion
  const max = entry.maxMobileVersion
  if (!min && !max) return true

  const current = semver.coerce(MOBILE_APP_VERSION ?? undefined)
  if (!current) {
    console.warn(
      `${LOG_TAG}: cannot determine mobile app version (EXPO_PUBLIC_MENTRAOS_VERSION=${MOBILE_APP_VERSION}); skipping version gate for ${entry.packageName}`,
    )
    return true
  }

  if (min) {
    const minVer = semver.coerce(min)
    if (minVer && semver.lt(current, minVer)) return false
  }
  if (max) {
    const maxVer = semver.coerce(max)
    if (maxVer && semver.gt(current, maxVer)) return false
  }
  return true
}

function shouldInstall(entry: PreinstalledMiniappRegistryEntry): boolean {
  if (!isMobileVersionSupported(entry)) {
    console.log(
      `${LOG_TAG}: skipping ${entry.packageName}@${entry.version} — mobile ${MOBILE_APP_VERSION} outside [${entry.minMobileVersion ?? "*"}, ${entry.maxMobileVersion ?? "*"}]`,
    )
    return false
  }
  const installedVersions = appRegistry.getInstalledVersions(entry.packageName)
  if (installedVersions.includes(entry.version)) return false
  if (entry.installPolicy === "install_once") return installedVersions.length === 0
  return true
}

async function installEntry(entry: PreinstalledMiniappRegistryEntry): Promise<void> {
  if (!shouldInstall(entry)) return

  console.log(`${LOG_TAG}: installing ${entry.packageName}@${entry.version} (${entry.installPolicy})`)
  const zipPath = await downloadVerifiedBundle(entry)
  const result = await appRegistry.installFromLocalZip(zipPath, {
    releaseIdentity: {
      source: "preinstalled_registry",
      bundleSha256: entry.bundleSha256.toLowerCase(),
      channel: entry.channel,
    },
  })
  if (result.is_error()) {
    throw result.error
  }
}

async function downloadVerifiedBundle(entry: PreinstalledMiniappRegistryEntry): Promise<string> {
  const downloadDir = new Directory(Paths.cache, "preinstalled_miniapps")
  if (!downloadDir.exists) downloadDir.create()

  const safeName = `${entry.packageName}-${entry.version}.zip`.replace(/[^a-z0-9._-]/gi, "_")
  const target = new File(downloadDir, safeName)
  if (target.exists) target.delete()

  let output: File
  try {
    output = await File.downloadFileAsync(entry.bundleUrl, target, {idempotent: true})
  } catch (error) {
    throw new Error(`bundle download failed: ${(error as Error)?.message ?? error}`)
  }
  const bytes = await output.bytes()
  const actualSha = await sha256Hex(bytes)
  if (actualSha !== entry.bundleSha256.toLowerCase()) {
    try {
      output.delete()
    } catch {
      // best effort cleanup
    }
    throw new Error(`bundle sha mismatch: expected ${entry.bundleSha256}, got ${actualSha}`)
  }
  return output.uri
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  if (globalThis.crypto?.subtle) {
    const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
    const digest = await globalThis.crypto.subtle.digest("SHA-256", data)
    return bytesToHex(new Uint8Array(digest))
  }
  return sha256HexSync(bytes)
}

function sha256HexSync(bytes: Uint8Array): string {
  const h = new Uint32Array([
    0x6a09e667,
    0xbb67ae85,
    0x3c6ef372,
    0xa54ff53a,
    0x510e527f,
    0x9b05688c,
    0x1f83d9ab,
    0x5be0cd19,
  ])
  const k = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ])
  const paddedLength = (((bytes.length + 9 + 63) >> 6) << 6)
  const msg = new Uint8Array(paddedLength)
  msg.set(bytes)
  msg[bytes.length] = 0x80
  const bitLength = bytes.length * 8
  for (let i = 0; i < 8; i++) {
    msg[paddedLength - 1 - i] = Math.floor(bitLength / 2 ** (8 * i)) & 0xff
  }

  const w = new Uint32Array(64)
  for (let offset = 0; offset < msg.length; offset += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] =
        (msg[offset + i * 4] << 24) |
        (msg[offset + i * 4 + 1] << 16) |
        (msg[offset + i * 4 + 2] << 8) |
        msg[offset + i * 4 + 3]
    }
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3)
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10)
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0
    }

    let a = h[0]
    let b = h[1]
    let c = h[2]
    let d = h[3]
    let e = h[4]
    let f = h[5]
    let g = h[6]
    let hh = h[7]
    for (let i = 0; i < 64; i++) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)
      const ch = (e & f) ^ (~e & g)
      const temp1 = (hh + s1 + ch + k[i] + w[i]) >>> 0
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const temp2 = (s0 + maj) >>> 0
      hh = g
      g = f
      f = e
      e = (d + temp1) >>> 0
      d = c
      c = b
      b = a
      a = (temp1 + temp2) >>> 0
    }
    h[0] = (h[0] + a) >>> 0
    h[1] = (h[1] + b) >>> 0
    h[2] = (h[2] + c) >>> 0
    h[3] = (h[3] + d) >>> 0
    h[4] = (h[4] + e) >>> 0
    h[5] = (h[5] + f) >>> 0
    h[6] = (h[6] + g) >>> 0
    h[7] = (h[7] + hh) >>> 0
  }

  const out = new Uint8Array(32)
  for (let i = 0; i < h.length; i++) {
    out[i * 4] = h[i] >>> 24
    out[i * 4 + 1] = h[i] >>> 16
    out[i * 4 + 2] = h[i] >>> 8
    out[i * 4 + 3] = h[i]
  }
  return bytesToHex(out)
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes]
    .map(byte => byte.toString(16).padStart(2, "0"))
    .join("")
}

function rotr(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits))
}

export const preinstalledMiniappSync = {
  async sync(): Promise<void> {
    let registry
    try {
      registry = await cloudClient.getPreinstalledMiniappRegistry()
    } catch (error) {
      console.warn(`${LOG_TAG}: registry fetch failed: ${(error as Error)?.message ?? error}`)
      return
    }

    for (const entry of registry.entries) {
      try {
        await installEntry(entry)
      } catch (error) {
        console.warn(
          `${LOG_TAG}: failed to install ${entry.packageName}@${entry.version}: ${(error as Error)?.message ?? error}`,
        )
      }
    }
  },
}
