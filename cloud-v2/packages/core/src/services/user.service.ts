/**
 * @fileoverview User aggregate. Identity lookup and first-sight creation.
 *
 * The user aggregate is immutable identity-only state: given an (tenantId,
 * tenantUserId) pair we either find the existing `mentraUserId` for it, or
 * mint a new one. Created on first sight during token exchange; thereafter
 * reused for every session that user opens under that OEM.
 *
 * Spec: docs/issues/001-oem-auth/design.md ("Lifecycles" / "Issue session" step 6)
 */

import { ulid } from "ulid";
import { createLogger } from "@mentra/cloud-shared";
import { UserModel, type User } from "../models/user.model";

const logger = createLogger("core").child({ service: "user.service" });

/**
 * Look up the user record for an (tenantId, tenantUserId) pair; insert one if it
 * doesn't exist. Idempotent under concurrent calls (relies on the unique
 * compound index to deduplicate races).
 */
export async function findOrCreateUser(args: {
  tenantId: string;
  tenantUserId: string;
}): Promise<User> {
  const { tenantId, tenantUserId } = args;

  const existing = await UserModel.findOne({ tenantId, tenantUserId }).lean();
  if (existing) return existing;

  const mentraUserId = `mu_${ulid()}`;
  try {
    const created = await UserModel.create({ mentraUserId, tenantId, tenantUserId });
    logger.info({ mentraUserId, tenantId }, "minted user record on first sight");
    return created.toObject();
  } catch (err) {
    // Race: another request created the same (tenantId, tenantUserId) between our
    // findOne and create. Re-read and return the winning row.
    if (isDuplicateKeyError(err)) {
      const winner = await UserModel.findOne({ tenantId, tenantUserId }).lean();
      if (winner) return winner;
    }
    throw err;
  }
}

/** Look up a user by `mentraUserId`. Returns null if unknown. */
export async function getUser(mentraUserId: string): Promise<User | null> {
  return UserModel.findOne({ mentraUserId }).lean();
}

function isDuplicateKeyError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: number }).code === 11000
  );
}
