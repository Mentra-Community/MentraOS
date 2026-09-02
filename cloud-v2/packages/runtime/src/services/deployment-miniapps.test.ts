import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { loadDeploymentMiniappBundles } from "./deployment-miniapps";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture(sha256?: string) {
  const directory = await mkdtemp(join(tmpdir(), "mentra-miniapps-"));
  temporaryDirectories.push(directory);
  const bytes = new TextEncoder().encode("verified miniapp zip");
  await writeFile(join(directory, "remoteassist-1.2.0.zip"), bytes);
  const digest = createHash("sha256").update(bytes).digest("hex");
  return {
    directory,
    manifest: JSON.stringify({
      miniapps: {
        managed: [
          {
            packageName: "com.example.remoteassist",
            version: "1.2.0",
            bundleUrl:
              "https://workspace.example/miniapps/remoteassist-1.2.0.zip",
            sha256: sha256 ?? digest,
          },
        ],
      },
    }),
  };
}

describe("Runtime deployment miniapp assets", () => {
  test("loads a manifest-pinned same-origin bundle", async () => {
    const value = await fixture();
    const bundles = await loadDeploymentMiniappBundles(
      value.manifest,
      value.directory,
    );

    expect(bundles).toHaveLength(1);
    expect(bundles[0].path).toBe("/miniapps/remoteassist-1.2.0.zip");
    expect(await bundles[0].body.text()).toBe("verified miniapp zip");
  });

  test("rejects a file whose SHA-256 does not match the manifest", async () => {
    const value = await fixture("0".repeat(64));

    await expect(
      loadDeploymentMiniappBundles(value.manifest, value.directory),
    ).rejects.toThrow("SHA-256 mismatch");
  });
});
