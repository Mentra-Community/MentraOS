/**
 * @fileoverview Local-only Mongo URLs for tests that must never touch a real database.
 *
 * `localTestMongoUrl` is the single entry point for tests that create their own
 * database. It reads `CLOUD_V2_TEST_MONGO_URL` (default: the replica set from
 * `docker-compose.test.yml`), refuses anything that is not a plain loopback
 * `mongodb://` URL without credentials, and returns a URL with a random
 * database name so concurrent runs and workspaces never share data.
 *
 * It deliberately ignores `MONGO_URL`: that variable is how shells, Doppler and
 * `.env` files point services at shared clusters, and a test must not inherit it.
 * Tests should drop their database in `afterAll`.
 */

import { randomBytes } from "node:crypto";

const DEFAULT_BASE_URL = "mongodb://127.0.0.1:27017";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost"]);
const MAX_PREFIX_LENGTH = 40;

function reject(reason: string): never {
  throw new Error(`CLOUD_V2_TEST_MONGO_URL must be a plain local mongodb:// URL (${reason})`);
}

/**
 * Build a connection URL for a fresh, randomly named database on local Mongo.
 *
 * The URL carries `directConnection=true`, so it works against a replica set
 * whose advertised member address is not reachable from the test process.
 *
 * @param prefix Database name prefix (letters, digits, `_`, `-`); the random suffix is appended.
 * @throws If the base URL is not `mongodb://127.0.0.1` or `mongodb://localhost`, carries
 *   credentials, a database name or options, or lists several hosts.
 */
export function localTestMongoUrl(prefix: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(prefix) || prefix.length > MAX_PREFIX_LENGTH) {
    throw new Error(
      `localTestMongoUrl prefix must be 1-${MAX_PREFIX_LENGTH} characters of letters, digits, "_" or "-"`,
    );
  }

  const base = process.env.CLOUD_V2_TEST_MONGO_URL || DEFAULT_BASE_URL;
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    return reject("not a valid URL");
  }

  if (url.protocol !== "mongodb:") reject("scheme must be mongodb:, not mongodb+srv:");
  if (url.username || url.password) reject("credentials are not allowed");
  if (!LOOPBACK_HOSTS.has(url.hostname.toLowerCase())) reject("host must be 127.0.0.1 or localhost");
  if (url.pathname !== "" && url.pathname !== "/") reject("do not include a database name");
  if (url.search || url.hash) reject("do not include options");

  const database = `${prefix}-${randomBytes(6).toString("hex")}`;
  return `mongodb://${url.host}/${database}?directConnection=true`;
}
