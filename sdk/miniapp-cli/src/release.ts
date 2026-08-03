/**
 * `mentra-miniapp release` — build a release and install it on a phone.
 *
 * Flow:
 *   1. Detect package manager, run `<pm> run build` so the user's bundler
 *      produces dist/.
 *   2. Validate manifest + pack dist/ → build/<pkg>-<v>.zip (uses pack()).
 *   3. Spin up a tiny HTTP server on the LAN that serves the zip and
 *      manifest at fixed paths.
 *   4. Print a QR with `miniapp://release?url=<lan-base>&...`.
 *   5. Stay up (default persistent) so multiple devices can install. Print a
 *      ✓ line whenever a phone successfully fetches /bundle.zip.
 *
 * Phone-side: scanner branches on `miniapp://release`, downloads the
 * zip via composer.installMiniApp(<base>/bundle.zip). The miniapp lands in
 * lmas/<pkg>/<manifestVersion>/ and behaves like any installed local
 * miniapp — runs offline, persists across restarts, no laptop required.
 *
 * Why "release" and not "install": `install` collides with package
 * managers (`bun run install` is reserved). Naming the action after what
 * the user is producing — a release build for their phone — avoids the
 * collision and matches Android's `installRelease` mental model.
 */

import {readFileSync, existsSync, statSync, readdirSync, unlinkSync} from 'fs'
import os from 'os'
import {resolve, join} from 'path'
import {buildProduction} from './build.js'
import {pack} from './pack.js'
import {printQR, writeQRPng} from './qr.js'
import {validateManifest} from './manifest.js'

const DEFAULT_PORT_START = 6789
const PORT_SCAN_LIMIT = 10
const HEALTH_PATH = '/__mentra_release/health'
const MANIFEST_PATH = '/miniapp.json'
const ICON_PATH = '/icon.png'
const BUNDLE_PATH = '/bundle.zip'

interface ReleaseOptions {
  noCache?: boolean
  qrOutput?: string
}

