import os from 'os';
import { readFileSync, existsSync, statSync } from 'fs';
import { join, resolve } from 'path';
import { printQR } from './qr.js';
import { validateManifest } from './manifest.js';
import { startDevSidecar } from './dev-server.js';

const DEFAULT_DEV_PORT = 3000;
const DEV_PORT_SCAN_LIMIT = 50;

export interface DevAttestationInput {
  packageName: string;
  devServerUrl: string;
}

export interface DevOptions {
  cwd?: string;
  signDevAttestation?: (input: DevAttestationInput) => string | Promise<string | null | undefined> | null | undefined;
}

function getLanIp(): string | null {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] ?? []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return null;
}

function contentTypeFor(path: string): string {
  if (path.endsWith('.json')) return 'application/json; charset=utf-8';
  if (path.endsWith('.html')) return 'text/html; charset=utf-8';
  if (path.endsWith('.js') || path.endsWith('.mjs')) return 'application/javascript; charset=utf-8';
  if (path.endsWith('.css')) return 'text/css; charset=utf-8';
  if (path.endsWith('.png')) return 'image/png';
  if (path.endsWith('.jpg') || path.endsWith('.jpeg')) return 'image/jpeg';
  if (path.endsWith('.svg')) return 'image/svg+xml';
  if (path.endsWith('.map')) return 'application/json; charset=utf-8';
  return 'application/octet-stream';
}

function canListenOnPort(port: number): boolean {
  try {
    const server = Bun.serve({
      hostname: '0.0.0.0',
      port,
      fetch: () => new Response(),
    });
    server.stop(true);
    return true;
  } catch {
    return false;
  }
}

function pickDevPort(start: number): number {
  for (let i = 0; i < DEV_PORT_SCAN_LIMIT; i++) {
    const port = start + i;
    if (canListenOnPort(port) && canListenOnPort(port + 1)) {
      return port;
    }
  }

  const end = start + DEV_PORT_SCAN_LIMIT - 1;
  console.error(
    `Error: no free adjacent dev port pair found between base ports ${start} and ${end}. ` +
      '`mentra-miniapp dev` needs one port for static files and the next port for live reload.',
  );
  process.exit(1);
}

/**
 * Run the project's build script. Two-layer projects ship a `build.ts` at
 * the project root that emits `dist/background/index.js` + `dist/ui/*`.
 * The sidecar's `bundle.zip` endpoint reads from disk, so the build must
 * finish before the phone fetches.
 */
async function runBuild(cwd: string): Promise<void> {
  const buildScript = resolve(cwd, 'build.ts');
  if (!existsSync(buildScript)) {
    throw new Error(
      'build.ts not found at project root. Two-layer miniapps emit ' +
        '`dist/background/index.js` + `dist/ui/index.html` via a build.ts ' +
        'script — see sdk/example-miniapp/build.ts for the canonical shape.',
    );
  }
  const proc = Bun.spawn(['bun', 'run', 'build.ts'], {
    cwd,
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`build.ts exited with code ${code}`);
  }
}

