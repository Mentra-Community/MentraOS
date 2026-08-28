/**
 * Seed the Kawaii fixture into a preinstalled miniapp registry.
 *
 * This is intentionally tiny and deterministic: it creates/uses the
 * com.mentra.kawaii release whose zip is supplied by KAWAII_BUNDLE, then
 * promotes a registry revision containing that release.
 *
 * Example:
 *   cd cloud-v2
 *   SEED_ENV=dev KAWAII_BUNDLE=../miniapps/kawaii/build/com.mentra.kawaii-0.1.0.zip \
 *     doppler run --project cloud-v2 --config dev -- bun scripts/seed-kawaii-preinstall.ts
 */
import {connectMongo, disconnectMongo} from "../packages/store/src/connections/mongo.connection"
import {MiniAppReleaseModel} from "../packages/store/src/models/miniapp-release.model"
import {MiniAppService} from "../packages/store/src/services/miniapps/miniapp.service"
import {PreinstalledRegistryService} from "../packages/store/src/services/miniapps/preinstalled-registry.service"

const PACKAGE_NAME = "com.mentra.kawaii"
const DISPLAY_NAME = "Kawaii"
const ENVIRONMENT = process.env.SEED_ENV ?? "dev"
const VERSION = process.env.KAWAII_VERSION ?? "0.1.0"
const BUNDLE_PATH = process.env.KAWAII_BUNDLE ?? "../miniapps/kawaii/build/com.mentra.kawaii-0.1.0.zip"
const ADMIN_ID = process.env.SEED_ADMIN ?? "admin@mentraglass.com"

const developer = {
  developerId: "dev_kawaii_preinstall",
  email: "isaiah@mentra.glass",
  orgId: "org_kawaii_preinstall",
  packagePrefix: "com.mentra",
}

async function main() {
  const mongoUrl = process.env.MONGO_URL ?? "mongodb://127.0.0.1:27017/mentra-cloud-v2"
  await connectMongo(mongoUrl)
  console.log(`connected mongo=${mongoUrl} env=${ENVIRONMENT}`)

  try {
    const bundle = new Uint8Array(await Bun.file(BUNDLE_PATH).arrayBuffer())
    const manifest = JSON.parse(await Bun.file("../miniapps/kawaii/miniapp.json").text()) as {
      packageName: string
      name?: string
      version: string
    }

    if (manifest.packageName !== PACKAGE_NAME) {
      throw new Error(`bundle fixture package mismatch: ${manifest.packageName}`)
    }

    const miniapps = new MiniAppService()
    const registries = new PreinstalledRegistryService()

    await miniapps.createMiniApp(developer, {
      packageName: PACKAGE_NAME,
      displayName: DISPLAY_NAME,
      description: "Tiny fixture for preinstall and auto-update E2E checks.",
    })

    let release = await MiniAppReleaseModel.findOne({packageName: PACKAGE_NAME, version: VERSION}).lean()
    if (!release) {
      const created = await miniapps.createRelease(developer, {
        packageName: PACKAGE_NAME,
        version: VERSION,
        manifest: {...manifest, version: VERSION},
        bundle,
        fileName: "bundle.zip",
      })
      await miniapps.submitRelease(developer, PACKAGE_NAME, created.id)
      await miniapps.approveRelease({
        releaseId: created.id,
        adminId: ADMIN_ID,
        notes: "Kawaii preinstall fixture seed",
      })
      release = await MiniAppReleaseModel.findById(created.id).lean()
    }

    if (!release) throw new Error("release missing after seed")

    const registry = await registries.ensureRegistry(
      {adminId: ADMIN_ID},
      {environment: ENVIRONMENT as "debug" | "dev" | "staging" | "prod"},
    )
    const revision = await registries.createRevision({adminId: ADMIN_ID}, registry.id, {
      reason: `Seed Kawaii ${VERSION}`,
      entries: [{releaseId: release._id.toString(), installPolicy: "keep_updated", required: true}],
    })
    await registries.promoteRevision({adminId: ADMIN_ID}, registry.id, revision.id)

    console.log(
      JSON.stringify(
        {
          ok: true,
          environment: ENVIRONMENT,
          packageName: PACKAGE_NAME,
          version: VERSION,
          releaseId: release._id.toString(),
          revisionId: revision.id,
          bundleBytes: bundle.byteLength,
          bundleSha256: release.bundleSha256,
        },
        null,
        2,
      ),
    )
  } finally {
    await disconnectMongo()
  }
}

main().catch(async (error) => {
  console.error("seed kawaii preinstall failed:", error)
  await disconnectMongo().catch(() => {})
  process.exit(1)
})
