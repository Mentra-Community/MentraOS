/**
 * Shared production-build step used by `release` and `pack`.
 *
 * Both commands produce a distributable bundle, so both must agree on what
 * that means: `<pm> run build` with NODE_ENV=production. Build scripts read
 * process.env.NODE_ENV and substitute it via Bun.build's `define`, which
 * tree-shakes any `if (NODE_ENV === "development")` branches (dev panels,
 * debug overlays) out of the bundle. Without this, `pack` would silently
 * zip whatever mode the last build happened to be — usually a dev build
 * left behind by `mentra-miniapp dev`.
 */

import {existsSync, readFileSync} from 'fs'
import {join, resolve} from 'path'

export function detectPackageManager(cwd: string): 'bun' | 'pnpm' | 'yarn' | 'npm' {
  if (existsSync(join(cwd, 'bun.lock')) || existsSync(join(cwd, 'bun.lockb'))) return 'bun'
  if (existsSync(join(cwd, 'pnpm-lock.yaml'))) return 'pnpm'
  if (existsSync(join(cwd, 'yarn.lock'))) return 'yarn'
  return 'npm'
}

export function packageJsonHasBuildScript(cwd: string): boolean {
  const pkgPath = join(cwd, 'package.json')
  if (!existsSync(pkgPath)) return false
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
    return typeof pkg?.scripts?.build === 'string' && pkg.scripts.build.length > 0
  } catch {
    return false
  }
}

/**
 * Run `<pm> run build` with NODE_ENV=production and verify it produced
 * `dist/`. Exits the process with an error message on any failure.
 */
export async function buildProduction(cwd: string, options: {silent?: boolean} = {}): Promise<void> {
  const pm = detectPackageManager(cwd)
  if (!packageJsonHasBuildScript(cwd)) {
    console.error('Error: no "build" script in package.json. Add one (e.g. "build": "vite build") and re-run.')
    process.exit(1)
  }
  if (!options.silent) console.log(`Building with ${pm} run build...`)
  const buildStart = Date.now()
  const buildProc = Bun.spawn([pm, 'run', 'build'], {
    cwd,
    env: {...process.env, NODE_ENV: 'production'},
    stdout: options.silent ? 'ignore' : 'inherit',
    stderr: options.silent ? 'ignore' : 'inherit',
  })
  const buildCode = await buildProc.exited
  if (buildCode !== 0) {
    console.error('Error: build failed')
    process.exit(1)
  }
  const distDir = resolve(cwd, 'dist')
  if (!existsSync(distDir)) {
    console.error('Error: build succeeded but dist/ does not exist. Configure your bundler to output to dist/.')
    process.exit(1)
  }
  if (!options.silent) console.log(`✓ Built (${((Date.now() - buildStart) / 1000).toFixed(1)}s)`)
}