export async function dev(options: DevOptions = {}): Promise<void> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const manifestPath = resolve(cwd, 'miniapp.json');
  if (!existsSync(manifestPath)) {
    console.error('Error: miniapp.json not found in current directory');
    process.exit(1);
  }

  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
  } catch {
    console.error('Error: miniapp.json is not valid JSON');
    process.exit(1);
  }

  // Validate the manifest before launching. Dev miniapps are served
  // directly (not packed), so without this check a typo in permissions or
  // hardwareRequirements wouldn't surface until the miniapp tried to
  // subscribe on the phone — and the developer would have no idea why.
  const { valid, errors } = validateManifest(manifest);
  if (!valid) {
    console.error('miniapp.json validation failed:');
    for (const err of errors) {
      console.error(`  - ${err}`);
    }
    process.exit(1);
  }

  const entry = manifest.entry as { background?: string; ui?: string } | undefined;
  if (!entry || typeof entry.background !== 'string') {
    console.error(
      'Error: miniapp.json is missing `entry.background`. Two-layer miniapps ' +
        'must declare `entry.background` (and optionally `entry.ui`) — see ' +
        'sdk/docs/two-layer.md.',
    );
    process.exit(1);
  }

  const name: string = (manifest.name as string) ?? 'unnamed';
  const packageName: string = (manifest.packageName as string) ?? 'unknown';
  const requestedPort: number = (manifest.port as number) ?? DEFAULT_DEV_PORT;
  const port = pickDevPort(requestedPort);

  console.log(`Starting dev server for ${name} (${packageName}) on port ${port}...`);
  if (port !== requestedPort) {
    console.log(`Port ${requestedPort} was unavailable; using ${port} instead.`);
  }

  // Initial build before serving — a fresh `bun run dev` should always
  // start from a clean, current `dist/`.
  try {
    await runBuild(cwd);
  } catch (err) {
    console.error('Initial build failed:', (err as Error).message);
    process.exit(1);
  }

  // Static HTTP server on `port` serving the project root. The phone hits
  // `${devUrl}/miniapp.json` (reachability + manifest) and `${devUrl}/icon.png`
  // (icon preview) before falling through to the sidecar's `bundle.zip`
  // for the actual install. Range requests aren't supported — files are
  // small and short-lived.
  const userServer = Bun.serve({
    hostname: '0.0.0.0',
    port,
    fetch(req) {
      const url = new URL(req.url);
      // Strip leading slash and prevent ../ traversal. Path joining
      // against cwd already canonicalises, but we double-check by
      // refusing absolute paths and any segment starting with `..`.
      const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
      if (rel.split('/').some((seg) => seg === '..')) {
        return new Response('forbidden', { status: 403 });
      }
      const abs = rel === '' ? join(cwd, 'miniapp.json') : join(cwd, rel);
      try {
        const stat = statSync(abs);
        if (stat.isDirectory()) {
          // Index of a directory isn't useful for the phone — refuse.
          return new Response('not found', { status: 404 });
        }
        const buf = readFileSync(abs);
        return new Response(buf, {
          headers: {
            'content-type': contentTypeFor(abs),
            'cache-control': 'no-store',
          },
        });
      } catch {
        return new Response('not found', { status: 404 });
      }
    },
  });

  let lanIp = getLanIp();
  if (!lanIp) {
    console.error('Warning: Could not detect LAN IP address');
    userServer.stop(true);
    process.exit(1);
  }

  // Sidecar on userPort + 1 — hosts the `__mentra_dev` WebSocket the
  // phone uses for live reload + console-log forwarding. The
  // `onBeforeBroadcast` hook rebuilds `dist/` before the phone is
  // notified, so the next `bundle.zip` fetch ships current code.
  // Failure here is non-fatal; the miniapp still runs without live reload.
  let sidecarPort: number | null = null;
  let sidecar: ReturnType<typeof startDevSidecar> | null = null;
  try {
    sidecar = startDevSidecar({
      port: port + 1,
      watchDir: cwd,
      onBeforeBroadcast: async () => {
        try {
          await runBuild(cwd);
        } catch (err) {
          console.error('Rebuild failed:', (err as Error).message);
        }
      },
    });
    sidecarPort = sidecar.port;
  } catch (err) {
    console.warn(
      `Warning: dev sidecar failed to start on port ${port + 1} (${(err as Error).message}). ` +
        `Live reload + console bridge will be disabled.`,
    );
  }

  const buildDevUrl = async (ip: string): Promise<string> => {
    const devServerUrl = `http://${ip}:${port}`;
    const base = `miniapp://dev?url=${encodeURIComponent(devServerUrl)}&name=${encodeURIComponent(name)}&package=${encodeURIComponent(packageName)}`;
    const withDevPort = sidecarPort ? `${base}&dev=${sidecarPort}` : base;
    if (!options.signDevAttestation) return withDevPort;

    try {
      const attestation = await options.signDevAttestation({ packageName, devServerUrl });
      if (!attestation) return withDevPort;
      return `${withDevPort}&attestation=${encodeURIComponent(attestation)}`;
    } catch (error) {
      console.warn(`Warning: could not sign dev URL (${(error as Error).message}). Miniapp auto-auth will be unavailable.`);
      return withDevPort;
    }
  };

  const printBanner = (): void => {
    console.log('\n╔══════════════════════════════════════════════════════════════╗');
    console.log('║  To test your miniapp on glasses:                            ║');
    console.log('║                                                              ║');
    console.log('║    1. Open the Mentra App on your phone                      ║');
    console.log('║    2. Settings → Developer settings                          ║');
    console.log('║    3. Under "Mini App Development", tap                      ║');
    console.log('║       "Scan Mini App QR Code" and scan the QR below          ║');
    console.log('║                                                              ║');
    console.log('║  Your phone must be on the same Wi-Fi as this computer.      ║');
    console.log('║                                                              ║');
    console.log('║  Dev mode is live and temporary:                             ║');
    console.log('║    • Keep this process and computer running.                 ║');
    console.log('║    • Each package gets its own dev entry, so you can scan    ║');
    console.log('║      and test multiple dev miniapps side by side.            ║');
    console.log('║    • The Mentra App caches each miniapp name and icon.       ║');
    console.log('║                                                              ║');
    console.log('║  For a persistent install, run: bun run release              ║');
    console.log('╚══════════════════════════════════════════════════════════════╝\n');
  };

  printBanner();
  const devUrl = await buildDevUrl(lanIp);
  await printQR(devUrl);
  console.log(`\n${devUrl}\n`);

  // Monitor for LAN IP changes (e.g., WiFi switch).
  const ipCheckInterval = setInterval(async () => {
    const newIp = getLanIp();
    if (newIp && newIp !== lanIp) {
      lanIp = newIp;
      console.log(`\nLAN IP changed to ${newIp}. New QR:`);
      printBanner();
      const newDevUrl = await buildDevUrl(newIp);
      await printQR(newDevUrl);
      console.log(`\n${newDevUrl}\n`);
    }
  }, 10_000);

  const shutdown = () => {
    clearInterval(ipCheckInterval);
    sidecar?.stop();
    userServer.stop(true);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Keep the process alive — the static server + sidecar hold the loop.
  // Block on a never-resolving promise so the foreground stays on the
  // dev process until SIGINT/SIGTERM fires.
  await new Promise<void>(() => {});
}
