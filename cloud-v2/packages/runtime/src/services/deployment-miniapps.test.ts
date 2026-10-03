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

async function fixture(
  overrides: {
    sha256?: string;
    version?: string;
    bundleUrl?: string;
    runtimeUrl?: string | null;
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "mentra-miniapps-"));
  temporaryDirectories.push(directory);
  const bytes = new TextEncoder().encode("verified miniapp zip");
  await writeFile(join(directory, "remoteassist-1.2.0.zip"), bytes);
  const digest = createHash("sha256").update(bytes).digest("hex");
  return {
    directory,
    manifest: JSON.stringify({
      services: {
        coreUrl: null,
        runtimeUrl:
          overrides.runtimeUrl === undefined
            ? "https://workspace.example"
            : overrides.runtimeUrl,
      },
      miniapps: {
        managed: [
          {
            packageName: "com.example.remoteassist",
            version: overrides.version ?? "1.2.0",
            bundleUrl:
              overrides.bundleUrl ??
              "https://workspace.example/miniapps/remoteassist-1.2.0.zip",
            sha256: overrides.sha256 ?? digest,
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
    const value = await fixture({ sha256: "0".repeat(64) });

    await expect(
      loadDeploymentMiniappBundles(value.manifest, value.directory),
    ).rejects.toThrow("SHA-256 mismatch");
  });

  test("accepts canonical prerelease versions", async () => {
    const value = await fixture({ version: "1.2.0-rc.1" });

    await expect(
      loadDeploymentMiniappBundles(value.manifest, value.directory),
    ).resolves.toHaveLength(1);
  });

  test("accepts canonical build metadata", async () => {
    const value = await fixture({ version: "1.2.0+build.7" });

    await expect(
      loadDeploymentMiniappBundles(value.manifest, value.directory),
    ).resolves.toHaveLength(1);
  });

  test.each(["v1.2.0", "1.2", "01.2.0", "1.2.0-01", "1.2.0+", " 1.2.0"])(
    "rejects non-canonical version %j",
    async (version) => {
      const value = await fixture({ version });

      await expect(
        loadDeploymentMiniappBundles(value.manifest, value.directory),
      ).rejects.toThrow("canonical SemVer");
    },
  );

  test("rejects a bundle URL that is not served over HTTPS", async () => {
    const value = await fixture({
      bundleUrl: "http://workspace.example/miniapps/remoteassist-1.2.0.zip",
    });

    await expect(
      loadDeploymentMiniappBundles(value.manifest, value.directory),
    ).rejects.toThrow("must use https");
  });

  test("rejects a bundle URL on another origin than the Runtime", async () => {
    const value = await fixture({
      bundleUrl: "https://cdn.example/miniapps/remoteassist-1.2.0.zip",
    });

    await expect(
      loadDeploymentMiniappBundles(value.manifest, value.directory),
    ).rejects.toThrow("share the Runtime origin https://workspace.example");
  });

  test("requires services.runtimeUrl when managed bundles are declared", async () => {
    const value = await fixture({ runtimeUrl: null });

    await expect(
      loadDeploymentMiniappBundles(value.manifest, value.directory),
    ).rejects.toThrow("require services.runtimeUrl");
  });
});
