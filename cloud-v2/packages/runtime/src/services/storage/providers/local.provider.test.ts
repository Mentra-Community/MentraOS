import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat, utimes } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// The provider resolves its blob dir from the environment at import time, so
// pin it to a throwaway temp dir BEFORE importing the module under test.
const dir = await mkdtemp(join(tmpdir(), "local-provider-test-"));
process.env.CAMERA_LOCAL_DIR = dir;
const { createLocalProvider } = await import("./local.provider");

const provider = createLocalProvider();

/** Backdate a stored blob (and its sidecar) past the 30-minute TTL. */
async function expire(key: string): Promise<void> {
  const stale = new Date(Date.now() - 31 * 60_000);
  await utimes(join(dir, key), stale, stale);
  await utimes(join(dir, `${key}.type`), stale, stale).catch(() => undefined);
}

beforeAll(async () => {
  await provider.put!("photos/fresh", new Uint8Array([1, 2, 3]), "image/jpeg");
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("local provider blob TTL", () => {
  test("serves a fresh blob with its content type", async () => {
    const obj = await provider.get!("photos/fresh");
    expect(obj).not.toBeNull();
    expect([...obj!.bytes]).toEqual([1, 2, 3]);
    expect(obj!.contentType).toBe("image/jpeg");
    expect(await provider.exists("photos/fresh")).toBe(true);
  });

  test("an expired blob reads as gone and is deleted from disk", async () => {
    await provider.put!("photos/stale", new Uint8Array([9]), "image/jpeg");
    await expire("photos/stale");

    expect(await provider.exists("photos/stale")).toBe(false);
    expect(await provider.get!("photos/stale")).toBeNull();
    // The expired read reclaimed the files.
    await expect(stat(join(dir, "photos/stale"))).rejects.toThrow();
    await expect(stat(join(dir, "photos/stale.type"))).rejects.toThrow();
  });

  test("presigned URLs still point at the runtime blob route", async () => {
    const upload = await provider.presignUpload("photos/p1", {
      contentType: "image/jpeg",
      origin: "http://localhost:3001",
    });
    expect(upload.url).toBe("http://localhost:3001/api/camera/blob/photos/p1");
    expect(await provider.presignDownload("photos/p1", { origin: "http://localhost:3001" })).toBe(
      "http://localhost:3001/api/camera/blob/photos/p1",
    );
  });
});
