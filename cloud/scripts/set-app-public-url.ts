/**
 * One-shot script: set an app's `publicUrl` (and matching `webhookURL`)
 * directly in the local cloud's MongoDB.
 *
 * Use when your tunnel URL changes and you don't want to deal with the
 * developer-console UI / dev session flow. The cloud's PhotoManager and
 * webhook plumbing both read `publicUrl` to tell the glasses where to
 * upload photos and where to deliver session/stop events — so a stale
 * value is the #1 cause of "Photo request timed out (30s)".
 *
 * Usage:
 *   MONGO_URL=mongodb://... bun run scripts/set-app-public-url.ts \
 *     com.mentra.okbeanieyolo \
 *     http://mentrayolo.share.zrok.io
 *
 * Or, from the cloud package root:
 *   bun run ../../scripts/set-app-public-url.ts <packageName> <publicUrl>
 */

import mongoose from "mongoose";

// Silence the noisy strictQuery deprecation warning — we don't query through
// the Mongoose ODM in this script (we hit collections directly), so the
// setting is irrelevant here.
mongoose.set("strictQuery", true);

const MONGO_URL = process.env.MONGO_URL;
if (!MONGO_URL) {
  console.error("MONGO_URL is not set. Source cloud/.env first or pass it inline.");
  process.exit(1);
}

const [, , rawPackageName, rawPublicUrl] = process.argv;

if (!rawPackageName) {
  console.error("Usage:");
  console.error("  bun run scripts/set-app-public-url.ts <packageName> [publicUrl]");
  console.error("");
  console.error("Examples:");
  console.error("  bun run scripts/set-app-public-url.ts com.mentra.okbeanieyolo");
  console.error("    → read-only: prints the current publicUrl + reachability test");
  console.error("  bun run scripts/set-app-public-url.ts com.mentra.okbeanieyolo https://mentrayolo.share.zrok.io");
  console.error("    → updates publicUrl in MongoDB after a reachability check");
  process.exit(1);
}

const packageName = rawPackageName.trim();
const publicUrl = rawPublicUrl ? rawPublicUrl.trim().replace(/\/+$/, "") : undefined;
const dryRun = !publicUrl;

if (publicUrl) {
  try {
    new URL(publicUrl);
  } catch {
    console.error(`Not a valid URL: ${publicUrl}`);
    process.exit(1);
  }
}

/**
 * Hit `${url}/api/health` to confirm the AppServer is reachable through the
 * provided URL. Returns true on 2xx, false otherwise. We use a short timeout
 * because zrok tunnels usually fail fast when not routing.
 */
async function pingHealth(url: string): Promise<{ ok: boolean; detail: string }> {
  const target = `${url}/api/health`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 7000);
  try {
    const res = await fetch(target, { signal: ctrl.signal, redirect: "follow" });
    clearTimeout(t);
    return {
      ok: res.ok,
      detail: `HTTP ${res.status} ${res.statusText} from ${target}`,
    };
  } catch (err) {
    clearTimeout(t);
    return {
      ok: false,
      detail: `${target} unreachable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

async function main(): Promise<void> {
  // Match what cloud/packages/cloud/src/connections/mongodb.connection.ts does
  // (default DB to "prod" when the URL has no db component).
  const url =
    MONGO_URL!.endsWith("/") || /\/[^/]+$/.test(new URL(MONGO_URL!).pathname) ? MONGO_URL! : MONGO_URL! + "/prod";

  console.log(`Connecting to ${url.replace(/:[^@]*@/, ":****@")}…`);
  await mongoose.connect(url);

  const apps = mongoose.connection.collection("apps");
  const before = await apps.findOne({ packageName });
  if (!before) {
    console.error(`No app found with packageName="${packageName}". Register it first via the dev console / CLI.`);
    await mongoose.disconnect();
    process.exit(2);
  }

  console.log("");
  console.log("Current values:");
  console.log(`  publicUrl  = ${before.publicUrl ?? "(unset)"}`);
  console.log(`  webhookURL = ${before.webhookURL ?? "(unset)"}`);

  // Always probe the *current* publicUrl, so the user can tell whether the
  // existing config is reachable before deciding to overwrite it.
  if (before.publicUrl) {
    console.log("");
    console.log(`Reachability test on current publicUrl…`);
    const probe = await pingHealth(before.publicUrl);
    console.log(`  ${probe.ok ? "✅ reachable" : "❌ unreachable"} — ${probe.detail}`);
  }

  if (dryRun) {
    console.log("");
    console.log("(read-only — no URL provided, nothing was changed)");
    await mongoose.disconnect();
    return;
  }

  // Helpful warning when downgrading https → http. Zrok shares default to
  // HTTPS in public mode, and going to plain http often breaks the upload
  // path silently.
  if (before.publicUrl?.startsWith("https://") && publicUrl!.startsWith("http://")) {
    console.warn("");
    console.warn(`⚠️  You're switching from https → http. Zrok tunnels are usually HTTPS;`);
    console.warn(`   if the upload path stops working, try the https variant instead.`);
  }

  console.log("");
  console.log(`Reachability test on new publicUrl (${publicUrl})…`);
  const newProbe = await pingHealth(publicUrl!);
  console.log(`  ${newProbe.ok ? "✅ reachable" : "❌ unreachable"} — ${newProbe.detail}`);
  if (!newProbe.ok) {
    console.warn("");
    console.warn("⚠️  Writing the value anyway, but if /api/health isn't reachable here,");
    console.warn("   the glasses won't be able to POST photos to /photo-upload either.");
  }

  const result = await apps.updateOne(
    { packageName },
    {
      $set: {
        publicUrl,
        webhookURL: `${publicUrl}/webhook`,
        updatedAt: new Date(),
      },
    },
  );

  const after = await apps.findOne({ packageName });

  console.log("");
  console.log(`Matched ${result.matchedCount}, modified ${result.modifiedCount}.`);
  console.log("After:");
  console.log(`  publicUrl  = ${after?.publicUrl}`);
  console.log(`  webhookURL = ${after?.webhookURL}`);
  console.log("");
  console.log("Done.");
  console.log("");
  console.log("PhotoManager now reads publicUrl fresh from MongoDB on every request,");
  console.log("so the new URL takes effect on the next photo capture without a cloud restart.");
  console.log("Other code paths (webhook delivery, uptime checks) still hit the 30s app-cache");
  console.log("refresh cycle — restart the cloud or wait ~30s if you need those updated too.");

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error("Failed:", err instanceof Error ? err.message : err);
  try {
    await mongoose.disconnect();
  } catch {
    // ignore
  }
  process.exit(3);
});
