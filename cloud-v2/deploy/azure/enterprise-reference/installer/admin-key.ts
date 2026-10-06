// Executed inside the selected Core container by the Azure operator.
// Mints this deployment's operator key (mak_local_...) through Core's own
// credential service; no additional HTTP auth surface.
import mongoose from "mongoose";
import {unlinkSync} from "node:fs";
import {createHash, randomBytes, createCipheriv, createDecipheriv} from "node:crypto";
import {OPERATOR_KEY_SCOPES} from "/app/cloud-v2/packages/workspace-contract/src/capabilities";
import {AccessCredentialModel} from "/app/cloud-v2/packages/core/src/models/access-credential.model";
import {
  createOperatorKey,
  revokeCredential,
  validateCredentialToken,
} from "/app/cloud-v2/packages/core/src/services/workspaces/credential.service";
import {isOrganizationAdminEmail} from "/app/cloud-v2/packages/core/src/services/workspaces/organization";

const owner = process.argv[2];
if (!/^[0-9a-f-]{36}$/.test(owner ?? "")) throw Error("Invalid deployment owner");
const directory = "/mnt/core-attachments/operator";
const output = `${directory}/admin-${owner}.json`;
// Must match OPERATOR_EMAIL in installer/setup.py, which allowlists it in
// CLOUD_CORE_ADMIN_EMAILS before running this script. An operator key works
// only while its creator's email is on that allowlist.
const OPERATOR_EMAIL = "operator@private-cloud.local";
const KEY_NAME = "Private Cloud administrator";
const actor = {
  kind: "user" as const,
  mentraUserId: `private-cloud-operator:${owner}`,
  email: OPERATOR_EMAIL,
  // Treated as verified on purpose. This is not a browser sign-in: the operator
  // runs this inside the deployment's own Core container, already holding its
  // database and signing secrets. `.local` cannot be a verified Entra domain, so
  // no employee identity can claim this address, and private Core has no other
  // identity provider; browser admin sign-in for private deployments is out of scope.
  emailVerified: true,
  name: "Private Cloud installer",
  isOrganizationAdmin: isOrganizationAdminEmail(OPERATOR_EMAIL, true),
};
type Credential = {id: string; value: string; adminEmail?: string; cleanupRequired?: boolean};
let credential: Credential;
const TOKEN = /^mak_local_([0-9A-HJKMNP-TV-Z]{26})\.[A-Za-z0-9_-]{43}$/;
async function usable(value: Credential | null): Promise<boolean> {
  if (!value || TOKEN.exec(value.value)?.[1] !== value.id) return false;
  const principal = await validateCredentialToken(value.value);
  return principal?.credentialKind === "organization" && principal.credentialId === value.id;
}
try {
  if (!actor.isOrganizationAdmin) {
    throw Error(`${OPERATOR_EMAIL} is not in CLOUD_CORE_ADMIN_EMAILS for this Core revision; rerun bootstrap-admin`);
  }
  await mongoose.connect(process.env.MONGO_URL!, {serverSelectionTimeoutMS: 15_000});
  // Only the encrypted journal persists the credential. It is keyed by the
  // stable owner ID and encrypted with the deployment signing key, so a retry
  // returns the same key. A journal from an earlier installer holds an msk_
  // key that this Core no longer accepts; it is replaced, never resurrected.
  const encryptionKey = createHash("sha256").update("mentra-installer-admin-v1:")
    .update(owner).update(process.env.MENTRA_JWT_PRIVATE_KEY!).digest();
  const journal = mongoose.connection.collection("installer_admin_credentials");
  const open = (row: any): Credential | null => {
    if (!row) return null;
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey, Buffer.from(row.iv, "base64"));
    decipher.setAuthTag(Buffer.from(row.tag, "base64"));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(row.ciphertext, "base64")), decipher.final()]).toString());
  };
  const seal = (value: Credential) => {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", encryptionKey, iv);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
    return {iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64")};
  };
  let row = await journal.findOne({_id: owner as any});
  let saved = open(row);
  if (!(await usable(saved))) {
    const minted = await createOperatorKey(actor, {name: KEY_NAME, scopes: [...OPERATOR_KEY_SCOPES]});
    const candidate = {id: minted.credential.credentialId, value: minted.token};
    try {
      // Replace only the stale entry this run read; a concurrent run's newer key wins.
      if (row) await journal.replaceOne({_id: owner as any, ciphertext: row.ciphertext}, seal(candidate));
      else await journal.insertOne({_id: owner as any, ...seal(candidate)});
    } catch (error) {
      if ((error as {code?: number}).code !== 11000) throw error;
    }
    row = await journal.findOne({_id: owner as any});
    saved = open(row);
    if (saved?.id !== candidate.id) await revokeCredential(actor, candidate.id);
  }
  if (!saved || !(await usable(saved))) throw Error("Saved administrator credential is revoked or inconsistent");
  credential = {id: saved.id, value: saved.value, adminEmail: OPERATOR_EMAIL};
  // Keys minted by an interrupted run never reached the journal and nobody holds
  // their secret. Revoke them so only the journaled key remains.
  const orphans = await AccessCredentialModel.find({
    credentialKind: "organization", createdByEmail: OPERATOR_EMAIL, name: KEY_NAME,
    revokedAt: null, credentialId: {$ne: credential.id},
  }).select({credentialId: 1}).lean<Array<{credentialId: string}>>();
  for (const orphan of orphans) await revokeCredential(actor, orphan.credentialId);
  // Earlier installers cached a plaintext key on the report attachment share,
  // whose SMB mount permissions do not provide owner-only access. Remove it.
  try { unlinkSync(output); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") credential.cleanupRequired = true; }
} finally {
  await mongoose.disconnect();
}
// Azure exec is captured directly into the operator's protected local file.
// This does not write the token to the application's console log stream.
console.log("MENTRA_ADMIN_BEGIN" + JSON.stringify(credential) + "MENTRA_ADMIN_END");
