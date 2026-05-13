// Shared helpers for release scripts.

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run an async fn with retries and exponential backoff. Designed for network
 * calls (gh release upload, fastlane google_play, altool, sentry-cli) that
 * occasionally fail with transient TLS/connection errors.
 *
 * Usage:
 *   await withRetry('Upload APK', () => $`gh release upload ...`);
 */
export async function withRetry(label, fn, { attempts = 4, baseDelayMs = 3000 } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === attempts) break;
      const delay = baseDelayMs * Math.pow(2, attempt - 1);
      console.warn(`\n⚠️  ${label} failed (attempt ${attempt}/${attempts}): ${err?.message || err}`);
      console.warn(`   Retrying in ${Math.round(delay / 1000)}s...`);
      await sleep(delay);
    }
  }
  console.error(`\n❌ ${label} failed after ${attempts} attempts.`);
  throw lastErr;
}
