#!/usr/bin/env bun
/**
 * Smart local dev entrypoint for Cloud V2.
 *
 * This is intentionally the teammate-friendly path:
 *   1. Check Doppler access to cloud-v2/dev.
 *   2. Start local Mongo + Redis.
 *   3. Start the integrated dev stack, which generates coherent local auth
 *      keys before Core and Runtime boot.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function step(message: string): void {
  console.log(`\x1b[2m->\x1b[0m ${message}`);
}

function ok(message: string): void {
  console.log(`\x1b[32m✓\x1b[0m ${message}`);
}

function fail(message: string): never {
  console.error(`\n\x1b[31mCloud V2 dev could not start.\x1b[0m\n${message}\n`);
  process.exit(1);
}

async function commandExists(command: string): Promise<boolean> {
  const proc = Bun.spawn(["sh", "-lc", `command -v ${command}`], {
    cwd: ROOT,
    stdout: "ignore",
    stderr: "ignore",
  });
  return (await proc.exited) === 0;
}

async function runInherited(
  args: string[],
  failureHelp: string,
  env?: Record<string, string>,
): Promise<void> {
  const proc = Bun.spawn(args, {
    cwd: ROOT,
    env: env ? { ...process.env, ...env } : process.env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await proc.exited;
  if (code !== 0) fail(failureHelp);
}

async function runCaptured(args: string[]): Promise<{ code: number; output: string }> {
  const proc = Bun.spawn(args, {
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, output: `${stdout}${stderr}`.trim() };
}

async function checkDoppler(): Promise<void> {
  step("checking Doppler access to cloud-v2/dev");

  if (!(await commandExists("doppler"))) {
    fail(
      [
        "Doppler CLI is not installed.",
        "",
        "Install it, then rerun:",
        "  brew install dopplerhq/cli/doppler",
        "  doppler login",
        "  bun run dev",
      ].join("\n"),
    );
  }

  const result = await runCaptured([
    "doppler",
    "secrets",
    "get",
    "SONIOX_API_KEY",
    "--project",
    "cloud-v2",
    "--config",
    "dev",
    "--plain",
  ]);

  if (result.code !== 0 || !result.output.trim()) {
    fail(
      [
        "Doppler is not ready for Cloud V2 real transcription.",
        "",
        "Run:",
        "  doppler login",
        "  doppler setup --project cloud-v2 --config dev",
        "",
        "Then confirm you have access to SONIOX_API_KEY in cloud-v2/dev.",
        "If that secret is missing or access is denied, ask for Doppler access to the cloud-v2 dev config.",
        "",
        result.output ? `Doppler said:\n${result.output}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  ok("Doppler cloud-v2/dev is available");
}

async function main(): Promise<void> {
  console.log("\nCloud V2 dev\n");
  await checkDoppler();

  step("starting local Mongo + Redis");
  await runInherited(
    ["bun", "scripts/setup.ts", "--test"],
    [
      "Local Mongo/Redis setup failed.",
      "",
      "Make sure Docker Desktop is running, then rerun:",
      "  bun run dev",
    ].join("\n"),
    { CLOUD_V2_SETUP_CALLER: "dev" },
  );

  step("starting Core + Store + Runtime + Test OEM");
  await runInherited(
    [
      "doppler",
      "run",
      "--project",
      "cloud-v2",
      "--config",
      "dev",
      "--",
      "bun",
      "scripts/dev-stack.ts",
    ],
    [
      "The integrated dev stack exited.",
      "",
      "Look at the error above. Common fixes:",
      "  - If SONIOX_API_KEY is missing, confirm Doppler cloud-v2/dev access.",
      "  - If a port is already in use, stop the old local cloud-v2 process.",
      "  - If Docker is down, start Docker Desktop and rerun bun run dev.",
    ].join("\n"),
  );
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
