/**
 * @fileoverview Real Cloudflare R2 storage round-trip (no mocks).
 *
 * Exercises the s3 storage provider against a real R2 bucket: presign an upload,
 * PUT real bytes, confirm the object exists, read it back through a presigned
 * download URL, assert byte-for-byte equality, then delete it. Uses a
 * `cloud-v2-storage-test/` key prefix and cleans up after itself.
 *
 * Gated on R2 credentials in the env (the s3 provider reads STORAGE_S3_*, R2_*,
 * or the v1 CLOUDFLARE_R2_* names). The cloud-v2 Doppler config has them, so:
 *   doppler run --project cloud-v2 --config dev -- bun test tests/storage.r2.integration.test.ts
 * Without creds the suite skips.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { createS3Provider } from "../packages/runtime/src/services/storage/providers/s3.provider";

const HAS_ENDPOINT = !!(
  process.env.STORAGE_S3_ENDPOINT ||
  process.env.R2_ENDPOINT ||
  process.env.CLOUDFLARE_R2_S3_ENDPOINT
);
const HAS_KEY = !!(
  process.env.STORAGE_S3_ACCESS_KEY_ID ||
  process.env.R2_ACCESS_KEY_ID ||
  process.env.CLOUDFLARE_R2_ACCESS_KEY_ID
);
const RUN = HAS_ENDPOINT && HAS_KEY;

if (!RUN) {
  console.log(
    "[storage.r2] skipped (no R2 creds). Run with: doppler run --project cloud-v2 --config dev -- bun test tests/storage.r2.integration.test.ts",
  );
}

describe.skipIf(!RUN)("Cloudflare R2 storage (real round-trip)", () => {
  const provider = createS3Provider();
  const key = `cloud-v2-storage-test/${process.pid}-${Date.now()}.bin`;
  const bytes = new Uint8Array(256);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31) & 0xff;

  afterAll(async () => {
    await provider.delete(key).catch(() => undefined);
  });

  test("presign + upload + exists + read-back + delete", async () => {
    // 1. Presigned PUT, then upload real bytes straight to R2.
    const up = await provider.presignUpload(key, {
      contentType: "application/octet-stream",
    });
    const put = await fetch(up.url, {
      method: "PUT",
      headers: up.headers,
      body: bytes,
    });
    expect(put.ok).toBe(true);

    // 2. The object exists in the bucket.
    expect(await provider.exists(key)).toBe(true);

    // 3. Presigned GET reads back the EXACT bytes.
    const readUrl = await provider.presignDownload(key);
    const got = await fetch(readUrl);
    expect(got.ok).toBe(true);
    const back = new Uint8Array(await got.arrayBuffer());
    expect(back).toEqual(bytes);

    // 4. Delete cleans it up.
    await provider.delete(key);
    expect(await provider.exists(key)).toBe(false);
  }, 30_000);
});
