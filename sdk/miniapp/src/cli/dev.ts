import os from 'os';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { printQR } from './qr.js';

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
      await fetch(`http://localhost:${port}`);
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

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
  const name: string = manifest.name ?? 'unnamed';
  const packageName: string = manifest.packageName ?? 'unknown';
  const port: number = manifest.port ?? 3000;

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

  const devUrl = `mentra-miniapp://dev?url=${encodeURIComponent(`http://${lanIp}:${port}`)}&name=${encodeURIComponent(name)}&package=${encodeURIComponent(packageName)}`;

  console.log('\n--- Dev server ready ---\n');
  printQR(devUrl);
  console.log(`\n${devUrl}\n`);

  // Monitor for LAN IP changes (e.g., WiFi switch)
  const ipCheckInterval = setInterval(() => {
    const newIp = getLanIp();
    if (newIp && newIp !== lanIp) {
      lanIp = newIp;
      const newDevUrl = `mentra-miniapp://dev?url=${encodeURIComponent(`http://${newIp}:${port}`)}&name=${encodeURIComponent(name)}&package=${encodeURIComponent(packageName)}`;
      console.log(`\nLAN IP changed to ${newIp}. New QR:\n`);
      printQR(newDevUrl);
      console.log(`\n${newDevUrl}\n`);
    }
  }, 10_000); // check every 10s

  // Clean up IP monitor on exit
  process.on('SIGINT', () => {
    clearInterval(ipCheckInterval);
    child.kill();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    clearInterval(ipCheckInterval);
    child.kill();
    process.exit(0);
  });

  // Keep the process alive until the child exits
  await child.exited;
}
