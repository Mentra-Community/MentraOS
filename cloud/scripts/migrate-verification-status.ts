/**
 * Migration script: Set verificationStatus for existing apps.
 *
 * - All apps with appStoreStatus === "PUBLISHED" → verificationStatus = "VERIFIED"
 * - All other apps keep the default "NONE" (set by schema default)
 *
 * Run with: bun run scripts/migrate-verification-status.ts
 *
 * Or run directly in MongoDB shell:
 *   db.apps.updateMany(
 *     { appStoreStatus: "PUBLISHED", verificationStatus: { $ne: "VERIFIED" } },
 *     { $set: { verificationStatus: "VERIFIED" } }
 *   )
 */

import mongoose from "mongoose";

const MONGODB_URI = process.env.MONGODB_URI || "mongodb://localhost:27017/augmentos";

async function migrate() {
  console.log(`Connecting to MongoDB: ${MONGODB_URI.replace(/\/\/.*@/, "//***@")}`);
  await mongoose.connect(MONGODB_URI);

  const db = mongoose.connection.db;
  if (!db) {
    throw new Error("Failed to get database connection");
  }

  const apps = db.collection("apps");

  // Set all PUBLISHED apps to VERIFIED (catches missing, null, or default "NONE")
  const publishedResult = await apps.updateMany(
    { appStoreStatus: "PUBLISHED", verificationStatus: { $ne: "VERIFIED" } },
    { $set: { verificationStatus: "VERIFIED" } },
  );
  console.log(`Updated ${publishedResult.modifiedCount} PUBLISHED apps → verificationStatus: "VERIFIED"`);

  // Set all non-PUBLISHED apps to NONE (if not already set)
  const otherResult = await apps.updateMany(
    { appStoreStatus: { $ne: "PUBLISHED" }, $or: [{ verificationStatus: { $exists: false } }, { verificationStatus: null }] },
    { $set: { verificationStatus: "NONE" } },
  );
  console.log(`Updated ${otherResult.modifiedCount} non-PUBLISHED apps → verificationStatus: "NONE"`);

  // Summary
  const counts = {
    verified: await apps.countDocuments({ verificationStatus: "VERIFIED" }),
    community: await apps.countDocuments({ verificationStatus: "COMMUNITY" }),
    none: await apps.countDocuments({ verificationStatus: "NONE" }),
  };
  console.log("Final counts:", counts);

  await mongoose.disconnect();
  console.log("Migration complete.");
}

migrate().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
