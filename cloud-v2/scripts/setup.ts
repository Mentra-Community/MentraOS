#!/usr/bin/env bun
/**
 * Cloud V2 local dev setup pre-flight.
 *
 * Checks the host has everything it needs, then starts the local Redis
 * container. Idempotent — safe to run repeatedly.
 *
 * Future additions (tracked under their own tickets):
 * - OS-1490: Doppler auth check + secrets pull
 * - OS-1491: Mongo schema migrations against the dev cluster
 */

import { $ } from "bun";

const REDIS_CONTAINER = "cloud-v2-redis-dev";
const MIN_BUN_MAJOR = 1;
const MIN_BUN_MINOR = 2;

function step(msg: string) {
  console.log(`\x1b[2m→\x1b[0m ${msg}`);
}

function ok(msg: string) {
  console.log(`\x1b[32m✓\x1b[0m ${msg}`);
}

function fail(msg: string): never {
  console.error(`\x1b[31m✗\x1b[0m ${msg}`);
  process.exit(1);
}

async function checkBunVersion() {
  step(`checking Bun version (need >=${MIN_BUN_MAJOR}.${MIN_BUN_MINOR}.0)`);
  const v = Bun.version;
  const [maj, min] = v.split(".").map((n) => Number.parseInt(n, 10));
  if (Number.isNaN(maj) || Number.isNaN(min)) {
    fail(`could not parse Bun version: ${v}`);
  }
  if (maj < MIN_BUN_MAJOR || (maj === MIN_BUN_MAJOR && min < MIN_BUN_MINOR)) {
    fail(
      `Bun ${v} is too old. Upgrade: \`curl -fsSL https://bun.sh/install | bash\``,
    );
  }
  ok(`Bun ${v}`);
}

async function checkDocker() {
  step("checking Docker is running");
  try {
    await $`docker info`.quiet();
  } catch {
    fail(
      "Docker is not running. Start Docker Desktop (or your Docker daemon) and re-run.",
    );
  }
  ok("Docker available");
}

async function startRedis() {
  step("starting Redis container (docker-compose.dev.yml)");
  try {
    await $`docker compose -f docker-compose.dev.yml up -d redis`.quiet();
  } catch (err) {
    fail(`docker compose failed: ${err}`);
  }

  step("waiting for Redis to respond to PING");
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const result = await $`docker exec ${REDIS_CONTAINER} redis-cli PING`
        .quiet()
        .text();
      if (result.trim() === "PONG") {
        ok("Redis ready at localhost:6379");
        return;
      }
    } catch {
      // not ready yet, retry
    }
    await Bun.sleep(200);
  }
  fail("Redis did not respond to PING within 10s. Check `docker ps` and `docker logs cloud-v2-redis-dev`.");
}

async function main() {
  console.log("\nCloud V2 dev setup\n");
  await checkBunVersion();
  await checkDocker();
  await startRedis();
  console.log(
    "\n\x1b[32mReady.\x1b[0m Next:\n" +
      "  \x1b[2m# in separate terminals\x1b[0m\n" +
      "  bun run dev:core\n" +
      "  bun run dev:audio\n" +
      "  bun run dev:proxy\n",
  );
}

main().catch((err) => {
  fail(err instanceof Error ? err.message : String(err));
});
