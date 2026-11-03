/**
 * The published wire shapes in `workspace-types.ts` must stay exactly the contract's. The checks are types:
 * `tsc -b` (cloud-v2's typecheck) fails when a shape drifts in either direction.
 */
import { describe, expect, test } from "bun:test";
import type * as Contract from "@mentra/workspace-contract";
import type * as Local from "./workspace-types";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

const same: [
  Equal<Local.ClientWorkspaceRole, Contract.WorkspaceRole>,
  Equal<Local.InvitationPreview, Contract.InvitationPreview>,
  Equal<Local.MyWorkspace, Contract.MyWorkspace>,
  Equal<Local.MyWorkspaceResponse, Contract.MyWorkspaceResponse>,
  Equal<Local.PendingInvitationsResponse, Contract.PendingInvitationsResponse>,
  Equal<Local.AcceptInvitationResult, Contract.AcceptInvitationResult>,
  Equal<Local.DeclineInvitationResult, Contract.DeclineInvitationResult>,
  Equal<Local.LeaveWorkspaceRequest, Contract.LeaveWorkspaceRequest>,
] = [true, true, true, true, true, true, true, true];

describe("client workspace wire shapes", () => {
  test("equal @mentra/workspace-contract's (checked by the typecheck)", () => {
    expect(same.every(Boolean)).toBe(true);
  });
});
