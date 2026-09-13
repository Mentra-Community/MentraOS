/**
 * @fileoverview Multi-organization Developer Console membership coverage.
 *
 * A user may belong to more than one developer organization. The selected
 * organization remains a request/session concern, while this service is the
 * authorization source for the organizations the picker may expose.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

import { connectMongo, disconnectMongo } from "../packages/store/src/connections/mongo.connection";
import { DeveloperOrgMembershipModel } from "../packages/store/src/models/developer-org-membership.model";
import { DeveloperOrgModel } from "../packages/store/src/models/developer-org.model";
import { DeveloperOrgService } from "../packages/store/src/services/developer-orgs/developer-org.service";

const service = new DeveloperOrgService();

beforeAll(async () => {
  await connectMongo(process.env.MONGO_URL ?? "mongodb://127.0.0.1:27017/mentra-cloud-v2-test");
  await Promise.all([DeveloperOrgModel.syncIndexes(), DeveloperOrgMembershipModel.syncIndexes()]);
});
afterAll(async () => {
  await disconnectMongo();
});

beforeEach(async () => {
  await Promise.all([
    DeveloperOrgMembershipModel.deleteMany({ userId: { $in: ["user_a", "user_b", "shared_user", "invite_first"] } }),
    DeveloperOrgModel.deleteMany({ ownerUserId: { $in: ["user_a", "user_b", "invite_first"] } }),
  ]);
});

describe("developer organization membership", () => {
  test("one user can access multiple organizations without duplicate membership rows", async () => {
    const first = await service.createPrimaryOrg(
      { id: "user_a", email: "a@example.com" },
      { displayName: "Alpha Team", packagePrefix: "com.testalpha" },
    );
    const second = await service.createPrimaryOrg(
      { id: "user_b", email: "b@example.com" },
      { displayName: "Beta Team", packagePrefix: "com.testbeta" },
    );

    await Promise.all([
      service.ensureMembership(first.id, "shared_user", { email: "shared@example.com" }),
      service.ensureMembership(second.id, "shared_user", { email: "shared@example.com" }),
    ]);
    await service.ensureMembership(first.id, "shared_user", { email: "shared@example.com" });

    const organizations = await service.listOrgsForUser({ id: "shared_user", email: "shared@example.com" });
    expect(organizations.map(organization => organization.id)).toEqual([first.id, second.id]);
    expect(await DeveloperOrgMembershipModel.countDocuments({ userId: "shared_user" })).toBe(2);
  });

  test("organization discovery never exposes an organization without ownership or membership", async () => {
    const visible = await service.createPrimaryOrg(
      { id: "user_a", email: "a@example.com" },
      { displayName: "Visible Team", packagePrefix: "com.testvisible" },
    );
    await service.createPrimaryOrg(
      { id: "user_b", email: "b@example.com" },
      { displayName: "Hidden Team", packagePrefix: "com.testhidden" },
    );

    const organizations = await service.listOrgsForUser({ id: "user_a", email: "a@example.com" });
    expect(organizations.map(organization => organization.id)).toEqual([visible.id]);
  });

  test("an invite-first developer can also own a newly created publisher organization", async () => {
    const joined = await service.createPrimaryOrg(
      { id: "user_a", email: "a@example.com" },
      { displayName: "Joined Team", packagePrefix: "com.testjoined" },
    );
    await service.ensureMembership(joined.id, "invite_first", { email: "invite-first@example.com" });

    const created = await service.createPrimaryOrg(
      { id: "invite_first", email: "invite-first@example.com" },
      { displayName: "Owned Team", packagePrefix: "com.testowned" },
    );

    const organizations = await service.listOrgsForUser({ id: "invite_first", email: "invite-first@example.com" });
    expect(organizations.map(organization => organization.id)).toEqual([joined.id, created.id]);
    expect(await service.getMemberRole(created.id, "invite_first")).toBe("owner");
  });
});
