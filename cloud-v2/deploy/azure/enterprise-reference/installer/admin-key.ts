// Executed inside the selected Core container by the Azure operator.
// Reuse its existing DB-backed org API keys; no additional HTTP auth surface.
import mongoose from "/app/cloud-v2/packages/core/node_modules/mongoose/index.js";
import {mkdirSync, openSync, closeSync, writeFileSync, readFileSync, existsSync, unlinkSync, fsyncSync} from "node:fs";
import {DeveloperOrgService} from "/app/cloud-v2/packages/core/src/services/developer-orgs/developer-org.service";
import {DeveloperApiKeyService} from "/app/cloud-v2/packages/core/src/services/developer-orgs/developer-api-key.service";

const owner = process.argv[2];
if (!/^[0-9a-f-]{36}$/.test(owner ?? "")) throw Error("Invalid deployment owner");
const directory = "/mnt/core-attachments/operator";
const output = `${directory}/admin-${owner}.json`;
mkdirSync(directory, {recursive: true, mode: 0o700});
if (!existsSync(output)) {
  // Reserve before minting. Concurrent callers cannot orphan extra keys.
  const fd = openSync(output, "wx", 0o600);
  let minted: {id: string; orgId: string} | undefined;
  let published = false;
  const user = {id: `private-cloud-operator:${owner}`, email: "operator@private-cloud.local"};
  try {
    await mongoose.connect(process.env.MONGO_URL!, {serverSelectionTimeoutMS: 15_000});
    const orgs = new DeveloperOrgService();
    const org = await orgs.getPrimaryOrgForUser(user) ?? await orgs.createPrimaryOrg(user, {
      displayName: "Private Cloud Administration", packagePrefix: `io.privatecloud.d${owner.replaceAll("-", "")}`,
    });
    const key = await new DeveloperApiKeyService().create(org.id, "Private Cloud administrator", user.id, "local");
    minted = {id: key.id, orgId: org.id};
    writeFileSync(fd, JSON.stringify({id: key.id, value: key.value, orgId: org.id, adminEmail: `api-key@${key.id}.local`}));
    fsyncSync(fd);
    published = true;
  } finally {
    closeSync(fd);
    if (!published) {
      if (minted) await new DeveloperApiKeyService().revoke(minted.orgId, minted.id);
      unlinkSync(output);
    }
    await mongoose.disconnect();
  }
}
// Azure exec is captured directly into the operator's protected local file.
// This does not write the token to the application's console log stream.
console.log("MENTRA_ADMIN_BEGIN" + readFileSync(output, "utf8") + "MENTRA_ADMIN_END");
