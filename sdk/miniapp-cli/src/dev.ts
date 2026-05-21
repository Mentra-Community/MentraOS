import os from 'os';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { printQR } from './qr.js';
import { validateManifest } from './manifest.js';
import { startDevSidecar } from './dev-server.js';

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

async function waitForPort(port: number, retries = 30, delayMs = 500): Promise<void> {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(`http://localhost:${port}`);
      // Any response means the server is up
      return;
    } catch {
      await Bun.sleep(delayMs);
    }
  }
  throw new Error(`Server did not become reachable on port ${port} after ${retries} attempts`);
}

export async function dev(): Promise<void> {
  const manifestPath = resolve(process.cwd(), 'miniapp.json');
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

  // Validate the manifest before launching the dev server. Dev miniapps are
  // served directly (not packed), so without this check a typo in permissions
  // or hardwareRequirements wouldn't surface until the miniapp tried to
  // subscribe on the phone — and the developer would have no idea why.
  const { valid, errors } = validateManifest(manifest);
  if (!valid) {
    console.error('miniapp.json validation failed:');
    for (const err of errors) {
      console.error(`  - ${err}`);
    }
    process.exit(1);
  }

  const name: string = (manifest.name as string) ?? 'unnamed';
  const packageName: string = (manifest.packageName as string) ?? 'unknown';
  const port: number = (manifest.port as number) ?? 3000;

  console.log(`Starting dev server for ${name} (${packageName}) on port ${port}...`);

  const child = Bun.spawn(['bun', 'run', '--hot', 'server.ts'], {
    cwd: process.cwd(),
    stdout: 'inherit',
    stderr: 'inherit',
    stdin: 'inherit',
  });

  try {
    await waitForPort(port);
  } catch (err) {
    console.error((err as Error).message);
    child.kill();
    process.exit(1);
  }

  let lanIp = getLanIp();
  if (!lanIp) {
    console.error('Warning: Could not detect LAN IP address');
    child.kill();
    process.exit(1);
  }

  // Start the sidecar dev server on userPort + 1 — it hosts the __mentra_dev
  // WebSocket the phone uses for live reload + console-log forwarding.
  // Failure here is non-fatal; the miniapp still runs without live reload.
  let sidecarPort: number | null = null;
  let sidecar: ReturnType<typeof startDevSidecar> | null = null;
  try {
    sidecar = startDevSidecar({
      port: port + 1,
      watchDir: process.cwd(),
    });
    sidecarPort = sidecar.port;
  } catch (err) {
    console.warn(
      `Warning: dev sidecar failed to start on port ${port + 1} (${(err as Error).message}). ` +
      `Live reload + console bridge will be disabled.`,
    );
  }

  const buildDevUrl = (ip: string) => {
    const base = `mentra-miniapp://dev?url=${encodeURIComponent(`http://${ip}:${port}`)}&name=${encodeURIComponent(name)}&package=${encodeURIComponent(packageName)}`;
    return sidecarPort ? `${base}&dev=${sidecarPort}` : base;
  };

  const printBanner = (): void => {
    console.log('\n╔══════════════════════════════════════════════════════════════╗');
    console.log('║  To test your mini app on glasses:                           ║');
    console.log('║                                                              ║');
    console.log('║    1. Open the Mentra app on your phone                      ║');
    console.log('║    2. Settings → Developer settings                          ║');
    console.log('║    3. Under "Mini App Development", tap                      ║');
    console.log('║       "Scan Mini App QR Code" and scan the QR below          ║');
    console.log('║                                                              ║');
    console.log('║  Your phone must be on the same Wi-Fi as this computer.      ║');
    console.log('╚══════════════════════════════════════════════════════════════╝\n');
  };

  printBanner();
  const devUrl = buildDevUrl(lanIp);
  printQR(devUrl);
  console.log(`\n${devUrl}\n`);

  // Monitor for LAN IP changes (e.g., WiFi switch)
  const ipCheckInterval = setInterval(() => {
    const newIp = getLanIp();
    if (newIp && newIp !== lanIp) {
      lanIp = newIp;
      console.log(`\nLAN IP changed to ${newIp}. New QR:`);
      printBanner();
      const newDevUrl = buildDevUrl(newIp);
      printQR(newDevUrl);
      console.log(`\n${newDevUrl}\n`);
    }
  }, 10_000); // check every 10s

  // Clean up IP monitor + sidecar on exit
  process.on('SIGINT', () => {
    clearInterval(ipCheckInterval);
    sidecar?.stop();
    child.kill();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    clearInterval(ipCheckInterval);
    sidecar?.stop();
    child.kill();
    process.exit(0);
  });

  // Keep the process alive until the child exits
  await child.exited;
}
