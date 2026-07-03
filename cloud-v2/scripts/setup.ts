#!/usr/bin/env bun
/**
 * Cloud V2 local dev setup pre-flight.
 *
 * Checks the host has everything it needs, then starts the local containers.
 * Idempotent — safe to run repeatedly.
 *
 * Modes:
 *   `bun scripts/setup.ts`        — dev (Redis only, Mongo via Atlas)
 *   `bun scripts/setup.ts --test` — test (Redis + Mongo locally)
 *
 * Future additions (tracked under their own tickets):
 * - OS-1490: Doppler auth check + secrets pull
 * - OS-1491: Mongo schema migrations against the dev cluster
 */

import { $ } from "bun";

const TEST_MODE = process.argv.includes("--test");
const COMPOSE_FILE = TEST_MODE ? "docker-compose.test.yml" : "docker-compose.dev.yml";
const REDIS_CONTAINER = TEST_MODE ? "cloud-v2-redis-test" : "cloud-v2-redis-dev";
const MONGO_CONTAINER = "cloud-v2-mongo-test";
const MIN_BUN_MAJOR = 1;
const MIN_BUN_MINOR = 3;

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

async function startContainers() {
  step(`starting containers from ${COMPOSE_FILE}`);
  try {
    await $`docker compose -f ${COMPOSE_FILE} up -d`.quiet();
  } catch (err) {
    fail(`docker compose failed: ${err}`);
  }

  step("waiting for Redis to respond to PING");
  const redisDeadline = Date.now() + 10_000;
  while (Date.now() < redisDeadline) {
    try {
      const result = await $`docker exec ${REDIS_CONTAINER} redis-cli PING`
        .quiet()
        .text();
      if (result.trim() === "PONG") {
        ok(`Redis ready at localhost:6379`);
        break;
      }
    } catch {
      // not ready yet, retry
    }
    await Bun.sleep(200);
  }
  if (Date.now() >= redisDeadline) {
    fail(
      `Redis did not respond to PING within 10s. Check \`docker logs ${REDIS_CONTAINER}\`.`,
    );
  }

  if (TEST_MODE) {
    step("waiting for Mongo to respond to ping");
    const mongoDeadline = Date.now() + 15_000;
    while (Date.now() < mongoDeadline) {
      try {
        const result = await $`docker exec ${MONGO_CONTAINER} mongosh --quiet --eval "db.runCommand({ping:1}).ok"`
          .quiet()
          .text();
        if (result.trim() === "1") {
          ok(`Mongo ready at localhost:27017`);
          return;
        }
      } catch {
        // not ready
      }
      await Bun.sleep(300);
    }
    fail(
      `Mongo did not respond within 15s. Check \`docker logs ${MONGO_CONTAINER}\`.`,
    );
  }
}

async function main() {
  console.log(`\nCloud V2 ${TEST_MODE ? "test" : "dev"} setup\n`);
  await checkBunVersion();
  await checkDocker();
  await startContainers();

  if (TEST_MODE) {
    if (process.env.CLOUD_V2_SETUP_CALLER === "dev") {
      console.log("\n\x1b[32mReady.\x1b[0m Starting Cloud V2 dev stack.\n");
    } else {
      console.log(
        "\n\x1b[32mReady.\x1b[0m Run tests:\n" +
          "  bun test                       # whole suite\n" +
          "  bun test tests/audio*          # just audio tests\n" +
          "\n  When done: \x1b[2mdocker compose -f docker-compose.test.yml down\x1b[0m\n",
      );
    }
  } else {
    console.log(
      "\n\x1b[32mReady.\x1b[0m Next:\n" +
        "  bun run dev\n",
    );
  }
}

main().catch((err) => {
  fail(err instanceof Error ? err.message : String(err));
});
