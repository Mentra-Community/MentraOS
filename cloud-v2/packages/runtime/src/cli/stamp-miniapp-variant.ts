#!/usr/bin/env bun
/**
 * Stamp a customer variant into a prebuilt Mentra miniapp ZIP, for a
 * deployment that serves its own manifest and bundles instead of Runtime.
 *
 *   bun /app/cloud-v2/packages/runtime/src/cli/stamp-miniapp-variant.ts \
 *     com.mentra.call-2.1.62.zip --package-name com.acme.call \
 *     --backend-url https://call.acme.example [--out-dir .]
 *
 * Writes `<packageName>-<version>.zip` and prints the managed entry fields
 * (add `bundleUrl` on your workspace origin) and the backend environment that
 * the same pair sets. Runtime does the same itself from
 * DEPLOYMENT_MINIAPP_VARIANTS when it serves the bundles.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";

import { resolveMiniappVariant, stampMiniappVariant } from "../services/miniapp-variant";

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {
    "package-name": { type: "string" },
    "backend-url": { type: "string" },
    "source-package": { type: "string" },
    "out-dir": { type: "string", default: "." },
  },
});

const [sourceZip] = positionals;
if (!sourceZip || positionals.length !== 1) {
  console.error(
    "usage: stamp-miniapp-variant <source.zip> --package-name <name> --backend-url <https-url> [--out-dir <dir>]",
  );
  process.exit(2);
}

try {
  const zip = new Uint8Array(readFileSync(sourceZip));
  // The source package defaults to the ZIP's own name: `<packageName>-<version>.zip`.
  const source = values["source-package"] ?? basename(sourceZip).replace(/-\d+\.\d+\.\d+.*\.zip$/, "");
  const variant = resolveMiniappVariant(source, {
    packageName: values["package-name"],
    backendUrl: values["backend-url"],
  });
  if (!variant) throw new Error("the pair changes nothing: set --package-name, --backend-url or both");
  const stamped = stampMiniappVariant(zip, source, variant);
  const file = join(values["out-dir"]!, `${stamped.packageName}-${stamped.version}.zip`);
  writeFileSync(file, stamped.bytes);
  console.log(
    JSON.stringify(
      {
        file,
        managedEntry: { packageName: stamped.packageName, version: stamped.version, sha256: stamped.sha256 },
        backendEnvironment: {
          PACKAGE_NAME: stamped.packageName,
          ...(variant.backendUrl ? { PUBLIC_BASE_URL: variant.backendUrl } : {}),
        },
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
