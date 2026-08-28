/**
 * Seed a published preinstall registry revision against the LIVE core Mongo,
 * so the client registry endpoint (/api/client/miniapps/registry) returns a
 * real, downloadable bundle. Mirrors tests/miniapp-release-lifecycle.integration.test.ts
 * but writes to the running dev DB instead of the throwaway test DB.
 *
 * Run FROM the cloud-v2/ directory (storage rootDir is `.cloud-v2-storage/core`
 * resolved relative to process.cwd(); the core runs with cwd=cloud-v2/, so seeding
 * from anywhere else writes the bundle where the core can't read it -> download 500):
 *   cd cloud-v2 && doppler run --project cloud-v2 --config dev -- bun scripts/seed-preinstall.ts
 */
import { readFileSync } from "node:fs";
import {
  connectMongo,
  disconnectMongo,
} from "../packages/store/src/connections/mongo.connection";
import { MiniAppModel } from "../packages/store/src/models/miniapp.model";
import { MiniAppService } from "../packages/store/src/services/miniapps/miniapp.service";
import { PreinstalledRegistryService } from "../packages/store/src/services/miniapps/preinstalled-registry.service";

const ENVIRONMENT = process.env.SEED_ENV ?? "dev";
const PACKAGE = "com.example.captions";
const VERSION = process.env.SEED_VERSION ?? "2.0.0";
const ADMIN = "admin@mentraglass.com";
const developer = {
  developerId: "dev_seed_user",
  email: "isaiah@mentra.glass",
  orgId: "org_seed_preinstall",
  packagePrefix: "com.example",
};

// A real zip bundle so the SHA-256 + mobile install path are valid.
const BUNDLE_PATH =
  process.env.SEED_BUNDLE ??
  ".cloud-v2-storage/core/miniapps/com.mentra.local-captions/releases/1.0.5/admin-preinstall-1781780396924-bundle.zip";

async function main() {
  const mongoUrl =
    process.env.MONGO_URL ?? "mongodb://127.0.0.1:27017/mentra-cloud-v2";
  await connectMongo(mongoUrl);
  // Log only safe metadata (host + db name); never the full URI, which can carry credentials.
  let mongoTarget = mongoUrl;
  try {
    const u = new URL(mongoUrl);
    mongoTarget = `${u.host}${u.pathname}`;
  } catch {
    // Non-URL connection string; fall back to a redacted marker rather than leaking it.
    mongoTarget = "<redacted>";
  }
  console.log(`connected mongo=${mongoTarget} env=${ENVIRONMENT}`);

  const miniapps = new MiniAppService();
  const registries = new PreinstalledRegistryService();

  const bundle = new Uint8Array(readFileSync(BUNDLE_PATH));
  console.log(`bundle=${BUNDLE_PATH} bytes=${bundle.byteLength}`);

  // 1) miniapp: createMiniApp is idempotent for the same developer/org (it
  // returns the existing app), so no error-swallowing is needed. It only throws
  // "package_taken" when the package is owned by another org or archived, which
  // is a real setup conflict that must surface rather than fail later at release.
  await miniapps.createMiniApp(developer, {
    packageName: PACKAGE,
    displayName: "Captions",
    description: "Seeded preinstall miniapp",
  });
  console.log(`created miniapp ${PACKAGE}`);

  // 2) release
  const release = await miniapps.createRelease(developer, {
    packageName: PACKAGE,
    version: VERSION,
    manifest: { packageName: PACKAGE, name: "Captions", version: VERSION },
    bundle,
    fileName: "bundle.zip",
  });
  console.log(`release id=${release.id} sha256=${release.bundleSha256}`);

  // 3) submit + approve
  await miniapps.submitRelease(developer, PACKAGE, release.id);
  await miniapps.approveRelease({ releaseId: release.id, adminId: ADMIN, notes: "seed" });
  console.log(`approved release ${release.id}`);

  // 4) registry (global, tenantId null -> matches the mentra client token)
  const registry = await registries.ensureRegistry({ adminId: ADMIN }, { environment: ENVIRONMENT });
  console.log(`registry id=${registry.id} env=${ENVIRONMENT}`);

  // 5) revision + promote
  const revision = await registries.createRevision({ adminId: ADMIN }, registry.id, {
    reason: "seed preinstall e2e",
    entries: [{ releaseId: release.id, installPolicy: "keep_updated", required: true }],
  });
  await registries.promoteRevision({ adminId: ADMIN }, registry.id, revision.id);
  console.log(`promoted revision ${revision.id}`);

  const savedApp = await MiniAppModel.findOne({ packageName: PACKAGE }).lean();
  console.log(`activeReleaseId=${savedApp?.activeReleaseId} expected=${release.id}`);

  console.log(`\nDONE: env=${ENVIRONMENT} package=${PACKAGE} version=${VERSION} sha256=${release.bundleSha256}`);
  await disconnectMongo();
}

main().catch(async (err) => {
  console.error("SEED FAILED:", err);
  await disconnectMongo().catch(() => {});
  process.exit(1);
});
