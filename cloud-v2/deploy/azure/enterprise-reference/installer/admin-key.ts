// Executed inside the selected Core container by the Azure operator.
// Reuse its existing DB-backed org API keys; no additional HTTP auth surface.
import mongoose from "mongoose";
import {mkdirSync, openSync, closeSync, writeFileSync, readFileSync, existsSync, unlinkSync, fsyncSync, linkSync} from "node:fs";
import {createHash, randomBytes, randomUUID} from "node:crypto";
import {ulid} from "ulid";
import {DeveloperOrgService} from "/app/cloud-v2/packages/core/src/services/developer-orgs/developer-org.service";
import {DeveloperApiKeyService} from "/app/cloud-v2/packages/core/src/services/developer-orgs/developer-api-key.service";
import {DeveloperOrgApiKeyModel} from "/app/cloud-v2/packages/core/src/models/developer-org-api-key.model";

const owner = process.argv[2];
if (!/^[0-9a-f-]{36}$/.test(owner ?? "")) throw Error("Invalid deployment owner");
const directory = "/mnt/core-attachments/operator";
const output = `${directory}/admin-${owner}.json`;
mkdirSync(directory, {recursive: true, mode: 0o700});
if (!existsSync(output)) {
  // Persist the complete secret before any database write. Atomic link publishes
  // one winner without overwriting it; interrupted/concurrent invocations use
  // that same token and idempotent database upsert, never an empty reservation.
  const id = ulid();
  const secret = randomBytes(32).toString("base64url");
  const temporary = `${output}.${randomUUID()}.pending`;
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(fd, JSON.stringify({id, value: `msk_local_${id}.${secret}`, adminEmail: `api-key@${id}.local`}));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    linkSync(temporary, output);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  } finally {
    unlinkSync(temporary);
  }
}
const credential = JSON.parse(readFileSync(output, "utf8"));
if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(credential.id)
    || !new RegExp(`^msk_local_${credential.id}\\.[A-Za-z0-9_-]{43}$`).test(credential.value)) {
  throw Error("Invalid saved administrator credential; restore the protected credential file");
}
const user = {id: `private-cloud-operator:${owner}`, email: "operator@private-cloud.local"};
try {
  await mongoose.connect(process.env.MONGO_URL!, {serverSelectionTimeoutMS: 15_000});
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
  await DeveloperOrgApiKeyModel.updateOne({keyId: credential.id}, {$setOnInsert: {
    keyId: credential.id, orgId: org.id, name: "Private Cloud administrator", env: "local",
    hash, last4: secret.slice(-4), createdByUserId: user.id,
  }}, {upsert: true, runValidators: true});
  // Existing/revoked/mismatched rows must not be replaced or resurrected.
  const valid = await new DeveloperApiKeyService().validate(credential.value, "local");
  if (valid?.orgId !== org.id) throw Error("Saved administrator credential is revoked or inconsistent");
  credential.orgId = org.id;
} finally {
  await mongoose.disconnect();
}
// Azure exec is captured directly into the operator's protected local file.
// This does not write the token to the application's console log stream.
console.log("MENTRA_ADMIN_BEGIN" + JSON.stringify(credential) + "MENTRA_ADMIN_END");