export async function release(opts: ReleaseOptions = {}): Promise<void> {
  const cwd = process.cwd()

  // ---- 1. Validate manifest + read identity ---------------------------
  const manifestPath = resolve(cwd, 'miniapp.json')
  if (!existsSync(manifestPath)) {
    console.error('Error: miniapp.json not found in current directory')
    process.exit(1)
  }
  let manifest: Record<string, unknown>
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'))
  } catch {
    console.error('Error: miniapp.json is not valid JSON')
    process.exit(1)
  }
  const validation = validateManifest(manifest)
  if (!validation.valid) {
    console.error('miniapp.json validation failed:')
    for (const err of validation.errors) console.error(`  - ${err}`)
    process.exit(1)
  }

  const packageName = manifest.packageName as string
  const version = manifest.version as string
  const name = (manifest.name as string) ?? packageName

  // ---- 2. Build (or skip via cache) -----------------------------------
  const cacheDir = resolve(cwd, 'build')
  const cachedZipName = `${packageName}-${version}.zip`
  const cachedZipPath = join(cacheDir, cachedZipName)

  const cacheValid = !opts.noCache && isCacheFresh(cachedZipPath, cwd)
  if (cacheValid) {
    console.log(`✓ Using cached build (${cachedZipName})`)
  } else {
    await buildProduction(cwd)

    // Pack into build/<pkg>-<v>.zip
    const packStart = Date.now()
    const zipPath = await pack({outDir: 'build', silent: true})
    const sizeKb = Math.round(statSync(zipPath).size / 1024)
    console.log(`✓ Packed ${packageName}@${version} (${sizeKb} KB) in ${((Date.now() - packStart) / 1000).toFixed(1)}s`)
  }

  // ---- 3. Find a free port and load the bundle into memory ------------
  const zipBuffer = readFileSync(cachedZipPath)
  const iconPath = resolve(cwd, 'icon.png')
  const iconBuffer = existsSync(iconPath) ? readFileSync(iconPath) : null
  const manifestBuffer = readFileSync(manifestPath)

  const port = await pickPort(DEFAULT_PORT_START, PORT_SCAN_LIMIT)
  const lanIp = getLanIp()
  if (!lanIp) {
    console.error('Error: could not detect LAN IP. Connect to a Wi-Fi network and re-run.')
    process.exit(1)
  }

  const baseUrl = `http://${lanIp}:${port}`

  let installCount = 0

  // ---- 4. Serve --------------------------------------------------------
  const server = Bun.serve({
    hostname: '0.0.0.0',
    port,
    fetch(req) {
      const url = new URL(req.url)
      if (url.pathname === HEALTH_PATH) {
        return new Response(JSON.stringify({ok: true}), {
          headers: {'content-type': 'application/json'},
        })
      }
      if (url.pathname === MANIFEST_PATH) {
        return new Response(manifestBuffer, {
          headers: {'content-type': 'application/json'},
        })
      }
      if (url.pathname === ICON_PATH) {
        if (!iconBuffer) return new Response('Not found', {status: 404})
        return new Response(iconBuffer, {
          headers: {'content-type': 'image/png'},
        })
      }
      if (url.pathname === BUNDLE_PATH) {
        installCount += 1
        const remote = req.headers.get('x-forwarded-for') ?? 'unknown'
        console.log(`✓ Install #${installCount} — ${name}@${version} → ${remote}`)
        return new Response(zipBuffer, {
          headers: {
            'content-type': 'application/zip',
            'content-length': String(zipBuffer.length),
          },
        })
      }
      return new Response('Not found', {status: 404})
    },
  })

  // ---- 5. QR + banner --------------------------------------------------
  const qrUrl = `miniapp://release?url=${encodeURIComponent(baseUrl)}&package=${encodeURIComponent(packageName)}&version=${encodeURIComponent(version)}&name=${encodeURIComponent(name)}`

  console.log('\n╔══════════════════════════════════════════════════════════════╗')
  console.log('║  Install your mini app on a phone:                           ║')
  console.log('║                                                              ║')
  console.log('║    1. Open the Mentra app                                    ║')
  console.log('║    2. Settings → Developer settings                          ║')
  console.log('║    3. Under "Mini App Development", tap                      ║')
  console.log('║       "Scan Mini App QR Code" and scan the QR below          ║')
  console.log('║                                                              ║')
  console.log('║  Phone must be on the same Wi-Fi as this computer.           ║')
  console.log('║  This server stays up — install on multiple phones, then     ║')
  console.log('║  Ctrl+C to stop.                                             ║')
  console.log('╚══════════════════════════════════════════════════════════════╝\n')

  const defaultQrPath = join(os.tmpdir(), `mentra-release-qr-${packageName}.png`)
  const qrOutputPath = resolve(opts.qrOutput ?? defaultQrPath)

  await printQR(qrUrl)
  await writeQRPng(qrUrl, qrOutputPath)
  console.log(`\n${qrUrl}`)
  console.log(`PNG QR: ${qrOutputPath}\n`)
  console.log(`Serving on ${baseUrl}`)

  // ---- 6. Wait for SIGINT ---------------------------------------------
  await new Promise<void>((resolvePromise) => {
    process.on('SIGINT', () => {
      console.log('\nShutting down...')
      try {
        unlinkSync(qrOutputPath)
      } catch {
        // best-effort cleanup of temp PNG
      }
      server.stop()
      resolvePromise()
    })
  })
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getLanIp(): string | null {
  const interfaces = os.networkInterfaces()
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] ?? []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address
      }
    }
  }
  return null
}

async function pickPort(start: number, limit: number): Promise<number> {
  for (let i = 0; i < limit; i++) {
    const port = start + i
    try {
      const server = Bun.serve({port, hostname: '127.0.0.1', fetch: () => new Response()})
      server.stop()
      return port
    } catch {
      continue
    }
  }
  console.error(`Error: no free port found between ${start} and ${start + limit - 1}`)
  process.exit(1)
}

/**
 * Cache is fresh if the zip exists and is newer than every source file in
 * the project (excluding node_modules / dist / build / .git).
 */
function isCacheFresh(zipPath: string, cwd: string): boolean {
  if (!existsSync(zipPath)) return false
  const zipMtime = statSync(zipPath).mtimeMs
  return walkAllNewerThan(cwd, zipMtime, ['node_modules', 'dist', 'build', '.git']) === false
}

/**
 * Returns true if any file under `dir` (recursively) has mtime > `threshold`.
 * Skips directories whose name matches `excludeNames`. Bounded to keep
 * cache-check fast on large monorepos.
 */
function walkAllNewerThan(dir: string, threshold: number, excludeNames: string[]): boolean {
  const MAX_FILES = 1000
  let scanned = 0
  const queue: string[] = [dir]
  while (queue.length > 0) {
    const cur = queue.shift()!
    let entries: string[]
    try {
      entries = readdirSync(cur)
    } catch {
      continue
    }
    for (const entry of entries) {
      if (excludeNames.includes(entry)) continue
      if (entry.startsWith('.') && entry !== '.') continue
      const abs = join(cur, entry)
      let st
      try {
        st = statSync(abs)
      } catch {
        continue
      }
      if (st.isDirectory()) {
        queue.push(abs)
      } else if (st.isFile()) {
        if (st.mtimeMs > threshold) return true
        scanned += 1
        if (scanned >= MAX_FILES) return true // err on rebuild for large trees
      }
    }
  }
  return false
}
