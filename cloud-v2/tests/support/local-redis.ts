/**
 * @fileoverview Local-only Redis URLs for tests that delete Redis keys.
 *
 * The runtime suites clear audio, session-tag and ownership keys between cases.
 * `localTestRedisUrl` reads `CLOUD_V2_TEST_REDIS_URL` (default: Redis on
 * 127.0.0.1:6379), refuses anything that is not a plain loopback `redis://` URL
 * without credentials, and returns a URL for one logical database on it.
 *
 * `REDIS_URL` is how shells, Doppler and `.env` files point services at shared
 * servers, and a test must not inherit it. Suites assign the result to
 * `process.env.REDIS_URL`, so the runtime and any spawned pods use the local
 * server too. When the shell already set `REDIS_URL`, that assignment does not
 * reach the runtime's audio workers: a Bun `Worker` keeps the value the process
 * started with for a variable that was already set (whatever its `env` option
 * says). The workers would then read keys on a different server or database
 * from the one the suite clears. So a `REDIS_URL` the process started with is
 * refused rather than ignored, even a local one.
 */

const DEFAULT_BASE_URL = "redis://127.0.0.1:6379";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost"]);
// Redis's default `databases` setting.
const DATABASE_COUNT = 16;
// Read once, when the first suite imports this module and before any suite
// assigns its own URL: the value the process (and so every Bun worker) started with.
const STARTUP_REDIS_URL = process.env.REDIS_URL;

function reject(name: string, reason: string): never {
  throw new Error(`${name} must be a plain local redis:// URL (${reason})`);
}

/** Throws unless `value` is a credential-free `redis://` URL for 127.0.0.1 or localhost. */
function assertLocal(name: string, value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    // Not echoed: an unparsable URL may still hold a password.
    return reject(name, "not a valid URL");
  }

  if (url.protocol !== "redis:") reject(name, "scheme must be redis:, not rediss:");
  if (url.username || url.password) reject(name, "credentials are not allowed");
  if (!LOOPBACK_HOSTS.has(url.hostname.toLowerCase())) reject(name, "host must be 127.0.0.1 or localhost");
  if (url.pathname !== "" && url.pathname !== "/") reject(name, "do not include a database number");
  if (url.search || url.hash) reject(name, "do not include options");
  return url;
}

/**
 * Build a connection URL for logical database `database` on local Redis.
 *
 * @param database Logical database number, 0-15. Suites use different numbers
 *   so they can run side by side.
 * @throws If the base URL is not `redis://127.0.0.1` or `redis://localhost`,
 *   carries credentials, a database number or options; if the process started
 *   with `REDIS_URL` set; or if `database` is out of range.
 */
export function localTestRedisUrl(database: number): string {
  if (!Number.isInteger(database) || database < 0 || database >= DATABASE_COUNT) {
    throw new Error(`localTestRedisUrl database must be an integer from 0 to ${DATABASE_COUNT - 1}`);
  }

  if (STARTUP_REDIS_URL) {
    // Not echoed: it may hold a password.
    throw new Error(
      "Unset REDIS_URL to run this suite: the runtime's Bun workers would keep it. Use CLOUD_V2_TEST_REDIS_URL for a local Redis.",
    );
  }

  const url = assertLocal("CLOUD_V2_TEST_REDIS_URL", process.env.CLOUD_V2_TEST_REDIS_URL || DEFAULT_BASE_URL);
  return `redis://${url.host}/${database}`;
}
