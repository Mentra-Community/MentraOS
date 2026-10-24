import os from 'os';
import { readFileSync, existsSync, statSync, unlinkSync } from 'fs';
import { join, resolve } from 'path';
import { printQR, writeQRPng } from './qr.js';
import { warnIfPlaceholderIcon } from './icon.js';
import { validateManifest } from './manifest.js';
import { buildProjectSnapshot, startDevSidecar } from './dev-server.js';
import { getLanIp, getMdnsHostname } from './lan.js';
import { adbReverse, closeUsbTunnel, missingReversePorts, openUsbTunnel } from './adb.js';

const DEFAULT_DEV_PORT = 3000;
const DEV_PORT_SCAN_LIMIT = 50;
/** How often to re-check Wi-Fi / LAN IP while `mentra-miniapp dev` is running. */
const LAN_IP_POLL_MS = 2_000;
/**
 * How often to confirm the `adb reverse` mappings are still live. Slower than
 * the LAN poll because each check spawns an adb subprocess, and a dropped
 * tunnel only matters on the phone's next fetch.
 */
const USB_TUNNEL_POLL_MS = 5_000;
/** Where `adb reverse` publishes the laptop from the phone's point of view. */
const USB_LOOPBACK_HOST = '127.0.0.1';

export interface DevOptions {
  cwd?: string;
  qrOutput?: string;
  /**
   * Reach the phone over USB via `adb reverse` instead of the LAN. The QR
   * advertises loopback, so the phone does not need to share this computer's
   * Wi-Fi. Android only.
   */
  usb?: boolean;
  /** Target a specific `adb` device serial. Only meaningful with `usb`. */
  device?: string;
  /**
   * Watch source files and remount the phone WebView / respawn the
   * background JSContext on save. Default true. `--no-hot-reload` sets
   * this to false; the sidecar still forwards console logs.
   */
  hotReload?: boolean;
}

/** Where the dev server serves the project's ZIP, relative to the miniapp URL. */
export const DEV_BUNDLE_PATH = 'bundle.zip';

/**
 * The miniapp URL the QR encodes and `dev` prints: the dev server's root,
 * which serves miniapp.json like any miniapp URL. A LAN address, or loopback
 * over USB, so the Mentra App installs it as a local-network miniapp.
 */
export function buildDevUrl(host: string, port: number): string {
  const urlHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return `http://${urlHost}:${port}/`;
}

/** What the served miniapp.json's `development` field tells the phone about the dev server. */
export interface DevelopmentInfo {
  /** The sidecar's live-reload socket. Absent while the sidecar isn't running. */
  reload?: string;
  /** This computer's mDNS name, to reach it by when its LAN address changes. */
  mdns?: string;
}

/**
 * The miniapp.json the dev server serves: the ZIP's own, plus `bundle` naming
 * the ZIP and its SHA-256, as any miniapp URL serves, and `development`, which
 * the Mentra App reads only from a local-network URL.
 */
export function servedDevManifest(
  manifest: Record<string, unknown>,
  sha256: string,
  development: DevelopmentInfo,
): Record<string, unknown> {
  return { ...manifest, bundle: { url: DEV_BUNDLE_PATH, sha256 }, development };
}

export interface DevRequestHandlerOptions {
  /** The project root the server serves. */
  cwd: string;
  /** The sidecar's port, read on each request: null while it isn't running. */
  sidecarPort: () => number | null;
  /** This computer's mDNS name, if it has one. */
  mdnsHost: string | null;
  /**
   * Settles once no build is writing dist/, so a request never reads half a
   * build, and miniapp.json and the ZIP it names come from the same one.
   */
  idle?: () => Promise<void>;
}

const NO_STORE = 'no-store';

/**
 * Runs builds one at a time, in the order they were asked for, so two
 * triggers (a save and a LAN address change) never write dist/ at once.
 * `idle` settles once every build asked for so far has finished, failed ones
 * included.
 */
export function createBuildQueue(run: () => Promise<void>): { build: () => Promise<void>; idle: () => Promise<void> } {
  let tail: Promise<void> = Promise.resolve();
  return {
    build() {
      const next = tail.then(run);
      tail = next.catch(() => {});
      return next;
    },
    async idle() {
      let current: Promise<void>;
      do {
        current = tail;
        await current;
      } while (current !== tail);
    },
  };
}

