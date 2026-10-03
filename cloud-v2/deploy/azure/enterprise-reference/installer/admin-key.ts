// Executed inside the selected Core container by the Azure operator.
// Reuse its existing DB-backed org API keys; no additional HTTP auth surface.
import mongoose from "mongoose";
import {mkdirSync, openSync, closeSync, writeFileSync, readFileSync, existsSync, unlinkSync, fsyncSync, renameSync} from "node:fs";
import {createHash, randomBytes, randomUUID, createCipheriv, createDecipheriv} from "node:crypto";
import {ulid} from "ulid";
import {DeveloperOrgService} from "/app/cloud-v2/packages/core/src/services/developer-orgs/developer-org.service";
import {DeveloperApiKeyService} from "/app/cloud-v2/packages/core/src/services/developer-orgs/developer-api-key.service";
import {DeveloperOrgApiKeyModel} from "/app/cloud-v2/packages/core/src/models/developer-org-api-key.model";

const owner = process.argv[2];
if (!/^[0-9a-f-]{36}$/.test(owner ?? "")) throw Error("Invalid deployment owner");
const directory = "/mnt/core-attachments/operator";
const output = `${directory}/admin-${owner}.json`;
mkdirSync(directory, {recursive: true, mode: 0o700});
const user = {id: `private-cloud-operator:${owner}`, email: "operator@private-cloud.local"};
let credential: {id: string; value: string; orgId?: string; adminEmail?: string};
function checkCredential(value: typeof credential) {
  if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(value.id)
      || !new RegExp(`^msk_local_${value.id}\\.[A-Za-z0-9_-]{43}$`).test(value.value)) {
    throw Error("Invalid saved administrator credential; restore the protected credential file");
  }
}
try {
  await mongoose.connect(process.env.MONGO_URL!, {serverSelectionTimeoutMS: 15_000});
  // Persist a complete credential atomically before creating its API-key row.
  // The journal encrypts the secret with the deployment signing key; stable
  // owner IDs and Mongo's unique _id make concurrent/restarted calls converge.
  // Azure Files does not support hard links, so it is only a credential cache.
  const encryptionKey = createHash("sha256").update("mentra-installer-admin-v1:")
    .update(owner).update(process.env.MENTRA_JWT_PRIVATE_KEY!).digest();
  const journal = mongoose.connection.collection("installer_admin_credentials");
  let row = await journal.findOne({_id: owner as any});
  if (!row) {
    const id = ulid();
    const candidate = existsSync(output) ? JSON.parse(readFileSync(output, "utf8"))
      : {id, value: `msk_local_${id}.${randomBytes(32).toString("base64url")}`};
    checkCredential(candidate);
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", encryptionKey, iv);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(candidate)), cipher.final()]);
    try {
      await journal.updateOne({_id: owner as any}, {$setOnInsert: {
        iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64"),
      }}, {upsert: true});
    } catch (error) {
      if ((error as {code?: number}).code !== 11000) throw error;
    }
    row = await journal.findOne({_id: owner as any});
  }
  if (!row) throw Error("Administrator credential journal unavailable");
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey, Buffer.from(row.iv, "base64"));
  decipher.setAuthTag(Buffer.from(row.tag, "base64"));
  credential = JSON.parse(Buffer.concat([decipher.update(Buffer.from(row.ciphertext, "base64")), decipher.final()]).toString());
  checkCredential(credential);
  const orgs = new DeveloperOrgService();
  let org = await orgs.getPrimaryOrgForUser(user);
  if (!org) {
    try {
      org = await orgs.createPrimaryOrg(user, {
        displayName: "Private Cloud Administration", packagePrefix: `io.privatecloud.d${owner.replaceAll("-", "")}`,
      });
    } catch (error) {
      org = await orgs.getPrimaryOrgForUser(user);
      if (!org) throw error;
    }
  }
  const secret = credential.value.split(".")[1];
  const hash = createHash("sha256").update(secret).digest("hex");
  try {
    await DeveloperOrgApiKeyModel.updateOne({keyId: credential.id}, {$setOnInsert: {
      keyId: credential.id, orgId: org.id, name: "Private Cloud administrator", env: "local",
      hash, last4: secret.slice(-4), createdByUserId: user.id,
    }}, {upsert: true, runValidators: true});
  } catch (error) {
    if ((error as {code?: number}).code !== 11000) throw error;
  }
  // Existing/revoked/mismatched rows must not be replaced or resurrected.
  const valid = await new DeveloperApiKeyService().validate(credential.value, "local");
  if (valid?.orgId !== org.id) throw Error("Saved administrator credential is revoked or inconsistent");
  credential.orgId = org.id;
  credential.adminEmail = `api-key@${credential.id}.local`;
  const temporary = `${output}.${randomUUID()}.pending`;
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(fd, JSON.stringify(credential));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try { renameSync(temporary, output); } finally { if (existsSync(temporary)) unlinkSync(temporary); }
} finally {
  await mongoose.disconnect();
}
// Azure exec is captured directly into the operator's protected local file.
// This does not write the token to the application's console log stream.
console.log("MENTRA_ADMIN_BEGIN" + JSON.stringify(credential) + "MENTRA_ADMIN_END");