/**
 * The static server's requests. `/miniapp.json` (and `/`) is the served
 * manifest, `/bundle.zip` the ZIP it names; any other path is a project file,
 * which live launches load `dist/` from.
 */
export function createDevRequestHandler(options: DevRequestHandlerOptions): (req: Request) => Promise<Response> {
  return async (req) => {
    await options.idle?.();
    const url = new URL(req.url);
    if (url.pathname === '/' || url.pathname === '/miniapp.json') {
      const snapshot = await buildProjectSnapshot(options.cwd);
      if (snapshot.manifest === null) return new Response('not found', { status: 404 });
      let manifest: unknown;
      try {
        manifest = JSON.parse(snapshot.manifest);
      } catch {
        manifest = null;
      }
      if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) {
        return new Response('miniapp.json is not a JSON object', { status: 500 });
      }
      const development: DevelopmentInfo = {};
      const sidecarPort = options.sidecarPort();
      // The host the phone reached this server by: the LAN address, loopback
      // over USB, or the mDNS name. The sidecar is on the same machine.
      if (sidecarPort) development.reload = `ws://${url.hostname}:${sidecarPort}/__mentra_dev`;
      // Lets the phone retry via ComputerName.local when the raw IP goes stale
      // after a Wi-Fi/DHCP change.
      if (options.mdnsHost) development.mdns = options.mdnsHost;
      const served = servedDevManifest(manifest as Record<string, unknown>, snapshot.sha256, development);
      return new Response(`${JSON.stringify(served, null, 2)}\n`, {
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': NO_STORE },
      });
    }
    if (url.pathname === `/${DEV_BUNDLE_PATH}` || url.pathname === '/__mentra_dev/bundle.zip') {
      const { zip } = await buildProjectSnapshot(options.cwd);
      const body = zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength) as ArrayBuffer;
      return new Response(body, {
        headers: {
          'content-type': 'application/zip',
          'content-length': String(zip.byteLength),
          'cache-control': NO_STORE,
        },
      });
    }
    // Strip leading slash and prevent ../ traversal. Path joining
    // against cwd already canonicalises, but we double-check by
    // refusing absolute paths and any segment starting with `..`.
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    if (rel.split('/').some((seg) => seg === '..')) {
      return new Response('forbidden', { status: 403 });
    }
    const abs = join(options.cwd, rel);
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
          'cache-control': NO_STORE,
        },
      });
    } catch {
      return new Response('not found', { status: 404 });
    }
  };
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
        'script — see examples/miniapp/build.ts for the canonical shape.',
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

  warnIfPlaceholderIcon(cwd);

  const name: string = (manifest.name as string) ?? 'unnamed';
  const packageName: string = (manifest.packageName as string) ?? 'unknown';
  const requestedPort: number = (manifest.port as number) ?? DEFAULT_DEV_PORT;
  const port = pickDevPort(requestedPort);

  console.log(`Starting dev server for ${name} (${packageName}) on port ${port}...`);
  if (port !== requestedPort) {
    console.log(`Port ${requestedPort} was unavailable; using ${port} instead.`);
  }

  // Every build goes through one queue, so the server can hold requests until
  // no build is writing dist/.
  const { build, idle } = createBuildQueue(() => runBuild(cwd));

  // Initial build before serving — a fresh `bun run dev` should always
  // start from a clean, current `dist/`.
  try {
    await build();
  } catch (err) {
    console.error('Initial build failed:', (err as Error).message);
    process.exit(1);
  }

  const mdnsHost = getMdnsHostname();
  let sidecarPort: number | null = null;

  // Static HTTP server on `port` serving the project root: the miniapp URL.
  // The phone fetches `miniapp.json`, then the `bundle.zip` it names, and
  // live launches load `dist/` files from here. Range requests aren't
  // supported — files are small and short-lived.
  const userServer = Bun.serve({
    hostname: '0.0.0.0',
    port,
    fetch: createDevRequestHandler({ cwd, sidecarPort: () => sidecarPort, mdnsHost, idle }),
  });

  // In USB mode the QR advertises loopback, so a missing LAN IP is the expected
  // case (laptop off Wi-Fi entirely) rather than a fatal one. It's still kept
  // when present, as the fallback if the ADB tunnel can't be established.
  let lanIp = getLanIp();
  if (!lanIp && !options.usb) {
    console.error('Warning: Could not detect LAN IP address');
    userServer.stop(true);
    process.exit(1);
  }

  // Sidecar on userPort + 1 — hosts the `__mentra_dev` WebSocket the
  // phone uses for live reload + console-log forwarding. The
  // `onBeforeBroadcast` hook rebuilds `dist/` before the phone is
  // notified, so the next `bundle.zip` fetch ships current code.
  // Failure here is non-fatal; the miniapp still runs without live reload.
  let sidecar: ReturnType<typeof startDevSidecar> | null = null;
  try {
    sidecar = startDevSidecar({
      port: port + 1,
      watchDir: cwd,
      hotReload: options.hotReload !== false,
      onBeforeBroadcast: async () => {
        try {
          await build();
        } catch (err) {
          console.error('Rebuild failed:', (err as Error).message);
        }
      },
    });
    sidecarPort = sidecar.port;
    if (options.hotReload === false) {
      console.log('Hot reload off. Restart without --no-hot-reload to remount the miniapp on save.');
    }
  } catch (err) {
    console.warn(
      `Warning: dev sidecar failed to start on port ${port + 1} (${(err as Error).message}). ` +
        `Live reload + console bridge will be disabled.`,
    );
  }

  // USB mode: publish this machine's ports on the phone's loopback so the QR
  // can point at 127.0.0.1. Done after the sidecar starts so we only tunnel a
  // port that something is actually listening on.
  const usbPorts: number[] = options.usb ? (sidecarPort ? [port, sidecarPort] : [port]) : [];
  let usbSerial: string | undefined;
  let usbActive = false;
  if (options.device && !options.usb) {
    console.warn('Warning: --device applies only with --usb. Ignoring it; the QR will use the LAN address.');
  }
  if (options.usb) {
    const tunnel = openUsbTunnel(usbPorts, { device: options.device });
    if (tunnel.ok) {
      usbActive = true;
      usbSerial = tunnel.serial;
      const portList = usbPorts.map((p) => `tcp:${p}`).join(', ');
      console.log(`USB: adb reverse active on ${portList}${usbSerial ? ` (${usbSerial})` : ''}`);
      if (!sidecarPort) {
        console.warn('Warning: dev sidecar is down, so live reload is unavailable over USB too.');
      }
    } else {
      console.error(`Error: --usb could not establish an ADB tunnel.\n  ${tunnel.reason}`);
      if (!lanIp) {
        sidecar?.stop();
        userServer.stop(true);
        process.exit(1);
      }
      console.warn(`Falling back to the LAN address ${lanIp} — the phone must share this computer's Wi-Fi.`);
    }
  }

  const printBanner = (): void => {
    console.log('\n╔══════════════════════════════════════════════════════════════╗');
    console.log('║  To test your miniapp on glasses:                            ║');
    console.log('║                                                              ║');
    console.log('║    1. Open the Mentra App on your phone                      ║');
    console.log('║    2. Settings → Miniapp Developer Settings                  ║');
    console.log('║    3. Tap "Scan Miniapp QR Code" and scan the QR below       ║');
    console.log('║                                                              ║');
    if (usbActive) {
      console.log('║  Your phone is reached over USB (adb reverse), not Wi-Fi.    ║');
      console.log('║  Keep the cable plugged in.                                  ║');
    } else {
      console.log('║  Your phone must be on the same Wi-Fi as this computer.      ║');
    }
    console.log('║                                                              ║');
    console.log('║  Scan once. Every saved change rebuilds and reloads on the   ║');
    console.log('║  phone, with no rescan. Keep this process running.           ║');
    console.log('║                                                              ║');
    console.log('║  Each package gets its own dev entry, so several dev         ║');
    console.log('║  miniapps can run side by side. The home screen caches the   ║');
    console.log('║  name and icon; rescan to update them.                       ║');
    console.log('║                                                              ║');
    console.log('║  For an install that runs without this computer:             ║');
    console.log('║    bun run release                                           ║');
    console.log('╚══════════════════════════════════════════════════════════════╝\n');
  };

  const defaultQrPath = join(os.tmpdir(), `mentra-dev-qr-${packageName}-${port}.png`);
  const qrOutputPath = resolve(options.qrOutput ?? defaultQrPath);
  const cleanupQrOnExit = !options.qrOutput;

  const emitQR = async (url: string): Promise<void> => {
    await printQR(url);
    const wrote = await writeQRPng(url, qrOutputPath);
    console.log(`\nMiniapp URL: ${url}`);
    if (wrote) {
      console.log(`PNG QR: ${qrOutputPath}\n`);
    } else {
      console.log(`PNG QR: (not written — see warning above)\n`);
    }
  };

  printBanner();
  if (mdnsHost) {
    console.log(`mDNS: ${mdnsHost} (phone can keep using this name across Wi-Fi IP changes)\n`);
  }
  // Loopback when the USB tunnel is up, otherwise the LAN IP. `lanIp` is
  // non-null here: the only path that leaves it null exits above unless the
  // tunnel came up. The QR is the plain miniapp URL and carries no credential.
  const devHost = usbActive ? USB_LOOPBACK_HOST : lanIp!;
  await emitQR(buildDevUrl(devHost, port));

  // Confirm the reverse mappings survive. They are dropped on unplug, on
  // `adb kill-server`, and on device reboot, and nothing notifies us — the
  // phone just silently stops reaching the laptop. Log the transitions only,
  // so a long unplug doesn't spam a line every tick.
  let usbTunnelHealthy = true;
  const usbTunnelInterval = usbActive
    ? setInterval(() => {
        const missing = missingReversePorts(usbPorts, { device: usbSerial });
        if (missing.length === 0) {
          if (!usbTunnelHealthy) {
            usbTunnelHealthy = true;
            console.log('USB: tunnel restored.');
          }
          return;
        }
        if (usbTunnelHealthy) {
          usbTunnelHealthy = false;
          const portList = missing.map((p) => `tcp:${p}`).join(', ');
          console.warn(`USB: tunnel lost (${portList}) — device unplugged or adb restarted. Retrying…`);
        }
        for (const p of missing) adbReverse(p, { device: usbSerial });
      }, USB_TUNNEL_POLL_MS)
    : null;

  // Monitor for LAN IP changes (e.g., Wi-Fi switch / DHCP renew).
  // Re-score interfaces — a VPN coming up must not steal the QR off Wi-Fi,
  // and a Wi-Fi roam must mint a new QR within a couple seconds.
  let ipCheckInFlight = false;
  const checkLanIpChange = (): void => {
    if (ipCheckInFlight) return;
    const newIp = getLanIp();
    if (!newIp || newIp === lanIp) return;
    ipCheckInFlight = true;
    void (async () => {
      try {
        console.log(`\n📶 LAN IP changed: ${lanIp} → ${newIp}`);
        console.log('Rebuilding so baked-in LAN URLs (e.g. signing endpoints) stay current…');
        try {
          await build();
        } catch (err) {
          // Leave lanIp on the previous value so the next poll retries this IP.
          // Committing early would leave dist/ stale while skipping further rebuilds.
          console.error('Rebuild after LAN IP change failed:', (err as Error).message);
          return;
        }
        const previous = lanIp;
        lanIp = newIp;
        console.log(`LAN IP committed: ${previous} → ${newIp}`);
        console.log('New QR (re-scan if the Mentra App still has the old IP):');
        printBanner();
        if (mdnsHost) {
          console.log(`mDNS: ${mdnsHost}\n`);
        }
        await emitQR(buildDevUrl(newIp, port));
      } finally {
        ipCheckInFlight = false;
      }
    })();
  };
  // Skipped under USB: the QR host is a fixed loopback address, and there are
  // no baked-in LAN URLs to keep current.
  const ipCheckInterval = usbActive ? null : setInterval(checkLanIpChange, LAN_IP_POLL_MS);

  const shutdown = () => {
    if (ipCheckInterval) clearInterval(ipCheckInterval);
    if (usbTunnelInterval) clearInterval(usbTunnelInterval);
    if (usbActive) closeUsbTunnel(usbPorts, { device: usbSerial });
    // Only remove the auto temp path — keep an explicit --qr-output artifact.
    if (cleanupQrOnExit) {
      try {
        unlinkSync(qrOutputPath);
      } catch {
        // best-effort cleanup of temp PNG
      }
    }
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
